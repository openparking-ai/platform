/**
 * PICTURE RETENTION: the scheduled job (src/pictureRetention.js) removes a
 * lane's pictures (0033) and a walk's (0040) 30 days after they were taken.
 * A stay keeps the pictures it holds while the car is inside, then 30 days
 * after it left, and while its customer has paid picture storage (0041). One
 * tenant at a time, and the job says counts only.
 *
 * Every time is given to the job (`now`), so each boundary is exact.
 * scripts/picture-retention-fail-control.js breaks each guarantee and
 * requires this file to go red in the test that names it.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { removeExpiredPictures, runPictureRetention, summary } from '../src/pictureRetention.js';
import { redactExpiredVehicles } from '../src/retention.js';
import { fold } from '../src/exitMatch.js';
import {
  pool, withTenant, createTenant, storePlan, flatHourlyPlan, activateGarage, superuserClient,
} from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';

// Every connection of this file in a zone that changes its clocks, so a day
// counted on the calendar instead of as 24 hours shows, wherever it runs.
process.env.PGOPTIONS = '-c TimeZone=America/New_York';

const DAY = 24 * 60 * 60 * 1000;
const RULE = 'opvid-plate-chars/1';
const JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 40, g: 120, b: 200 } } }).jpeg().toBuffer();
const ago = (days) => new Date(Date.now() - days * DAY);
const after_ = (from, days, ms = 0) => new Date(from.getTime() + days * DAY + ms);

let engine;
let server;
let base;

const send = (token, method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function key(tenantId, table, laneId) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) => (table === 'lane_devices'
    ? c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)', [tenantId, laneId, 'pi', hashToken(token)])
    : c.query("INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)", [tenantId, hashToken(token)])));
  return token;
}

/** A tenant of its own, with one garage, its entry and exit lanes, and an operator key: the job's counts are this test's alone. */
async function garage(name) {
  const tenant = await createTenant(name);
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query("INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,$2,'UTC','USD') RETURNING id", [tenant, name])).rows[0].id;
    const lane = async (n, direction) =>
      (await c.query('INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id', [tenant, id, n, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan());
    await activateGarage(c, tenant, id);
    return { id, entryLane, exitLane };
  });
  return {
    tenant,
    id: built.id,
    entry: await key(tenant, 'lane_devices', built.entryLane),
    exit: await key(tenant, 'lane_devices', built.exitLane),
    op: await key(tenant, 'operator_tokens'),
  };
}

/** A stay opened at the entry lane, as the lane opens it. */
async function openStay(g, { entryAt = ago(60), eventId = randomUUID() } = {}) {
  const plate = `P${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, '7')}`;
  const res = await send(g.entry, 'POST', '/lane/sessions/open', { event_id: eventId, plate, entry_at: entryAt.toISOString(), entry_confirmation: 'confirmed' });
  assert.equal(res.status, 201, await res.clone().text());
  return { id: (await res.json()).session.id, eventId, plate };
}

/** The stay closed at the exit lane, at `at`. */
async function closeAt(g, stay, at) {
  const res = await send(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), plate: stay.plate, exit_at: at.toISOString(), exit_confirmation: 'confirmed' });
  assert.equal(res.status, 200, await res.clone().text());
}

/** A lane picture against `eventId`, taken at `takenAt`. */
async function lanePicture(g, eventId, takenAt) {
  const res = await send(g.entry, 'POST', '/lane/pictures', { picture_ref: randomUUID(), event_id: eventId, taken_at: takenAt.toISOString(), image: JPEG.toString('base64') });
  assert.equal(res.status, 201, await res.clone().text());
}

/**
 * A walk at `g`, finished through its route, with these sightings written as
 * the sighting route writes them: `{plate}` a typed plate, matched on its
 * folded characters; none, a picture nothing could be read on; `answers`
 * the index of the earlier sighting it answers; `picture` whether it keeps one.
 */
