/**
 * A stay can be identified by a TICKET instead of a plate.
 *
 * The camera used to be the only way into the record. A driver whose plate
 * could not be read had no identity for a session to be opened on, so the
 * intercom had nothing to hand the platform even after a human had decided to
 * let the car in. `vehicles` now carries EXACTLY ONE of a plate or a ticket
 * reference, and every route that opens, finds or closes a stay takes either.
 *
 * What this file measures, and each of them has a break in
 * `scripts/ticket-identity-fail-control.js`:
 *
 *   * exactly one of the two, at the request boundary AND at the constraint;
 *   * a ticket is unique per tenant, exactly as a plate is;
 *   * a ticket stay can be FOUND and CLOSED at the exit — without which the
 *     round ships a car that gets in and a stay that never bills;
 *   * a lane that sends only a plate is unchanged, which is the control on all
 *     of the above;
 *   * this platform verifies a ticket's SHAPE and nothing else, and says so.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

/** A ticket in the shape the agent will mint: upper case, digits, hyphen. */
const ticket = () => `TKT-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
const plate = () => `TP${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;

const openStay = (body) => fetch(`${base}/api/v1/lane/sessions/open`, post(entryToken, body));
const closeStay = (body) => fetch(`${base}/api/v1/lane/sessions/close`, post(exitToken, body));
const findOpen = (query) =>
  fetch(`${base}/api/v1/lane/sessions/open?${query}`, {
    headers: { authorization: `Bearer ${exitToken}` },
  });

/** Half an hour, so a stay bills exactly one hour: any part-hour is a full one. */
const halfAnHourAgo = () => new Date(Date.now() - 1800_000).toISOString();

before(async () => {
  tenant = await createTenant('ticket');
  world = await buildWorld(tenant, { hourlyMinor: 250 });
  entryToken = await issueDeviceToken(tenant, world.entryLane, 'entry device');
  exitToken = await issueDeviceToken(tenant, world.exitLane, 'exit device');
  operatorToken = await issueOperatorToken(tenant);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

// --- exactly one of the two -----------------------------------------------

test('a stay opens on a ticket, and the row carries the ticket and no plate', async () => {
  const ref = ticket();
  const res = await openStay({
    ticket_ref: ref,
    entry_at: halfAnHourAgo(),
    entry_confirmation: 'confirmed',
  });
  assert.equal(res.status, 201);
  const { session } = await res.json();

  const vehicle = await withTenant(tenant, async (c) =>
    (await c.query('SELECT plate, ticket_ref FROM vehicles WHERE id = $1', [session.vehicle_id]))
      .rows[0],
  );
  assert.equal(vehicle.ticket_ref, ref);
  assert.equal(vehicle.plate, null, 'a ticket identity invents no plate');
});

test('both identities on one request is refused, and the refusal names the rule', async () => {
  const res = await openStay({
    plate: plate(),
    ticket_ref: ticket(),
    entry_at: halfAnHourAgo(),
    entry_confirmation: 'confirmed',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /exactly one of plate or ticket_ref/);
  assert.match(body.error, /both/, 'the refusal says which of the two mistakes was made');
});

test('neither identity is refused by the same rule', async () => {
  const res = await openStay({ entry_at: halfAnHourAgo(), entry_confirmation: 'confirmed' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /exactly one of plate or ticket_ref/);
  assert.match(body.error, /neither/);
});

test('the database refuses both and neither too, not only the route', async () => {
  // The route is one way in. The constraint is the property.
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query('INSERT INTO vehicles (tenant_id, plate, ticket_ref) VALUES ($1,$2,$3)', [
        tenant,
        plate(),
        ticket(),
      ]),
    ),
    (err) => err.code === '23514',
    'a row carrying both must violate vehicles_exactly_one_identity',
  );
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query('INSERT INTO vehicles (tenant_id) VALUES ($1)', [tenant]),
    ),
    (err) => err.code === '23514',
    'a row carrying neither must violate it as well',
  );
  // THE CONTROL: exactly one is accepted by the same statement shape, so the
  // two rejections above are the constraint and not a broken INSERT.
  await withTenant(tenant, (c) =>
    c.query('INSERT INTO vehicles (tenant_id, ticket_ref) VALUES ($1,$2)', [tenant, ticket()]),
  );
});

// --- the shape, and the honesty about what is not checked ------------------

test('a ticket outside the closed alphabet or the length bound is refused', async () => {
  for (const ref of ['tkt-lowercase-1', 'TKT_UNDERSCORE', 'SHORT', 'X'.repeat(65), 'TKT REF']) {
    const res = await openStay({
      ticket_ref: ref,
      entry_at: halfAnHourAgo(),
      entry_confirmation: 'confirmed',
    });
    assert.equal(res.status, 400, `${JSON.stringify(ref)} should not be a ticket_ref`);
    assert.match((await res.json()).error, /A-Z, 0-9 and hyphen/);
  }
  // THE CONTROL: a value that IS in the alphabet, at both bounds, is accepted —
  // otherwise the loop above passes against a rule that refuses everything.
  for (const ref of ['A1-2B3', 'T'.repeat(64)]) {
    const res = await openStay({
      ticket_ref: ref,
      entry_at: halfAnHourAgo(),
      entry_confirmation: 'confirmed',
    });
    assert.equal(res.status, 201, `${ref} is inside the bound and must be accepted`);
  }
});

// --- the TYPE, before the shape --------------------------------------------

test('a ticket_ref that is not a string is refused, and never coerced into one', async () => {
  // `String(["ABCDEF"])` is "ABCDEF", so a coercion in front of the regex makes
  // the shape rule read a value the caller never sent — and opens a stay on it.
  // `lane-controller`'s contract.py publishes a claim that this platform's copy
  // of the rule fails in the safe direction; the type is the half that was not
  // true of it.
  for (const ref of [['ABCDEF'], 123456, { toString: () => 'ABCDEF' }, true]) {
    const res = await openStay({
      ticket_ref: ref,
      entry_at: halfAnHourAgo(),
      entry_confirmation: 'confirmed',
    });
    assert.equal(res.status, 400, `${JSON.stringify(ref)} is not a string and is not a ticket_ref`);
    assert.match((await res.json()).error, /must be a string/);
  }
  // THE CONTROL: the same request with a real string is accepted, so the four
  // refusals above are the type test and not a route that refuses everything.
  const res = await openStay({
    ticket_ref: ticket(),
    entry_at: halfAnHourAgo(),
    entry_confirmation: 'confirmed',
  });
  assert.equal(res.status, 201);
});

test('a plate has a shape rule now: a string, not blank, bounded', async () => {
  // AN ADDITION. Until this round `plate` had no rule of any kind: a 4 kB plate
  // and a plate of three spaces both opened a stay. It is a bound and not an
  // alphabet — this platform does not know the world's plate formats.
  for (const value of [['ABC123'], 7, '   ', '\t\n ', 'P'.repeat(33)]) {
    const res = await openStay({
      plate: value,
      entry_at: halfAnHourAgo(),
      entry_confirmation: 'confirmed',
    });
    assert.equal(res.status, 400, `${JSON.stringify(value)} is not a plate`);
    assert.match((await res.json()).error, /plate must be a string/);
  }
  // THE CONTROL: an ordinary plate, and one exactly at the bound, are accepted.
  for (const value of [plate(), 'P'.repeat(32)]) {
    const res = await openStay({
      plate: value,
      entry_at: halfAnHourAgo(),
      entry_confirmation: 'confirmed',
    });
    assert.equal(res.status, 201, `${value} is inside the bound and must be accepted`);
  }
});

// --- the constraint matches the route --------------------------------------

test('an empty string is not an identity at the constraint either', async () => {
  // `'' IS NULL` is false, so 0007's XOR alone counted the empty string as an
  // identity: a row with a plate column that is not null and holds nothing.
  // Migration 0008 is what makes "exactly one" mean one that is there.
  for (const [column, value] of [
    ['ticket_ref', ''],
    ['plate', ''],
  ]) {
    await assert.rejects(
      withTenant(tenant, (c) =>
        c.query(`INSERT INTO vehicles (tenant_id, ${column}) VALUES ($1,$2)`, [tenant, value]),
      ),
      (err) => err.code === '23514',
      `an empty ${column} must violate vehicles_exactly_one_identity`,
    );
  }
  // THE CONTROLS: the same statement shape with a real value is accepted in
  // both columns, so the two rejections are the constraint and not a broken
  // INSERT — and the route's own refusal is unchanged.
  await withTenant(tenant, (c) =>
    c.query('INSERT INTO vehicles (tenant_id, ticket_ref) VALUES ($1,$2)', [tenant, ticket()]),
  );
  await withTenant(tenant, (c) =>
    c.query('INSERT INTO vehicles (tenant_id, plate) VALUES ($1,$2)', [tenant, plate()]),
  );
});

test('the redaction still satisfies the constraint it was written under', async () => {
  // 0007 put no shape check in the database because the purge writes
  // `redacted:<row id>` into whichever column the row carries. 0008 adds a
  // non-empty test rather than a shape, so that value still satisfies it.
  const id = await withTenant(tenant, async (c) =>
    (
      await c.query(
        'INSERT INTO vehicles (tenant_id, ticket_ref) VALUES ($1,$2) RETURNING id',
        [tenant, ticket()],
      )
    ).rows[0].id,
  );
  await withTenant(tenant, (c) =>
    c.query(`UPDATE vehicles SET ticket_ref = 'redacted:' || id WHERE id = $1`, [id]),
  );
  const row = await withTenant(tenant, async (c) =>
    (await c.query('SELECT plate, ticket_ref FROM vehicles WHERE id = $1', [id])).rows[0],
  );
  assert.equal(row.plate, null);
  assert.equal(row.ticket_ref, `redacted:${id}`);
});

// --- uniqueness ------------------------------------------------------------

test('a ticket is unique per tenant: the same ref is the same vehicle', async () => {
  const ref = ticket();
  const first = await openStay({
    ticket_ref: ref,
    entry_at: halfAnHourAgo(),
    entry_confirmation: 'confirmed',
  });
  assert.equal(first.status, 201);
  // A DIFFERENT event id, so this is not the idempotency key answering. The
  // vehicle is the same vehicle, so the stay already open is the answer.
  const again = await openStay({
    ticket_ref: ref,
    entry_at: halfAnHourAgo(),
    entry_confirmation: 'confirmed',
  });
  assert.equal(again.status, 200);
  const [a, b] = [await first.json(), await again.json()];
  assert.equal(b.created, false);
  assert.equal(b.session.id, a.session.id);
  assert.equal(b.session.vehicle_id, a.session.vehicle_id);
});

test('the same ticket in another tenant is another vehicle', async () => {
  const ref = ticket();
  const other = await createTenant('ticket-other');
  await buildWorld(other);
  await withTenant(tenant, (c) =>
    c.query('INSERT INTO vehicles (tenant_id, ticket_ref) VALUES ($1,$2)', [tenant, ref]),
  );
  // The unique index is (tenant_id, ticket_ref), so this must not collide.
  await withTenant(other, (c) =>
    c.query('INSERT INTO vehicles (tenant_id, ticket_ref) VALUES ($1,$2)', [other, ref]),
  );
  // And within one tenant it does — the control on the line above.
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query('INSERT INTO vehicles (tenant_id, ticket_ref) VALUES ($1,$2)', [tenant, ref]),
    ),
    (err) => err.code === '23505',
  );
});

