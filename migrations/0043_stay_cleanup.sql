-- 0043 — the garage clean-up: when a stay looks stuck, and what a stay a
-- person ended owes.
--
--   garages.stuck_after_hours   how old an open stay is before the stuck
--                    list shows it, unless the reader asks for another age.
--                    24 unless the garage sets another, 1 to 2160 (90 days).
--   sessions.ended->'owed'      on a stay a person ended because the car
--                    left (`reason` 'ended'): what the stay owes, priced as
--                    its exit would have priced it -- the modules asked,
--                    then the rates, then the tax -- at the time the person
--                    said it left. The stay itself stays unpriced (0039's
--                    sixth shape): `fee_minor` is what a stay paid at its
--                    exit, and nobody paid this. The garage collects it its
--                    own way; nothing here charges a card.
--                      outcome          'covered' or 'transient'
--                      fee_minor        what it owes, tax included, in
--                                       minor units; 0 when covered; null
--                                       only when the rates refused to
--                                       price it
--                      currency         the stay's
--                    A stay ended before this migration has no `owed`, and
--                    a superseded or abandoned stay never has one.
--
-- Nothing is backfilled.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE garages
  ADD COLUMN stuck_after_hours integer NOT NULL DEFAULT 24
    CONSTRAINT garages_stuck_after_hours_check CHECK (stuck_after_hours BETWEEN 1 AND 2160);

ALTER TABLE sessions
  ADD CONSTRAINT sessions_ended_owed_is_a_price CHECK (
    ended IS NULL OR NOT (ended ? 'owed') OR (
      ended->>'reason' = 'ended'
      AND jsonb_typeof(ended->'owed') = 'object'
      -- coalesced: a missing key makes ->> NULL, and a NULL CHECK passes
      AND coalesce(ended->'owed'->>'outcome', '') IN ('covered', 'transient')
      AND coalesce(ended->'owed'->>'currency', '') = currency
      -- CASE, so the number is read only once it is known to be one.
      AND CASE coalesce(jsonb_typeof(ended->'owed'->'fee_minor'), '')
            WHEN 'null' THEN ended->'owed'->>'outcome' = 'transient'
            WHEN 'number' THEN (ended->'owed'->>'fee_minor')::numeric >= 0
              AND (ended->'owed'->>'fee_minor')::numeric = trunc((ended->'owed'->>'fee_minor')::numeric)
              AND (ended->'owed'->>'outcome' <> 'covered' OR (ended->'owed'->>'fee_minor')::numeric = 0)
            ELSE false
          END
    )
  );

COMMIT;
