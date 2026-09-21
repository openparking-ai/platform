/**
 * The rules payload (migration 0016): what the exit needs to decide, off
 * the barrier's path.
 *
 * `GET /lane/rules` carries the garage's rate plans whole, its space class,
 * each linked module's register read through its own `show-garage-register`
 * verb -- the REAL garage-pass and monthly-billing, each with a database
 * built from its own migrations -- and the garage's open stays with a
 * cursor. `GET /lane/stays?since=` is the fast cadence: every stay whose
 * cursor value is past `since`, closed rows included. `hourly_minor`,
 * `rate_id` and `plate_rules` are gone; `POST /garages/:id/rates` refuses by
 * name (test/api.test.js).
 *
 * Every absence is asserted beside a presence, and the cursor's stated limit
 * is planted rather than described: an in-flight transaction commits after a
 * later cursor was read, the delta misses it, the full set has it.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { startEntitlementModules } from './entitlement-modules.js';
import { REGISTER_VERB } from '../src/entitlement.js';

let engine;
let modules;
let server;
let base;
let tenant;
let operatorToken;

async function issueToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [tenantId, laneId, name, hashToken(token)]),
  );
  return token;
}
async function issueOperatorToken(tenantId) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenantId, hashToken(token)]),
  );
  return token;
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
const rules = async (token) => {
  const res = await fetch(`${base}/api/v1/lane/rules`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};
const stays = async (token, since) => {
  const url = since === undefined ? `${base}/api/v1/lane/stays` : `${base}/api/v1/lane/stays?since=${since}`;
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
};
const open = (token, plate, entryAt = '2026-09-10T12:00:00Z', extra = {}) =>
  fetch(`${base}/api/v1/lane/sessions/open`, asDevice(token, { plate, entry_at: entryAt, entry_confirmation: 'confirmed', ...extra }));
const close = (token, plate, exitAt = '2026-09-10T14:00:00Z', extra = {}) =>
  fetch(`${base}/api/v1/lane/sessions/close`, asDevice(token, { plate, exit_at: exitAt, exit_confirmation: 'confirmed', ...extra }));
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;

/** An active platform garage with a flat plan and both lanes, with device tokens. */
async function garage({ plans = 1 } = {}) {
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Rules','America/New_York','USD') RETURNING id`, [tenant])).rows[0].id;
    const lane = async (name, direction) =>
      (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, id, name, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan());
    for (let n = 2; n <= plans; n += 1) {
      await storePlan(c, tenant, id, flatHourlyPlan({ hourlyMinor: 250 + n, version: `v${n}`, effectiveFrom: `2026-0${n}-01T00:00:00Z` }));
    }
    await activateGarage(c, tenant, id);
    return { id, entryLane, exitLane };
  });
  return { ...built, entry: await issueToken(tenant, built.entryLane, 'e'), exit: await issueToken(tenant, built.exitLane, 'x') };
}
const gpLink = (garageId) => ({ tenant_id: modules.garage_pass.tenant, garage_id: garageId });
const mbLink = (garageId) => ({ tenant_id: modules.monthly_billing.tenant, garage_id: garageId });

/** One garage in each module, linked, with a pass holder and a monthly vehicle. */
async function linkedWorld() {
  const g = await garage();
  const tag = g.id.slice(0, 8);
  const gpGarage = `gp-${tag}`;
  const mbGarage = `mb-${tag}`;
  const passCar = plate('PASS');
  const monthlyCar = plate('MNTH');
  await modules.gpGarage(gpGarage);
  await modules.gpPass(`pass-${tag}`, [gpGarage]);
  await modules.gpRegister(`pass-${tag}`, gpGarage, passCar);
  await modules.mbSeed({ garage: mbGarage, agreement: `ag-${tag}`, payer: `payer-${tag}`, vehicles: [monthlyCar] });
  const res = await op('PUT', `/garages/${g.id}/entitlement-links`, { garage_pass: gpLink(gpGarage), monthly_billing: mbLink(mbGarage) });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  return { ...g, gpGarage, mbGarage, passCar, monthlyCar, passId: `pass-${tag}`, agreement: `ag-${tag}` };
}

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  modules = await startEntitlementModules();
  tenant = await createTenant('rules');
  await buildWorld(tenant);
  operatorToken = await issueOperatorToken(tenant);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await modules?.stop();
  await pool.end();
});

// --- the shape ------------------------------------------------------------------------

