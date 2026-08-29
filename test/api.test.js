import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp, LANE_EVENT_KINDS } from '../src/app.js';
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

// --- a time that has not happened yet ---------------------------------------
//
// Times come from the lane, and a time in the PAST is legitimate — the car may
// have arrived while the lane had no network. A time in the FUTURE is a claim
// that something has happened which has not, and nothing bounded it: an
// `exit_at` a lane could name froze a fee for a stay nobody had. Measured
// against the running platform first: an entry a year back and an exit four
// years on closed, billed, and sat in the ledger looking like a stay.
//
// The pair below lands either side of MAX_CLOCK_SKEW_SECONDS deliberately. A
// threshold with fixture inputs on only one side of it is not exercised.

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const secondsAhead = (sec) => new Date(Date.now() + sec * 1000).toISOString();
// An exit computed FROM the entry, not from a second reading of the clock: a
// part-hour bills as a whole one, so two calls to `hoursAgo` an instant apart
// make a 1h stay cost two hours and the expectation goes wrong for a reason
// that has nothing to do with what is being tested.
const plusHours = (iso, h) => new Date(Date.parse(iso) + h * 3600 * 1000).toISOString();

/** A garage of its own with both lanes and a rate, so a refused close cannot
 *  disturb the shared world every other test reads. */
