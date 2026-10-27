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
import { WALK_ABANDON_HOURS, SIGHTINGS_PER_MINUTE, WALK_COMPLETE_DEFAULT_PERCENT } from '../src/walks.js';
import { fold } from '../src/exitMatch.js';
import {
  pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage, superuserClient,
} from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';

const RULE = 'opvid-plate-chars/1';
const RED = 'opvid-colour/1:m:f000000000000000';
const MARK = 'WALK-PICTURE-SECRET-TEXT';
const jpeg = (blue) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 90, b: blue } } })
  .withMetadata({ exif: { IFD0: { Copyright: MARK } } }).jpeg().toBuffer();
// Each car photographed is a picture of its own: the same bytes twice are one sighting.
const SHOTS = await Promise.all(Array.from({ length: 24 }, (_, i) => jpeg(i * 10)));
let shots = 0;

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

/** Another garage of the same tenant, with its own entry lane, and the same operator key. */
async function sameTenantGarage(g) {
  const { id, lane } = await withTenant(g.tenant, async (c) => {
    const garageId = (await c.query(
      "INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, 'Second', 'UTC', 'USD') RETURNING id", [g.tenant])).rows[0].id;
    await storePlan(c, g.tenant, garageId, flatHourlyPlan({ hourlyMinor: 250, currency: 'USD' }));
    await activateGarage(c, g.tenant, garageId);
    const laneId = (await c.query(
      "INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1, $2, 'Entry 2', 'entry') RETURNING id", [g.tenant, garageId])).rows[0].id;
    return { id: garageId, lane: laneId };
  });
  return { ...g, id, entry: await token(g.tenant, lane, 'entry 2') };
}

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
const picture = (extra = {}) => ({ picture: SHOTS[shots++ % SHOTS.length].toString('base64'), ...extra });
const stuckList = async (g) => (await (await call(g.op, 'GET', `/garages/${g.id}/stays/stuck`)).json()).stays;

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

test('SENT AGAIN WITHOUT A CLIENT_REF: the same picture on the same walk answers the sighting already kept, read once', async () => {
  readerOn();
  reader.state.identity = { plate: 'DIG1234', plate_characters: read('DIG1234') };
  const g = await garage('wk-digest');
  const stay = await enter(g, { plate: 'DIG1234' });
  const walk = await startWalk(g);
  const body = picture();
  const first = await seen(g, walk, body);
  const again = await sight(g, walk, body);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).sighting.id, first.id);
  assert.equal(reader.state.requests.length, 1, 'a picture sent again was read again');
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_with_stay.map((r) => [r.stay, r.sightings]), [[stay.id, [first.id]]]);
  const after = await sight(g, walk, body);
  assert.equal(after.status, 200, 'a picture sent again after the finish is answered, so the phone stops sending it');
  const n = await withTenant(g.tenant, async (c) => (await c.query('SELECT count(*)::int AS n FROM walk_sightings WHERE walk_id = $1', [walk.id])).rows[0].n);
  assert.equal(n, 1);
});

test('AN ANSWER THAT DOES NOT SAY SO: a typed plate answers the one waiting read it agrees with; anything else is a car of its own', async () => {
  readerOn();
  const g = await garage('wk-infer');
  const one = await enter(g, { plate: 'INF1123' });
  const two = await enter(g, { plate: 'INF2123' });
  reader.state.identity = { plate: 'INF?123', plate_characters: read('INF?123') };
  const walk = await startWalk(g);
  const unsure = await seen(g, walk, picture());
  const unrelated = await seen(g, walk, typed('ZZZ9999'));
  assert.equal(unrelated.confirms, null);
  const named = await seen(g, walk, { ...typed('INF2123'), client_ref: 'phone-typed-1' });
  assert.equal(named.confirms, null, 'a typed plate the phone gave its own id is a car of its own');
  const answer = await seen(g, walk, typed('INF1123'));
  assert.equal(answer.confirms, unsure.id);
  const done = await finish(g, walk);
  assert.deepEqual(new Map(done.lists.seen_with_stay.map((r) => [r.stay, r.sightings])), new Map([[one.id, [answer.id]], [two.id, [named.id]]]));
  assert.deepEqual(done.lists.seen_without_stay.map((r) => r.sighting), [unrelated.id]);
});

