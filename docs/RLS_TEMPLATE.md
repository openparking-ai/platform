# The tenant-owned table template

Every table that holds tenant data follows this shape. No exceptions, and the
isolation test in `test/tenant-isolation.test.js` is what keeps it honest.

```sql
CREATE TABLE <table> (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- ... the table's own columns ...
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX <table>_tenant_id_idx ON <table> (tenant_id);

ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE  ROW LEVEL SECURITY;

CREATE POLICY <table>_tenant_isolation ON <table>
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO openparking_app;
```

## Why each line is there

**`tenant_id NOT NULL`** — a nullable tenant column produces rows no policy matches
and no tenant can reach. They are invisible, not safe.

**`ENABLE`** turns policies on for everyone except the table owner. **`FORCE`** closes
that last hole so the owner is subject to its own policies too. You need both, and
neither one helps against a superuser — see below.

**`USING`** filters what a query can read, update or delete. **`WITH CHECK`** filters
what it can write. Omit `WITH CHECK` and a tenant can insert rows attributed to
someone else — writes are unguarded while reads look fine, which is the worst version
of this bug because it tests clean from the reading side.

**The grant** is DML only. The app role never gets DDL.

## The superuser trap

A Postgres **superuser bypasses row-level security unconditionally**. `FORCE` does not
change that; `FORCE` only removes the table-*owner* exemption. So:

- The application connects as `openparking_app`, created `NOSUPERUSER NOBYPASSRLS`.
- The tests connect as `openparking_app`, not as the owner and not as `postgres`.
- `test/tenant-isolation.test.js` asserts those two role attributes before it asserts
  anything else, so nobody can make a failing isolation test pass by handing the app
  role `BYPASSRLS`.

This matters most in CI, where the stock `postgres` service container hands you a
superuser by default. An isolation test run as that user sees every tenant's rows
whether the policies exist or not — it fails on correct code and cannot be fixed by
correcting the schema, which invites someone to weaken the assertion instead.

## The one sanctioned exception: authentication

Every tenant-owned table follows the template above. Exactly one does not, and
this section is the standard for it rather than a note about a special case.

**The problem the template cannot express.** A lane controller presents a token.
The tenant that token belongs to is *precisely what the lookup exists to
discover*, so a policy of `tenant_id = current_tenant_id()` matches nothing —
there is no context to set yet. Measured on a scratch database before anything
was built: the lookup returned **0 rows**.

**The standard.** The device credential table is `ENABLE ROW LEVEL SECURITY`
**without** `FORCE`, and is read only through a `SECURITY DEFINER` resolver
owned by the migration role:

```sql
ALTER TABLE lane_devices ENABLE ROW LEVEL SECURITY;
-- deliberately NOT forced

CREATE POLICY lane_devices_tenant_isolation ON lane_devices
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE FUNCTION resolve_lane_device(p_token_hash text)
  RETURNS TABLE (device_id uuid, tenant_id uuid, lane_id uuid, garage_id uuid, direction text)
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ ... $$;

GRANT EXECUTE ON FUNCTION resolve_lane_device(text) TO openparking_app;
```

**Why this shape and not another.** To read a row without knowing the tenant,
something must be exempt from the policy. The available exemptions are: the
table owner with `FORCE` off, a `BYPASSRLS` role, a superuser, or a policy that
lets anyone read. The middle two are exactly what this whole document exists to
avoid, and the last is worse than the problem. That leaves ownership.

The distinction that makes it acceptable: **the exemption is a property of
ownership, not of privilege.** Nobody has to be a superuser, so it behaves
identically on a developer laptop, in CI, and on a production cluster where the
owner is an ordinary role. `FORCE` is not decoration being skipped — removing
it is the documented mechanism for letting a table's owner read its own table,
which is what a definer function needs.

**What fences it in.** Four things, all tested:

- `openparking_app` still cannot read the table with no tenant context.
- `openparking_app` still cannot see another tenant's devices with one.
- The resolver returns nothing for an unknown or revoked token.
- `test/rls-coverage.test.js` asserts this is the **only** non-forced table in
  the schema, so the exception cannot quietly spread. Adding a second one fails
  CI until somebody writes down why.

Anything else that needs to resolve a credential before a tenant is known
follows this shape. Anything that does not need to resolve a credential uses the
template at the top of this page.

## Application scoping is still required

RLS is the backstop, not the plan. Queries still carry their own
`WHERE tenant_id = $1`, and `withTenant()` in `src/db.js` sets the context with
`SET LOCAL` inside a transaction so it cannot leak to the next borrower of a pooled
connection. Two independent controls; either one alone is one mistake away from a leak.
