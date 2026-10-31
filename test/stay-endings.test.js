/**
 * A STAY NO EXIT CLOSED (0039): the same car coming in again, an exit on
 * another lane's clock, a late close for a stay already ended, and a person
 * ending a stay that looks stuck.
 *
 * Against the real database and the real engine. Each test names the
 * guarantee it holds; scripts/stay-endings-fail-control.js breaks each one
 * and requires this file to go red.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';

let engine;
let server;
let base;

async function deviceToken(tenantId, laneId, name) {
  const t = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)', [tenantId, laneId, name, hashToken(t)]));
  return t;
}

const call = (tok, method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const plate = (tag = 'SE') => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

/** An active garage with an entry and an exit lane, their tokens, and an operator key. */
async function garage(name) {
  const tenant = await createTenant(name);
  const world = await buildWorld(tenant, { hourlyMinor: 250 });
  const op = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)`, [tenant, hashToken(op)]));
  return {
    tenant, id: world.garage, world, op,
    entry: await deviceToken(tenant, world.entryLane, 'entry'),
    exit: await deviceToken(tenant, world.exitLane, 'exit'),
  };
}

async function open(g, body) {
  const res = await call(g.entry, 'POST', '/lane/sessions/open', { event_id: randomUUID(), entry_confirmation: 'confirmed', ...body });
  assert.ok([200, 201].includes(res.status), await res.clone().text());
  return (await res.json()).session;
}
const close = (g, body) => call(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_confirmation: 'confirmed', ...body });
const stay = (g, id) => withTenant(g.tenant, async (c) => (await c.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0]);
const events = (g, kind) => withTenant(g.tenant, async (c) =>
  (await c.query('SELECT detail FROM events WHERE tenant_id = $1 AND kind = $2', [g.tenant, kind])).rows.map((r) => r.detail));
const end = (g, id, body) => call(g.op, 'POST', `/garages/${g.id}/stays/${id}/end`, body);
const stuckList = async (g, query = '') => {
  const res = await call(g.op, 'GET', `/garages/${g.id}/stays/stuck${query}`);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

// --- the same car again ---------------------------------------------------------------

test('OPENS A DAY APART: the same car in again a day later gets a stay of its own; the old one is ended as superseded, unpriced, at the later entry', async () => {
  const g = await garage('se-apart');
  const p = plate();
  const first = await open(g, { plate: p, entry_at: '2026-09-01T12:00:00Z' });
  const second = await open(g, { plate: p, entry_at: '2026-09-02T12:00:00Z' });
  assert.notEqual(second.id, first.id, 'never folded into the old stay, which would bill the new visit from the old entry');
  const old = await stay(g, first.id);
  assert.equal(old.ended.reason, 'superseded');
  assert.equal(old.ended.by_session, second.id);
  assert.equal(new Date(old.exit_at).toISOString(), '2026-09-02T12:00:00.000Z');
  assert.deepEqual([old.fee_minor, old.exit_outcome, old.exit_lane_id], [null, null, null]);
  assert.equal((await stay(g, second.id)).exit_at, null);
  const told = await events(g, 'stay_ended');
  assert.deepEqual(told.map((e) => [e.session_id, e.reason]), [[first.id, 'superseded']]);
});

test('A QUICK RE-APPROACH: two entries of one car inside REAPPROACH_MINUTES are one arrival, one stay', async () => {
  const g = await garage('se-quick');
  const p = plate();
  const first = await open(g, { plate: p, entry_at: '2026-09-01T12:00:00Z' });
  const again = await open(g, { plate: p, entry_at: '2026-09-01T12:05:00Z' });
  assert.equal(again.id, first.id);
  assert.equal((await stay(g, first.id)).ended, null);
});

test('AN EARLIER VISIT ARRIVING LATE: an open for a visit before the stay already here is stored ended, superseded by that stay', async () => {
  const g = await garage('se-late-open');
  const p = plate();
  const later = await open(g, { plate: p, entry_at: '2026-09-02T12:00:00Z' });
  const earlier = await open(g, { plate: p, entry_at: '2026-09-01T12:00:00Z' });
  assert.notEqual(earlier.id, later.id);
  const row = await stay(g, earlier.id);
  assert.equal(row.ended.reason, 'superseded');
  assert.equal(row.ended.by_session, later.id);
  assert.equal(new Date(row.exit_at).toISOString(), '2026-09-02T12:00:00.000Z');
  assert.equal((await stay(g, later.id)).exit_at, null, 'the stay already here is untouched');
});

test('AN UNREAD CAR NEVER SUPERSEDES: two unread entries are two cars, whatever their times', async () => {
  const g = await garage('se-unread');
  const a = await open(g, { plate_unreadable: true, entry_at: '2026-09-01T12:00:00Z' });
  const b = await open(g, { plate_unreadable: true, entry_at: '2026-09-02T12:00:00Z' });
  assert.notEqual(a.id, b.id);
  assert.equal((await stay(g, a.id)).exit_at, null, 'the first unread stay is still open');
});

// --- the late close -----------------------------------------------------------------------

test('A LATE CLOSE FOR THE SUPERSEDED STAY: an exit inside it, by plate, closes and prices it, and the later stay is untouched', async () => {
  const g = await garage('se-late-close');
  const p = plate();
  const first = await open(g, { plate: p, entry_at: '2026-09-01T12:00:00Z' });
  const second = await open(g, { plate: p, entry_at: '2026-09-02T12:00:00Z' });
  const res = await close(g, { plate: p, exit_at: '2026-09-01T14:00:00Z' });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await stay(g, first.id);
  assert.equal(row.ended, null, 'the exit it lost replaces the ending');
  assert.ok(Number(row.fee_minor) > 0, 'priced from its own exit');
  assert.equal(new Date(row.exit_at).toISOString(), '2026-09-01T14:00:00.000Z');
  assert.equal((await stay(g, second.id)).exit_at, null);
  assert.deepEqual((await events(g, 'ended_stay_closed')).map((e) => [e.session_id, e.was.reason]), [[first.id, 'superseded']]);
});

test('A NAMED LATE CLOSE FOR A SUPERSEDED STAY: a close naming the ended stay closes and prices it', async () => {
  const g = await garage('se-named-late');
  const p = plate();
  const first = await open(g, { plate: p, entry_at: '2026-09-01T12:00:00Z' });
  await open(g, { plate: p, entry_at: '2026-09-02T12:00:00Z' });
  const res = await close(g, { plate: p, session_id: first.id, exit_at: '2026-09-01T15:00:00Z' });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await stay(g, first.id);
  assert.equal(row.ended, null);
  assert.ok(Number(row.fee_minor) > 0);
});

test('A STAY A PERSON ENDED, CLOSED BY ITS EXIT LATER: still that stay\'s exit until the car comes in again', async () => {
  const g = await garage('se-person-late');
  const p = plate();
  const s = await open(g, { plate: p, entry_at: hoursAgo(80) });
  assert.equal((await end(g, s.id, { outcome: 'ended', reason: 'gone on the walk', left_at: hoursAgo(10) })).status, 200);
  // The exit lane was offline; its close arrives now, with the real exit time.
  const res = await close(g, { plate: p, exit_at: hoursAgo(2) });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await stay(g, s.id);
  assert.equal(row.ended, null);
  assert.ok(Number(row.fee_minor) > 0, 'priced to its real exit, past when the person said it left');
});

// --- two lanes' clocks --------------------------------------------------------------------

test('THE LANES\' CLOCKS APART: an exit a little before its entry closes the stay at its entry, with the time the lane sent kept; further back is still stale', async () => {
  const g = await garage('se-clocks');
  const p = plate();
  const s = await open(g, { plate: p, entry_at: hoursAgo(1) });
  const sent = new Date(new Date(s.entry_at).getTime() - 60_000).toISOString();
  const res = await close(g, { plate: p, session_id: s.id, exit_at: sent });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await stay(g, s.id);
  assert.equal(new Date(row.exit_at).getTime(), new Date(s.entry_at).getTime());
  const told = await events(g, 'exit_before_entry');
  assert.deepEqual(told.map((e) => [e.session_id, e.exit_at_sent]), [[s.id, sent]]);

  const q = plate();
  const t = await open(g, { plate: q, entry_at: hoursAgo(1) });
  const stale = await close(g, { plate: q, exit_at: new Date(new Date(t.entry_at).getTime() - 10 * 60_000).toISOString() });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'stale_exit');
});

test('the 404s carry names: a named stay not open, and a car with no stay', async () => {
  const g = await garage('se-404');
  const named = await close(g, { plate: plate(), session_id: randomUUID(), exit_at: hoursAgo(0.1) });
  assert.equal(named.status, 404);
  assert.equal((await named.json()).code, 'session_not_open');
  const none = await close(g, { plate: plate(), exit_at: hoursAgo(0.1) });
  assert.equal(none.status, 404);
  assert.equal((await none.json()).code, 'no_open_stay');
});

// --- the stays that look stuck --------------------------------------------------------------

test('THE STUCK LIST: open stays older than the setting, oldest first, in the app\'s shape; young, closed and other garages\' stays are not on it', async () => {
  const g = await garage('se-list');
  const oldest = await open(g, { plate: plate(), entry_at: hoursAgo(200) });
  const unread = await open(g, { plate_unreadable: true, entry_at: hoursAgo(100) });
  await open(g, { plate: plate(), entry_at: hoursAgo(10) });
  const closedPlate = plate();
  await open(g, { plate: closedPlate, entry_at: hoursAgo(150) });
  assert.equal((await close(g, { plate: closedPlate, exit_at: hoursAgo(149) })).status, 200);
  const other = await garage('se-list-other');
  await open(other, { plate: plate(), entry_at: hoursAgo(300) });

  const body = await stuckList(g);
  assert.deepEqual([body.older_than_hours, body.stuck_after_hours], [24, 24], "the garage's setting, 24 unless it set another (0043)");
  assert.deepEqual(body.stays.map((s) => s.id), [oldest.id, unread.id]);
  const [a, b] = body.stays;
  assert.deepEqual(Object.keys(a).sort(), ['at_exit', 'entered_at', 'entry_lane', 'id', 'last_seen_on_walk', 'pictures', 'plate', 'plate_whole', 'ticket', 'unread', 'why']);
  assert.deepEqual([a.why, a.last_seen_on_walk, a.unread, a.plate_whole, a.at_exit], ['old', null, false, true, false]);
  assert.deepEqual([b.unread, b.plate, b.plate_whole], [true, null, false]);
  assert.deepEqual((await stuckList(g, '?older_than_hours=150')).stays.map((s) => s.id), [oldest.id]);
  for (const bad of ['0', '2161', 'x', '1.5']) {
    const res = await call(g.op, 'GET', `/garages/${g.id}/stays/stuck?older_than_hours=${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json()).code, 'older_than_hours_invalid');
  }
  assert.equal((await call(other.op, 'GET', `/garages/${g.id}/stays/stuck`)).status, 404, "another account's garage");
});