test('the payload carries the plans whole, the space class, the entitlements, the stays -- and no hourly figure', async () => {
  const g = await garage({ plans: 3 });
  const payload = await rules(g.entry);
  assert.deepEqual(Object.keys(payload).sort(), [
    'active', 'currency', 'default_action', 'direction', 'entitlements', 'garage_id', 'lane_id',
    'rate_plans', 'space_class', 'stays', 'synced_at', 'timezone',
  ]);
  for (const gone of ['hourly_minor', 'rate_id', 'plate_rules']) assert.equal(gone in payload, false, gone);
  assert.equal(payload.space_class, 'standard');
  assert.equal(payload.active, true);
  // Every plan, whole, oldest first -- the same list the close hands the engine.
  assert.deepEqual(payload.rate_plans.map((p) => p.plan_version), ['flat-250-USD', 'v2', 'v3']);
  const stored = await withTenant(tenant, async (c) =>
    (await c.query(`SELECT document FROM rate_plans WHERE garage_id = $1 ORDER BY effective_from`, [g.id])).rows.map((r) => r.document),
  );
  assert.deepEqual(payload.rate_plans, stored, 'the documents as 0012 stores them, nothing filtered, nothing added');
  // CONTROL: the plans are not the same object under two names.
  assert.notDeepEqual(payload.rate_plans[0], payload.rate_plans[2]);
  assert.deepEqual(payload.stays, { cursor: '0', open: [] });
  assert.equal(payload.entitlements.complete, true);
  assert.equal(payload.entitlements.garage_pass.consulted, false);
  assert.equal(payload.entitlements.monthly_billing.consulted, false);
  assert.match(payload.entitlements.garage_pass.reason, /not linked/);
});

// --- the entitlements ----------------------------------------------------------------

test('each linked module\'s register is read through its own show-garage-register verb and kept verbatim', async () => {
  const w = await linkedWorld();
  const payload = await rules(w.exit);
  const { entitlements } = payload;
  assert.equal(entitlements.complete, true);
  assert.match(entitlements.read_at, /^\d{4}-\d{2}-\d{2}T/);

  const gp = entitlements.garage_pass;
  assert.equal(gp.consulted, true);
  assert.deepEqual(gp.argv, [REGISTER_VERB, '--tenant', modules.garage_pass.tenant, '--garage', w.gpGarage]);
  assert.equal(gp.exit_code, 0);
  assert.equal(gp.register.garage, w.gpGarage);
  assert.deepEqual(gp.register.registrations.map((r) => [r.vehicle_identity, r.pass]), [[w.passCar, w.passId]]);
  assert.deepEqual(gp.register.passes.map((p) => [p.pass, p.state, p.valid_from, p.valid_to]), [[w.passId, 'active', '2026-01-01', '2026-12-31']]);
  // Verbatim: the module's own bytes, parsed, and nothing of this platform's added.
  const printed = JSON.parse(await modules.gp(REGISTER_VERB, '--garage', w.gpGarage));
  assert.deepEqual(gp.register, printed);

  const mb = entitlements.monthly_billing;
  assert.equal(mb.consulted, true);
  assert.deepEqual(mb.argv, [REGISTER_VERB, '--tenant', modules.monthly_billing.tenant, '--garage', w.mbGarage]);
  assert.equal(mb.exit_code, 0);
  assert.equal(mb.register.garage, w.mbGarage);
  // monthly-billing stores the identity in the garage's own form: folded.
  assert.deepEqual(mb.register.registrations.map((r) => [r.identity_normalised, r.agreement]), [[w.monthlyCar.toLowerCase(), w.agreement]]);
  assert.deepEqual(mb.register.agreements.map((a) => [a.agreement, a.status, a.registrar]), [[w.agreement, 'active', 'this_module']]);
  assert.deepEqual(mb.register.agreements_not_found, []);

  // The read wrote nothing anywhere: no event, no row.
  const { rows } = await withTenant(tenant, (c) => c.query(`SELECT count(*)::int AS n FROM events WHERE garage_id = $1`, [w.id]));
  const before = rows[0].n;
  await rules(w.exit);
  const again = await withTenant(tenant, (c) => c.query(`SELECT count(*)::int AS n FROM events WHERE garage_id = $1`, [w.id]));
  assert.equal(again.rows[0].n, before, 'a rules read appended an event');
});

