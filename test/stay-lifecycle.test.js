/**
 * A stay's life when no exit closes it, and an exit that comes before its
 * entry (0035).
 *
 *   OP-NODE-001  a car that comes back while an old stay of its own is still
 *                open gets a stay of its own: the old one is ended as
 *                superseded, unpriced, and the new visit is billed from its
 *                own entry. Entries minutes apart are still one arrival.
 *   OP-NODE-005  a close that reaches the platform before its open is kept
 *                (202) and the open closes and prices itself from it; an exit
 *                a little before its entry, the two lanes' clocks apart, is
 *                that stay's exit, whether the close names the stay or not; a
 *                close naming a superseded stay still prices it; a named stay
 *                that is not open is a 404 with a name.
 *   OP-NODE-002  the operator's command line ends orphan stays as abandoned,
 *                and a stay abandoned while its car was still inside is
 *                closed and priced by the car's real exit, up to the car's
 *                next entry.
 *
 * The engine is the real one at its pin; the plan is 10.00 an hour, every
 * part hour rounded up, no maximum.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, storePlan, flatHourlyPlan, activateGarage, superuserClient, buildWorld } from './helpers.js';
import { redactExpiredVehicles } from '../src/retention.js';
import { abandonStays } from '../src/stays.js';
import { insideAt } from '../src/repository.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';

let engine;
let server;
let base;
let tenant;
let operatorToken;

async function issueToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)', [tenantId, laneId, name, hashToken(token)]),
  );
  return token;
}
const asDevice = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ event_id: randomUUID(), ...body }),
});
const open = (token, plate, entryAt, extra = {}) =>
  fetch(`${base}/api/v1/lane/sessions/open`, asDevice(token, { plate, entry_at: entryAt, entry_confirmation: 'confirmed', ...extra }));
const close = (token, plate, exitAt, extra = {}) =>
  fetch(`${base}/api/v1/lane/sessions/close`, asDevice(token, { plate, exit_at: exitAt, exit_confirmation: 'confirmed', ...extra }));
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
const json = async (res) => ({ status: res.status, body: await res.json() });
const row = async (id) => (await withTenant(tenant, (c) => c.query('SELECT * FROM sessions WHERE id = $1', [id]))).rows[0];
const staysOf = async (car) =>
  (await withTenant(tenant, (c) => c.query(
    'SELECT s.* FROM sessions s JOIN vehicles v ON v.id = s.vehicle_id WHERE v.plate = $1 ORDER BY s.entry_at', [car]))).rows;
const eventsOf = async (kind, sessionId) =>
  (await withTenant(tenant, (c) => c.query("SELECT * FROM events WHERE kind = $1 AND detail->>'session_id' = $2", [kind, sessionId]))).rows;
const linesAbout = async (sessionId) =>
  (await withTenant(tenant, (c) => c.query(
    "SELECT * FROM garage_changes WHERE subject_kind = 'stay' AND subject_id = $1 ORDER BY at", [sessionId]))).rows;
const keptOf = async (car) =>
  (await withTenant(tenant, (c) => c.query(
    'SELECT count(*)::int AS n FROM pending_exits p JOIN vehicles v ON v.id = p.vehicle_id WHERE v.plate = $1', [car]))).rows[0].n;

/** An active garage with two entry lanes and an exit lane, its plan 10.00 an hour. */
async function garage() {
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(
      "INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Stays','America/New_York','USD') RETURNING id",
      [tenant],
    )).rows[0].id;
    const lane = async (name, direction) =>
      (await c.query('INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id', [tenant, id, name, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const entryLane2 = await lane('E2', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan({ hourlyMinor: 1000 }));
    await activateGarage(c, tenant, id);
    return { id, entryLane, entryLane2, exitLane };
  });
  return {
    ...built,
    entry: await issueToken(tenant, built.entryLane, 'e'),
    entry2: await issueToken(tenant, built.entryLane2, 'e2'),
    exit: await issueToken(tenant, built.exitLane, 'x'),
  };
}

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('stays');
  operatorToken = generateDeviceToken();
  await withTenant(tenant, (c) =>
    c.query("INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)", [tenant, hashToken(operatorToken)]));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

// --- OP-NODE-001: a car that comes back ----------------------------------------------