// --- the exit --------------------------------------------------------------

test('a ticket stay is found and closed at the exit', async () => {
  const ref = ticket();
  const opened = await openStay({
    ticket_ref: ref,
    entry_at: halfAnHourAgo(),
    entry_confirmation: 'confirmed',
  });
  assert.equal(opened.status, 201);
  const openedSession = (await opened.json()).session;

  const found = await findOpen(`ticket_ref=${ref}`);
  assert.equal(found.status, 200, 'the exit lane must be able to name the stay it is closing');
  assert.equal((await found.json()).session.id, openedSession.id);

  const closed = await closeStay({
    ticket_ref: ref,
    exit_at: new Date().toISOString(),
    exit_confirmation: 'confirmed',
    session_id: openedSession.id,
  });
  assert.equal(closed.status, 200);
  const body = await closed.json();
  assert.equal(body.closed, true);
  assert.equal(body.session.id, openedSession.id);
  assert.equal(body.session.fee_minor, 250, 'and the stay bills — a part-hour at 250');
});

test('a plate lookup never answers with a ticket stay, or the other way round', async () => {
  // The hazard a single `v.plate = $3 OR v.ticket_ref = $3` would create: one
  // lookup matching two different vehicles across two columns, at the moment a
  // lane is deciding whose stay to close.
  const shared = 'SHARED123';
  await openStay({
    ticket_ref: shared,
    entry_at: halfAnHourAgo(),
    entry_confirmation: 'confirmed',
  });
  const byPlate = await findOpen(`plate=${shared}`);
  assert.equal(byPlate.status, 404, 'a plate must not match a ticket of the same text');
  // THE CONTROL: the same text, asked as a ticket, is found.
  assert.equal((await findOpen(`ticket_ref=${shared}`)).status, 200);
});

