-- 0046 — other cars' plates do not outlive the retention window in a walk
-- kept for one car's picture.
--
-- A walk past the tenant's retention window is deleted once none of its
-- pictures is kept (src/retention.js). One photographed car still inside
-- keeps its picture, and so the walk -- and with it every other car's plate:
-- in its sightings (`plate`, the positioned characters, what the reader
-- said) and in its four lists. Now, past the window, the purge blanks them,
-- keeping only what a kept picture needs:
--
--   walk_sightings  a sighting whose picture is gone (or that never had one)
--                   has its plate, its positioned characters and the plate in
--                   `readers` set to null, once, with `plate_blanked_at`. A
--                   sighting whose picture is kept is left whole.
--   walks.lists     every `plate` in the four lists is set to null, but the
--                   one of a `seen_with_stay` row holding a kept picture: the
--                   stay that keeps it.
--
-- THE FREEZE TRIGGERS (0040) allow exactly that and nothing else: a closed
-- walk's sighting may, beside losing its picture, have its plate blanked once
-- -- its picture gone, the reader's name and confidence kept, every other
-- column as it was; a closed walk's lists may have plates set to null -- no
-- other value, no row, key or column moved. The same blanking may run again
-- as more pictures go.
--
-- Nothing is backfilled: the next purge blanks what is due.
--
-- Numbered 0046: 0045 is the exit case closed by the platform.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE walk_sightings ADD COLUMN plate_blanked_at timestamptz;

-- Every read but `none` has a plate -- until the purge blanked it.
ALTER TABLE walk_sightings DROP CONSTRAINT walk_sightings_read_shape;
ALTER TABLE walk_sightings ADD CONSTRAINT walk_sightings_read_shape CHECK (
  (read = 'none' AND why IS NOT NULL AND plate IS NULL)
  OR (read <> 'none' AND why IS NULL AND (plate IS NOT NULL OR plate_blanked_at IS NOT NULL))
);

-- Blanked is blanked whole, and only once its picture is gone.
ALTER TABLE walk_sightings ADD CONSTRAINT walk_sightings_blanked_whole CHECK (
  plate_blanked_at IS NULL
  OR (plate IS NULL AND plate_state IS NULL AND plate_rule IS NULL AND plate_pattern IS NULL AND picture IS NULL)
);

-- What the readers said, with each one's plate set to null: who read it and
-- how sure it was are kept.
CREATE FUNCTION walk_readers_blanked(readers jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public
  AS $$
    SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(e.el) = 'object' AND e.el ? 'plate'
                                   THEN jsonb_set(e.el, '{plate}', 'null'::jsonb) ELSE e.el END ORDER BY e.i), '[]'::jsonb)
      FROM jsonb_array_elements(readers) WITH ORDINALITY AS e(el, i)
  $$;

-- A walk's lists with every `plate` set to null, but in the `seen_with_stay`
-- rows of the stays in `keep`.
CREATE FUNCTION walk_lists_blanked(lists jsonb, keep uuid[]) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public
  AS $$
    SELECT COALESCE(jsonb_object_agg(k.key, CASE
             WHEN jsonb_typeof(k.value) = 'array' THEN (
               SELECT COALESCE(jsonb_agg(CASE
                        WHEN jsonb_typeof(e.el) = 'object' AND e.el ? 'plate'
                             AND NOT (k.key = 'seen_with_stay' AND (e.el->>'stay') = ANY (keep::text[]))
                        THEN jsonb_set(e.el, '{plate}', 'null'::jsonb)
                        ELSE e.el END ORDER BY e.i), '[]'::jsonb)
                 FROM jsonb_array_elements(k.value) WITH ORDINALITY AS e(el, i))
             ELSE k.value END), lists)
      FROM jsonb_each(lists) AS k(key, value)
  $$;

