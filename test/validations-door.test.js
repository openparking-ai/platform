/**
 * Which command is the validations door is the DEPLOYMENT's to say
 * (`VALIDATIONS_DOOR`), and there is no default: unset, this deployment has no
 * validations module.
 *
 * Held here: with the setting unset, stating a link is refused by name and
 * nothing is run; a reader claim and a close at an unlinked garage answer
 * exactly what they answer with a door named; a garage that already links a
 * module takes the could-not-decide path, by name, and still runs nothing; a
 * value that is not a bare command is never run. "Nothing is run" is COUNTED:
 * every `spawn` this process makes is counted, and the counter is shown to
 * count before its zero is read.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage, DEFAULT_TAXES_HELD } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { LINK_STATED_EVENT_KIND, NO_VALIDATIONS_CONFIGURED, releaseStaleHolds } from '../src/validations.js';

const DOOR_DIR = new URL('./fixtures/validations-door/', import.meta.url).pathname;
const DOOR_NAME = 'validations-stand-in';
const scratch = mkdtempSync(join(tmpdir(), 'openparking-validations-door-'));
const STATE = join(scratch, 'state.json');
const LOG = join(scratch, 'calls.jsonl');

let engine;
let server;
let base;
let tenant;
let operatorToken;

// --- every spawn this process makes, counted ------------------------------------------------

const realSpawn = childProcess.spawn;
let spawned = [];
function countSpawns() {
  childProcess.spawn = (command, ...rest) => {
    spawned.push(String(command));
    return realSpawn(command, ...rest);
  };
  syncBuiltinESMExports();
}
function stopCounting() {
  childProcess.spawn = realSpawn;
  syncBuiltinESMExports();
}

const withDoor = () => { process.env.VALIDATIONS_DOOR = DOOR_NAME; };
const withoutDoor = () => { delete process.env.VALIDATIONS_DOOR; };

async function issueToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [tenantId, laneId, name, hashToken(token)]),
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
const open = (token, plate) =>
  fetch(`${base}/api/v1/lane/sessions/open`, asDevice(token, { plate, entry_at: '2026-09-10T12:00:00Z', entry_confirmation: 'confirmed' }));
const close = (token, plate, extra = {}) =>
  fetch(`${base}/api/v1/lane/sessions/close`, asDevice(token, { plate, exit_at: '2026-09-10T14:00:00Z', exit_confirmation: 'confirmed', ...extra }));
const computedFrom = { rules_refreshed_at: 1, stays_refreshed_at: 1, stays_cursor: '1', day: '2026-09-10', clock: 'America/New_York' };
const priced = (sessionId) => ({
  status: 'priced', covered_by: [], matched: [], fee_minor: 500, currency: 'USD', plan_version: 'flat-250-USD',
  breakdown: [{ code: 'increment.first_period', rule_id: 'hourly', text: 'first hour', delta_minor: 250 },
    { code: 'increment.repeat_periods', rule_id: 'hourly', text: 'more hours', delta_minor: 250 }],
  entry_at: '2026-09-10T12:00:00+00:00', exit_at: '2026-09-10T14:00:00+00:00', session_id: sessionId, space_class: 'standard',
  computed_from: computedFrom, subtotal_minor: 500, tax_sets_held: DEFAULT_TAXES_HELD,
});
// An invented number, in the range set aside for fiction (555-0100..0199).
const PHONE = '(202) 555-0143';
const claimAt = (token, sessionId, decision) =>
  fetch(`${base}/api/v1/lane/sessions/${sessionId}/validation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ phone: PHONE, local_decision: decision }),
  });
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
const rowFor = (id) => withTenant(tenant, async (c) => (await c.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0]);
const garageRow = (id) => withTenant(tenant, async (c) => (await c.query('SELECT * FROM garages WHERE id = $1', [id])).rows[0]);
const linkEvents = (garageId) =>
  withTenant(tenant, async (c) =>
    (await c.query(`SELECT * FROM events WHERE tenant_id = $1 AND kind = $2 AND garage_id = $3`, [tenant, LINK_STATED_EVENT_KIND, garageId])).rows,
  );

/** An active garage with a flat 250/h plan, linked to nothing. */
async function garage() {
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Door','America/New_York','USD') RETURNING id`, [tenant])).rows[0].id;
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
async function opened(g, car) {
  const res = await open(g.entry, car);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).session.id;
}

/** A reader claim and a close at an unlinked garage, with what each answered and what the row says. */
async function unlinkedStay() {
  const g = await garage();
  const car = plate('UNL');
  const id = await opened(g, car);
  const claim = await claimAt(g.exit, id, priced(id));
  const claimBody = await claim.json();
  const closed = await close(g.exit, car, { local_decision: priced(id) });
  const closedBody = await closed.json();
  const row = await rowFor(id);
  return {
    claim: { status: claim.status, body: claimBody },
    close: { status: closed.status, fee_minor: closedBody.session?.fee_minor, outcome: closedBody.session?.outcome },
    row: { fee_minor: row.fee_minor, breakdown: row.breakdown, validation: row.validation, decided_by: row.decided_by, outcome: row.outcome },
  };
}

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  process.env.ENTITLEMENT_BIN_DIR = DOOR_DIR;
  process.env.VALIDATIONS_STANDIN_STATE = STATE;
  process.env.VALIDATIONS_STANDIN_LOG = LOG;
  tenant = await createTenant('validations-door');
  await buildWorld(tenant);
  const token = generateDeviceToken();
  await withTenant(tenant, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(token)]),
  );
  operatorToken = token;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Counting starts after the engine is up: from here, a spawn is a door.
  countSpawns();
});

