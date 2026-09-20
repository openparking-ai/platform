/**
 * The exit's three outcomes, and the two modules consulted before pricing
 * (migration 0015) -- driven through the lane's close against the REAL
 * garage-pass and monthly-billing, each with its own database built from
 * its own migrations and seeded through its own doors.
 *
 * Every claim of coverage is paired with the same close, for a car the
 * modules do not know, pricing as transient -- and every refusal-to-decide
 * with the same close succeeding when the module is back.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { startEntitlementModules } from './entitlement-modules.js';
import { EXIT_OUTCOMES, EXIT_COVERED_EVENT_KIND, LINKS_STATED_EVENT_KIND } from '../src/entitlement.js';
import { redactExpiredVehicles } from '../src/retention.js';

let engine;
let modules;
let server;
let base;
let tenant;
let operatorToken;
let operatorTokenId;

async function issueToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [tenantId, laneId, name, hashToken(token)]),
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

/** An active platform garage with a flat plan and both lanes. */
async function garage() {
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Outcomes','America/New_York','USD') RETURNING id`, [tenant])).rows[0].id;
    const lane = async (name, direction) =>
      (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, id, name, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan());
    await activateGarage(c, tenant, id);
    return { id, entryLane, exitLane };
  });
  return { ...built, entry: await issueToken(tenant, built.entryLane, 'e'), exit: await issueToken(tenant, built.exitLane, 'x') };
}
const links = (garageId, body) => op('PUT', `/garages/${garageId}/entitlement-links`, body);
const gpLink = (garageId) => ({ tenant_id: modules.garage_pass.tenant, garage_id: garageId });
const mbLink = (garageId) => ({ tenant_id: modules.monthly_billing.tenant, garage_id: garageId });

const open = (token, plate, entryAt = '2026-09-10T12:00:00Z', extra = {}) =>
  fetch(`${base}/api/v1/lane/sessions/open`, asDevice(token, { plate, entry_at: entryAt, entry_confirmation: 'confirmed', ...extra }));
const close = (token, plate, exitAt = '2026-09-10T14:00:00Z', extra = {}) =>
  fetch(`${base}/api/v1/lane/sessions/close`, asDevice(token, { plate, exit_at: exitAt, exit_confirmation: 'confirmed', ...extra }));
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
const eventsOf = (kind, garageId) =>
  withTenant(tenant, async (c) =>
    (await c.query(`SELECT * FROM events WHERE tenant_id = $1 AND kind = $2 AND garage_id = $3 ORDER BY received_at`, [tenant, kind, garageId])).rows,
  );
const rowFor = (id) => withTenant(tenant, async (c) => (await c.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0]);

/** One garage in each module, linked, with a pass holder and a monthly vehicle. */
async function linkedWorld() {
  const g = await garage();
  const gpGarage = `gp-${g.id.slice(0, 8)}`;
  const mbGarage = `mb-${g.id.slice(0, 8)}`;
  const passCar = plate('PASS');
  const monthlyCar = plate('MNTH');
  await modules.gpGarage(gpGarage);
  await modules.gpPass(`pass-${g.id.slice(0, 8)}`, [gpGarage]);
  await modules.gpRegister(`pass-${g.id.slice(0, 8)}`, gpGarage, passCar);
  await modules.mbSeed({ garage: mbGarage, agreement: `ag-${g.id.slice(0, 8)}`, payer: `payer-${g.id.slice(0, 8)}`, vehicles: [monthlyCar] });
  const res = await links(g.id, { garage_pass: gpLink(gpGarage), monthly_billing: mbLink(mbGarage) });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  return { ...g, gpGarage, mbGarage, passCar, monthlyCar, passId: `pass-${g.id.slice(0, 8)}`, agreement: `ag-${g.id.slice(0, 8)}` };
}

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  modules = await startEntitlementModules();
  tenant = await createTenant('outcomes');
  await buildWorld(tenant);
  ({ token: operatorToken, id: operatorTokenId } = await issueOperatorToken(tenant));
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

// --- the vocabulary --------------------------------------------------------------------

