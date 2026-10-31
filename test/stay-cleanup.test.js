/**
 * THE GARAGE CLEAN-UP (0043): the stays that look stuck, listed with what a
 * person needs to know the car -- its entry, its plate as read, its lane and
 * its pictures -- and ended by a person: the car LEFT, owing what its exit
 * would have charged and charged nothing, or ABANDONED, owing nothing. Each
 * with a reason, and a line in the change log saying who, when, which stay,
 * why, and what it was and became.
 *
 * Against the real database and the real engine. Each test names the
 * guarantee it holds; scripts/stay-cleanup-fail-control.js breaks each one
 * and requires this file to go red.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { redactExpiredVehicles } from '../src/retention.js';

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
const plate = (tag = 'CL') => `${tag}${randomUUID().replace(/[^0-9]/g, '').slice(0, 5)}`;
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
const end = (g, id, body) => call(g.op, 'POST', `/garages/${g.id}/stays/${id}/end`, body);
const stuckList = async (g, query = '') => {
  const res = await call(g.op, 'GET', `/garages/${g.id}/stays/stuck${query}`);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};
const endLines = (g, outcome = 'done') => withTenant(g.tenant, async (c) => (await c.query(
  `SELECT at, outcome, actor_kind, actor_name, subject_kind, subject_id, subject_name, before, after
     FROM garage_changes WHERE tenant_id = $1 AND action = 'stay.end' AND outcome = $2 ORDER BY at`, [g.tenant, outcome])).rows);

/** A picture the entry lane kept with a stay's open (0033), put in place as the lane's upload would. */
async function entryPicture(g, s, { takenAt = new Date(), bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } = {}) {
  const row = await stay(g, s.id);
  return withTenant(g.tenant, async (c) => (await c.query(
    `INSERT INTO entry_pictures (tenant_id, garage_id, lane_id, picture_ref, event_id, taken_at, content_type, image)
     VALUES ($1, $2, $3, $4, $5, $6, 'image/jpeg', $7) RETURNING id, taken_at`,
    [g.tenant, g.id, g.world.entryLane, randomUUID().slice(0, 12), row.open_event_id, takenAt, bytes])).rows[0]);
}

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

// --- the stuck list -------------------------------------------------------------------------

test("THE GARAGE'S OWN AGE: 24 hours unless it sets another; the list follows the setting, a reader may ask for another age, and the setting is checked and logged", async () => {
  const g = await garage('cl-age');
  const day = await open(g, { plate: plate(), entry_at: hoursAgo(30) });
  const half = await open(g, { plate: plate(), entry_at: hoursAgo(12) });
  await open(g, { plate: plate(), entry_at: hoursAgo(2) });

  const first = await stuckList(g);
  assert.deepEqual([first.older_than_hours, first.stuck_after_hours], [24, 24]);
  assert.deepEqual(first.stays.map((s) => s.id), [day.id], 'older than 24 hours only');

  const set = (body) => call(g.op, 'PATCH', `/garages/${g.id}`, body);
  for (const wrong of [0, 2161, 10.5, '10', null, true]) {
    const res = await set({ stuck_after_hours: wrong });
    assert.equal(res.status, 400, `stuck_after_hours ${JSON.stringify(wrong)}`);
    assert.equal((await res.json()).code, 'stuck_after_hours_invalid');
  }
  const res = await set({ stuck_after_hours: 10 });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).garage.stuck_after_hours, 10);
  const line = await withTenant(g.tenant, (c) => c.query(
    "SELECT before, after FROM garage_changes WHERE garage_id = $1 AND action = 'garage.update' AND outcome = 'done'", [g.id]));
  assert.deepEqual(line.rows, [{ before: { stuck_after_hours: 24 }, after: { stuck_after_hours: 10 } }]);

  const after10 = await stuckList(g);
  assert.deepEqual([after10.older_than_hours, after10.stuck_after_hours], [10, 10]);
  assert.deepEqual(after10.stays.map((s) => s.id), [day.id, half.id], 'the garage\'s 10 hours, oldest first');
  assert.deepEqual((await stuckList(g, '?older_than_hours=24')).stays.map((s) => s.id), [day.id], 'a reader may ask for another age');

  const other = await garage('cl-age-other');
  await open(other, { plate: plate(), entry_at: hoursAgo(12) });
  assert.deepEqual((await stuckList(other)).stays, [], "another garage keeps its own 24 hours");
});

