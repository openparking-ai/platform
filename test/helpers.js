import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pool, withTenant } from '../src/db.js';

/**
 * A connection to the test database as the SUPERUSER (SUPERUSER_URL), which
 * sees every row: for a test that looks across accounts, or puts a row in
 * place by hand, the way no role of a deployment can. The owner is NOSUPERUSER
 * and NOBYPASSRLS, and FORCE binds it like anyone (0031), so it is not that.
 * Not connected; the caller connects and ends it.
 */
export function superuserClient() {
  const url = new URL(process.env.SUPERUSER_URL);
  url.pathname = new URL(process.env.APP_DATABASE_URL).pathname;
  return new pg.Client({ connectionString: url.toString() });
}

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
 * State a garage's taxes directly, as the database's side of the store would
 * have them (0022): one set, its `rule_count`, and its rules. `rules: []` is
 * the statement "this garage charges no tax". Tests of the route and its
 * refusals are in test/taxes.test.js.
 */
/**
 * What a lane reports of its cache when it holds exactly the set `stateTaxes`
 * states by default (0023): one set, and its instant as `/lane/rules` serves it.
 */
export const DEFAULT_TAXES_HELD = Object.freeze({ count: 1, newest_effective_from: '2000-01-01T00:00:00.000000Z' });

export async function stateTaxes(client, tenantId, garageId, { rules = [], effectiveFrom = '2000-01-01T00:00:00Z' } = {}) {
  const set = (
    await client.query(
      `INSERT INTO garage_tax_sets (tenant_id, garage_id, effective_from, rule_count)
       VALUES ($1, $2, $3::timestamptz, $4) RETURNING id`,
      [tenantId, garageId, effectiveFrom, rules.length],
    )
  ).rows[0].id;
  for (const r of rules) {
    await client.query(
      `INSERT INTO garage_tax_rules (tenant_id, tax_set_id, rule_id, label, percent_bp, rounding, sequence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, set, r.id, r.label, r.percent_bp, r.rounding, r.sequence],
    );
  }
  return set;
}

/**
 * Activate a garage directly: state its transient mode and set
 * `activated_at`, through the trigger that checks the gate's conditions
 * (0014, 0022) -- so a world that could not activate through the route
 * cannot activate here either. Tests of the gate itself go through the route.
 *
 * A garage that has stated no taxes is made to state NONE first, in so many
 * words (a set with no rules): these worlds exist to exercise lanes and
 * closes, and a set with no rules taxes nothing, so their fees are the
 * engine's alone. A garage that already stated its taxes keeps what it
 * stated -- and is taxed by it (0023).
 */
export async function activateGarage(client, tenantId, garageId, { transientAvailable = true } = {}) {
  const stated = await client.query(
    'SELECT 1 FROM garage_tax_sets WHERE tenant_id = $1 AND garage_id = $2 LIMIT 1',
    [tenantId, garageId],
  );
  if (stated.rows.length === 0) await stateTaxes(client, tenantId, garageId);
  await client.query(
    `UPDATE garages SET transient_available = $3, activated_at = now() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, garageId, transientAvailable],
  );
}

/**
 * One garage with both lanes, a vehicle, a rate and a flat plan, ACTIVE —
 * enough to exercise everything. `plan: false` builds a garage that cannot
 * price and therefore cannot activate; `active: false` leaves an otherwise
 * ready garage inactive.
 */
export async function buildWorld(tenantId, { hourlyMinor = 250, currency = 'USD', plan = true, active = true } = {}) {
  return withTenant(tenantId, async (client) => {
    const garage = (
      await client.query(
        `INSERT INTO garages (tenant_id, name, timezone, currency)
         VALUES ($1, 'Test Garage', 'America/New_York', $2) RETURNING id`,
        [tenantId, currency],
      )
    ).rows[0].id;
    if (plan) await storePlan(client, tenantId, garage, flatHourlyPlan({ hourlyMinor, currency }));
    if (plan && active) await activateGarage(client, tenantId, garage);

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
