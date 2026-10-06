-- 0030 — what a lane's screen says when no car is in front of it, and the
-- closing it now acts on.
--
-- THE BOARD (U4c, amendment 1). While no ticket or fee is up and its lane is
-- open, a lane's screen shows the garage's current items one after another:
-- the owner's own messages, and -- where the owner switches it on for that
-- lane -- the price, which the lane works out itself from the plans and the
-- taxes it charges with. Nobody types a price.
--
--   board_messages        the owner's words, with an optional start and end.
--                         Start and end are instants: the owner writes them in
--                         the garage's own time and the platform turns them
--                         into instants with the garage's timezone. An event
--                         tonight goes up and comes down by itself; a lane
--                         with no network keeps to the instants it holds.
--   board_message_lanes   which lanes a message shows on. Every one is a lane
--                         of the message's own garage; a lane that is removed
--                         takes its rows with it.
--   lanes.board_prices    the owner's switch: this lane shows the price.
--
-- The text of a message is 1 to 160 characters with no control or invisible
-- formatting character, as a closed lane's message is (0026). WHICH
-- characters the screen can draw is the route's check (src/screenText.js):
-- the list is a copy of the screen's font, checked against it, and a copy
-- held in a CHECK here would be a third one.
--
-- FULL IS A WAY IN'S REASON. `full` lets pass and monthly holders in; a way
-- out has nobody to let in. The route refuses it by name; this holds it for
-- every writer. Nothing is deployed, so no stored row needs moving.
--
-- Tenant-owned: docs/RLS_TEMPLATE.md.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE lanes
  ADD COLUMN board_prices boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT lanes_full_is_a_way_in CHECK (closed_reason IS DISTINCT FROM 'full' OR direction = 'entry');

-- ---------------------------------------------------------------------------
-- board_messages — the owner's words for the lanes' screens.
-- ---------------------------------------------------------------------------
CREATE TABLE board_messages (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id  uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  text       text        NOT NULL,
  starts_at  timestamptz,
  ends_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_messages_text_is_bounded CHECK (
    length(text) BETWEEN 1 AND 160
    AND text = btrim(text)
    AND text !~ '[\u0000-\u001f\u007f-\u009f­؜᠎​-‏ -‮⁠-⁯﻿￹-￻]'
  ),
  CONSTRAINT board_messages_ends_after_start CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX board_messages_tenant_id_idx ON board_messages (tenant_id);
CREATE INDEX board_messages_garage_idx ON board_messages (tenant_id, garage_id, created_at, id);

ALTER TABLE board_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_messages FORCE  ROW LEVEL SECURITY;

CREATE POLICY board_messages_tenant_isolation ON board_messages
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON board_messages TO openparking_app;

-- ---------------------------------------------------------------------------
-- board_message_lanes — which lanes a message shows on.
-- ---------------------------------------------------------------------------
CREATE TABLE board_message_lanes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id uuid        NOT NULL REFERENCES board_messages(id) ON DELETE CASCADE,
  lane_id    uuid        NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_message_lanes_once UNIQUE (message_id, lane_id)
);

CREATE INDEX board_message_lanes_tenant_id_idx ON board_message_lanes (tenant_id);
CREATE INDEX board_message_lanes_lane_idx ON board_message_lanes (tenant_id, lane_id);

ALTER TABLE board_message_lanes ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_message_lanes FORCE  ROW LEVEL SECURITY;

CREATE POLICY board_message_lanes_tenant_isolation ON board_message_lanes
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON board_message_lanes TO openparking_app;

-- ---------------------------------------------------------------------------
-- A message is on a garage of its own account, and shows only on lanes of
-- that garage, whoever writes the row.
--
-- A foreign key is checked without row-level security, so on its own it
-- would take another account's garage or lane id. The triggers read the
-- garage and the lane as the writer -- under the policies -- and refuse one
-- that is not the row's own account's, or a lane of another garage. AFTER
-- the row is written, so a row attributed to another account is refused by
-- that account's policy first, as every table's is.
-- ---------------------------------------------------------------------------
CREATE FUNCTION board_messages_own_garage() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM garages WHERE id = NEW.garage_id AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'board_messages_garage: a message is on a garage of its own account'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.garage_id <> OLD.garage_id THEN
      RAISE EXCEPTION 'board_messages_garage: a message stays on its garage'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER board_messages_on_own_garage
  AFTER INSERT OR UPDATE OF garage_id, tenant_id ON board_messages
  FOR EACH ROW EXECUTE FUNCTION board_messages_own_garage();

CREATE FUNCTION board_message_lanes_same_garage() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM board_messages m JOIN lanes l ON l.garage_id = m.garage_id AND l.tenant_id = m.tenant_id
       WHERE m.id = NEW.message_id AND l.id = NEW.lane_id AND m.tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'board_message_lanes_garage: a message shows only on lanes of its own garage'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER board_message_lanes_on_own_garage
  AFTER INSERT OR UPDATE ON board_message_lanes
  FOR EACH ROW EXECUTE FUNCTION board_message_lanes_same_garage();

-- The change log names a message as its subject.
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_subject_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_subject_kind_check CHECK (subject_kind IN (
  'garage', 'lane', 'computer', 'reader', 'payment_account',
  'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'unknown'));

COMMIT;
