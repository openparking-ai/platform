-- 0018 — the reconciler looks WITHOUT BEING ASKED, and says what it found.
--
-- WHAT 0017 LEFT OPEN. 0017 made the platform store a fee a DEVICE wrote and
-- gave two things to stand behind it: `decision_inputs`, so the number can be
-- re-derived from what the lane said it used, and a reconciler that re-derives
-- it and reports divergence without correcting anything. The second one only
-- ran when an operator asked, on the reconciliation route, inside that
-- route's window (24 hours by default). So a fee written by a device that
-- nobody queried inside that day was never re-derived by anything. The record
-- was there and re-derivable; nothing looked. A protection that runs only when
-- somebody thinks to ask is not the protection 0017 was specified to provide.
--
-- WHAT THIS ADDS, and it is two columns and no new decision:
--
--   `decision_checked_at`  when a check last ran on this row. NULL means NEVER
--                          CHECKED, and that is the queue: the sweep takes the
--                          oldest unchecked lane-decided closes, whatever their
--                          age, and no window bounds it. `sessions_lane_unchecked_idx`
--                          is that queue's index.
--   `decision_check`       what the check found, in the reconciler's own words:
--                          the verdict (`agreed`, `diverged`, `inputs_disagree`,
--                          `unrecomputable`, `covered`), the recomputed figure
--                          beside the lane's where there is one, and when.
--
-- The two are held together by a CHECK: a row that says it was checked carries
-- what the check found, and one that carries a verdict says when. Only a
-- lane-decided close can carry either -- a platform-priced close has nothing to
-- re-derive, because this platform computed its fee itself.
--
-- WHAT IT DOES NOT DO, and this is the whole design. IT CORRECTS NOTHING. The
-- sweep never writes `fee_minor`, `plan_version`, `exit_outcome`,
-- `decision_inputs` or any other column of the money record; the only columns
-- it may write are the two added here, and `test/lane-decision-sweep.test.js`
-- plants a lane that wrote fee + 1 and asserts every other column of that row
-- is byte-identical after the sweep has named it. An auto-correcting
-- reconciler on a money record is a way to lose the evidence of the thing it
-- was built to detect, and a sweep that corrects unattended is that failure
-- with nobody watching it happen. A divergence is also written to `events`,
-- which is append-only by grant, so the finding cannot be edited away even by
-- something that can write this table.
--
-- No personal data is added: a verdict, two figures and an instant.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN decision_checked_at timestamptz,
  ADD COLUMN decision_check jsonb
    CONSTRAINT sessions_decision_check_is_a_verdict CHECK (
      decision_check IS NULL OR (
        jsonb_typeof(decision_check) = 'object'
        -- coalesced: a missing key makes jsonb_typeof NULL, and a NULL CHECK passes
        AND coalesce(decision_check->>'verdict', '') IN
            ('agreed', 'diverged', 'inputs_disagree', 'unrecomputable', 'covered')
      )
    );

-- Checked and what-was-found travel together, and only on a lane-decided close.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_decision_check_is_attributed CHECK (
    (decision_checked_at IS NULL AND decision_check IS NULL)
    OR (decision_checked_at IS NOT NULL AND decision_check IS NOT NULL AND decided_by = 'lane')
  );

-- The sweep's queue: the lane-decided closes nothing has checked yet, oldest
-- first, with no window over them.
CREATE INDEX sessions_lane_unchecked_idx ON sessions (tenant_id, exit_at)
  WHERE decided_by = 'lane' AND decision_checked_at IS NULL;

COMMIT;
