/**
 * The registry of tenant-owned tables and how to put one row in each.
 *
 * This exists so the isolation suite is written ONCE and runs against every
 * table, rather than being copy-pasted per table. The foundation's suite named
 * `parking_sites` nine times; that pattern does not survive six more tables
 * without one of them quietly ending up untested.
 *
 * Adding a table here is how it gets isolation coverage. Forgetting to is
 * caught separately by test/rls-coverage.test.js, which walks the schema
 * itself rather than this list.
 */

export const TENANT_TABLES = [
  {
    table: 'garages',
    insert: (c, t) =>
      c.query(
        `INSERT INTO garages (tenant_id, name, timezone, currency)
         VALUES ($1, 'Row', 'UTC', 'USD') RETURNING id`,
        [t],
      ),
  },
  {
    table: 'lanes',
    insert: (c, t, w) =>
      c.query(
        `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,'Row','entry') RETURNING id`,
        [t, w.garage],
      ),
  },
  {
    table: 'vehicles',
    insert: (c, t) =>
      c.query(`INSERT INTO vehicles (tenant_id, plate) VALUES ($1, 'ROW-' || gen_random_uuid()) RETURNING id`, [t]),
  },
  {
    table: 'rates',
    insert: (c, t, w) =>
      c.query(
        `INSERT INTO rates (tenant_id, garage_id, name, hourly_minor) VALUES ($1,$2,'Row',100) RETURNING id`,
        [t, w.garage],
      ),
  },
  {
    table: 'sessions',
    // Each row gets its own vehicle: sessions_one_open_per_vehicle allows only
    // one open session per vehicle per garage, so reusing one would collide
    // with the index rather than with a policy — and the test would then be
    // measuring the index, not isolation.
    insert: (c, t, w) =>
      c.query(
        `WITH v AS (
           INSERT INTO vehicles (tenant_id, plate) VALUES ($1, 'S-' || gen_random_uuid()) RETURNING id
         )
         INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency, open_event_id)
         SELECT $1, $2, v.id, $3, now() - interval '1 hour', 'USD', gen_random_uuid()::text FROM v
         RETURNING id`,
        [t, w.garage, w.entryLane],
      ),
  },
  {
    table: 'events',
    insert: (c, t, w) =>
      c.query(
        `INSERT INTO events (tenant_id, garage_id, lane_id, event_id, kind, occurred_at)
         VALUES ($1,$2,$3, gen_random_uuid()::text, 'probe', now()) RETURNING id`,
        [t, w.garage, w.entryLane],
      ),
    // Append-only: the app role has no UPDATE or DELETE grant, so those two
    // assertions do not apply. That the grants are actually absent is asserted
    // in rls-coverage.test.js rather than assumed here.
    appendOnly: true,
  },
  {
    table: 'tenant_settings',
    insert: (c, t) =>
      c.query(
        `INSERT INTO tenant_settings (tenant_id, vehicle_retention_days) VALUES ($1, 30)
         ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now() RETURNING tenant_id AS id`,
        [t],
      ),
    // One row per tenant by construction, so there is no second row to plant.
    singleton: true,
  },
  {
    table: 'operator_tokens',
    insert: (c, t) =>
      c.query(
        `INSERT INTO operator_tokens (tenant_id, name, token_hash)
         VALUES ($1,'Row', md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)) RETURNING id`,
        [t],
      ),
  },
  {
    table: 'lane_devices',
    insert: (c, t, w) =>
      c.query(
        `INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash)
         VALUES ($1,$2,'Row', md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)) RETURNING id`,
        [t, w.entryLane],
      ),
  },
];

/**
 * Tables that legitimately have no tenant_id, and why.
 *
 * The guard requires every table in the schema to be either tenant-owned and
 * protected, or named here. A table that is neither fails CI. Without this list
 * the guard only inspects tables that already have a tenant_id -- so a new
 * table that forgets the column entirely is invisible to it, which is the one
 * case most worth catching. Measured before this existed: a `permits` table
 * holding a plate, readable by every tenant, and the suite stayed green 7/7.
 */
export const TABLES_WITHOUT_TENANT_ID = {
  schema_migrations: 'migration bookkeeping; global to the database by definition',
  tenants: 'the tenant registry itself — scoped by its own id, not by a tenant_id column',
};

/**
 * Tables that are ENABLE ROW LEVEL SECURITY but deliberately NOT FORCE.
 *
 * BOTH are credential-resolution tables, and they are on this list for the one
 * reason the RLS template cannot express: a credential is presented and the
 * tenant that owns it is precisely what the lookup exists to discover, so no
 * tenant policy can gate it. Nothing else may join this list without the same
 * argument.
 * See migration 0002 for why lane_devices is the exception, and
 * rls-coverage.test.js for the assertion that it is the ONLY one.
 */
export const NOT_FORCED_BY_DESIGN = ['lane_devices', 'operator_tokens'];