test('OPENS A DAY APART: the new visit gets its own stay and is billed from its own entry; the old one is ended, unpriced, on the record', async () => {
  const g = await garage();
  const car = plate('BACK');
  // Friday 08:00 in, and the close is lost.
  const friday = await json(await open(g.entry, car, '2026-09-11T12:00:00Z'));
  assert.equal(friday.status, 201);
  // Monday 08:00 in again, a new event: a new stay, not Friday's.
  const monday = await json(await open(g.entry, car, '2026-09-14T12:00:00Z'));
  assert.equal(monday.status, 201, JSON.stringify(monday.body));
  assert.equal(monday.body.created, true);
  assert.notEqual(monday.body.session.id, friday.body.session.id, 'never folded into the old stay');
  const out = await json(await close(g.exit, car, '2026-09-14T14:00:00Z'));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.session.id, monday.body.session.id);
  assert.equal(out.body.session.subtotal_minor, 2000, 'two hours from Monday 08:00, not seventy-four from Friday');
  // Friday's stay: ended as superseded at Monday's entry, no fee, no outcome.
  const old = await row(friday.body.session.id);
  assert.equal(old.ended.reason, 'superseded');
  assert.equal(old.ended.by_session, monday.body.session.id);
  assert.equal(old.exit_at.toISOString(), '2026-09-14T12:00:00.000Z', 'gone by the later entry');
  assert.deepEqual([old.fee_minor, old.exit_outcome, old.exit_lane_id, old.close_event_id], [null, null, null, null]);
  // An event beside it, and a line in the change log by the platform naming no car.
  const [ev] = await eventsOf('stay_ended', old.id);
  assert.equal(ev.detail.reason, 'superseded');
  assert.equal(ev.lane_id, g.entryLane);
  const lines = await linesAbout(old.id);
  assert.deepEqual(lines.map((l) => [l.action, l.actor_kind, l.actor_id, l.actor_name, l.subject_name]),
    [['stay.supersede', 'platform', null, null, null]]);
  assert.equal(lines[0].after.state, 'superseded');
  assert.ok(!JSON.stringify(lines[0]).includes(car), 'the line names no vehicle');
});

test('A QUICK RE-APPROACH: two entries of one car minutes apart are one arrival, and the stay already open is the answer', async () => {
  const g = await garage();
  const car = plate('AGAIN');
  const first = await json(await open(g.entry, car, '2026-09-11T12:00:00Z'));
  // A back-out and a second approach, at the other entry lane, three minutes on.
  const again = await json(await open(g.entry2, car, '2026-09-11T12:03:00Z'));
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.session.id, first.body.session.id);
  assert.equal((await staysOf(car)).length, 1, 'one stay, nothing ended');
});

test('A LATE CLOSE FOR THE SUPERSEDED STAY: an exit between the two entries still closes and prices it, and the end is cleared', async () => {
  const g = await garage();
  const car = plate('LATE');
  const friday = await json(await open(g.entry, car, '2026-09-11T12:00:00Z'));
  const monday = await json(await open(g.entry, car, '2026-09-14T12:00:00Z'));
  // Friday's close, from a lane that was offline, arrives on Monday.
  const late = await json(await close(g.exit, car, '2026-09-11T14:30:00Z'));
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.session.id, friday.body.session.id);
  assert.equal(late.body.session.subtotal_minor, 3000, 'two and a half hours on Friday');
  assert.equal(late.body.session.ended, null);
  assert.equal((await eventsOf('ended_stay_closed', friday.body.session.id)).length, 1);
  // Monday's stay is untouched and closes on its own.
  assert.equal((await row(monday.body.session.id)).exit_at, null);
});

test('AN EARLIER VISIT ARRIVING LATE: its open is stored ended by the stay open now, and its own close still prices it', async () => {
  const g = await garage();
  const car = plate('EARLY');
  const monday = await json(await open(g.entry, car, '2026-09-14T12:00:00Z'));
  // Friday's open, from the entry lane that was offline.
  const friday = await json(await open(g.entry2, car, '2026-09-11T12:00:00Z'));
  assert.equal(friday.status, 201);
  assert.equal(friday.body.session.ended.reason, 'superseded');
  assert.equal(friday.body.session.ended.by_session, monday.body.session.id);
  assert.equal((await row(monday.body.session.id)).exit_at, null, 'the stay open now stays open');
  const late = await json(await close(g.exit, car, '2026-09-11T13:00:00Z'));
  assert.equal(late.body.session.id, friday.body.session.id);
  assert.equal(late.body.session.subtotal_minor, 1000);
});

