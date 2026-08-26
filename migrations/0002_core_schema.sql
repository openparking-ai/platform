-- 0002 — the core parking schema: garages, lanes, vehicles, rates, sessions,
-- events, and the lane device credentials.
--
-- Every tenant-owned table below follows docs/RLS_TEMPLATE.md. The one
-- deliberate deviation is lane_devices, and it is documented where it happens.
--
-- Run as the database OWNER.

BEGIN;

-- ---------------------------------------------------------------------------
-- parking_sites was the sample table 0001 used to establish the pattern. The
-- real tables are below; leaving a table called "parking_sites" beside
-- "garages" in a public repository would only ever confuse a reader.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS parking_sites;

-- ---------------------------------------------------------------------------
-- garages
--
-- Times are stored UTC everywhere. The garage carries the IANA timezone so a
-- local-time answer can be produced for a human, and the ISO 4217 currency so
-- money is never a bare number.
-- ---------------------------------------------------------------------------
CREATE TABLE garages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  timezone    text        NOT NULL,
  currency    text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX garages_tenant_id_idx ON garages (tenant_id);

-- ---------------------------------------------------------------------------
-- lanes
-- ---------------------------------------------------------------------------
CREATE TABLE lanes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id   uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  direction   text        NOT NULL CHECK (direction IN ('entry', 'exit')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lanes_tenant_id_idx ON lanes (tenant_id);
CREATE INDEX lanes_garage_id_idx ON lanes (garage_id);

-- ---------------------------------------------------------------------------
-- vehicles
--
-- A plate is personal data in most jurisdictions. There is no retention or
-- purge policy in this migration because that decision has not been made --
-- see docs/DATA_RETENTION.md, which records it as open rather than pretending
-- the absence is a decision.
-- ---------------------------------------------------------------------------
CREATE TABLE vehicles (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plate         text        NOT NULL,
  plate_region  text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plate)
);
CREATE INDEX vehicles_tenant_id_idx ON vehicles (tenant_id);

