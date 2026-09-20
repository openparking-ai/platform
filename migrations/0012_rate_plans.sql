-- 0012 — the plan store: where a garage's rate plans live, and what a closed
-- stay keeps of the one that priced it.
--
-- THERE WAS NOTHING TO PRICE FROM. `rate-engine` prices a stay from a plan
-- document handed to it on every call -- `quote(plans, stay)`, a LIST, and the
-- engine picks the version in force at entry -- and it has no persistence of
-- any kind. `rates` (0002) is six columns: no currency, no plan, no version,
-- no effective date, and `src/fees.js` is `billableHours × hourly_minor`. So
-- every rule the engine can express -- grace, early bird, a daily maximum, a
-- weekend structure, a space class -- could not be charged by this product,
-- and there was no place a garage's plan could be stored if somebody wrote
-- one. This table is that place. It does not price, does not choose rules and
-- does not interpret a plan: it holds plan documents for a garage and its read
-- hands every one of them to the engine.
--
-- THE DOCUMENT IS STORED WHOLE AND IS NOT DECOMPOSED INTO COLUMNS. The engine
-- validates a plan on load, rejects and NAMES any key its version does not
-- understand, and says in its own words that the document is a versioned
-- commercial contract expected to GAIN fields. A schema that shredded it into
-- columns would need a migration on every plan change and would silently drop
-- exactly the keys the engine is built to refuse. `plan_version` and
-- `effective_from` are lifted out ONLY as index keys, and each is CHECKed
-- against the document it was lifted from, so the key and the contract cannot
-- disagree. The document is the fact; the columns are how it is found.
--
-- A GARAGE HAS MANY PLANS, NOT ONE, AND THIS TABLE DOES NOT SELECT. The
-- engine's `select_plan` picks by `effective_from <= entry_at`, and its own
-- test (`test_f3_entry_time_governs`) is what holds the entry-time rule. A
-- second selector here would be the copy that comes to disagree with the one
-- that charges the driver. The read returns every plan of the garage; the
-- engine does the choosing. The two UNIQUE constraints are not selection: two
-- documents under one version name is nonsense the engine refuses on sight,
-- and two versions taking effect at the same instant is the ambiguity the
-- engine refuses at quote time (`CONFLICT_AMBIGUOUS_PLAN_SELECTION`) -- for
-- every stay from that instant on. Refusing the pair at WRITE time is the
-- same rule, caught in front of an operator instead of a driver.
--
-- CURRENCY IS THE GARAGE'S, IN ONE PLACE. `garages.currency` (0002) is served
-- to the lane, frozen onto every session, and has no update path. The engine
-- requires `currency` on the plan document too (its loader refuses a plan
-- without one) and refuses a quote whose caller's currency differs from the
-- plan's. So the document RESTATES the garage's currency and never sets it:
-- the trigger below refuses a plan whose `currency` is not the garage's, by
-- name, and the route says the same thing first with a better sentence. A
-- rule enforced only at a route is a rule one direct INSERT goes around.
--
-- A PLAN IS VALIDATED BEFORE IT IS STORED, NOT AT THE BARRIER. The route runs
-- the engine's `validate-plan` and refuses a document with any finding. That
-- cannot be expressed here -- the engine is the only thing that knows what a
-- plan means -- so `engine_schema_version` records which engine contract said
-- the document was whole, and the route's tests plant a document with a gap
-- and require the refusal.
--
-- APPEND-ONLY BY GRANT. A plan is a commercial contract that priced stays; a
-- new price is a new version with a later `effective_from`, not an edit. The
-- application role can read and insert and can do nothing else, the same
-- shape as `events`. There is no personal data on this table and the
-- retention purge does not touch it -- test/rate-plans.test.js asserts both.
--
-- WHAT A CLOSED STAY KEEPS. `sessions` already freezes `rate_id`,
-- `hourly_minor_applied` and `fee_minor` at exit, and 0002's comment says why:
-- deriving a closed session's fee from the rates table on read means a rate
-- change rewrites history. The same rule now covers the plan: a closed stay
-- names the `plan_version` that priced it and keeps the engine's `breakdown`
-- -- the plain-English line for every part of the fee -- beside `fee_minor`.
-- The two travel together or not at all, and only on a closed stay. THEY ARE
-- NULLABLE IN THIS MIGRATION BECAUSE NOTHING PRICES FROM A PLAN YET: the close
-- route still prices with `src/fees.js`, which knows no plan, and a NULL here
-- says so honestly. The round that re-points the close onto the engine is the
-- one that tightens this to NOT NULL on every closed stay; until then a closed
-- stay with a NULL `plan_version` is a stay `fees.js` priced.
--
-- Tenant-owned; docs/RLS_TEMPLATE.md, with the grant narrowed as above.
--
-- Run as the database OWNER.

