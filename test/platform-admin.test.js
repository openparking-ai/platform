/**
 * The platform admin's door (src/platformAdmin.js) and its read (0049).
 *
 * Held here: every account is in it with its garages, their lanes (entry or
 * exit, closed or open) and number of spaces, and an account with no garage
 * is in it too; cars in (entry gate) and out (exit gate) are counted on the
 * GARAGE'S local day, both ends of the range included, a car still inside or
 * ended with no exit gate counted in but not out; no
 * plate, ticket, descriptor or vehicle id is anywhere in the answer; no key,
 * a wrong key and an unreadable key file are 401 and never echo what was
 * sent; past the refusal count the caller is 429; days that are not two
 * dates, the first first, at most 366 days apart, are 400; the door is 404
 * when no key file is named; the read leaves the caller's tenant setting as
 * it found it; and it changes nothing.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createApp } from '../src/app.js';
import { createPlatformAdminRouter, dayOf, REFUSED_PER_WINDOW, readPlatformAdminSettings } from '../src/platformAdmin.js';
import { pool, withTenant, createTenant, buildWorld, superuserClient } from './helpers.js';

const KEY = `k${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
const PLATE = 'ADMINPLATE42';
const DESCRIPTOR = 'planted-descriptor-for-the-admin-read';

let server;
let base;
let keyFile;
let tenant;
let empty;
let world;

const get = (path, key = KEY) =>
  fetch(`${base}/api/v1/platform-admin${path}`, { headers: key === null ? {} : { authorization: `Bearer ${key}` } })
    .then(async (r) => ({ status: r.status, text: await r.text(), cache: r.headers.get('cache-control') }))
    .then((r) => ({ ...r, json: JSON.parse(r.text) }));

async function stay(c, w, vehicle, entry, exit) {
  const id = randomUUID();
  if (exit === null) {
    await c.query(
      `INSERT INTO sessions (id, tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, open_event_id, currency, entry_confirmation, entry_descriptor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD','confirmed',$8)`,
      [id, w.tenantId, w.garage, vehicle, w.entryLane, entry, `open-${id}`, DESCRIPTOR]);
  } else {
    await c.query(
      `INSERT INTO sessions (id, tenant_id, garage_id, vehicle_id, entry_lane_id, exit_lane_id, entry_at, exit_at, open_event_id, close_event_id,
                             currency, entry_confirmation, exit_confirmation, entry_descriptor, exit_descriptor, hourly_minor_applied, fee_minor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'USD','confirmed','confirmed',$11,$11,250,400)`,
      [id, w.tenantId, w.garage, vehicle, w.entryLane, w.exitLane, entry, exit, `open-${id}`, `close-${id}`, DESCRIPTOR]);
  }
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-admin-'));
  keyFile = join(dir, 'key.txt');
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  process.env.PLATFORM_ADMIN_KEY_FILE = keyFile;
  try {
    server = createApp().listen(0, '127.0.0.1');
  } finally {
    delete process.env.PLATFORM_ADMIN_KEY_FILE;
  }
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  tenant = await createTenant('Admin Read Customer');
  empty = await createTenant('Admin Read No Garage');
  world = await buildWorld(tenant); // America/New_York, Entry 1 + Exit 1, active
  await withTenant(tenant, async (c) => {
    await c.query('UPDATE garages SET spaces = 120 WHERE id = $1', [world.garage]);
    await c.query(`UPDATE lanes SET closed_reason = 'everyone', closed_message = 'Works', closed_by = 'test', closed_at = now() WHERE id = $1`, [world.exitLane]);
    const v = (await c.query('INSERT INTO vehicles (tenant_id, plate) VALUES ($1,$2) RETURNING id', [tenant, PLATE])).rows[0].id;
    const v2 = (await c.query('INSERT INTO vehicles (tenant_id, plate) VALUES ($1,$2) RETURNING id', [tenant, `${PLATE}B`])).rows[0].id;
    // New York is UTC-4 on these days. 2026-09-02 local runs 04:00Z on the 2nd to 04:00Z on the 3rd.
    await stay(c, world, v, '2026-09-02T03:59:00Z', '2026-09-02T05:00:00Z'); // in on the 1st (local), out on the 2nd
    await stay(c, world, v, '2026-09-02T12:00:00Z', '2026-09-02T14:00:00Z'); // in and out on the 2nd
    await stay(c, world, v, '2026-09-03T03:30:00Z', '2026-09-03T04:30:00Z'); // in on the 2nd (local), out on the 3rd
    await stay(c, world, v2, '2026-09-02T20:00:00Z', null); // in on the 2nd, still inside
    // In through the entry gate on the 2nd, then ended by a person with no exit gate (0039): in, never out.
    const id = randomUUID();
    await c.query(
      `INSERT INTO sessions (id, tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, exit_at, open_event_id, currency, entry_confirmation, entry_descriptor, ended)
       VALUES ($1,$2,$3,$4,$5,'2026-09-02T15:00:00Z','2026-09-02T16:00:00Z',$6,'USD','confirmed',$7,$8)`,
      [id, tenant, world.garage, v2, world.entryLane, `open-${id}`, DESCRIPTOR,
        { reason: 'ended', at: '2026-09-02T16:00:00Z', by: 'test', why: 'The car was towed.' }]);
  });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const mine = (body) => body.customers.filter((c) => c.id === tenant || c.id === empty);

test('every account is in it, with its garages, lanes and spaces; an account with no garage too', async () => {
  const r = await get('/summary?from=2026-09-02&to=2026-09-02');
  assert.equal(r.status, 200);
  assert.equal(r.cache, 'no-store');
  const [c, e] = [mine(r.json).find((x) => x.id === tenant), mine(r.json).find((x) => x.id === empty)];
  assert.equal(c.name, 'Admin Read Customer');
  assert.equal(c.garages.length, 1);
  const g = c.garages[0];
  assert.deepEqual(Object.keys(g).sort(), ['carsIn', 'carsOut', 'id', 'lanes', 'name', 'open', 'spaces', 'timezone']);
  assert.equal(g.id, world.garage);
  assert.equal(g.open, true);
  assert.equal(g.spaces, 120);
  assert.deepEqual(g.lanes.map((l) => [l.name, l.direction, l.closed]), [['Entry 1', 'entry', false], ['Exit 1', 'exit', true]]);
  assert.equal(e.name, 'Admin Read No Garage');
  assert.deepEqual(e.garages, []);
});

test('cars in are entry-gate stays and cars out exit-gate stays, on the garage\'s own day; a car still inside, or ended with no exit gate, is in, not out', async () => {
  const day2 = mine((await get('/summary?from=2026-09-02&to=2026-09-02')).json).find((x) => x.id === tenant).garages[0];
  assert.deepEqual([day2.carsIn, day2.carsOut], [4, 2]);
  const day1 = mine((await get('/summary?from=2026-09-01&to=2026-09-01')).json).find((x) => x.id === tenant).garages[0];
  assert.deepEqual([day1.carsIn, day1.carsOut], [1, 0]);
  const range = mine((await get('/summary?from=2026-09-01&to=2026-09-03')).json).find((x) => x.id === tenant).garages[0];
  assert.deepEqual([range.carsIn, range.carsOut], [5, 3]);
  const none = mine((await get('/summary?from=2026-08-01&to=2026-08-31')).json).find((x) => x.id === tenant).garages[0];
  assert.deepEqual([none.carsIn, none.carsOut], [0, 0]);
});

test('no plate, descriptor or vehicle id is in the answer', async () => {
  const r = await get('/summary?from=2026-09-01&to=2026-09-03');
  assert.ok(!r.text.includes(PLATE));
  assert.ok(!r.text.includes(DESCRIPTOR));
  assert.ok(!r.text.includes(world.vehicle));
});

test('days that are not two dates, the first first, at most 366 days apart, are 400', async () => {
  for (const q of ['', '?from=2026-09-01', '?from=2026-09-02&to=2026-09-01', '?from=2026-02-30&to=2026-03-01',
    '?from=2025-01-01&to=2026-01-02', '?from=x&to=y', '?from=2026-9-1&to=2026-9-2']) {
    const r = await get(`/summary${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.code, 'days_refused');
  }
  assert.equal((await get('/summary?from=2025-01-01&to=2026-01-01')).status, 200, '366 days is taken');
});

test('no key, a wrong key, and a key file that cannot be read are 401 and echo nothing', async () => {
  const wrong = `w${'x'.repeat(40)}`;
  for (const k of [null, wrong]) {
    const r = await get('/summary?from=2026-09-01&to=2026-09-01', k);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'platform_admin_key_required');
    if (k) assert.ok(!r.text.includes(k));
  }
  const missing = express().use(createPlatformAdminRouter({ settings: { on: true, keyFile: '/nonexistent/key.txt' } }));
  const s = missing.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${s.address().port}/summary?from=2026-09-01&to=2026-09-01`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(res.status, 401);
  await new Promise((r) => s.close(r));
});

test('past the refusal count a caller is 429, even with the key, until the window passes', async () => {
  let clock = 0;
  const app = express().use(createPlatformAdminRouter({ settings: { on: true, keyFile }, now: () => clock }));
  const s = app.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const at = (k) => fetch(`http://127.0.0.1:${s.address().port}/summary?from=2026-09-01&to=2026-09-01`, { headers: { authorization: `Bearer ${k}` } }).then((r) => r.status);
  for (let i = 0; i < REFUSED_PER_WINDOW; i += 1) assert.equal(await at('nope'), 401);
  assert.equal(await at(KEY), 429);
  clock += 15 * 60_000;
  assert.equal(await at(KEY), 200);
  await new Promise((r) => s.close(r));
});

test('the door is 404 when no key file is named, and a named file must be absolute', async () => {
  assert.deepEqual(readPlatformAdminSettings({}), { on: false });
  assert.throws(() => readPlatformAdminSettings({ PLATFORM_ADMIN_KEY_FILE: 'key.txt' }), /absolute/);
  const off = express().use(createPlatformAdminRouter({ settings: { on: false } }));
  const s = off.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${s.address().port}/summary?from=2026-09-01&to=2026-09-01`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(res.status, 404);
  await new Promise((r) => s.close(r));
});

test('the read leaves the caller\'s tenant as it found it, and the body is the owner\'s alone', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('openparking.tenant_id', $1, true)", [empty]);
    await c.query("SELECT * FROM platform_admin_summary('2026-09-01', '2026-09-01')");
    assert.equal((await c.query("SELECT current_setting('openparking.tenant_id', true) AS t")).rows[0].t, empty);
    assert.equal((await c.query("SELECT current_setting('openparking.definer_lookup', true) AS t")).rows[0].t, '');
    await c.query('ROLLBACK');
    await assert.rejects(c.query("SELECT * FROM platform_admin_summary_body('2026-09-01', '2026-09-01')"), (err) => err.code === '42501');
  } finally {
    c.release();
  }
});

test('the read changes nothing', async () => {
  const su = superuserClient();
  await su.connect();
  try {
    const count = async () => (await su.query('SELECT (SELECT count(*) FROM sessions) + (SELECT count(*) FROM garages) + (SELECT count(*) FROM lanes) + (SELECT count(*) FROM tenants) AS n')).rows[0].n;
    const before = await count();
    await get('/summary?from=2026-09-01&to=2026-09-03');
    assert.equal(await count(), before);
  } finally {
    await su.end();
  }
});

test('a day is a real date only', () => {
  assert.equal(dayOf('2026-02-28'), '2026-02-28');
  assert.equal(dayOf('2026-02-29'), null);
  assert.equal(dayOf(['2026-02-28']), null);
});
