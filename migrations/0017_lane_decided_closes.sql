-- 0017 — the close consumes the lane's decision, and says so beside the fee.
--
-- WHAT MOVED. Since 0013 this platform computed every transient fee itself,
-- at the close, from the plan store, and the row echoed it: "what the response
-- echoes IS the row, never a recomputation." The exit round moved the price
-- to the LANE: the barrier now shows a fee computed on the box, before the
-- boom moves, by the same engine function this platform calls
-- (`rate_engine.contract.run_quote`), from the plans this platform handed it
-- (0016). One computation has to feed the screen, the card and the row -- so
-- a close that carries the lane's decision WRITES THAT DECISION'S NUMBERS and
-- does not run the engine again. A close that carries none prices as before,
-- exactly.
--
-- WHAT THAT OPENS, AND WHAT STANDS BEHIND IT. The platform now stores a fee
-- a DEVICE wrote, on a device token. A buggy or compromised lane can write
-- any fee_minor it likes. The one-computation rule is right for the screen
-- and the card; it is not a defence for the record. Two things are:
--
--   `decision_inputs`  everything the lane said it decided FROM -- the entry
--                      and exit instants it priced between, the space class,
--                      the plan version, the currency, and when its cache was
--                      last refreshed (the rules' and the stays' timestamps
--                      and the stays cursor: the cache's `synced_at`). Stored
--                      beside the fee so the number can be re-derived later
--                      from what the lane said it used, never guessed.
--   the reconciler     `src/reconcile.js` recomputes each lane-decided fee
--                      OUT OF BAND -- the operator's reconciliation route,
--                      never the barrier's path -- from those inputs and the
--                      plans as stored, and REPORTS DIVERGENCE AND STOPS. It
--                      corrects nothing, because an auto-correcting
--                      reconciler on a money record is a way to lose the
--                      evidence of the thing you were trying to detect. That
--                      is the shape the file already had, copied.
--
-- `decided_by` names which of the two paths closed the stay: 'platform' (the
-- close priced it, or consulted the modules, itself) or 'lane' (the close
-- consumed the lane's decision). Every non-legacy closed stay says which; a
-- lane-decided one carries its inputs and a platform-decided one carries
-- none, and the CHECK below holds the pair together. Rows closed before this
-- migration were all decided by the platform, and are backfilled to say so.
--
-- WHAT THE CLOSE DOES NOT CONSUME, and records instead. A lane decision that
-- names a session other than the one being closed, prices in another
-- currency or space class, or names a plan version this garage does not hold
-- is NOT written as the fee -- the close prices itself, and the decision it
-- did not take is kept on the entitlement record under `local_decision_ignored`
-- with its reason, so the reconciler can list it. A lane that could not
-- decide (no cached entry, stale facts, an engine refusal) says so, and the
-- close prices itself, as brief 4.5 states. None of those is a 5xx: a 5xx
-- the lane classifies as retryable and jams its outbox behind.
--
-- No personal data is added: the inputs are instants, a class, a version and
-- a cursor. The purge does not need to reach them.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN decided_by text
    CONSTRAINT sessions_decided_by_is_named CHECK (decided_by IN ('platform', 'lane')),
  ADD COLUMN decision_inputs jsonb
    CONSTRAINT sessions_decision_inputs_is_a_record CHECK (
      decision_inputs IS NULL OR (
        jsonb_typeof(decision_inputs) = 'object'
        -- coalesced: a missing key makes jsonb_typeof NULL, and a NULL CHECK passes
        AND coalesce(jsonb_typeof(decision_inputs->'entry_at'), '') = 'string'
        AND coalesce(jsonb_typeof(decision_inputs->'exit_at'), '') = 'string'
        AND coalesce(jsonb_typeof(decision_inputs->'space_class'), '') = 'string'
        AND coalesce(jsonb_typeof(decision_inputs->'synced_at'), '') = 'object'
      )
    );

-- Every stay closed so far was decided by the platform.
UPDATE sessions SET decided_by = 'platform' WHERE exit_outcome IS NOT NULL AND decided_by IS NULL;

-- The pair holds together: a lane-decided close carries its inputs, a
-- platform-decided one carries none, and a stay that names an outcome names
-- who decided it. Open stays and the hourly-legacy rows carry neither.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_decision_is_attributed CHECK (
    (exit_outcome IS NULL AND decided_by IS NULL AND decision_inputs IS NULL)
    OR (exit_outcome IS NOT NULL AND decided_by = 'platform' AND decision_inputs IS NULL)
    OR (exit_outcome IS NOT NULL AND decided_by = 'lane' AND decision_inputs IS NOT NULL)
  );

CREATE INDEX sessions_lane_decided_idx ON sessions (tenant_id, garage_id, exit_at)
  WHERE decided_by = 'lane';

COMMIT;