test('the exit has three named outcomes, and the third is declared and produced nowhere', async () => {
  assert.deepEqual(Object.values(EXIT_OUTCOMES), ['covered', 'transient', 'transient_card_on_file']);
  // Nothing in src writes the third: no customer, no account, no card exists to produce it.
  const files = await readdir(new URL('../src', import.meta.url));
  for (const f of files) {
    const source = await readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
    const writes = source.match(/EXIT_OUTCOMES\.TRANSIENT_CARD_ON_FILE|'transient_card_on_file'/g) ?? [];
    // entitlement.js declares it once, in the frozen set; nothing else names it.
    assert.equal(writes.length, f === 'entitlement.js' ? 1 : 0, `${f} produces transient_card_on_file`);
  }
  const { rows } = await pool.query(`SELECT count(*) FROM sessions WHERE exit_outcome = 'transient_card_on_file'`);
  assert.equal(Number(rows[0].count), 0);
  // CONTROL: the schema does admit it, so the zero above is a fact about the code.
  const check = await pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'sessions_exit_outcome_is_named'`);
  assert.match(check.rows[0].def, /transient_card_on_file/);
});

// --- covered ---------------------------------------------------------------------------

test('a pass holder leaves COVERED: no fee, the pass named, both modules on the record, an event', async () => {
  const w = await linkedWorld();
  assert.equal((await open(w.entry, w.passCar)).status, 201);
  const res = await close(w.exit, w.passCar);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const { session } = await res.json();
  assert.equal(session.exit_outcome, 'covered');
  assert.equal(session.fee_minor, null);
  assert.equal(session.plan_version, null);
  assert.equal(session.pricing_refusal, null);
  assert.deepEqual(session.entitlement.covered_by, ['garage_pass']);
  assert.equal(session.entitlement.garage_pass.consulted, true);
  assert.equal(session.entitlement.garage_pass.covered, true);
  assert.equal(session.entitlement.garage_pass.answer.pass_id, w.passId, "the module's answer, verbatim");
  assert.equal(session.entitlement.garage_pass.answer.outcome, 'covered');
  assert.equal(session.entitlement.monthly_billing.consulted, true, 'the second module is asked even when the first covered');
  assert.equal(session.entitlement.monthly_billing.covered, false);
  assert.equal(session.entitlement.monthly_billing.answer.verdict, 'NOT COVERED');
  assert.equal(session.entitlement.identity, w.passCar);

  const [event] = await eventsOf(EXIT_COVERED_EVENT_KIND, w.id);
  assert.ok(event, 'money not charged is recorded');
  assert.equal(event.detail.session_id, session.id);
  assert.deepEqual(event.detail.covered_by, ['garage_pass']);
  assert.equal(event.detail.pass_id, w.passId);
  assert.equal(event.lane_id, w.exitLane);
  // Not in the unpriced list: covered is not unpriced.
  const report = await (await op('GET', `/garages/${w.id}/reconciliation?max_stay_hours=24&hours=2160`)).json();
  assert.deepEqual(report.closes_unpriced.sessions, []);
});

test('a monthly agreement vehicle leaves COVERED by monthly-billing, with the agreement named', async () => {
  const w = await linkedWorld();
  await open(w.entry, w.monthlyCar);
  const { session } = await (await close(w.exit, w.monthlyCar)).json();
  assert.equal(session.exit_outcome, 'covered');
  assert.deepEqual(session.entitlement.covered_by, ['monthly_billing']);
  assert.equal(session.entitlement.monthly_billing.answer.verdict, 'COVERED');
  assert.ok(session.entitlement.monthly_billing.answer.lines.some((l) => l.includes(`under agreement ${w.agreement}`)));
  assert.equal(session.entitlement.garage_pass.covered, false);
  assert.equal(session.entitlement.garage_pass.answer.reason, 'NO_PASS', 'the named reason for the not-covered half');
  const [event] = await eventsOf(EXIT_COVERED_EVENT_KIND, w.id);
  assert.match(event.detail.agreement, new RegExp(`under agreement ${w.agreement}`));
});

// --- transient -------------------------------------------------------------------------

test('a car neither module knows is TRANSIENT: priced by the engine, both named reasons on the record, no covered event', async () => {
  const w = await linkedWorld();
  const car = plate('TRNS');
  await open(w.entry, car);
  const { session } = await (await close(w.exit, car)).json();
  assert.equal(session.exit_outcome, 'transient');
  assert.equal(session.fee_minor, 500, 'two hours at the flat plan');
  assert.equal(session.plan_version, 'flat-250-USD');
  assert.deepEqual(session.entitlement.covered_by, []);
  assert.equal(session.entitlement.garage_pass.answer.reason, 'NO_PASS');
  assert.equal(session.entitlement.garage_pass.exit_code, 1);
  assert.equal(session.entitlement.monthly_billing.answer.verdict, 'NOT COVERED');
  assert.equal(session.entitlement.monthly_billing.exit_code, 1);
  assert.deepEqual(await eventsOf(EXIT_COVERED_EVENT_KIND, w.id), []);
});

test('a garage linked to neither module prices every exit as transient, and the record says so', async () => {
  const g = await garage();
  const car = plate('NOLK');
  await open(g.entry, car);
  const { session } = await (await close(g.exit, car)).json();
  assert.equal(session.exit_outcome, 'transient');
  assert.equal(session.fee_minor, 500);
  assert.equal(session.entitlement.garage_pass.consulted, false);
  assert.match(session.entitlement.garage_pass.reason, /not linked/);
  assert.equal(session.entitlement.monthly_billing.consulted, false);
  assert.deepEqual(session.entitlement.covered_by, []);
});

test('a ticket stay consults with the ticket text and is transient', async () => {
  const w = await linkedWorld();
  const ticket = `T-${randomUUID().slice(0, 8).toUpperCase()}`;
  assert.equal((await open(w.entry, undefined, '2026-09-10T12:00:00Z', { ticket_ref: ticket })).status, 201);
  const res = await close(w.exit, undefined, '2026-09-10T14:00:00Z', { ticket_ref: ticket });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const { session } = await res.json();
  assert.equal(session.exit_outcome, 'transient');
  assert.equal(session.entitlement.identity, ticket);
  assert.equal(session.entitlement.garage_pass.answer.vehicle_identity, ticket);
});

// --- no money crosses ------------------------------------------------------------------

test('no amount travels to either module: the argv carries an identity, a garage, a lane and instants', async () => {
  const w = await linkedWorld();
  await open(w.entry, w.passCar);
  const { session } = await (await close(w.exit, w.passCar)).json();
  for (const module of ['garage_pass', 'monthly_billing']) {
    const argv = session.entitlement[module].argv;
    assert.ok(Array.isArray(argv) && argv.length > 0);
    const flags = argv.filter((a) => a.startsWith('--'));
    assert.deepEqual(
      flags,
      module === 'garage_pass'
        ? ['--tenant', '--garage', '--vehicle', '--lane', '--direction', '--at']
        : ['--tenant', '--garage', '--vehicle', '--at', '--entered-at'],
    );
    assert.ok(!/minor|amount|fee|price|currency/i.test(argv.join(' ')), `${module} was handed money`);
  }
  // CONTROL: the sweep would catch an amount.
  assert.ok(/minor|amount|fee|price|currency/i.test('--fee-minor 500'));
});

// --- could not decide is not not-covered ---------------------------------------------------

test('a module that cannot answer is NOT a not-covered: 500, nothing written, the stay open; the same close covers when it is back', async () => {
  const w = await linkedWorld();
  await open(w.entry, w.passCar);
  const closeEvent = randomUUID();
  const before = await withTenant(tenant, async (c) => Number((await c.query('SELECT count(*) FROM events WHERE tenant_id = $1', [tenant])).rows[0].count));
  const live = process.env.GARAGE_PASS_DSN;
  try {
    process.env.GARAGE_PASS_DSN = 'host=127.0.0.1 port=1 dbname=none user=none password=none';
    const res = await close(w.exit, w.passCar, '2026-09-10T14:00:00Z', { event_id: closeEvent });
    assert.equal(res.status, 500);
  } finally {
    process.env.GARAGE_PASS_DSN = live;
  }
  const row = await withTenant(tenant, async (c) => (await c.query('SELECT exit_at, exit_outcome FROM sessions WHERE garage_id = $1', [w.id])).rows[0]);
  assert.equal(row.exit_at, null, 'still open');
  assert.equal(row.exit_outcome, null);
  const after = await withTenant(tenant, async (c) => Number((await c.query('SELECT count(*) FROM events WHERE tenant_id = $1', [tenant])).rows[0].count));
  assert.equal(after, before, 'no event of any kind');
  const retry = await close(w.exit, w.passCar, '2026-09-10T14:00:00Z', { event_id: closeEvent });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).session.exit_outcome, 'covered');
});

test('a module whose script is missing is the same: could not decide, 500', async () => {
  const w = await linkedWorld();
  await open(w.entry, w.passCar);
  const live = process.env.ENTITLEMENT_BIN_DIR;
  try {
    process.env.ENTITLEMENT_BIN_DIR = '/nonexistent';
    assert.equal((await close(w.exit, w.passCar)).status, 500);
  } finally {
    if (live === undefined) delete process.env.ENTITLEMENT_BIN_DIR;
    else process.env.ENTITLEMENT_BIN_DIR = live;
  }
  assert.equal((await close(w.exit, w.passCar)).status, 200);
});

// --- links are stated, probed, recorded ----------------------------------------------------

test('a link the module cannot answer questions about is refused by name, and nothing is stored', async () => {
  const g = await garage();
  const res = await links(g.id, { garage_pass: gpLink('no-such-garage'), monthly_billing: null });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'entitlement_link_unanswerable');
  assert.match(body.error, /garage_pass/);
  assert.match(body.error, /no garage 'no-such-garage'/);
  const mb = await links(g.id, { garage_pass: null, monthly_billing: mbLink('no-such-garage') });
  assert.equal(mb.status, 409);
  assert.match((await mb.json()).error, /monthly_billing.*no garage with id 'no-such-garage'/);
  const row = await withTenant(tenant, async (c) => (await c.query('SELECT garage_pass_link, monthly_billing_link FROM garages WHERE id = $1', [g.id])).rows[0]);
  assert.deepEqual(row, { garage_pass_link: null, monthly_billing_link: null });
  assert.deepEqual(await eventsOf(LINKS_STATED_EVENT_KIND, g.id), [], 'a refused statement leaves no record');
  // CONTROL: a garage the module knows is accepted, recorded, and probed.
  const gpGarage = `gp-${g.id.slice(0, 8)}`;
  await modules.gpGarage(gpGarage);
  const ok = await links(g.id, { garage_pass: gpLink(gpGarage), monthly_billing: null });
  assert.equal(ok.status, 200);
  const { garage: stated } = await ok.json();
  assert.deepEqual(stated.garage_pass_link, gpLink(gpGarage));
  assert.equal(stated.monthly_billing_link, null);
  const [event] = await eventsOf(LINKS_STATED_EVENT_KIND, g.id);
  assert.equal(event.detail.actor, `operator_token:${operatorTokenId}`);
  assert.deepEqual(event.detail.before, { garage_pass: null, monthly_billing: null });
  assert.deepEqual(event.detail.after.garage_pass, gpLink(gpGarage));
  assert.equal(event.detail.probes.garage_pass.answered, true);
  assert.equal(event.detail.probes.garage_pass.exit_code, 1, 'the probe identity is not covered, and the module answered');
});

test('a link is stated, never inferred: the shape is refused, and the platform does not guess the module garage from its own id', async () => {
  const g = await garage();
  for (const body of [
    {},
    { garage_pass: null },
    { garage_pass: { tenant_id: 'x' }, monthly_billing: null },
    { garage_pass: 'gp-1', monthly_billing: null },
    { garage_pass: null, monthly_billing: null, other: 1 },
  ]) {
    assert.equal((await links(g.id, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await links(randomUUID(), { garage_pass: null, monthly_billing: null })).status, 404);
  // Unlinking is a statement too, and is recorded.
  assert.equal((await links(g.id, { garage_pass: null, monthly_billing: null })).status, 200);
  assert.equal((await eventsOf(LINKS_STATED_EVENT_KIND, g.id)).length, 1);
  // A module garage named after the platform's id is not consulted unless stated.
  await modules.gpGarage(g.id);
  const car = plate('INFR');
  await open(g.entry, car);
  const { session } = await (await close(g.exit, car)).json();
  assert.equal(session.entitlement.garage_pass.consulted, false);
});

test('the database holds a link to its shape', async () => {
  const g = await garage();
  for (const bad of ['"gp-1"', '{"tenant_id": "t"}', '{"tenant_id": "", "garage_id": "g"}', '[]']) {
    await assert.rejects(
      withTenant(tenant, (c) => c.query(`UPDATE garages SET garage_pass_link = $2::jsonb WHERE id = $1`, [g.id, bad])),
      (err) => err.constraint === 'garages_garage_pass_link_is_a_link',
      bad,
    );
  }
});

// --- the row's shapes ----------------------------------------------------------------------

test('a covered close carries no fee and no pricing; a fee beside covered, or a pricing with no outcome, is refused by the database', async () => {
  const w = await linkedWorld();
  const id = await withTenant(tenant, async (c) => {
    const v = (await c.query(`INSERT INTO vehicles (tenant_id, plate) VALUES ($1, $2) RETURNING id`, [tenant, plate('SHAP')])).rows[0].id;
    return (await c.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency, open_event_id, entry_confirmation)
       VALUES ($1,$2,$3,$4, now() - interval '2 hours', 'USD', $5, 'confirmed') RETURNING id`,
      [tenant, w.id, v, w.entryLane, randomUUID()],
    )).rows[0].id;
  });
  const closeSql = (extra) =>
    `UPDATE sessions SET exit_at = now(), exit_lane_id = $2, close_event_id = $3, exit_confirmation = 'confirmed',
            entitlement = '{"covered_by": ["garage_pass"]}'::jsonb, ${extra} WHERE id = $1`;
  for (const extra of [
    `exit_outcome = 'covered', fee_minor = 100`,
    `exit_outcome = 'covered', plan_version = 'v', breakdown = '[]'::jsonb, space_class = 'standard'`,
    `exit_outcome = 'covered', pricing_refusal = '[]'::jsonb`,
    `exit_outcome = NULL, fee_minor = 100, plan_version = 'v', breakdown = '[]'::jsonb, space_class = 'standard'`,
    `exit_outcome = 'nonsense'`,
  ]) {
    await assert.rejects(
      withTenant(tenant, (c) => c.query(closeSql(extra), [id, w.exitLane, randomUUID()])),
      (err) => ['sessions_closed_is_covered_priced_or_refused', 'sessions_exit_outcome_is_named'].includes(err.constraint),
      extra,
    );
  }
  // CONTROL: the covered shape lands.
  await withTenant(tenant, (c) => c.query(closeSql(`exit_outcome = 'covered'`), [id, w.exitLane, randomUUID()]));
  assert.equal((await rowFor(id)).exit_outcome, 'covered');
});

