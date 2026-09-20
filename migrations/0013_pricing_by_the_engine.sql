-- 0013 — the close prices through the engine, and a close that cannot price
-- still closes.
--
-- THE ONE PRICING PATH. `src/fees.js` (billableHours × hourly_minor) is gone.
-- The close route hands every plan of the garage (0012) to `rate-engine`'s
-- `POST /v1/quote` and freezes what came back onto the stay: `fee_minor`,
-- `plan_version`, `breakdown` and the `space_class` it was priced as. The
-- engine chooses the version in force at ENTRY -- its rule, held by its own
-- test -- and this platform does not filter the list before handing it over,
-- because a platform that handed it one version could never demonstrate the
-- choice was by entry rather than by exit. One computation feeds everything
-- downstream: what the response echoes IS the row, never a recomputation.
--
-- A SPACE CLASS, BECAUSE THE ENGINE PRICES A SPACE. `quote()` takes the class
-- of the space the car occupied, and a plan declares the classes it prices;
-- a class the plan does not declare is a refusal (`GAP_UNDECLARED_SPACE_CLASS`).
-- This platform has no space, only a garage, so the class is the GARAGE'S:
-- one column, set when the garage is created and frozen like its currency.
-- The default `'standard'` is the product's standing fact -- every space in a
-- garage has been the same space since `rates` was one hourly figure per
-- garage -- written down in one place. A garage with two kinds of space is not
-- expressible; that is a stated limit, not a hidden one. The store (0012)
-- now refuses a plan that does not declare the garage's class, so the gap is
-- met in front of an operator and not at the barrier.
--
-- THE CLOSE THAT CANNOT PRICE CLOSES. `computeFee` could not fail; `quote()`
-- refuses, by design, with named findings -- no version in force at entry,
-- a gap the plan set left -- and a garage with no plan at all has nothing to
-- price from. Before this migration that path was a 409 (`no_rate_configured`),
-- and the lane DROPS a 409: the barrier has already opened, the car is gone,
-- the stay never closes, nothing is billed, and the car is counted inside for
-- ever. The likeliest cause is the ordinary first morning of a plan: cars that
-- entered the night before, under no version yet in force. So a refusal is
-- not a refusal of the CLOSE. The stay closes with `fee_minor` NULL and the
-- refusal -- the engine's findings, verbatim, or the platform's own named
-- reason -- in `pricing_refusal`, and a `close_unpriced` event beside it
-- (append-only, the record a human works from), and the reconciliation report
-- lists it. The same principle as `exit_held`: a flag for a human, not a hole
-- in the ledger. What this does NOT do: invent a fee, or price by anything
-- the engine did not say.
--
-- An engine that cannot be REACHED is different and is not this: the stay can
-- be priced, just not now. That close answers 5xx, the transaction rolls back
-- and the lane's outbox retries; recording a priceable stay as unpriced would
-- be a false record.
--
-- WHAT A CLOSED STAY IS, NOW. Three shapes, and the constraint below names
-- them: priced by a plan (`fee_minor`, `plan_version`, `breakdown`,
-- `space_class`, all present, `pricing_refusal` NULL); priced by an hourly
-- rate (`fee_minor` and `hourly_minor_applied` present -- the rows the old
-- path wrote, kept honest, and nothing writes this shape any more); or
-- UNPRICED (`fee_minor` NULL, `pricing_refusal` present, nothing else). An
-- open stay carries none of it. 0002's `sessions_closed_is_complete` said a
-- closed stay always has a fee; that sentence is replaced here, not weakened
-- in place, and 0012's `sessions_plan_pricing_is_complete` is folded in.
--
-- No personal data is added: a breakdown is the engine's ledger lines, a
-- refusal is its findings, a space class is the garage's. The retention purge
-- leaves all three where they are.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE garages
  ADD COLUMN space_class text NOT NULL DEFAULT 'standard'
    CONSTRAINT garages_space_class_not_blank CHECK (space_class <> '');

ALTER TABLE sessions
  ADD COLUMN space_class     text,
  ADD COLUMN pricing_refusal jsonb;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_pricing_refusal_is_findings CHECK (
    pricing_refusal IS NULL OR jsonb_typeof(pricing_refusal) = 'array'
  );

ALTER TABLE sessions DROP CONSTRAINT sessions_closed_is_complete;
ALTER TABLE sessions DROP CONSTRAINT sessions_plan_pricing_is_complete;

-- The closing facts come together or not at all.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_closed_is_complete CHECK (
    (exit_at IS NULL AND exit_lane_id IS NULL AND close_event_id IS NULL)
    OR
    (exit_at IS NOT NULL AND exit_lane_id IS NOT NULL AND close_event_id IS NOT NULL)
  );

-- And a closed stay is priced by a plan, priced by an hourly rate, or
-- unpriced with its refusal -- exactly one -- while an open stay is none.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_closed_is_priced_or_refused CHECK (
    (exit_at IS NULL
       AND fee_minor IS NULL AND plan_version IS NULL AND breakdown IS NULL
       AND space_class IS NULL AND pricing_refusal IS NULL)
    OR
    (exit_at IS NOT NULL AND fee_minor IS NOT NULL
       AND plan_version IS NOT NULL AND breakdown IS NOT NULL AND space_class IS NOT NULL
       AND pricing_refusal IS NULL)
    OR
    (exit_at IS NOT NULL AND fee_minor IS NOT NULL AND hourly_minor_applied IS NOT NULL
       AND plan_version IS NULL AND breakdown IS NULL AND space_class IS NULL
       AND pricing_refusal IS NULL)
    OR
    (exit_at IS NOT NULL AND fee_minor IS NULL
       AND plan_version IS NULL AND breakdown IS NULL AND space_class IS NULL
       AND pricing_refusal IS NOT NULL)
  );

-- The unpriced closes of a garage: what the reconciliation report lists.
CREATE INDEX sessions_unpriced_idx ON sessions (garage_id, exit_at)
  WHERE exit_at IS NOT NULL AND fee_minor IS NULL;

COMMIT;
