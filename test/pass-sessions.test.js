/**
 * A PASS'S VISITS ARE SESSIONS OF THE PASS, AND A CAR A QR LET IN IS THE
 * PASS'S CAR AT THE EXIT (the owner's rules, 2026-10-31; 0048), against the
 * REAL garage-pass, through its own command line and database (the suite's
 * module harness, test/entitlement-modules.js), at the commit in
 * `garage-pass.pin` -- the one where a QR passes a plate "similar enough".
 *
 * What this file measures, each with a break in
 * `scripts/exit-rules-fail-control.js`:
 *
 *   * each in and out of a pass holder is its own stay -- a session of the
 *     pass -- asked about at its own exit with its own entry, and kept with
 *     the pass it was a session of; the past stays say so;
 *   * the pass's own rules are judged per session: a session after the
 *     pass's last day is priced from its own entry, nothing carried from
 *     the session before;
 *   * a stay a registration QR let in keeps the QR's id, how it passed and
 *     the QR's plate; its exit asks garage-pass by the QR's plate, so a car
 *     let in on one difference or with nothing read is covered as the pass
 *     it is -- and the same car with no QR pays;
 *   * the QR is checked to its shape; a key this build does not know is left
 *     on the lane; the retention purge takes the QR's plate with the vehicle.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { startEntitlementModules } from './entitlement-modules.js';
import { redactExpiredVehicles } from '../src/retention.js';

const RULE = 'opvid-plate-chars/1';

let engine;
let modules;
let server;
let base;
let tenant;
let op;

const call = (token, method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const tag = () => randomUUID().replace(/[^0-9]/g, '').slice(0, 5).padEnd(5, '7');

async function device(laneId, name) {
  const t = generateDeviceToken();
  await withTenant(tenant, (c) => c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)',
    [tenant, laneId, name, hashToken(t)]));
  return t;
}

/** A platform garage linked to a garage-pass garage, with one pass registered to one car. */
async function world({ validTo = '2026-12-31' } = {}) {
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Passes','America/New_York','USD') RETURNING id`, [tenant])).rows[0].id;
    const lane = async (name, direction) =>
      (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, id, name, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan());
    await activateGarage(c, tenant, id);
    return { id, entryLane, exitLane };
  });
  const gpGarage = `gp-${built.id.slice(0, 8)}`;
  const passId = `pass-${built.id.slice(0, 8)}`;
  const passCar = `PAS${tag()}`;
  await modules.gpGarage(gpGarage, 'America/New_York');
  await modules.gpPass(passId, [gpGarage], { validTo });
  await modules.gpRegister(passId, gpGarage, passCar);
  const linked = await call(op, 'PUT', `/garages/${built.id}/entitlement-links`, {
    garage_pass: { tenant_id: modules.garage_pass.tenant, garage_id: gpGarage }, monthly_billing: null,
  });
  assert.equal(linked.status, 200, await linked.clone().text());
  return { ...built, gpGarage, passId, passCar, entry: await device(built.entryLane, 'entry'), exit: await device(built.exitLane, 'exit') };
}

/** A QR minted at the desk for one car of the pass, by its plate. */
async function qrFor(w, plate, enrolment = `enr-${randomUUID().slice(0, 8)}`) {
  await modules.gp('issue-enrolment', '--garage', w.gpGarage, '--pass-id', w.passId, '--enrolment-id', enrolment,
    '--starts-on', '2026-09-01', '--days-valid', '30', '--by', 'the desk', '--at', '2026-09-01T09:00:00+00:00', '--plate', plate);
  return enrolment;
}