test('A PERSON ENDS A STAY: abandoned is closed unpriced with who, why and when, an event, and a change-log line naming no vehicle; once', async () => {
  const g = await garage('se-end');
  const s = await open(g, { plate: plate(), entry_at: hoursAgo(100) });
  const res = await end(g, s.id, { outcome: 'abandoned', reason: '  Not seen on three walks ' });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()).stay;
  assert.equal(body.id, s.id);
  assert.equal(body.ended.reason, 'abandoned');
  assert.equal(body.ended.why, 'Not seen on three walks');
  assert.match(body.ended.by, /^key:/);
  const row = await stay(g, s.id);
  assert.deepEqual([row.fee_minor, row.exit_outcome, row.exit_lane_id, row.close_event_id], [null, null, null, null]);
  assert.ok(Math.abs(new Date(row.exit_at).getTime() - Date.now()) < 60_000, 'abandoned now');
  assert.deepEqual((await events(g, 'stay_ended')).map((e) => [e.session_id, e.reason, e.why]), [[s.id, 'abandoned', 'Not seen on three walks']]);
  const lines = await withTenant(g.tenant, async (c) => (await c.query(
    "SELECT action, subject_kind, subject_id, subject_name FROM garage_changes WHERE tenant_id = $1 AND action = 'stay.end'", [g.tenant])).rows);
  assert.deepEqual(lines, [{ action: 'stay.end', subject_kind: 'stay', subject_id: s.id, subject_name: null }]);
  assert.deepEqual((await stuckList(g)).stays, [], 'no longer listed');

  const again = await end(g, s.id, { outcome: 'ended', reason: 'twice' });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'stay_not_open');
});