async function garageWithBothLanes() {
  const body = { name: 'Bounds Garage', timezone: 'America/New_York', currency: 'USD' };
  const created = await fetch(`${base}/api/v1/garages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify(body),
  });
  assert.equal(created.status, 201);
  const { garage } = await created.json();

  const makeLane = async (name, direction) => {
    const res = await fetch(`${base}/api/v1/garages/${garage.id}/lanes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ name, direction }),
    });
    assert.equal(res.status, 201);
    return issueToken(tenant, (await res.json()).lane.id, `${direction} device`);
  };

  const rate = await fetch(`${base}/api/v1/garages/${garage.id}/rates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ name: 'Hourly', hourly_minor: 500 }),
  });
  assert.equal(rate.status, 201);

  return {
    garage,
    entry: await makeLane('Entry 1', 'entry'),
    exit: await makeLane('Exit 1', 'exit'),
  };
}

const openFor = (token, plate, entryAt) =>
  fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(token, { plate, entry_at: entryAt, entry_confirmation: 'confirmed' }),
  );

const closeFor = (token, plate, exitAt, confirmation = 'confirmed') =>
  fetch(
    `${base}/api/v1/lane/sessions/close`,
    asDevice(token, { plate, exit_at: exitAt, exit_confirmation: confirmation }),
  );

test('an exit_at in the future is refused, and no fee is frozen', async () => {
  const { entry, exit } = await garageWithBothLanes();
  assert.equal((await openFor(entry, 'FUTURE01', hoursAgo(1))).status, 201);

  const res = await closeFor(exit, 'FUTURE01', secondsAhead(365 * 24 * 3600));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /ahead of this server's clock/);

  // The session is untouched: still open, no exit, no money on it.
  const still = await fetch(`${base}/api/v1/lane/sessions/open?plate=FUTURE01`, {
    headers: { authorization: `Bearer ${exit}` },
  });
  assert.equal(still.status, 200, 'the refused close must not have closed anything');
  const { session } = await still.json();
  assert.equal(session.exit_at, null);
  assert.equal(session.fee_minor, null);
});

test('an exit_at a few seconds ahead is inside the drift tolerated and closes', async () => {
  // The other side of the threshold. A lane device whose clock is seconds fast
  // is a normal lane, not an attack, and refusing it would strand a real car.
  const { entry, exit } = await garageWithBothLanes();
  assert.equal((await openFor(entry, 'SKEW0001', hoursAgo(1))).status, 201);

  const res = await closeFor(exit, 'SKEW0001', secondsAhead(5));
  assert.equal(res.status, 200);
  // An hour and five seconds, and a part-hour bills as a whole one.
  assert.equal((await res.json()).session.fee_minor, 1000);
});

test('an entry_at in the future is refused too', async () => {
  const { entry } = await garageWithBothLanes();
  const res = await openFor(entry, 'FUTURE02', secondsAhead(365 * 24 * 3600));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /entry_at is \d+s ahead/);
});

test('a replay from the PAST is still accepted — that half is a decision', async () => {
  // The lane-clock decision, unchanged and deliberately re-asserted here: an
  // offline lane replaying yesterday's entries is the case the decision exists
  // for, and the future bound must not have taken it with it.
  const { entry, exit } = await garageWithBothLanes();
  const entryAt = hoursAgo(8760);
  assert.equal((await openFor(entry, 'PAST0001', entryAt)).status, 201);
  const res = await closeFor(exit, 'PAST0001', plusHours(entryAt, 1), 'held');
  assert.equal(res.status, 200);
  const { session } = await res.json();
  assert.equal(session.fee_minor, 500, 'a year-old stay of one hour still bills one hour');
  assert.equal(session.exit_confirmation, 'held');
});

// --- what a lane may call an event ------------------------------------------

test('an event kind no lane emits is refused, and the refusal names it', async () => {
  const res = await fetch(
    `${base}/api/v1/lane/events`,
    asDevice(entryToken, {
      events: [
        {
          event_id: randomUUID(),
          kind: 'totally_invented_kind',
          occurred_at: new Date().toISOString(),
        },
      ],
    }),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /totally_invented_kind/);
});

test('every kind this platform publishes is a kind it accepts', async () => {
  // Derived from the exported set rather than from a list written here: a list
  // typed into a test cannot notice anything added to the thing it covers.
  const events = LANE_EVENT_KINDS.map((kind) => ({
    event_id: randomUUID(),
    kind,
    occurred_at: new Date().toISOString(),
  }));
  const res = await fetch(`${base}/api/v1/lane/events`, asDevice(entryToken, { events }));
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: LANE_EVENT_KINDS.length, duplicates: 0 });
});

test('an event dated in the future is refused, on the same bound as a session', async () => {
  // The third lane-supplied time. It was unbounded: `reconcile.js` filters
  // `occurred_at >= since` with no upper bound and `retention.js` never touches
  // `events`, so one future-dated row satisfies every window that will ever be
  // asked for and nothing removes it. Either side of the same threshold the two
  // session routes are bounded by, plus the past, which stays legitimate.
  const post = (occurredAt) =>
    fetch(
      `${base}/api/v1/lane/events`,
      asDevice(entryToken, {
        events: [{ event_id: randomUUID(), kind: 'frames_captured', occurred_at: occurredAt }],
      }),
    );

  const ahead = await post(secondsAhead(365 * 24 * 3600));
  assert.equal(ahead.status, 409);
  assert.match((await ahead.json()).error, /occurred_at is \d+s ahead/);

  // Inside the drift tolerated: a lane device seconds fast is a normal lane.
  assert.equal((await post(secondsAhead(119))).status, 202);

  // A replay from the past is the case the lane-clock decision exists for.
  assert.equal((await post(hoursAgo(8760))).status, 202);
});

test('every kind reconciliation counts is a kind a lane may still report', async () => {
  // Two layers reading the same concept. Narrowing the accepted set without
  // noticing that reconcile.js filters on three of its members would leave the
  // report counting a kind nothing can write any more -- silently zero.
  const source = await readFile(new URL('../src/reconcile.js', import.meta.url), 'utf8');
  const counted = [...source.matchAll(/kind = '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(counted.length >= 3, 'the query found nothing to check — it is not measuring');
  for (const kind of counted) {
    assert.ok(LANE_EVENT_KINDS.includes(kind), `reconcile.js counts '${kind}', which is refused`);
  }
});

// --- revoking a device token ------------------------------------------------
//
// A device token IS a lane's identity, so a leaked one is a leaked lane. Until
// this route existed nothing an operator could reach ended that: there is no
// device DELETE, `PATCH /garages/:id` takes `default_action` and refuses every
// other field, and setting a garage to `deny` stops vends while leaving
// /lane/sessions/open and /close fully usable by the stolen token. The only
// move left was an UPDATE against the production database by hand.
//
// The column and the filter are not new — `lane_devices.revoked_at` and
// `resolve_lane_device`'s `AND d.revoked_at IS NULL` have been there since
// 0002. What was missing was anything that sets it, so these tests are about
// the route and about the seam it reaches, not about the SQL.

/** Issue a device through the operator route, which is what returns its id. */
async function issueDeviceViaRoute(laneId, name, token = operatorToken) {
  const res = await fetch(`${base}/api/v1/lanes/${laneId}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

const revoke = (deviceId, token = operatorToken) =>
  fetch(`${base}/api/v1/devices/${deviceId}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });

test('a revoked device token can no longer open a session, and its sibling still can', async () => {
  // The probe the third outside pass ran, in both directions: 201 before,
  // revoke, 401 after. The sibling is what stops this passing because
  // revocation broke the lane rather than the credential.
  const stolen = await issueDeviceViaRoute(world.entryLane, 'stolen entry device');
  const sibling = await issueDeviceViaRoute(world.entryLane, 'sibling entry device');

  const open = (token) =>
    fetch(
      `${base}/api/v1/lane/sessions/open`,
      asDevice(token, {
        plate: `REVOKE${Math.floor(Math.random() * 1e6)}`,
        entry_at: new Date().toISOString(),
        entry_confirmation: 'confirmed',
      }),
    );

  assert.equal((await open(stolen.token)).status, 201, 'the token must work before it is revoked');

  const revoked = await revoke(stolen.device.id);
  assert.equal(revoked.status, 200);
  assert.ok((await revoked.json()).device.revoked_at, 'the row must carry when it was revoked');

  const after = await open(stolen.token);
  assert.equal(after.status, 401);
  assert.deepEqual(await after.json(), { error: 'unknown or revoked device token' });

  assert.equal(
    (await open(sibling.token)).status,
    201,
    'revoking one device must not disable the lane',
  );
});

test('a revoked token cannot close either, and is refused BEFORE the direction check', async () => {
  // An entry token posting a close is normally 409 — wrong direction. Once
  // revoked it must be 401: the credential stops resolving, so nothing behind
  // it gets a say. If this ever reads 409 the token is still being resolved.
  const entry = await issueDeviceViaRoute(world.entryLane, 'entry, to be revoked');
  const exit = await issueDeviceViaRoute(world.exitLane, 'exit, to be revoked');

  const close = (token) =>
    fetch(
      `${base}/api/v1/lane/sessions/close`,
      asDevice(token, {
        plate: 'REVOKECLOSE1',
        exit_at: new Date().toISOString(),
        exit_confirmation: 'confirmed',
      }),
    );

  assert.equal((await close(entry.token)).status, 409, 'an entry token cannot close, by direction');

  assert.equal((await revoke(entry.device.id)).status, 200);
  assert.equal((await revoke(exit.device.id)).status, 200);

  assert.equal((await close(entry.token)).status, 401);
  assert.equal((await close(exit.token)).status, 401);
});

test('revoking twice does not move when the credential stopped being trusted', async () => {
  const device = await issueDeviceViaRoute(world.entryLane, 'revoked twice');

  const first = await (await revoke(device.device.id)).json();
  const second = await (await revoke(device.device.id)).json();

  assert.ok(first.device.revoked_at);
  assert.equal(second.device.revoked_at, first.device.revoked_at);
});

test("an operator of another tenant cannot revoke this tenant's device", async () => {
  // Row-level security makes it not-found rather than forbidden: the row is
  // not visible to ask about. The control is the same call with the RIGHT
  // operator token, which must succeed — without it a 404 proves only that the
  // route is broken.
  const device = await issueDeviceViaRoute(world.entryLane, 'another tenant may not touch this');

  const other = await createTenant('revoke-outsider');
  const outsiderToken = await issueOperatorToken(other);

  const refused = await revoke(device.device.id, outsiderToken);
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), { error: 'device not found' });

  assert.equal((await revoke(device.device.id)).status, 200, 'control: the owner can revoke it');
});

test('a device that does not exist is not found, and an unauthenticated revoke is refused', async () => {
  assert.equal((await revoke(randomUUID())).status, 404);

  const noToken = await fetch(`${base}/api/v1/devices/${randomUUID()}/revoke`, { method: 'POST' });
  assert.equal(noToken.status, 401);
});

// ---------------------------------------------------------------------------
// Revoking an OPERATOR token — the device revoke's twin.
//
// `operator_tokens.revoked_at` (0003:71) and `resolve_operator_token`'s
// `AND t.revoked_at IS NULL` (0003:92) have been there since 0003 with nothing
// setting the column, exactly as `lane_devices` was until the route above. The
// case is weaker than the device one — an operator token is issued by
// `scripts/issue-operator-token.js`, so the person who would revoke one already
// has the psql access to UPDATE it — and these tests are here for the same
// reason the route is: "you still have psql" was not an acceptable answer for
// devices either.
//
// As with the device tests, these are about the route and the seam it reaches,
// not about the SQL, which was already there.

/** An operator token AND its id, which `issueOperatorToken` does not return. */
async function issueOperatorTokenRow(tenantId, name = 'ops') {
  const token = generateDeviceToken();
  const row = await withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,$2,$3)
       RETURNING id, name`,
      [tenantId, name, hashToken(token)],
    );
    return rows[0];
  });
  return { id: row.id, token };
}