async function walkWith(g, sightings) {
  const started = await send(g.op, 'POST', `/garages/${g.id}/walks`, {});
  assert.equal(started.status, 201, await started.clone().text());
  const walk = (await started.json()).walk;
  const ids = [];
  await withTenant(g.tenant, async (c) => {
    for (const s of sightings) {
      const typed = Boolean(s.plate);
      const { rows } = await c.query(
        `INSERT INTO walk_sightings (tenant_id, walk_id, read, plate, why, plate_state, plate_rule, plate_pattern,
                                     confirms, taken_at, added_by, picture, picture_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'key:test', $11, $12) RETURNING id`,
        [g.tenant, walk.id, typed ? 'typed' : 'none', s.plate ?? null, typed ? null : 'reader_off',
          typed ? 'read' : null, typed ? RULE : null, typed ? [...s.plate].map(fold).join('') : null,
          s.answers === undefined ? null : ids[s.answers], s.takenAt, s.picture ? JPEG : null, s.picture ? 'image/jpeg' : null],
      );
      ids.push(rows[0].id);
    }
  });
  const finished = await send(g.op, 'POST', `/garages/${g.id}/walks/${walk.id}/finish`, {});
  assert.equal(finished.status, 200, await finished.clone().text());
  return { walk: (await finished.json()).walk, ids };
}

const lanePictures = (g, eventId) =>
  withTenant(g.tenant, async (c) => (await c.query('SELECT count(*)::int AS n FROM entry_pictures WHERE event_id = $1', [eventId])).rows[0].n);
const walkPictureKept = (g, sightingId) =>
  withTenant(g.tenant, async (c) => (await c.query('SELECT picture IS NOT NULL AS kept FROM walk_sightings WHERE id = $1', [sightingId])).rows[0].kept);

/** Finished walks moved back in time, as no role of a deployment can: a closed walk never changes. */
async function ageWalks(ids, days) {
  const su = superuserClient();
  await su.connect();
  try {
    await su.query('BEGIN');
    await su.query('SET LOCAL session_replication_role = replica');
    await su.query(
      `UPDATE walks SET started_at = started_at - make_interval(days => $2),
                        finished_at = finished_at - make_interval(days => $2) WHERE id = ANY($1::uuid[])`, [ids, days]);
    await su.query('COMMIT');
  } finally {
    await su.end();
  }
}

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  delete process.env.VEHICLE_ID_URL;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

test('DAY 29, 30 AND 31: a picture no stay keeps is kept on its 29th day and a second before its 30th is over, and gone at 30 days and at 31, lane and walk alike', async () => {
  // The days are written out, never derived from the constant under test.
  const g = await garage('pic-days');
  const now = new Date();
  const ages = { d29: 29 * DAY, d30less: 30 * DAY - 1000, d30: 30 * DAY, d31: 31 * DAY };
  const taken = Object.fromEntries(Object.entries(ages).map(([k, ms]) => [k, new Date(now.getTime() - ms)]));
  const events = {};
  for (const k of Object.keys(ages)) {
    events[k] = randomUUID();
    await lanePicture(g, events[k], taken[k]);
  }
  const { ids } = await walkWith(g, Object.keys(ages).map((k) => ({ picture: true, takenAt: taken[k] })));
  const sighting = Object.fromEntries(Object.keys(ages).map((k, i) => [k, ids[i]]));

  assert.deepEqual(await removeExpiredPictures(g.tenant, { now }), { lane: 2, walk: 2 });
  const kept = {};
  for (const k of Object.keys(ages)) kept[k] = [await lanePictures(g, events[k]), await walkPictureKept(g, sighting[k])];
  assert.deepEqual(kept, { d29: [1, true], d30less: [1, true], d30: [0, false], d31: [0, false] });
});

