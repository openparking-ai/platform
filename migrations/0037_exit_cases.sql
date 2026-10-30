-- 0037: THE EXIT, BY THE CAR'S ID.
--
-- Two things.
--
-- 1. A stay keeps the ID its entry read (sessions.entry_plate_*,
--    entry_colour_code, entry_size): the plate as positioned characters, the
--    sure ones folded and the others '?', under a named rule; or the fact that
--    it was unreadable, or not seen; the colour code; the size. The exit finds
--    the stay by comparing its own ID with these (src/exitMatch.js), not by an
--    exact plate. Nulled with the plate when the vehicle is redacted.
--
-- 2. Every car at an exit lane is a CASE (exits): which stay it is and how
--    that was decided -- the lane's own match, one clear stay, the picker's
--    choice among a few, or the driver's stated entry time when no stay was
--    found -- the fee shown, and a person's decision when there is one. The
--    gate opens once the case is settled; the close names the case.
--
-- Numbered 0037: main holds 0036, and open pull requests use 0035.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN entry_plate_state   text CHECK (entry_plate_state IN ('read', 'unreadable', 'not_seen')),
  ADD COLUMN entry_plate_rule    text CHECK (entry_plate_rule ~ '^[a-z0-9-]{1,40}/[0-9]{1,4}$'),
  ADD COLUMN entry_plate_pattern text CHECK (entry_plate_pattern ~ '^[0-9A-Z?]{1,16}$'),
  ADD COLUMN entry_colour_code   text CHECK (entry_colour_code ~ '^opvid-colour/[0-9]{1,4}:[mf]:[0-9a-f]{16}$'),
  ADD COLUMN entry_size          text CHECK (entry_size ~ '^[a-z0-9_-]{1,32}$');

-- A read plate has a rule and at least one sure character; an unreadable or
-- unseen one has no characters; no state, nothing.
ALTER TABLE sessions ADD CONSTRAINT sessions_entry_plate_id_shape CHECK (
  (entry_plate_state IS NULL AND entry_plate_rule IS NULL AND entry_plate_pattern IS NULL)
  OR (entry_plate_state = 'read' AND entry_plate_rule IS NOT NULL AND entry_plate_pattern ~ '[0-9A-Z]')
  OR (entry_plate_state IN ('unreadable', 'not_seen') AND entry_plate_pattern IS NULL)
);

CREATE TABLE exits (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id         uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  lane_id           uuid        NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  -- The lane's id for this car at the exit: a resend is the same case.
  event_id          text        NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  exit_at           timestamptz NOT NULL,
  plate_state       text        CHECK (plate_state IN ('read', 'unreadable', 'not_seen')),
  plate_rule        text        CHECK (plate_rule ~ '^[a-z0-9-]{1,40}/[0-9]{1,4}$'),
  plate_pattern     text        CHECK (plate_pattern ~ '^[0-9A-Z?]{1,16}$'),
  colour_code       text        CHECK (colour_code ~ '^opvid-colour/[0-9]{1,4}:[mf]:[0-9a-f]{16}$'),
  size              text        CHECK (size ~ '^[a-z0-9_-]{1,32}$'),
  -- lane: the lane matched the stay itself; single: one stay agreed clearly;
  -- picker: chosen among a few by pictures; none: no stay found yet;
  -- driver_word: no stay found, and the driver's stated entry time priced.
  method            text        NOT NULL CHECK (method IN ('lane', 'single', 'picker', 'none', 'driver_word')),
  session_id        uuid        REFERENCES sessions(id),
  -- The stays considered, numbered as the picker was shown them; ids only.
  candidates        jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(candidates) = 'array'),
  -- What the picker was asked and answered: the model, the number, the time,
  -- the pictures shown. Nothing else from its answer.
  picker            jsonb       CHECK (picker IS NULL OR jsonb_typeof(picker) = 'object'),
  claimed_entry_at  timestamptz,
  -- The fee as shown at the lane: the platform's figures, never the lane's.
  quote             jsonb       CHECK (quote IS NULL OR jsonb_typeof(quote) = 'object'),
  -- A person who let the car out: who, why, when.
  person            jsonb       CHECK (person IS NULL OR (jsonb_typeof(person) = 'object'
                                                          AND length(person->>'reason') BETWEEN 1 AND 500
                                                          AND person ? 'by' AND person ? 'at')),
  close_event_id    text        CHECK (close_event_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exits_once UNIQUE (tenant_id, event_id),
  CONSTRAINT exits_close_once UNIQUE (tenant_id, close_event_id),
  CONSTRAINT exits_plate_id_shape CHECK (
    (plate_state IS NULL AND plate_rule IS NULL AND plate_pattern IS NULL)
    OR (plate_state = 'read' AND plate_rule IS NOT NULL AND plate_pattern ~ '[0-9A-Z]')
    OR (plate_state IN ('unreadable', 'not_seen') AND plate_pattern IS NULL)
  ),
  -- A matched case names its stay; an unmatched one names none.
  CONSTRAINT exits_method_names_a_stay CHECK ((method IN ('lane', 'single', 'picker')) = (session_id IS NOT NULL)),
  -- The driver's word is an entry time, no later than the exit and no more
  -- than 90 days before it (the longest stay the engine prices).
  CONSTRAINT exits_word_is_a_time CHECK (
    (method = 'driver_word') = (claimed_entry_at IS NOT NULL)
    AND (claimed_entry_at IS NULL OR (claimed_entry_at <= exit_at AND claimed_entry_at >= exit_at - interval '90 days'))
  ),
  CONSTRAINT exits_closed_is_complete CHECK ((close_event_id IS NULL) = (closed_at IS NULL))
);

CREATE INDEX exits_tenant_id_idx ON exits (tenant_id);
CREATE INDEX exits_open_idx ON exits (tenant_id, garage_id, created_at) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX exits_one_open_per_stay ON exits (tenant_id, session_id)
  WHERE session_id IS NOT NULL AND closed_at IS NULL;

ALTER TABLE exits ENABLE ROW LEVEL SECURITY;
ALTER TABLE exits FORCE  ROW LEVEL SECURITY;

CREATE POLICY exits_tenant_isolation ON exits
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- A case is never deleted: it is the record of why a car was let out.
GRANT SELECT, INSERT, UPDATE ON exits TO openparking_app;

-- A foreign key is checked without row-level security, so on its own it
-- would take another account's lane or stay; this reads them as the writer,
-- as 0033's do -- after the row's own policy has had its say.
CREATE FUNCTION exits_own_lane_and_stay() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM lanes l WHERE l.id = NEW.lane_id AND l.garage_id = NEW.garage_id AND l.tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'exits_lane: an exit case is at a lane of its own account''s garage'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.session_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM sessions s WHERE s.id = NEW.session_id AND s.garage_id = NEW.garage_id AND s.tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'exits_stay: an exit case names a stay at its own account''s garage'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER exits_on_own_lane_and_stay
  AFTER INSERT OR UPDATE ON exits
  FOR EACH ROW EXECUTE FUNCTION exits_own_lane_and_stay();

-- The change log names an exit case as its subject: a person letting a car out.
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_subject_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_subject_kind_check CHECK (subject_kind IN (
  'garage', 'lane', 'computer', 'reader', 'payment_account',
  'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'exit', 'unknown'));

COMMIT;