async function open(w, body) {
  const res = await call(w.entry, 'POST', '/lane/sessions/open', { event_id: randomUUID(), entry_confirmation: 'confirmed', ...body });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).session;
}
async function closeByPlate(w, plate, exitAt) {
  const res = await call(w.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), plate, exit_at: exitAt, exit_confirmation: 'confirmed' });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).session;
}
const stayRow = (id) => withTenant(tenant, async (c) => (await c.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0]);

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  modules = await startEntitlementModules();
  tenant = await createTenant('pass-sessions');
  op = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)`, [tenant, hashToken(op)]));
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

test('EACH VISIT IS A SESSION OF THE PASS: two visits are two stays, each asked about with its own entry, each covered and kept with its pass', async () => {
  const w = await world();
  const first = await open(w, { plate: w.passCar, entry_at: '2026-09-10T12:00:00Z' });
  const out1 = await closeByPlate(w, w.passCar, '2026-09-10T14:00:00Z');
  // Back five minutes after it left: a new session, never the old stay.
  const second = await open(w, { plate: w.passCar, entry_at: '2026-09-10T14:05:00Z' });
  assert.notEqual(second.id, first.id);
  const out2 = await closeByPlate(w, w.passCar, '2026-09-10T15:00:00Z');
  for (const [s, entered] of [[out1, '2026-09-10T12:00:00.000Z'], [out2, '2026-09-10T14:05:00.000Z']]) {
    assert.deepEqual([s.exit_outcome, s.fee_minor], ['covered', null]);
    const row = await stayRow(s.id);
    assert.deepEqual(row.pass_session, { module: 'garage_pass', pass_id: w.passId, covered: true, reason: null, covering_term: row.pass_session.covering_term });
    const argv = row.entitlement.garage_pass.argv;
    assert.equal(argv[argv.indexOf('--entered-at') + 1], entered, "asked with the session's own entry");
  }
  const res = await call(op, 'GET', `/garages/${w.id}/stays/closed?from=2026-09-10T00:00:00Z&to=2026-09-11T00:00:00Z`);
  const past = (await res.json()).stays;
  assert.deepEqual(past.map((p) => p.pass), [
    { module: 'garage_pass', pass_id: w.passId, covered: true }, { module: 'garage_pass', pass_id: w.passId, covered: true },
  ], 'the past stays name the pass each was a session of');
});

test("THE PASS'S OWN RULES, PER SESSION: a session after the pass's last day is priced from its own entry -- nothing carried from the session before", async () => {
  const w = await world({ validTo: '2026-09-10' });
  await open(w, { plate: w.passCar, entry_at: '2026-09-10T12:00:00Z' });
  const covered = await closeByPlate(w, w.passCar, '2026-09-10T22:00:00Z');
  assert.equal(covered.exit_outcome, 'covered');
  const next = await open(w, { plate: w.passCar, entry_at: '2026-09-11T13:00:00Z' });
  const priced = await closeByPlate(w, w.passCar, '2026-09-11T13:40:00Z');
  assert.equal(priced.id, next.id);
  assert.deepEqual([priced.exit_outcome, priced.fee_minor], ['transient', 250], 'forty minutes of its own: one hour, not the day before');
  const row = await stayRow(priced.id);
  assert.deepEqual([row.pass_session.module, row.pass_session.pass_id, row.pass_session.covered], ['garage_pass', w.passId, false]);
  assert.ok(row.pass_session.reason, "the pass module's reason kept");
});

test("A CAR A QR LET IN ON ONE DIFFERENCE is the pass's car at the exit: garage-pass is asked by the QR's plate -- and the same car with no QR pays", async () => {
  const w = await world();
  const qrPlate = `QRA${tag()}`;
  const enrolment = await qrFor(w, qrPlate);
  const read = `${qrPlate.slice(0, -1)}${qrPlate.endsWith('8') ? '9' : '8'}`;
  const opened = await open(w, {
    plate: read, entry_at: '2026-09-10T12:00:00Z', plate_characters: { state: 'read', rule: RULE, pattern: read },
    qr: { enrolment, passed_by: 'one_difference', qr_plate: qrPlate },
  });
  assert.deepEqual((await stayRow(opened.id)).entry_qr, { enrolment, passed_by: 'one_difference', qr_plate: qrPlate });
  const res = await call(w.exit, 'POST', '/lane/exits', { event_id: randomUUID(), exit_at: '2026-09-10T13:00:00Z', plate_characters: { state: 'read', rule: RULE, pattern: read } });
  assert.equal(res.status, 201, await res.clone().text());
  const { exit } = await res.json();
  assert.deepEqual([exit.session_id, exit.settled, exit.why], [opened.id, true, 'covered'], JSON.stringify(exit));
  const closed = await call(w.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: '2026-09-10T13:01:00Z', exit_confirmation: 'confirmed' });
  assert.equal(closed.status, 200, await closed.clone().text());
  const row = await stayRow(opened.id);
  assert.equal(row.exit_outcome, 'covered');
  const gp = row.entitlement.garage_pass;
  assert.deepEqual([gp.asked_as, gp.argv[gp.argv.indexOf('--vehicle') + 1], gp.qr.enrolment], ['qr_plate', qrPlate, enrolment]);
  assert.deepEqual([row.pass_session.pass_id, row.pass_session.covered, row.pass_session.enrolment, row.pass_session.passed_by],
    [w.passId, true, enrolment, 'one_difference']);

  // The same read with no QR is a car of its own: not the pass's, it pays.
  const other = `QRB${tag()}`;
  await open(w, { plate: other, entry_at: '2026-09-10T12:00:00Z', plate_characters: { state: 'read', rule: RULE, pattern: other } });
  const plain = await closeByPlate(w, other, '2026-09-10T13:00:00Z');
  assert.deepEqual([plain.exit_outcome, plain.fee_minor], ['transient', 250]);
});

test('A CAR A QR LET IN WITH NOTHING READ: the unread stay the lane names at the exit is covered as the pass\'s car; monthly billing is not asked about a car with no plate', async () => {
  const w = await world();
  const qrPlate = `QRC${tag()}`;
  const enrolment = await qrFor(w, qrPlate);
  const opened = await open(w, {
    plate_unreadable: true, entry_at: '2026-09-10T12:00:00Z', no_open_command: false,
    qr: { enrolment, passed_by: 'nothing_read', qr_plate: qrPlate },
  });
  const res = await call(w.exit, 'POST', '/lane/exits', { event_id: randomUUID(), exit_at: '2026-09-10T13:00:00Z', session_id: opened.id });
  assert.equal(res.status, 201, await res.clone().text());
  const { exit } = await res.json();
  assert.deepEqual([exit.method, exit.why], ['lane', 'covered']);
  const q = await withTenant(tenant, async (c) => (await c.query('SELECT quote FROM exits WHERE id = $1', [exit.id])).rows[0].quote);
  assert.equal(q.entitlement.garage_pass.asked_as, 'qr_plate');
  assert.deepEqual(q.entitlement.monthly_billing, { consulted: false, reason: 'not linked: the garage names no garage in this module' });
  // Without the QR the same unread car is asked about by nobody, and pays.
  const bare = await open(w, { plate_unreadable: true, entry_at: '2026-09-10T12:00:00Z' });
  const res2 = await call(w.exit, 'POST', '/lane/exits', { event_id: randomUUID(), exit_at: '2026-09-10T13:00:00Z', session_id: bare.id });
  const { exit: exit2 } = await res2.json();
  assert.deepEqual([exit2.needs, exit2.fee.fee_minor], ['payment', 250]);
});

test("THE QR IS CHECKED TO ITS SHAPE; a key this build does not know is left on the lane; the purge takes the QR's plate with the vehicle and keeps the rest", async () => {
  const w = await world();
  for (const qr of [
    { passed_by: 'close_enough' }, { qr_plate: 'AB 123' }, { enrolment: 'has space' }, 'QRA12345', [1], { qr_plate: '' },
  ]) {
    const res = await call(w.entry, 'POST', '/lane/sessions/open', { event_id: randomUUID(), plate: `QS${tag()}`, entry_at: '2026-09-10T12:00:00Z', entry_confirmation: 'confirmed', qr });
    assert.equal(res.status, 400, `${JSON.stringify(qr)} is refused`);
  }
  const car = `QS${tag()}`;
  const s = await open(w, { plate: car, entry_at: '2026-09-10T12:00:00Z', qr: { enrolment: 'enr-shape', qr_plate: car, seen_by: 'lane-7' } });
  assert.deepEqual((await stayRow(s.id)).entry_qr, { enrolment: 'enr-shape', qr_plate: car }, 'an unknown key is left on the lane');
  await closeByPlate(w, car, '2026-09-10T13:00:00Z');
  await redactExpiredVehicles(tenant, { now: '2099-01-01T00:00:00Z' });
  assert.deepEqual((await stayRow(s.id)).entry_qr, { enrolment: 'enr-shape' }, "the QR's plate goes with the vehicle; its id stays");
  // The database holds the shape too.
  await assert.rejects(withTenant(tenant, (c) => c.query(`UPDATE sessions SET entry_qr = '{"passed_by":"close_enough"}' WHERE id = $1`, [s.id])), /sessions_entry_qr_shape/);
  await assert.rejects(withTenant(tenant, (c) => c.query(`UPDATE sessions SET pass_session = '{"module":"garage_pass","covered":true}' WHERE id = $1`, [s.id])), /sessions_pass_session_shape/);
});
