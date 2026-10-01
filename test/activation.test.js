/**
 * The activation gate (migrations 0014, 0022): a garage is not usable until
 * its rate setup is complete, its transient mode is stated and its taxes are
 * stated -- with rules, or as none. The taxes' own store is exercised in
 * test/taxes.test.js; here is the condition.
 *
 * Every refusal here is paired with the same call succeeding once the one
 * missing thing is supplied, so "cannot" is measured against "can". And the
 * gate is measured at both of its layers: the operator route, and the
 * database trigger a direct UPDATE cannot go around.
 *
 * There is no Stripe condition in activation; the last test sweeps
 * activation's own sources for one, with a control that the sweep can see.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { GARAGE_ACTIVATED_EVENT_KIND, GARAGE_INACTIVE_REFUSAL_EVENT_KIND } from '../src/activation.js';

let engine;
let server;
let base;
let tenant;
let operatorToken;
let operatorTokenId;

async function issueToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [
      tenantId, laneId, name, hashToken(token),
    ]),
  );
  return token;
}

async function issueOperatorToken(tenantId) {
  const token = generateDeviceToken();
  const { rows } = await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2) RETURNING id`, [tenantId, hashToken(token)]),
  );
  return { token, id: rows[0].id };
}

const op = (method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const asDevice = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ event_id: randomUUID(), ...body }),
});

/** A garage through the operator route, with both lanes; nothing else. */
async function newGarage(body = {}) {
  const res = await op('POST', '/garages', { name: 'Gate', timezone: 'America/New_York', currency: 'USD', ...body });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const { garage } = await res.json();
  const lane = async (name, direction) =>
    (await (await op('POST', `/garages/${garage.id}/lanes`, { name, direction })).json()).lane.id;
  const entryLane = await lane('E', 'entry');
  const exitLane = await lane('X', 'exit');
  return {
    ...garage,
    entryLane,
    exitLane,
    entry: await issueToken(tenant, entryLane, 'e'),
    exit: await issueToken(tenant, exitLane, 'x'),
  };
}
const withPlan = (garageId, overrides = {}) =>
  withTenant(tenant, (c) => storePlan(c, tenant, garageId, flatHourlyPlan({ version: `v-${randomUUID().slice(0, 6)}`, ...overrides })));
const activate = (garageId) => op('POST', `/garages/${garageId}/activate`);
/** State a tax set through the operator door; `rules: []` states NONE. */
const stateTaxes = async (garageId, { rules = [], effectiveFrom = '2000-01-01T00:00:00Z' } = {}) => {
  const res = await op('POST', `/garages/${garageId}/tax-sets`, { tax_set: { effective_from: effectiveFrom, rules } });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await res.json()).tax_set;
};
const VAT = { id: 'vat', label: 'VAT', percent_bp: 2000, rounding: 'nearest', sequence: 1 };
/** 20% of 3.00 is exactly 0.60: no rounding, so the figure is the rule's alone. */
const VAT_ON_300 = 60;
const readout = async (garageId) => (await (await op('GET', `/garages/${garageId}/activation`)).json()).activation;
const open = (token, plate, entryAt = '2026-08-26T09:00:00Z') =>
  fetch(`${base}/api/v1/lane/sessions/open`, asDevice(token, { plate, entry_at: entryAt, entry_confirmation: 'confirmed' }));
const plate = () => `AG-${randomUUID().slice(0, 8)}`;
const eventsOf = (kind, garageId) =>
  withTenant(tenant, async (c) =>
    (await c.query(`SELECT * FROM events WHERE tenant_id = $1 AND kind = $2 AND garage_id = $3 ORDER BY received_at`, [tenant, kind, garageId])).rows,
  );

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('gate');
  await buildWorld(tenant);
  ({ token: operatorToken, id: operatorTokenId } = await issueOperatorToken(tenant));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Guarded: a `before` that threw leaves these unset, and an unguarded close
  // would hang the file with whatever it had started still running.
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

// --- the two conditions, through the route ------------------------------------------

