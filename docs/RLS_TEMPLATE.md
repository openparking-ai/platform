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

## Application scoping is still required

RLS is the backstop, not the plan. Queries still carry their own
`WHERE tenant_id = $1`, and `withTenant()` in `src/db.js` sets the context with
`SET LOCAL` inside a transaction so it cannot leak to the next borrower of a pooled
connection. Two independent controls; either one alone is one mistake away from a leak.
