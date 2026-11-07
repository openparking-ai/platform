-- 0052 — the owner's tick: they tested the garage's payment account themselves.
--
-- HIS RULE, 2026-11-07: every Stripe setup carries a clear statement that the
-- owner must do test transactions and see the money reach their account, and a
-- box they tick to confirm it. The tick is a statement by the owner, kept with
-- who made it and when. It is on the garage's payment account because that is
-- what was tested.
--
--   garage_stripe_accounts.test_confirmed_at  when the box was ticked.
--   garage_stripe_accounts.test_confirmed_by  who ticked it, as `kind:id` (an
--                                             owner, a linked person, a key).
--                                             An id, never a name or an email:
--                                             the shape below refuses one.
--
-- FIRST TICK WINS, AND IT STANDS. The trigger below refuses any change to
-- either column once they are set: for every role that can write this table,
-- not only the route. It is a trigger of its own so that
-- garage_stripe_accounts_guard (0020) stays exactly as it was.
--
-- NOTHING HERE IS AN ACTIVATION CONDITION, as with everything in this table
-- (0020): a garage must be open before a car can pay, so opening cannot wait
-- for this tick, and no card path reads it.
--
-- The table's tenant policy, grants and FORCE (0020) cover the new columns.
-- Nothing is backfilled: no account has a tick until its owner gives one.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE garage_stripe_accounts
  ADD COLUMN test_confirmed_at timestamptz,
  ADD COLUMN test_confirmed_by text,
  ADD CONSTRAINT garage_stripe_accounts_test_confirmed_together CHECK (
    (test_confirmed_at IS NULL) = (test_confirmed_by IS NULL)
  ),
  ADD CONSTRAINT garage_stripe_accounts_test_confirmed_by_shape CHECK (
    test_confirmed_by IS NULL
    OR test_confirmed_by ~ '^(owner|linked|key):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  -- What was tested is an account: a reservation has none.
  ADD CONSTRAINT garage_stripe_accounts_test_confirmed_needs_an_account CHECK (
    test_confirmed_at IS NULL OR account_id IS NOT NULL
  );

CREATE FUNCTION garage_stripe_accounts_test_confirmed_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.test_confirmed_at IS NOT NULL AND (
       NEW.test_confirmed_at IS DISTINCT FROM OLD.test_confirmed_at
       OR NEW.test_confirmed_by IS DISTINCT FROM OLD.test_confirmed_by) THEN
    RAISE EXCEPTION 'garage_stripe_accounts: the owner''s test confirmation, once given, never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'garage_stripe_accounts_test_confirmed_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER garage_stripe_accounts_test_confirmed_guard
  BEFORE UPDATE ON garage_stripe_accounts
  FOR EACH ROW EXECUTE FUNCTION garage_stripe_accounts_test_confirmed_guard();

COMMIT;
