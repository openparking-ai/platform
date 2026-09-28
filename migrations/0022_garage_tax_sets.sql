-- 0022 — a garage's taxes: stated as sets, and a third condition in the
-- activation gate that a garage cannot go live without stating them.
--
-- THE OWNER'S RULING, 2026-09-27: a garage states which taxes it charges, or
-- states that it charges none -- one or the other. So there are three states
-- and no fourth, no default and no inference:
--
--   stated, with rules   a set is in force and it holds one or more rules;
--   stated, none         a set is in force and it states that it holds NO
--                        rules (`rule_count = 0`) -- a statement, written;
--   UNSTATED             no set is in force: the garage has said nothing.
--
-- THE SHAPE IS `rate-engine`'s, NOT A NEW ONE. `tax.py` (rate-engine a12fb94)
-- takes a garage's taxes as a list of SETS, each with an `effective_from` and
-- its rules, and a rule as exactly `id`, `label`, `percent_bp`, `rounding` and
-- `sequence` -- all required, and nothing else: an unknown key, `base`
-- included, is refused at load. These two tables are that shape, column for
-- column, and there is no `base` column because there is only one base (the
-- money actually paid) and it is not stated. `rule_id` is the engine's `id`
-- -- the name its refusals use for a rule -- renamed only because `id` is
-- this schema's row key everywhere.
--
-- THE THREE STATES COPY `transient_available` (0014), which copied
-- `garage-pass`: unstated is not "none", nothing defaults it, a statement is
-- never un-stated. The difference is WHERE the statement lives. A tax position
-- changes over time -- a rate changes, a tax is repealed -- and the engine
-- already models that as a later set, so the statement lives on the set and
-- not in a garage column. A boolean on `garages` beside these sets would be
-- the same fact written twice, free to disagree with them; one concept in two
-- shapes is this estate's recurring defect.
--
-- "NONE" IS STATED, NOT INFERRED FROM AN EMPTY LIST. `rule_count` is written
-- by whoever states the set, and the deferred constraint trigger below holds
-- the set to it at COMMIT: a set whose rules arrived short (a half-written
-- statement) and a set given a rule in a later transaction (a statement
-- edited after the fact) are both refused, by name. So a set with no rules
-- is one that SAID zero, and the store can tell "stated none" from "no
-- statement" without reading anything into an absence.
--
-- A LATER `effective_from` IS HOW ANYTHING CHANGES. Stating a set supersedes
-- nothing and edits nothing; a new rate, a new tax and a repealed tax are all
-- a new set. Both tables are append-only by grant, like `rate_plans`.
--
-- TWO SETS AT ONE INSTANT IS A REFUSAL -- the engine refuses them at load
-- ("both take effect at ..., refused, both named"), and refusing the pair at
-- WRITE time is the same rule caught in front of an operator instead of a
-- driver. The UNIQUE constraint compares INSTANTS: `timestamptz` stores
-- `10:00-05:00` and `15:00Z` as one value. The route names both sets.
--
-- THIS PLATFORM COMPUTES NO PERCENTAGE, EVER. `rate-engine`'s `tax.py` is the
-- only tax arithmetic in the estate. These tables store and validate; nothing
-- here or in the route multiplies anything. No stay carries a tax after this
-- migration: the close is untouched, and hands the engine no tax set.
--
-- THE CHECKS BELOW ARE THE ENGINE'S LOAD RULES, held at the table so a direct
-- INSERT cannot store a set the engine would refuse: a non-empty label and
-- rule id, a positive whole `percent_bp`, a rounding the engine names
-- (`TAX_ROUNDINGS`: up, down, nearest -- there is no default), a non-negative
-- whole `sequence`, and no two rules in one set sharing an id or a sequence.
--
-- THE THIRD ACTIVATION CONDITION. `garages_activation_gate` (0014) is
-- replaced whole below with one more condition: a tax set in force now. It
-- is the rate condition's twin -- stated, and in force, not merely stored --
-- and it is monotonic the same way (sets are append-only, and once one is in
-- force one always is), so an active garage stays one and the lane routes may
-- still read `activated_at` and nothing else. The payment processor is still
-- no condition of this gate.
--
-- Tenant-owned; docs/RLS_TEMPLATE.md, the grant narrowed as for `rate_plans`.
-- No personal data. Run as the database OWNER.

BEGIN;