test('the exit lookup applies the same exactly-one rule to its query string', async () => {
  const both = await findOpen(`plate=${plate()}&ticket_ref=${ticket()}`);
  assert.equal(both.status, 400);
  assert.match((await both.json()).error, /exactly one of plate or ticket_ref .*query string/);
  const neither = await findOpen('');
  assert.equal(neither.status, 400);
});

// --- what an operator sees -------------------------------------------------

test('the open-sessions listing carries the ticket, not a blank where a plate was', async () => {
  const ref = ticket();
  await openStay({ ticket_ref: ref, entry_at: halfAnHourAgo(), entry_confirmation: 'confirmed' });
  const res = await fetch(
    `${base}/api/v1/garages/${world.garage}/sessions/open`,
    asOperator(operatorToken),
  );
  assert.equal(res.status, 200);
  const { sessions } = await res.json();
  const row = sessions.find((s) => s.ticket_ref === ref);
  assert.ok(row, 'a ticket stay must be identifiable in the listing it appears in');
  assert.equal(row.plate, null);
  // THE CONTROL: a plate stay in the same listing still shows its plate, so
  // this is not a listing that lost both columns.
  const withPlate = plate();
  await openStay({ plate: withPlate, entry_at: halfAnHourAgo(), entry_confirmation: 'confirmed' });
  const second = await fetch(
    `${base}/api/v1/garages/${world.garage}/sessions/open`,
    asOperator(operatorToken),
  );
  assert.ok((await second.json()).sessions.some((s) => s.plate === withPlate));
});

