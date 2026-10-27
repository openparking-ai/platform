/**
 * A car whose plate nobody could read is a stay too (0036).
 *
 * The owner's rule: every car that crosses a lane's activation loop and then its
 * closing loop is a stay, whatever opened the barrier, and "unreadable" is part
 * of the car's identity, not a failure to have one. A stay used to need a plate
 * a camera read or a ticket a person asserted, so the lane had no identity to
 * open one on for a car it could not read: inside the garage, in no money
 * record, and not in the count of cars inside.
 *
 * What this file measures, and each of them has a break in
 * `scripts/unread-identity-fail-control.js`:
 *
 *   * `plate_unreadable: true` opens a stay, on an entry's open, and the stay's
 *     vehicle carries no plate and no ticket;
 *   * it is alone or refused: beside a plate, beside a ticket, or as anything
 *     but `true`;
 *   * two unread cars are two vehicles and two stays, never one, and a replay
 *     of the open is the same stay;
 *   * the database holds the same rule -- exactly one of the three, none empty,
 *     one stay per unread key -- not only the route;
 *   * the stay counts: in the count of cars inside a later car is priced on
 *     (0034), and in the open stays the lane is sent;
 *   * the purge redacts its key as it redacts a plate, and the candidate set
 *     names it `unread`;
 *   * nothing else changes: the close and the exit's lookup still take a plate
 *     or a ticket, and a request with neither is refused as before.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { candidateStays } from '../src/candidates.js';
import { redactExpiredVehicles } from '../src/retention.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';

let engine;
let server;
let base;
let tenant;
let world;
let entryToken;
let exitToken;

async function issueDeviceToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [
      tenantId,
      laneId,
      name,
      hashToken(token),
    ]),
  );
  return token;
}

const post = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ event_id: randomUUID(), ...body }),
});

const openStay = (body) => fetch(`${base}/api/v1/lane/sessions/open`, post(entryToken, body));
const closeStay = (body) => fetch(`${base}/api/v1/lane/sessions/close`, post(exitToken, body));
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
const plate = () => `UR${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;

/** What a lane sends for a car through the gate that nobody could read. */
const unread = (extra = {}) => ({
  plate_unreadable: true,
  entry_at: minutesAgo(30),
  entry_confirmation: 'confirmed',
  tailgater: true,
  ...extra,
});

const vehicleOf = (sessionId) =>
  withTenant(tenant, async (c) =>
    (
      await c.query(
        `SELECT v.id, v.plate, v.ticket_ref, v.unread_ref FROM vehicles v
           JOIN sessions s ON s.vehicle_id = v.id WHERE s.id = $1`,
        [sessionId],
      )
    ).rows[0],
  );

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('unread');
  world = await buildWorld(tenant, { hourlyMinor: 250 });
  entryToken = await issueDeviceToken(tenant, world.entryLane, 'entry device');
  exitToken = await issueDeviceToken(tenant, world.exitLane, 'exit device');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

// --- the stay opens --------------------------------------------------------

test('a car nobody could read opens a stay, and its vehicle carries no plate and no ticket', async () => {
  const res = await openStay(unread());
  assert.equal(res.status, 201);
  const { session } = await res.json();
  assert.equal(session.entry_confirmation, 'confirmed', 'the loops saw it: echoed as sent');
  assert.equal(session.tailgater, true, 'no open command let it in');
  assert.equal(session.exit_at, null, 'it is inside');
  const vehicle = await vehicleOf(session.id);
  assert.equal(vehicle.plate, null, 'no plate is invented for it');
  assert.equal(vehicle.ticket_ref, null, 'nor a ticket');
  assert.equal(vehicle.unread_ref, session.open_event_id, 'keyed on its own open');
});

test('two unread cars are two vehicles and two stays, and a replay is the same stay', async () => {
  const first = await (await openStay(unread())).json();
  const second = await (await openStay(unread())).json();
  assert.notEqual(first.session.id, second.session.id, 'folded into one stay');
  assert.notEqual(first.session.vehicle_id, second.session.vehicle_id, 'folded into one car');
  assert.equal(first.created, true);
  assert.equal(second.created, true);

  // The lane re-sends what it could not confirm, with the same event id.
  const eventId = randomUUID();
  const once = await openStay(unread({ event_id: eventId }));
  const again = await openStay(unread({ event_id: eventId }));
  assert.equal(once.status, 201);
  assert.equal(again.status, 200, 'a replay is not a second car');
  assert.equal((await once.json()).session.id, (await again.json()).session.id);
  const rows = await withTenant(tenant, async (c) =>
    (await c.query('SELECT count(*)::int AS n FROM vehicles WHERE unread_ref = $1', [eventId])).rows[0].n,
  );
  assert.equal(rows, 1, 'the replay made no second vehicle');
});

// --- alone, or refused -----------------------------------------------------

test('plate_unreadable beside a plate or a ticket, or as anything but true, is refused', async () => {
  for (const [extra, why] of [
    [{ plate: plate() }, 'beside a plate'],
    [{ ticket_ref: 'TKT-UNREAD01' }, 'beside a ticket'],
    [{ plate: '' }, 'beside an empty plate'],
  ]) {
    const res = await openStay(unread(extra));
    assert.equal(res.status, 400, why);
    assert.match((await res.json()).error, /identity of its own/, why);
  }
  for (const value of [false, 'true', 1, 'yes']) {
    const res = await openStay(unread({ plate_unreadable: value }));
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.match((await res.json()).error, /plate_unreadable must be true/);
  }
  // THE CONTROL: the same body with `true` alone opens, so the refusals above
  // are the rule and not a route that refuses the field.
  assert.equal((await openStay(unread())).status, 201);
});

