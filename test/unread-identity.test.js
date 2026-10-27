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
 *     or a ticket, and a request with neither is refused as before;
 *   * `no_open_command` is its own field, and `tailgater` keeps its meaning: an
 *     unread car is never ban-listed, whatever its open says;
 *   * what was read below the lane's confidence is kept on the stay and is not
 *     an identity: no lookup finds it, the purge nulls it;
 *   * the open's `event_id` -- now an identity's key -- is a UUID or a 400.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { candidateStays } from '../src/candidates.js';
import { redactExpiredVehicles } from '../src/retention.js';
import * as bans from '../src/bans.js';
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
  no_open_command: true,
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
  assert.equal(session.no_open_command, true, 'no open command let it in');
  assert.equal(session.tailgater, false, 'and an unread car is never a tailgater');
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
  await withTenant(tenant, (c) =>
    c.query(`UPDATE sessions SET entry_unsure_plate = 'UR4X7', entry_unsure_plate_confidence = 0.4
              WHERE open_event_id = $1`, [key]),
  );
  await redactExpiredVehicles(tenant);
  const row = await withTenant(tenant, async (c) =>
    (await c.query('SELECT plate, ticket_ref, unread_ref, color, redacted_at FROM vehicles WHERE id = $1', [id])).rows[0],
  );
  const stay = await withTenant(tenant, async (c) =>
    (await c.query('SELECT entry_unsure_plate, entry_unsure_plate_confidence FROM sessions WHERE open_event_id = $1', [key])).rows[0],
  );
  assert.deepEqual(stay, { entry_unsure_plate: null, entry_unsure_plate_confidence: null },
    'what was read of the plate goes with the vehicle');
  assert.match(row.unread_ref, /^redacted:/, 'the key of the stay is replaced');
  assert.equal(row.plate, null, 'the purge gives an unread car no plate');
  assert.equal(row.ticket_ref, null);
  assert.equal(row.color, null);
  assert.ok(row.redacted_at);
});

// --- its own marker, and the ban list ---------------------------------------