const revokeOperatorToken = (tokenId, token = operatorToken) =>
  fetch(`${base}/api/v1/operator-tokens/${tokenId}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });

/**
 * Every operator route, DERIVED from src/app.js rather than typed here.
 *
 * A hard-coded list cannot notice a route added later, and a route added later
 * is exactly the thing that could sit outside the auth middleware. This reads
 * the same source the router is built from, so a new `operator.<verb>(...)`
 * line joins this test automatically or breaks the parse loudly.
 */
async function operatorRoutesFromSource() {
  const src = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const routes = [...src.matchAll(/^ {2}operator\.(get|post|patch|put|delete)\('([^']+)'/gm)].map(
    (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  );
  assert.ok(routes.length >= 9, `expected the operator surface, parsed ${routes.length} routes`);
  return routes;
}

test('a revoked operator token is refused on EVERY operator route, and a sibling still works', async () => {
  // The device test's shape: 200 before, revoke, 401 after, sibling unaffected.
  // The sibling is what stops this passing because revocation broke the tenant
  // rather than the credential.
  const stolen = await issueOperatorTokenRow(tenant, 'stolen ops token');
  const sibling = await issueOperatorTokenRow(tenant, 'sibling ops token');

  const listGarages = (token) =>
    fetch(`${base}/api/v1/garages/${world.garage}/sessions/open`, asOperator(token));

  assert.equal((await listGarages(stolen.token)).status, 200, 'must work before it is revoked');

  const revoked = await revokeOperatorToken(stolen.id);
  assert.equal(revoked.status, 200);
  const body = await revoked.json();
  assert.ok(body.operator_token.revoked_at, 'the row must carry when it was revoked');
  assert.ok(!('token_hash' in body.operator_token), 'revoking must not hand the credential back');

  // Every operator route, not a sample: the credential stops resolving, so
  // nothing behind it — validation, direction, tenancy — gets a say.
  for (const route of await operatorRoutesFromSource()) {
    const path = route.path
      .replace(':garageId', world.garage)
      .replace(':laneId', world.entryLane)
      .replace(':deviceId', randomUUID())
      .replace(':tokenId', randomUUID());
    const res = await fetch(`${base}/api/v1${path}`, {
      method: route.method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${stolen.token}` },
      body: route.method === 'GET' ? undefined : '{}',
    });
    assert.equal(res.status, 401, `${route.method} ${route.path} must be 401 for a revoked token`);
    assert.deepEqual(await res.json(), { error: 'unknown or revoked operator token' });
  }

  assert.equal(
    (await listGarages(sibling.token)).status,
    200,
    'revoking one operator token must not lock the tenant out',
  );
});