// --- retention -------------------------------------------------------------------------

test('the purge nulls the entitlement record of a redacted vehicle and keeps the outcome', async () => {
  const w = await linkedWorld();
  const DAY = 86_400_000;
  const car = plate('OLDP');
  await modules.gpRegister(w.passId, w.gpGarage, car);
  const entryAt = new Date(Date.now() - 41 * DAY).toISOString();
  const exitAt = new Date(Date.now() - 40 * DAY).toISOString();
  await open(w.entry, car, entryAt);
  const { session } = await (await close(w.exit, car, exitAt)).json();
  assert.equal(session.exit_outcome, 'covered');
  await withTenant(tenant, (c) => c.query(`UPDATE vehicles SET last_seen_at = $2 WHERE id = $1`, [session.vehicle_id, exitAt]));
  const result = await redactExpiredVehicles(tenant);
  assert.ok(result.redacted >= 1, 'the control: the purge redacted something');
  const row = await rowFor(session.id);
  assert.equal(row.entitlement, null, 'the record naming the identity is gone');
  assert.equal(row.exit_outcome, 'covered', 'the outcome stays');
  const vehicle = await withTenant(tenant, async (c) => (await c.query('SELECT redacted_at FROM vehicles WHERE id = $1', [session.vehicle_id])).rows[0]);
  assert.ok(vehicle.redacted_at, 'and it was this vehicle');
});