CREATE TABLE garage_tax_sets (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id      uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  effective_from timestamptz NOT NULL,
  -- How many rules this set states. Zero is the statement "this garage
  -- charges no tax from effective_from". Held to the rules actually stored,
  -- at commit, by the trigger below.
  rule_count     integer     NOT NULL CHECK (rule_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT garage_tax_sets_one_set_per_instant UNIQUE (tenant_id, garage_id, effective_from),
  -- The key the rules hang from: a rule's set is its own tenant's.
  CONSTRAINT garage_tax_sets_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX garage_tax_sets_tenant_id_idx ON garage_tax_sets (tenant_id);
CREATE INDEX garage_tax_sets_garage_idx ON garage_tax_sets (garage_id, effective_from);

CREATE TABLE garage_tax_rules (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid    NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tax_set_id  uuid    NOT NULL,
  -- The engine's five, and nothing else.
  rule_id     text    NOT NULL,
  label       text    NOT NULL,
  percent_bp  integer NOT NULL,
  rounding    text    NOT NULL,
  sequence    integer NOT NULL,

  CONSTRAINT garage_tax_rules_set_is_the_tenants
    FOREIGN KEY (tax_set_id, tenant_id) REFERENCES garage_tax_sets (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT garage_tax_rules_rule_id_not_blank CHECK (btrim(rule_id) <> ''),
  CONSTRAINT garage_tax_rules_label_not_blank CHECK (btrim(label) <> ''),
  CONSTRAINT garage_tax_rules_percent_bp_positive CHECK (percent_bp >= 1),
  CONSTRAINT garage_tax_rules_rounding_is_stated CHECK (rounding IN ('up', 'down', 'nearest')),
  CONSTRAINT garage_tax_rules_sequence_not_negative CHECK (sequence >= 0),
  CONSTRAINT garage_tax_rules_one_rule_per_id UNIQUE (tax_set_id, rule_id),
  CONSTRAINT garage_tax_rules_one_rule_per_sequence UNIQUE (tax_set_id, sequence)
);
CREATE INDEX garage_tax_rules_tenant_id_idx ON garage_tax_rules (tenant_id);

-- The garage is this tenant's. The foreign key alone would accept another
-- tenant's garage id, because a foreign-key check runs as the table owner and
-- sees every row (the same trigger `rate_plans` carries).
CREATE FUNCTION garage_tax_sets_garage_is_the_tenants() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM garages g WHERE g.id = NEW.garage_id AND g.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'garage_tax_sets: garage % is not this tenant''s under row-level security', NEW.garage_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER garage_tax_sets_garage_is_the_tenants
  BEFORE INSERT ON garage_tax_sets
  FOR EACH ROW EXECUTE FUNCTION garage_tax_sets_garage_is_the_tenants();

-- A set holds exactly the rules it states, checked at COMMIT: a statement is
-- written whole in one transaction or not at all, and is never added to.
CREATE FUNCTION garage_tax_sets_hold_their_stated_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  set_id uuid;
  stated integer;
  held   integer;
BEGIN
  -- Two branches, not one CASE: PL/pgSQL resolves every NEW field an
  -- expression names, and a set row has no tax_set_id.
  IF TG_TABLE_NAME = 'garage_tax_sets' THEN
    set_id := NEW.id;
  ELSE
    set_id := NEW.tax_set_id;
  END IF;
  SELECT s.rule_count INTO stated FROM garage_tax_sets s WHERE s.id = set_id;
  SELECT count(*) INTO held FROM garage_tax_rules r WHERE r.tax_set_id = set_id;
  IF held IS DISTINCT FROM stated THEN
    RAISE EXCEPTION 'garage_tax_sets: set % states % rule(s) and holds %; a tax set is stated whole, once', set_id, stated, held
      USING ERRCODE = 'check_violation', CONSTRAINT = 'garage_tax_sets_hold_their_stated_rules';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER garage_tax_sets_hold_their_stated_rules
  AFTER INSERT ON garage_tax_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION garage_tax_sets_hold_their_stated_rules();

CREATE CONSTRAINT TRIGGER garage_tax_rules_hold_their_stated_rules
  AFTER INSERT ON garage_tax_rules
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION garage_tax_sets_hold_their_stated_rules();

ALTER TABLE garage_tax_sets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE garage_tax_sets  FORCE  ROW LEVEL SECURITY;
ALTER TABLE garage_tax_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE garage_tax_rules FORCE  ROW LEVEL SECURITY;

CREATE POLICY garage_tax_sets_tenant_isolation ON garage_tax_sets
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY garage_tax_rules_tenant_isolation ON garage_tax_rules
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Append-only: no UPDATE, no DELETE. A changed tax is a new set.
GRANT SELECT, INSERT ON garage_tax_sets  TO openparking_app;
GRANT SELECT, INSERT ON garage_tax_rules TO openparking_app;

-- The gate (0014), whole, with its third condition. Everything above the
-- taxes block is 0014's body, unchanged but for one comment ("both
-- conditions" is now "every condition").
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
    SELECT count(*), count(*) FILTER (WHERE effective_from <= now())
      INTO plans_stored, plans_in_force
      FROM rate_plans
     WHERE garage_id = NEW.id AND tenant_id = NEW.tenant_id;
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
