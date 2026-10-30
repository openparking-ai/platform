-- 0045 — an exit case closed by the platform, not by the lane: superseded by
-- a new case for the same stay, or closed because a person ended the stay.
--
-- 0037 holds ONE OPEN CASE PER STAY (exits_one_open_per_stay). A lane drops
-- its case when a car leaves the loop unsettled -- the gate faulted, the car
-- backed off, the driver went to fetch a card or to the other exit lane --
-- and nothing on the platform closed it, so the car's next case answered 500
-- and the barrier stayed down; and a person could not end the stay at all
-- (409 stay_at_an_exit). Now:
--
--   exits.ended   NULL, or why the platform closed the case without a lane's
--                 close event:
--                   {why: "superseded", at, by_exit}  a new case for the same
--                                                     stay took its place;
--                   {why: "stay_ended", at, by}       a person ended the stay.
--                 Such a case is CLOSED (closed_at set) with no close event,
--                 so everything that reads "open" as `closed_at IS NULL` --
--                 the one-open-case index, the attendant's list, a payment,
--                 the driver's word, a let-out, the close -- treats it as
--                 closed, with no second meaning to keep in step.
--
-- No plate is ever here: ids, a reason and when.
--
-- Nothing is backfilled.
--
-- Numbered 0045: 0040 and 0041 are the inventory walk and picture retention,
-- 0042 is the let-out, 0043 and 0044 the stuck-stay clean-up.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE exits
  ADD COLUMN ended jsonb
    CONSTRAINT exits_ended_is_a_record CHECK (
      ended IS NULL OR (
        jsonb_typeof(ended) = 'object'
        -- coalesced: a missing key makes ->> NULL, and a NULL CHECK passes
        AND coalesce(ended->>'why', '') IN ('superseded', 'stay_ended')
        AND coalesce(jsonb_typeof(ended->'at'), '') = 'string'
        AND (ended->>'why' <> 'superseded' OR (
          coalesce(jsonb_typeof(ended->'by_exit'), '') = 'string'
          AND ended->>'by_exit' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ))
        AND (ended->>'why' <> 'stay_ended' OR (
          coalesce(jsonb_typeof(ended->'by'), '') = 'string'
          AND length(ended->>'by') BETWEEN 1 AND 300
        ))
      )
    );

-- Open; closed by the lane's close event; or closed by the platform, with why.
ALTER TABLE exits DROP CONSTRAINT exits_closed_is_complete;
ALTER TABLE exits ADD CONSTRAINT exits_closed_is_complete CHECK (
  (closed_at IS NULL AND close_event_id IS NULL AND ended IS NULL)
  OR (closed_at IS NOT NULL AND close_event_id IS NOT NULL AND ended IS NULL)
  OR (closed_at IS NOT NULL AND close_event_id IS NULL AND ended IS NOT NULL)
);

COMMIT;
