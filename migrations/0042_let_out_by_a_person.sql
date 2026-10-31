-- 0042 — a car a person let out at the exit with nothing paid, recorded as
-- that; and the lane computer a person used, named in the change log.
--
--   sessions.let_out   NULL, or the record of a transient stay a person let
--                      out with nothing paid: who (`by`), the exit case it
--                      was settled on (`exit_id`), what it owed when the
--                      person decided (`owed_minor`, `currency`; null when
--                      the engine could not price it), when (`at`), and
--                      `paid: false`. Such a stay carries NO fee: `fee_minor`
--                      is what a stay paid, and this one paid nothing. It is
--                      the seventh shape of a closed stay -- transient, let
--                      out, unpriced -- or, when the engine refused to price
--                      it, the fifth (refused) with the record beside it.
--                      A stay whose card had paid closes priced, as any
--                      paid stay does, and carries no record here.
--   garage_changes     a lane computer as who made a change (`computer`, its
--                      id and name): the computer a person at the lane used
--                      to open the barrier for a car with an exit case. A
--                      person's name is not known to the lane; the computer
--                      and the authority it opened on are.
--
-- Nothing is backfilled.
--
-- The change log's two CHECKs are added NOT VALID inside the transaction and
-- validated after it, so the change log is not held under an exclusive lock
-- while it is read (as 0040 does for its own two).
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN let_out jsonb
    CONSTRAINT sessions_let_out_is_a_record CHECK (
      let_out IS NULL OR (
        jsonb_typeof(let_out) = 'object'
        -- coalesced: a missing key makes ->> NULL, and a NULL CHECK passes
        AND coalesce(jsonb_typeof(let_out->'paid'), '') = 'boolean'
        AND let_out->>'paid' = 'false'
        AND coalesce(jsonb_typeof(let_out->'by'), '') = 'string'
        AND length(let_out->>'by') BETWEEN 1 AND 300
        AND coalesce(jsonb_typeof(let_out->'exit_id'), '') = 'string'
        AND coalesce(jsonb_typeof(let_out->'at'), '') = 'string'
        AND coalesce(jsonb_typeof(let_out->'owed_minor'), '') IN ('number', 'null')
      )
    );

-- The five shapes of 0015, the sixth of 0039, and the seventh: a transient
-- stay a person let out, with nothing paid and so no fee.
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
    OR
    (exit_at IS NOT NULL AND let_out IS NOT NULL AND exit_outcome IS NOT NULL AND exit_outcome = 'transient'
       AND fee_minor IS NULL
       AND plan_version IS NULL AND breakdown IS NULL AND space_class IS NULL
       AND pricing_refusal IS NULL)
  );

-- A let-out stay is closed by an exit, transient, and carries no fee: the
-- seventh shape, or the refused fifth. Never a priced one, never an ended one.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_let_out_is_unpaid CHECK (
    let_out IS NULL OR (
      exit_at IS NOT NULL AND ended IS NULL AND exit_outcome IS NOT NULL AND exit_outcome = 'transient'
      AND fee_minor IS NULL AND subtotal_minor IS NULL
    )
  );

-- The change log names a lane computer as who made a change.
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_actor_kind_check;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_actor_kind_check
  CHECK (actor_kind IN ('owner', 'key', 'computer', 'outside', 'nobody')) NOT VALID;
ALTER TABLE garage_changes DROP CONSTRAINT garage_changes_actor_shape;
ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_actor_shape CHECK (
  (actor_kind IN ('owner', 'key', 'computer') AND actor_id IS NOT NULL)
  OR (actor_kind IN ('outside', 'nobody') AND actor_id IS NULL AND actor_name IS NULL)
) NOT VALID;

COMMIT;

ALTER TABLE garage_changes VALIDATE CONSTRAINT garage_changes_actor_kind_check;
ALTER TABLE garage_changes VALIDATE CONSTRAINT garage_changes_actor_shape;
