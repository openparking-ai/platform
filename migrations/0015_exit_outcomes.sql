-- 0015 — the exit has three outcomes, named, and two modules are consulted
-- before a stay is priced.
--
-- HIS WORDS, 2026-09-20: "we have several different customers: monthly/garage
-- pass, transient, transient with card on file." Three things happen at the
-- barrier, and the answer this platform records SAYS WHICH:
--
--   covered                 a monthly agreement or a garage pass covers the
--                           stay. No transient fee. Which module said so, and
--                           what it said, is on the row.
--   transient               priced through the engine (0013), the money
--                           collected at the barrier -- or unpriced with its
--                           refusal, the backstop 0013 keeps.
--   transient_card_on_file  priced, charged off-session, the barrier opens
--                           with no tap. DECLARED HERE AND PRODUCED NOWHERE:
--                           this platform holds no customer, no account and
--                           no card (verified: those words score zero across
--                           every migration), so no close can say it yet. It
--                           is in the vocabulary so the third customer has a
--                           seat and the payment round does not re-open this
--                           row's shape; a test asserts nothing writes it.
--
-- TWO MODULES, CONSULTED THROUGH THEIR OWN DOORS. `garage-pass access-in-store
-- --direction exit` and `monthly-billing covered-in-store --entered-at` are
-- the two command lines, run as subprocesses with the environment the
-- operator gave this platform (their DSNs are theirs, never read here). This
-- platform imports neither and holds none of their data. What each printed,
-- and its exit code, is kept verbatim in `entitlement` beside the outcome --
-- the named reason for a not-covered answer as much as for a covered one.
-- Neither call takes money and neither opens or refuses a barrier: their own
-- tests hold that line (garage-pass G3 and G21, monthly-billing G6), and this
-- side hands them an identity, a garage, a lane and two instants, and no
-- amount -- the argv is on the record so that can be checked.
--
-- LINKS ARE STATED, NEVER INFERRED. A platform garage says which garage-pass
-- garage and which monthly-billing garage it is, under which tenant of each
-- (`garage_pass_link`, `monthly_billing_link`: `{tenant_id, garage_id}`), and
-- a link is PROBED when it is stated -- the module must answer the question
-- at all, covered or not -- and refused by name when it cannot. NULL is
-- "not linked": that module is not consulted and the record says so. A
-- garage with neither link prices every exit as transient, on the record.
--
-- A MODULE THAT CANNOT ANSWER IS NOT A NOT-COVERED. An unset DSN, a database
-- that is down, a garage the module does not know: the exit code says
-- "could not decide", and a stay whose entitlement could not be decided is
-- not recorded as transient and charged -- that would be a pass holder billed
-- on the strength of an outage. The close answers 5xx, the transaction rolls
-- back, the lane retries. The same rule as the engine (0013).
--
-- WHAT A CLOSED STAY IS, NOW. 0013's three shapes gain a fourth -- COVERED:
-- `exit_outcome = 'covered'`, no fee, no plan pricing, no refusal, and the
-- entitlement record present -- and every non-legacy closed stay names its
-- outcome and carries its entitlement record, even when both modules were
-- unlinked. The hourly-legacy rows (the old path's) carry neither, as before.
--
-- No personal data is added beyond what the row already holds: the identity
-- consulted is the plate or ticket the stay already carries, and it appears
-- inside `entitlement` (the argv and the modules' answers name it). RETENTION
-- REACHES IT: the purge nulls `entitlement` on the sessions of every vehicle
-- it redacts, keeping `exit_outcome`. The outcome survives; who it was about
-- does not -- the same shape as the descriptors.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE garages
  ADD COLUMN garage_pass_link     jsonb,
  ADD COLUMN monthly_billing_link jsonb;

ALTER TABLE garages
  ADD CONSTRAINT garages_garage_pass_link_is_a_link CHECK (
    garage_pass_link IS NULL OR (
      jsonb_typeof(garage_pass_link) = 'object'
      -- coalesced: a missing key makes jsonb_typeof NULL, and a NULL CHECK passes
      AND coalesce(jsonb_typeof(garage_pass_link->'tenant_id'), '') = 'string'
      AND coalesce(jsonb_typeof(garage_pass_link->'garage_id'), '') = 'string'
      AND (garage_pass_link->>'tenant_id') <> '' AND (garage_pass_link->>'garage_id') <> ''
    )
  ),
  ADD CONSTRAINT garages_monthly_billing_link_is_a_link CHECK (
    monthly_billing_link IS NULL OR (
      jsonb_typeof(monthly_billing_link) = 'object'
      -- coalesced: a missing key makes jsonb_typeof NULL, and a NULL CHECK passes
      AND coalesce(jsonb_typeof(monthly_billing_link->'tenant_id'), '') = 'string'
      AND coalesce(jsonb_typeof(monthly_billing_link->'garage_id'), '') = 'string'
      AND (monthly_billing_link->>'tenant_id') <> '' AND (monthly_billing_link->>'garage_id') <> ''
    )
  );

ALTER TABLE sessions
  ADD COLUMN exit_outcome text
    CONSTRAINT sessions_exit_outcome_is_named CHECK (
      exit_outcome IN ('covered', 'transient', 'transient_card_on_file')
    ),
  ADD COLUMN entitlement jsonb
    CONSTRAINT sessions_entitlement_is_a_record CHECK (
      entitlement IS NULL OR jsonb_typeof(entitlement) = 'object'
    );

ALTER TABLE sessions DROP CONSTRAINT sessions_closed_is_priced_or_refused;

-- Four shapes for a closed stay -- covered, priced by a plan, priced by an
-- hourly rate (legacy), unpriced with its refusal -- exactly one; an open stay
-- is none of them. Every shape but the legacy one names its outcome and
-- carries its entitlement record (nulled only by the retention purge, which
-- stamps the vehicle it did it for).
ALTER TABLE sessions
  ADD CONSTRAINT sessions_closed_is_covered_priced_or_refused CHECK (
    (exit_at IS NULL
       AND fee_minor IS NULL AND plan_version IS NULL AND breakdown IS NULL
       AND space_class IS NULL AND pricing_refusal IS NULL
       AND exit_outcome IS NULL AND entitlement IS NULL)
    OR
    (exit_at IS NOT NULL AND exit_outcome IS NOT NULL AND exit_outcome = 'covered'
       AND fee_minor IS NULL AND plan_version IS NULL AND breakdown IS NULL
       AND space_class IS NULL AND pricing_refusal IS NULL)
    OR
    -- `exit_outcome IS NOT NULL AND` on the shapes that name one: a NULL
    -- outcome would make `IN (...)` NULL, and a CHECK that is NULL passes.
    (exit_at IS NOT NULL AND exit_outcome IS NOT NULL
       AND exit_outcome IN ('transient', 'transient_card_on_file')
       AND fee_minor IS NOT NULL
       AND plan_version IS NOT NULL AND breakdown IS NOT NULL AND space_class IS NOT NULL
       AND pricing_refusal IS NULL)
    OR
    (exit_at IS NOT NULL AND exit_outcome IS NULL AND entitlement IS NULL
       AND fee_minor IS NOT NULL AND hourly_minor_applied IS NOT NULL
       AND plan_version IS NULL AND breakdown IS NULL AND space_class IS NULL
       AND pricing_refusal IS NULL)
    OR
    (exit_at IS NOT NULL AND exit_outcome IS NOT NULL AND exit_outcome = 'transient'
       AND fee_minor IS NULL
       AND plan_version IS NULL AND breakdown IS NULL AND space_class IS NULL
       AND pricing_refusal IS NOT NULL)
  );

-- A covered close has no fee; the unpriced list must not read it as one.
DROP INDEX sessions_unpriced_idx;
CREATE INDEX sessions_unpriced_idx ON sessions (garage_id, exit_at)
  WHERE exit_at IS NOT NULL AND pricing_refusal IS NOT NULL;

COMMIT;