-- ---------------------------------------------------------------------------
-- rates — one simple hourly rate per garage to start.
--
-- Money is a bigint of MINOR units (cents), never numeric and never a float.
-- node-pg returns numeric AND bigint as JavaScript strings, so the application
-- parses them explicitly rather than doing arithmetic on whatever came back;
-- see src/money.js.
-- ---------------------------------------------------------------------------
CREATE TABLE rates (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id    uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  hourly_minor bigint      NOT NULL CHECK (hourly_minor >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rates_tenant_id_idx ON rates (tenant_id);
CREATE INDEX rates_garage_id_idx ON rates (garage_id);

-- ---------------------------------------------------------------------------
-- sessions
--
-- The fee and the rate that produced it are FROZEN onto the row at exit.
-- Deriving a closed session's fee from the rates table on read would mean that
-- editing a rate silently rewrites the financial history of every session that
-- ever used it.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id            uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  vehicle_id           uuid        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  entry_lane_id        uuid        NOT NULL REFERENCES lanes(id),
  exit_lane_id         uuid        REFERENCES lanes(id),
  entry_at             timestamptz NOT NULL,
  exit_at              timestamptz,
  currency             text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate_id              uuid        REFERENCES rates(id),
  hourly_minor_applied bigint      CHECK (hourly_minor_applied >= 0),
  fee_minor            bigint      CHECK (fee_minor >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- A closed session has all of its closing facts, or none of them.
  CONSTRAINT sessions_closed_is_complete CHECK (
    (exit_at IS NULL AND exit_lane_id IS NULL AND fee_minor IS NULL)
    OR
    (exit_at IS NOT NULL AND exit_lane_id IS NOT NULL AND fee_minor IS NOT NULL)
  ),
  CONSTRAINT sessions_exit_after_entry CHECK (exit_at IS NULL OR exit_at >= entry_at)
);
CREATE INDEX sessions_tenant_id_idx ON sessions (tenant_id);
CREATE INDEX sessions_garage_open_idx ON sessions (garage_id) WHERE exit_at IS NULL;

-- One open session per vehicle per garage. This is what makes "open a session"
-- safe to retry: a replayed entry cannot create a second one.
CREATE UNIQUE INDEX sessions_one_open_per_vehicle
  ON sessions (tenant_id, garage_id, vehicle_id) WHERE exit_at IS NULL;

-- ---------------------------------------------------------------------------
-- events — append-only log of lane activity.
--
-- "Append-only" is enforced by the grants at the bottom of this file (SELECT
-- and INSERT, no UPDATE, no DELETE), not by the name of the table.
--
-- event_id is generated by the lane controller and unique per tenant. It is
-- what makes delivery idempotent: a lane that reconnects and re-flushes its
-- queue re-sends events it may already have delivered, and must not produce
-- duplicates.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id   uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  lane_id     uuid        REFERENCES lanes(id) ON DELETE SET NULL,
  event_id    text        NOT NULL,
  kind        text        NOT NULL,
  occurred_at timestamptz NOT NULL,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id)
);
CREATE INDEX events_tenant_id_idx ON events (tenant_id);
CREATE INDEX events_garage_occurred_idx ON events (garage_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- lane_devices — one credential per lane.
--
-- THIS TABLE IS THE ONE DELIBERATE DEVIATION FROM docs/RLS_TEMPLATE.md.
--
-- Authentication has a bootstrap problem that the template cannot express. A
-- lane presents a token; the tenant it belongs to is precisely what the lookup
-- exists to discover. A policy of `tenant_id = current_tenant_id()` therefore
-- matches nothing, because no tenant context can be set yet. Measured on a
-- scratch database before this was written: the lookup returned 0 rows.
--
-- The resolution: ENABLE row level security but do NOT force it, and read the
-- table only through resolve_lane_device() below, which is SECURITY DEFINER and
-- so runs as this table's owner. An owner is exempt from its own policies
-- exactly when FORCE is absent -- which is what FORCE is for.
--
-- Note what this does NOT rely on: nobody has to be a superuser. The exemption
-- is a property of ownership, not of privilege, so it behaves identically on a
-- developer laptop, in CI, and on a production cluster where the owner is an
-- ordinary role.
--
-- openparking_app still cannot read this table directly without a tenant
-- context, and still cannot read another tenant's rows with one. Both are
-- asserted in test/lane-devices.test.js.
-- ---------------------------------------------------------------------------
CREATE TABLE lane_devices (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lane_id      uuid        NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  -- The token itself is never stored. Only a SHA-256 of it.
  token_hash   text        NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX lane_devices_tenant_id_idx ON lane_devices (tenant_id);

ALTER TABLE lane_devices ENABLE ROW LEVEL SECURITY;
-- Intentionally NOT forced. See the note above. test/rls-coverage.test.js
-- asserts that this is the only table in the schema for which that is true.

CREATE POLICY lane_devices_tenant_isolation ON lane_devices
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Resolves a presented credential to the tenant that owns it, and nothing more.
-- Returns no row for an unknown or revoked token.
CREATE FUNCTION resolve_lane_device(p_token_hash text)
  RETURNS TABLE (device_id uuid, tenant_id uuid, lane_id uuid, garage_id uuid, direction text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT d.id, d.tenant_id, d.lane_id, l.garage_id, l.direction
    FROM lane_devices d
    JOIN lanes l ON l.id = d.lane_id
    WHERE d.token_hash = p_token_hash
      AND d.revoked_at IS NULL
  $$;

-- Records that a device was seen, without widening what the app role can read.
CREATE FUNCTION touch_lane_device(p_device_id uuid) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ UPDATE lane_devices SET last_seen_at = now() WHERE id = p_device_id $$;

-- ---------------------------------------------------------------------------
-- Row level security for every other table. ENABLED and FORCED, policy with
-- both USING and WITH CHECK, exactly as docs/RLS_TEMPLATE.md requires.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['garages', 'lanes', 'vehicles', 'rates', 'sessions', 'events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Grants. DML only, and events gets no UPDATE or DELETE -- that is what makes
-- it append-only.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON garages, lanes, vehicles, rates, sessions TO openparking_app;
GRANT SELECT, INSERT                 ON events                                    TO openparking_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lane_devices                              TO openparking_app;

GRANT EXECUTE ON FUNCTION resolve_lane_device(text) TO openparking_app;
GRANT EXECUTE ON FUNCTION touch_lane_device(uuid)   TO openparking_app;

COMMIT;