test('revoking an operator token twice does not move when it stopped being trusted', async () => {
  const doomed = await issueOperatorTokenRow(tenant, 'ops revoked twice');

  const first = await (await revokeOperatorToken(doomed.id)).json();
  const second = await (await revokeOperatorToken(doomed.id)).json();

  assert.ok(first.operator_token.revoked_at);
  assert.equal(second.operator_token.revoked_at, first.operator_token.revoked_at);
});

test("an operator of another tenant cannot revoke this tenant's operator token", async () => {
  // Row-level security makes it not-found rather than forbidden. The control is
  // the same call with the RIGHT token, which must succeed — without it a 404
  // proves only that the route is broken.
  const mine = await issueOperatorTokenRow(tenant, 'another tenant may not touch this');

  const other = await createTenant('ops-revoke-outsider');
  const outsiderToken = await issueOperatorToken(other);

  const refused = await revokeOperatorToken(mine.id, outsiderToken);
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), { error: 'operator token not found' });

  // And the row is untouched, not merely invisible: it still authenticates.
  assert.equal(
    (await fetch(`${base}/api/v1/garages/${world.garage}/sessions/open`, asOperator(mine.token)))
      .status,
    200,
    'a refused cross-tenant revoke must not have revoked it anyway',
  );

  assert.equal((await revokeOperatorToken(mine.id)).status, 200, 'control: the owner can revoke it');
});

