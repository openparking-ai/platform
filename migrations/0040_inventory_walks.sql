-- 0040 — the inventory walk: a person photographs the cars parked in a garage
-- and the walk finishes into four lists, frozen.
--
--   walks            one walk at one garage: who started it and when, and, once
--                    finished, who finished it, when, and its four lists
--                    (`lists`), stored as they were worked out at the finish and
--                    never worked out again.
--   walk_sightings   one car seen on a walk: what the reader made of its picture
--                    or the plate the person gave (`read`), the plate's
--                    positioned characters the matching uses
--                    (`plate_state/rule/pattern`), the candidates it fitted when
--                    it fitted several, the one the person picked, and an
--                    earlier sighting it answers (`confirms`). The picture is
--                    not kept. `client_ref` is the phone's own id for it, so a
--                    sighting sent twice is kept once.
--   walk_stays       the stays a finished walk listed, and in which list
--                    (`seen` or `not_seen`): what the stuck list reads.
--   garage_changes   a walk as what a change was done to (`walk`). A line about
--                    a walk names no vehicle.
--
-- A walk holds plates: it is deleted with its sightings and its stays once it
-- finished (or, never finished, started) longer ago than the tenant's
-- retention window (src/retention.js).
--
-- Run as the database OWNER.

BEGIN;

CREATE TABLE walks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id    uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  started_by   text        NOT NULL CHECK (length(started_by) BETWEEN 1 AND 300),
  finished_at  timestamptz,
  finished_by  text        CHECK (finished_by IS NULL OR length(finished_by) BETWEEN 1 AND 300),
  lists        jsonb,
  CONSTRAINT walks_finished_whole CHECK (
    (finished_at IS NULL AND finished_by IS NULL AND lists IS NULL)
    OR (finished_at IS NOT NULL AND finished_by IS NOT NULL AND jsonb_typeof(lists) = 'object'
        AND finished_at >= started_at)
  )
);

CREATE INDEX walks_tenant_id_idx ON walks (tenant_id);
CREATE INDEX walks_garage_idx ON walks (tenant_id, garage_id, started_at);

CREATE TABLE walk_sightings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  walk_id         uuid        NOT NULL REFERENCES walks(id) ON DELETE CASCADE,
  client_ref      text        CHECK (client_ref IS NULL OR length(client_ref) BETWEEN 1 AND 100),
  read            text        NOT NULL CHECK (read IN ('agreed', 'unsure', 'none', 'typed')),
  why             text        CHECK (why IS NULL OR why IN ('unreadable', 'not_seen', 'reader_off')),
  plate           text        CHECK (plate IS NULL OR length(plate) BETWEEN 1 AND 32),
  plate_state     text        CHECK (plate_state IS NULL OR plate_state IN ('read', 'unreadable', 'not_seen')),
  plate_rule      text        CHECK (plate_rule IS NULL OR length(plate_rule) BETWEEN 1 AND 64),
  plate_pattern   text        CHECK (plate_pattern IS NULL OR plate_pattern ~ '^[0-9A-Z?]{1,32}$'),
  readers         jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(readers) = 'array'),
  candidates      uuid[]      NOT NULL DEFAULT '{}',
  picked_stay     uuid        REFERENCES sessions(id) ON DELETE SET NULL,
  confirms        uuid        REFERENCES walk_sightings(id) ON DELETE SET NULL,
  taken_at        timestamptz NOT NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),
  added_by        text        NOT NULL CHECK (length(added_by) BETWEEN 1 AND 300),
  -- `none` says why and has no plate; every other read has a plate and no why.
  CONSTRAINT walk_sightings_read_shape CHECK (
    (read = 'none' AND why IS NOT NULL AND plate IS NULL)
    OR (read <> 'none' AND why IS NULL AND plate IS NOT NULL)
  ),
  -- What the matching compares comes whole or not at all.
  CONSTRAINT walk_sightings_characters_whole CHECK (
    (plate_state IS NULL AND plate_rule IS NULL AND plate_pattern IS NULL)
    OR (plate_state = 'read' AND plate_rule IS NOT NULL AND plate_pattern IS NOT NULL)
    OR (plate_state IN ('unreadable', 'not_seen') AND plate_pattern IS NULL)
  ),
  CONSTRAINT walk_sightings_not_itself CHECK (confirms IS NULL OR confirms <> id),
  CONSTRAINT walk_sightings_picked_a_candidate CHECK (picked_stay IS NULL OR picked_stay = ANY (candidates))
);