test('a module whose register could not be read is said, not filled in: unavailable, complete false, the rest served', async () => {
  const w = await linkedWorld();
  // The premise: linked and readable.
  assert.equal((await rules(w.exit)).entitlements.complete, true);
  // garage-pass's door cannot be run: its DSN gone. The platform reaches the
  // module through the environment, so this is the outage as it would happen.
  const dsn = process.env.GARAGE_PASS_DSN;
  delete process.env.GARAGE_PASS_DSN;
  let payload;
  try {
    payload = await rules(w.exit);
  } finally {
    process.env.GARAGE_PASS_DSN = dsn;
  }
  const gp = payload.entitlements.garage_pass;
  assert.equal(gp.consulted, true);
  assert.equal('register' in gp, false, 'an outage must not read as an empty register');
  assert.equal(gp.exit_code, 2, 'the module said it could not answer (exit 2), and that is what is kept');
  assert.match(gp.unavailable, /GARAGE_PASS_DSN/);
  assert.equal(payload.entitlements.complete, false);
  // The other module, and the platform's own halves, are still served.
  assert.equal(payload.entitlements.monthly_billing.register.garage, w.mbGarage);
  assert.equal(payload.rate_plans.length, 1);
  assert.equal(payload.space_class, 'standard');
  // And back: the register is present again.
  assert.equal((await rules(w.exit)).entitlements.garage_pass.register.garage, w.gpGarage);
});

// --- the stays ------------------------------------------------------------------------

test('the open stays travel with a cursor, closed ones do not, and the delta carries both so a reader can drop a closed one', async () => {
  const g = await garage();
  const a = plate('A');
  const b = plate('B');
  assert.equal((await open(g.entry, a, '2026-09-10T12:00:00Z')).status, 201);
  assert.equal((await open(g.entry, b, '2026-09-10T12:05:00Z')).status, 201);
  const first = await rules(g.exit);
  assert.deepEqual(first.stays.open.map((s) => [s.plate, s.open, s.entry_at, s.entry_lane]), [
    [a, true, '2026-09-10T12:00:00.000Z', 'E'],
    [b, true, '2026-09-10T12:05:00.000Z', 'E'],
  ]);
  assert.deepEqual(Object.keys(first.stays.open[0]).sort(), ['change_seq', 'entry_at', 'entry_lane', 'open', 'plate', 'plate_region', 'session_id', 'ticket_ref']);
  assert.match(first.stays.cursor, /^\d+$/);
  assert.equal(first.stays.cursor, first.stays.open[1].change_seq, 'the cursor is the highest value the garage holds');
  // The stay route without `since` is the same set and the same cursor.
  const full = await (await stays(g.exit)).json();
  assert.deepEqual(full, { cursor: first.stays.cursor, open: first.stays.open });

  // Nothing changed: the delta is empty and the cursor does not move.
  const quiet = await (await stays(g.exit, first.stays.cursor)).json();
  assert.deepEqual(quiet, { since: first.stays.cursor, cursor: first.stays.cursor, changes: [], more: false });

  // A leaves and C arrives: the delta carries A closed and C open, in that
  // order, and the cursor is the last row's.
  assert.equal((await close(g.exit, a, '2026-09-10T13:00:00Z')).status, 200);
  const c = plate('C');
  assert.equal((await open(g.entry, c, '2026-09-10T13:05:00Z')).status, 201);
  const delta = await (await stays(g.exit, first.stays.cursor)).json();
  assert.deepEqual(delta.changes.map((s) => [s.plate, s.open]), [[a, false], [c, true]]);
  assert.equal(delta.more, false);
  assert.equal(delta.cursor, delta.changes[1].change_seq);
  assert.ok(BigInt(delta.cursor) > BigInt(first.stays.cursor));
  // The full set now: B and C, A gone.
  const second = await rules(g.exit);
  assert.deepEqual(second.stays.open.map((s) => s.plate), [b, c]);
  assert.equal(second.stays.cursor, delta.cursor);
  // CONTROL: the closed row really is closed in the table, and still carries the cursor value the delta showed.
  const { rows } = await withTenant(tenant, (cl) => cl.query(`SELECT exit_at, change_seq::text FROM sessions WHERE id = $1`, [delta.changes[0].session_id]));
  assert.notEqual(rows[0].exit_at, null);
  assert.equal(rows[0].change_seq, delta.changes[0].change_seq);
});

test('a ticket stay travels as its ticket: the identity the exit will read', async () => {
  const g = await garage();
  const res = await open(g.entry, undefined, '2026-09-10T12:00:00Z', { ticket_ref: 'T-0042' });
  assert.equal(res.status, 201, await res.clone().text());
  const payload = await rules(g.exit);
  assert.deepEqual(payload.stays.open.map((s) => [s.plate, s.ticket_ref]), [[null, 'T-0042']]);
});