test('a new garage is inactive, unstated, and the readout names all three conditions unmet', async () => {
  const g = await newGarage();
  assert.equal(g.activated_at, null);
  assert.equal(g.transient_available, null, 'unstated, not false');
  const state = await readout(g.id);
  assert.equal(state.active, false);
  assert.deepEqual(state.conditions.map((c) => [c.condition, c.met]), [
    ['rate_setup_complete', false],
    ['transient_mode_stated', false],
    ['taxes_stated', false],
  ]);
  assert.match(state.conditions[0].reason, /no rate plan is stored/);
  assert.match(state.conditions[1].reason, /unstated/);
  assert.match(state.conditions[2].reason, /taxes are unstated/);
  assert.equal(state.conditions.length, 3, 'three conditions and no fourth: nothing this gate cannot observe');
});

test('a garage with no plan cannot be activated, by name; the same garage activates once a plan is in force', async () => {
  const g = await newGarage({ transient_available: true });
  await stateTaxes(g.id);
  const res = await activate(g.id);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'garage_not_activatable');
  assert.deepEqual(body.details.unmet.map((c) => c.condition), ['rate_setup_complete']);
  assert.match(body.error, /no rate plan is stored/);
  assert.equal((await readout(g.id)).active, false);
  // CONTROL
  await withPlan(g.id);
  const ok = await activate(g.id);
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  const { garage, activated } = await ok.json();
  assert.equal(activated, true);
  assert.ok(garage.activated_at);
  assert.equal((await readout(g.id)).active, true);
});

test('a garage whose only plan is not yet in force cannot be activated; it can once a version is in force', async () => {
  const g = await newGarage({ transient_available: false });
  await stateTaxes(g.id);
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  await withPlan(g.id, { effectiveFrom: future });
  const res = await activate(g.id);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'garage_not_activatable');
  assert.deepEqual(body.details.unmet.map((c) => c.condition), ['rate_setup_complete']);
  assert.match(body.error, /1 plan\(s\) stored, none in force yet/);
  // CONTROL: a version in force, and the same call activates.
  await withPlan(g.id, { effectiveFrom: '2026-01-01T00:00:00Z' });
  assert.equal((await activate(g.id)).status, 201);
});

test('an unstated transient mode cannot be activated; stating it -- true or false -- is enough, and false is not unstated', async () => {
  for (const stated of [true, false]) {
    const g = await newGarage();
    await withPlan(g.id);
    await stateTaxes(g.id);
    const res = await activate(g.id);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual(body.details.unmet.map((c) => c.condition), ['transient_mode_stated']);
    assert.match(body.error, /transient_available is unstated/);
    // CONTROL: state it through PATCH, and activate.
    const patched = await op('PATCH', `/garages/${g.id}`, { transient_available: stated });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).garage.transient_available, stated);
    assert.equal((await activate(g.id)).status, 201, `stated ${stated}`);
  }
});

