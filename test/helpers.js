import { randomUUID } from 'node:crypto';
import { pool, withTenant } from '../src/db.js';

/**
 * Create a tenant using the application connection.
 *
 * The id is generated here rather than by the column default, because the
 * tenants policy is `WITH CHECK (id = current_tenant_id())` -- the row can only
 * be written by a connection already claiming to be that tenant. Seeding this
 * way exercises the policy instead of stepping around it, and behaves the same
 * whoever owns the database.
 */
export async function createTenant(name = 'tenant') {
  const id = randomUUID();
  await withTenant(id, (client) =>
    client.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [
      id,
      `${name}-${id.slice(0, 8)}`,
      name,
    ]),
  );
  return id;
}

/**
 * A flat hourly plan in the engine's document shape: `hourlyMinor` for the
 * first hour and every hour after, rounded up, no maximum. The same fee the
 * old `computeFee` gave for whole hours, so the suite's numbers stand -- and
 * the engine's for the rest, which is the point.
 */
export function flatHourlyPlan({ hourlyMinor = 250, currency = 'USD', spaceClass = 'standard', version = null, effectiveFrom = '2000-01-01T00:00:00Z' } = {}) {
  return {
    plan_version: version ?? `flat-${hourlyMinor}-${currency}`,
    effective_from: effectiveFrom,
    timezone: 'America/New_York',
    currency,
    space_classes: [spaceClass],
    resolution: { QUALIFY: { mode: 'cheapest_wins' }, ACCUMULATE: { mode: 'cheapest_wins' } },
    adjust_order: null,
    rules: [
      {
        id: 'hourly',
        type: 'increment',
        stage: 'ACCUMULATE',
        space_classes: [spaceClass],
        first_period_minutes: 60,
        first_period_minor: hourlyMinor,
        repeat_period_minutes: 60,
        repeat_period_minor: hourlyMinor,
        rounding: 'ceil',
        max_duration_minutes: null,
      },
    ],
    decisions: [],
  };
}

/**
 * Store a plan document for a garage directly, as the database's side of the
 * store would have it. The engine is not asked -- these are worlds for tests
 * that need a garage that prices, and test/rate-plans.test.js is where the
 * route and the engine's validation are exercised.
 */
export async function storePlan(client, tenantId, garageId, document) {
  return (
    await client.query(
      `INSERT INTO rate_plans (tenant_id, garage_id, plan_version, effective_from, document, engine_schema_version)
       VALUES ($1, $2, $3::jsonb->>'plan_version', ($3::jsonb->>'effective_from')::timestamptz, $3::jsonb, 1)
       RETURNING id`,
      [tenantId, garageId, JSON.stringify(document)],
    )
  ).rows[0].id;
}

/**
 * One garage with both lanes, a vehicle, a rate and a flat plan — enough to
 * exercise everything. `plan: false` builds a garage that cannot price.
 */
export async function buildWorld(tenantId, { hourlyMinor = 250, currency = 'USD', plan = true } = {}) {
  return withTenant(tenantId, async (client) => {
    const garage = (
      await client.query(
        `INSERT INTO garages (tenant_id, name, timezone, currency)
         VALUES ($1, 'Test Garage', 'America/New_York', $2) RETURNING id`,
        [tenantId, currency],
      )
    ).rows[0].id;
    if (plan) await storePlan(client, tenantId, garage, flatHourlyPlan({ hourlyMinor, currency }));

    const lane = async (name, direction) =>
      (
        await client.query(
          `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`,
          [tenantId, garage, name, direction],
        )
      ).rows[0].id;

    const entryLane = await lane('Entry 1', 'entry');
    const exitLane = await lane('Exit 1', 'exit');

    const vehicle = (
      await client.query(
        `INSERT INTO vehicles (tenant_id, plate) VALUES ($1, $2) RETURNING id`,
        [tenantId, `PLATE-${tenantId.slice(0, 6)}`],
      )
    ).rows[0].id;

    const rate = (
      await client.query(
        `INSERT INTO rates (tenant_id, garage_id, name, hourly_minor) VALUES ($1,$2,'Hourly',$3) RETURNING id`,
        [tenantId, garage, hourlyMinor],
      )
    ).rows[0].id;

    return { tenantId, garage, entryLane, exitLane, vehicle, rate, currency, hourlyMinor };
  });
}

export { pool, withTenant };
