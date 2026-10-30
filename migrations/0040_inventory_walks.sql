-- 0040 — the inventory walk: a person photographs the cars parked in a garage
-- and the walk finishes into four lists, frozen.
--
--   walks            one walk at one garage: who started it and when, and, once
--                    finished, who finished it, when, and its four lists
--                    (`lists`), stored as they were worked out at the finish and
--                    never worked out again, and whether its "not seen" list
--                    feeds the stuck list (`feeds_stuck`). A person has one
--                    unfinished walk at a garage at a time; one left
--                    unfinished is closed as abandoned (`abandoned_at`), with
--                    no lists. Once finished or abandoned, a walk, its
--                    sightings and its listed stays are frozen by the
--                    triggers below, not only by the code.
--   walk_sightings   one car seen on a walk: what the reader made of its picture
--                    or the plate the person gave (`read`), the plate's
--                    positioned characters the matching uses
--                    (`plate_state/rule/pattern`), the candidates it fitted when
--                    it fitted several, the one the person picked, and an
--                    earlier sighting it answers (`confirms`), and the picture as
--                    it was written fresh, until its 30 days are over.
--                    `client_ref` is the phone's own id for it, so a sighting
--                    sent twice is kept once; with none, `picture_digest`
--                    does that for a picture sent twice.
--   walk_stays       the stays a finished walk listed, and in which list
--                    (`seen` or `not_seen`): what the stuck list reads.
--   garages          `walk_complete_percent`: the share of the stays it was
--                    checking a walk must see to feed the stuck list, 80
--                    unless the garage sets another.
--   garage_changes   a walk as what a change was done to (`walk`). A line about
--                    a walk names no vehicle.
--
-- A walk holds plates: it is deleted with its sightings and its stays once it
-- finished, was abandoned, or (neither) started longer ago than the tenant's
-- retention window; a sighting's picture goes once its 30 days are over
-- (src/retention.js).
--
-- Run as the database OWNER.

BEGIN;

-- A constant default: no rewrite of the table.
ALTER TABLE garages
  ADD COLUMN walk_complete_percent integer NOT NULL DEFAULT 80
    CONSTRAINT garages_walk_complete_percent_check CHECK (walk_complete_percent BETWEEN 1 AND 100);

CREATE TABLE walks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id    uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  started_by   text        NOT NULL CHECK (length(started_by) BETWEEN 1 AND 300),
  finished_at  timestamptz,
  finished_by  text        CHECK (finished_by IS NULL OR length(finished_by) BETWEEN 1 AND 300),
  lists        jsonb,
  -- Whether its "not seen" list feeds the stuck list: it saw at least
  -- complete_percent of the stays it was checking (seen_percent, rounded
  -- down; null when there was none to check). complete_percent is the
  -- garage's setting when the walk finished.
  feeds_stuck      boolean,
  seen_percent     integer CHECK (seen_percent BETWEEN 0 AND 100),
  complete_percent integer CHECK (complete_percent BETWEEN 1 AND 100),
  abandoned_at timestamptz,
  CONSTRAINT walks_finished_whole CHECK (
    (finished_at IS NULL AND finished_by IS NULL AND lists IS NULL AND feeds_stuck IS NULL
     AND seen_percent IS NULL AND complete_percent IS NULL)
    OR (finished_at IS NOT NULL AND finished_by IS NOT NULL AND jsonb_typeof(lists) = 'object'
        AND feeds_stuck IS NOT NULL AND complete_percent IS NOT NULL AND finished_at >= started_at
        AND (NOT feeds_stuck OR seen_percent >= complete_percent))
  ),
  -- Abandoned is never finished, and has no lists.
  CONSTRAINT walks_abandoned_unfinished CHECK (
    abandoned_at IS NULL OR (finished_at IS NULL AND abandoned_at >= started_at)
  )
);

