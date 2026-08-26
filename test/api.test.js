import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';

let server;
let base;
let tenant;
let world;
let entryToken;
let exitToken;

async function issueToken(tenantId, laneId, name) {
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

const asDevice = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

before(async () => {
  tenant = await createTenant('api');
  world = await buildWorld(tenant, { hourlyMinor: 250 });
  entryToken = await issueToken(tenant, world.entryLane, 'entry device');
  exitToken = await issueToken(tenant, world.exitLane, 'exit device');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

// --- authentication -------------------------------------------------------

test('healthz needs nothing', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('a lane call with no token is refused BY THE LANE ROUTER', async () => {
  const res = await fetch(`${base}/api/v1/lane/rules`);
  assert.equal(res.status, 401);
  // The message, not just the status. '/api/v1' is a prefix of '/api/v1/lane',
  // so if the operator router is mounted first it also answers 401 here -- and
  // every authenticated lane call then fails for a reason nothing reports.
  assert.deepEqual(await res.json(), { error: 'device token required' });
});

test('a lane call with an unknown token is refused', async () => {
  const res = await fetch(`${base}/api/v1/lane/rules`, {
    headers: { authorization: `Bearer ${generateDeviceToken()}` },
  });
  assert.equal(res.status, 401);
});

test('a device resolves to its own tenant, lane and direction', async () => {
  const res = await fetch(`${base}/api/v1/lane/rules`, {
    headers: { authorization: `Bearer ${entryToken}` },
  });
  assert.equal(res.status, 200);
  const rules = await res.json();
  assert.equal(rules.garage_id, world.garage);
  assert.equal(rules.direction, 'entry');
  assert.equal(rules.hourly_minor, 250, 'money must arrive as a number, not a string');
  assert.equal(rules.currency, 'USD');
});

// --- events ---------------------------------------------------------------

test('events are appended, and a replayed batch adds nothing', async () => {
  const events = [
    { event_id: randomUUID(), kind: 'vehicle_identified', occurred_at: new Date().toISOString() },
    { event_id: randomUUID(), kind: 'vended', occurred_at: new Date().toISOString() },
  ];
  const first = await fetch(`${base}/api/v1/lane/events`, asDevice(entryToken, { events }));
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { accepted: 2, duplicates: 0 });

  // This is what a lane does after being offline: it re-sends what it could
  // not confirm. The duplicates must land nowhere.
  const replay = await fetch(`${base}/api/v1/lane/events`, asDevice(entryToken, { events }));
  assert.deepEqual(await replay.json(), { accepted: 0, duplicates: 2 });
});

test('an event without an event_id is refused, because it could not be deduplicated', async () => {
  const res = await fetch(
    `${base}/api/v1/lane/events`,
    asDevice(entryToken, { events: [{ kind: 'vended', occurred_at: new Date().toISOString() }] }),
  );
  assert.equal(res.status, 400);
});

// --- sessions -------------------------------------------------------------

test('a car drives in, and driving in twice does not open two sessions', async () => {
  const plate = `IN-${randomUUID().slice(0, 8)}`;
  const entryAt = new Date('2026-08-26T09:00:00Z').toISOString();

  const first = await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(entryToken, { plate, entry_at: entryAt }));
  assert.equal(first.status, 201);
  const opened = (await first.json()).session;
  assert.equal(opened.exit_at, null);

  const replay = await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(entryToken, { plate, entry_at: entryAt }));
  assert.equal(replay.status, 200, 'a replayed entry is not a new session');
  const body = await replay.json();
  assert.equal(body.created, false);
  assert.equal(body.session.id, opened.id);
});

test('a car drives out and the fee is computed, frozen, and idempotent on replay', async () => {
  const plate = `OUT-${randomUUID().slice(0, 8)}`;
  await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_at: '2026-08-26T09:00:00Z' }),
  );

  const res = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_at: '2026-08-26T12:30:00Z' }),
  );
  assert.equal(res.status, 200);
  const { session, closed } = await res.json();
  assert.equal(closed, true);
  // 3h30m at 250 minor/hour, part hours rounded up => 4 hours => 1000.
  assert.equal(session.fee_minor, 1000);
  assert.equal(session.hourly_minor_applied, 250);
  assert.equal(session.currency, 'USD');
  assert.ok(session.rate_id, 'the rate that produced the fee is recorded on the session');

  const replay = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_at: '2026-08-26T12:30:00Z' }),
  );
  const replayBody = await replay.json();
  assert.equal(replayBody.replay, true);
  assert.equal(replayBody.session.id, session.id);
  assert.equal(replayBody.session.fee_minor, 1000, 'a replayed exit must not re-charge or re-compute');
});