test('the delta pages: a page that fills says more, and following it delivers the rest exactly once', async () => {
  const g = await garage();
  const cars = Array.from({ length: 7 }, (_, i) => plate(`P${i}`));
  for (const car of cars) assert.equal((await open(g.entry, car)).status, 201);
  // The page size is the route's; the test walks with whatever it is by
  // asking from zero and following `more`. Seven rows, a page of 500: one
  // page. The paging itself is exercised in the fail-control with the size
  // planted down to 3 -- here the contract: following `more` until it is
  // false yields every row once.
  let since = '0';
  const seen = [];
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await (await stays(g.exit, since)).json();
    seen.push(...page.changes.map((s) => s.plate));
    since = page.cursor;
    if (!page.more) break;
  }
  assert.deepEqual(seen, cars);
});

test('since must be a cursor this route handed out', async () => {
  const g = await garage();
  for (const bad of ['abc', '-1', '1e3', '12345678901234567890']) {
    const res = await stays(g.exit, bad);
    assert.equal(res.status, 400, bad);
    assert.match((await res.json()).error, /cursor/);
  }
  assert.equal((await stays(g.exit, '0')).status, 200);
});

test('every writer moves the cursor: a close bumps the row without the route knowing (the trigger), and the purge does not', async () => {
  const g = await garage();
  const a = plate('A');
  await open(g.entry, a);
  const opened = (await rules(g.exit)).stays.open[0];
  await close(g.exit, a, '2026-09-10T14:00:00Z');
  const { rows } = await withTenant(tenant, (c) => c.query(`SELECT change_seq::text FROM sessions WHERE id = $1`, [opened.session_id]));
  assert.ok(BigInt(rows[0].change_seq) > BigInt(opened.change_seq), 'the close moved the cursor value');
  // A change that is not a car arriving or leaving does not move it: the
  // purge's shape, an UPDATE of a column the feed does not carry.
  await withTenant(tenant, (c) => c.query(`UPDATE sessions SET entitlement = NULL, exit_descriptor = NULL WHERE id = $1`, [opened.session_id]));
  const after = await withTenant(tenant, (c) => c.query(`SELECT change_seq::text FROM sessions WHERE id = $1`, [opened.session_id]));
  assert.equal(after.rows[0].change_seq, rows[0].change_seq);
});

test('the cursor\'s stated limit, planted: a delta can miss a row whose commit came after a later cursor; the full set has it', async () => {
  const g = await garage();
  const seed = plate('S');
  await open(g.entry, seed);
  const start = (await rules(g.exit)).stays.cursor;

  // An in-flight transaction takes its cursor value NOW and commits LATER.
  const inflight = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
  await inflight.connect();
  let advanced;
  const later = plate('L');
  try {
    await inflight.query('BEGIN');
    await inflight.query(`SELECT set_config('openparking.tenant_id', $1, true)`, [tenant]);
    const { rows: v } = await inflight.query(`INSERT INTO vehicles (tenant_id, plate) VALUES ($1, $2) RETURNING id`, [tenant, plate('LATE')]);
    await inflight.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency, open_event_id, entry_confirmation)
       VALUES ($1, $2, $3, $4, '2026-09-10T12:30:00Z', 'USD', $5, 'confirmed')`,
      [tenant, g.id, v[0].id, g.entryLane, randomUUID()],
    );
    // A later row commits first, so the garage's cursor is past the in-flight one.
    assert.equal((await open(g.entry, later)).status, 201);
    const delta = await (await stays(g.exit, start)).json();
    assert.deepEqual(delta.changes.map((s) => s.plate), [later]);
    advanced = delta.cursor;
    // Now the earlier value commits.
    await inflight.query('COMMIT');
  } finally {
    await inflight.end();
  }
  // The delta since the advanced cursor cannot see it: the stated limit.
  const missed = await (await stays(g.exit, advanced)).json();
  assert.deepEqual(missed.changes, [], 'the premise of the limit: the late commit is below the cursor');
  // The full set has it -- which is why a reader takes the full set on the slow cadence.
  const full = await rules(g.exit);
  const plates = full.stays.open.map((s) => s.plate);
  assert.equal(plates.length, 3);
  assert.ok(plates.some((p) => p.startsWith('LATE')), plates);
  assert.ok(BigInt(full.stays.cursor) >= BigInt(advanced));
});

// --- the shape survives what the schema gate would drop -----------------------------------

test('space_class and the plans are the garage\'s own: two garages, two payloads', async () => {
  const one = await garage();
  const two = await garage({ plans: 2 });
  await withTenant(tenant, (c) => c.query(`UPDATE garages SET space_class = 'compact' WHERE id = $1`, [two.id]));
  const p1 = await rules(one.entry);
  const p2 = await rules(two.entry);
  assert.equal(p1.space_class, 'standard');
  assert.equal(p2.space_class, 'compact');
  assert.equal(p1.rate_plans.length, 1);
  assert.equal(p2.rate_plans.length, 2);
});
