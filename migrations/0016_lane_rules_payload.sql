-- 0016 — the rules payload carries what the exit needs to decide, and the
-- open stays have a cursor.
--
-- HIS REQUIREMENT, 2026-09-21: "we must identify the car and display the fee
-- in about a second. if no fee (garage pass, monthly) open the gate in about
-- a second." Nothing on the barrier's path may wait on the network, so the
-- lane decides from what it already holds -- and what it holds comes from
-- `GET /lane/rules`, refreshed off the barrier's path. Until this round that
-- payload carried an hourly figure nothing prices with (`rates`, superseded
-- by the plan store of 0012 and the engine-priced close of 0013) and an empty
-- `plate_rules`. Now it carries THE GARAGE'S RATE PLANS, whole, as 0012
-- stores them (the engine selects among them by entry time; this platform
-- filters nothing); THE ENTITLEMENT FACTS, read from garage-pass and
-- monthly-billing through the two modules' own `show-garage-register` verbs
-- (their command lines, as subprocesses -- this platform imports neither and
-- paraphrases nothing); and THE GARAGE'S OPEN STAYS, because a transient
-- cannot be priced without its entry time and the entry time lives here.
--
-- TWO CADENCES. Plans, entitlements and garage settings change rarely; open
-- stays change with every car. So the stays are ALSO served on their own
-- route, `GET /lane/stays?since=<cursor>`, as a delta: every row whose
-- `change_seq` is past the cursor, closed rows included so a reader can drop
-- them. That is what this migration adds: `sessions.change_seq`, drawn from
-- one sequence, set on insert by default and BUMPED BY TRIGGER whenever a
-- column the stay feed carries changes (entry, exit, the vehicle, the entry
-- lane) -- so every writer, present and future, moves the cursor without
-- knowing it exists. Nothing else about a session moves it: the purge nulls
-- descriptors and entitlement records, and a redaction is not a car arriving
-- or leaving.
--
-- THE CURSOR'S HONEST LIMIT. A sequence value is taken when a row is written,
-- and a transaction can commit AFTER a later value has already been read: a
-- delta since N can miss a row whose value is below N but whose commit came
-- later. The full open set, served with its own cursor on `/lane/rules` and
-- on `/lane/stays` without `since`, is what bounds that miss -- a reader
-- takes the full set on the slow cadence and the delta on the fast one. The
-- test plants exactly that race and asserts both halves: the delta misses,
-- the full set has the row.
--
-- WHAT THE PAYLOAD NOW CARRIES TO A DEVICE IS PERSONAL DATA: the plates and
-- ticket references of every open stay, and of every pass holder and monthly
-- vehicle the modules register at the garage. The lane holds them in memory,
-- replaced on every refresh; docs/DATA_RETENTION.md says so. Nothing is added
-- to the schema that the retention purge does not already reach.
--
-- `rates` STAYS. `sessions.rate_id` references it and the hourly-legacy rows
-- of 0013 name it; the table is history. What is retired is the WRITE:
-- `POST /garages/:id/rates` now refuses by name (`rates_retired`, 410) and
-- points at the plan store. No migration is needed for a route.

BEGIN;

CREATE SEQUENCE sessions_change_seq;

ALTER TABLE sessions
  ADD COLUMN change_seq bigint NOT NULL DEFAULT nextval('sessions_change_seq');

-- The delta and the snapshot both read by garage, in cursor order.
CREATE INDEX sessions_garage_change_seq_idx ON sessions (tenant_id, garage_id, change_seq);

-- Every writer moves the cursor, without knowing it exists.
CREATE FUNCTION sessions_bump_change_seq() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.entry_at      IS DISTINCT FROM NEW.entry_at
  OR OLD.exit_at       IS DISTINCT FROM NEW.exit_at
  OR OLD.vehicle_id    IS DISTINCT FROM NEW.vehicle_id
  OR OLD.entry_lane_id IS DISTINCT FROM NEW.entry_lane_id THEN
    NEW.change_seq := nextval('sessions_change_seq');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_bump_change_seq
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_bump_change_seq();

-- The application role inserts sessions (the DEFAULT draws from the sequence)
-- and the trigger runs as the invoking role.
GRANT USAGE ON SEQUENCE sessions_change_seq TO openparking_app;

COMMIT;