test('the fee survives the rate being changed afterwards', async () => {
  const plate = `FROZEN-${randomUUID().slice(0, 8)}`;
  await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(entryToken, { plate, entry_at: '2026-08-26T09:00:00Z' }));
  const closed = (
    await (
      await fetch(`${base}/api/v1/lane/sessions/close`, asDevice(exitToken, { plate, exit_at: '2026-08-26T10:00:00Z' }))
    ).json()
  ).session;
  assert.equal(closed.fee_minor, 250);

  // Somebody edits pricing. History must not move.
  await withTenant(tenant, (c) =>
    c.query(`INSERT INTO rates (tenant_id, garage_id, name, hourly_minor) VALUES ($1,$2,'New',9900)`, [
      tenant,
      world.garage,
    ]),
  );
  const after = await withTenant(tenant, async (c) =>
    (await c.query('SELECT fee_minor FROM sessions WHERE id = $1', [closed.id])).rows[0],
  );
  assert.equal(Number(after.fee_minor), 250, 'a closed session must not be repriced by a later rate change');
});

test('a device may only do the job of the lane it is on', async () => {
  const plate = `DIR-${randomUUID().slice(0, 8)}`;
  const wrongOpen = await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(exitToken, { plate, entry_at: new Date().toISOString() }),
  );
  assert.equal(wrongOpen.status, 409);

  const wrongClose = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(entryToken, { plate, exit_at: new Date().toISOString() }),
  );
  assert.equal(wrongClose.status, 409);
});

test('closing a vehicle that never entered is a 404, not a phantom session', async () => {
  const res = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate: `GHOST-${randomUUID().slice(0, 8)}`, exit_at: new Date().toISOString() }),
  );
  assert.equal(res.status, 404);
});

// --- operator surface -----------------------------------------------------

test('open sessions and the inside-count are readable per garage', async () => {
  const plate = `INSIDE-${randomUUID().slice(0, 8)}`;
  await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(entryToken, { plate, entry_at: new Date().toISOString() }));

  const res = await fetch(`${base}/api/v1/garages/${world.garage}/sessions/open`, {
    headers: { 'x-tenant-id': tenant },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.inside_count, body.sessions.length);
  assert.ok(body.sessions.some((s) => s.plate === plate));
});

test("another tenant sees nothing of this garage's sessions", async () => {
  const other = await createTenant('nosy');
  const res = await fetch(`${base}/api/v1/garages/${world.garage}/sessions/open`, {
    headers: { 'x-tenant-id': other },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { inside_count: 0, sessions: [] });
});

test('a device token is returned exactly once, and only its hash is stored', async () => {
  const res = await fetch(`${base}/api/v1/lanes/${world.entryLane}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenant },
    body: JSON.stringify({ name: 'issued in a test' }),
  });
  assert.equal(res.status, 201);
  const { token, device } = await res.json();
  assert.match(token, /^opl_/);
  assert.equal(device.token_hash, undefined, 'the hash must not be handed back either');

  const stored = await withTenant(tenant, async (c) =>
    (await c.query('SELECT token_hash FROM lane_devices WHERE id = $1', [device.id])).rows[0],
  );
  assert.equal(stored.token_hash, hashToken(token));
  assert.notEqual(stored.token_hash, token);
});