test('an earlier visit arriving after the next visit closed is stored ended by it, not left open for ever', async () => {
  const g = await garage();
  const car = plate('AFTER');
  const monday = await json(await open(g.entry, car, '2026-09-14T12:00:00Z'));
  assert.equal((await close(g.exit, car, '2026-09-14T13:00:00Z')).status, 200);
  const friday = await json(await open(g.entry2, car, '2026-09-11T12:00:00Z'));
  assert.equal(friday.status, 201);
  assert.equal(friday.body.session.ended.by_session, monday.body.session.id);
  assert.equal(friday.body.session.exit_at, '2026-09-14T12:00:00.000Z');
  assert.equal((await staysOf(car)).filter((x) => x.exit_at === null).length, 0, 'nothing of this car is left open');
});

test('a validation claim on a superseded stay is handed to the release, not left held on a closed stay', async () => {
  const g = await garage();
  const car = plate('HELD');
  const s = await json(await open(g.entry, car, '2026-09-11T12:00:00Z'));
  const su = superuserClient();
  await su.connect();
  try {
    await su.query(`UPDATE sessions SET validation = jsonb_build_object('state', 'held', 'held_at', now()::text) WHERE id = $1`, [s.body.session.id]);
  } finally {
    await su.end();
  }
  const again = await open(g.entry, car, '2026-09-14T12:00:00Z');
  assert.equal(again.status, 201, await again.clone().text());
  const old = await row(s.body.session.id);
  assert.equal(old.validation.state, 'releasing');
  assert.equal(old.validation.released_by, 'ended');
});

// --- OP-NODE-005: a close before its open ---------------------------------------------

test('A CLOSE BEFORE ITS OPEN is kept (202), and the open closes and prices itself from it', async () => {
  const g = await garage();
  const car = plate('FIRST');
  const closeEvent = randomUUID();
  const kept = await json(await close(g.exit, car, '2026-09-10T15:00:00Z', { event_id: closeEvent }));
  assert.equal(kept.status, 202, JSON.stringify(kept.body));
  assert.deepEqual([kept.body.closed, kept.body.replay, kept.body.pending_exit.close_event_id], [false, false, closeEvent]);
  // Sent again, the one kept is the answer.
  const again = await json(await close(g.exit, car, '2026-09-10T15:00:00Z', { event_id: closeEvent }));
  assert.deepEqual([again.status, again.body.replay], [202, true]);
  assert.equal((await staysOf(car)).length, 0, 'no stay made from an exit');
  // The open arrives: the stay is closed from the kept exit, priced.
  const opened = await json(await open(g.entry, car, '2026-09-10T12:00:00Z'));
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.session.exit_at, '2026-09-10T15:00:00.000Z');
  assert.equal(opened.body.session.close_event_id, closeEvent);
  assert.equal(opened.body.session.subtotal_minor, 3000);
  assert.equal(opened.body.pending_exit.close_event_id, closeEvent);
  // The close sent once more is now a replay of the stay it closed.
  const replay = await json(await close(g.exit, car, '2026-09-10T15:00:00Z', { event_id: closeEvent }));
  assert.deepEqual([replay.status, replay.body.replay, replay.body.session.id], [200, true, opened.body.session.id]);
});

test('TWO VISITS, CLOSES FIRST: each open closes from its own kept exit', async () => {
  const g = await garage();
  const car = plate('TWO');
  assert.equal((await close(g.exit, car, '2026-09-10T13:00:00Z')).status, 202);
  assert.equal((await close(g.exit, car, '2026-09-10T18:00:00Z')).status, 202);
  const a = await json(await open(g.entry, car, '2026-09-10T12:00:00Z'));
  const b = await json(await open(g.entry, car, '2026-09-10T16:00:00Z'));
  assert.equal(a.body.session.exit_at, '2026-09-10T13:00:00.000Z');
  assert.equal(b.body.session.exit_at, '2026-09-10T18:00:00.000Z');
  assert.deepEqual([a.body.session.subtotal_minor, b.body.session.subtotal_minor], [1000, 2000]);
});

