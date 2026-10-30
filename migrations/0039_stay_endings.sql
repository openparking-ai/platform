-- 0039 — a stay no exit closed, ended with its reason; and how full the
-- garage was, counted at the car's own entry.
--
--   sessions.ended   NULL, or the record of how a stay no exit closed ended.
--                    Three reasons:
--                      superseded  the same car (the same whole plate or
--                                  ticket: one vehicle row) came in again,
--                                  further apart than one arrival
--                                  (REAPPROACH_MINUTES), while this stay was
--                                  still open. It had left by then, so
--                                  `exit_at` is that later entry -- "gone by",
--                                  not "left at". An earlier visit whose open
--                                  arrives after a later stay of the car is
--                                  stored so from the start. An unread car
--                                  never shares a vehicle row (0036), so a
--                                  partial ID never ends another car's stay.
--                      ended       a person said the car left, with a reason:
--                                  `exit_at` is when they said it left, or
--                                  when they said so.
--                      abandoned   a person wrote the stay off, with a
--                                  reason: no charge is expected. `exit_at`
--                                  is when they did.
--                    The two a person decides carry who (`by`) and the
--                    person's own words (`why`). A late close whose exit falls inside the stay
--                    still closes and prices it, and clears this.
--                    An ended stay has no exit lane, no close event, no exit
--                    confirmation or descriptor, no outcome and no price: the
--                    sixth shape of a closed stay, beside the five of 0015.
--   sessions_garage_entry_idx   the count of cars inside at an entry reads
--                    the stays that came in before it; and
--   sessions_vehicle_entry_idx  a car's stays in entry order, for the open
--                    and the late close above.
--   garage_changes   a stay as what a change was done to (`stay`): a person
--                    ending one. A line about a stay names no vehicle. A
--                    superseded stay is not a line: `ended` and its event
--                    record it.
--
-- Nothing is backfilled: no stay is ended by this migration.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN ended jsonb
    CONSTRAINT sessions_ended_is_a_record CHECK (
      ended IS NULL OR (
        jsonb_typeof(ended) = 'object'
        -- coalesced: a missing key makes ->> NULL, and a NULL CHECK passes
        AND coalesce(ended->>'reason', '') IN ('superseded', 'ended', 'abandoned')
        AND coalesce(jsonb_typeof(ended->'at'), '') = 'string'
        AND (ended->>'reason' = 'superseded' OR (
          coalesce(jsonb_typeof(ended->'by'), '') = 'string'
          AND length(coalesce(ended->>'why', '')) BETWEEN 1 AND 500
        ))
      )
    );

-- The closing facts come together or not at all -- or, on an ended stay, not
-- at all with an exit.
ALTER TABLE sessions DROP CONSTRAINT sessions_closed_is_complete;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_closed_is_complete CHECK (
    (exit_at IS NULL AND exit_lane_id IS NULL AND close_event_id IS NULL AND ended IS NULL)
    OR
    (exit_at IS NOT NULL AND ended IS NULL AND exit_lane_id IS NOT NULL AND close_event_id IS NOT NULL)
    OR
    (exit_at IS NOT NULL AND ended IS NOT NULL AND exit_lane_id IS NULL AND close_event_id IS NULL)
  );

-- Nothing confirmed the exit of an ended stay, and no exit read described it.
ALTER TABLE sessions DROP CONSTRAINT sessions_exit_confirmation_matches_exit;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_exit_confirmation_matches_exit CHECK (
    (exit_at IS NULL AND exit_confirmation IS NULL)
    OR
    (exit_at IS NOT NULL AND ended IS NULL AND exit_confirmation IS NOT NULL)
    OR
    (exit_at IS NOT NULL AND ended IS NOT NULL AND exit_confirmation IS NULL AND exit_descriptor IS NULL)
  );

-- The five shapes of 0015, and the sixth: ended, unpriced, no outcome.
ALTER TABLE sessions DROP CONSTRAINT sessions_closed_is_covered_priced_or_refused;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_closed_is_covered_priced_or_refused CHECK (
    (exit_at IS NULL
       AND fee_minor IS NULL AND plan_version IS NULL AND breakdown IS NULL
       AND space_class IS NULL AND pricing_refusal IS NULL
       AND exit_outcome IS NULL AND entitlement IS NULL)
    OR
    (exit_at IS NOT NULL AND exit_outcome IS NOT NULL AND exit_outcome = 'covered'
       AND fee_minor IS NULL AND plan_version IS NULL AND breakdown IS NULL
       AND space_class IS NULL AND pricing_refusal IS NULL)
    OR
    -- `exit_outcome IS NOT NULL AND` on the shapes that name one: a NULL
    -- outcome would make `IN (...)` NULL, and a CHECK that is NULL passes.
    (exit_at IS NOT NULL AND exit_outcome IS NOT NULL
       AND exit_outcome IN ('transient', 'transient_card_on_file')
       AND fee_minor IS NOT NULL
       AND plan_version IS NOT NULL AND breakdown IS NOT NULL AND space_class IS NOT NULL
       AND pricing_refusal IS NULL)
    OR
    (exit_at IS NOT NULL AND exit_outcome IS NULL AND entitlement IS NULL
       AND fee_minor IS NOT NULL AND hourly_minor_applied IS NOT NULL
       AND plan_version IS NULL AND breakdown IS NULL AND space_class IS NULL
       AND pricing_refusal IS NULL)
    OR
    (exit_at IS NOT NULL AND exit_outcome IS NOT NULL AND exit_outcome = 'transient'
       AND fee_minor IS NULL
       AND plan_version IS NULL AND breakdown IS NULL AND space_class IS NULL
       AND pricing_refusal IS NOT NULL)
    OR
    (exit_at IS NOT NULL AND ended IS NOT NULL AND exit_outcome IS NULL AND entitlement IS NULL
       AND fee_minor IS NULL AND hourly_minor_applied IS NULL
       AND plan_version IS NULL AND breakdown IS NULL AND space_class IS NULL
       AND pricing_refusal IS NULL)
  );

-- An ended stay is the sixth shape and no other: the first five never carry it.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_ended_is_unpriced CHECK (
    ended IS NULL OR (
      exit_at IS NOT NULL AND exit_outcome IS NULL AND fee_minor IS NULL
      AND subtotal_minor IS NULL AND decided_by IS NULL
    )
  );

CREATE INDEX sessions_garage_entry_idx ON sessions (tenant_id, garage_id, entry_at);
CREATE INDEX sessions_vehicle_entry_idx ON sessions (tenant_id, garage_id, vehicle_id, entry_at);

-- The change log names a stay as its subject: a person ending one.
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_subject_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_subject_kind_check CHECK (subject_kind IN (
  'garage', 'lane', 'computer', 'reader', 'payment_account',
  'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'exit', 'stay', 'unknown'));

-- A line about a stay names no vehicle: the stay is its id.
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_stay_unnamed
  CHECK (subject_kind <> 'stay' OR subject_name IS NULL);

COMMIT;
