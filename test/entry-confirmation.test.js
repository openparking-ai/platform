/**
 * A session opens on a CONFIRMATION, not on a vend.
 *
 * The lane creates a pending entry when it vends and promotes it only when two
 * loops after the barrier see a vehicle cross them forward. This file is the
 * platform's half of that: what it refuses, what it stores, and what it counts.
 *
 * The point of enforcing it HERE and not only in the lane is that a property
 * living in one repo's code is a property one HTTP request goes around. The
 * question the outside reviews asked was "what is every route to a ticket with
 * no car" — `POST /lane/sessions/open` was one of them, and a lane-side rule
 * would not have closed it.
 */
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

const post = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ event_id: randomUUID(), ...body }),
});

const asOperator = (token) => ({ headers: { authorization: `Bearer ${token}` } });

const plate = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

const openEntry = (body) =>
  fetch(`${base}/api/v1/lane/sessions/open`, post(entryToken, body));

before(async () => {
  tenant = await createTenant('confirmation');
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

// --- what the route refuses ------------------------------------------------

test('an entry that does not say what confirmed it is refused', async () => {
  const res = await openEntry({ plate: plate('NOSAY'), entry_at: new Date().toISOString() });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /entry_confirmation is required/);
});

test('an entry claiming a value the lane does not publish is refused', async () => {
  for (const claimed of ['', 'yes', 'true', 'CONFIRMED', 'probably', null]) {
    const res = await openEntry({
      plate: plate('BAD'),
      entry_at: new Date().toISOString(),
      entry_confirmation: claimed,
    });
    assert.equal(res.status, 400, `entry_confirmation ${JSON.stringify(claimed)} was accepted`);
  }
});

test('opened_on_vend is a backfill value and a lane may not claim it', async () => {
  // The column's CHECK permits it, because every row written before migration
  // 0005 carries it. A REQUEST claiming it would be a lane asserting a history
  // it does not have, so the two sets are deliberately different.
  const res = await openEntry({
    plate: plate('LEGACY'),
    entry_at: new Date().toISOString(),
    entry_confirmation: 'opened_on_vend',
  });
  assert.equal(res.status, 400);
});

test('an exit that does not say what confirmed it is refused', async () => {
  const p = plate('EXITSAY');
  await openEntry({ plate: p, entry_at: '2026-08-26T09:00:00Z', entry_confirmation: 'confirmed' });

  const res = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    post(exitToken, { plate: p, exit_at: '2026-08-26T11:00:00Z' }),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /exit_confirmation is required/);
});