test('ENDED: the car left when the person says, never before its entry or in the future; the reason and the outcome are required', async () => {
  const g = await garage('se-ended');
  const s = await open(g, { plate: plate(), entry_at: hoursAgo(100) });
  const refusals = [
    [{ outcome: 'left', reason: 'x' }, 'outcome_invalid'],
    [{ outcome: 'ended' }, 'reason_required'],
    [{ outcome: 'ended', reason: '   ' }, 'reason_required'],
    [{ outcome: 'ended', reason: 'x'.repeat(501) }, 'reason_required'],
    [{ outcome: 'abandoned', reason: 'x', left_at: hoursAgo(5) }, 'left_at_not_for_abandoned'],
    [{ outcome: 'ended', reason: 'x', left_at: hoursAgo(101) }, 'left_at_before_entry'],
  ];
  for (const [body, code] of refusals) {
    const res = await end(g, s.id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, code, JSON.stringify(body));
  }
  const future = await end(g, s.id, { outcome: 'ended', reason: 'x', left_at: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(future.status, 409, 'a time in the future, as every route refuses one');
  assert.equal((await future.json()).code, 'clock_skew');
  assert.equal((await stay(g, s.id)).exit_at, null, 'nothing refused ended it');

  const leftAt = hoursAgo(50);
  const ok = await end(g, s.id, { outcome: 'ended', reason: 'seen leaving', left_at: leftAt });
  assert.equal(ok.status, 200);
  assert.equal(new Date((await stay(g, s.id)).exit_at).toISOString(), leftAt);
});

test('AN EXIT CASE LEFT OPEN never blocks the end: the end closes it, says so in the change log; not another garage\'s stay, and an unread stay ends like any other', async () => {
  const g = await garage('se-guards');
  const s = await open(g, { plate: plate(), entry_at: hoursAgo(100) });
  // A case the lane dropped when the car left the loop: no close ever came.
  const exitId = (await withTenant(g.tenant, (c) => c.query(
    `INSERT INTO exits (tenant_id, garage_id, lane_id, event_id, exit_at, method, session_id)
     VALUES ($1, $2, $3, 'se' || replace(gen_random_uuid()::text, '-', ''), now(), 'single', $4) RETURNING id`,
    [g.tenant, g.id, g.world.exitLane, s.id]))).rows[0].id;
  assert.equal((await stuckList(g)).stays[0].at_exit, true);
  const atExit = await end(g, s.id, { outcome: 'abandoned', reason: 'left the loop, never came back' });
  assert.equal(atExit.status, 200, await atExit.clone().text());
  const after = await stay(g, s.id);
  assert.deepEqual([after.ended.reason, after.ended.exit_cases], ['abandoned', [exitId]]);
  const theCase = await withTenant(g.tenant, async (c) => (await c.query('SELECT * FROM exits WHERE id = $1', [exitId])).rows[0]);
  assert.ok(theCase.closed_at, 'the case is closed');
  assert.equal(theCase.close_event_id, null, 'by the platform, not by a lane close');
  assert.deepEqual([theCase.ended.why, theCase.ended.by], ['stay_ended', 'key:desk']);
  const line = await withTenant(g.tenant, async (c) => (await c.query(
    `SELECT after FROM garage_changes WHERE tenant_id = $1 AND action = 'stay.end' AND subject_id = $2`, [g.tenant, s.id])).rows);
  assert.equal(line.length, 1);
  assert.deepEqual(line[0].after.exit_cases_closed, [{ exit_id: exitId, payment: null }]);
  const listed = await (await call(g.op, 'GET', `/garages/${g.id}/exits`)).json();
  assert.equal(listed.exits.some((e) => e.id === exitId), false, 'no longer at a lane for the attendant');

  // Another garage of the same account: the route names the garage, and a
  // stay of the other one is not found there.
  const theirs = await withTenant(g.tenant, async (c) => {
    const garageId = (await c.query(
      `INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, 'Other', 'America/New_York', 'USD') RETURNING id`, [g.tenant])).rows[0].id;
    const laneId = (await c.query(
      `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1, $2, 'In', 'entry') RETURNING id`, [g.tenant, garageId])).rows[0].id;
    return (await c.query(
      `WITH v AS (INSERT INTO vehicles (tenant_id, plate) VALUES ($1, $4) RETURNING id)
       INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency, open_event_id, entry_confirmation)
       SELECT $1, $2, v.id, $3, now() - interval '100 hours', 'USD', gen_random_uuid()::text, 'confirmed' FROM v RETURNING id`,
      [g.tenant, garageId, laneId, plate()])).rows[0];
  });
  const foreign = await end(g, theirs.id, { outcome: 'abandoned', reason: 'x' });
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).code, 'stay_not_found');
  assert.equal((await stay(g, theirs.id)).exit_at, null);

  const unread = await open(g, { plate_unreadable: true, entry_at: hoursAgo(90) });
  assert.equal((await end(g, unread.id, { outcome: 'abandoned', reason: 'unread, gone' })).status, 200);
  assert.equal((await stay(g, unread.id)).ended.reason, 'abandoned');
});

