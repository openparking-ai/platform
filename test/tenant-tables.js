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
         INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency,
                               open_event_id, entry_confirmation)
         SELECT $1, $2, v.id, $3, now() - interval '1 hour', 'USD', gen_random_uuid()::text,
                'confirmed' FROM v
         RETURNING id`,
        [t, w.garage, w.entryLane],
      ),
  },
  {
    table: 'shadow_searches',
    // Each row closes its own stay, and the unique key is the close event, so
    // rows do not collide with anything but a policy.
    insert: (c, t, w) =>
      c.query(
        `WITH v AS (
           INSERT INTO vehicles (tenant_id, plate) VALUES ($1, 'SH-' || gen_random_uuid()) RETURNING id
         ), s AS (
           INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency,
                                 open_event_id, entry_confirmation)
           SELECT $1, $2, v.id, $3, now() - interval '1 hour', 'USD', gen_random_uuid()::text,
                  'confirmed' FROM v
           RETURNING id
         )
         INSERT INTO shadow_searches (tenant_id, garage_id, session_id, close_event_id, candidate_ids,
                                      candidates_open, candidates_with_descriptor, true_stay_comparable)
         SELECT $1, $2, s.id, gen_random_uuid()::text, ARRAY[s.id], 1, 1, true FROM s
         RETURNING id`,
        [t, w.garage, w.entryLane],
      ),
  },
  {
    table: 'rate_plans',
    // A document the STORE would accept from the database's side: the version
    // and the instant are unique per garage, and the currency is the world's
    // garage's, which the trigger checks. What the engine would say about it
    // is the route's business, not this table's.
    insert: (c, t, w) => {
      const version = `Row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const at = new Date(Date.now() - Math.floor(Math.random() * 1e9)).toISOString();
      return c.query(
        `INSERT INTO rate_plans (tenant_id, garage_id, plan_version, effective_from, document, engine_schema_version)
         VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, 1) RETURNING id`,
        [t, w.garage, version, at,
         JSON.stringify({ plan_version: version, effective_from: at, currency: w.currency })],
      );
    },
    // Append-only by grant, like events; that the grants are absent is
    // asserted in rate-plans.test.js rather than assumed here.
    appendOnly: true,
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
    table: 'garage_stripe_accounts',
    // One per garage (0020), so each row gets a garage of its own.
    insert: (c, t) =>
      c.query(
        `WITH g AS (
           INSERT INTO garages (tenant_id, name, timezone, currency)
           VALUES ($1, 'Row', 'UTC', 'USD') RETURNING id
         )
         INSERT INTO garage_stripe_accounts (tenant_id, garage_id, create_idempotency_key, create_requested_by)
         SELECT $1, g.id, 'row-' || gen_random_uuid(), 'test' FROM g
         RETURNING id`,
        [t],
      ),
    // Updated as Stripe is re-read; never deleted -- the grant has no DELETE.
    noDelete: true,
  },
  {
    table: 'garage_terminal_locations',
    // One per garage (0021), so each row gets a garage of its own.
    insert: (c, t) =>
      c.query(
        `WITH g AS (
           INSERT INTO garages (tenant_id, name, timezone, currency)
           VALUES ($1, 'Row', 'UTC', 'USD') RETURNING id
         )
         INSERT INTO garage_terminal_locations (tenant_id, garage_id, account_id, location_id, display_name, created_by)
         SELECT $1, g.id, 'acct_stubRow', 'tml_stub' || replace(gen_random_uuid()::text, '-', ''), 'Row', 'test' FROM g
         RETURNING id`,
        [t],
      ),
    // Insert-only: the grant has no UPDATE or DELETE.
    appendOnly: true,
  },
  {
    table: 'lane_readers',
    // One reader per lane at a time, so each row binds on a lane of its own.
    insert: (c, t, w) =>
      c.query(
        `WITH l AS (
           INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1, $2, 'Row', 'exit') RETURNING id, garage_id
         )
         INSERT INTO lane_readers (tenant_id, garage_id, lane_id, account_id, location_id, reader_id, label, bound_by)
         SELECT $1, l.garage_id, l.id, 'acct_stubRow', 'tml_stubRow', 'tmr_stub' || replace(gen_random_uuid()::text, '-', ''), 'Row', 'test'
           FROM l
         RETURNING id`,
        [t, w.garage],
      ),
    // Ending a binding is the one UPDATE there is; there is no DELETE.
    noDelete: true,
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
