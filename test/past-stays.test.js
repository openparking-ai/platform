/**
 * A garage's past stays (src/pastStays.js): GET /garages/:garageId/stays/closed.
 *
 * Held here: the stays that closed in the range and only those, oldest exit
 * first, each with exactly its seven fields; no vehicle identity anywhere in
 * the answer (a plate, a ticket, a descriptor and the ids are planted and none
 * is found); the pages join up with nothing lost or repeated; every bound
 * refuses in its own sentence with no database words; another tenant's garage
 * is the same 404 as one that does not exist; no credential is 401 and the
 * owner's session reads it as a key does; and the read writes nothing.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { createAdmin } from '../src/adminAccount.js';
import { PAGE_MAX, RANGE_MAX_DAYS } from '../src/pastStays.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const PASSWORD = 'correct horse battery staple';
const PLATE = 'PLANTPLATE9';
const TICKET = 'PLANTTICKET7';
const DESCRIPTOR = 'planted-descriptor-silver-hatchback';
const FIELDS = ['currency', 'ended', 'entry_at', 'exit_at', 'exit_outcome', 'fee_minor', 'let_out_unpaid', 'occupancy_at_entry_bp', 'owed_minor', 'pass_unasked', 'pricing_refused', 'subtotal_minor'];
// The words a database error carries; none may reach an answer.
const DB_WORDS = /relation|column|syntax|SQLSTATE|violates|constraint|postgres|timestamptz|uuid|select|where/i;

let server;
let base;
let tenant;
let other;
let world;
let otherWorld;
let key;
let otherKey;
let cookie;
const ids = { vehicles: [], sessions: [] };

const FROM = '2026-09-01T00:00:00Z';
const TO = '2026-09-08T00:00:00Z';

const get = (path, headers = { authorization: `Bearer ${key}` }) =>
  fetch(`${base}/api/v1${path}`, { headers }).then(async (r) => ({ status: r.status, text: await r.text() }))
    .then((r) => ({ ...r, json: JSON.parse(r.text) }));

const closed = (garage, q = {}) => {
  const params = new URLSearchParams({ from: FROM, to: TO, ...q });
  return `/garages/${garage}/stays/closed?${params}`;
};

async function issueKey(tenantId) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenantId, hashToken(token)]));
  return token;
}

/** One closed stay, in one of the shapes 0015 allows. */
async function stay(c, w, vehicle, { entry, exit, shape = 'legacy', fee = 400 }) {
  const id = randomUUID();
  const common = [id, w.tenantId, w.garage, vehicle, w.entryLane, w.exitLane, entry, exit, `open-${id}`, `close-${id}`];
  const cols = `id, tenant_id, garage_id, vehicle_id, entry_lane_id, exit_lane_id, entry_at, exit_at, open_event_id, close_event_id,
                currency, entry_confirmation, exit_confirmation, entry_descriptor, exit_descriptor`;
  const vals = `$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'USD','confirmed','confirmed','${DESCRIPTOR}','${DESCRIPTOR}'`;
  if (shape === 'legacy') {
    await c.query(`INSERT INTO sessions (${cols}, hourly_minor_applied, fee_minor) VALUES (${vals}, 250, $11)`, [...common, fee]);
  } else if (shape === 'covered') {
    await c.query(`INSERT INTO sessions (${cols}, exit_outcome) VALUES (${vals}, 'covered')`, common);
  } else if (shape === 'refused') {
    await c.query(
      `INSERT INTO sessions (${cols}, exit_outcome, pricing_refusal) VALUES (${vals}, 'transient', '[{"code":"no_plan"}]')`,
      common,
    );
  }
  ids.sessions.push(id);
  return id;
}

