-- 0034 — a rate plan that has not started yet may be withdrawn and replaced
-- (U7i fix 1).
--
-- THE OWNER'S RULE, 2026-10-12: an owner has rates scheduled to start on a
-- later date; today they save a change. On that later date the scheduled rates
-- start WITH TODAY'S CHANGE IN THEM. Before this, the later version had been
-- built on the rates in force when it was saved, so a change made today was
-- undone on the later date without a word (U7i gate, F2).
--
-- A plan whose `effective_from` is still in the future has priced nothing --
-- the engine picks the version in force at a stay's ENTRY, and no stay has
-- entered after an instant that has not come -- so withdrawing it rewrites no
-- history. One that has started may have priced a stay, and is never touched.
--
--   withdrawn_at   when it was withdrawn. NULL: it prices.
--   withdrawn_by   who withdrew it, as the change log names an actor
--                  (`owner:<id>` or `key:<id>`): never a name or an address.
--
-- APPEND-ONLY STILL, WITH ONE NARROW DOOR. 0012 granted SELECT and INSERT and
-- nothing else. The application role may now UPDATE these two columns and no
-- other, and the trigger below refuses every UPDATE that is not exactly "set
-- both, once, on a plan that has not started", by name. DELETE stays refused
-- by the grant, as before.
--
-- "ONE VERSION PER INSTANT" COUNTS ONLY THE PLANS THAT PRICE. The replacement
-- of a withdrawn plan takes the same instant, so 0012's UNIQUE constraint
-- becomes a unique index over the plans not withdrawn -- under the same name,
-- so the store's refusal by name is unchanged. "One document per version"
-- stays whole: a version name is never used twice, withdrawn or not.
--
-- WITHDRAWN PLANS ARE NEVER USED FOR A PRICE. In the application that is one
-- function, `ratePlansForGarage` (src/ratePlans.js); here it is the opening
-- gate, which counts the plans stored and in force: it counts only the plans
-- not withdrawn (a withdrawn plan is in the future, so the "in force" count
-- could not change, but "plans stored" would have counted one that prices
-- nothing).
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE rate_plans
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by text CHECK (withdrawn_by IS NULL OR length(withdrawn_by) BETWEEN 1 AND 200);

-- Both or neither.
ALTER TABLE rate_plans
  ADD CONSTRAINT rate_plans_withdrawn_whole CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL));

-- One version per instant, among the plans that price.
ALTER TABLE rate_plans DROP CONSTRAINT rate_plans_one_version_per_instant;
CREATE UNIQUE INDEX rate_plans_one_version_per_instant
  ON rate_plans (tenant_id, garage_id, effective_from)
  WHERE withdrawn_at IS NULL;

-- Withdrawal is the only change a plan ever takes, and only before it starts.
-- The clock is the statement's own (clock_timestamp()), not the transaction's
-- start: a transaction opened a second before a plan starts must not withdraw
-- it a second after.
CREATE FUNCTION rate_plans_withdrawn_only_before_start() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.garage_id IS DISTINCT FROM OLD.garage_id
     OR NEW.plan_version IS DISTINCT FROM OLD.plan_version
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.document IS DISTINCT FROM OLD.document
     OR NEW.engine_schema_version IS DISTINCT FROM OLD.engine_schema_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'rate_plans: a stored plan is never edited; a changed plan is a new version'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'rate_plans_never_edited';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'rate_plans: plan % was already withdrawn at %', OLD.id, OLD.withdrawn_at
      USING ERRCODE = 'check_violation', CONSTRAINT = 'rate_plans_withdrawn_once';
  END IF;
  IF NEW.withdrawn_at IS NULL THEN
    RAISE EXCEPTION 'rate_plans: the only change a plan takes is its withdrawal'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'rate_plans_never_edited';
  END IF;
  IF OLD.effective_from <= clock_timestamp() THEN
    RAISE EXCEPTION 'rate_plans: plan % started at % and may have priced a stay; it is never withdrawn', OLD.id, OLD.effective_from
      USING ERRCODE = 'check_violation', CONSTRAINT = 'rate_plans_withdrawn_before_start';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rate_plans_withdrawn_only_before_start
  BEFORE UPDATE ON rate_plans
  FOR EACH ROW EXECUTE FUNCTION rate_plans_withdrawn_only_before_start();

GRANT UPDATE (withdrawn_at, withdrawn_by) ON rate_plans TO openparking_app;

-- The opening gate (0022's, unchanged but for the plans it counts).
CREATE OR REPLACE FUNCTION garages_activation_gate() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  plans_stored integer;
  plans_in_force integer;
  tax_sets_stated integer;
  tax_sets_in_force integer;
BEGIN
  -- A garage is never CREATED active: activation is an act after the plan
  -- exists, and a plan needs the garage to exist first.
  IF TG_OP = 'INSERT' THEN
    IF NEW.activated_at IS NOT NULL THEN
      RAISE EXCEPTION 'garages: a garage is not created active; activate it once its plan is stored'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'garages_created_inactive';
    END IF;
    RETURN NEW;
  END IF;
  -- A stated transient mode is never un-stated.
  IF OLD.transient_available IS NOT NULL AND NEW.transient_available IS NULL THEN
    RAISE EXCEPTION 'garages: transient_available, once stated, cannot be un-stated'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'garages_transient_mode_is_not_unstated';
  END IF;
  -- Activation is never undone or moved.
  IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'garages: activated_at, once set, cannot be cleared or changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'garages_activation_is_not_undone';
  END IF;
  -- Activating: every condition, observed now.
  IF OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL THEN
    IF NEW.transient_available IS NULL THEN
      RAISE EXCEPTION 'garages: cannot activate % -- transient_available is unstated', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'garages_activation_needs_transient_mode';
    END IF;
    -- Only the plans that price (0034): a withdrawn plan is not counted.
    SELECT count(*), count(*) FILTER (WHERE effective_from <= now())
      INTO plans_stored, plans_in_force
      FROM rate_plans
     WHERE garage_id = NEW.id AND tenant_id = NEW.tenant_id AND withdrawn_at IS NULL;
    IF plans_stored = 0 THEN
      RAISE EXCEPTION 'garages: cannot activate % -- no rate plan is stored', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'garages_activation_needs_a_plan';
    END IF;
    IF plans_in_force = 0 THEN
      RAISE EXCEPTION 'garages: cannot activate % -- % plan(s) stored, none in force yet', NEW.id, plans_stored
        USING ERRCODE = 'check_violation', CONSTRAINT = 'garages_activation_needs_a_plan_in_force';
    END IF;
    -- Taxes (0022): stated -- with rules, or as none -- and in force.
    SELECT count(*), count(*) FILTER (WHERE effective_from <= now())
      INTO tax_sets_stated, tax_sets_in_force
      FROM garage_tax_sets
     WHERE garage_id = NEW.id AND tenant_id = NEW.tenant_id;
    IF tax_sets_stated = 0 THEN
      RAISE EXCEPTION 'garages: cannot activate % -- its taxes are unstated', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'garages_activation_needs_taxes_stated';
    END IF;
    IF tax_sets_in_force = 0 THEN
      RAISE EXCEPTION 'garages: cannot activate % -- % tax set(s) stated, none in force yet', NEW.id, tax_sets_stated
        USING ERRCODE = 'check_violation', CONSTRAINT = 'garages_activation_needs_taxes_in_force';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
