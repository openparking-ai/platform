-- 0019 — a validation at the exit: a linked module asked through its own door,
-- and the discount it answers written as one more line on the stay's ledger.
--
-- A VALIDATION is a discount a merchant (a restaurant, a shop) gives a driver
-- ahead of the exit, carried by the driver's phone number. The module that
-- holds validations is ITS OWN SYSTEM with its own database and its own
-- tenants, asked the way garage-pass and monthly-billing are asked (0015):
-- a command line, run as a subprocess with the environment the operator gave
-- this platform, its DSN never read here. THIS REPOSITORY GETS THE ABILITY TO
-- ASK, NEVER THE MODULE: an operator without one links nothing, and a
-- phone entered at a garage that links none discounts nothing.
--
--   <door> validation-in-store --tenant T --garage G --at EXIT        < phone
--   <door> claim-in-store --tenant T --garage G --at EXIT
--          --consumer openparking --ref SESSION --base-minor FEE --currency C < phone
--   <door> release-in-store --tenant T --garage G --at NOW
--          --consumer openparking --ref SESSION
--
-- THE PHONE NUMBER IS NEVER STORED. It arrives from the reader, goes to the
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
-- WHEN THE CLAIM IS MADE (amendment A1). Not at the close: the close comes
-- after the barrier opens, and the driver has to see the discounted amount
-- BEFORE they pay. So the phone is claimed THE MOMENT IT IS ENTERED at the
-- reader -- `POST /lane/sessions/:id/validation`, on the fee the lane's own
-- decision priced -- and the claim is HELD on the open stay. The close RECORDS
-- the held claim: the same line, now on the ledger, with no door asked and
-- nothing recomputed. The door, the discount and the line are as above; only
-- their moment moved.
--
-- A HOLD THAT IS NEVER RECORDED IS GIVEN BACK. A driver who enters a phone and
-- then does not pay and leave has claimed something their stay will not
-- record. The claim is released through the module's own door
-- (`release-in-store`), and the validation is unclaimed again -- live if its
-- garage-day has not ended:
--   * by the sweep (`npm run release-validation-holds`), for a stay still OPEN
--     a hold window after the claim (VALIDATION_HOLD_MINUTES, default 30);
--   * by the close, when the stay closes with no fee to take it (covered,
--     unpriced) or at a fee other than the one it was claimed on.
-- A driver who comes back to the reader after a release enters the phone
-- again and claims again.
--
-- `sessions.validation` is the record: null when no phone was claimed for the
-- stay; otherwise an object whose `state` is
--   claiming  a claim about to be asked for, COMMITTED before the door is
--             asked (amendment A2.3), on an OPEN stay: never a discount;
--   held      claimed at the reader, on an OPEN stay, not yet recorded;
--   recorded  taken by the close: its line is on the ledger -- only when the
--             close says the reader showed the discounted fee (A2.2);
--   releasing a release about to be asked for, COMMITTED before the door is
--             asked (A2.3): never a discount, whatever the door did;
--   released  given back, by the sweep or by the close, with the reason.
-- A closed stay never holds or claims, and an open one never has recorded.
-- The door commits in its own database first, so the state written BEFORE a
-- door call is what a rollback after it leaves behind -- and both are states
-- the sweep finishes and no close records. It holds no
-- vehicle identity and no phone, so the retention purge has nothing in it to
-- reach.
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
        AND coalesce(validation->>'state', '') IN ('claiming', 'held', 'recorded', 'releasing', 'released')
      )
    ),
  -- A hold lives on an open stay; the close resolves it, recorded or released.
  ADD CONSTRAINT sessions_validation_state_fits_the_stay CHECK (
    validation IS NULL
    OR (validation->>'state' IN ('claiming', 'held') AND exit_at IS NULL)
    OR (validation->>'state' = 'recorded' AND exit_at IS NOT NULL)
    OR validation->>'state' IN ('releasing', 'released')
  );

-- The sweep's queues: open stays holding or claiming, and any stay releasing.
CREATE INDEX sessions_validation_unresolved_idx ON sessions (tenant_id)
  WHERE validation->>'state' IN ('claiming', 'held', 'releasing');

COMMIT;