test('TWO READS WAITING: a typed plate that fits neither alone answers neither', async () => {
  readerOn();
  const g = await garage('wk-infer-two');
  reader.state.identity = { plate: null, plate_characters: { state: 'unreadable', rule: RULE, pattern: null } };
  const walk = await startWalk(g);
  await seen(g, walk, picture());
  await seen(g, walk, picture());
  assert.equal((await seen(g, walk, typed('TWW1234'))).confirms, null);
});

test('ONE CAR SENT TWICE WITH NO STAY: a whole plate is listed once, with both sightings', async () => {
  const g = await garage('wk-twice-none');
  const walk = await startWalk(g);
  const a = await seen(g, walk, typed('DUP1234'));
  const b = await seen(g, walk, typed('dup-1234'));
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_without_stay.map((r) => [r.sighting, r.plate, r.sightings]), [[a.id, 'DUP1234', [a.id, b.id]]]);
});

test('AN EMPTY PLATE FROM THE READER: its sure characters stand for it, kept and answered, never a 500', async () => {
  readerOn();
  const g = await garage('wk-empty-plate');
  const stay = await enter(g, { plate: 'EMP1234' });
  reader.state.identity = { plate: '', plate_characters: read('EMP1234') };
  const walk = await startWalk(g);
  const s = await seen(g, walk, picture());
  assert.deepEqual([s.read, s.plate, s.needs_confirmation], ['agreed', read('EMP1234').pattern, false]);
  const done = await finish(g, walk);
  assert.deepEqual(done.lists.seen_with_stay.map((r) => r.stay), [stay.id]);
});

test(`TOO MANY SIGHTINGS: a key sends at most ${SIGHTINGS_PER_MINUTE} a minute, refused before a picture is opened or read`, async () => {
  readerOn();
  reader.state.identity = { plate: 'LIM1234', plate_characters: read('LIM1234') };
  const g = await garage('wk-limit');
  const walk = await startWalk(g);
  for (let i = 0; i < SIGHTINGS_PER_MINUTE; i += 1) assert.equal((await sight(g, walk, {})).status, 400);
  const res = await sight(g, walk, picture());
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, 'too_many_sightings');
  assert.equal(reader.state.requests.length, 0);
  const other = await person(g, 'second desk');
  assert.equal((await sight(other, await startWalk(other), picture())).status, 201, "another key's minute is its own");
});

