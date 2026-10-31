/**
 * WHAT A PASS HOLDER'S STAY OWES WHEN A PERSON ENDS IT (0043), against the
 * REAL garage-pass, through its own command line and database (the suite's
 * module harness, test/entitlement-modules.js).
 *
 * No exit lane was crossed, and a pass answers for a lane: it is asked at
 * each of the garage's exit lanes, and a pass any of them covers covers the
 * stay, as it would have at the exit -- at a garage that takes transients
 * and at one for passes only. A garage with no exit lane has nowhere to ask,
 * and the ending says so (`pass_unasked`). Each guarantee has a break in
 * scripts/stay-cleanup-fail-control.js.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { startEntitlementModules } from './entitlement-modules.js';

// Inside the harness pass's validity (2026-01-01 to 2026-12-31), fixed so the test never ages out of it.
const ENTRY = '2026-09-10T12:00:00Z';
const LEFT = '2026-09-10T14:00:00Z';

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
const plate = (tag) => `${tag}${randomUUID().replace(/[^0-9A-F]/gi, '').slice(0, 6).toUpperCase()}`;

/**
 * A platform garage linked to a garage-pass garage, with `exitLanes` exit
 * lanes, a pass registered to one car -- allowed at every lane, or at the
 * exit lane numbered `allowedAt` only, in the order the platform asks at
 * them -- and transients taken or not.
 */
async function world({ exitLanes = 1, transient = true, allowedAt = null } = {}) {
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Passes','America/New_York','USD') RETURNING id`, [tenant])).rows[0].id;
    const lane = async (name, direction) =>
      (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, id, name, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    for (let i = 1; i <= exitLanes; i += 1) await lane(`X${i}`, 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan());
    await activateGarage(c, tenant, id, { transientAvailable: transient });
    // The exit lanes in the order the platform asks at them.
    const exits = (await c.query(
      `SELECT id FROM lanes WHERE tenant_id = $1 AND garage_id = $2 AND direction = 'exit' ORDER BY created_at, id`, [tenant, id])).rows.map((r) => r.id);
    return { id, entryLane, exits };
  });
  const gpGarage = `gp-${built.id.slice(0, 8)}`;
  const passId = `pass-${built.id.slice(0, 8)}`;
  const passCar = plate('PAS');
  await modules.gpGarage(gpGarage, 'America/New_York', { transientAvailable: transient });
  // garage-pass states a pass's lanes per garage, by the name the platform asks with: the lane's id.
  await modules.gpPass(passId, [gpGarage], {
    allowedLanes: allowedAt === null ? null : [{ garage_id: gpGarage, lanes: [built.exits[allowedAt - 1]] }],
  });
  await modules.gpRegister(passId, gpGarage, passCar);
  const linked = await call(op, 'PUT', `/garages/${built.id}/entitlement-links`, {
    garage_pass: { tenant_id: modules.garage_pass.tenant, garage_id: gpGarage }, monthly_billing: null,
  });
  assert.equal(linked.status, 200, await linked.clone().text());
  const entry = generateDeviceToken();
  await withTenant(tenant, (c) => c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)',
    [tenant, built.entryLane, 'entry', hashToken(entry)]));
  return { ...built, gpGarage, passCar, entry };
}

async function endedStay(w, carPlate) {
  const opened = await call(w.entry, 'POST', '/lane/sessions/open', { event_id: randomUUID(), plate: carPlate, entry_at: ENTRY, entry_confirmation: 'confirmed' });
  assert.equal(opened.status, 201, await opened.clone().text());
  const id = (await opened.json()).session.id;
  const res = await call(op, 'POST', `/garages/${w.id}/stays/${id}/end`, { outcome: 'ended', reason: 'seen leaving', left_at: LEFT });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await withTenant(tenant, async (c) => (await c.query('SELECT ended FROM sessions WHERE id = $1', [id])).rows[0]);
  return { answer: (await res.json()).stay, owed: row.ended.owed, id };
}

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  modules = await startEntitlementModules();
  tenant = await createTenant('cleanup-passes');
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

test('A PASS HOLDER A PERSON ENDS OWES NOTHING: garage-pass is asked at the exit lane, as at the exit; a car with no pass owes its price', async () => {
  const w = await world();
  const pass = await endedStay(w, w.passCar);
  assert.deepEqual([pass.answer.owed_minor, pass.answer.pass_unasked], [0, false], JSON.stringify(pass.owed));
  assert.deepEqual([pass.owed.outcome, pass.owed.covered_by], ['covered', ['garage_pass']]);
  assert.deepEqual(pass.owed.entitlement.garage_pass.asked_at_lanes, [{ lane_id: w.exits[0], covered: true }], 'asked at the exit lane');
  assert.equal(pass.owed.entitlement.garage_pass.answer.outcome, 'covered', "the module's own answer is kept");

  const other = await endedStay(w, plate('NOP'));
  assert.deepEqual([other.answer.owed_minor, other.owed.outcome], [500, 'transient'], 'two hours at 250');
  assert.deepEqual(other.owed.entitlement.garage_pass.asked_at_lanes, [{ lane_id: w.exits[0], covered: false }]);
});

test('COVERED IF ANY EXIT LANE SAYS SO: a pass allowed only at the exit lane asked second covers the stay', async () => {
  const w = await world({ exitLanes: 2, allowedAt: 2 });
  const pass = await endedStay(w, w.passCar);
  assert.deepEqual([pass.answer.owed_minor, pass.owed.outcome], [0, 'covered'], JSON.stringify(pass.owed));
  assert.deepEqual(pass.owed.entitlement.garage_pass.asked_at_lanes,
    [{ lane_id: w.exits[0], covered: false }, { lane_id: w.exits[1], covered: true }]);
});

test('A PASS-ONLY GARAGE: a pass holder a person ends owes nothing there either', async () => {
  const w = await world({ transient: false });
  const pass = await endedStay(w, w.passCar);
  assert.deepEqual([pass.answer.owed_minor, pass.owed.outcome, pass.answer.pass_unasked], [0, 'covered', false], JSON.stringify(pass.owed));
});

test('NO EXIT LANE TO ASK AT: the pass is not asked, the stay is priced without it, and the ending, its answer and the past stays say pass_unasked', async () => {
  const w = await world({ exitLanes: 0 });
  const pass = await endedStay(w, w.passCar);
  assert.deepEqual([pass.answer.owed_minor, pass.answer.pass_unasked], [500, true], JSON.stringify(pass.owed));
  assert.deepEqual([pass.owed.pass_unasked, pass.owed.entitlement.garage_pass.consulted, pass.owed.entitlement.garage_pass.unasked], [true, false, true]);
  const past = await call(op, 'GET', `/garages/${w.id}/stays/closed?from=${encodeURIComponent('2026-09-10T13:00:00Z')}&to=${encodeURIComponent('2026-09-10T15:00:00Z')}`);
  assert.equal(past.status, 200, await past.clone().text());
  const mine = (await past.json()).stays;
  assert.deepEqual(mine.map((s) => [s.owed_minor, s.pass_unasked]), [[500, true]]);
});