test('no_open_command is its own field; tailgater keeps its meaning', async () => {
  const marked = await (await openStay(unread({ tailgater: false, no_open_command: true }))).json();
  assert.equal(marked.session.no_open_command, true);
  assert.equal(marked.session.tailgater, false, 'no_open_command does not make a tailgater');
  const plain = await (await openStay({ plate: plate(), entry_at: minutesAgo(3), entry_confirmation: 'confirmed' })).json();
  assert.equal(plain.session.no_open_command, false, 'the control: an ordinary open is not marked');
  const res = await openStay(unread({ no_open_command: 'yes' }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no_open_command must be true or false/);
});

test('a car nobody could read is never ban-listed, even marked a tailgater with a descriptor', async () => {
  // A monthly with a dirty plate, through a raised barrier, at a garage that
  // bans tailgaters: listed, it would be refused at every entry on a match
  // nobody can check against a plate.
  const banning = await createTenant('unread-ban');
  const g = await buildWorld(banning, { hourlyMinor: 250 });
  const entry = await issueDeviceToken(banning, g.entryLane, 'entry device');
  await withTenant(banning, (c) =>
    c.query('UPDATE garages SET ban_tailgaters = true WHERE tenant_id = $1 AND id = $2', [banning, g.garage]),
  );
  const open = async (body) =>
    (await (await fetch(`${base}/api/v1/lane/sessions/open`, post(entry, body))).json()).session;
  const listed = (sessionId) =>
    withTenant(banning, async (c) =>
      (await c.query('SELECT count(*)::int AS n FROM banned_vehicles WHERE session_id = $1', [sessionId])).rows[0].n,
    );
  const monthly = await open(unread({ tailgater: true, no_open_command: true, descriptor: 'opvid-opa-id/2:monthly' }));
  assert.equal(await listed(monthly.id), 0, 'an unread car was put on the banned list');
  const rules = await (
    await fetch(`${base}/api/v1/lane/rules`, { headers: { authorization: `Bearer ${entry}` } })
  ).json();
  assert.deepEqual(rules.banned, [], 'and no lane is sent it as banned');
  // THE CONTROL: the same open with a read plate is listed, so the refusal above
  // is the read-plate rule and not a garage that lists nobody.
  const read = await open({
    plate: plate(), entry_at: minutesAgo(5), entry_confirmation: 'confirmed', tailgater: true,
    descriptor: 'opvid-opa-id/2:read',
  });
  assert.equal(await listed(read.id), 1);

  // AND THE LISTING RULE ITSELF, apart from the route's normalising: a stay
  // marked a tailgater whose vehicle has no read plate -- a row written by
  // anything but this route -- is not listed either.
  const decided = await withTenant(banning, async (c) => {
    const vehicle = (await c.query(
      'INSERT INTO vehicles (tenant_id, unread_ref) VALUES ($1, $2) RETURNING id, plate', [banning, randomUUID()],
    )).rows[0];
    const session = (await c.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency,
                             open_event_id, entry_confirmation, entry_descriptor, tailgater)
       VALUES ($1, $2, $3, $4, now(), 'USD', $5, 'confirmed', 'opvid-opa-id/2:direct', true)
       RETURNING *`,
      [banning, g.garage, vehicle.id, g.entryLane, randomUUID()],
    )).rows[0];
    return bans.listIfBanned(c, banning, { garage: { ban_tailgaters: true }, session, vehicle });
  });
  assert.equal(decided, false, 'a tailgater stay with no read plate was listed');
});

// --- what was seen, kept and not an identity -------------------------------

test('what was read below the confidence is kept on the stay, and is not an identity', async () => {
  const unsure = plate();
  const res = await openStay(unread({ unsure_plate: unsure, unsure_plate_confidence: 0.42 }));
  assert.equal(res.status, 201);
  const { session } = await res.json();
  assert.equal(session.entry_unsure_plate, unsure);
  assert.equal(session.entry_unsure_plate_confidence, 0.42);
  assert.equal((await vehicleOf(session.id)).plate, null, 'it never becomes the plate');
  const lookup = await fetch(`${base}/api/v1/lane/sessions/open?plate=${unsure}`, {
    headers: { authorization: `Bearer ${exitToken}` },
  });
  assert.equal(lookup.status, 404, 'no lookup finds a stay by it');
  for (const [extra, pattern] of [
    [{ unsure_plate: unsure }, /unsure_plate_confidence/],
    [{ unsure_plate_confidence: 0.4 }, /unsure_plate must be/],
    [{ unsure_plate: unsure, unsure_plate_confidence: 1.5 }, /unsure_plate_confidence/],
    [{ unsure_plate: '   ', unsure_plate_confidence: 0.4 }, /unsure_plate must be/],
    [{ unsure_plate: 'P'.repeat(33), unsure_plate_confidence: 0.4 }, /unsure_plate must be/],
  ]) {
    const refused = await openStay(unread(extra));
    assert.equal(refused.status, 400, JSON.stringify(extra));
    assert.match((await refused.json()).error, pattern);
  }
  const beside = await openStay({
    plate: plate(), entry_at: minutesAgo(5), entry_confirmation: 'confirmed',
    unsure_plate: unsure, unsure_plate_confidence: 0.4,
  });
  assert.equal(beside.status, 400, 'a read plate has no unsure one');
  assert.match((await beside.json()).error, /only with plate_unreadable/);
});

// --- the open's event id -------------------------------------------------------

test('one event-id rule on the open, the close and the events: bounded, safe, and another lane\'s ids still work', async () => {
  const send = (route, token, body) =>
    fetch(`${base}/api/v1/lane/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const refusedIds = [{ id: randomUUID() }, ['x'], 42, `redacted:${randomUUID()}`, 'has space', 'x'.repeat(65), 'evt.1'];
  // A lane that is not ours mints its own ids, and they keep working.
  const theirs = `tp-${randomUUID().slice(0, 8)}`;
  const car = plate();
  const opened = await send('sessions/open', entryToken, {
    event_id: theirs, plate: car, entry_at: minutesAgo(40), entry_confirmation: 'confirmed',
  });
  assert.equal(opened.status, 201, await opened.clone().text());
  const closed = await send('sessions/close', exitToken, {
    event_id: `${theirs}_out`, plate: car, exit_at: minutesAgo(1), exit_confirmation: 'confirmed',
  });
  assert.equal(closed.status, 200, await closed.clone().text());
  const logged = await send('events', entryToken, {
    events: [{ event_id: 'tp-0001', kind: 'armed', occurred_at: minutesAgo(1), detail: {} }],
  });
  assert.equal(logged.status, 202, await logged.clone().text());
  assert.equal((await send('sessions/open', entryToken, { ...unread(), event_id: randomUUID() })).status, 201,
    'and our lane\'s UUIDs');

  for (const value of refusedIds) {
    const label = JSON.stringify(value).slice(0, 40);
    const open = await send('sessions/open', entryToken, { ...unread(), event_id: value });
    assert.equal(open.status, 400, `open ${label}`);
    assert.match((await open.json()).error, /event_id must be 1 to 64 characters/);
    const close = await send('sessions/close', exitToken, {
      event_id: value, plate: plate(), exit_at: minutesAgo(1), exit_confirmation: 'confirmed',
    });
    assert.equal(close.status, 400, `close ${label}`);
    assert.match((await close.json()).error, /event_id must be 1 to 64 characters/);
    const events = await send('events', entryToken, {
      events: [{ event_id: value, kind: 'armed', occurred_at: minutesAgo(1), detail: {} }],
    });
    assert.equal(events.status, 400, `events ${label}`);
    assert.match((await events.json()).error, /event_id must be 1 to 64 characters/);
  }
});

test('an unread open that says it is a tailgater is stored as not one, and still opens', async () => {
  const res = await openStay(unread({ tailgater: true, no_open_command: true }));
  assert.equal(res.status, 201, 'the stay is never refused over it');
  const { session } = await res.json();
  assert.equal(session.tailgater, false, 'an unread car is never a tailgater, in the data');
  assert.equal(session.no_open_command, true);
  // THE CONTROL: a read car that says so is one.
  const read = await (await openStay({
    plate: plate(), entry_at: minutesAgo(3), entry_confirmation: 'confirmed', tailgater: true,
  })).json();
  assert.equal(read.session.tailgater, true);
});