test('TWO VISITS, OPENS FIRST: the second supersedes the first, and each close lands on its own visit', async () => {
  const g = await garage();
  const car = plate('OPENS');
  const a = await json(await open(g.entry, car, '2026-09-10T12:00:00Z'));
  const b = await json(await open(g.entry, car, '2026-09-10T16:00:00Z'));
  const ca = await json(await close(g.exit, car, '2026-09-10T13:00:00Z'));
  const cb = await json(await close(g.exit, car, '2026-09-10T17:00:00Z'));
  assert.deepEqual([ca.status, ca.body.session.id, ca.body.session.subtotal_minor], [200, a.body.session.id, 1000]);
  assert.deepEqual([cb.status, cb.body.session.id, cb.body.session.subtotal_minor], [200, b.body.session.id, 1000]);
});

test('a kept exit whose close cannot be made now fails the open with a 5xx, and the open sent again closes from it', async () => {
  const g = await garage();
  const car = plate('RETRY');
  assert.equal((await close(g.exit, car, '2026-09-10T14:00:00Z')).status, 202);
  const eventId = randomUUID();
  const url = process.env.RATE_ENGINE_URL;
  process.env.RATE_ENGINE_URL = 'http://127.0.0.1:9';
  let first;
  try {
    first = await open(g.entry, car, '2026-09-10T12:00:00Z', { event_id: eventId });
  } finally {
    process.env.RATE_ENGINE_URL = url;
  }
  assert.ok(first.status >= 500, `the lane must send it again: ${first.status}`);
  const again = await json(await open(g.entry, car, '2026-09-10T12:00:00Z', { event_id: eventId }));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.created, false, 'the open was kept the first time');
  assert.equal(again.body.session.exit_at, '2026-09-10T14:00:00.000Z');
  assert.equal(again.body.session.subtotal_minor, 2000);
});

test('THE LANES\' CLOCKS APART: an exit up to twice the drift before its entry closes that stay at its entry, with an event; further before, it is kept', async () => {
  const g = await garage();
  const car = plate('CLOCK');
  // Entry lane 100 s fast, exit lane 100 s slow: a 2-minute stay reads as an
  // exit 80 s before its entry.
  const s = await json(await open(g.entry, car, '2026-09-10T12:01:40Z'));
  const out = await json(await close(g.exit, car, '2026-09-10T12:00:20Z'));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.session.id, s.body.session.id);
  assert.equal(out.body.session.exit_at, '2026-09-10T12:01:40.000Z', 'closed at its entry');
  const [ev] = (await withTenant(tenant, (c) => c.query(
    "SELECT detail FROM events WHERE kind = 'exit_before_entry' AND detail->>'session_id' = $1", [s.body.session.id]))).rows;
  assert.equal(ev.detail.exit_at_sent, '2026-09-10T12:00:20.000Z');
  // Ten minutes before the entry of the stay open now: an earlier visit's
  // exit, whose open has not arrived. Kept, and the open stay is untouched.
  const other = plate('CLOCK2');
  const t = await json(await open(g.entry, other, '2026-09-10T12:10:00Z'));
  const early = await close(g.exit, other, '2026-09-10T12:00:00Z');
  assert.equal(early.status, 202);
  assert.equal((await row(t.body.session.id)).exit_at, null);
});

// An online exit lane looks the stay up at the barrier and NAMES it on the
// close, so a lane that is connected takes the named path, not the plate's.