CREATE INDEX walk_sightings_tenant_id_idx ON walk_sightings (tenant_id);
CREATE INDEX walk_sightings_walk_idx ON walk_sightings (walk_id, added_at);
CREATE UNIQUE INDEX walk_sightings_one_per_client_ref ON walk_sightings (walk_id, client_ref)
  WHERE client_ref IS NOT NULL;
-- An earlier sighting is answered once.
CREATE UNIQUE INDEX walk_sightings_confirmed_once ON walk_sightings (confirms) WHERE confirms IS NOT NULL;

CREATE TABLE walk_stays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  walk_id     uuid NOT NULL REFERENCES walks(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  list        text NOT NULL CHECK (list IN ('seen', 'not_seen')),
  UNIQUE (walk_id, session_id)
);

CREATE INDEX walk_stays_tenant_id_idx ON walk_stays (tenant_id);
CREATE INDEX walk_stays_session_idx ON walk_stays (tenant_id, session_id);

ALTER TABLE walks ENABLE ROW LEVEL SECURITY;
ALTER TABLE walks FORCE  ROW LEVEL SECURITY;
ALTER TABLE walk_sightings ENABLE ROW LEVEL SECURITY;
ALTER TABLE walk_sightings FORCE  ROW LEVEL SECURITY;
ALTER TABLE walk_stays ENABLE ROW LEVEL SECURITY;
ALTER TABLE walk_stays FORCE  ROW LEVEL SECURITY;

CREATE POLICY walks_tenant_isolation ON walks
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY walk_sightings_tenant_isolation ON walk_sightings
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY walk_stays_tenant_isolation ON walk_stays
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Deleted only by the retention purge, with the walk.
GRANT SELECT, INSERT, UPDATE, DELETE ON walks TO openparking_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON walk_sightings TO openparking_app;
GRANT SELECT, INSERT, DELETE ON walk_stays TO openparking_app;

-- A foreign key is checked without row-level security, so on its own it
-- would take another account's garage, walk or stay; these read them as the
-- writer, as 0037's do.
CREATE FUNCTION walks_own_garage() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM garages g WHERE g.id = NEW.garage_id AND g.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'walks_garage: a walk is at a garage of its own account'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER walks_at_own_garage
  AFTER INSERT OR UPDATE ON walks
  FOR EACH ROW EXECUTE FUNCTION walks_own_garage();

CREATE FUNCTION walk_sightings_own_walk_and_stay() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    walk_garage uuid;
  BEGIN
    SELECT w.garage_id INTO walk_garage FROM walks w WHERE w.id = NEW.walk_id AND w.tenant_id = NEW.tenant_id;
    IF walk_garage IS NULL THEN
      RAISE EXCEPTION 'walk_sightings_walk: a sighting is on a walk of its own account'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM unnest(NEW.candidates) AS c(id)
       WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = c.id AND s.tenant_id = NEW.tenant_id AND s.garage_id = walk_garage)
    ) THEN
      RAISE EXCEPTION 'walk_sightings_candidates: a sighting''s candidates are stays at its walk''s garage'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.confirms IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM walk_sightings o WHERE o.id = NEW.confirms AND o.walk_id = NEW.walk_id AND o.tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'walk_sightings_confirms: a sighting answers one of its own walk'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER walk_sightings_on_own_walk_and_stay
  AFTER INSERT OR UPDATE ON walk_sightings
  FOR EACH ROW EXECUTE FUNCTION walk_sightings_own_walk_and_stay();

CREATE FUNCTION walk_stays_own_walk_and_stay() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM walks w JOIN sessions s ON s.garage_id = w.garage_id AND s.tenant_id = w.tenant_id
       WHERE w.id = NEW.walk_id AND w.tenant_id = NEW.tenant_id AND s.id = NEW.session_id
    ) THEN
      RAISE EXCEPTION 'walk_stays: a walk lists stays at its own garage'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER walk_stays_on_own_walk_and_stay
  AFTER INSERT ON walk_stays
  FOR EACH ROW EXECUTE FUNCTION walk_stays_own_walk_and_stay();

-- The change log names a walk as its subject, and names no vehicle with it.
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_subject_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_subject_kind_check CHECK (subject_kind IN (
  'garage', 'lane', 'computer', 'reader', 'payment_account',
  'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'exit', 'stay', 'walk',
  'unknown'));
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_walk_names_no_vehicle
  CHECK (subject_kind <> 'walk' OR subject_name IS NULL);

COMMIT;