CREATE UNIQUE INDEX walks_one_open_per_person ON walks (garage_id, started_by)
  WHERE finished_at IS NULL AND abandoned_at IS NULL;

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
  picture_type    text        CHECK (picture_type IS NULL OR picture_type IN ('image/jpeg', 'image/png')),
  picture         bytea       CHECK (picture IS NULL OR octet_length(picture) BETWEEN 1 AND 3145728),
  -- SHA-256 of the picture as the phone sent it: the same picture sent again
  -- with no client_ref is the same sighting. Goes with the picture.
  picture_digest  text        CHECK (picture_digest IS NULL OR picture_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT walk_sightings_picture_whole CHECK ((picture IS NULL) = (picture_type IS NULL)),
  CONSTRAINT walk_sightings_digest_with_picture CHECK (picture_digest IS NULL OR picture IS NOT NULL),
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
CREATE UNIQUE INDEX walk_sightings_one_per_picture ON walk_sightings (walk_id, picture_digest)
  WHERE picture_digest IS NOT NULL;
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

-- A walk is deleted only by the retention purge; its sightings and listed
-- stays go with it, by the cascade, and are never deleted on their own.
GRANT SELECT, INSERT, UPDATE, DELETE ON walks TO openparking_app;
GRANT SELECT, INSERT, UPDATE ON walk_sightings TO openparking_app;
GRANT SELECT, INSERT ON walk_stays TO openparking_app;

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

-- FROZEN AT THE FINISH, held here and not only by the code. A walk finished
-- or abandoned never changes again: not its lists, not who finished it, and
-- never back to open. Its sightings take nothing new, never move to another
-- walk, and change only by losing their picture once its days are over, or a
-- picked stay or an answered sighting going when that row goes. Its listed
-- stays are written before the finish and never after (src/walks.js
-- finishWalk); the app role cannot change or move one at all (no UPDATE).
CREATE FUNCTION walks_frozen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF OLD.finished_at IS NOT NULL OR OLD.abandoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'walks_frozen: a finished or abandoned walk never changes'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'walks_frozen';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER walks_frozen
  BEFORE UPDATE ON walks
  FOR EACH ROW EXECUTE FUNCTION walks_frozen();

CREATE FUNCTION walk_closed(walk uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (SELECT 1 FROM walks w WHERE w.id = walk AND (w.finished_at IS NOT NULL OR w.abandoned_at IS NOT NULL))
  $$;

CREATE FUNCTION walk_sightings_frozen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    -- A sighting stays on the walk it was added to: it never leaves a closed
    -- walk, and the walk checked below is the one it was on as well.
    IF TG_OP = 'UPDATE' AND NEW.walk_id IS DISTINCT FROM OLD.walk_id THEN
      RAISE EXCEPTION 'walk_sightings_frozen: a sighting stays on the walk it was added to'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'walk_sightings_frozen';
    END IF;
    IF NOT walk_closed(NEW.walk_id) THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT'
       OR (NEW.id, NEW.tenant_id, NEW.walk_id, NEW.client_ref, NEW.read, NEW.why, NEW.plate, NEW.plate_state,
           NEW.plate_rule, NEW.plate_pattern, NEW.readers, NEW.candidates, NEW.taken_at, NEW.added_at, NEW.added_by)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.walk_id, OLD.client_ref, OLD.read, OLD.why, OLD.plate, OLD.plate_state,
           OLD.plate_rule, OLD.plate_pattern, OLD.readers, OLD.candidates, OLD.taken_at, OLD.added_at, OLD.added_by)
       OR (NEW.picture IS NOT NULL AND NEW.picture IS DISTINCT FROM OLD.picture)
       OR (NEW.picture_type IS NOT NULL AND NEW.picture_type IS DISTINCT FROM OLD.picture_type)
       OR (NEW.picture_digest IS NOT NULL AND NEW.picture_digest IS DISTINCT FROM OLD.picture_digest)
       OR (NEW.picked_stay IS NOT NULL AND NEW.picked_stay IS DISTINCT FROM OLD.picked_stay)
       OR (NEW.confirms IS NOT NULL AND NEW.confirms IS DISTINCT FROM OLD.confirms) THEN
      RAISE EXCEPTION 'walk_sightings_frozen: a finished or abandoned walk''s sightings never change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'walk_sightings_frozen';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER walk_sightings_frozen
  BEFORE INSERT OR UPDATE ON walk_sightings
  FOR EACH ROW EXECUTE FUNCTION walk_sightings_frozen();

CREATE FUNCTION walk_stays_frozen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF walk_closed(NEW.walk_id) THEN
      RAISE EXCEPTION 'walk_stays_frozen: a finished or abandoned walk lists no more stays'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'walk_stays_frozen';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER walk_stays_frozen
  BEFORE INSERT ON walk_stays
  FOR EACH ROW EXECUTE FUNCTION walk_stays_frozen();

-- The change log names a walk as its subject, and names no vehicle with it.
-- NOT VALID here, checked after the COMMIT below: the check of the rows
-- already there then reads the change log without holding it locked.
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_subject_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_subject_kind_check CHECK (subject_kind IN (
  'garage', 'lane', 'computer', 'reader', 'payment_account',
  'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'exit', 'stay', 'walk',
  'unknown')) NOT VALID;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_walk_names_no_vehicle
  CHECK (subject_kind <> 'walk' OR subject_name IS NULL) NOT VALID;

COMMIT;

ALTER TABLE garage_changes VALIDATE CONSTRAINT garage_changes_subject_kind_check;
ALTER TABLE garage_changes VALIDATE CONSTRAINT garage_changes_walk_names_no_vehicle;
