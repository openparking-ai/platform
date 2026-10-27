/**
 * THE INVENTORY WALK (0040): a person photographs the cars parked in a
 * garage, or types their plates, and the walk finishes into four lists,
 * frozen; the stuck list reads them.
 *
 * Against the real database and the real engine, with a stand-in for
 * vehicle-id. Each test names the guarantee it holds;
 * scripts/walks-fail-control.js breaks each one and requires this file to
 * go red.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { redactExpiredVehicles } from '../src/retention.js';
import { WALK_ABANDON_HOURS } from '../src/walks.js';
import { fold } from '../src/exitMatch.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';

const RULE = 'opvid-plate-chars/1';
const RED = 'opvid-colour/1:m:f000000000000000';
const MARK = 'WALK-PICTURE-SECRET-TEXT';
const JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 90, b: 200 } } })
  .withMetadata({ exif: { IFD0: { Copyright: MARK } } }).jpeg().toBuffer();

let engine;
let server;
let base;
let reader;

/** A stand-in for vehicle-id's read route: records each request, answers what it is told. */
function startReader() {
  const state = { requests: [], status: 200, identity: null, confidence: 0.9 };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.requests.push({ path: req.url, body: JSON.parse(raw) });
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ read: { identity: state.identity, confidence: state.confidence } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ state, srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function token(tenantId, laneId, name) {
  const t = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)', [tenantId, laneId, name, hashToken(t)]));
  return t;
}