test('A DAY IS 24 HOURS: 30 days that cross a clock change end 720 hours after the picture was taken, lane and walk alike', async () => {
  const g = await garage('pic-clock-change');
  const zone = await withTenant(g.tenant, async (c) => (await c.query('SHOW TimeZone')).rows[0].TimeZone);
  assert.equal(zone, 'America/New_York', 'the job runs in a zone with a clock change');
  // New York goes back an hour on 2026-11-01.
  const taken = new Date('2026-10-20T12:00:00Z');
  const eventId = randomUUID();
  await lanePicture(g, eventId, taken);
  const { ids: [sighting] } = await walkWith(g, [{ picture: true, takenAt: taken }]);
  assert.deepEqual(await removeExpiredPictures(g.tenant, { now: after_(taken, 30, -1000) }), { lane: 0, walk: 0 }, '720 hours less a second: kept');
  assert.deepEqual(await removeExpiredPictures(g.tenant, { now: after_(taken, 30) }), { lane: 1, walk: 1 }, '720 hours: gone');
  assert.deepEqual([await lanePictures(g, eventId), await walkPictureKept(g, sighting)], [0, false]);
});

test('AN OPEN STAY KEEPS ITS PICTURES UNTIL THE CAR LEAVES, THEN 30 DAYS: its lane picture, a walk picture that saw it, and one a typed plate answered', async () => {
  const g = await garage('pic-open');
  const stay = await openStay(g, { entryAt: ago(60) });
  await lanePicture(g, stay.eventId, ago(59));
  const { ids: [seenIt, unread, , nobodys] } = await walkWith(g, [
    { plate: stay.plate, picture: true, takenAt: ago(45) },
    { picture: true, takenAt: ago(45) },
    { plate: stay.plate, answers: 1, takenAt: ago(45) },
    { picture: true, takenAt: ago(45) },
  ]);
  const state = async () => [await lanePictures(g, stay.eventId), await walkPictureKept(g, seenIt), await walkPictureKept(g, unread)];

  assert.deepEqual(await removeExpiredPictures(g.tenant, { now: after_(new Date(), 400) }), { lane: 0, walk: 1 },
    'a car still inside keeps them however old they are; a picture no stay holds goes');
  assert.equal(await walkPictureKept(g, nobodys), false);
  assert.deepEqual(await state(), [1, true, true]);

  const left = ago(1);
  await closeAt(g, stay, left);
  assert.deepEqual(await removeExpiredPictures(g.tenant, { now: after_(left, 29) }), { lane: 0, walk: 0 }, 'day 29 after it left: kept');
  assert.deepEqual(await removeExpiredPictures(g.tenant, { now: after_(left, 30, -1000) }), { lane: 0, walk: 0 }, 'a second before day 30 is over: kept');
  assert.deepEqual(await state(), [1, true, true]);
  assert.deepEqual(await removeExpiredPictures(g.tenant, { now: after_(left, 30) }), { lane: 1, walk: 2 }, '30 days after it left: gone');
  assert.deepEqual(await state(), [0, false, false]);
});

test('PAID STORAGE KEEPS THEM: past their 30 days while the customer has paid, and gone once the paid time is over', async () => {
  const g = await garage('pic-paid');
  const paid = await openStay(g, { entryAt: ago(60) });
  const unpaid = await openStay(g, { entryAt: ago(60) });
  await lanePicture(g, paid.eventId, ago(59));
  await lanePicture(g, unpaid.eventId, ago(59));
  const { ids: [seenIt] } = await walkWith(g, [{ plate: paid.plate, picture: true, takenAt: ago(2) }]);
  const left = ago(1);
  await closeAt(g, paid, left);
  await closeAt(g, unpaid, left);
  const until = after_(left, 90);
  await withTenant(g.tenant, (c) => c.query('UPDATE sessions SET pictures_paid_until = $2 WHERE id = $1', [paid.id, until]));
  const state = async () => [await lanePictures(g, paid.eventId), await walkPictureKept(g, seenIt)];

  assert.deepEqual(await removeExpiredPictures(g.tenant, { now: after_(left, 60) }), { lane: 1, walk: 0 },
    'day 60 after it left: the unpaid stay\'s picture goes, the paid one\'s are kept');
  assert.equal(await lanePictures(g, unpaid.eventId), 0);
  assert.deepEqual(await state(), [1, true]);
  assert.deepEqual(await removeExpiredPictures(g.tenant, { now: new Date(until.getTime() - 1000) }), { lane: 0, walk: 0 }, 'a second before the paid time is over: kept');
  assert.deepEqual(await removeExpiredPictures(g.tenant, { now: until }), { lane: 1, walk: 1 }, 'the paid time over: gone');
  assert.deepEqual(await state(), [0, false]);
});