after(async () => {
  stopCounting();
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

beforeEach(() => {
  writeFileSync(STATE, JSON.stringify({ mode: 'normal', garages: { 'vt-1/known': [] } }));
  writeFileSync(LOG, '');
  withoutDoor();
  spawned = [];
});

test('CONTROL: the spawn counter counts — with a door named, stating a link runs it once', async () => {
  withDoor();
  const g = await garage();
  const res = await op('PUT', `/garages/${g.id}/validations-link`, { validations: { tenant_id: 'vt-1', garage_id: 'known' } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(spawned, [join(DOOR_DIR, DOOR_NAME)], 'the probe is the one spawn, and it ran the named door');
});

test('unset: stating a link is refused by name, nothing is stored, nothing is recorded, and nothing is run', async () => {
  const g = await garage();
  const res = await op('PUT', `/garages/${g.id}/validations-link`, { validations: { tenant_id: 'vt-1', garage_id: 'known' } });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'validations_not_configured');
  // The sentence itself, not the constant: a reworded constant moves both sides.
  assert.equal(body.error, 'This deployment has no validations module configured.');
  assert.equal(NO_VALIDATIONS_CONFIGURED, body.error);
  assert.equal((await garageRow(g.id)).validations_link, null);
  assert.equal((await linkEvents(g.id)).length, 0);
  // Unlinking states nothing a door is needed for.
  const unlinked = await op('PUT', `/garages/${g.id}/validations-link`, { validations: null });
  assert.equal(unlinked.status, 200);
  assert.deepEqual(spawned, [], 'no door, and no command of any kind, was run');
});

test('unset: a reader claim and a close at an unlinked garage answer exactly what they answer with a door named, and nothing is run', async () => {
  withDoor();
  const named = await unlinkedStay();
  assert.deepEqual(spawned, [], 'the premise: an unlinked garage runs no door even with one named');
  withoutDoor();
  const unset = await unlinkedStay();
  assert.deepEqual(spawned, []);
  assert.equal(unset.claim.status, 200);
  assert.equal(unset.claim.body.validation.outcome, 'not_linked');
  assert.equal(unset.close.status, 200);
  assert.equal(unset.row.validation, null);
  assert.deepEqual(unset, named);
});

test('unset: a garage that already links a module cannot be answered for — the claim is could-not-decide, named in the log — and nothing is run', async () => {
  const g = await garage();
  await withTenant(tenant, (c) =>
    c.query(`UPDATE garages SET validations_link = '{"tenant_id":"vt-1","garage_id":"known"}'::jsonb WHERE id = $1`, [g.id]),
  );
  const car = plate('LNK');
  const id = await opened(g, car);
  // The reader's could-not-decide path as it is on 64eaa19: a 5xx the wire
  // says nothing about, and the log line that names it.
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  let res;
  try {
    res = await claimAt(g.exit, id, priced(id));
  } finally {
    console.error = realError;
  }
  assert.equal(res.status, 500, 'could not decide is a 5xx, never a verdict');
  assert.deepEqual(await res.json(), { error: 'internal error' });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /validations could not answer/);
  assert.match(logged[0], /names no validations door \(VALIDATIONS_DOOR is unset\)/);
  assert.equal(logged[0].includes('555'), false, 'the phone is not in the line');
  const row = await rowFor(id);
  assert.notEqual(row.validation?.state, 'held', 'nothing is held');
  assert.equal(row.validation?.discount_minor ?? null, null);
  assert.deepEqual(spawned, []);
});

test('unset: the sweep cannot give back a hold — it says so and counts it failed, never released — and nothing is run', async () => {
  const g = await garage();
  await withTenant(tenant, (c) =>
    c.query(`UPDATE garages SET validations_link = '{"tenant_id":"vt-1","garage_id":"known"}'::jsonb WHERE id = $1`, [g.id]),
  );
  const id = await opened(g, plate('SWP'));
  const heldAt = new Date('2026-09-10T12:30:00Z');
  await withTenant(tenant, (c) =>
    c.query(`UPDATE sessions SET validation = $2 WHERE id = $1`, [id, JSON.stringify({
      state: 'held', consulted: true, claim_id: randomUUID(), held_at: heldAt.toISOString(), base_minor: 500, currency: 'USD',
      link: { tenant_id: 'vt-1', garage_id: 'known' },
    })]),
  );
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let summary;
  try {
    summary = await releaseStaleHolds(tenant, { holdMinutes: 30, now: new Date(heldAt.getTime() + 31 * 60_000) });
  } finally {
    console.error = realError;
  }
  assert.equal(summary.released, 0);
  assert.equal((await rowFor(id)).validation.state, 'releasing', 'the release is begun and left for a run that can finish it');
  assert.deepEqual([summary.stale, summary.failed], [1, 1], JSON.stringify(summary));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /names no validations door/);
  assert.deepEqual(spawned, []);
});

test('a value that is not a bare command name is never run: the link is refused as unanswerable, by name', async () => {
  for (const value of ['../validations-door/validations-stand-in', '/bin/sh', ' validations-stand-in', '-x9q', 'door x9q']) {
    process.env.VALIDATIONS_DOOR = value;
    const g = await garage();
    const res = await op('PUT', `/garages/${g.id}/validations-link`, { validations: { tenant_id: 'vt-1', garage_id: 'known' } });
    assert.equal(res.status, 409, value);
    const body = await res.json();
    assert.equal(body.code, 'validations_link_unanswerable', value);
    assert.match(body.error, /not a bare command name/, value);
    assert.equal(body.error.includes(value.trim()), false, 'the value is not repeated');
  }
  assert.deepEqual(spawned, []);
});