test('THE WALK\'S STUCK LIST: a stay the latest complete walk did not see is listed whatever its age, beside the old ones', async () => {
  const g = await garage('cl-walk');
  const missed = await open(g, { plate: 'CLW1111', entry_at: hoursAgo(1) });
  const old = await open(g, { plate: 'CLW2222', entry_at: hoursAgo(40) });
  for (const p of ['CLW3333', 'CLW4444', 'CLW5555']) await open(g, { plate: p, entry_at: hoursAgo(1) });
  const start = await call(g.op, 'POST', `/garages/${g.id}/walks`, {});
  assert.equal(start.status, 201, await start.clone().text());
  const walk = (await start.json()).walk;
  for (const p of ['CLW2222', 'CLW3333', 'CLW4444', 'CLW5555']) {
    const res = await call(g.op, 'POST', `/garages/${g.id}/walks/${walk.id}/sightings`, { plate: p, confirmed: true });
    assert.equal(res.status, 201, await res.clone().text());
  }
  const done = await call(g.op, 'POST', `/garages/${g.id}/walks/${walk.id}/finish`, {});
  assert.equal((await done.json()).walk.feeds_stuck, true);

  const { stays } = await stuckList(g);
  assert.deepEqual(stays.map((s) => [s.id, s.why]), [[old.id, 'old'], [missed.id, 'not_seen_on_walk']]);
});

