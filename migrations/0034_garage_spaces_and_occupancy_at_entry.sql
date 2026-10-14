-- 0034 — the garage's number of spaces, and how full it was when each car came in.
--
-- HIS WORDS, 2026-10-14: the fill rule ("when the garage is at least X% full,
-- the time-based charge is Y% more") prices on how full the garage was at the
-- moment the car came in, and "full" is ALL cars -- every car inside, VIP and
-- nested included -- against every switched-on spot. Cars inside keep the
-- price they came in on.
--
--   garages.spaces                  the garage's number of spaces: the count of
--                                   switched-on spots when the garage map is
--                                   built, otherwise typed by the owner. NULL
--                                   until one of those says it, and then the
--                                   fill rule cannot price here: a plan with
--                                   one is refused for this garage (src/app.js).
--   sessions.occupancy_at_entry_bp  how full the garage was when this stay
--                                   opened, in basis points of full:
--                                   floor(10000 x cars inside before this one
--                                   / spaces), at most 10000 -- a map changed
--                                   under cars still inside can leave more cars
--                                   than spaces, and that is full, never more.
--                                   Set by the platform inside the open, behind
--                                   the garage's lock (src/repository.js), and
--                                   by nothing else: no lane sends it. NULL when
--                                   the garage had no `spaces` then, and on
--                                   every stay opened before this migration.
--
-- Nothing is backfilled. A stay opened before this has no figure, and no plan
-- with a fill rule can be in force for it: a plan with one is refused while
-- `spaces` is NULL, and the engine prices a stay on the plan in force at its
-- entry.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE garages
  ADD COLUMN spaces integer
    CONSTRAINT garages_spaces_check CHECK (spaces > 0);

ALTER TABLE sessions
  ADD COLUMN occupancy_at_entry_bp integer
    CONSTRAINT sessions_occupancy_at_entry_bp_check CHECK (occupancy_at_entry_bp BETWEEN 0 AND 10000);

COMMIT;
