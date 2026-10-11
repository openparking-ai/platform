-- 0033 — pictures kept with an entry, tailgaters as stays, and a banned list
-- the owner turns on (U7f).
--
-- HIS ANSWERS, 2026-10-11: pictures at the closing loop and between the vend
-- and it, kept one week after the car leaves; a tailgater whose identity is
-- read is a stay like any other and pays at the exit; banning tailgaters is
-- the owner's choice in the location setup, off until they turn it on, and so
-- is whether the list covers this garage or all their garages; a ban lasts
-- until someone takes the car off the list; no car is put on it by hand.
-- "We need to keep this as simple as possible."
--
--   garages.ban_tailgaters  off by default. With it on, a tailgater stay
--                           opened here, with an identity read, is listed.
--   garages.ban_reach       'garage' (this garage only) or 'all' (every garage
--                           of this account). Read when a lane loads its list,
--                           from the garage the car was listed at.
--   sessions.tailgater      the lane opened this stay for a car through the
--                           gate that no vend let in. False for every other.
--   entry_pictures          the pictures, kept against the lane's event id of
--                           the entry record they belong to: a stay's open, a
--                           tailgater nobody identified, a banned car refused.
--                           Removed one week after the car left (or after it
--                           was taken, when no stay holds it); a car still
--                           inside keeps them; a listed car keeps them.
--   banned_vehicles         one row per listed stay. Removing a ban deletes
--                           the row, and the normal rules apply again.
--
-- The arming loop's pictures are not here: none is stored anywhere, before
-- this migration or after it.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE garages
  ADD COLUMN ban_tailgaters boolean NOT NULL DEFAULT false,
  ADD COLUMN ban_reach      text    NOT NULL DEFAULT 'garage'
    CONSTRAINT garages_ban_reach_check CHECK (ban_reach IN ('garage', 'all'));

ALTER TABLE sessions
  ADD COLUMN tailgater boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- entry_pictures
-- ---------------------------------------------------------------------------
CREATE TABLE entry_pictures (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id    uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  lane_id      uuid        NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  -- The lane's own id for the picture: a resend is the same picture.
  picture_ref  text        NOT NULL CHECK (length(picture_ref) BETWEEN 1 AND 64),
  -- The lane's event id of the entry record the picture belongs to.
  event_id     text        NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  taken_at     timestamptz NOT NULL,
  content_type text        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  image        bytea       NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 3145728),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entry_pictures_once UNIQUE (tenant_id, lane_id, picture_ref)
);

CREATE INDEX entry_pictures_tenant_id_idx ON entry_pictures (tenant_id);
CREATE INDEX entry_pictures_event_idx ON entry_pictures (tenant_id, event_id);

ALTER TABLE entry_pictures ENABLE ROW LEVEL SECURITY;
ALTER TABLE entry_pictures FORCE  ROW LEVEL SECURITY;

CREATE POLICY entry_pictures_tenant_isolation ON entry_pictures
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON entry_pictures TO openparking_app;

-- ---------------------------------------------------------------------------
-- banned_vehicles
-- ---------------------------------------------------------------------------
CREATE TABLE banned_vehicles (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The garage the car was listed at: its reach decides where it is refused.
  garage_id  uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  -- The tailgater's stay: its identity, its pictures.
  session_id uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  listed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT banned_vehicles_once UNIQUE (session_id)
);

CREATE INDEX banned_vehicles_tenant_id_idx ON banned_vehicles (tenant_id);

ALTER TABLE banned_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE banned_vehicles FORCE  ROW LEVEL SECURITY;

CREATE POLICY banned_vehicles_tenant_isolation ON banned_vehicles
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON banned_vehicles TO openparking_app;

-- ---------------------------------------------------------------------------
-- Each row is about its own account's garage, lane and stay, whoever writes.
-- A foreign key is checked without row-level security, so on its own it would
-- take another account's id; these read the rows as the writer, as 0030's do.
-- ---------------------------------------------------------------------------
CREATE FUNCTION entry_pictures_own_lane() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM lanes l
       WHERE l.id = NEW.lane_id AND l.garage_id = NEW.garage_id AND l.tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'entry_pictures_lane: a picture is from a lane of its own account''s garage'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER entry_pictures_on_own_lane
  AFTER INSERT OR UPDATE ON entry_pictures
  FOR EACH ROW EXECUTE FUNCTION entry_pictures_own_lane();

CREATE FUNCTION banned_vehicles_own_stay() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM sessions s
       WHERE s.id = NEW.session_id AND s.garage_id = NEW.garage_id AND s.tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'banned_vehicles_stay: a listed car is a stay at its own account''s garage'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER banned_vehicles_on_own_stay
  AFTER INSERT OR UPDATE ON banned_vehicles
  FOR EACH ROW EXECUTE FUNCTION banned_vehicles_own_stay();

COMMIT;
