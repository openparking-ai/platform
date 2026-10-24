/**
 * U7f (0033): pictures kept with an entry, tailgaters as stays, and the banned
 * list the owner turns on.
 *
 *   1  pictures kept with a stay, gone one week after its exit, kept while the
 *      car is inside; a picture no stay holds goes one week after it was taken
 *   2  a tailgater the lane identified is a stay like any other: it closes and
 *      prices at the exit
 *   3  "ban tailgaters" off lists nothing; on lists the tailgater, at the reach
 *      chosen: a second garage of the account refuses it only under "all"
 *   4  the list travels to the lanes on the rules payload, by descriptor
 *   5  a removed car is off the list and ages out by the normal rules; a listed
 *      one is kept whole -- its vehicle, its pictures
 *   6  no route puts a car on the list by hand; the one that takes it off is
 *      found by the same search
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createApp, WRITE_ROUTES, BODY_UNREADABLE } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { removeExpiredPictures } from '../src/bans.js';
import { redactExpiredVehicles } from '../src/retention.js';

let engine;
let server;
let base;
let tenant;
let operatorToken;

// Real pictures: every one is decoded and written fresh when it arrives.
const plain = (width, height) => sharp({ create: { width, height, channels: 3, background: { r: 180, g: 70, b: 30 } } });
const PNG = await plain(64, 48).png().toBuffer();
const JPEG = await plain(64, 48).jpeg().toBuffer();
const DAY = 24 * 60 * 60 * 1000;

async function issueToken(tenantId, laneId) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)', [tenantId, laneId, 'pi', hashToken(token)]));
  return token;
}
const op = (method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const asLane = (token, path, body) =>
  fetch(`${base}/api/v1/lane${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const rules = async (token) => {
  const res = await fetch(`${base}/api/v1/lane/rules`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

async function garage(name = 'Bans') {
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,$2,'America/New_York','USD') RETURNING id`, [tenant, name])).rows[0].id;
    const lane = async (n, direction) =>
      (await c.query('INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id', [tenant, id, n, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan());
    await activateGarage(c, tenant, id);
    return { id, entryLane, exitLane };
  });
  return { ...built, entry: await issueToken(tenant, built.entryLane), exit: await issueToken(tenant, built.exitLane) };
}

/** A stay opened at the entry lane, as the lane opens it; `tailgater` and `descriptor` as given. */
async function openStay(g, { tailgater, descriptor = `opvid-opa-id/2:${randomUUID()}`, entryAt = ago(2) } = {}) {
  const eventId = randomUUID();
  const body = { event_id: eventId, plate: plate('T'), entry_at: entryAt, entry_confirmation: 'confirmed' };
  if (descriptor) body.descriptor = descriptor;
  if (tailgater !== undefined) body.tailgater = tailgater;
  const res = await asLane(g.entry, '/sessions/open', body);
  assert.equal(res.status, 201, await res.clone().text());
  return { eventId, session: (await res.json()).session, plate: body.plate, descriptor };
}
const picture = (g, eventId, { takenAt = ago(2), image = PNG, ref = randomUUID() } = {}) =>
  asLane(g.entry, '/pictures', { picture_ref: ref, event_id: eventId, taken_at: takenAt, image: image.toString('base64') });
const pictureCount = (eventId) =>
  withTenant(tenant, async (c) => (await c.query('SELECT count(*)::int AS n FROM entry_pictures WHERE tenant_id = $1 AND event_id = $2', [tenant, eventId])).rows[0].n);
const kept = (ref) =>
  withTenant(tenant, async (c) => (await c.query('SELECT content_type, image FROM entry_pictures WHERE tenant_id = $1 AND picture_ref = $2', [tenant, ref])).rows[0]);
/** The stay closed at the exit lane, as the lane closes it, at `at`. */
const closeAt = async (g, stay, at) => {
  const res = await asLane(g.exit, '/sessions/close', { event_id: randomUUID(), plate: stay.plate, exit_at: at, exit_confirmation: 'confirmed' });
  assert.equal(res.status, 200, await res.clone().text());
};
const purge = () => withTenant(tenant, (c) => removeExpiredPictures(c, tenant));
const banTailgaters = async (g, on, reach) => {
  const res = await op('PATCH', `/garages/${g.id}`, { ban_tailgaters: on, ...(reach ? { ban_reach: reach } : {}) });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).garage;
};

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('bans');
  await buildWorld(tenant);
  operatorToken = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(operatorToken)]));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

