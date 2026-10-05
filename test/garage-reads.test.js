/**
 * The three reads the owner's screens need (U2a): the tenant's garages, one
 * garage, and its lanes with their devices and their card reader.
 *
 * Held here: the shapes, and only those fields; a revoked device is shown
 * with when it was revoked, and an unbound reader is not shown; no credential hash is; the reads work behind
 * the owner's session as behind a key; and they write nothing. Tenant
 * isolation is held in tenant-isolation.test.js.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { createAdmin } from '../src/adminAccount.js';
import { COOKIE } from '../src/signIn.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const PASSWORD = 'correct horse battery staple';

let server;
let base;
let tenant;
let world;
let key;
let cookie;
// Reader ids are unique among live bindings across the database, so each run gets its own.
const RUN = Math.random().toString(36).slice(2, 10);
const EXIT_READER = `tmr_stubExit${RUN}`;
const GONE_READER = `tmr_stubGone${RUN}`;

const get = (path, auth = { authorization: `Bearer ${key}` }) =>
  fetch(`${base}/api/v1${path}`, { headers: auth }).then(async (r) => ({ status: r.status, json: await r.json() }));

before(async () => {
  process.env.ADMIN_ORIGIN = ADMIN_ORIGIN;
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  tenant = await createTenant('garage-reads');
  world = await buildWorld(tenant);
  key = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(key)]));
  const email = `reads-${tenant.slice(0, 8)}@example.com`;
  await createAdmin({ tenantId: tenant, email, password: PASSWORD });
  const res = await fetch(`${base}/api/v1/auth/sign-in`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  cookie = res.headers.getSetCookie()[0].split(';')[0];

  await withTenant(tenant, async (c) => {
    // A second, inactive garage, made later.
    await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, 'Not Yet Live', 'Europe/London', 'GBP')`, [tenant]);
    // Two devices on the entry lane, one heard from and one revoked; one on the exit lane, never heard from.
    await c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash, last_seen_at) VALUES ($1,$2,'entry-pi',$3, '2026-09-30T12:00:00Z')`, [tenant, world.entryLane, hashToken(generateDeviceToken())]);
    await c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash, revoked_at) VALUES ($1,$2,'old-pi',$3, now())`, [tenant, world.entryLane, hashToken(generateDeviceToken())]);
    await c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,'exit-pi',$3)`, [tenant, world.exitLane, hashToken(generateDeviceToken())]);
    // A reader bound to the exit lane, and one that WAS bound to the entry lane.
    await c.query(
      `INSERT INTO lane_readers (tenant_id, garage_id, lane_id, account_id, location_id, reader_id, label, bound_by, bound_at)
       VALUES ($1,$2,$3,'acct_stubReads','tml_stubReads',$4,'Exit reader','test','2026-09-29T10:00:00Z')`, [tenant, world.garage, world.exitLane, EXIT_READER]);
    // A binding begins bound (0021's trigger); this one is then ended.
    await c.query(
      `INSERT INTO lane_readers (tenant_id, garage_id, lane_id, account_id, location_id, reader_id, label, bound_by, bound_at)
       VALUES ($1,$2,$3,'acct_stubReads','tml_stubReads',$4,'Gone','test', now() - interval '1 day')`, [tenant, world.garage, world.entryLane, GONE_READER]);
    await c.query(`UPDATE lane_readers SET unbound_at = now(), unbound_by = 'test' WHERE reader_id = $1`, [GONE_READER]);
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

test('GET /garages: the tenant\'s garages, oldest first, with exactly id, name, time zone, currency and whether each is live', async () => {
  const r = await get('/garages');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.garages, [
    { id: world.garage, name: 'Test Garage', timezone: 'America/New_York', currency: 'USD', live: true },
    { id: r.json.garages[1].id, name: 'Not Yet Live', timezone: 'Europe/London', currency: 'GBP', live: false },
  ]);
});

test('GET /garages/:id: one garage, the same shape; an unknown one is 404', async () => {
  const r = await get(`/garages/${world.garage}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.garage, { id: world.garage, name: 'Test Garage', timezone: 'America/New_York', currency: 'USD', live: true });
  const missing = await get('/garages/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: 'garage not found' });
});

test('GET /garages/:id/lanes: each lane with its devices, when each was last heard from and whether it is revoked, and its bound reader', async () => {
  const r = await get(`/garages/${world.garage}/lanes`);
  assert.equal(r.status, 200);
  assert.equal(r.json.lanes.length, 2);
  // Ordered by creation; these two were made in one transaction, so the id breaks the tie.
  const entry = r.json.lanes.find((l) => l.id === world.entryLane);
  const exit = r.json.lanes.find((l) => l.id === world.exitLane);
  assert.deepEqual(Object.keys(entry).sort(), ['closed', 'devices', 'direction', 'id', 'name', 'reader', 'reopened']);
  // Open, and never closed (0026): closing is covered in lane-setup.test.js.
  assert.deepEqual([entry.closed, entry.reopened], [null, null]);
  assert.deepEqual([entry.id, entry.name, entry.direction], [world.entryLane, 'Entry 1', 'entry']);
  // Made in one transaction, so compared by name rather than by the creation order.
  const byName = (list) => [...list].sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(byName(entry.devices).map((d) => [d.name, d.last_seen_at, d.revoked_at === null]), [['entry-pi', '2026-09-30T12:00:00.000Z', true], ['old-pi', null, false]],
    'a revoked device is shown, with when it was revoked');
  assert.equal(entry.reader, null, 'an unbound reader is no longer the lane\'s');
  assert.deepEqual([exit.id, exit.direction], [world.exitLane, 'exit']);
  assert.deepEqual(exit.devices.map((d) => [d.name, d.last_seen_at, d.revoked_at]), [['exit-pi', null, null]], 'never heard from is null, not absent');
  assert.deepEqual(exit.reader, { reader_id: EXIT_READER, label: 'Exit reader', bound_at: '2026-09-29T10:00:00.000Z' });
  for (const d of [...entry.devices, ...exit.devices]) assert.deepEqual(Object.keys(d).sort(), ['id', 'last_seen_at', 'name', 'revoked_at']);
  assert.equal(JSON.stringify(r.json).includes('token_hash'), false);
  const missing = await get('/garages/00000000-0000-4000-8000-000000000000/lanes');
  assert.equal(missing.status, 404);
});

test('the reads work behind the owner\'s session exactly as behind a key', async () => {
  for (const path of ['/garages', `/garages/${world.garage}`, `/garages/${world.garage}/lanes`]) {
    const byKey = await get(path);
    const bySession = await get(path, { cookie });
    assert.equal(bySession.status, 200, path);
    assert.deepEqual(bySession.json, byKey.json, path);
  }
  assert.ok(cookie.startsWith(`${COOKIE}=`));
});