test('the close and the exit lookup take a plate or a ticket, as before', async () => {
  const res = await closeStay({
    plate_unreadable: true,
    exit_at: minutesAgo(1),
    exit_confirmation: 'confirmed',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /exactly one of plate or ticket_ref .*neither/);
  const lookup = await fetch(`${base}/api/v1/lane/sessions/open?plate_unreadable=true`, {
    headers: { authorization: `Bearer ${exitToken}` },
  });
  assert.equal(lookup.status, 400);
});

// --- the database holds it too ---------------------------------------------

test('the database refuses an unread key beside a plate or a ticket, empty, or twice', async () => {
  const insert = (columns, values) =>
    withTenant(tenant, (c) =>
      c.query(
        `INSERT INTO vehicles (tenant_id, ${columns.join(', ')})
         VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})`,
        [tenant, ...values],
      ),
    );
  const key = randomUUID();
  for (const [columns, values, why] of [
    [['plate', 'unread_ref'], [plate(), randomUUID()], 'a plate and an unread key'],
    [['ticket_ref', 'unread_ref'], ['TKT-UNREAD02', randomUUID()], 'a ticket and an unread key'],
    [['unread_ref'], [''], 'an empty unread key'],
  ]) {
    await assert.rejects(insert(columns, values), (err) => err.code === '23514', why);
  }
  // THE CONTROL: the key alone is a vehicle; the same key twice is not two.
  await insert(['unread_ref'], [key]);
  await assert.rejects(insert(['unread_ref'], [key]), (err) => err.code === '23505');
});

// --- it counts --------------------------------------------------------------

test('an unread stay counts among the cars inside, for the next car and for the lane', async () => {
  const counted = await createTenant('unread-count');
  const garage = await buildWorld(counted, { hourlyMinor: 250 });
  const entry = await issueDeviceToken(counted, garage.entryLane, 'entry device');
  await withTenant(counted, (c) =>
    c.query('UPDATE garages SET spaces = 4 WHERE tenant_id = $1 AND id = $2', [counted, garage.garage]),
  );
  const open = async (body) =>
    (await (await fetch(`${base}/api/v1/lane/sessions/open`, post(entry, body))).json()).session;
  const first = await open(unread());
  const second = await open({ plate: plate(), entry_at: minutesAgo(10), entry_confirmation: 'confirmed' });
  assert.equal(first.occupancy_at_entry_bp, 0);
  assert.equal(second.occupancy_at_entry_bp, 2500, 'the unread car was not counted inside');

  const stays = await (
    await fetch(`${base}/api/v1/lane/stays`, { headers: { authorization: `Bearer ${entry}` } })
  ).json();
  const ours = stays.open.find((s) => s.session_id === first.id);
  assert.ok(ours, 'the lane is not sent the unread stay, so it does not count it');
  assert.equal(ours.plate, null);
  assert.equal(ours.ticket_ref, null);
});

test('the candidate set names an unread stay `unread`, never `plate`', async () => {
  const { session } = await (await openStay(unread({ descriptor: 'opvid-opa-id/2:unread' }))).json();
  const candidates = await withTenant(tenant, (c) => candidateStays(c, tenant, world.garage));
  const ours = candidates.candidates.find((s) => s.id === session.id);
  assert.equal(ours.identity_kind, 'unread');
  assert.equal(ours.plate, null);
  // THE CONTROL: a plate stay in the same set is `plate`.
  const read = await (await openStay({ plate: plate(), entry_at: minutesAgo(5), entry_confirmation: 'confirmed' })).json();
  const again = await withTenant(tenant, (c) => candidateStays(c, tenant, world.garage));
  assert.equal(again.candidates.find((s) => s.id === read.session.id).identity_kind, 'plate');
});

// --- the purge -----------------------------------------------------------------

test('the purge redacts an unread key as it redacts a plate, and the row keeps its shape', async () => {
  const DAY = 86_400_000;
  const ago = (days) => new Date(Date.now() - days * DAY);
  const key = randomUUID();
  const id = await withTenant(tenant, async (c) => {
    const v = (
      await c.query(
        `INSERT INTO vehicles (tenant_id, unread_ref, color, last_seen_at) VALUES ($1,$2,'grey',$3) RETURNING id`,
        [tenant, key, ago(400)],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, exit_lane_id,
                             entry_at, exit_at, currency, fee_minor, hourly_minor_applied,
                             open_event_id, close_event_id,
                             entry_confirmation, exit_confirmation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',250,250,$8,$9,'confirmed','confirmed')`,
      [tenant, world.garage, v, world.entryLane, world.exitLane, ago(401), ago(400), key, randomUUID()],
    );
    return v;
  });
  await redactExpiredVehicles(tenant);
  const row = await withTenant(tenant, async (c) =>
    (await c.query('SELECT plate, ticket_ref, unread_ref, color, redacted_at FROM vehicles WHERE id = $1', [id])).rows[0],
  );
  assert.match(row.unread_ref, /^redacted:/, 'the key of the stay is replaced');
  assert.equal(row.plate, null, 'the purge gives an unread car no plate');
  assert.equal(row.ticket_ref, null);
  assert.equal(row.color, null);
  assert.ok(row.redacted_at);
});
