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
let operatorToken;

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

async function issueOperatorToken(tenantId) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [
      tenantId,
      hashToken(token),
    ]),
  );
  return token;
}

const asOperator = (token) => ({ headers: { authorization: `Bearer ${token}` } });

before(async () => {
  tenant = await createTenant('api');
  world = await buildWorld(tenant, { hourlyMinor: 250 });
  entryToken = await issueToken(tenant, world.entryLane, 'entry device');
  exitToken = await issueToken(tenant, world.exitLane, 'exit device');
  operatorToken = await issueOperatorToken(tenant);
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
    asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: entryAt, event_id: eventId }),
  );
  assert.equal(first.status, 201);
  const opened = (await first.json()).session;
  assert.equal(opened.exit_at, null);

  const replay = await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: entryAt, event_id: eventId }),
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
        asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:00:00Z', event_id: entryEvent }),
      )
    ).json()
  ).session;

  await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_confirmation: 'confirmed', exit_at: '2026-08-26T11:00:00Z' }),
  );

  const replay = await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:00:00Z', event_id: entryEvent }),
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
    asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:00:00Z' }),
  );
  await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_confirmation: 'confirmed', exit_at: '2026-08-26T11:00:00Z' }),
  );
  // second visit, the next day
  await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: '2026-08-27T09:00:00Z' }),
  );

  // the exit lane's queue finally drains and delivers visit one's close
  const stale = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_confirmation: 'confirmed', exit_at: '2026-08-26T11:00:00Z' }),
  );

  assert.equal(stale.status, 409, 'must be terminal, so the lane stops retrying it');
  assert.ok(stale.status < 500, 'a 5xx here would be retried forever');
  assert.match((await stale.json()).error, /stale exit/i);
});

test('a session call without an event_id is refused', async () => {
  const res = await fetch(`${base}/api/v1/lane/sessions/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${entryToken}` },
    body: JSON.stringify({ plate: 'NOKEY-1', entry_confirmation: 'confirmed', entry_at: new Date().toISOString() }),
  });
  assert.equal(res.status, 400, 'with no key there is nothing to be idempotent on');
});

test('a car drives out and the fee is computed, frozen, and idempotent on replay', async () => {
  const plate = `OUT-${randomUUID().slice(0, 8)}`;
  await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:00:00Z' }),
  );

  const closeEvent = randomUUID();
  const res = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_confirmation: 'confirmed', exit_at: '2026-08-26T12:30:00Z', event_id: closeEvent }),
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
    asDevice(exitToken, { plate, exit_confirmation: 'confirmed', exit_at: '2026-08-26T12:30:00Z', event_id: closeEvent }),
  );
  const replayBody = await replay.json();
  assert.equal(replayBody.replay, true);
  assert.equal(replayBody.session.id, session.id);
  assert.equal(replayBody.session.fee_minor, 1000, 'a replayed exit must not re-charge or re-compute');
});

test('the fee survives the rate being changed afterwards', async () => {
  const plate = `FROZEN-${randomUUID().slice(0, 8)}`;
  await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:00:00Z' }));
  const closed = (
    await (
      await fetch(`${base}/api/v1/lane/sessions/close`, asDevice(exitToken, { plate, exit_confirmation: 'confirmed', exit_at: '2026-08-26T10:00:00Z' }))
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
    asDevice(exitToken, { plate, entry_confirmation: 'confirmed', entry_at: new Date().toISOString() }),
  );
  assert.equal(wrongOpen.status, 409);

  const wrongClose = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(entryToken, { plate, exit_confirmation: 'confirmed', exit_at: new Date().toISOString() }),
  );
  assert.equal(wrongClose.status, 409);
});

test('closing a vehicle that never entered is a 404, not a phantom session', async () => {
  const res = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate: `GHOST-${randomUUID().slice(0, 8)}`, exit_confirmation: 'confirmed', exit_at: new Date().toISOString() }),
  );
  assert.equal(res.status, 404);
});

// --- operator surface -----------------------------------------------------

test('open sessions and the inside-count are readable per garage', async () => {
  const plate = `INSIDE-${randomUUID().slice(0, 8)}`;
  await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: new Date().toISOString() }));

  const res = await fetch(`${base}/api/v1/garages/${world.garage}/sessions/open`, asOperator(operatorToken));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.inside_count, body.sessions.length);
  assert.ok(body.sessions.some((s) => s.plate === plate));
});

test("another tenant's operator sees nothing of this garage's sessions", async () => {
  const other = await createTenant('nosy');
  const otherToken = await issueOperatorToken(other);
  const res = await fetch(`${base}/api/v1/garages/${world.garage}/sessions/open`, asOperator(otherToken));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    inside_count: 0,
    unconfirmable_count: 0,
    open_count: 0,
    sessions: [],
  });
});