test('transient_available is true or false and nothing else; unstated is the absence of the field, never a value', async () => {
  const g = await newGarage();
  for (const bad of [null, 'true', 1, 'yes']) {
    const res = await op('PATCH', `/garages/${g.id}`, { transient_available: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal((await op('PATCH', `/garages/${g.id}`, {})).status, 400, 'a PATCH that states nothing');
  assert.equal((await op('POST', '/garages', { name: 'G', timezone: 'UTC', currency: 'USD', transient_available: 'no' })).status, 400);
  // CONTROL: PATCH still takes default_action alone, and both together.
  assert.equal((await op('PATCH', `/garages/${g.id}`, { default_action: 'deny' })).status, 200);
  const both = await (await op('PATCH', `/garages/${g.id}`, { default_action: 'allow', transient_available: true })).json();
  assert.equal(both.garage.default_action, 'allow');
  assert.equal(both.garage.transient_available, true);
});

test('activation is recorded -- who, when, what the gate saw -- and is idempotent', async () => {
  const g = await newGarage({ transient_available: true });
  await withPlan(g.id);
  await stateTaxes(g.id);
  const first = await (await activate(g.id)).json();
  const again = await activate(g.id);
  assert.equal(again.status, 200);
  const second = await again.json();
  assert.equal(second.activated, false);
  assert.equal(second.garage.activated_at, first.garage.activated_at, 'not moved');
  const events = await eventsOf(GARAGE_ACTIVATED_EVENT_KIND, g.id);
  assert.equal(events.length, 1, 'one act, one record');
  assert.equal(events[0].detail.actor, `operator_token:${operatorTokenId}`);
  assert.equal(events[0].detail.transient_available, true);
  assert.deepEqual(events[0].detail.conditions.map((c) => c.met), [true, true, true]);
  assert.equal(events[0].lane_id, null);
});

test('a refused activation leaves no activation record', async () => {
  const g = await newGarage();
  assert.equal((await activate(g.id)).status, 409);
  assert.deepEqual(await eventsOf(GARAGE_ACTIVATED_EVENT_KIND, g.id), []);
});

test('an unknown garage is 404 on the readout and the activation', async () => {
  assert.equal((await activate(randomUUID())).status, 404);
  assert.equal((await op('GET', `/garages/${randomUUID()}/activation`)).status, 404);
});


// --- the third condition: taxes stated (0022) ----------------------------------------

test('UNSTATED taxes refuse activation, naming the condition; stated-none activates; stated-with-rules activates', async () => {
  for (const [stated, reason] of [
    [[], /stated: this garage charges no tax, from 2000-01-01T00:00:00.000Z/],
    [[VAT], /stated: 1 tax rule\(s\) in force, from 2000-01-01T00:00:00.000Z/],
  ]) {
    const g = await newGarage({ transient_available: true });
    await withPlan(g.id);
    const res = await activate(g.id);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'garage_not_activatable');
    assert.deepEqual(body.details.unmet.map((c) => c.condition), ['taxes_stated'], 'the tax condition, and only it');
    assert.match(body.error, /taxes_stated -- taxes are unstated: state the taxes this garage charges, or state that it charges none/);
    assert.deepEqual(await eventsOf(GARAGE_ACTIVATED_EVENT_KIND, g.id), []);
    // CONTROL: state them -- none, or with rules -- and the same call activates.
    await stateTaxes(g.id, { rules: stated });
    const state = await readout(g.id);
    assert.equal(state.conditions[2].met, true);
    assert.match(state.conditions[2].reason, reason);
    const ok = await activate(g.id);
    assert.equal(ok.status, 201, `stated ${JSON.stringify(stated)}`);
    const [event] = await eventsOf(GARAGE_ACTIVATED_EVENT_KIND, g.id);
    assert.equal(event.detail.conditions[2].condition, 'taxes_stated');
    assert.match(event.detail.conditions[2].reason, reason);
  }
});

test('a tax set stated for later leaves the garage unstated today: set up, not in force', async () => {
  const g = await newGarage({ transient_available: true });
  await withPlan(g.id);
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  await stateTaxes(g.id, { effectiveFrom: future });
  const res = await activate(g.id);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.deepEqual(body.details.unmet.map((c) => c.condition), ['taxes_stated']);
  assert.match(body.error, /1 tax set\(s\) stated, none in force yet; the earliest takes effect/);
  // CONTROL: a set in force, and the same call activates.
  await stateTaxes(g.id);
  assert.equal((await activate(g.id)).status, 201);
});

test('the new condition has not replaced the old ones: stated taxes do not open a garage failing the rate condition', async () => {
  const g = await newGarage({ transient_available: true });
  await stateTaxes(g.id, { rules: [VAT] });
  const res = await activate(g.id);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.deepEqual(body.details.unmet.map((c) => c.condition), ['rate_setup_complete'], 'refused on the rate condition, alone');
  assert.match(body.error, /no rate plan is stored/);
  const unstatedMode = await newGarage();
  await withPlan(unstatedMode.id);
  await stateTaxes(unstatedMode.id);
  const second = await (await activate(unstatedMode.id)).json();
  assert.deepEqual(second.details.unmet.map((c) => c.condition), ['transient_mode_stated'], 'and on the transient mode, alone');
  // CONTROL: the missing plan supplied, the first garage activates.
  await withPlan(g.id);
  assert.equal((await activate(g.id)).status, 201);
});

// --- the database is the second layer ------------------------------------------------

test('the database itself refuses to activate an unready garage: a direct UPDATE does not go around the route', async () => {
  const g = await newGarage();
  const setActive = () =>
    withTenant(tenant, (c) => c.query(`UPDATE garages SET activated_at = now() WHERE id = $1`, [g.id]));
  await assert.rejects(setActive, (err) => err.constraint === 'garages_activation_needs_transient_mode');
  await withTenant(tenant, (c) => c.query(`UPDATE garages SET transient_available = true WHERE id = $1`, [g.id]));
  await assert.rejects(setActive, (err) => err.constraint === 'garages_activation_needs_a_plan');
  await withPlan(g.id, { effectiveFrom: new Date(Date.now() + 86_400_000).toISOString() });
  await assert.rejects(setActive, (err) => err.constraint === 'garages_activation_needs_a_plan_in_force');
  await withPlan(g.id);
  await assert.rejects(setActive, (err) => err.constraint === 'garages_activation_needs_taxes_stated');
  await stateTaxes(g.id, { effectiveFrom: new Date(Date.now() + 86_400_000).toISOString() });
  await assert.rejects(setActive, (err) => err.constraint === 'garages_activation_needs_taxes_in_force');
  // CONTROL: with a tax set in force the same UPDATE lands.
  await stateTaxes(g.id);
  await setActive();
  assert.equal((await readout(g.id)).active, true);
});

test('a garage is never created active, a stated mode is never un-stated, and activation is never undone', async () => {
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(`INSERT INTO garages (tenant_id, name, timezone, currency, activated_at) VALUES ($1,'X','UTC','USD', now())`, [tenant]),
    ),
    (err) => err.constraint === 'garages_created_inactive',
  );
  const g = await newGarage({ transient_available: true });
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE garages SET transient_available = NULL WHERE id = $1`, [g.id])),
    (err) => err.constraint === 'garages_transient_mode_is_not_unstated',
  );
  await withPlan(g.id);
  await stateTaxes(g.id);
  assert.equal((await activate(g.id)).status, 201);
  for (const sql of [
    `UPDATE garages SET activated_at = NULL WHERE id = $1`,
    `UPDATE garages SET activated_at = now() + interval '1 day' WHERE id = $1`,
  ]) {
    await assert.rejects(
      withTenant(tenant, (c) => c.query(sql, [g.id])),
      (err) => err.constraint === 'garages_activation_is_not_undone',
      sql,
    );
  }
  // CONTROL: restating the mode on an active garage is allowed.
  await withTenant(tenant, (c) => c.query(`UPDATE garages SET transient_available = false WHERE id = $1`, [g.id]));
});

// --- an inactive garage does not operate ---------------------------------------------

test('an inactive garage opens no stay: refused by name, and RECORDED before the lane can drop it', async () => {
  const g = await newGarage({ transient_available: true });
  await withPlan(g.id);
  const laneEvent = randomUUID();
  const res = await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(g.entry, { event_id: laneEvent, plate: plate(), entry_at: '2026-08-26T09:00:00Z', entry_confirmation: 'confirmed' }),
  );
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'garage_not_active');
  assert.match(body.error, /rate setup is complete, its transient mode is stated and its taxes are stated/);
  const sessions = await withTenant(tenant, async (c) =>
    (await c.query('SELECT count(*) FROM sessions WHERE garage_id = $1', [g.id])).rows[0].count,
  );
  assert.equal(Number(sessions), 0, 'no stay was created');
  const [record] = await eventsOf(GARAGE_INACTIVE_REFUSAL_EVENT_KIND, g.id);
  assert.ok(record, 'the platform remembers the car it turned away');
  assert.equal(record.lane_id, g.entryLane);
  assert.equal(record.event_id, `inactive:${laneEvent}`);
  assert.deepEqual(record.detail, { actor: 'platform:lane', action: 'open', lane_event_id: laneEvent });
  assert.ok(!JSON.stringify(record.detail).includes('AG-'), 'and records no plate');

  // A replay of the same lane event adds no second record.
  await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(g.entry, { event_id: laneEvent, plate: plate(), entry_at: '2026-08-26T09:00:00Z', entry_confirmation: 'confirmed' }),
  );
  assert.equal((await eventsOf(GARAGE_INACTIVE_REFUSAL_EVENT_KIND, g.id)).length, 1);

  // CONTROL: activated, the same lane opens a stay exactly as before.
  await stateTaxes(g.id);
  assert.equal((await activate(g.id)).status, 201);
  const opened = await open(g.entry, plate());
  assert.equal(opened.status, 201);
});

test('an inactive garage closes no stay either, by name and on the record', async () => {
  const g = await newGarage({ transient_available: true });
  await withPlan(g.id);
  const laneEvent = randomUUID();
  const res = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(g.exit, { event_id: laneEvent, plate: plate(), exit_at: '2026-08-26T10:00:00Z', exit_confirmation: 'confirmed' }),
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'garage_not_active');
  const [record] = await eventsOf(GARAGE_INACTIVE_REFUSAL_EVENT_KIND, g.id);
  assert.equal(record.detail.action, 'close');
  assert.equal(record.lane_id, g.exitLane);
});

test('/lane/rules tells the lane whether its garage is active, and still serves an inactive one its rules', async () => {
  const g = await newGarage({ transient_available: true });
  const rules = async () => (await fetch(`${base}/api/v1/lane/rules`, { headers: { authorization: `Bearer ${g.entry}` } })).json();
  const before = await rules();
  assert.equal(before.active, false);
  assert.equal(before.garage_id, g.id, 'the rules themselves are served');
  await withPlan(g.id);
  await stateTaxes(g.id);
  assert.equal((await activate(g.id)).status, 201);
  assert.equal((await rules()).active, true);
});

test('an active garage with every condition met operates as before: open, close, priced -- and taxed', async () => {
  const g = await newGarage({ transient_available: true });
  await withPlan(g.id, { hourlyMinor: 300 });
  await stateTaxes(g.id, { rules: [VAT] });
  assert.equal((await activate(g.id)).status, 201);
  const p = plate();
  assert.equal((await open(g.entry, p)).status, 201);
  const closed = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(g.exit, { plate: p, exit_at: '2026-08-26T10:00:00Z', exit_confirmation: 'confirmed' }),
  );
  assert.equal(closed.status, 200);
  const session = (await closed.json()).session;
  // Since 0023 the stated tax IS charged: on the 300 the driver pays, as its
  // own line after the engine's, with the subtotal kept beside the fee.
  assert.equal(session.subtotal_minor, 300, 'the subtotal is the fee before tax');
  assert.equal(session.fee_minor, 300 + VAT_ON_300, 'the stated tax is charged on it');
  assert.deepEqual(session.breakdown.filter((l) => l.code === 'tax.applied').map((l) => l.delta_minor), [VAT_ON_300], 'as one line on the ledger');
  assert.deepEqual(await eventsOf(GARAGE_INACTIVE_REFUSAL_EVENT_KIND, g.id), [], 'and nothing was refused');
});

// --- no Stripe condition in activation ------------------------------------------------

// NARROWED, NOT REMOVED. This used to sweep every source and migration for any
// Stripe word, because the round that wrote it had none anywhere. A garage's
// own Stripe account now exists (0020, src/stripeAccount.js), so a sweep of the
// whole tree would fail on code that has nothing to do with activation. What
// this test protects was never "the repository has no Stripe"; it is
// "ACTIVATION HAS NO STRIPE CONDITION" -- the owner's correction of 2026-09-20.
// So it sweeps activation's own sources: the module the route and the lane
// consult, and the migration whose trigger enforces the gate. The planted
// control stays, and scripts/activation-fail-control.js still plants a Stripe
// field into src/activation.js and requires this to go red.
test('activation has no Stripe condition, and the sweep can see one', async () => {
  const stripe = /stripe|connect_account|application_fee|payment_method/i;
  const ACTIVATION_SOURCES = [
    'src/activation.js',
    'src/taxes.js',
    'migrations/0014_activation_gate.sql',
    // 0022 replaces the gate's trigger function with its third condition.
    'migrations/0022_garage_tax_sets.sql',
  ];
  const hits = [];
  for (const path of ACTIVATION_SOURCES) {
    const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    if (stripe.test(text)) hits.push(path);
  }
  assert.deepEqual(hits, [], 'a Stripe surface appeared in activation');
  // CONTROL: the pattern finds what it is for, and the files were read.
  assert.ok(stripe.test('const stripe = require("stripe")'));
  const gate = await readFile(new URL('../migrations/0014_activation_gate.sql', import.meta.url), 'utf8');
  assert.ok(gate.includes('garages_activation_gate'));
  const module = await readFile(new URL('../src/activation.js', import.meta.url), 'utf8');
  assert.ok(module.includes('GARAGE_ACTIVATED_EVENT_KIND'));
});