test('held is an EXIT value and an entry may not claim it', async () => {
  // The one value the two ends do not share. An entry nothing confirmed is not
  // a session at all -- no row, no occupancy, no money -- so there is nothing
  // for `held` to mean on an open.
  const res = await openEntry({
    plate: plate('HELDOPEN'),
    entry_at: new Date().toISOString(),
    entry_confirmation: 'held',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /must be one of confirmed, unconfirmable$/);
});

// --- what it echoes --------------------------------------------------------

test('the open echoes back what confirmed it, and a lane depends on that', async () => {
  // A platform that predates the column answers this call exactly as
  // successfully and hands back a session without the field. The lane treats an
  // open that does not come back carrying the value it sent as NOT DELIVERED,
  // so this echo is a contract term and not a convenience of the response.
  for (const value of ['confirmed', 'unconfirmable']) {
    const res = await openEntry({
      plate: plate(`ECHO-${value}`),
      entry_at: new Date().toISOString(),
      entry_confirmation: value,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(
      body.session.entry_confirmation,
      value,
      'the open did not echo what the lane said confirmed it',
    );
  }
});

test('a replayed open echoes it too, from the row it originally wrote', async () => {
  // The replay answers 200 from the stored session rather than from the
  // request, so the echo has to survive that path as well -- an outbox re-sends
  // and it is the second answer the lane checks.
  const p = plate('ECHOREPLAY');
  const eventId = randomUUID();
  const body = {
    event_id: eventId,
    plate: p,
    entry_at: new Date().toISOString(),
    entry_confirmation: 'confirmed',
  };
  const first = await fetch(`${base}/api/v1/lane/sessions/open`, post(entryToken, body));
  const again = await fetch(`${base}/api/v1/lane/sessions/open`, post(entryToken, body));

  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).session.entry_confirmation, 'confirmed');
});

// --- an exit the loops did not confirm -------------------------------------

test('an unconfirmed exit closes, bills, and is marked held', async () => {
  // The decision, and the reason it is not symmetrical with an entry: the exit
  // vend is the payment moment and the barrier opened. Holding the session open
  // left the stay unbilled and the vehicle inside for ever, so installing the
  // loops made a garage worse off than not installing them.
  const p = plate('HELDEXIT');
  await openEntry({ plate: p, entry_at: '2026-08-26T09:00:00Z', entry_confirmation: 'confirmed' });

  const res = await fetch(
    `${base}/api/v1/lane/sessions/close`,
    post(exitToken, {
      plate: p,
      exit_at: '2026-08-26T11:00:00Z',
      exit_confirmation: 'held',
    }),
  );

  assert.equal(res.status, 200);
  const { session } = await res.json();
  assert.equal(session.exit_confirmation, 'held');
  assert.ok(session.exit_at, 'a held exit must still close the session');
  assert.equal(session.fee_minor, 500, 'two hours at 250/hour, billed like any other exit');
});

test('the database refuses an exit confirmation the routes do not publish', async () => {
  // The constraint, not the route. `closed_on_vend` is 0005's backfill and is
  // permitted by the column for the old rows; anything else is not there at all.
  const p = plate('BADEXITVAL');
  const opened = await openEntry({
    plate: p,
    entry_at: '2026-08-26T09:00:00Z',
    entry_confirmation: 'confirmed',
  });
  const sessionId = (await opened.json()).session.id;

  await assert.rejects(
    () =>
      withTenant(tenant, (c) =>
        c.query(
          `UPDATE sessions SET exit_at = now(), exit_lane_id = $2, close_event_id = $3,
                               fee_minor = 0, hourly_minor_applied = 0,
                               exit_confirmation = 'probably'
             WHERE id = $1`,
          [sessionId, world.exitLane, randomUUID()],
        ),
      ),
    /sessions_exit_confirmation_check/,
  );
});

// --- what it stores --------------------------------------------------------

test('what confirmed the entry is stored on the session, both values', async () => {
  for (const value of ['confirmed', 'unconfirmable']) {
    const p = plate(`STORE-${value}`);
    const res = await openEntry({
      plate: p,
      entry_at: new Date().toISOString(),
      entry_confirmation: value,
    });
    assert.equal(res.status, 201);
    const row = await withTenant(tenant, async (c) =>
      (
        await c.query(
          `SELECT s.entry_confirmation, s.exit_confirmation FROM sessions s
             JOIN vehicles v ON v.id = s.vehicle_id WHERE v.plate = $1`,
          [p],
        )
      ).rows[0],
    );
    assert.equal(row.entry_confirmation, value);
    assert.equal(row.exit_confirmation, null, 'nothing has left yet');
  }
});

test('the column has NO default, so an insert that forgets it fails loudly', async () => {
  // The default existed for the length of one ALTER in 0005 and was dropped in
  // the same file. Left in place it would hand a plausible answer to an insert
  // that never asserted anything — a silent wrong value in the one column that
  // says whether anything saw the car.
  await assert.rejects(
    () =>
      withTenant(tenant, async (c) => {
        const v = (
          await c.query('INSERT INTO vehicles (tenant_id, plate) VALUES ($1,$2) RETURNING id', [
            tenant,
            plate('NODEFAULT'),
          ])
        ).rows[0].id;
        return c.query(
          `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at,
                                 currency, open_event_id)
           VALUES ($1,$2,$3,$4,now(),'USD',$5)`,
          [tenant, world.garage, v, world.entryLane, randomUUID()],
        );
      }),
    /entry_confirmation/,
  );
});

test('a session cannot be closed without recording what confirmed the exit', async () => {
  // The constraint, not the route: the two must agree, and this is the half
  // that holds however the row is written.
  const p = plate('CONSTRAINT');
  const opened = await openEntry({
    plate: p,
    entry_at: '2026-08-26T09:00:00Z',
    entry_confirmation: 'confirmed',
  });
  const sessionId = (await opened.json()).session.id;

  await assert.rejects(
    () =>
      withTenant(tenant, (c) =>
        c.query(
          `UPDATE sessions SET exit_at = now(), exit_lane_id = $2, close_event_id = $3,
                               fee_minor = 0, hourly_minor_applied = 0
             WHERE id = $1`,
          [sessionId, world.exitLane, randomUUID()],
        ),
      ),
    /sessions_exit_confirmation_matches_exit/,
  );
});

test('an open session cannot carry an exit confirmation either', async () => {
  const p = plate('OPENEXIT');
  const opened = await openEntry({
    plate: p,
    entry_at: '2026-08-26T09:00:00Z',
    entry_confirmation: 'confirmed',
  });
  const sessionId = (await opened.json()).session.id;

  await assert.rejects(
    () =>
      withTenant(tenant, (c) =>
        c.query(`UPDATE sessions SET exit_confirmation = 'confirmed' WHERE id = $1`, [sessionId]),
      ),
    /sessions_exit_confirmation_matches_exit/,
  );
});

// --- what it counts --------------------------------------------------------

test('the inside-count counts confirmed sessions, and names what it left out', async () => {
  const isolated = await createTenant('counting');
  const theirs = await buildWorld(isolated, { hourlyMinor: 100 });
  const theirEntry = await issueDeviceToken(isolated, theirs.entryLane, 'entry');
  const theirOps = await issueOperatorToken(isolated);

  const openFor = (value) =>
    fetch(
      `${base}/api/v1/lane/sessions/open`,
      post(theirEntry, {
        plate: plate(value.toUpperCase()),
        entry_at: new Date().toISOString(),
        entry_confirmation: value,
      }),
    );

  await openFor('confirmed');
  await openFor('confirmed');
  await openFor('unconfirmable');

  const res = await fetch(
    `${base}/api/v1/garages/${theirs.garage}/sessions/open`,
    asOperator(theirOps),
  );
  const body = await res.json();

  assert.equal(body.inside_count, 2, 'only the confirmed entries count as inside');
  assert.equal(body.unconfirmable_count, 1);
  assert.equal(body.open_count, 3, 'nothing is hidden — the third one is still open');
  assert.equal(body.sessions.length, 3);
  assert.equal(
    body.sessions.filter((s) => s.entry_confirmation === 'unconfirmable').length,
    1,
    'each session says for itself what it rests on',
  );
});

// --- the pending, held and backed-out entries -----------------------------

test('the entries that never became sessions land in events, and nowhere else', async () => {
  // `events` is the right home and needs no new table: it is append-only by
  // grant, it already carries everything else the lane observed, and a held
  // entry is precisely an observation with no money attached. If any of these
  // had produced a session, that would be the phantom occupant.
  const isolated = await createTenant('held');
  const theirs = await buildWorld(isolated);
  const theirEntry = await issueDeviceToken(isolated, theirs.entryLane, 'entry');

  const at = new Date().toISOString();
  const kinds = ['entry_pending', 'entry_held', 'entry_backed_out', 'entry_unconfirmable'];
  const res = await fetch(`${base}/api/v1/lane/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${theirEntry}` },
    body: JSON.stringify({
      events: kinds.map((kind) => ({
        event_id: randomUUID(),
        kind,
        occurred_at: at,
        detail: { reason: 'confirmation_window_elapsed' },
      })),
    }),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: 4, duplicates: 0 });

  const stored = await withTenant(isolated, async (c) =>
    (
      await c.query('SELECT kind FROM events WHERE tenant_id = $1 ORDER BY kind', [isolated])
    ).rows.map((r) => r.kind),
  );
  assert.deepEqual(stored, [...kinds].sort());

  const sessions = await withTenant(isolated, async (c) =>
    (await c.query('SELECT count(*)::int AS n FROM sessions WHERE tenant_id = $1', [isolated]))
      .rows[0].n,
  );
  assert.equal(sessions, 0, 'a pending, held or backed-out entry is not a session');
});