-- Whether `n` is `o` with some plates set to null and nothing else changed:
-- the same keys, the same rows in the same order, each row the same but for
-- a `plate` that is now null.
CREATE FUNCTION walk_lists_only_plates_blanked(o jsonb, n jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public
  AS $$
    SELECT jsonb_typeof(o) = 'object' AND jsonb_typeof(n) = 'object'
       AND ARRAY(SELECT jsonb_object_keys(o) ORDER BY 1) = ARRAY(SELECT jsonb_object_keys(n) ORDER BY 1)
       AND NOT EXISTS (
             SELECT 1 FROM jsonb_each(o) AS a(key, value)
              WHERE CASE WHEN jsonb_typeof(a.value) = 'array' THEN
                      jsonb_typeof(n->a.key) IS DISTINCT FROM 'array'
                      OR jsonb_array_length(a.value) <> jsonb_array_length(n->a.key)
                      OR EXISTS (
                           SELECT 1
                             FROM jsonb_array_elements(a.value) WITH ORDINALITY AS x(el, i)
                             JOIN jsonb_array_elements(n->a.key) WITH ORDINALITY AS y(el, i) ON y.i = x.i
                            WHERE CASE WHEN jsonb_typeof(x.el) = 'object' AND jsonb_typeof(y.el) = 'object'
                                       THEN (x.el - 'plate') <> (y.el - 'plate')
                                            OR (x.el ? 'plate') <> (y.el ? 'plate')
                                            OR (y.el ? 'plate' AND y.el->'plate' <> 'null'::jsonb AND y.el->'plate' <> x.el->'plate')
                                       ELSE x.el <> y.el END)
                    ELSE a.value IS DISTINCT FROM n->a.key END)
  $$;

-- 0040's, with the one change a closed walk now takes.
CREATE OR REPLACE FUNCTION walks_frozen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF OLD.finished_at IS NOT NULL OR OLD.abandoned_at IS NOT NULL THEN
      -- Past the retention window, plates in its lists set to null
      -- (src/retention.js): every other column as it was.
      IF NEW.lists IS DISTINCT FROM OLD.lists
         AND (to_jsonb(NEW) - 'lists') = (to_jsonb(OLD) - 'lists')
         AND walk_lists_only_plates_blanked(OLD.lists, NEW.lists) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'walks_frozen: a finished or abandoned walk never changes'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'walks_frozen';
    END IF;
    RETURN NEW;
  END
  $$;

-- 0040's, with the one change a closed walk's sighting now takes beside
-- losing its picture.
CREATE OR REPLACE FUNCTION walk_sightings_frozen() RETURNS trigger
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
    -- Past the retention window, its picture gone, its plate blanked, once
    -- (src/retention.js): the plate, its characters and the readers' plates
    -- to null, and every other column as it was.
    IF TG_OP = 'UPDATE' AND OLD.plate_blanked_at IS NULL AND NEW.plate_blanked_at IS NOT NULL THEN
      IF OLD.picture IS NULL AND NEW.picture IS NULL
         AND NEW.plate IS NULL AND NEW.plate_state IS NULL AND NEW.plate_rule IS NULL AND NEW.plate_pattern IS NULL
         AND NEW.readers = walk_readers_blanked(OLD.readers)
         AND (to_jsonb(NEW) - ARRAY['plate', 'plate_state', 'plate_rule', 'plate_pattern', 'readers', 'plate_blanked_at'])
             = (to_jsonb(OLD) - ARRAY['plate', 'plate_state', 'plate_rule', 'plate_pattern', 'readers', 'plate_blanked_at']) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'walk_sightings_frozen: only the plate of a sighting whose picture is gone is blanked, and nothing with it'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'walk_sightings_frozen';
    END IF;
    IF TG_OP = 'INSERT'
       OR (NEW.id, NEW.tenant_id, NEW.walk_id, NEW.client_ref, NEW.read, NEW.why, NEW.plate, NEW.plate_state,
           NEW.plate_rule, NEW.plate_pattern, NEW.readers, NEW.candidates, NEW.taken_at, NEW.added_at, NEW.added_by,
           NEW.plate_blanked_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.walk_id, OLD.client_ref, OLD.read, OLD.why, OLD.plate, OLD.plate_state,
           OLD.plate_rule, OLD.plate_pattern, OLD.readers, OLD.candidates, OLD.taken_at, OLD.added_at, OLD.added_by,
           OLD.plate_blanked_at)
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

COMMIT;