test('A HELD VALIDATION on a stay a person ends is handed to the release, not left held on a closed stay', async () => {
  const g = await garage('se-validation');
  const s = await open(g, { plate: plate(), entry_at: hoursAgo(100) });
  await withTenant(g.tenant, (c) => c.query(`UPDATE sessions SET validation = '{"state": "held"}' WHERE id = $1`, [s.id]));
  assert.equal((await end(g, s.id, { outcome: 'abandoned', reason: 'x' })).status, 200);
  const v = (await stay(g, s.id)).validation;
  assert.deepEqual([v.state, v.released_by], ['releasing', 'ended']);
});

test('the past stays name how a stay no exit closed ended', async () => {
  const g = await garage('se-past');
  const s = await open(g, { plate: plate(), entry_at: hoursAgo(100) });
  assert.equal((await end(g, s.id, { outcome: 'abandoned', reason: 'x' })).status, 200);
  const res = await call(g.op, 'GET', `/garages/${g.id}/stays/closed?from=${encodeURIComponent(hoursAgo(1))}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).stays.map((x) => x.ended), ['abandoned']);
});

// --- the table holds it ---------------------------------------------------------------------

test('the database holds the ended shape: unpriced, no exit lane, a known reason, and who and why on the ones a person decides', async () => {
  const g = await garage('se-schema');
  const s = await open(g, { plate: plate(), entry_at: hoursAgo(100) });
  const refused = async (sql, params) => assert.rejects(withTenant(g.tenant, (c) => c.query(sql, params)), /violates check constraint/);
  const ended = (record) => JSON.stringify({ at: new Date().toISOString(), ...record });
  await refused(`UPDATE sessions SET exit_at = now(), ended = $2 WHERE id = $1`, [s.id, ended({ reason: 'lost', by: 'key:x', why: 'x' })]);
  await refused(`UPDATE sessions SET exit_at = now(), ended = $2 WHERE id = $1`, [s.id, ended({ reason: 'abandoned', by: 'key:x' })]);
  await refused(`UPDATE sessions SET exit_at = now(), ended = $2 WHERE id = $1`, [s.id, ended({ reason: 'ended', why: 'x' })]);
  await refused(`UPDATE sessions SET exit_at = now(), ended = $2, exit_lane_id = $3, close_event_id = 'x' WHERE id = $1`,
    [s.id, ended({ reason: 'superseded' }), g.world.exitLane]);
  await refused(`UPDATE sessions SET exit_at = now(), ended = $2, fee_minor = 100, exit_outcome = 'transient' WHERE id = $1`,
    [s.id, ended({ reason: 'superseded' })]);
  await refused(`UPDATE sessions SET ended = $2 WHERE id = $1`, [s.id, ended({ reason: 'superseded' })]);
});
