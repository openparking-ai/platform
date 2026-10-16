-- 0035 — a stay the platform ends, an exit that arrives before its entry, and
-- how full the garage was counted at the car's own entry.
--
--   sessions.ended   a stay no exit closed, ended by the platform with its
--                    reason, or NULL. Two reasons:
--                      superseded  the same car came in again, further apart
--                                  than one arrival (REAPPROACH_MINUTES), while
--                                  this stay was still open: it had left by
--                                  then, so `exit_at` is that later entry --
--                                  "gone by", not "left at" -- and the stay is
--                                  closed UNPRICED. An earlier visit whose
--                                  open arrives after a later stay of the car
--                                  is stored so from the start. A late close
--                                  whose exit falls inside the stay still
--                                  closes and prices it, and clears this.
--                      abandoned   an operator ended an open stay nothing
--                                  closed (scripts/abandon-stays.js): `exit_at`
--                                  is when they did. A late close is taken as
--                                  for a superseded stay.
--                    An ended stay has no exit lane, no close event, no exit
--                    confirmation or descriptor, no outcome and no price: the
--                    sixth shape of a closed stay, beside the five of 0015.
--   pending_exits    a close that found no stay to close -- the exit lane's
--                    queue delivered before the entry lane's, after an
--                    outage -- kept as it was sent instead of refused and lost.
--                    An open whose entry comes before it, and before the
--                    car's next stay, has the close delivered again through
--                    the close route, and the stay closes and prices itself
--                    from it. Never updated but by the retention purge, which
--                    nulls the descriptor and the lane's decision; never
--                    deleted. One is "paired" once a stay carries its
--                    close_event_id.
--   sessions_garage_entry_idx  the fill rule's count of cars inside at an
--                    entry reads the stays that came in before it; and
--   sessions_vehicle_entry_idx  a car's stays in entry order, for the open
--                    and the close above.
--   garage_changes   the platform itself as who did it (`platform`: a stay
--                    the operator ended as abandoned from the command line,
--                    `stay.abandon`), and a stay as what it was done to
--                    (`stay`). A line about a stay names no vehicle. A
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
        AND coalesce(ended->>'reason', '') IN ('superseded', 'abandoned')
        AND coalesce(jsonb_typeof(ended->'at'), '') = 'string'
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
-- A car's stays here in entry order: the open finds the car's next stay, and a
-- late close the stay of its car that its exit falls inside.
CREATE INDEX sessions_vehicle_entry_idx ON sessions (tenant_id, garage_id, vehicle_id, entry_at);

-- ---------------------------------------------------------------------------
-- pending_exits
-- ---------------------------------------------------------------------------
CREATE TABLE pending_exits (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id         uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  vehicle_id        uuid        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  -- The exit lane that sent it: the close is delivered again as that lane's.
  lane_id           uuid        NOT NULL REFERENCES lanes(id),
  -- The lane's event id of the close, as it was sent.
  close_event_id    text        NOT NULL CHECK (length(close_event_id) BETWEEN 1 AND 200),
  exit_at           timestamptz NOT NULL,
  exit_confirmation text        NOT NULL
    CHECK (exit_confirmation IN ('confirmed', 'unconfirmable', 'held', 'closed_on_vend')),
  exit_descriptor   text,
  local_decision    jsonb       CHECK (local_decision IS NULL OR jsonb_typeof(local_decision) = 'object'),
  reader_shown      jsonb       CHECK (reader_shown IS NULL OR jsonb_typeof(reader_shown) = 'object'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pending_exits_once UNIQUE (tenant_id, close_event_id)
);

CREATE INDEX pending_exits_tenant_id_idx ON pending_exits (tenant_id);
CREATE INDEX pending_exits_vehicle_idx ON pending_exits (tenant_id, garage_id, vehicle_id, exit_at);

ALTER TABLE pending_exits ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_exits FORCE  ROW LEVEL SECURITY;

CREATE POLICY pending_exits_tenant_isolation ON pending_exits
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- No DELETE: a pending exit is the record that the close arrived. UPDATE for
-- the retention purge only.
GRANT SELECT, INSERT, UPDATE ON pending_exits TO openparking_app;

-- ---------------------------------------------------------------------------
-- the change log: the platform, and a stay
-- ---------------------------------------------------------------------------
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_actor_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_actor_kind_check
  CHECK (actor_kind IN ('owner', 'key', 'outside', 'nobody', 'platform'));

ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_actor_shape;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_actor_shape CHECK (
  (actor_kind IN ('owner', 'key') AND actor_id IS NOT NULL)
  OR (actor_kind IN ('outside', 'nobody', 'platform') AND actor_id IS NULL AND actor_name IS NULL)
);

ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_subject_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_subject_kind_check CHECK (subject_kind IN (
  'garage', 'lane', 'computer', 'reader', 'payment_account',
  'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'stay', 'unknown'));

-- A line about a stay names no vehicle: the stay is its id.
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_stay_unnamed
  CHECK (subject_kind <> 'stay' OR subject_name IS NULL);

COMMIT;
