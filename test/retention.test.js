/**
 * Retention. The decision is: real vehicle identity IS stored, and transient
 * identity is redacted N days after the stay closes — per tenant, default 30.
 * Enrolled vehicles persist while enrolled.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { redactExpiredVehicles, listTenantIds } from '../src/retention.js';

let tenant;
let world;

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY);

async function vehicleWithClosedStay(plate, { closedDaysAgo, enrolled = false }) {
  return withTenant(tenant, async (c) => {
    const v = (
      await c.query(
        `INSERT INTO vehicles (tenant_id, plate, make, model, color, enrolled, last_seen_at)
         VALUES ($1,$2,'Toyota','Corolla','silver',$3,$4) RETURNING id`,
        [tenant, plate, enrolled, ago(closedDaysAgo)],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, exit_lane_id,
                             entry_at, exit_at, currency, fee_minor, hourly_minor_applied,
                             open_event_id, close_event_id,
                             entry_confirmation, exit_confirmation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',250,250,$8,$9,'confirmed','confirmed')`,
      [
        tenant, world.garage, v, world.entryLane, world.exitLane,
        ago(closedDaysAgo + 1), ago(closedDaysAgo), randomUUID(), randomUUID(),
      ],
    );
    return v;
  });
}

const read = (id) =>
  withTenant(tenant, async (c) =>
    (await c.query('SELECT plate, make, model, color, redacted_at FROM vehicles WHERE id = $1', [id]))
      .rows[0],
  );

before(async () => {
  tenant = await createTenant('ret');
  world = await buildWorld(tenant);
});
after(async () => {
  await pool.end();
});

test('the default retention window is 30 days, from one place only', async () => {
  const days = await withTenant(tenant, async (c) =>
    (await c.query('SELECT vehicle_retention_days FROM tenant_settings WHERE tenant_id = $1', [tenant]))
      .rows[0],
  );
  assert.equal(days, undefined, 'no row yet — the default lives in the column, not in a second place');
  const result = await redactExpiredVehicles(tenant, { dryRun: true });
  assert.equal(result.retentionDays, 30);
});

test('a stay older than the window is redacted', async () => {
  const id = await vehicleWithClosedStay(`OLD-${randomUUID().slice(0, 8)}`, { closedDaysAgo: 40 });
  const before = await read(id);
  assert.equal(before.make, 'Toyota');

  const result = await redactExpiredVehicles(tenant);
  assert.ok(result.redacted >= 1);

  const after = await read(id);
  assert.match(after.plate, /^redacted:/, 'the plate is replaced, not kept');
  assert.equal(after.make, null);
  assert.equal(after.model, null);
  assert.equal(after.color, null);
  assert.ok(after.redacted_at, 'and the fact of redaction is recorded');
});

test('a recent stay is left alone — the control on the test above', async () => {
  const id = await vehicleWithClosedStay(`NEW-${randomUUID().slice(0, 8)}`, { closedDaysAgo: 3 });
  await redactExpiredVehicles(tenant);
  const after = await read(id);
  assert.equal(after.redacted_at, null);
  assert.equal(after.make, 'Toyota', 'a vehicle inside the window keeps its identity');
});

test('an enrolled vehicle persists however old the stay', async () => {
  const id = await vehicleWithClosedStay(`ENROLLED-${randomUUID().slice(0, 8)}`, {
    closedDaysAgo: 400,
    enrolled: true,
  });
  await redactExpiredVehicles(tenant);
  const after = await read(id);
  assert.equal(after.redacted_at, null);
  assert.equal(after.make, 'Toyota', 'enrolment is a standing credential; retention does not apply');
});

test('a vehicle still inside the garage is never redacted', async () => {
  const id = await withTenant(tenant, async (c) => {
    const v = (
      await c.query(
        `INSERT INTO vehicles (tenant_id, plate, make, last_seen_at)
         VALUES ($1,$2,'Toyota',$3) RETURNING id`,
        [tenant, `INSIDE-${randomUUID().slice(0, 8)}`, ago(400)],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency,
                             open_event_id, entry_confirmation)
       VALUES ($1,$2,$3,$4,$5,'USD',$6,'confirmed')`,
      [tenant, world.garage, v, world.entryLane, ago(400), randomUUID()],
    );
    return v;
  });
  await redactExpiredVehicles(tenant);
  const after = await read(id);
  assert.equal(after.redacted_at, null, 'a car that has not left cannot have its identity removed');
});

test('redaction keeps the financial record — this is why it is not deletion', async () => {
  const plate = `MONEY-${randomUUID().slice(0, 8)}`;
  const id = await vehicleWithClosedStay(plate, { closedDaysAgo: 90 });
  await redactExpiredVehicles(tenant);

  const session = await withTenant(tenant, async (c) =>
    (await c.query('SELECT fee_minor, entry_at, exit_at FROM sessions WHERE vehicle_id = $1', [id]))
      .rows[0],
  );
  assert.ok(session, 'the session must still exist — sessions cascade on vehicle delete');
  assert.equal(Number(session.fee_minor), 250, 'and it must still carry what was charged');
});

test('the window is per tenant, and shortening it takes effect', async () => {
  const id = await vehicleWithClosedStay(`SHORT-${randomUUID().slice(0, 8)}`, { closedDaysAgo: 10 });
  await redactExpiredVehicles(tenant);
  assert.equal((await read(id)).redacted_at, null, 'still inside the default 30 days');

  await withTenant(tenant, (c) =>
    c.query(
      `INSERT INTO tenant_settings (tenant_id, vehicle_retention_days) VALUES ($1, 7)
       ON CONFLICT (tenant_id) DO UPDATE SET vehicle_retention_days = 7`,
      [tenant],
    ),
  );
  await redactExpiredVehicles(tenant);
  assert.ok((await read(id)).redacted_at, 'at 7 days it is now outside the window');
});

test('a ticket reference is redacted exactly as a plate is', async () => {
  // A ticket is identity too — a code a driver read out loud, minted for one
  // arrival. It ages out on the same window, under the same never-redact
  // rules, and it must not be the one column the purge leaves behind.
  const ref = `TKT-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const id = await withTenant(tenant, async (c) => {
    const v = (
      await c.query(
        `INSERT INTO vehicles (tenant_id, ticket_ref, last_seen_at) VALUES ($1,$2,$3) RETURNING id`,
        [tenant, ref, ago(400)],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, exit_lane_id,
                             entry_at, exit_at, currency, fee_minor, hourly_minor_applied,
                             open_event_id, close_event_id,
                             entry_confirmation, exit_confirmation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',250,250,$8,$9,'confirmed','confirmed')`,
      [
        tenant, world.garage, v, world.entryLane, world.exitLane,
        ago(401), ago(400), randomUUID(), randomUUID(),
      ],
    );
    return v;
  });

  await redactExpiredVehicles(tenant);

  const after = await withTenant(tenant, async (c) =>
    (
      await c.query('SELECT plate, ticket_ref, redacted_at FROM vehicles WHERE id = $1', [id])
    ).rows[0],
  );
  assert.match(after.ticket_ref, /^redacted:/, 'the ticket is replaced, not kept');
  assert.ok(after.redacted_at);
  // And the row still carries EXACTLY ONE identity, which is what
  // `vehicles_exactly_one_identity` requires: writing the placeholder into both
  // columns would fail the whole purge, and into neither would leave nothing to
  // hold the unique index.
  assert.equal(after.plate, null, 'redaction must not give a ticket vehicle a plate');

  // THE CONTROL: a ticket inside the window keeps its value, so the assertion
  // above is the window doing its job and not a purge that redacts everything.
  const fresh = `TKT-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const keep = await withTenant(tenant, async (c) =>
    (
      await c.query(
        `INSERT INTO vehicles (tenant_id, ticket_ref, last_seen_at) VALUES ($1,$2,$3) RETURNING id`,
        [tenant, fresh, ago(1)],
      )
    ).rows[0].id,
  );
  await redactExpiredVehicles(tenant);
  const untouched = await withTenant(tenant, async (c) =>
    (await c.query('SELECT ticket_ref FROM vehicles WHERE id = $1', [keep])).rows[0],
  );
  assert.equal(untouched.ticket_ref, fresh);
});

test('redaction is idempotent', async () => {
  const first = await redactExpiredVehicles(tenant);
  const second = await redactExpiredVehicles(tenant);
  assert.equal(second.redacted, 0, 'nothing is redacted twice');
  assert.ok(first.redacted >= 0);
});

test('maintenance can enumerate tenants without a superuser', async () => {
  // tenants is FORCED, so neither the app role nor the owner can list it. The
  // definer function is the whole reason the purge does not need a superuser.
  const ids = await listTenantIds(pool);
  assert.ok(ids.includes(tenant));
});