test('A NAMED CLOSE ON A SLOW CLOCK: a close naming its stay, up to twice the drift before the entry, closes it at its entry, with an event; further before, it is a stale exit', async () => {
  const g = await garage();
  const car = plate('NCLOCK');
  const s = await json(await open(g.entry, car, '2026-09-10T12:01:40Z'));
  const id = s.body.session.id;
  // CONTROL, the far side of the limit: ten minutes before the named stay's
  // entry is not a slow clock, and the close refuses it as before.
  const far = await json(await close(g.exit, car, '2026-09-10T11:51:40Z', { session_id: id }));
  assert.deepEqual([far.status, far.body.code], [409, 'stale_exit']);
  // 80 s before the entry, the two lanes' clocks apart: that stay's exit.
  const closeEvent = randomUUID();
  const out = await json(await close(g.exit, car, '2026-09-10T12:00:20Z', { session_id: id, event_id: closeEvent }));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.session.id, id);
  assert.equal(out.body.session.exit_at, '2026-09-10T12:01:40.000Z', 'closed at its entry');
  assert.equal(out.body.session.close_event_id, closeEvent);
  const [ev] = await eventsOf('exit_before_entry', id);
  assert.equal(ev.detail.exit_at_sent, '2026-09-10T12:00:20.000Z');
  assert.equal(ev.detail.close_event_id, closeEvent);
});

test('A NAMED LATE CLOSE FOR A SUPERSEDED STAY: a close naming the stay its exit falls inside closes and prices it, and the end is cleared', async () => {
  const g = await garage();
  const car = plate('NLATE');
  const friday = await json(await open(g.entry, car, '2026-09-11T12:00:00Z'));
  // The exit lane named Friday's stay at the barrier, then went offline; by
  // the time its close arrives, Monday's entry has ended that stay.
  const monday = await json(await open(g.entry, car, '2026-09-14T12:00:00Z'));
  assert.equal((await row(friday.body.session.id)).ended.reason, 'superseded');
  const late = await json(await close(g.exit, car, '2026-09-11T14:30:00Z', { session_id: friday.body.session.id }));
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.session.id, friday.body.session.id);
  assert.equal(late.body.session.subtotal_minor, 3000, 'two and a half hours on Friday');
  assert.equal(late.body.session.ended, null);
  assert.equal((await eventsOf('ended_stay_closed', friday.body.session.id)).length, 1);
  assert.equal((await row(monday.body.session.id)).exit_at, null, "Monday's stay is untouched");
});

test('a second exit inside a visit already closed is a stale exit (409), by name, and keeps nothing', async () => {
  const g = await garage();
  const car = plate('TWICE');
  await open(g.entry, car, '2026-09-10T12:00:00Z');
  assert.equal((await close(g.exit, car, '2026-09-10T14:00:00Z')).status, 200);
  await open(g.entry, car, '2026-09-11T12:00:00Z');
  const res = await json(await close(g.exit, car, '2026-09-10T13:30:00Z'));
  assert.deepEqual([res.status, res.body.code], [409, 'stale_exit']);
  const kept = (await withTenant(tenant, (c) => c.query(
    'SELECT count(*)::int AS n FROM pending_exits p JOIN vehicles v ON v.id = p.vehicle_id WHERE v.plate = $1', [car]))).rows[0].n;
  assert.equal(kept, 0);
});

test('the 404s carry names: a named stay that is not open, and no open stay for a lookup', async () => {
  const g = await garage();
  const car = plate('NAMED');
  const s = await json(await open(g.entry, car, '2026-09-10T12:00:00Z'));
  await close(g.exit, car, '2026-09-10T13:00:00Z', { session_id: s.body.session.id });
  const named = await json(await close(g.exit, car, '2026-09-10T15:00:00Z', { session_id: s.body.session.id }));
  assert.deepEqual([named.status, named.body.code], [404, 'session_not_open']);
  const lookup = await fetch(`${base}/api/v1/lane/sessions/open?plate=${car}`, { headers: { authorization: `Bearer ${g.exit}` } });
  assert.deepEqual([lookup.status, (await lookup.json()).code], [404, 'no_open_stay']);
});

// --- the operator's command line ------------------------------------------------------

