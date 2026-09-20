-- 0010 — a session carries the appearance descriptor its exit read produced.
--
-- The other end of 0009. The exit module matches an exiting car to a stay by
-- comparing the descriptor read AT THE EXIT against the descriptors of the open
-- stays, and the comparison's own input has to be on the record beside its
-- result: a match that cannot be re-examined against what the exit lane saw is
-- a number nobody can check.
--
-- ON THE CLOSE, AND ONLY ON THE CLOSE. The exit reaches this platform on two
-- channels that arrive in no specified order -- the sessions sync
-- (`POST /lane/sessions/close`) and the events ingest (`POST /lane/events`).
-- The shadow search (a later round) snapshots the open stays INSIDE the close
-- transaction, before `exit_at` is written, so the descriptor it compares has
-- to arrive in the close call itself. Riding the events channel it could land
-- after the close, with the true stay already closed: every plate-matched exit
-- would then read as "absent true car". One channel, one ordering, no race.
--
-- Same shape and same rules as `entry_descriptor` (0009): opaque, versioned,
-- bounded at the route, NULL means NOT MEASURED, on the session rather than the
-- vehicle, and reached by the retention purge in the same run. One more rule
-- here, and it is the only one: a stay that has not exited has no exit read, so
-- the column is NULL while `exit_at` is -- the same check
-- `sessions_exit_confirmation_matches_exit` makes about the confirmation, one
-- direction only, because an exit may have produced no descriptor.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN exit_descriptor text;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_exit_descriptor_needs_exit CHECK (
    exit_at IS NOT NULL OR exit_descriptor IS NULL
  );

COMMIT;
