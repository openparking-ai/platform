-- 0007 — a garage says how long a stay can be, and a garage that says nothing
-- has no bound at all.
--
-- A close freezes a fee computed from the session's `entry_at` to the `exit_at`
-- the lane supplies, and nothing bounded the distance between them. A lane
-- naming an exit a year after the entry froze a year of hourly billing onto the
-- row -- `rate_id` and `hourly_minor_applied` beside it, indistinguishable in
-- the ledger from a stay somebody actually had. It was measured against the
-- running platform before it was decided, not argued from the source.
--
-- The bound is per GARAGE and it follows `default_action` exactly: a column on
-- `garages`, set at creation or by PATCH, served to the lane from the same row
-- in the same payload. It is not a per-tenant question -- one operator can hold
-- an airport garage where four days is ordinary and a retail one where four
-- hours is not.
--
-- NULL IS NO BOUND, AND IT IS THE DEFAULT. A garage that has set nothing is not
-- quietly given a plausible number: any figure this file chose would be a guess
-- at somebody's operation, and the first time the guess was low it would refuse
-- a real customer's exit at the barrier. The value is PUBLISHED in the rules
-- payload, null included, so an operator reads the absence rather than assuming
-- a limit exists.
--
-- What this does NOT bound is a stay in the other direction. Times come from
-- the lane because the car may have arrived while the lane had no network, so a
-- replay from the PAST is legitimate and stays legitimate. A time in the FUTURE
-- is refused, but that is a platform-wide clock-skew bound in src/app.js and
-- not a per-garage decision, so there is no column for it here.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE garages
  ADD COLUMN max_stay_hours integer
    CHECK (max_stay_hours IS NULL OR max_stay_hours > 0);

COMMIT;