test('an operator token that does not exist is not found, and an unauthenticated revoke is refused', async () => {
  assert.equal((await revokeOperatorToken(randomUUID())).status, 404);

  const noToken = await fetch(`${base}/api/v1/operator-tokens/${randomUUID()}/revoke`, {
    method: 'POST',
  });
  assert.equal(noToken.status, 401);
});

test('an operator can revoke the token it is holding, and is locked out immediately after', async () => {
  // Not a special case in the route, and the test exists to prove that: the
  // UPDATE has already happened when the response is written, so the call that
  // revokes succeeds and the next one does not.
  const selfRevoking = await issueOperatorTokenRow(tenant, 'revokes itself');

  const res = await revokeOperatorToken(selfRevoking.id, selfRevoking.token);
  assert.equal(res.status, 200);

  const after = await fetch(
    `${base}/api/v1/garages/${world.garage}/sessions/open`,
    asOperator(selfRevoking.token),
  );
  assert.equal(after.status, 401);
});

// --- the devices route, and what a monitor reads off it ---------------------
//
// `lane_devices.last_seen_at` is written on every authenticated lane request
// and was published on no route. A lane that has stopped reporting is one of
// the malfunctions this estate is supposed to notice, and the platform is the
// only thing that can see it -- a lane that is switched off cannot report that
// it is switched off.
//
// Two things are proven here and they are different questions. That the ROUTE
// serves the column, tenant-scoped; and that the column it serves is the one
// `touch_lane_device` writes -- bumped through a real authenticated lane
// request and read back changed. Without the second, this could be serving a
// column nothing ever sets, which reads exactly the same until a lane dies.

const devicesOf = (garageId, token = operatorToken) =>
  fetch(`${base}/api/v1/garages/${garageId}/devices`, asOperator(token));

test('the devices route lists this garage devices with last_seen_at', async () => {
  const created = await issueDeviceViaRoute(world.entryLane, 'listed device');

  const res = await devicesOf(world.garage);
  assert.equal(res.status, 200);
  const { devices } = await res.json();

  const mine = devices.find((d) => d.id === created.device.id);
  assert.ok(mine, 'the device just issued on this garage lane must be in the list');
  assert.deepEqual(
    Object.keys(mine).sort(),
    ['created_at', 'id', 'last_seen_at', 'lane_id', 'name', 'revoked_at'].sort(),
  );
  // Listing devices is not an occasion to hand out a credential's hash.
  assert.equal(JSON.stringify(devices).includes('token_hash'), false);
  // Never used, so never seen. Null and not a fabricated moment.
  assert.equal(mine.last_seen_at, null);
});

