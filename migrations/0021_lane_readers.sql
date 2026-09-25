-- 0021 — a garage's card reader, bound to a lane.
--
-- A reader belongs to the GARAGE'S OWN Stripe account (0020), not to the
-- deployment: under direct charges Stripe's own words are "all API resources
-- belong to the connected account rather than your platform". So the Location
-- that groups the garage's readers, and each Reader, are registered ON that
-- account (the `Stripe-Account` header). Stripe reaches the reader over the
-- internet; nothing here talks to the device.
--
-- Both are refused while the account's card_payments capability is not
-- active, read from Stripe at the moment of the request: "Terminal connected
-- accounts must have the card_payments capability to perform transactions."
--
-- ONE LOCATION PER GARAGE. ONE READER PER LANE, AND ONE LANE PER READER, AT A
-- TIME. A binding is ended by recording when and by whom -- `unbound_at`,
-- `unbound_by` -- never by deleting the row: which reader served which lane,
-- and when, is the record a charge at that lane is later read against. A
-- reader unbound from one lane may be bound to another; each binding is its
-- own row.
--
-- Tenant-owned; docs/RLS_TEMPLATE.md. Locations: INSERT only. Bindings:
-- INSERT, and one UPDATE -- the unbinding -- enforced by the trigger. No
-- DELETE on either.
--
-- Run as the database OWNER.

BEGIN;

CREATE TABLE garage_terminal_locations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id    uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  -- The garage's account the location was registered on, as it was then.
  account_id   text        NOT NULL,
  location_id  text        NOT NULL,
  display_name text        NOT NULL,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT garage_terminal_locations_one_per_garage UNIQUE (garage_id),
  CONSTRAINT garage_terminal_locations_one_garage_per_location UNIQUE (location_id),
  CONSTRAINT garage_terminal_locations_location_id_shape CHECK (location_id ~ '^tml_[A-Za-z0-9]+$'),
  CONSTRAINT garage_terminal_locations_account_id_shape CHECK (account_id ~ '^acct_[A-Za-z0-9]+$')
);
CREATE INDEX garage_terminal_locations_tenant_id_idx ON garage_terminal_locations (tenant_id);

CREATE TABLE lane_readers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id   uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  lane_id     uuid        NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  account_id  text        NOT NULL,
  location_id text        NOT NULL,
  reader_id   text        NOT NULL,
  label       text        NOT NULL,
  bound_at    timestamptz NOT NULL DEFAULT now(),
  bound_by    text        NOT NULL,
  unbound_at  timestamptz,
  unbound_by  text,

  CONSTRAINT lane_readers_reader_id_shape CHECK (reader_id ~ '^tmr_[A-Za-z0-9]+$'),
  CONSTRAINT lane_readers_location_id_shape CHECK (location_id ~ '^tml_[A-Za-z0-9]+$'),
  CONSTRAINT lane_readers_account_id_shape CHECK (account_id ~ '^acct_[A-Za-z0-9]+$'),
  CONSTRAINT lane_readers_unbound_together CHECK ((unbound_at IS NULL) = (unbound_by IS NULL)),
  CONSTRAINT lane_readers_unbound_after_bound CHECK (unbound_at IS NULL OR unbound_at >= bound_at)
);
CREATE INDEX lane_readers_tenant_id_idx ON lane_readers (tenant_id);
-- At most one reader bound to a lane, and a reader bound to at most one lane.
CREATE UNIQUE INDEX lane_readers_one_per_lane ON lane_readers (lane_id) WHERE unbound_at IS NULL;
CREATE UNIQUE INDEX lane_readers_one_lane_per_reader ON lane_readers (reader_id) WHERE unbound_at IS NULL;

CREATE FUNCTION lane_readers_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The lane is this tenant's, and in the garage the row names. A foreign
    -- key alone would accept another tenant's lane: it runs as the owner.
    IF NOT EXISTS (
      SELECT 1 FROM lanes l
       WHERE l.id = NEW.lane_id AND l.tenant_id = NEW.tenant_id AND l.garage_id = NEW.garage_id
    ) THEN
      RAISE EXCEPTION 'lane_readers: lane % is not in garage % of this tenant', NEW.lane_id, NEW.garage_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.unbound_at IS NOT NULL THEN
      RAISE EXCEPTION 'lane_readers: a binding begins bound'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'lane_readers_begins_bound';
    END IF;
    RETURN NEW;
  END IF;
  -- The one update: recording the unbinding, once, and nothing else.
  IF OLD.unbound_at IS NOT NULL
     OR NEW.unbound_at IS NULL
     OR (NEW.id, NEW.tenant_id, NEW.garage_id, NEW.lane_id, NEW.account_id, NEW.location_id,
         NEW.reader_id, NEW.label, NEW.bound_at, NEW.bound_by)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.garage_id, OLD.lane_id, OLD.account_id, OLD.location_id,
         OLD.reader_id, OLD.label, OLD.bound_at, OLD.bound_by) THEN
    RAISE EXCEPTION 'lane_readers: a binding is only ever ended, once, by recording when and by whom'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'lane_readers_only_unbinding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lane_readers_guard
  BEFORE INSERT OR UPDATE ON lane_readers
  FOR EACH ROW EXECUTE FUNCTION lane_readers_guard();

CREATE FUNCTION garage_terminal_locations_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM garages g WHERE g.id = NEW.garage_id AND g.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'garage_terminal_locations: garage % is not this tenant''s under row-level security', NEW.garage_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER garage_terminal_locations_guard
  BEFORE INSERT ON garage_terminal_locations
  FOR EACH ROW EXECUTE FUNCTION garage_terminal_locations_guard();

ALTER TABLE garage_terminal_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE garage_terminal_locations FORCE  ROW LEVEL SECURITY;
CREATE POLICY garage_terminal_locations_tenant_isolation ON garage_terminal_locations
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE lane_readers ENABLE ROW LEVEL SECURITY;
ALTER TABLE lane_readers FORCE  ROW LEVEL SECURITY;
CREATE POLICY lane_readers_tenant_isolation ON lane_readers
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON garage_terminal_locations TO openparking_app;
GRANT SELECT, INSERT, UPDATE ON lane_readers TO openparking_app;

COMMIT;
