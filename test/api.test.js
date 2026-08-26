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
  // Every session call carries an event id, exactly as a lane sends it. Tests
  // that want to exercise a REPLAY pass the same one twice, deliberately.
  body: JSON.stringify({ event_id: randomUUID(), ...body }),
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

test('a car drives in, and the same entry replayed does not open two sessions', async () => {
  const plate = `IN-${randomUUID().slice(0, 8)}`;
  const entryAt = new Date('2026-08-26T09:00:00Z').toISOString();
  const eventId = randomUUID();

  const first = await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_at: entryAt, event_id: eventId }),
  );
  assert.equal(first.status, 201);
  const opened = (await first.json()).session;
  assert.equal(opened.exit_at, null);

  const replay = await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_at: entryAt, event_id: eventId }),
  );
  assert.equal(replay.status, 200, 'a replayed entry is not a new session');
  const body = await replay.json();
  assert.equal(body.created, false);
  assert.equal(body.session.id, opened.id);
});

test('an entry replayed AFTER the car has already left does not open a phantom', async () => {
  // The one that state-based idempotency gets wrong, and the reason sessions
  // are keyed on the lane's event id. The entry lane's acknowledgement was
  // lost, the exit lane -- a different controller with its own queue -- closed
  // the session, and only then does the entry lane reconnect and re-send.
  const plate = `PHANTOM-${randomUUID().slice(0, 8)}`;
  const entryEvent = randomUUID();

  const opened = (
    await (
      await fetch(
        `${base}/api/v1/lane/sessions/open`,
        asDevice(entryToken, { plate, entry_at: '2026-08-26T09:00:00Z', event_id: entryEvent }),
      )
    ).json()
  ).session;

  await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_at: '2026-08-26T11:00:00Z' }),
  );

  const replay = await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_at: '2026-08-26T09:00:00Z', event_id: entryEvent }),
  );
  assert.equal(replay.status, 200, 'a replayed entry must never be treated as a new arrival');
  const body = await replay.json();
  assert.equal(body.created, false);
  assert.equal(body.session.id, opened.id, 'the replay must resolve to the session it originally opened');
  assert.ok(body.session.exit_at, 'and that session is the closed one, not a fresh open');

  const open = await withTenant(tenant, async (c) =>
    (
      await c.query(
        'SELECT count(*)::int AS n FROM sessions WHERE garage_id = $1 AND vehicle_id = (SELECT id FROM vehicles WHERE plate = $2) AND exit_at IS NULL',
        [world.garage, plate],
      )
    ).rows[0].n,
  );
  assert.equal(open, 0, 'no phantom open session may be left behind');
});

test('a stale exit from an earlier visit is refused terminally, not with a 500', async () => {
  // A 500 is classified retryable by the lane, so it would be re-sent forever
  // and jam every item behind it in the outbox. This has to be a 4xx the lane
  // can dead-letter.
  const plate = `STALE-${randomUUID().slice(0, 8)}`;

  await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_at: '2026-08-26T09:00:00Z' }),
  );
  await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_at: '2026-08-26T11:00:00Z' }),
  );
  // second visit, the next day
  await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_at: '2026-08-27T09:00:00Z' }),
  );

  // the exit lane's queue finally drains and delivers visit one's close
  const stale = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_at: '2026-08-26T11:00:00Z' }),
  );

  assert.equal(stale.status, 409, 'must be terminal, so the lane stops retrying it');
  assert.ok(stale.status < 500, 'a 5xx here would be retried forever');
  assert.match((await stale.json()).error, /stale exit/i);
});

test('a session call without an event_id is refused', async () => {
  const res = await fetch(`${base}/api/v1/lane/sessions/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${entryToken}` },
    body: JSON.stringify({ plate: 'NOKEY-1', entry_at: new Date().toISOString() }),
  });
  assert.equal(res.status, 400, 'with no key there is nothing to be idempotent on');
});

test('a car drives out and the fee is computed, frozen, and idempotent on replay', async () => {
  const plate = `OUT-${randomUUID().slice(0, 8)}`;
  await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_at: '2026-08-26T09:00:00Z' }),
  );

  const closeEvent = randomUUID();
  const res = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_at: '2026-08-26T12:30:00Z', event_id: closeEvent }),
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
    asDevice(exitToken, { plate, exit_at: '2026-08-26T12:30:00Z', event_id: closeEvent }),
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