test('1. a picture is kept by its entry: a JPEG or a PNG by its bytes, a resend is the same picture, anything else refused', async () => {
  const g = await garage();
  const { eventId } = await openStay(g);
  const ref = randomUUID();
  const first = await picture(g, eventId, { ref, image: JPEG });
  assert.equal(first.status, 201, await first.clone().text());
  assert.deepEqual(await first.json(), { picture_ref: ref, event_id: eventId, created: true });
  const again = await picture(g, eventId, { ref, image: JPEG });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).created, false);
  assert.equal(await pictureCount(eventId), 1, 'the resend is the one picture');
  for (const [image, why] of [[Buffer.from('not a picture'), 'neither a JPEG nor a PNG'], [Buffer.alloc(3 * 1024 * 1024 + 1, 0xff), 'too large']]) {
    const r = await picture(g, eventId, { image });
    assert.equal(r.status, 400, why);
  }
  const future = await picture(g, eventId, { takenAt: new Date(Date.now() + DAY).toISOString() });
  assert.equal(future.status, 409, 'taken in the future: the clock-skew refusal every lane time gets');
  assert.equal(await pictureCount(eventId), 1);
  // The control: the picture kept is the one sent, typed by its first bytes, at its size.
  const row = await kept(ref);
  const meta = await sharp(row.image).metadata();
  assert.deepEqual([row.content_type, meta.format, meta.width, meta.height], ['image/jpeg', 'jpeg', 64, 48]);
});

