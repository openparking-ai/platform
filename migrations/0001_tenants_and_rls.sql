-- 0001 — tenants, the first tenant-owned table, and the row-level security
-- foundation every later migration inherits.
--
-- Run as the database OWNER. The application never connects as this role.

BEGIN;

-- ---------------------------------------------------------------------------
-- The application role.
--
-- NOSUPERUSER and NOBYPASSRLS are the whole point. A superuser bypasses
-- row-level security unconditionally -- FORCE ROW LEVEL SECURITY does not stop
-- one, it only closes the table-owner hole. If the application (or a test)
-- connects as a superuser, every policy below is inert and every isolation
-- test passes for the wrong reason.
--
-- Created NOLOGIN here so the schema carries the guarantee; scripts/ensure-app-role.js
-- adds LOGIN and a password from the environment.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openparking_app') THEN
    CREATE ROLE openparking_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE openparking_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Tenant context.
--
-- Unset resolves to NULL, and `tenant_id = NULL` is NULL, not true -- so a
-- connection that forgets to set the context sees nothing. Fail closed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('openparking.tenant_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenants_self_only ON tenants
  USING      (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- parking_sites -- the sample tenant-owned table, and the template for every
-- tenant-owned table that follows it. See docs/RLS_TEMPLATE.md.
-- ---------------------------------------------------------------------------
CREATE TABLE parking_sites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX parking_sites_tenant_id_idx ON parking_sites (tenant_id);

ALTER TABLE parking_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE parking_sites FORCE  ROW LEVEL SECURITY;

CREATE POLICY parking_sites_tenant_isolation ON parking_sites
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Grants. The app role gets DML and nothing structural.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO openparking_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, parking_sites TO openparking_app;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO openparking_app;

COMMIT;