BEGIN;

CREATE TABLE rate_plans (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id             uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  -- Index keys lifted from the document, and held to it.
  plan_version          text        NOT NULL,
  effective_from        timestamptz NOT NULL,
  -- The plan, whole, exactly as the engine validated it.
  document              jsonb       NOT NULL,
  -- The engine contract version that validated the document before it was
  -- stored. A later engine may know keys this one refused; the record says
  -- which one looked.
  engine_schema_version integer     NOT NULL CHECK (engine_schema_version >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rate_plans_document_is_an_object CHECK (jsonb_typeof(document) = 'object'),
  CONSTRAINT rate_plans_version_is_the_documents CHECK (
    document->>'plan_version' = plan_version
  ),
  CONSTRAINT rate_plans_effective_from_is_the_documents CHECK (
    (document->>'effective_from')::timestamptz = effective_from
  ),
  CONSTRAINT rate_plans_one_document_per_version UNIQUE (tenant_id, garage_id, plan_version),
  CONSTRAINT rate_plans_one_version_per_instant UNIQUE (tenant_id, garage_id, effective_from)
);
CREATE INDEX rate_plans_tenant_id_idx ON rate_plans (tenant_id);
CREATE INDEX rate_plans_garage_idx ON rate_plans (garage_id, effective_from);

-- The document restates the garage's currency; it never sets it.
CREATE FUNCTION rate_plans_currency_is_the_garages() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  garage_currency text;
BEGIN
  SELECT g.currency INTO garage_currency
    FROM garages g
   WHERE g.id = NEW.garage_id AND g.tenant_id = NEW.tenant_id;
  -- Invisible under this tenant's policy: another tenant's garage, or none.
  -- The foreign key alone would accept another tenant's garage id, because a
  -- foreign-key check runs as the table owner and sees every row.
  IF garage_currency IS NULL THEN
    RAISE EXCEPTION 'rate_plans: garage % is not this tenant''s under row-level security', NEW.garage_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.document->>'currency' IS DISTINCT FROM garage_currency THEN
    RAISE EXCEPTION 'rate_plans: the plan prices in % but the garage''s currency is %',
      COALESCE(NEW.document->>'currency', 'nothing'), garage_currency
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'rate_plans_currency_is_the_garages';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rate_plans_currency_is_the_garages
  BEFORE INSERT ON rate_plans
  FOR EACH ROW EXECUTE FUNCTION rate_plans_currency_is_the_garages();

ALTER TABLE rate_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_plans FORCE  ROW LEVEL SECURITY;

CREATE POLICY rate_plans_tenant_isolation ON rate_plans
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Append-only: no UPDATE, no DELETE. See above.
GRANT SELECT, INSERT ON rate_plans TO openparking_app;

-- What a closed stay keeps of the plan that priced it.
ALTER TABLE sessions
  ADD COLUMN plan_version text,
  ADD COLUMN breakdown    jsonb;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_breakdown_is_a_ledger CHECK (
    breakdown IS NULL OR jsonb_typeof(breakdown) = 'array'
  );

-- The version and the breakdown come together, or not at all, and only once
-- the stay has closed. A fee with a version and no breakdown is a number with
-- no explanation; a breakdown with no version is an explanation nothing can be
-- checked against.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_plan_pricing_is_complete CHECK (
    (plan_version IS NULL AND breakdown IS NULL)
    OR
    (plan_version IS NOT NULL AND breakdown IS NOT NULL AND exit_at IS NOT NULL)
  );

COMMIT;