test('1. A LANE BODY THAT IS NOT UTF-8 is refused before it is read, on the picture path and the others: nothing stored, and the same bodies in UTF-8 store', async () => {
  const g = await garage();
  const raw = (token, path, text, bytes) => {
    const [head, tail, ...more] = text.split('@BYTE@');
    assert.equal(more.length, 0, 'one marker');
    return fetch(`${base}/api/v1/lane${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: Buffer.concat([Buffer.from(head), Buffer.from(bytes), Buffer.from(tail)]),
    });
  };
  const stays = (eventId) =>
    withTenant(tenant, async (c) => (await c.query('SELECT count(*)::int AS n FROM sessions WHERE tenant_id = $1 AND open_event_id = $2', [tenant, eventId])).rows[0].n);
  // A stay's plate with a byte that is not UTF-8: read lossily, a plate nobody read.
  const eventId = randomUUID();
  const open = JSON.stringify({ event_id: eventId, plate: 'T@BYTE@X1', entry_at: ago(2), entry_confirmation: 'confirmed' });
  const badOpen = await raw(g.entry, '/sessions/open', open, [0xff]);
  assert.equal(badOpen.status, 400);
  assert.equal(await badOpen.text(), JSON.stringify(BODY_UNREADABLE));
  assert.equal(await stays(eventId), 0, 'no stay opened');
  // CONTROL: the same body, the byte a valid letter, opens it.
  assert.equal((await raw(g.entry, '/sessions/open', open, [0x41])).status, 201);
  assert.equal(await stays(eventId), 1);
  // The picture path, on its own 5mb parser: a ~4 MB body with one byte that is not UTF-8.
  const ref = randomUUID();
  const big = JSON.stringify({ picture_ref: `${ref}@BYTE@`, event_id: eventId, taken_at: ago(2), image: Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024 - JPEG.length)]).toString('base64') });
  assert.ok(big.length > 4 * 1024 * 1024, 'larger than the 1mb parser takes');
  const badPicture = await raw(g.entry, '/pictures', big, [0xed, 0xa0, 0x80]);
  assert.equal(badPicture.status, 400);
  assert.equal(await badPicture.text(), JSON.stringify(BODY_UNREADABLE));
  assert.equal(await pictureCount(eventId), 0, 'no picture kept');
  // CONTROL: a valid picture of the same size is kept.
  const good = await asLane(g.entry, '/pictures', { picture_ref: ref, event_id: eventId, taken_at: ago(2), image: Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024 - JPEG.length)]).toString('base64') });
  assert.equal(good.status, 201, await good.clone().text());
  assert.equal(await pictureCount(eventId), 1);
});

// Every picture is decoded and written fresh when it arrives: nothing but the
// image is kept, at most 2560 px on its longer side. The sizes are written out,
// never read from the constant under test.
test('1. a JPEG carrying EXIF and HTML after its end is kept as its image alone', async () => {
  const g = await garage();
  const { eventId } = await openStay(g);
  const tagged = await sharp(await plain(640, 480).jpeg().toBuffer())
    .withExif({ IFD0: { ImageDescription: 'EXIF-PLANTED-4417', Make: 'PlantedLane' } }).jpeg().toBuffer();
  const planted = Buffer.concat([tagged, Buffer.from('<html><script>alert("planted")</script></html>')]);
  assert.ok(planted.includes('EXIF-PLANTED-4417') && planted.includes('<html>'), 'the plant carries both');
  const ref = randomUUID();
  const sent = await picture(g, eventId, { ref, image: planted });
  assert.equal(sent.status, 201, await sent.clone().text());
  const { image } = await kept(ref);
  assert.ok(!image.includes('<html') && !image.includes('alert('), 'no HTML kept');
  assert.ok(!image.includes('EXIF-PLANTED-4417') && !image.includes('PlantedLane') && !image.includes('Exif'), 'no EXIF kept');
  const meta = await sharp(image).metadata();
  assert.deepEqual([meta.format, meta.exif, meta.width, meta.height], ['jpeg', undefined, 640, 480]);
});

test('1. control: a clean JPEG keeps its size', async () => {
  const g = await garage();
  const { eventId } = await openStay(g);
  const ref = randomUUID();
  const sent = await picture(g, eventId, { ref, image: await plain(1920, 1080).jpeg().toBuffer() });
  assert.equal(sent.status, 201, await sent.clone().text());
  const meta = await sharp((await kept(ref)).image).metadata();
  assert.deepEqual({ format: meta.format, width: meta.width, height: meta.height }, { format: 'jpeg', width: 1920, height: 1080 });
});

test('1. a picture wider than 2560 px is kept 2560 px wide; one turned by its EXIF is kept turned upright', async () => {
  const g = await garage();
  const { eventId } = await openStay(g);
  const wide = randomUUID();
  assert.equal((await picture(g, eventId, { ref: wide, image: await plain(4000, 1000).jpeg().toBuffer() })).status, 201);
  const wideMeta = await sharp((await kept(wide)).image).metadata();
  assert.deepEqual([wideMeta.width, wideMeta.height], [2560, 640]);
  const turned = randomUUID();
  const sideways = await sharp(await plain(640, 480).jpeg().toBuffer()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  assert.equal((await picture(g, eventId, { ref: turned, image: sideways })).status, 201);
  const upright = await sharp((await kept(turned)).image).metadata();
  assert.deepEqual({ width: upright.width, height: upright.height }, { width: 480, height: 640 }, 'stood upright');
  assert.equal(upright.orientation, undefined, 'the EXIF turn was applied, not kept');
});

test('1. a picture that does not open, or opens to more than 40 million pixels, is refused and nothing is kept', async () => {
  const g = await garage();
  const { eventId } = await openStay(g);
  const broken = await picture(g, eventId, { image: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000)]) });
  assert.equal(broken.status, 400, await broken.clone().text());
  assert.match((await broken.json()).error, /does not open/);
  // 7000 x 7000: 49 million pixels in a small file.
  const bomb = await plain(7000, 7000).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < 3 * 1024 * 1024, `the bomb is under the byte limit (${bomb.length})`);
  const refused = await picture(g, eventId, { image: bomb });
  assert.equal(refused.status, 400, await refused.clone().text());
  assert.equal(await pictureCount(eventId), 0, 'nothing kept');
});

test('1. a picture over 3 MiB once written fresh is refused by name, not failed: the table holds at most 3 MiB', async () => {
  const g = await garage();
  const { eventId } = await openStay(g);
  // A palette PNG of noise: under the limit as sent, three times the size as full colour.
  const side = 1700;
  const noise = await sharp(randomBytes(side * side * 3), { raw: { width: side, height: side, channels: 3 } }).png({ palette: true }).toBuffer();
  assert.ok(noise.length < 3 * 1024 * 1024, `under the limit as sent (${noise.length})`);
  const sent = await picture(g, eventId, { image: noise });
  assert.equal(sent.status, 400, await sent.clone().text());
  assert.match((await sent.json()).error, /once written fresh/);
  assert.equal(await pictureCount(eventId), 0, 'nothing kept');
});

test('1. ONE WEEK AFTER THE CAR LEFT: kept while inside, kept six and a half days after the exit, gone seven and a half days after; a picture no stay holds goes a week after it was taken', async () => {
  // His answer is one week, so the days are written out, never derived from
  // the constant under test: a week of six or eight days goes red here (U7f
  // re-gate, G2).
  const g = await garage();
  const inside = await openStay(g, { entryAt: ago(30) });
  const leftRecently = await openStay(g, { entryAt: ago(7) });
  const leftLongAgo = await openStay(g, { entryAt: ago(10) });
  const unheldOld = randomUUID();
  const unheldNew = randomUUID();
  for (const s of [inside, leftRecently, leftLongAgo]) assert.equal((await picture(g, s.eventId, { takenAt: ago(9) })).status, 201);
  assert.equal((await picture(g, unheldOld, { takenAt: ago(7.5) })).status, 201);
  assert.equal((await picture(g, unheldNew, { takenAt: ago(6.5) })).status, 201);
  await closeAt(g, leftRecently, ago(6.5));
  await closeAt(g, leftLongAgo, ago(7.5));

  await purge();
  assert.equal(await pictureCount(inside.eventId), 1, 'a car still inside keeps its pictures, however old they are');
  assert.equal(await pictureCount(leftRecently.eventId), 1, 'six and a half days after the exit: kept');
  assert.equal(await pictureCount(leftLongAgo.eventId), 0, 'seven and a half days after the exit: gone');
  assert.equal(await pictureCount(unheldNew), 1, 'no stay, taken six and a half days ago: kept');
  assert.equal(await pictureCount(unheldOld), 0, 'no stay, taken seven and a half days ago: gone');
});

test('2. A TAILGATER THE LANE IDENTIFIED IS A STAY: opened as any other, marked, and it closes with a price at the exit', async () => {
  const g = await garage();
  const t = await openStay(g, { tailgater: true, entryAt: ago(0.1) });
  assert.equal(t.session.tailgater, true);
  const regular = await openStay(g, { entryAt: ago(0.1) });
  assert.equal(regular.session.tailgater, false, 'the control: a stay the lane did not say was a tailgater');
  const bad = await asLane(g.entry, '/sessions/open', { event_id: randomUUID(), plate: plate('B'), entry_at: ago(0.1), entry_confirmation: 'confirmed', tailgater: 'yes' });
  assert.equal(bad.status, 400);
  const closed = await asLane(g.exit, '/sessions/close', { event_id: randomUUID(), plate: t.plate, exit_at: new Date().toISOString(), exit_confirmation: 'confirmed' });
  assert.equal(closed.status, 200, await closed.clone().text());
  const session = (await closed.json()).session;
  assert.equal(session.exit_outcome, 'transient');
  assert.ok(Number.isInteger(session.fee_minor) && session.fee_minor > 0, `a fee: ${session.fee_minor}`);
});

test('3. THE SWITCH: off lists nothing, on lists the tailgater; never a car the lane did not call a tailgater, never one with no identity read', async () => {
  const g = await garage();
  const fresh = (await op('GET', `/garages/${g.id}/banned`)).json();
  assert.deepEqual(await fresh, { ban_tailgaters: false, ban_reach: 'garage', cars: [] }, 'off by default, this garage only');

  const whileOff = await openStay(g, { tailgater: true });
  assert.deepEqual((await rules(g.entry)).banned, [], 'switch off: nothing listed');

  const updated = await banTailgaters(g, true);
  assert.deepEqual([updated.ban_tailgaters, updated.ban_reach], [true, 'garage']);
  const listed = await openStay(g, { tailgater: true });
  await openStay(g, { tailgater: false });
  const unread = await openStay(g, { tailgater: true, descriptor: null });
  const banned = (await rules(g.entry)).banned;
  assert.equal(banned.length, 1, JSON.stringify(banned));
  assert.equal(banned[0].descriptor, listed.descriptor);
  assert.notEqual(banned[0].descriptor, whileOff.descriptor);
  assert.deepEqual(Object.keys(banned[0]).sort(), ['descriptor', 'id']);
  // What the owner sees (U7f gate, F5): the lane's list hides a row with no
  // descriptor, so the owner's list is read too -- the one listed car, and
  // never the tailgater whose identity was not read.
  const owner = await (await op('GET', `/garages/${g.id}/banned`)).json();
  assert.deepEqual(owner.cars.map((c) => c.plate), [listed.plate], JSON.stringify(owner.cars));
  assert.ok(!owner.cars.some((c) => c.plate === unread.plate), 'no car listed without an identity read');

  const refused = await op('PATCH', `/garages/${g.id}`, { ban_reach: 'everywhere' });
  assert.equal(refused.status, 400);
  const refusedSwitch = await op('PATCH', `/garages/${g.id}`, { ban_tailgaters: 'on' });
  assert.equal(refusedSwitch.status, 400);
});

test('3. THE REACH: a second garage of the account refuses the car only under "all my garages"; another account never does', async () => {
  const first = await garage('First');
  const second = await garage('Second');
  await banTailgaters(first, true, 'garage');
  const listed = await openStay(first, { tailgater: true });
  assert.equal((await rules(first.entry)).banned.length, 1);
  assert.deepEqual((await rules(second.entry)).banned, [], 'this garage only: the second garage does not refuse it');
  await banTailgaters(first, true, 'all');
  assert.deepEqual((await rules(second.entry)).banned.map((b) => b.descriptor), [listed.descriptor], 'all my garages: it does');
  const cars = (await (await op('GET', `/garages/${second.id}/banned`)).json()).cars;
  assert.deepEqual(cars.map((c) => c.garage_name), ['First'], 'the second garage lists it, naming where it was listed');

  const other = await createTenant('bans-other');
  await buildWorld(other);
  const theirs = await withTenant(other, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Theirs','UTC','USD') RETURNING id`, [other])).rows[0].id;
    const lane = (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,'E','entry') RETURNING id`, [other, id])).rows[0].id;
    await storePlan(c, other, id, flatHourlyPlan());
    await activateGarage(c, other, id);
    return lane;
  });
  assert.deepEqual((await rules(await issueToken(other, theirs))).banned, [], 'another account sees nothing of it');
  // Back to this garage only, so the tests after this one start from their own garages.
  await banTailgaters(first, false, 'garage');
  assert.deepEqual((await rules(second.entry)).banned, []);
});

test('5. A LISTED CAR IS KEPT WHOLE, AND A REMOVED ONE AGES OUT: the pictures and the vehicle, held while listed, go by the normal rules once taken off', async () => {
  const g = await garage();
  await banTailgaters(g, true);
  const t = await openStay(g, { tailgater: true, entryAt: ago(60) });
  assert.equal((await picture(g, t.eventId, { takenAt: ago(60) })).status, 201);
  await closeAt(g, t, ago(50));
  const farFuture = new Date(Date.now() + 400 * DAY);

  await purge();
  assert.equal(await pictureCount(t.eventId), 1, 'listed: its pictures stay past the week');
  await redactExpiredVehicles(tenant, { now: farFuture });
  const vehicle = () => withTenant(tenant, async (c) => (await c.query('SELECT v.plate, s.entry_descriptor FROM sessions s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.id = $1', [t.session.id])).rows[0]);
  assert.deepEqual(await vehicle(), { plate: t.plate, entry_descriptor: t.descriptor }, 'listed: its vehicle is not redacted');

  const list = await (await op('GET', `/garages/${g.id}/banned`)).json();
  assert.equal(list.cars.length, 1);
  const [car] = list.cars;
  assert.equal(car.plate, t.plate);
  assert.equal(car.pictures.length, 1);
  const shown = await op('GET', `/garages/${g.id}/banned/${car.id}/pictures/${car.pictures[0].id}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('content-type'), 'image/png');
  const shownMeta = await sharp(Buffer.from(await shown.arrayBuffer())).metadata();
  assert.deepEqual([shownMeta.format, shownMeta.width, shownMeta.height], ['png', 64, 48]);

  const removed = await op('POST', `/garages/${g.id}/banned/${car.id}/remove`);
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.deepEqual((await rules(g.entry)).banned, [], 'off the list: no lane refuses it');
  assert.equal((await op('GET', `/garages/${g.id}/banned/${car.id}/pictures/${car.pictures[0].id}`)).status, 404);
  assert.equal((await op('POST', `/garages/${g.id}/banned/${car.id}/remove`)).status, 404, 'removed once');

  await purge();
  assert.equal(await pictureCount(t.eventId), 0, 'removed: its pictures go by the week rule');
  await redactExpiredVehicles(tenant, { now: farFuture });
  assert.equal((await vehicle()).plate.startsWith('redacted:'), true, 'removed: its vehicle ages out by the retention window');
});

test('5. a ban that does not reach this garage is not found here: not removed, its pictures not shown', async () => {
  const first = await garage('Here');
  const second = await garage('There');
  await banTailgaters(first, true, 'garage');
  const t = await openStay(first, { tailgater: true });
  assert.equal((await picture(first, t.eventId)).status, 201);
  const [car] = (await (await op('GET', `/garages/${first.id}/banned`)).json()).cars;
  assert.equal((await op('GET', `/garages/${second.id}/banned/${car.id}/pictures/${car.pictures[0].id}`)).status, 404);
  const r = await op('POST', `/garages/${second.id}/banned/${car.id}/remove`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, 'banned_car_not_found');
  assert.equal((await rules(first.entry)).banned.length, 1, 'still listed');
});

test('6. NO CAR IS LISTED BY HAND: no route writes to the list but the one that takes a car off it', () => {
  const banned = WRITE_ROUTES.filter(([, path]) => path.includes('/banned'));
  // The control: the same search finds the remove route.
  assert.deepEqual(banned, [['POST', '/garages/:garageId/banned/:banId/remove', 'garage.banned_car_remove']]);
});
