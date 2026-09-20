-- 0014 — the activation gate: a garage is not usable until its rate setup is
-- complete and its transient mode is stated.
--
-- HIS RULING, 2026-09-20: the system will never be active until the rate
-- setup is complete; if a garage is not transient -- garage pass and monthly
-- only -- it must be selected as such before the system can become active.
-- (The payment-processor onboarding and the tested money collection are a
-- SEPARATE requirement with its own place; this gate carries no payment
-- condition at all rather than an unchecked one, so it never reports
-- satisfied what it cannot observe.)
--
-- TWO CONDITIONS, BOTH OBSERVABLE FROM THIS SCHEMA, NEITHER RE-VALIDATING:
--
--   rate setup complete   the garage holds at least one plan (0012) and a
--                         version is IN FORCE -- `effective_from <= now()`.
--                         The store already refused a plan the engine found
--                         fault with at write time, so this is presence and
--                         coverage, not a second validation. A garage whose
--                         only plan takes effect next month is set up and not
--                         yet priceable; it is not active until it is.
--   transient mode stated `transient_available` is TRUE or FALSE. It is the
--                         three-state field `garage-pass` already ships --
--                         true, false, or UNSTATED (NULL), no default and no
--                         inference -- copied, not reinvented, because one
--                         concept in two shapes is this estate's recurring
--                         defect. NULL is not false. A garage that has not
--                         said whether it sells transient parking cannot open.
--
-- ACTIVATION IS AN ACT, WITH A TIMESTAMP AND AN ACTOR, and the conditions are
-- checked at that moment BY THE DATABASE, not only by the route: the trigger
-- below refuses to set `activated_at` while either condition is unmet, so a
-- direct UPDATE does not go around the gate. Once set it cannot be cleared or
-- moved, and a stated transient mode cannot be un-stated; the conditions are
-- monotonic by construction (plans are append-only, `effective_from` is
-- CHECKed to the document), so an active garage stays one. Which is why the
-- lane routes may read `activated_at IS NOT NULL` and nothing else.
--
-- AN INACTIVE GARAGE DOES NOT OPERATE: no stay is opened and none is closed
-- there. The refusal is NAMED and RECORDED on this side -- a
-- `garage_inactive_refusal` event, written before the 409 is answered --
-- because a 409 is dropped by the lane's sync path, counted there and
-- forgotten here, and a garage refusing every car with no record of it on
-- the platform is the silent shape this round exists to remove.
--
-- WHAT THIS GATE DOES NOT REACH: a stay that outlived the plan that covered
-- it -- a car parked past the plan's last day. That stay still arrives at the
-- exit with no price, and the unpriced close (0013) is its backstop. The gate
-- closes the go-live window; it does not replace B3.
--
-- No personal data is added. Run as the database OWNER.

BEGIN;

ALTER TABLE garages
  ADD COLUMN transient_available boolean,
  ADD COLUMN activated_at        timestamptz;

-- The gate, enforced where a direct UPDATE cannot go around it.
CREATE FUNCTION garages_activation_gate() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  plans_stored integer;
  plans_in_force integer;
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
  -- Activating: both conditions, observed now.
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
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER garages_activation_gate
  BEFORE INSERT OR UPDATE OF transient_available, activated_at ON garages
  FOR EACH ROW EXECUTE FUNCTION garages_activation_gate();

COMMIT;
