-- 0003 — real vehicle identity with a retention regime, and authentication for
-- the operator surface.
--
-- Run as the database OWNER.

BEGIN;

-- ---------------------------------------------------------------------------
-- Vehicle identity.
--
-- The running system stores real vehicle identity -- plate, make, model,
-- colour, attributes -- because without it there is no product. What does NOT
-- go in the public repository is real DATA: fixtures and tests use invented
-- values, enforced by .github/scripts/check-no-real-data.js.
--
-- redacted_at is how retention is enforced. See the note on the purge below
-- for why this is redaction rather than deletion.
-- ---------------------------------------------------------------------------
ALTER TABLE vehicles
  ADD COLUMN make        text,
  ADD COLUMN model       text,
  ADD COLUMN color       text,
  ADD COLUMN attributes  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- An enrolled vehicle holds a monthly, a pass or another standing
  -- credential. Its identity persists while it is enrolled; retention applies
  -- to transient parkers only.
  ADD COLUMN enrolled    boolean     NOT NULL DEFAULT false,
  ADD COLUMN redacted_at timestamptz;

CREATE INDEX vehicles_enrolled_idx ON vehicles (tenant_id) WHERE enrolled;

-- ---------------------------------------------------------------------------
-- Per-tenant settings. Retention is configurable per tenant; the default is 30
-- days after a session closes.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_settings (
  tenant_id              uuid        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_retention_days integer     NOT NULL DEFAULT 30 CHECK (vehicle_retention_days BETWEEN 1 AND 3650),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_settings_tenant_isolation ON tenant_settings
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- operator_tokens — authentication for the operator surface.
--
-- Until now the operator API trusted an x-tenant-id header. Anyone who could
-- reach it could act as any tenant whose id they knew, including minting lane
-- credentials for it. That is closed here: the tenant is derived from the
-- token, and the header is no longer trusted for anything.
--
-- This table takes the SAME shape as lane_devices, and for the same reason: a
-- credential is presented and the tenant it belongs to is precisely what the
-- lookup exists to discover, so a tenant policy cannot gate it. ENABLE without
-- FORCE, read through a SECURITY DEFINER resolver owned by the migration role.
-- The exemption is a property of ownership, not of privilege -- see
-- docs/RLS_TEMPLATE.md, "The sanctioned exception: authentication".
-- ---------------------------------------------------------------------------
CREATE TABLE operator_tokens (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  token_hash   text        NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX operator_tokens_tenant_id_idx ON operator_tokens (tenant_id);

ALTER TABLE operator_tokens ENABLE ROW LEVEL SECURITY;
-- Intentionally NOT forced. See the note above.

CREATE POLICY operator_tokens_tenant_isolation ON operator_tokens
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE FUNCTION resolve_operator_token(p_token_hash text)
  RETURNS TABLE (token_id uuid, tenant_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT t.id, t.tenant_id
    FROM operator_tokens t
    WHERE t.token_hash = p_token_hash
      AND t.revoked_at IS NULL
  $$;

CREATE FUNCTION touch_operator_token(p_token_id uuid) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ UPDATE operator_tokens SET last_seen_at = now() WHERE id = p_token_id $$;

-- ---------------------------------------------------------------------------
-- Maintenance.
--
-- The purge has to walk every tenant, and the tenants table is under RLS like
-- everything else -- so a job connecting as the application role cannot list
-- them, and neither can the owner, because tenants is FORCED. Rather than
-- reach for a superuser (which would bypass every policy in the schema and is
-- exactly what this design avoids), maintenance gets one narrow definer
-- function that returns ids and nothing else.
-- ---------------------------------------------------------------------------
CREATE FUNCTION list_tenant_ids_for_maintenance()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT id FROM tenants ORDER BY created_at $$;

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_settings, operator_tokens TO openparking_app;
GRANT EXECUTE ON FUNCTION resolve_operator_token(text) TO openparking_app;
GRANT EXECUTE ON FUNCTION touch_operator_token(uuid)   TO openparking_app;
GRANT EXECUTE ON FUNCTION list_tenant_ids_for_maintenance() TO openparking_app;

COMMIT;