test('abandon-stays lists the open stays older than the hours given, changes nothing without --apply, and with it ends each, on the record', async () => {
  const g = await garage();
  const car = plate('ORPHAN');
  const old = await json(await open(g.entry, car, new Date(Date.now() - 30 * 3600_000).toISOString()));
  const fresh = await json(await open(g.entry, plate('INSIDE'), new Date(Date.now() - 3600_000).toISOString()));
  const run = (...args) => spawnSync(process.execPath, ['scripts/abandon-stays.js', tenant, g.id, ...args],
    { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const refused = run();
  assert.equal(refused.status, 1, 'no default for how old is too old');
  assert.match(refused.stderr, /--older-than-hours is required/);
  const dry = run('--older-than-hours', '24');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(old.body.session.id));
  assert.doesNotMatch(dry.stdout, new RegExp(fresh.body.session.id));
  assert.ok(!dry.stdout.includes(car), 'no plate in the output');
  assert.equal((await row(old.body.session.id)).exit_at, null, 'nothing changed without --apply');
  // Until it is ended, the orphan is a car inside, beside the one of an hour ago.
  const insideNow = async () => (await withTenant(tenant, (c) => insideAt(c, tenant, g.id, new Date()))).inside;
  assert.equal(await insideNow(), 2);
  const applied = run('--older-than-hours', '24', '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /1 open stay\(s\) older than 24 h ended as abandoned/);
  const ended = await row(old.body.session.id);
  assert.equal(ended.ended.reason, 'abandoned');
  assert.equal(ended.fee_minor, null);
  assert.equal((await row(fresh.body.session.id)).exit_at, null, 'a stay inside the hours is left alone');
  assert.equal((await eventsOf('stay_ended', ended.id)).length, 1);
  assert.deepEqual((await linesAbout(ended.id)).map((l) => [l.action, l.actor_kind]), [['stay.abandon', 'platform']]);
  assert.equal(await insideNow(), 1, 'the abandoned stay has left the count; the other is still inside');
  // A late close inside it still prices it.
  const late = await json(await close(g.exit, car, new Date(ended.entry_at.getTime() + 30 * 60_000).toISOString()));
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.session.id, ended.id);
  assert.equal(late.body.session.subtotal_minor, 1000);
});

// An abandoned stay's `exit_at` is only the moment the operator ran the
// command line; it does not show the car left (a superseded stay's does: the
// car came in again then). So its window runs to the car's next entry.

test('AN ABANDONED STAY ITS CAR WAS STILL IN: a close after the abandon moment closes and prices it, and nothing is kept', async () => {
  const g = await garage();
  const car = plate('STILL');
  const now = Date.now();
  const hoursAgo = (h) => new Date(now - h * 3600_000);
  const s = await json(await open(g.entry, car, hoursAgo(30).toISOString()));
  // Ended two hours ago, as an orphan; the car was in fact still inside.
  const { ended } = await abandonStays(tenant, g.id, { olderThanHours: 24, apply: true, now: hoursAgo(2) });
  assert.deepEqual(ended.map((x) => x.id), [s.body.session.id]);
  // It leaves an hour ago.
  const out = await json(await close(g.exit, car, hoursAgo(1).toISOString()));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.session.id, s.body.session.id);
  assert.equal(out.body.session.exit_at, hoursAgo(1).toISOString());
  assert.equal(out.body.session.subtotal_minor, 29_000, 'twenty-nine hours, entry to exit');
  assert.equal(out.body.session.ended, null);
  const [ev] = await eventsOf('ended_stay_closed', s.body.session.id);
  assert.equal(ev.detail.ended.reason, 'abandoned');
  assert.equal(await keptOf(car), 0, 'closed, not kept');
});

test("an abandoned stay is its car's until the car's next entry: an exit inside a later stay is not its, one before that entry is, named or not", async () => {
  const g = await garage();
  const car = plate('BOUND');
  const now = Date.now();
  const hoursAgo = (h) => new Date(now - h * 3600_000).toISOString();
  const first = await json(await open(g.entry, car, hoursAgo(30)));
  const id = first.body.session.id;
  await abandonStays(tenant, g.id, { olderThanHours: 5, sessionIds: [id], apply: true, now: new Date(now - 20 * 3600_000) });
  assert.equal((await row(id)).ended.reason, 'abandoned');
  // The car comes in again ten hours ago and leaves an hour later: a stay of its own.
  const second = await json(await open(g.entry, car, hoursAgo(10)));
  assert.equal(second.status, 201);
  assert.notEqual(second.body.session.id, id);
  const left = await json(await close(g.exit, car, hoursAgo(9)));
  assert.deepEqual([left.status, left.body.session.id], [200, second.body.session.id]);
  // CONTROL: a second exit inside that later stay is a stale exit, and does
  // not reach back to the abandoned one.
  const stale = await json(await close(g.exit, car, hoursAgo(9.5)));
  assert.deepEqual([stale.status, stale.body.code], [409, 'stale_exit']);
  assert.equal((await row(id)).ended.reason, 'abandoned');
  // An exit after the abandon moment and before the car's next entry is the
  // abandoned stay's own -- here named, as a lane that looked it up sends it.
  const out = await json(await close(g.exit, car, hoursAgo(15), { session_id: id }));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.session.id, id);
  assert.equal(out.body.session.subtotal_minor, 15_000, 'fifteen hours, entry to exit');
  assert.equal(out.body.session.ended, null);
});