test('the operator surface refuses an unauthenticated call', async () => {
  const res = await fetch(`${base}/api/v1/garages/${world.garage}/sessions/open`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'operator token required' });
});

test('an x-tenant-id header no longer grants anything', async () => {
  // This is the closed hole. Knowing a tenant id used to be enough to act as
  // that tenant, including minting lane credentials for it.
  const res = await fetch(`${base}/api/v1/garages/${world.garage}/sessions/open`, {
    headers: { 'x-tenant-id': tenant },
  });
  assert.equal(res.status, 401, 'the header must not authenticate anything');
});

test('a revoked operator token stops working', async () => {
  const doomed = await issueOperatorToken(tenant);
  assert.equal((await fetch(`${base}/api/v1/garages/${world.garage}/sessions/open`, asOperator(doomed))).status, 200);
  await withTenant(tenant, (c) =>
    c.query('UPDATE operator_tokens SET revoked_at = now() WHERE token_hash = $1', [hashToken(doomed)]),
  );
  assert.equal((await fetch(`${base}/api/v1/garages/${world.garage}/sessions/open`, asOperator(doomed))).status, 401);
});

test('a device token is returned exactly once, and only its hash is stored', async () => {
  const res = await fetch(`${base}/api/v1/lanes/${world.entryLane}/devices`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${operatorToken}`,
    },
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

// --- C5: the two residuals from the independent review ---------------------

test('the exit lane can look up the open session for a plate', async () => {
  const plate = `LOOKUP-${randomUUID().slice(0, 8)}`;
  const opened = (
    await (
      await fetch(
        `${base}/api/v1/lane/sessions/open`,
        asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:00:00Z' }),
      )
    ).json()
  ).session;

  const res = await fetch(`${base}/api/v1/lane/sessions/open?plate=${plate}`, {
    headers: { authorization: `Bearer ${exitToken}` },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).session.id, opened.id);
});

test('C5(a): a stale exit cannot land on a later visit when it names the session', async () => {
  // The residual the previous round could not close: an exit whose timestamp
  // falls AFTER a later entry. Naming the session removes the guesswork.
  const plate = `NAMED-${randomUUID().slice(0, 8)}`;
  const first = (
    await (
      await fetch(
        `${base}/api/v1/lane/sessions/open`,
        asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:00:00Z' }),
      )
    ).json()
  ).session;
  await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_confirmation: 'confirmed', exit_at: '2026-08-26T10:00:00Z', session_id: first.id }),
  );

  // second visit, and its exit is LATER than the stale one we are about to replay
  await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate, entry_confirmation: 'confirmed', entry_at: '2026-08-27T09:00:00Z' }),
  );

  const stale = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate, exit_confirmation: 'confirmed', exit_at: '2026-08-27T11:00:00Z', session_id: first.id }),
  );
  assert.equal(stale.status, 404, 'the named session is closed; it must not fall through to the open one');

  const stillOpen = await withTenant(tenant, async (c) =>
    (
      await c.query(
        `SELECT count(*)::int AS n FROM sessions s JOIN vehicles v ON v.id = s.vehicle_id
          WHERE v.plate = $1 AND s.exit_at IS NULL`,
        [plate],
      )
    ).rows[0].n,
  );
  assert.equal(stillOpen, 1, "the second visit's session is untouched");
});

test('C5(a): naming a session belonging to another vehicle is refused', async () => {
  const a = `OWNER-${randomUUID().slice(0, 8)}`;
  const b = `OTHER-${randomUUID().slice(0, 8)}`;
  const sessionA = (
    await (
      await fetch(
        `${base}/api/v1/lane/sessions/open`,
        asDevice(entryToken, { plate: a, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:00:00Z' }),
      )
    ).json()
  ).session;
  await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate: b, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:05:00Z' }),
  );

  const res = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(exitToken, { plate: b, exit_confirmation: 'confirmed', exit_at: '2026-08-26T12:00:00Z', session_id: sessionA.id }),
  );
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /different vehicle/i);
});

test('C5(b): an event id re-presented for a different vehicle is a loud conflict', async () => {
  // Previously this silently returned the FIRST vehicle's session, so the
  // second car got no session at all, exited to a 404, and parked free with
  // nothing in the record to say so. A loud lane fault is worth more.
  const shared = randomUUID();
  const first = await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate: `DUP-A-${randomUUID().slice(0, 6)}`, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:00:00Z', event_id: shared }),
  );
  assert.equal(first.status, 201);

  const second = await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { plate: `DUP-B-${randomUUID().slice(0, 6)}`, entry_confirmation: 'confirmed', entry_at: '2026-08-26T09:10:00Z', event_id: shared }),
  );
  assert.equal(second.status, 409, 'must be a conflict, not a silent resolution to the first vehicle');
  assert.match((await second.json()).error, /different vehicle/i);
});

test('vehicle identity from the lane is stored', async () => {
  const plate = `ID-${randomUUID().slice(0, 8)}`;
  await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, {
      plate,
      entry_confirmation: 'confirmed', entry_at: new Date().toISOString(),
      make: 'Toyota',
      model: 'Corolla',
      color: 'silver',
      attributes: { marks: ['roof rack'] },
    }),
  );
  const v = await withTenant(tenant, async (c) =>
    (await c.query('SELECT make, model, color, attributes FROM vehicles WHERE plate = $1', [plate])).rows[0],
  );
  assert.equal(v.make, 'Toyota');
  assert.equal(v.color, 'silver');
  assert.deepEqual(v.attributes, { marks: ['roof rack'] });
});

// --- what a garage does with a plate that matches no rule -------------------
//
// This was a string literal in the response body until 0004, so every lane in
// every deployment synced 'allow' and the lane's own 'deny' path -- which it
// has always had -- was unreachable. The tests below are in pairs: the garage
// that configured nothing, which must not have moved, and the garage that
// asked to be strict, which could not exist before.

/** A garage of its own, with an entry lane and a device, so a strict garage
 *  cannot disturb the shared world every other test reads. */
async function garageWithALane(action) {
  const body = { name: 'Rules Garage', timezone: 'America/New_York', currency: 'USD' };
  if (action !== undefined) body.default_action = action;
  const created = await fetch(`${base}/api/v1/garages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify(body),
  });
  assert.equal(created.status, 201);
  const { garage } = await created.json();

  const lane = await fetch(`${base}/api/v1/garages/${garage.id}/lanes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ name: 'Entry 1', direction: 'entry' }),
  });
  assert.equal(lane.status, 201);
  const token = await issueToken(tenant, (await lane.json()).lane.id, 'rules device');
  return { garage, token };
}

const rulesFor = async (token) =>
  (await fetch(`${base}/api/v1/lane/rules`, { headers: { authorization: `Bearer ${token}` } })).json();

test('a garage that has configured nothing still serves allow', async () => {
  // The protection for every lane that already exists. Two committed tests in
  // lane-controller assert this vend by name; if this one moves, they break.
  const { token } = await garageWithALane(undefined);
  assert.equal((await rulesFor(token)).default_action, 'allow');
});

test('a garage that asked to be strict serves deny to its lane', async () => {
  const { token } = await garageWithALane('deny');
  assert.equal((await rulesFor(token)).default_action, 'deny');
});

test('an existing garage can be made strict, and made open again', async () => {
  // Creation-time only would leave every garage that already exists unable to
  // be strict, which is the whole of what was wrong.
  const { garage, token } = await garageWithALane(undefined);
  const patch = (action) =>
    fetch(`${base}/api/v1/garages/${garage.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ default_action: action }),
    });

  assert.equal((await patch('deny')).status, 200);
  assert.equal((await rulesFor(token)).default_action, 'deny');

  assert.equal((await patch('allow')).status, 200);
  assert.equal((await rulesFor(token)).default_action, 'allow');
});

test('a default_action the lane does not recognise is refused, not ignored', async () => {
  // It was accepted and silently dropped: 201 with the field absent from the
  // row. An operator asking for a strict garage got one that admits everybody
  // and no indication of it.
  for (const value of ['fallback', 'ALLOW', 'Allow', '', 'refuse', 0, null]) {
    const res = await fetch(`${base}/api/v1/garages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({
        name: 'Nonsense',
        timezone: 'America/New_York',
        currency: 'USD',
        default_action: value,
      }),
    });
    if (value === null) {
      // Absent is not the same as wrong: it means "say nothing", and the
      // garage gets the column default.
      assert.equal(res.status, 201, 'an absent default_action must still create the garage');
      assert.equal((await res.json()).garage.default_action, 'allow');
      continue;
    }
    assert.equal(res.status, 400, `${JSON.stringify(value)} was accepted`);
    assert.match((await res.json()).error, /default_action/);
  }
});

test('the database refuses a value no route would have let through', async () => {
  // The route is where an operator is told what the values are; the column is
  // what makes it true whatever reaches the table next.
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(`UPDATE garages SET default_action = 'whatever' WHERE tenant_id = $1`, [tenant]),
    ),
    /check constraint/i,
  );
});
