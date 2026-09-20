/**
 * The appearance descriptor on a session close: STORED, ECHOED, BOUNDED, on the
 * close and no other channel, and reached by retention.
 *
 * The other end of `entry-descriptor.test.js`. The exit reaches this platform
 * on two channels that arrive in no specified order -- the sessions sync and
 * the events ingest -- and the shadow search (a later round) snapshots the open
 * stays INSIDE the close transaction, before `exit_at` is written. So the
 * descriptor it compares has to be in the close call itself; on the events
 * channel it could land after the stay was already closed. This file asserts
 * that the close carries it, echoes it, and that a stay that has not exited
 * cannot hold one.
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

const plate = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
const descriptor = (tag) => `opvid-fp/1:${Buffer.from(`${tag}-${randomUUID()}`).toString('base64url')}`;

const openEntry = (body) => fetch(`${base}/api/v1/lane/sessions/open`, post(entryToken, body));
const closeExit = (body) => fetch(`${base}/api/v1/lane/sessions/close`, post(exitToken, body));

async function openStay(p, entryDescriptor = null) {
  const res = await openEntry({
    plate: p,
    entry_at: '2026-08-26T09:00:00Z',
    entry_confirmation: 'confirmed',
    ...(entryDescriptor ? { descriptor: entryDescriptor } : {}),
  });
  assert.equal(res.status, 201);
  return (await res.json()).session.id;
}

const stored = (sessionId) =>
  withTenant(tenant, async (c) =>
    (await c.query('SELECT exit_at, entry_descriptor, exit_descriptor FROM sessions WHERE id = $1', [sessionId]))
      .rows[0],
  );

before(async () => {
  tenant = await createTenant('exit-descriptor');
  world = await buildWorld(tenant, { hourlyMinor: 250 });
  entryToken = await issueDeviceToken(tenant, world.entryLane, 'entry device');
  exitToken = await issueDeviceToken(tenant, world.exitLane, 'exit device');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

// --- stored and echoed -----------------------------------------------------

test('a descriptor on the close is stored on the session and ECHOED on the response', async () => {
  const p = plate('XECHO');
  const id = await openStay(p);
  const d = descriptor('XECHO');
  const res = await closeExit({
    plate: p,
    exit_at: '2026-08-26T11:00:00Z',
    exit_confirmation: 'confirmed',
    descriptor: d,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.closed, true);
  assert.equal(body.session.exit_descriptor, d, 'the response must carry the descriptor the lane sent');
  const row = await stored(id);
  assert.equal(row.exit_descriptor, d);
  assert.ok(row.exit_at);
  assert.equal(row.entry_descriptor, null, 'the entry end is untouched by the exit');
});

test('the two ends are two columns: an entry descriptor and an exit descriptor on one stay', async () => {
  const p = plate('BOTH');
  const din = descriptor('IN');
  const dout = descriptor('OUT');
  const id = await openStay(p, din);
  const res = await closeExit({
    plate: p,
    exit_at: '2026-08-26T11:00:00Z',
    exit_confirmation: 'confirmed',
    descriptor: dout,
  });
  assert.equal(res.status, 200);
  const session = (await res.json()).session;
  assert.equal(session.entry_descriptor, din);
  assert.equal(session.exit_descriptor, dout);
  const row = await stored(id);
  assert.equal(row.entry_descriptor, din);
  assert.equal(row.exit_descriptor, dout);
});

test('a close with no descriptor is unchanged: 200, and the column stays null', async () => {
  const p = plate('XNONE');
  const id = await openStay(p);
  const res = await closeExit({ plate: p, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).session.exit_descriptor, null);
  assert.equal((await stored(id)).exit_descriptor, null);
});

test('a replayed close echoes the descriptor the FIRST close stored', async () => {
  const p = plate('XREPLAY');
  await openStay(p);
  const d = descriptor('XREPLAY');
  const body = {
    event_id: randomUUID(),
    plate: p,
    exit_at: '2026-08-26T11:00:00Z',
    exit_confirmation: 'confirmed',
    descriptor: d,
  };
  const first = await closeExit(body);
  assert.equal(first.status, 200);
  const again = await closeExit(body);
  assert.equal(again.status, 200);
  const replayed = await again.json();
  assert.equal(replayed.replay, true);
  assert.equal(replayed.session.exit_descriptor, d);
});

// --- what the route refuses ------------------------------------------------

test('a bad descriptor on the close is refused, and the stay stays OPEN', async () => {
  // Judged beside the identity, before the transaction: a refusal must not
  // half-close the stay. The car is still inside on the record, which is the
  // truthful state for an exit this platform did not accept.
  const p = plate('XBAD');
  const id = await openStay(p);
  for (const bad of [42, ['opvid-fp/1:abc'], '', '   ', 'x'.repeat(65537)]) {
    const res = await closeExit({
      plate: p,
      exit_at: '2026-08-26T11:00:00Z',
      exit_confirmation: 'confirmed',
      descriptor: bad,
    });
    assert.equal(res.status, 400, `descriptor ${JSON.stringify(bad).slice(0, 40)} was accepted`);
    assert.match((await res.json()).error, /descriptor must be a string of at most 65536/);
  }
  const row = await stored(id);
  assert.equal(row.exit_at, null, 'a refused close must not close the stay');
  assert.equal(row.exit_descriptor, null);
  // THE CONTROL: the bound itself is accepted and closes the stay.
  const ok = await closeExit({
    plate: p,
    exit_at: '2026-08-26T11:00:00Z',
    exit_confirmation: 'confirmed',
    descriptor: 'x'.repeat(65536),
  });
  assert.equal(ok.status, 200);
});

// --- the constraint --------------------------------------------------------

test('a stay that has not exited cannot hold an exit descriptor — the constraint, not only the route', async () => {
  // A rule enforced only at a route is a rule one direct INSERT goes around.
  const p = plate('XCHECK');
  const id = await openStay(p);
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(`UPDATE sessions SET exit_descriptor = $2 WHERE id = $1`, [id, descriptor('XCHECK')]),
    ),
    (err) => err.code === '23514' && /sessions_exit_descriptor_needs_exit/.test(err.constraint ?? err.message),
    'an exit descriptor on an open stay must violate sessions_exit_descriptor_needs_exit',
  );
  // THE CONTROL: the same write once the stay has exited is accepted.
  await closeExit({ plate: p, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed' });
  await withTenant(tenant, (c) =>
    c.query(`UPDATE sessions SET exit_descriptor = $2 WHERE id = $1`, [id, descriptor('XCHECK2')]),
  );
  assert.ok((await stored(id)).exit_descriptor);
});

// --- retention -------------------------------------------------------------

test('retention nulls BOTH descriptors on the sessions of the vehicles it redacts, and no other', async () => {
  const DAY = 86_400_000;
  const ago = (days) => new Date(Date.now() - days * DAY);

  async function closedStay(prefix, closedDaysAgo) {
    const din = descriptor(`${prefix}-IN`);
    const dout = descriptor(`${prefix}-OUT`);
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
                                 entry_confirmation, exit_confirmation,
                                 entry_descriptor, exit_descriptor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',250,250,$8,$9,'confirmed','confirmed',$10,$11)
           RETURNING id`,
          [
            tenant, world.garage, v, world.entryLane, world.exitLane,
            ago(closedDaysAgo + 1), ago(closedDaysAgo), randomUUID(), randomUUID(), din, dout,
          ],
        )
      ).rows[0].id;
      return { session: s, din, dout };
    });
  }

  const old = await closedStay('XOLD', 40);
  const recent = await closedStay('XRECENT', 3);

  const result = await redactExpiredVehicles(tenant);
  assert.ok(result.redacted >= 1);

  const gone = await stored(old.session);
  assert.equal(gone.entry_descriptor, null);
  assert.equal(gone.exit_descriptor, null, 'the exit descriptor is redacted with the entry one');
  // THE CONTROL, in the same run.
  const kept = await stored(recent.session);
  assert.equal(kept.entry_descriptor, recent.din);
  assert.equal(kept.exit_descriptor, recent.dout);
});