test('A PICK ON A FINISHED WALK: refused, and the finished lists keep the read unpicked', async () => {
  readerOn();
  const g = await garage('wk-pick-late');
  const one = await enter(g, { plate: 'PKL1123' });
  await enter(g, { plate: 'PKL2123' });
  reader.state.identity = { plate: 'PKL?123', plate_characters: read('PKL?123') };
  const walk = await startWalk(g);
  const s = await seen(g, walk, picture());
  const done = await finish(g, walk);
  const res = await call(g.op, 'POST', `/garages/${g.id}/walks/${walk.id}/sightings/${s.id}/pick`, { stay: one.id });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'walk_finished');
  const shown = (await (await call(g.op, 'GET', `/garages/${g.id}/walks/${walk.id}`)).json()).walk;
  assert.deepEqual(shown.lists, done.lists);
  assert.equal(shown.sightings.find((x) => x.id === s.id).picked_stay, null);
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
  assert.deepEqual(Object.keys(done.lists).sort(), ['incomplete', 'not_readable', 'seen_with_stay', 'seen_without_stay', 'stay_not_seen']);
  assert.deepEqual([done.seen_percent, done.incomplete, done.lists.incomplete], [50, 'walk incomplete (50%)', 'walk incomplete (50%)']);
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

const parked = (g, plates) => Promise.all(plates.map((plate) => enter(g, { plate, minutes: 60 })));
async function walkSaw(g, plates) {
  const walk = await startWalk(g);
  for (const plate of plates) await seen(g, walk, typed(plate));
  return finish(g, walk);
}
const notSeenStuck = async (g) => (await stuckList(g)).filter((s) => s.why === 'not_seen_on_walk').map((s) => s.id);

test('THE STUCK LIST READS THE WALKS: a young stay the latest walk missed is listed; a seen one carries when it was seen', async () => {
  const g = await garage('wk-stuck');
  const young = await enter(g, { plate: 'YNG1111', minutes: 60 });
  const old = await enter(g, { plate: 'OLD2222', minutes: 100 * 60 });
  await parked(g, ['STK1111', 'STK2222', 'STK3333']);
  const done = await walkSaw(g, ['OLD2222', 'STK1111', 'STK2222', 'STK3333']);
  assert.equal(done.feeds_stuck, true);
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
  await parked(g, ['LTS2222', 'LTS3333', 'LTS4444', 'LTS5555']);
  await walkSaw(g, ['LTS2222', 'LTS3333', 'LTS4444', 'LTS5555']);
  assert.deepEqual(await notSeenStuck(g), [stay.id]);
  const newer = await enter(g, { plate: 'LTS6666', minutes: 0 });
  await walkSaw(g, ['LTS1111', 'LTS2222', 'LTS3333', 'LTS4444', 'LTS5555']);
  assert.deepEqual(await notSeenStuck(g), [newer.id]);
});

test('A WALK THAT SAW NOTHING: its lists say every stay was not seen, but it marks none stuck', async () => {
  const g = await garage('wk-empty-walk');
  const stays = await parked(g, ['EMW1111', 'EMW2222']);
  const done = await finish(g, await startWalk(g));
  assert.equal(done.feeds_stuck, false);
  assert.deepEqual([done.seen_percent, done.incomplete, done.lists.incomplete], [0, 'walk incomplete (0%)', 'walk incomplete (0%)']);
  assert.deepEqual(done.lists.stay_not_seen.map((r) => r.stay).sort(), stays.map((s) => s.id).sort());
  assert.deepEqual(await notSeenStuck(g), []);
});

test(`A WALK THAT SAW PART OF THE GARAGE: under ${WALK_COMPLETE_DEFAULT_PERCENT}% of its stays seen, by default, is incomplete and marks none stuck; nothing a walk lists ends or charges a stay`, async () => {
  const g = await garage('wk-part-walk');
  const all = await parked(g, ['PRT1111', 'PRT2222', 'PRT3333', 'PRT4444', 'PRT5555']);
  const part = await walkSaw(g, ['PRT1111', 'PRT2222', 'PRT3333', 'XXX0001', 'XXX0002']);
  assert.equal(part.feeds_stuck, false, 'sightings of cars with no stay count as seeing the garage');
  assert.deepEqual([part.seen_percent, part.complete_percent, part.incomplete], [60, 80, 'walk incomplete (60%)']);
  assert.deepEqual(await notSeenStuck(g), []);
  const enough = await walkSaw(g, ['PRT1111', 'PRT2222', 'PRT3333', 'PRT4444']);
  assert.equal(enough.feeds_stuck, true, 'exactly the threshold feeds');
  assert.deepEqual([enough.seen_percent, enough.incomplete, enough.lists.incomplete], [80, null, null]);
  assert.deepEqual(await notSeenStuck(g), [all[4].id]);
  const partLater = await walkSaw(g, ['PRT5555']);
  assert.equal(partLater.feeds_stuck, false);
  assert.deepEqual(await notSeenStuck(g), [], 'a stay a later walk saw is not stuck, even when that walk covered too little to list');
  const left = await withTenant(g.tenant, async (c) => ({
    open: (await c.query('SELECT count(*)::int AS n FROM sessions WHERE garage_id = $1 AND exit_at IS NULL', [g.id])).rows[0].n,
    paid: (await c.query('SELECT count(*)::int AS n FROM exit_payments WHERE tenant_id = $1', [g.tenant])).rows[0].n,
  }));
  assert.deepEqual(left, { open: 5, paid: 0 });
});

test("THE STUCK LIST IS THE GARAGE'S OWN: a later walk at the tenant's other garage hides nothing this garage's walk missed", async () => {
  const g = await garage('wk-stuck-two');
  const h = await sameTenantGarage(g);
  const missed = await enter(g, { plate: 'MSD1111', minutes: 60 });
  await parked(g, ['GSN1111', 'GSN2222', 'GSN3333', 'GSN4444']);
  assert.equal((await walkSaw(g, ['GSN1111', 'GSN2222', 'GSN3333', 'GSN4444'])).feeds_stuck, true);
  await parked(h, ['HSN1111']);
  assert.equal((await walkSaw(h, ['HSN1111'])).feeds_stuck, true);
  assert.deepEqual(await notSeenStuck(g), [missed.id]);
  assert.deepEqual(await notSeenStuck(h), []);
});

test("A GARAGE SETS ITS OWN THRESHOLD: at 75%, 3 of 4 seen feeds the stuck list; at 76%, the same walk is incomplete; the tenant's other garage keeps 80%", async () => {
  const g = await garage('wk-threshold');
  const h = await sameTenantGarage(g);
  const set = (body) => call(g.op, 'PATCH', `/garages/${g.id}`, body);
  for (const wrong of [0, 101, 75.5, '75', null, true]) {
    assert.equal((await set({ walk_complete_percent: wrong })).status, 400, `walk_complete_percent ${JSON.stringify(wrong)}`);
  }
  const res = await set({ walk_complete_percent: 75 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).garage.walk_complete_percent, 75);
  const line = await withTenant(g.tenant, (c) => c.query(
    "SELECT before, after FROM garage_changes WHERE garage_id = $1 AND action = 'garage.update' AND outcome = 'done'", [g.id]));
  assert.deepEqual(line.rows, [{ before: { walk_complete_percent: 80 }, after: { walk_complete_percent: 75 } }]);

  const stays = await parked(g, ['THR1111', 'THR2222', 'THR3333', 'THR4444']);
  const at75 = await walkSaw(g, ['THR1111', 'THR2222', 'THR3333']);
  assert.deepEqual([at75.feeds_stuck, at75.seen_percent, at75.complete_percent, at75.incomplete], [true, 75, 75, null],
    'exactly the garage threshold feeds');
  assert.deepEqual(await notSeenStuck(g), [stays[3].id]);

  assert.equal((await set({ walk_complete_percent: 76 })).status, 200);
  const at76 = await walkSaw(g, ['THR1111', 'THR2222', 'THR3333']);
  assert.deepEqual([at76.feeds_stuck, at76.seen_percent, at76.complete_percent, at76.incomplete, at76.lists.incomplete],
    [false, 75, 76, 'walk incomplete (75%)', 'walk incomplete (75%)'], 'one point under the garage threshold does not');
  assert.deepEqual(await notSeenStuck(g), [stays[3].id], 'an incomplete walk feeds nothing: the last complete walk still lists');
  const kept = (await (await call(g.op, 'GET', `/garages/${g.id}/walks/${at75.id}`)).json()).walk;
  assert.deepEqual([kept.feeds_stuck, kept.complete_percent, kept.incomplete], [true, 75, null], 'a finished walk keeps the threshold it finished under');
  const shown = (await (await call(g.op, 'GET', `/garages/${g.id}/walks/${at76.id}`)).json()).walk;
  assert.deepEqual([shown.seen_percent, shown.incomplete, shown.lists.incomplete], [75, 'walk incomplete (75%)', 'walk incomplete (75%)']);

  await parked(h, ['HTH1111', 'HTH2222', 'HTH3333', 'HTH4444']);
  const other = await walkSaw(h, ['HTH1111', 'HTH2222', 'HTH3333']);
  assert.deepEqual([other.feeds_stuck, other.complete_percent, other.incomplete], [false, 80, 'walk incomplete (75%)']);
  assert.deepEqual(await notSeenStuck(h), []);
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
  await refused('UPDATE garages SET walk_complete_percent = 0 WHERE id = $1', [a.id], /garages_walk_complete_percent_check/);
  await refused('UPDATE garages SET walk_complete_percent = 101 WHERE id = $1', [a.id], /garages_walk_complete_percent_check/);
  await refused(
    `UPDATE walks SET finished_at = now(), finished_by = 'key:x', lists = '{}', feeds_stuck = true, seen_percent = 79, complete_percent = 80
      WHERE id = $1`, [walk.id], /walks_finished_whole/);
  await refused(
    "UPDATE walks SET finished_at = now(), finished_by = 'key:x', lists = '{}', feeds_stuck = false, seen_percent = 50 WHERE id = $1",
    [walk.id], /walks_finished_whole/);
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

test('THE DATABASE KEEPS A CLOSED WALK AS IT ENDED: the app role reopens nothing, changes no sighting or list, and deletes no listed stay', async () => {
  const g = await garage('wk-db-frozen');
  await enter(g, { plate: 'DBF1111' });
  await enter(g, { plate: 'DBF2222' });
  const walk = await startWalk(g);
  const s = await seen(g, walk, typed('DBF1111'));
  const p = await seen(g, walk, picture());
  await finish(g, walk);
  const later = await enter(g, { plate: 'DBF3333', minutes: 0 });
  const refused = (sql, params, why) => assert.rejects(withTenant(g.tenant, (c) => c.query(sql, params)), why);
  await refused('UPDATE walks SET finished_at = NULL, finished_by = NULL, lists = NULL, feeds_stuck = NULL WHERE id = $1', [walk.id], /walks_frozen/);
  await refused("UPDATE walks SET lists = '{}'::jsonb WHERE id = $1", [walk.id], /walks_frozen/);
  await refused('UPDATE walks SET feeds_stuck = NOT feeds_stuck WHERE id = $1', [walk.id], /walks_frozen/);
  await refused('UPDATE walks SET complete_percent = 1 WHERE id = $1', [walk.id], /walks_frozen/);
  await refused("UPDATE walk_sightings SET plate = 'DBF2222' WHERE id = $1", [s.id], /walk_sightings_frozen/);
  await refused('UPDATE walk_sightings SET picked_stay = $2 WHERE id = $1', [s.id, later.id], /walk_sightings_frozen/);
  await refused(
    `INSERT INTO walk_sightings (tenant_id, walk_id, read, plate, taken_at, added_by)
     VALUES ($1, $2, 'typed', 'DBF2222', now(), 'key:x')`, [g.tenant, walk.id], /walk_sightings_frozen/);
  await refused("INSERT INTO walk_stays (tenant_id, walk_id, session_id, list) VALUES ($1, $2, $3, 'seen')", [g.tenant, walk.id, later.id], /walk_stays_frozen/);
  await refused("UPDATE walk_stays SET list = 'seen' WHERE walk_id = $1", [walk.id], /permission denied/);
  await refused('DELETE FROM walk_stays WHERE walk_id = $1', [walk.id], /permission denied/);
  await refused('DELETE FROM walk_sightings WHERE walk_id = $1', [walk.id], /permission denied/);
  const forgotten = await withTenant(g.tenant, (c) => c.query(
    'UPDATE walk_sightings SET picture = NULL, picture_type = NULL, picture_digest = NULL WHERE id = $1 AND picture IS NOT NULL', [p.id]));
  assert.equal(forgotten.rowCount, 1, 'the picture of a closed walk can still be forgotten');
  const night = await person(g, 'night desk');
  const stale = await startWalk(night);
  await withTenant(g.tenant, (c) => c.query(
    'UPDATE walks SET started_at = started_at - make_interval(hours => $2) WHERE id = $1', [stale.id, WALK_ABANDON_HOURS + 1]));
  await startWalk(night);
  await refused('UPDATE walks SET abandoned_at = NULL WHERE id = $1', [stale.id], /walks_frozen/);
  const kept = await withTenant(g.tenant, async (c) => (await c.query(
    'SELECT list, count(*)::int AS n FROM walk_stays WHERE walk_id = $1 GROUP BY list ORDER BY list', [walk.id])).rows);
  assert.deepEqual(kept, [{ list: 'not_seen', n: 1 }, { list: 'seen', n: 1 }]);
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
  await ageWalks([oldWalk.id, stale.id], 40);
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
