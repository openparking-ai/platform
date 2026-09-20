/**
 * The appearance descriptor on a session open: STORED, ECHOED, BOUNDED, and
 * reached by retention.
 *
 * The exit module matches an exiting car to a STAY by comparing one descriptor
 * against the descriptors of every open stay in the garage. This is the entry
 * half: a lane whose identity service produced one sends it on the open, and
 * the platform holds it on the session (migration 0009).
 *
 * THE ECHO IS THE PROPERTY, and silence is the failure mode. This route
 * destructures the keys it knows and ignores the rest, so a platform older than
 * the column answers exactly as successfully -- 201, session, no descriptor --
 * and nothing reports that the field was dropped. The lane treats an open whose
 * response does not carry the descriptor it sent as not delivered, exactly as
 * it does for `entry_confirmation`; that only works if THIS side echoes it, so
 * the echo is asserted here rather than assumed.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { redactExpiredVehicles } from '../src/retention.js';

let server;
let base;
let tenant;
let world;
let entryToken;

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

const plate = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

// The shape the identity service produces: a versioned prefix and an opaque
// base64url payload. This platform does not parse it, and nothing here depends
// on the payload meaning anything.
const descriptor = (tag) => `opvid-fp/1:${Buffer.from(`${tag}-${randomUUID()}`).toString('base64url')}`;

const openEntry = (body) => fetch(`${base}/api/v1/lane/sessions/open`, post(entryToken, body));

const stored = (sessionId) =>
  withTenant(tenant, async (c) =>
    (await c.query('SELECT entry_descriptor FROM sessions WHERE id = $1', [sessionId])).rows[0]
      .entry_descriptor,
  );

before(async () => {
  tenant = await createTenant('descriptor');
  world = await buildWorld(tenant, { hourlyMinor: 250 });
  entryToken = await issueDeviceToken(tenant, world.entryLane, 'entry device');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

// --- stored and echoed -----------------------------------------------------

test('a descriptor on the open is stored on the session and ECHOED on the response', async () => {
  const d = descriptor('ECHO');
  const res = await openEntry({
    plate: plate('ECHO'),
    entry_at: new Date().toISOString(),
    entry_confirmation: 'confirmed',
    descriptor: d,
  });
  assert.equal(res.status, 201);
  const { session } = await res.json();
  // THE ECHO. Asserted on the response, because the lane reads it there and
  // nowhere else: a platform that stored it and did not echo it would be
  // indistinguishable, to the lane, from one that dropped it.
  assert.equal(session.entry_descriptor, d, 'the response must carry the descriptor the lane sent');
  // AND THE DISK. A route that echoed the request back without writing it would
  // satisfy the lane and hold nothing for the exit to search.
  assert.equal(await stored(session.id), d);
});

test('an open with no descriptor is unchanged: 201, and the column is null (NOT MEASURED)', async () => {
  // The default. The identity service produces a descriptor only when the
  // deployment asks for one, so most lanes send none, and every row written
  // before migration 0009 has none. Null is the honest value: nothing measured.
  const res = await openEntry({
    plate: plate('NONE'),
    entry_at: new Date().toISOString(),
    entry_confirmation: 'confirmed',
  });
  assert.equal(res.status, 201);
  const { session } = await res.json();
  assert.equal(session.entry_descriptor, null);
  assert.equal(await stored(session.id), null);

  // And an explicit null is the same statement, not a refusal.
  const nulled = await openEntry({
    plate: plate('NULL'),
    entry_at: new Date().toISOString(),
    entry_confirmation: 'confirmed',
    descriptor: null,
  });
  assert.equal(nulled.status, 201);
  assert.equal((await nulled.json()).session.entry_descriptor, null);
});

test('a replayed open echoes the descriptor the FIRST open stored', async () => {
  // Idempotent on event_id. The replay is the same event, so the same read;
  // what comes back is the row that exists, which is the contract for every
  // other field on it.
  const d = descriptor('REPLAY');
  const body = {
    event_id: randomUUID(),
    plate: plate('REPLAY'),
    entry_at: new Date().toISOString(),
    entry_confirmation: 'confirmed',
    descriptor: d,
  };
  const first = await openEntry(body);
  assert.equal(first.status, 201);
  const again = await openEntry(body);
  assert.equal(again.status, 200);
  const replayed = await again.json();
  assert.equal(replayed.created, false);
  assert.equal(replayed.session.entry_descriptor, d);
});

test('the lookup by identity carries the stored descriptor too', async () => {
  const d = descriptor('LOOKUP');
  const p = plate('LOOKUP');
  await openEntry({
    plate: p,
    entry_at: new Date().toISOString(),
    entry_confirmation: 'confirmed',
    descriptor: d,
  });
  const res = await fetch(`${base}/api/v1/lane/sessions/open?plate=${encodeURIComponent(p)}`, {
    headers: { authorization: `Bearer ${entryToken}` },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).session.entry_descriptor, d);
});

// --- what the route refuses ------------------------------------------------

test('a descriptor that is not a string, is blank, or is over the bound is refused', async () => {
  for (const bad of [42, true, ['opvid-fp/1:abc'], { v: 1 }, '', '   ', 'x'.repeat(65537)]) {
    const res = await openEntry({
      plate: plate('BAD'),
      entry_at: new Date().toISOString(),
      entry_confirmation: 'confirmed',
      descriptor: bad,
    });
    assert.equal(res.status, 400, `descriptor ${JSON.stringify(bad).slice(0, 40)} was accepted`);
    assert.match((await res.json()).error, /descriptor must be a string of at most 65536/);
  }
  // THE CONTROL: exactly the bound is accepted, so the refusals above are the
  // rule and not the route.
  const res = await openEntry({
    plate: plate('BOUND'),
    entry_at: new Date().toISOString(),
    entry_confirmation: 'confirmed',
    descriptor: 'x'.repeat(65536),
  });
  assert.equal(res.status, 201);
});

test('a refused descriptor opens nothing: no session, no vehicle', async () => {
  // The descriptor is judged BEFORE the transaction, beside the identity. A
  // refusal that had already upserted the vehicle would leave a row for a stay
  // that never opened.
  const p = plate('NOROW');
  const res = await openEntry({
    plate: p,
    entry_at: new Date().toISOString(),
    entry_confirmation: 'confirmed',
    descriptor: 7,
  });
  assert.equal(res.status, 400);
  const vehicles = await withTenant(tenant, async (c) =>
    (await c.query('SELECT 1 FROM vehicles WHERE plate = $1', [p])).rowCount,
  );
  assert.equal(vehicles, 0);
});

// --- retention -------------------------------------------------------------

test('retention nulls the descriptor on the sessions of the vehicles it redacts, and no other', async () => {
  const DAY = 86_400_000;
  const ago = (days) => new Date(Date.now() - days * DAY);

  // A descriptor is one specific car's appearance: personal data on the same
  // terms the plate is. It goes on the same window, in the same run.
  async function closedStay(prefix, closedDaysAgo) {
    const d = descriptor(prefix);
    return withTenant(tenant, async (c) => {
      const v = (
        await c.query(
          `INSERT INTO vehicles (tenant_id, plate, last_seen_at) VALUES ($1,$2,$3) RETURNING id`,
          [tenant, plate(prefix), ago(closedDaysAgo)],
        )
      ).rows[0].id;
      const s = (
        await c.query(
          `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, exit_lane_id,
                                 entry_at, exit_at, currency, fee_minor, hourly_minor_applied,
                                 open_event_id, close_event_id,
                                 entry_confirmation, exit_confirmation, entry_descriptor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',250,250,$8,$9,'confirmed','confirmed',$10)
           RETURNING id`,
          [
            tenant, world.garage, v, world.entryLane, world.exitLane,
            ago(closedDaysAgo + 1), ago(closedDaysAgo), randomUUID(), randomUUID(), d,
          ],
        )
      ).rows[0].id;
      return { vehicle: v, session: s, descriptor: d };
    });
  }

  const old = await closedStay('OLD', 40);
  const recent = await closedStay('RECENT', 3);

  const result = await redactExpiredVehicles(tenant);
  assert.ok(result.redacted >= 1);

  assert.equal(await stored(old.session), null, 'the redacted vehicle\'s descriptor is gone');
  // THE CONTROL, in the same run: a stay inside the window keeps its descriptor,
  // so the null above is retention reaching the column and not the column
  // being empty.
  assert.equal(await stored(recent.session), recent.descriptor);

  // And the session itself survives with its money, as every other redaction
  // test asserts: this is redaction, not deletion.
  const money = await withTenant(tenant, async (c) =>
    (await c.query('SELECT fee_minor, redacted_at FROM sessions s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.id = $1', [old.session])).rows[0],
  );
  assert.equal(Number(money.fee_minor), 250);
  assert.ok(money.redacted_at);
});