test('the database holds the ended shape: no exit lane, close event, confirmation, outcome or fee beside an end', async () => {
  const g = await garage();
  const s = await json(await open(g.entry, plate('SHAPE'), '2026-09-10T12:00:00Z'));
  const su = superuserClient();
  await su.connect();
  try {
    const end = `'{"reason":"abandoned","at":"2026-09-10T13:00:00Z"}'::jsonb`;
    await assert.rejects(su.query(`UPDATE sessions SET exit_at = entry_at, ended = ${end}, exit_lane_id = $2, close_event_id = 'x', exit_confirmation = 'confirmed' WHERE id = $1`, [s.body.session.id, g.exitLane]), /sessions_closed_is_complete|sessions_exit_confirmation_matches_exit/);
    await assert.rejects(su.query(`UPDATE sessions SET exit_at = entry_at, ended = ${end}, exit_outcome = 'covered', decided_by = 'platform', entitlement = '{}' WHERE id = $1`, [s.body.session.id]), /sessions_ended_is_unpriced/);
    await assert.rejects(su.query(`UPDATE sessions SET exit_at = entry_at, ended = '{"reason":"lost","at":"x"}' WHERE id = $1`, [s.body.session.id]), /sessions_ended_is_a_record/);
    await assert.rejects(su.query('UPDATE sessions SET exit_at = entry_at WHERE id = $1', [s.body.session.id]), /sessions_closed_is_complete|sessions_exit_confirmation_matches_exit/);
    // CONTROL: the ended shape itself is taken.
    await su.query(`UPDATE sessions SET exit_at = entry_at, ended = ${end} WHERE id = $1`, [s.body.session.id]);
  } finally {
    await su.end();
  }
});

test('the purge nulls a kept exit\'s descriptor, decision and reader with its vehicle\'s identity, and keeps the row', async () => {
  // Its own account: the purge reaches every vehicle of the tenant it runs for.
  const other = await createTenant('stays-purge');
  const w = await buildWorld(other);
  const kept = async (daysAgo) => withTenant(other, async (c) => {
    const at = new Date(Date.now() - daysAgo * 86_400_000);
    const v = (await c.query(
      'INSERT INTO vehicles (tenant_id, plate, first_seen_at, last_seen_at) VALUES ($1, $2, $3, $3) RETURNING id',
      [other, plate('KEPT'), at])).rows[0].id;
    return (await c.query(
      `INSERT INTO pending_exits (tenant_id, garage_id, vehicle_id, lane_id, close_event_id, exit_at, exit_confirmation,
                                  exit_descriptor, local_decision, reader_shown)
       VALUES ($1, $2, $3, $4, gen_random_uuid()::text, $5, 'confirmed', 'opvid-opa-id/2:x', '{"status":"unknown"}', '{"fee_minor":1}')
       RETURNING id`,
      [other, w.garage, v, w.exitLane, at])).rows[0].id;
  });
  const aged = await kept(400);
  const young = await kept(1);
  await redactExpiredVehicles(other);
  const read = async (id) => (await withTenant(other, (c) => c.query('SELECT * FROM pending_exits WHERE id = $1', [id]))).rows[0];
  const after = await read(aged);
  assert.deepEqual([after.exit_descriptor, after.local_decision, after.reader_shown], [null, null, null]);
  assert.equal(after.exit_confirmation, 'confirmed', 'the row and its time are kept');
  // CONTROL: a kept exit inside the window keeps what it carries.
  assert.equal((await read(young)).exit_descriptor, 'opvid-opa-id/2:x');
});