test('EACH LISTED STAY CARRIES ITS ENTRY: when, the plate as read, the lane, and its pictures, newest first; a picture is served only through its own stay and garage', async () => {
  const g = await garage('cl-pictures');
  const p = plate();
  const s = await open(g, { plate: p, entry_at: hoursAgo(48) });
  const unread = await open(g, { plate_unreadable: true, entry_at: hoursAgo(30) });
  const earlier = await entryPicture(g, s, { takenAt: new Date(Date.now() - 48 * 3600_000) });
  const later = await entryPicture(g, s, { takenAt: new Date(Date.now() - 48 * 3600_000 + 2000), bytes: Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]) });

  const { stays } = await stuckList(g);
  const [a, b] = stays;
  assert.equal(a.id, s.id);
  assert.deepEqual([a.plate, a.plate_whole, a.entry_lane], [p, true, 'Entry 1']);
  assert.equal(new Date(a.entered_at).toISOString(), new Date((await stay(g, s.id)).entry_at).toISOString());
  assert.deepEqual(a.pictures.map((x) => x.id), [later.id, earlier.id], 'newest first');
  assert.deepEqual(Object.keys(a.pictures[0]).sort(), ['id', 'taken_at']);
  assert.deepEqual([b.id, b.unread, b.plate, b.pictures], [unread.id, true, null, []]);

  const img = await call(g.op, 'GET', `/garages/${g.id}/stays/${s.id}/pictures/${later.id}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(img.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]));

  assert.equal((await call(g.op, 'GET', `/garages/${g.id}/stays/${unread.id}/pictures/${later.id}`)).status, 404,
    "a picture is not served through another stay");
  const second = await withTenant(g.tenant, async (c) => (await c.query(
    "INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, 'Second', 'UTC', 'USD') RETURNING id", [g.tenant])).rows[0].id);
  assert.equal((await call(g.op, 'GET', `/garages/${second}/stays/${s.id}/pictures/${later.id}`)).status, 404,
    "nor through another garage of the same account");
  const other = await garage('cl-pictures-other');
  assert.equal((await call(other.op, 'GET', `/garages/${g.id}/stays/${s.id}/pictures/${later.id}`)).status, 404,
    "another account cannot read it");
  assert.equal((await call(other.op, 'GET', `/garages/${other.id}/stays/${s.id}/pictures/${later.id}`)).status, 404,
    "nor through its own garage");
});

// --- End and Abandon ------------------------------------------------------------------------

test('END: the car left at the chosen time and owes exactly what its exit then would have charged; the stay stays unpriced and nothing is charged', async () => {
  const g = await garage('cl-end');
  // From one instant: two readings of the clock a millisecond apart are 50 hours and a millisecond, a 51st hour.
  const leftAt = hoursAgo(50);
  const entryAt = new Date(new Date(leftAt).getTime() - 50 * 3600_000).toISOString();
  const closedPlate = plate();
  await open(g, { plate: closedPlate, entry_at: entryAt });
  const exitRes = await close(g, { plate: closedPlate, exit_at: leftAt });
  assert.equal(exitRes.status, 200, await exitRes.clone().text());
  const paidAtExit = await withTenant(g.tenant, async (c) => (await c.query(
    'SELECT fee_minor, breakdown FROM sessions WHERE garage_id = $1 AND exit_lane_id IS NOT NULL', [g.id])).rows[0]);

  const s = await open(g, { plate: plate(), entry_at: entryAt });
  const res = await end(g, s.id, { outcome: 'ended', reason: 'Seen leaving behind another car', left_at: leftAt });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()).stay;
  assert.deepEqual([body.owed_minor, body.currency], [12500, 'USD'], '50 hours at 250');
  assert.equal(body.owed_minor, Number(paidAtExit.fee_minor), 'what the exit charged for the same stay');

  const row = await stay(g, s.id);
  assert.equal(new Date(row.exit_at).toISOString(), leftAt);
  assert.deepEqual([row.fee_minor, row.subtotal_minor, row.exit_outcome, row.decided_by], [null, null, null, null],
    'the stay is not recorded as paid');
  assert.deepEqual(
    [row.ended.reason, row.ended.owed.outcome, row.ended.owed.fee_minor, row.ended.owed.currency, row.ended.owed.refused],
    ['ended', 'transient', 12500, 'USD', false]);
  assert.deepEqual(row.ended.owed.breakdown, paidAtExit.breakdown, 'line for line');
  const payments = await withTenant(g.tenant, async (c) => (await c.query('SELECT count(*)::int AS n FROM exit_payments WHERE session_id = $1', [s.id])).rows[0].n);
  assert.equal(payments, 0, 'no payment was started');

  const past = await call(g.op, 'GET', `/garages/${g.id}/stays/closed?from=${encodeURIComponent(hoursAgo(51))}&to=${encodeURIComponent(hoursAgo(49))}`);
  const mine = (await past.json()).stays.find((x) => x.ended === 'ended');
  assert.deepEqual([mine.fee_minor, mine.owed_minor], [null, 12500], 'the past stays show it owed, not paid');
});

test('END AN UNREAD CAR: priced as a car nobody could ask a pass about, and owed', async () => {
  const g = await garage('cl-end-unread');
  const leftAt = hoursAgo(7);
  const s = await open(g, { plate_unreadable: true, entry_at: hoursAgo(10) });
  const res = await end(g, s.id, { outcome: 'ended', reason: 'gone', left_at: leftAt });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).stay.owed_minor, 750);
  assert.equal((await stay(g, s.id)).ended.owed.outcome, 'transient');
});

test('WHAT THE MODULES SAID is kept on what an ended stay owes, and goes with the vehicle at the retention window; what it owed stays', async () => {
  const g = await garage('cl-owed-record');
  const carPlate = plate();
  const at = Date.now();
  const s = await open(g, { plate: carPlate, entry_at: new Date(at - 80 * 3600_000).toISOString() });
  const res = await end(g, s.id, { outcome: 'ended', reason: 'gone', left_at: new Date(at - 76 * 3600_000).toISOString() });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()).stay;
  assert.deepEqual([body.owed_minor, body.pass_unasked], [1000, false], 'no pass linked: nothing unasked');
  const before = (await stay(g, s.id)).ended.owed;
  assert.equal(before.entitlement.identity, carPlate, 'the record names what was asked about');
  assert.deepEqual(Object.keys(before.entitlement).sort(), ['asked_at', 'covered_by', 'garage_pass', 'identity', 'monthly_billing']);

  await withTenant(g.tenant, (c) => c.query(
    `INSERT INTO tenant_settings (tenant_id, vehicle_retention_days) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET vehicle_retention_days = 1`, [g.tenant]));
  const purged = await redactExpiredVehicles(g.tenant);
  assert.ok(purged.redacted >= 1);
  const after = (await stay(g, s.id)).ended;
  assert.equal(after.owed.entitlement, undefined, 'out with the vehicle');
  assert.deepEqual([after.owed.fee_minor, after.owed.outcome, after.reason], [1000, 'transient', 'ended'], 'what it owed is kept');
  assert.ok(!JSON.stringify(after).includes(carPlate));
});

test('ABANDON: written off, owing nothing -- no price on the stay and none owed', async () => {
  const g = await garage('cl-abandon');
  const s = await open(g, { plate: plate(), entry_at: hoursAgo(100) });
  const res = await end(g, s.id, { outcome: 'abandoned', reason: 'Not seen on three walks' });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()).stay;
  assert.equal(body.owed_minor, null);
  const row = await stay(g, s.id);
  assert.deepEqual([row.fee_minor, row.exit_outcome, row.ended.reason, 'owed' in row.ended], [null, null, 'abandoned', false]);
});

test('THE REASON IS REQUIRED, one line, and kept as typed: markup is words, not code', async () => {
  const g = await garage('cl-reason');
  const s = await open(g, { plate: plate(), entry_at: hoursAgo(100) });
  for (const [reason, code] of [[undefined, 'reason_required'], ['', 'reason_required'], ['   ', 'reason_required'],
    ['two\nlines', 'reason_invalid'], ['bell\u0007', 'reason_invalid'], ['x'.repeat(501), 'reason_required']]) {
    for (const outcome of ['ended', 'abandoned']) {
      const res = await end(g, s.id, { outcome, reason });
      assert.equal(res.status, 400, JSON.stringify([outcome, reason]));
      assert.equal((await res.json()).code, code, JSON.stringify([outcome, reason]));
    }
  }
  assert.equal((await stay(g, s.id)).exit_at, null, 'nothing refused ended it');
  const typed = '<img src=x onerror=alert(1)> "left" & gone';
  const res = await end(g, s.id, { outcome: 'abandoned', reason: typed });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type').split(';')[0], 'application/json');
  assert.equal((await res.json()).stay.ended.why, typed);
  assert.equal((await endLines(g))[0].after.reason, typed);
});

// --- the change log -------------------------------------------------------------------------

test('THE CHANGE LOG: each use is one line -- who, when, which stay, the reason, before and after -- and names no car', async () => {
  const g = await garage('cl-log');
  const p1 = plate();
  const p2 = plate();
  const leftAt = hoursAgo(20);
  const a = await open(g, { plate: p1, entry_at: hoursAgo(30) });
  const b = await open(g, { plate: p2, entry_at: hoursAgo(40) });
  const t0 = Date.now();
  assert.equal((await end(g, a.id, { outcome: 'ended', reason: 'left with the barrier up', left_at: leftAt })).status, 200);
  assert.equal((await end(g, b.id, { outcome: 'abandoned', reason: 'written off' })).status, 200);
  const lines = await endLines(g);
  assert.equal(lines.length, 2);
  const [la, lb] = lines;
  for (const l of lines) {
    assert.deepEqual([l.outcome, l.actor_kind, l.actor_name, l.subject_kind, l.subject_name], ['done', 'key', 'desk', 'stay', null]);
    assert.ok(new Date(l.at).getTime() >= t0 - 1000 && new Date(l.at).getTime() <= Date.now() + 1000, 'when');
    assert.equal(l.before.open, true);
    assert.equal(l.before.exit_at, null);
    assert.equal(l.after.open, false);
    assert.equal(l.before.entered_at, l.after.entered_at);
    const text = JSON.stringify(l);
    assert.ok(!text.includes(p1) && !text.includes(p2), 'no plate on the line');
  }
  assert.equal(la.subject_id, a.id);
  assert.equal(new Date(la.before.entered_at).toISOString(), new Date((await stay(g, a.id)).entry_at).toISOString());
  assert.deepEqual([la.after.outcome, la.after.reason, la.after.owed_minor, la.after.currency], ['ended', 'left with the barrier up', 2500, 'USD']);
  assert.equal(new Date(la.after.exit_at).toISOString(), leftAt);
  assert.equal(lb.subject_id, b.id);
  assert.deepEqual([lb.after.outcome, lb.after.reason, lb.after.owed_minor], ['abandoned', 'written off', null]);

  const events = await withTenant(g.tenant, async (c) => (await c.query(
    "SELECT detail FROM events WHERE tenant_id = $1 AND kind = 'stay_ended' ORDER BY occurred_at", [g.tenant])).rows.map((r) => r.detail));
  assert.deepEqual(events.map((e) => [e.session_id, e.owed_minor]), [[a.id, 2500], [b.id, null]]);
  assert.ok(!JSON.stringify(events).includes(p1), 'no plate on the event');
});

// --- another account ------------------------------------------------------------------------

test("ANOTHER ACCOUNT'S STAY is refused, through its garage or one's own, and left as it was", async () => {
  const mine = await garage('cl-mine');
  const theirs = await garage('cl-theirs');
  const s = await open(theirs, { plate: plate(), entry_at: hoursAgo(100) });

  const viaMine = await end(mine, s.id, { outcome: 'abandoned', reason: 'x' });
  assert.equal(viaMine.status, 404);
  assert.equal((await viaMine.json()).code, 'stay_not_found');
  const viaTheirs = await call(mine.op, 'POST', `/garages/${theirs.id}/stays/${s.id}/end`, { outcome: 'ended', reason: 'x' });
  assert.equal(viaTheirs.status, 404);
  assert.equal((await call(mine.op, 'GET', `/garages/${theirs.id}/stays/stuck`)).status, 404, 'nor their list');
  assert.equal((await call(mine.op, 'PATCH', `/garages/${theirs.id}`, { stuck_after_hours: 1 })).status, 404, 'nor their setting');

  const row = await stay(theirs, s.id);
  assert.deepEqual([row.exit_at, row.ended], [null, null]);
  assert.deepEqual((await stuckList(theirs)).stays.map((x) => x.id), [s.id], 'still on their own list');
  assert.deepEqual(await endLines(mine), [], 'nothing done in mine');
  assert.deepEqual(await endLines(theirs), [], 'nothing done in theirs');
  assert.deepEqual((await endLines(mine, 'refused')).map((l) => [l.before, l.after]), [[null, null], [null, null]],
    'each attempt is on the record as refused, with nothing of their stay on it');
});

// --- the table holds it ---------------------------------------------------------------------

test('the database holds what a stay owes: a price only on a stay that ended, in its own money, a whole number, nothing on a covered one; and a garage\'s age in bounds', async () => {
  const g = await garage('cl-schema');
  const s = await open(g, { plate: plate(), entry_at: hoursAgo(100) });
  const refused = async (sql, params) => assert.rejects(withTenant(g.tenant, (c) => c.query(sql, params)), /violates check constraint/);
  const ended = (reason, owed) => JSON.stringify({ reason, at: new Date().toISOString(), by: 'key:x', why: 'x', owed });
  const set = `UPDATE sessions SET exit_at = now(), ended = $2 WHERE id = $1`;
  const fine = { outcome: 'transient', fee_minor: 100, currency: 'USD' };
  await refused(set, [s.id, ended('abandoned', fine)]);
  await refused(set, [s.id, JSON.stringify({ reason: 'superseded', at: new Date().toISOString(), owed: fine })]);
  await refused(set, [s.id, ended('ended', { ...fine, currency: 'EUR' })]);
  await refused(set, [s.id, ended('ended', { ...fine, fee_minor: -1 })]);
  await refused(set, [s.id, ended('ended', { ...fine, fee_minor: 1.5 })]);
  await refused(set, [s.id, ended('ended', { ...fine, fee_minor: '100' })]);
  await refused(set, [s.id, ended('ended', { ...fine, outcome: 'paid' })]);
  await refused(set, [s.id, ended('ended', { ...fine, outcome: 'covered' })]);
  await refused(set, [s.id, ended('ended', { outcome: 'covered', fee_minor: null, currency: 'USD' })]);
  await refused(set, [s.id, ended('ended', 'owed')]);
  await withTenant(g.tenant, (c) => c.query(set, [s.id, ended('ended', { outcome: 'transient', fee_minor: null, currency: 'USD' })]));
  await refused('UPDATE garages SET stuck_after_hours = 0 WHERE id = $1', [g.id]);
  await refused('UPDATE garages SET stuck_after_hours = 2161 WHERE id = $1', [g.id]);
});