/** A garage of its own, so each walk lists its own stays only. */
async function garage(name) {
  const tenant = await createTenant(name);
  const world = await buildWorld(tenant, { hourlyMinor: 250 });
  const op = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)`, [tenant, hashToken(op)]));
  return { tenant, id: world.garage, world, op, entry: await token(tenant, world.entryLane, 'entry') };
}

/** A second operator key at the garage: another person on the floor. */
async function person(g, name) {
  const op = generateDeviceToken();
  await withTenant(g.tenant, (c) => c.query('INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,$2,$3)', [g.tenant, name, hashToken(op)]));
  return { ...g, op };
}

const call = (tok, method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
/** Positioned characters as vehicle-id sends them: folded under the rule, `?` where unsure. */
const read = (pattern) => ({ state: 'read', rule: RULE, pattern: [...pattern].map((c) => (c === '?' ? c : fold(c))).join('') });

async function enter(g, { plate = null, unread = false, id = {}, minutes = 90 } = {}) {
  const res = await call(g.entry, 'POST', '/lane/sessions/open', {
    event_id: randomUUID(),
    ...(unread ? { plate_unreadable: true } : { plate }),
    entry_at: ago(minutes),
    entry_confirmation: 'confirmed',
    ...id,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).session;
}

async function startWalk(g) {
  const res = await call(g.op, 'POST', `/garages/${g.id}/walks`, {});
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).walk;
}
const sight = (g, walk, body) => call(g.op, 'POST', `/garages/${g.id}/walks/${walk.id}/sightings`, body);
async function seen(g, walk, body) {
  const res = await sight(g, walk, body);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).sighting;
}
async function finish(g, walk) {
  const res = await call(g.op, 'POST', `/garages/${g.id}/walks/${walk.id}/finish`, {});
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).walk;
}
const typed = (plate) => ({ plate, confirmed: true });
const picture = (extra = {}) => ({ picture: JPEG.toString('base64'), ...extra });

function readerOn() {
  process.env.VEHICLE_ID_URL = reader.url;
  process.env.VEHICLE_ID_TIMEOUT_MS = '1000';
}
function readerOff() {
  delete process.env.VEHICLE_ID_URL;
  delete process.env.VEHICLE_ID_TIMEOUT_MS;
}

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  reader = await startReader();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  readerOff();
  Object.assign(reader.state, { requests: [], status: 200, identity: null, confidence: 0.9 });
});

after(async () => {
  readerOff();
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => reader.srv.close(r));
  await engine?.stop();
  await pool.end();
});

// --- start ----------------------------------------------------------------------------

test('ONE WALK A PERSON: starting again resumes the open walk; another person starts their own; a finish frees a new one', async () => {
  const g = await garage('wk-start');
  const first = await startWalk(g);
  assert.ok(first.id && first.started_at);
  const again = await call(g.op, 'POST', `/garages/${g.id}/walks`, {});
  assert.equal(again.status, 200);
  assert.equal((await again.json()).walk.id, first.id);
  const theirs = await startWalk(await person(g, 'night desk'));
  assert.notEqual(theirs.id, first.id);
  await finish(g, first);
  const next = await startWalk(g);
  assert.ok(![first.id, theirs.id].includes(next.id));
});

test(`LEFT UNFINISHED ${WALK_ABANDON_HOURS} HOURS: abandoned -- no sightings, no finish, no lists, and its person starts afresh`, async () => {
  const g = await garage('wk-abandon');
  const walk = await startWalk(g);
  await seen(g, walk, typed('ABN1234'));
  await withTenant(g.tenant, (c) => c.query(
    'UPDATE walks SET started_at = started_at - make_interval(hours => $2) WHERE id = $1', [walk.id, WALK_ABANDON_HOURS + 1]));
  const late = await sight(g, walk, typed('ABN1234'));
  assert.equal(late.status, 409);
  assert.equal((await late.json()).code, 'walk_abandoned');
  const done = await call(g.op, 'POST', `/garages/${g.id}/walks/${walk.id}/finish`, {});
  assert.equal(done.status, 409);
  assert.equal((await done.json()).code, 'walk_abandoned');
  const shown = (await (await call(g.op, 'GET', `/garages/${g.id}/walks/${walk.id}`)).json()).walk;
  assert.ok(shown.abandoned_at);
  assert.equal(shown.lists, null);
  const next = await startWalk(g);
  assert.notEqual(next.id, walk.id);
  const recorded = await withTenant(g.tenant, async (c) => (await c.query('SELECT abandoned_at FROM walks WHERE id = $1', [walk.id])).rows[0].abandoned_at);
  assert.ok(recorded, 'the stale walk was not recorded as abandoned');
});

test("ANOTHER TENANT'S WALK: a key never starts, reads, adds to or finishes another tenant's walk", async () => {
  const a = await garage('wk-own-a');
  const b = await garage('wk-own-b');
  const walk = await startWalk(a);
  assert.equal((await call(b.op, 'POST', `/garages/${a.id}/walks`, {})).status, 404);
  assert.equal((await call(b.op, 'GET', `/garages/${a.id}/walks/${walk.id}`)).status, 404);
  assert.equal((await call(b.op, 'GET', `/garages/${b.id}/walks/${walk.id}`)).status, 404);
  assert.equal((await sight(b, { id: walk.id }, typed('AB1234'))).status, 404);
  assert.equal((await call(b.op, 'POST', `/garages/${b.id}/walks/${walk.id}/finish`, {})).status, 404);
  const n = await withTenant(a.tenant, async (c) => (await c.query('SELECT count(*)::int AS n FROM walk_sightings WHERE walk_id = $1', [walk.id])).rows[0].n);
  assert.equal(n, 0);
});

test("ANOTHER GARAGE'S WALK: a walk is reached only through its own garage, even within one tenant", async () => {
  const g = await garage('wk-garage');
  const other = await withTenant(g.tenant, async (c) => (await c.query(
    "INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, 'Second', 'UTC', 'USD') RETURNING id", [g.tenant])).rows[0].id);
  const walk = await startWalk(g);
  assert.equal((await call(g.op, 'GET', `/garages/${other}/walks/${walk.id}`)).status, 404);
  assert.equal((await call(g.op, 'POST', `/garages/${other}/walks/${walk.id}/sightings`, typed('AB1234'))).status, 404);
  assert.equal((await call(g.op, 'POST', `/garages/${other}/walks/${walk.id}/finish`, {})).status, 404);
  assert.equal((await call(g.op, 'GET', `/garages/${g.id}/walks/${walk.id}`)).status, 200);
});

// --- sightings ------------------------------------------------------------------------

test('A TYPED PLATE: kept as typed only when the person confirmed it, and matched alone to its stay', async () => {
  const g = await garage('wk-typed');
  const stay = await enter(g, { plate: 'TYP7123' });
  const walk = await startWalk(g);
  const unconfirmed = await sight(g, walk, { plate: 'TYP7123' });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await unconfirmed.json()).code, 'plate_not_confirmed');
  const s = await seen(g, walk, typed('typ-7123'));
  assert.deepEqual([s.read, s.plate, s.needs_confirmation, s.readers, s.candidates], ['typed', 'TYP7123', false, [], []]);
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_with_stay.map((r) => [r.stay, r.sightings]), [[stay.id, [s.id]]]);
  assert.deepEqual(done.lists.stay_not_seen, []);
});

test('A PICTURE: written fresh, read by vehicle-id with fast-alpr named, kept fresh and served on its own walk only', async () => {
  readerOn();
  const g = await garage('wk-picture');
  const stay = await enter(g, { plate: 'PIC4567' });
  reader.state.identity = { plate: 'PIC4567', plate_characters: read('PIC4567') };
  const walk = await startWalk(g);
  const s = await seen(g, walk, picture());
  assert.deepEqual([s.read, s.plate, s.needs_confirmation, s.why], ['agreed', 'PIC4567', false, null]);
  assert.deepEqual(s.readers, [{ reader: 'fast-alpr', plate: 'PIC4567', confidence: 0.9 }]);
  assert.deepEqual(s.plate_characters, read('PIC4567'));
  assert.equal(reader.state.requests.length, 1);
  const [asked] = reader.state.requests;
  assert.equal(asked.path, '/v1/reads');
  const sent = Buffer.from(asked.body.captures[0].image_b64, 'base64');
  assert.ok(sent.length > 0 && !sent.includes(Buffer.from(MARK)), 'the picture went with what was written into it');
  assert.equal(s.has_picture, true);
  const shown = await call(g.op, 'GET', `/garages/${g.id}/walks/${walk.id}/sightings/${s.id}/picture`);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('content-type'), 'image/jpeg');
  assert.equal(shown.headers.get('cache-control'), 'private, no-store');
  assert.ok(Buffer.from(await shown.arrayBuffer()).equals(sent), 'the picture kept is not the fresh one read');
  const other = await startWalk(await person(g, 'second desk'));
  assert.equal((await call(g.op, 'GET', `/garages/${g.id}/walks/${other.id}/sightings/${s.id}/picture`)).status, 404);
  const typedOne = await seen(g, walk, typed('PIC4567'));
  assert.equal(typedOne.has_picture, false);
  assert.equal((await call(g.op, 'GET', `/garages/${g.id}/walks/${walk.id}/sightings/${typedOne.id}/picture`)).status, 404);
  const pics = await withTenant(g.tenant, async (c) => (await c.query('SELECT count(*)::int AS n FROM entry_pictures WHERE garage_id = $1', [g.id])).rows[0].n);
  assert.equal(pics, 0);
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_with_stay.map((r) => r.stay), [stay.id]);
});

test('A PICTURE THAT DOES NOT OPEN: refused, nothing read, nothing kept', async () => {
  readerOn();
  const g = await garage('wk-bad-picture');
  const walk = await startWalk(g);
  const res = await sight(g, walk, { picture: Buffer.from('not a picture at all').toString('base64') });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'picture_invalid');
  assert.equal(reader.state.requests.length, 0);
});

test('A PHONE PICTURE OF A FEW MEGABYTES: the body is read whole, not refused at the 1 MB every other route keeps', async () => {
  const g = await garage('wk-big');
  const walk = await startWalk(g);
  const noise = Buffer.alloc(900 * 700 * 3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24;
  const big = await sharp(noise, { raw: { width: 900, height: 700, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(big.length > 1024 * 1024 && big.length <= 3 * 1024 * 1024, `the picture is ${big.length} bytes`);
  const res = await sight(g, walk, { picture: big.toString('base64') });
  assert.equal(res.status, 201, await res.clone().text());
});

test('THE READER OFF: a picture is kept as read "none", why "reader_off", for the person to type', async () => {
  const g = await garage('wk-off');
  const walk = await startWalk(g);
  const s = await seen(g, walk, picture());
  assert.deepEqual([s.read, s.why, s.plate, s.needs_confirmation, s.plate_characters], ['none', 'reader_off', null, true, null]);
});

test('THE READER NOT ANSWERING: 503, nothing kept, so the phone sends it again', async () => {
  readerOn();
  reader.state.status = 500;
  const g = await garage('wk-down');
  const walk = await startWalk(g);
  const res = await sight(g, walk, picture({ client_ref: 'phone-1' }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'reader_unanswered');
  const n = await withTenant(g.tenant, async (c) => (await c.query('SELECT count(*)::int AS n FROM walk_sightings WHERE walk_id = $1', [walk.id])).rows[0].n);
  assert.equal(n, 0);
});

test('SENT AGAIN: the same client_ref on the same walk answers the sighting already kept, read once', async () => {
  readerOn();
  reader.state.identity = { plate: 'AGN1234', plate_characters: read('AGN1234') };
  const g = await garage('wk-again');
  const walk = await startWalk(g);
  const first = await seen(g, walk, picture({ client_ref: 'phone-7' }));
  const again = await sight(g, walk, picture({ client_ref: 'phone-7' }));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).sighting.id, first.id);
  assert.equal(reader.state.requests.length, 1, 'a sighting sent again was read again');
  const n = await withTenant(g.tenant, async (c) => (await c.query('SELECT count(*)::int AS n FROM walk_sightings WHERE walk_id = $1', [walk.id])).rows[0].n);
  assert.equal(n, 1);
});

test('AN UNSURE READ: the stays it fits are its candidates; the person picks one, and only one of them', async () => {
  readerOn();
  const g = await garage('wk-unsure');
  const one = await enter(g, { plate: 'UNS1123' });
  const two = await enter(g, { plate: 'UNS2123' });
  await enter(g, { plate: 'XYZ9999' });
  reader.state.identity = { plate: 'UNS?123', plate_characters: read('UNS?123') };
  const walk = await startWalk(g);
  const s = await seen(g, walk, picture());
  assert.deepEqual([s.read, s.plate, s.needs_confirmation], ['unsure', read('UNS?123').pattern, true]);
  assert.deepEqual(s.candidates.map((c) => c.stay).sort(), [one.id, two.id].sort());
  assert.ok(s.candidates.every((c) => c.plate && c.entered_at));
  const pick = (stay) => call(g.op, 'POST', `/garages/${g.id}/walks/${walk.id}/sightings/${s.id}/pick`, { stay });
  const wrong = await pick(randomUUID());
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).code, 'stay_not_a_candidate');
  const ok = await pick(two.id);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).sighting.picked_stay, two.id);
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_with_stay.map((r) => r.stay), [two.id]);
  assert.deepEqual(done.lists.stay_not_seen.map((r) => r.stay).sort(), [one.id, (await stayOf(g, 'XYZ9999'))].sort());
});

async function stayOf(g, plate) {
  return withTenant(g.tenant, async (c) => (await c.query(
    'SELECT s.id FROM sessions s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.garage_id = $1 AND v.plate = $2', [g.id, plate])).rows[0].id);
}

test('NOT PICKED: a plate that fits several stays and was not picked is seen without a stay, with its candidates', async () => {
  const g = await garage('wk-unpicked');
  await enter(g, { plate: 'NPK1123' });
  await enter(g, { plate: 'NPK2123' });
  readerOn();
  reader.state.identity = { plate: 'NPK?123', plate_characters: read('NPK?123') };
  const walk = await startWalk(g);
  const s = await seen(g, walk, picture());
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_with_stay, []);
  assert.equal(done.lists.seen_without_stay.length, 1);
  assert.equal(done.lists.seen_without_stay[0].sighting, s.id);
  assert.equal(done.lists.seen_without_stay[0].candidates.length, 2);
});

test('NOTHING SURE, THEN ANSWERED: an unreadable picture is not readable until a later sighting confirms it', async () => {
  readerOn();
  const g = await garage('wk-confirm');
  const stay = await enter(g, { plate: 'CNF5555' });
  reader.state.identity = { plate: null, plate_characters: { state: 'unreadable', rule: RULE, pattern: null } };
  const walk = await startWalk(g);
  const blur = await seen(g, walk, picture());
  assert.deepEqual([blur.read, blur.why, blur.needs_confirmation], ['none', 'unreadable', true]);
  const other = await seen(g, walk, picture());
  const answer = await seen(g, walk, { ...typed('CNF5555'), confirms: blur.id });
  assert.equal(answer.confirms, blur.id);
  const twice = await sight(g, walk, { ...typed('CNF5555'), confirms: blur.id });
  assert.equal(twice.status, 409);
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.not_readable, [{ sighting: other.id, plate: null, why: 'unreadable' }]);
  assert.deepEqual(done.lists.seen_with_stay.map((r) => [r.stay, r.sightings]), [[stay.id, [answer.id]]]);
});

test("A PHONE'S UNREADABLE IS NOT A LANE'S: a picture with nothing sure never matches a stay whose plate was unread", async () => {
  readerOn();
  const g = await garage('wk-unread');
  const unread = await enter(g, { unread: true, id: { color_code: RED, size: 'small' } });
  reader.state.identity = { plate: null, plate_characters: { state: 'unreadable', rule: RULE, pattern: null }, color_code: RED, size: 'small' };
  const walk = await startWalk(g);
  await seen(g, walk, picture());
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_with_stay, []);
  assert.deepEqual(done.lists.stay_not_seen.map((r) => r.stay), [unread.id]);
});

test('THE PLATE DECIDES: a stay whose entry colour and size differ from anything the phone saw is matched on its plate', async () => {
  readerOn();
  const g = await garage('wk-look');
  const stay = await enter(g, { plate: 'LOK3210', id: { plate_characters: read('LOK3210'), color_code: RED, size: 'large' } });
  reader.state.identity = {
    plate: 'LOK3210', plate_characters: read('LOK3210'), color_code: 'opvid-colour/1:m:000000000000f000', size: 'small',
  };
  const walk = await startWalk(g);
  await seen(g, walk, picture());
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_with_stay.map((r) => r.stay), [stay.id]);
});

test('NO STAY FITS: a ticket stay and a plate of another length are never candidates for a plate', async () => {
  const g = await garage('wk-none');
  await enter(g, { plate: 'LONGER12345' });
  await enter(g, { id: { ticket_ref: `T-${randomUUID().slice(0, 8).toUpperCase()}` } });
  const walk = await startWalk(g);
  const s = await seen(g, walk, typed('NOS1234'));
  assert.deepEqual(s.candidates, []);
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_without_stay.map((r) => [r.sighting, r.plate, r.candidates]), [[s.id, 'NOS1234', []]]);
});

// --- the finish -----------------------------------------------------------------------

test('THE FOUR LISTS: a car seen twice lists once; a stay that came in or left during the walk is never "not seen"', async () => {
  const g = await garage('wk-lists');
  const twice = await enter(g, { plate: 'TWI2222' });
  const missed = await enter(g, { plate: 'MIS3333', minutes: 300 });
  const leaves = await enter(g, { plate: 'LVS4444' });
  const walk = await startWalk(g);
  const late = await enter(g, { plate: 'LAT5555', minutes: 0 });
  const ended = await call(g.op, 'POST', `/garages/${g.id}/stays/${leaves.id}/end`, { outcome: 'ended', reason: 'drove out the back' });
  assert.equal(ended.status, 200, await ended.clone().text());
  const a = await seen(g, walk, typed('TWI2222'));
  const b = await seen(g, walk, typed('TWI2222'));
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_with_stay.map((r) => [r.stay, r.plate, r.sightings]), [[twice.id, 'TWI2222', [a.id, b.id]]]);
  assert.deepEqual(done.lists.stay_not_seen.map((r) => [r.stay, r.plate]), [[missed.id, 'MIS3333']]);
  assert.ok(!done.lists.stay_not_seen.some((r) => r.stay === late.id || r.stay === leaves.id));
  assert.deepEqual(Object.keys(done.lists).sort(), ['not_readable', 'seen_with_stay', 'seen_without_stay', 'stay_not_seen']);
});

test('FROZEN: a finished walk answers the same lists again, refuses sightings, and never works them out again', async () => {
  const g = await garage('wk-frozen');
  const stay = await enter(g, { plate: 'FRZ1111' });
  const walk = await startWalk(g);
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.stay_not_seen.map((r) => r.stay), [stay.id]);
  const after = await sight(g, walk, typed('FRZ1111'));
  assert.equal(after.status, 409);
  assert.equal((await after.json()).code, 'walk_finished');
  await enter(g, { plate: 'NEW2222' });
  const again = await finish(g, walk);
  assert.deepEqual([again.finished_at, again.lists], [done.finished_at, done.lists]);
  const res = await call(g.op, 'GET', `/garages/${g.id}/walks/${walk.id}`);
  assert.equal(res.status, 200);
  const shown = (await res.json()).walk;
  assert.deepEqual([shown.finished_at, shown.lists, shown.sightings], [done.finished_at, done.lists, []]);
});

// --- the stuck list -------------------------------------------------------------------

test('THE STUCK LIST READS THE WALKS: a young stay the latest walk missed is listed; a seen one carries when it was seen', async () => {
  const g = await garage('wk-stuck');
  const young = await enter(g, { plate: 'YNG1111', minutes: 60 });
  const old = await enter(g, { plate: 'OLD2222', minutes: 100 * 60 });
  const walk = await startWalk(g);
  await seen(g, walk, typed('OLD2222'));
  const done = await finish(g, walk);
  const res = await call(g.op, 'GET', `/garages/${g.id}/stays/stuck`);
  assert.equal(res.status, 200);
  const { stays } = await res.json();
  const byId = new Map(stays.map((s) => [s.id, s]));
  assert.ok(byId.has(young.id), 'a stay the latest walk did not see is listed whatever its age');
  assert.equal(byId.get(young.id).why, 'not_seen_on_walk');
  assert.equal(byId.get(young.id).last_seen_on_walk, null);
  assert.equal(byId.get(old.id).why, 'old');
  assert.equal(byId.get(old.id).last_seen_on_walk, done.finished_at);
  assert.deepEqual(stays.map((s) => s.id), [old.id, young.id], 'oldest first');
});

test('ONLY THE LATEST WALK: a stay an earlier walk missed and the latest saw is not listed for the walks', async () => {
  const g = await garage('wk-latest');
  const stay = await enter(g, { plate: 'LTS1111', minutes: 60 });
  await finish(g, await startWalk(g));
  const second = await startWalk(g);
  await seen(g, second, typed('LTS1111'));
  await finish(g, second);
  const { stays } = await (await call(g.op, 'GET', `/garages/${g.id}/stays/stuck`)).json();
  assert.ok(!stays.some((s) => s.id === stay.id));
});

// --- the database ---------------------------------------------------------------------

test("THE DATABASE KEEPS A WALK TO ITS OWN: no walk at another account's garage, no sighting or listed stay from elsewhere, no name on its line", async () => {
  const a = await garage('wk-db-a');
  const b = await garage('wk-db-b');
  const refused = (sql, params, why) => assert.rejects(withTenant(a.tenant, (c) => c.query(sql, params)), why);
  const theirs = await enter(b, { plate: 'THR1111' });
  const walk = await startWalk(a);
  const other = await startWalk(await person(a, 'second desk'));
  const first = await seen(a, other, typed('ABC123'));
  const { started_by: by } = (await (await call(a.op, 'GET', `/garages/${a.id}/walks/${walk.id}`)).json()).walk;
  await refused('INSERT INTO walks (tenant_id, garage_id, started_by) VALUES ($1, $2, $3)', [a.tenant, a.id, by], /walks_one_open_per_person/);
  await refused('UPDATE walks SET abandoned_at = now(), finished_at = now() WHERE id = $1', [walk.id], /walks_abandoned_unfinished/);
  await refused("INSERT INTO walks (tenant_id, garage_id, started_by) VALUES ($1, $2, 'key:x')", [a.tenant, b.id], /walks_garage/);
  await refused(
    `INSERT INTO walk_sightings (tenant_id, walk_id, read, plate, candidates, taken_at, added_by)
     VALUES ($1, $2, 'typed', 'THR1111', $3, now(), 'key:x')`, [a.tenant, walk.id, [theirs.id]], /walk_sightings_candidates/);
  await refused(
    `INSERT INTO walk_sightings (tenant_id, walk_id, read, plate, confirms, taken_at, added_by)
     VALUES ($1, $2, 'typed', 'ABC123', $3, now(), 'key:x')`, [a.tenant, walk.id, first.id], /walk_sightings_confirms/);
  await refused("INSERT INTO walk_stays (tenant_id, walk_id, session_id, list) VALUES ($1, $2, $3, 'seen')", [a.tenant, walk.id, theirs.id], /walk_stays/);
  await refused(
    `INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, action, subject_kind, subject_id, subject_name)
     VALUES ($1, $2, 'done', 'key', gen_random_uuid(), 'walk.start', 'walk', $3, 'ABC123')`, [a.tenant, a.id, walk.id], /garage_changes_walk_names_no_vehicle/);
});

// --- retention ------------------------------------------------------------------------

test('RETENTION: a walk is deleted with its sightings once it finished, or was abandoned, longer ago than the window', async () => {
  const g = await garage('wk-retention');
  await enter(g, { plate: 'RET1111' });
  const oldWalk = await startWalk(g);
  await seen(g, oldWalk, typed('RET1111'));
  await finish(g, oldWalk);
  const stale = await startWalk(g);
  await seen(g, stale, typed('RET1111'));
  await withTenant(g.tenant, (c) => c.query(
    "UPDATE walks SET started_at = started_at - interval '40 days', finished_at = finished_at - interval '40 days' WHERE id = ANY($1::uuid[])",
    [[oldWalk.id, stale.id]]));
  const recent = await startWalk(g);
  await seen(g, recent, typed('RET1111'));
  await finish(g, recent);
  const result = await redactExpiredVehicles(g.tenant);
  assert.ok(result.walksDeleted >= 2);
  const left = await withTenant(g.tenant, async (c) => ({
    walks: (await c.query('SELECT id FROM walks WHERE garage_id = $1', [g.id])).rows.map((r) => r.id),
    sightings: (await c.query('SELECT walk_id FROM walk_sightings WHERE walk_id = ANY($1::uuid[])', [[oldWalk.id, stale.id]])).rows.length,
    stays: (await c.query('SELECT 1 FROM walk_stays WHERE walk_id = $1', [oldWalk.id])).rows.length,
  }));
  assert.deepEqual(left, { walks: [recent.id], sightings: 0, stays: 0 });
});

test('A PICTURE HAS 30 DAYS: then it is forgotten and the sighting keeps what was read', async () => {
  const g = await garage('wk-picture-days');
  const walk = await startWalk(g);
  const old = await seen(g, walk, picture());
  const fresh = await seen(g, walk, picture());
  await withTenant(g.tenant, (c) => c.query("UPDATE walk_sightings SET taken_at = now() - interval '31 days' WHERE id = $1", [old.id]));
  const result = await redactExpiredVehicles(g.tenant);
  assert.equal(result.walkPictures, 1);
  const path = (s) => `/garages/${g.id}/walks/${walk.id}/sightings/${s.id}/picture`;
  assert.equal((await call(g.op, 'GET', path(old))).status, 404);
  assert.equal((await call(g.op, 'GET', path(fresh))).status, 200);
  const shown = (await (await call(g.op, 'GET', `/garages/${g.id}/walks/${walk.id}`)).json()).walk;
  const byId = new Map(shown.sightings.map((s) => [s.id, s]));
  assert.deepEqual([byId.get(old.id).has_picture, byId.get(old.id).read, byId.get(old.id).why], [false, 'none', 'reader_off']);
  assert.equal(byId.get(fresh.id).has_picture, true);
});