test('last_seen_at on that route is the column touch_lane_device writes', async () => {
  // The check that stops this route serving a column nothing sets. A real
  // authenticated lane request goes through the device router, which calls
  // touch_lane_device, and the value the route publishes must move with it.
  const device = await issueDeviceViaRoute(world.entryLane, 'touched device');

  const before = (await (await devicesOf(world.garage)).json()).devices.find(
    (d) => d.id === device.device.id,
  );
  assert.equal(before.last_seen_at, null, 'a device that has never called must read null');

  const used = await fetch(`${base}/api/v1/lane/rules`, {
    headers: { authorization: `Bearer ${device.token}` },
  });
  assert.equal(used.status, 200, 'the lane request itself must succeed, or nothing was touched');

  // touch_lane_device is fire-and-forget on the request path, so the write is
  // not ordered against the response. Poll rather than sleep a fixed time: a
  // fixed sleep either flakes or is slower than it needs to be.
  let after = null;
  for (let i = 0; i < 50 && !after; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    const row = (await (await devicesOf(world.garage)).json()).devices.find(
      (d) => d.id === device.device.id,
    );
    after = row.last_seen_at;
  }
  assert.ok(after, 'last_seen_at must move when the device makes an authenticated request');
  assert.ok(Date.parse(after) > 0);
});

test("the devices route does not serve another tenant's garage", async () => {
  // 404 and not 403, and not an empty list: the convention every garage-scoped
  // operator route here already follows. An empty list would be the dangerous
  // answer -- a monitor pointed at the wrong garage would report no devices
  // and therefore nothing wrong.
  const other = await createTenant('devices-other');
  const otherWorld = await buildWorld(other);
  const otherToken = await issueOperatorToken(other);

  const cross = await devicesOf(otherWorld.garage);
  assert.equal(cross.status, 404);
  assert.deepEqual(await cross.json(), { error: 'garage not found' });

  // The control: the same call with the RIGHT token finds the garage, so the
  // 404 above is about the tenant and not about the garage id being wrong.
  assert.equal((await devicesOf(otherWorld.garage, otherToken)).status, 200);
});

// --- every 409 names itself -------------------------------------------------
//
// A 409 is the platform's terminal refusal and the lane dead-letters it. Seven
// different conditions produced one indistinguishable fact, and one of the
// seven -- a clock skew -- means every session open and close that lane sends
// is being dropped. That is money leaving the record, reported to nobody.

test('a clock-skew refusal carries the code a lane can key on', async () => {
  const { entry } = await garageWithBothLanes();
  const res = await openFor(entry, 'SKEWCODE1', secondsAhead(600));

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'clock_skew');
  // The message is still there and is still for a human. The code is what a
  // machine reads, and it is not derived from the message.
  assert.match(body.error, /ahead of this server's clock/);
});

test('another 409 carries a DIFFERENT code, so the skew one distinguishes something', async () => {
  // The control for the test above. A `code` field that answered `clock_skew`
  // for every refusal would satisfy that assertion and tell a lane nothing.
  const { entry } = await garageWithBothLanes();
  const res = await closeFor(entry, 'SKEWCODE2', hoursAgo(1));

  assert.equal(res.status, 409, 'an entry token cannot close, by direction');
  const body = await res.json();
  assert.equal(body.code, 'wrong_lane_direction');
  assert.notEqual(body.code, 'clock_skew');
});

test('a 400 carries no code, and a 500 never publishes one', async () => {
  // The field is published only for errors this file raised, and only below
  // 500. A driver error carries a SQLSTATE in `code` of its own and must never
  // reach the wire; it has no `status`, so it becomes a 500 and is answered
  // 'internal error' with nothing else in the body.
  const res = await fetch(
    `${base}/api/v1/lane/sessions/open`,
    asDevice(entryToken, { entry_at: new Date().toISOString(), entry_confirmation: 'confirmed' }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'plate is required' });
});

test('no conflict in src/app.js is raised without a name', async () => {
  // A 409 constructed directly, bypassing `conflict()`, would arrive at a lane
  // with no code -- indistinguishable from a platform too old to have this
  // field at all. Swept from the source, because the alternative is a list of
  // the seven call sites, and a list cannot notice an eighth.
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const bare = /new\s+HttpError\(\s*409\b/g;

  assert.deepEqual(source.match(bare), null, 'every conflict goes through conflict()');
  // THE CONTROL: the same sweep, over text known to contain one, must find it.
  // Without this the assertion above passes for a regex that matches nothing.
  assert.equal('throw new HttpError(409, "x");'.match(bare)?.length, 1);
  // And the helper really is in use, so the zero above is not zero conflicts.
  assert.ok(source.includes('const conflict = (code, message) =>'));
  assert.ok((source.match(/\bconflict\(/g) ?? []).length >= 7);
});