before(async () => {
  process.env.ADMIN_ORIGIN = ADMIN_ORIGIN;
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  tenant = await createTenant('past-stays');
  other = await createTenant('past-stays-other');
  world = await buildWorld(tenant);
  otherWorld = await buildWorld(other);
  key = await issueKey(tenant);
  otherKey = await issueKey(other);

  const email = `stays-${tenant.slice(0, 8)}@example.com`;
  await createAdmin({ tenantId: tenant, email, password: PASSWORD });
  const res = await fetch(`${base}/api/v1/auth/sign-in`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  cookie = res.headers.getSetCookie()[0].split(';')[0];

  await withTenant(tenant, async (c) => {
    const plated = (await c.query(`INSERT INTO vehicles (tenant_id, plate) VALUES ($1,$2) RETURNING id`, [tenant, PLATE])).rows[0].id;
    const ticketed = (await c.query(`INSERT INTO vehicles (tenant_id, ticket_ref) VALUES ($1,$2) RETURNING id`, [tenant, TICKET])).rows[0].id;
    ids.vehicles.push(plated, ticketed);
    // In the range: five, in three shapes, one exactly on `from`.
    await stay(c, world, plated, { entry: '2026-08-31T22:00:00Z', exit: '2026-09-01T00:00:00Z', fee: 500 });
    await stay(c, world, ticketed, { entry: '2026-09-02T08:00:00Z', exit: '2026-09-02T10:30:00Z', fee: 750 });
    await stay(c, world, plated, { entry: '2026-09-03T08:00:00Z', exit: '2026-09-03T09:00:00Z', shape: 'covered' });
    await stay(c, world, ticketed, { entry: '2026-09-04T08:00:00Z', exit: '2026-09-04T09:00:00Z', shape: 'refused' });
    // Two leaving at the same instant: the cursor's tie-break is the id.
    await stay(c, world, plated, { entry: '2026-09-05T08:00:00Z', exit: '2026-09-05T12:00:00.123456Z', fee: 1000 });
    await stay(c, world, ticketed, { entry: '2026-09-05T09:00:00Z', exit: '2026-09-05T12:00:00.123456Z', fee: 900 });
    // Outside it: one left before, one left exactly on `to`, one still inside.
    await stay(c, world, plated, { entry: '2026-08-20T08:00:00Z', exit: '2026-08-20T09:00:00Z' });
    await stay(c, world, ticketed, { entry: '2026-09-07T20:00:00Z', exit: '2026-09-08T00:00:00Z' });
    await c.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, open_event_id, currency, entry_confirmation)
       VALUES ($1,$2,$3,$4,'2026-09-06T08:00:00Z',$5,'USD','confirmed')`,
      [tenant, world.garage, world.vehicle, world.entryLane, `open-${randomUUID()}`],
    );
  });
  // The other tenant's garage has a stay in the same range.
  await withTenant(other, (c) => stay(c, otherWorld, otherWorld.vehicle, { entry: '2026-09-02T08:00:00Z', exit: '2026-09-02T09:00:00Z', fee: 12345 }));
});

after(async () => {
  server.close();
  await pool.end();
});

test('the stays that closed in the range, oldest exit first, each with exactly its fields', async () => {
  const { status, json } = await get(closed(world.garage));
  assert.equal(status, 200);
  assert.equal(json.garage_id, world.garage);
  assert.equal(json.from, '2026-09-01T00:00:00.000Z');
  assert.equal(json.to, '2026-09-08T00:00:00.000Z');
  assert.equal(json.next, null);
  assert.equal(json.stays.length, 6);
  for (const s of json.stays) assert.deepEqual(Object.keys(s).sort(), FIELDS);
  assert.deepEqual(json.stays.map((s) => s.fee_minor), [500, 750, null, null, json.stays[4].fee_minor, json.stays[5].fee_minor]);
  assert.deepEqual(new Set([json.stays[4].fee_minor, json.stays[5].fee_minor]), new Set([1000, 900]));
  const exits = json.stays.map((s) => Date.parse(s.exit_at));
  assert.deepEqual(exits, [...exits].sort((a, b) => a - b));
  assert.equal(json.stays[0].exit_at, '2026-09-01T00:00:00.000Z', 'a stay leaving exactly on `from` is in');
  assert.equal(json.stays[0].entry_at, '2026-08-31T22:00:00.000Z');
  assert.equal(json.stays[0].currency, 'USD');
  assert.equal(json.stays[0].exit_outcome, null, 'priced by the old hourly rate');
  assert.equal(json.stays[2].exit_outcome, 'covered');
  assert.equal(json.stays[2].pricing_refused, false);
  assert.equal(json.stays[3].exit_outcome, 'transient');
  assert.equal(json.stays[3].pricing_refused, true);
  assert.ok(!json.stays.some((s) => s.fee_minor === 12345), "another tenant's stay is not in it");
});

test('no vehicle identity anywhere in the answer', async () => {
  const { text } = await get(closed(world.garage));
  for (const planted of [PLATE, TICKET, DESCRIPTOR, ...ids.vehicles, world.vehicle, ...ids.sessions, 'plate', 'ticket', 'descriptor', 'vehicle']) {
    assert.ok(!text.includes(planted), `the answer carries ${planted}`);
  }
});

test('the pages join up: nothing lost, nothing repeated, the tie at one instant split by the cursor', async () => {
  const whole = (await get(closed(world.garage))).json.stays;
  const seen = [];
  let after;
  let pages = 0;
  do {
    const { status, json } = await get(closed(world.garage, { limit: '1', ...(after ? { after } : {}) }));
    assert.equal(status, 200);
    assert.equal(json.limit, 1);
    assert.ok(json.stays.length <= 1);
    seen.push(...json.stays);
    after = json.next;
    pages += 1;
  } while (after && pages < 20);
  assert.equal(pages, 6);
  assert.deepEqual(seen, whole);
});

test('every bound refuses in a sentence, with its code and no database words', async () => {
  const cases = [
    [`/garages/${world.garage}/stays/closed`, 'range_invalid'],
    [`/garages/${world.garage}/stays/closed?from=${FROM}`, 'range_invalid'],
    [closed(world.garage, { from: '2026-09-01T00:00:00' }), 'range_invalid'],
    [closed(world.garage, { from: '2026-09-01' }), 'range_invalid'],
    [closed(world.garage, { from: '2026-13-40T00:00:00Z' }), 'range_invalid'],
    [closed(world.garage, { from: "2026-09-01T00:00:00Z'; DROP TABLE sessions; --" }), 'range_invalid'],
    [closed(world.garage, { from: TO, to: FROM }), 'range_invalid'],
    [closed(world.garage, { from: FROM, to: FROM }), 'range_invalid'],
    [closed(world.garage, { from: '2026-06-01T00:00:00Z', to: '2026-09-03T00:00:01Z' }), 'range_too_long'],
    [closed(world.garage, { limit: '0' }), 'page_size_invalid'],
    [closed(world.garage, { limit: String(PAGE_MAX + 1) }), 'page_size_invalid'],
    [closed(world.garage, { limit: '10.5' }), 'page_size_invalid'],
    [closed(world.garage, { limit: '-1' }), 'page_size_invalid'],
    [closed(world.garage, { after: 'not a cursor' }), 'cursor_invalid'],
    [closed(world.garage, { after: Buffer.from('["x","y"]').toString('base64url') }), 'cursor_invalid'],
    [closed(world.garage, { after: Buffer.from(JSON.stringify(['2026-09-01T00:00:00Z', "1' OR '1'='1"])).toString('base64url') }), 'cursor_invalid'],
    [closed(world.garage, { after: Buffer.from('{').toString('base64url') }), 'cursor_invalid'],
  ];
  for (const [path, code] of cases) {
    const { status, json, text } = await get(path);
    assert.equal(status, 400, path);
    assert.equal(json.code, code, path);
    assert.equal(typeof json.error, 'string');
    assert.doesNotMatch(text, DB_WORDS, path);
  }
  // The longest range allowed is allowed.
  const longest = new Date(Date.parse(FROM) + RANGE_MAX_DAYS * 24 * 3600 * 1000).toISOString();
  assert.equal((await get(closed(world.garage, { to: longest }))).status, 200);
  assert.equal((await get(closed(world.garage, { limit: String(PAGE_MAX) }))).status, 200);
  // Repeated parameters are not a string: refused, not a 500.
  const twice = await get(`/garages/${world.garage}/stays/closed?from=${FROM}&from=${FROM}&to=${TO}`);
  assert.equal(twice.status, 400);
  const limitTwice = await get(`${closed(world.garage)}&limit=1&limit=2`);
  assert.equal(limitTwice.status, 400);
});

test("another tenant's garage is the same 404 as one that does not exist", async () => {
  const theirs = await get(closed(otherWorld.garage));
  const none = await get(closed(randomUUID()));
  assert.equal(theirs.status, 404);
  assert.deepEqual(theirs.json, none.json);
  assert.doesNotMatch(theirs.text, /12345/);
  // And the other tenant sees its own, not this one's.
  const own = await get(closed(otherWorld.garage), { authorization: `Bearer ${otherKey}` });
  assert.equal(own.status, 200);
  assert.deepEqual(own.json.stays.map((s) => s.fee_minor), [12345]);
  const mine = await get(closed(world.garage), { authorization: `Bearer ${otherKey}` });
  assert.equal(mine.status, 404);
  // A malformed id is a 404 too, before the database is asked.
  assert.equal((await get(closed('not-a-uuid'))).status, 404);
});

test('no credential is 401; the owner\'s session reads it as a key does', async () => {
  const none = await get(closed(world.garage), {});
  assert.equal(none.status, 401);
  assert.ok(!('stays' in none.json));
  const wrong = await get(closed(world.garage), { authorization: `Bearer ${generateDeviceToken()}` });
  assert.equal(wrong.status, 401);
  const bySession = await get(closed(world.garage), { cookie });
  assert.equal(bySession.status, 200);
  assert.deepEqual(bySession.json, (await get(closed(world.garage))).json);
});

test('the read writes nothing', async () => {
  const count = () => withTenant(tenant, async (c) => {
    const s = await c.query('SELECT count(*)::int AS n, max(change_seq) AS seq FROM sessions');
    const g = await c.query('SELECT count(*)::int AS n FROM garage_changes');
    return [s.rows[0].n, String(s.rows[0].seq), g.rows[0].n];
  });
  const before = await count();
  await get(closed(world.garage));
  await get(closed(world.garage, { limit: '0' }));
  await get(closed(otherWorld.garage));
  assert.deepEqual(await count(), before);
});