// --- the lane that has not changed ----------------------------------------

test('a lane that sends only a plate is unchanged, end to end', async () => {
  const p = plate();
  const opened = await openStay({
    plate: p,
    plate_region: 'TR',
    entry_at: halfAnHourAgo(),
    entry_confirmation: 'confirmed',
  });
  assert.equal(opened.status, 201);
  const session = (await opened.json()).session;

  const vehicle = await withTenant(tenant, async (c) =>
    (
      await c.query('SELECT plate, plate_region, ticket_ref FROM vehicles WHERE id = $1', [
        session.vehicle_id,
      ])
    ).rows[0],
  );
  assert.equal(vehicle.plate, p);
  assert.equal(vehicle.plate_region, 'TR');
  assert.equal(vehicle.ticket_ref, null, 'no ticket is invented for a plate identity');

  assert.equal((await findOpen(`plate=${p}`)).status, 200);
  const closed = await closeStay({
    plate: p,
    exit_at: new Date().toISOString(),
    exit_confirmation: 'confirmed',
  });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).session.fee_minor, 250);
});

// --- the event the lane's assisted vend writes -----------------------------

test('assisted_identity is a kind this platform accepts', async () => {
  // The lane records it BEFORE it pulses the relay. A platform that refused the
  // kind would dead-letter the one event that says a human authorised an open.
  assert.ok(LANE_EVENT_KINDS.includes('assisted_identity'));
  const res = await fetch(
    `${base}/api/v1/lane/events`,
    post(entryToken, {
      events: [
        {
          event_id: randomUUID(),
          kind: 'assisted_identity',
          occurred_at: new Date().toISOString(),
          detail: { identity_kind: 'ticket', authorised_by: 'human_open_now' },
        },
      ],
    }),
  );
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: 1, duplicates: 0 });

  // THE CONTROL: a kind no lane emits is still refused, so the acceptance above
  // is this kind being known rather than the endpoint taking anything.
  const invented = await fetch(
    `${base}/api/v1/lane/events`,
    post(entryToken, {
      events: [
        {
          event_id: randomUUID(),
          kind: 'assisted_identity_but_not_really',
          occurred_at: new Date().toISOString(),
        },
      ],
    }),
  );
  assert.equal(invented.status, 400);
});