test("TWO TENANTS: a tenant's pass removes its own pictures only, another tenant's stay keeps none of them, and the job goes through every tenant it is given", async () => {
  const a = await garage('pic-two-a');
  const b = await garage('pic-two-b');
  const now = new Date();
  // B's open stay carries the entry event id A's picture carries: it is B's, and keeps B's picture only.
  const shared = randomUUID();
  await openStay(b, { entryAt: ago(60), eventId: shared });
  await lanePicture(b, shared, ago(40));
  await lanePicture(a, shared, ago(40));
  const aOwn = randomUUID();
  const bOwn = randomUUID();
  await lanePicture(a, aOwn, ago(40));
  await lanePicture(b, bOwn, ago(40));
  const { ids: [aWalk] } = await walkWith(a, [{ picture: true, takenAt: ago(40) }]);
  const { ids: [bWalk] } = await walkWith(b, [{ picture: true, takenAt: ago(40) }]);

  assert.deepEqual(await removeExpiredPictures(a.tenant, { now }), { lane: 2, walk: 1 });
  assert.deepEqual([await lanePictures(a, shared), await lanePictures(a, aOwn), await walkPictureKept(a, aWalk)], [0, 0, false]);
  assert.deepEqual([await lanePictures(b, shared), await lanePictures(b, bOwn), await walkPictureKept(b, bWalk)], [1, 1, true],
    "A's pass leaves B's pictures as they were");

  const total = await runPictureRetention([a.tenant, b.tenant], { now });
  assert.deepEqual(total, { tenants: 2, lane: 1, walk: 1 });
  assert.deepEqual([await lanePictures(b, shared), await lanePictures(b, bOwn), await walkPictureKept(b, bWalk)], [1, 0, false]);
  const line = summary(total);
  assert.equal(line, 'pictures: 2 tenant(s); removed 1 lane picture(s) and 1 walk picture(s).', 'counts only');
  assert.ok(![a.tenant, b.tenant].some((t) => line.includes(t.slice(0, 8))));
});

test('A WALK WAITS FOR ITS PICTURES: past the retention window it is kept while a stay keeps one of its pictures, and deleted once that picture is gone', async () => {
  const g = await garage('pic-walk-waits');
  const stay = await openStay(g, { entryAt: ago(60) });
  const { walk, ids: [seenIt] } = await walkWith(g, [{ plate: stay.plate, picture: true, takenAt: ago(1) }]);
  await ageWalks([walk.id], 40);
  const walkThere = async () => (await withTenant(g.tenant, (c) => c.query('SELECT 1 FROM walks WHERE id = $1', [walk.id]))).rows.length;

  await redactExpiredVehicles(g.tenant);
  assert.equal(await walkThere(), 1, 'its picture is kept for the open stay, so the walk is too');
  assert.equal(await walkPictureKept(g, seenIt), true);

  const left = ago(0.5);
  await closeAt(g, stay, left);
  assert.deepEqual(await removeExpiredPictures(g.tenant, { now: after_(left, 30) }), { lane: 0, walk: 1 });
  await redactExpiredVehicles(g.tenant);
  assert.equal(await walkThere(), 0, 'its picture gone, the walk goes with the window');
});
