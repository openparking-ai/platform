-- 0019 — a validation at the exit: a linked module asked through its own door,
-- and the discount it answers written as one more line on the stay's ledger.
--
-- A VALIDATION is a discount a merchant (a restaurant, a shop) gives a driver
-- ahead of the exit, carried by the driver's phone number. The module that
-- holds validations is ITS OWN SYSTEM with its own database and its own
-- tenants, asked the way garage-pass and monthly-billing are asked (0015):
-- a command line, run as a subprocess with the environment the operator gave
-- this platform, its DSN never read here. THIS REPOSITORY GETS THE ABILITY TO
-- ASK, NEVER THE MODULE: an operator without one links nothing, and a close
-- with a phone at a garage that links none says so and discounts nothing.
--
--   <door> validation-in-store --tenant T --garage G --at EXIT        < phone
--   <door> claim-in-store --tenant T --garage G --at EXIT
--          --consumer openparking --ref SESSION --base-minor FEE --currency C < phone
--
-- THE PHONE NUMBER IS NEVER STORED. It arrives on the close body, goes to the
-- door on STDIN -- never argv, because argv is kept on the record -- and is not
-- written to any column, any event or any log line. The door's answers carry
-- the number's last four digits for a human reading them at a terminal; this
-- platform DROPS that key before it keeps an answer. What is kept is the argv
-- (tenant, garage, instant, consumer, the session's own id, the fee and its
-- currency), the exit code, and the answer without the phone.
--
-- MONEY CROSSES THIS DOOR, unlike the other two, which answer covered or not.
-- The discount is the MODULE'S ASSERTION, computed by the module on its own
-- rule, and it is stored as what it was -- the claim's answer, verbatim but
-- for the phone -- the way a device-asserted fee is stored beside the fee
-- (0017). It is applied as ONE MORE LINE on the ledger: `breakdown` is already
-- an ordered list of lines whose running total is the fee, with a negative
-- line for a cap; the validation is a negative line after the engine's lines,
-- `code: 'validation'`, and the fee is the running total including it. The
-- engine's number is not recomputed and the engine is not asked again. The
-- reconciler, which re-derives the engine's number for a lane-decided close,
-- compares it with the fee WITHOUT the validation line -- the line is not the
-- engine's.
--
-- ONLY A PRICED FEE ABOVE ZERO IS DISCOUNTED. A covered stay, a stay the
-- engine refused, and a zero fee have nothing to take a discount from, and a
-- claim would consume the driver's validation for nothing: the door is not
-- asked, and the record says why.
--
-- `sessions.validation` is the record: null when the close carried no phone;
-- otherwise an object saying whether the module was consulted and what it
-- said. It holds no vehicle identity and no phone, so the retention purge has
-- nothing in it to reach.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE garages
  ADD COLUMN validations_link jsonb;

ALTER TABLE garages
  ADD CONSTRAINT garages_validations_link_is_a_link CHECK (
    validations_link IS NULL OR (
      jsonb_typeof(validations_link) = 'object'
      -- coalesced: a missing key makes jsonb_typeof NULL, and a NULL CHECK passes
      AND coalesce(jsonb_typeof(validations_link->'tenant_id'), '') = 'string'
      AND coalesce(jsonb_typeof(validations_link->'garage_id'), '') = 'string'
      AND (validations_link->>'tenant_id') <> '' AND (validations_link->>'garage_id') <> ''
    )
  );

ALTER TABLE sessions
  ADD COLUMN validation jsonb
    CONSTRAINT sessions_validation_is_a_record CHECK (
      validation IS NULL OR (
        jsonb_typeof(validation) = 'object'
        AND coalesce(jsonb_typeof(validation->'consulted'), '') = 'boolean'
      )
    ),
  -- A record only on a closed stay: an open stay has no exit to ask about.
  ADD CONSTRAINT sessions_validation_only_when_closed CHECK (
    validation IS NULL OR exit_at IS NOT NULL
  );

COMMIT;
