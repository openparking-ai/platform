-- 0005 — a session records what confirmed it, and there is no default.
--
-- Until now a session opened the moment the lane vended. That made the TICKET
-- the entry, and it is not one: a driver can pull up, take a ticket and drive
-- away, and a vend with no car behind it is not an arrival at all. Every one of
-- those became a phantom occupant — counted as inside, never seen again, filling
-- the garage on paper before it filled in concrete.
--
-- The lane now creates a PENDING entry at the vend and promotes it only when two
-- loops after the barrier see a vehicle cross them forward inside the
-- confirmation window. What promoted it travels with the session, so the money
-- record can say what it rests on rather than leaving it to be inferred.
--
-- THE VALUES, and each is its own name because folding two of them together is
-- how the difference stops being visible:
--
--   confirmed        two loops after the barrier saw a vehicle cross forward
--   unconfirmable    this lane has no closing loops installed, so nothing could
--                    have confirmed or refuted it. NOT the same word as
--                    `confirmed`, and it is on every session such a lane opens
--   opened_on_vend   what every row written before this migration is. They were
--                    opened at the vend, and no loop was consulted, because
--                    there was nothing to consult. It is the BACKFILL value and
--                    the application never writes it — src/app.js accepts only
--                    the two above, and test/api.test.js asserts it refuses
--                    this one
--
-- Entries backed out of and entries held are NOT rows here. They are not
-- sessions: no session, no occupancy, no money. They are lane events, and they
-- land in `events`, which is append-only by grant and already carries every
-- other thing a lane observed.
--
-- THE DEFAULT IS DROPPED AT THE END OF THIS FILE, DELIBERATELY. It exists for
-- the length of one ALTER, to give existing rows a value. Leaving it in place
-- would mean an INSERT that forgets the column gets a plausible answer instead
-- of an error — a silent wrong value in the one column that says whether
-- anything saw the car.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN entry_confirmation text NOT NULL DEFAULT 'opened_on_vend'
    CHECK (entry_confirmation IN ('confirmed', 'unconfirmable', 'opened_on_vend'));

ALTER TABLE sessions ALTER COLUMN entry_confirmation DROP DEFAULT;

-- The exit is the same question about the other end of the stay: did anything
-- see the car leave. NULL while the session is open, because nothing has left
-- yet — and the constraint below is what stops that being a way to close a
-- session without saying.
ALTER TABLE sessions
  ADD COLUMN exit_confirmation text
    CHECK (exit_confirmation IN ('confirmed', 'unconfirmable', 'closed_on_vend'));

UPDATE sessions SET exit_confirmation = 'closed_on_vend' WHERE exit_at IS NOT NULL;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_exit_confirmation_matches_exit CHECK (
    (exit_at IS NULL     AND exit_confirmation IS NULL)
    OR
    (exit_at IS NOT NULL AND exit_confirmation IS NOT NULL)
  );

-- The inside-count now filters on this column, and it is the query an operator
-- polls. `sessions_garage_open_idx` already covers `garage_id WHERE exit_at IS
-- NULL`; this carries the value alongside so the count does not go back to the
-- heap for every open row.
CREATE INDEX sessions_garage_open_confirmation_idx
  ON sessions (garage_id, entry_confirmation) WHERE exit_at IS NULL;

COMMIT;
