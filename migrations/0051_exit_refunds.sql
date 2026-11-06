-- 0051 — refunds, as they happen: a dated ledger, and Stripe's word for it.
--
-- `exit_payments.refunded_minor` (0048) is a standing total, and it is read
-- from Stripe only when a stay is priced again at a new exit. A car that paid
-- and left never comes back to that read, so its refund was heard of nowhere,
-- and a total has no date for a day's numbers to put it on.
--
--   exit_refunds   one row per change of a payment's refunded total, written by
--                  Stripe's refund events on the garage's own account
--                  (src/exitRefunds.js):
--                    refund    the total grew: amount_minor > 0;
--                    reversal  the total shrank (a refund failed or was
--                              canceled): amount_minor < 0, so every sum nets
--                              it out on the day Stripe reported it.
--                  `refunded_at` is when Stripe reported it, the event's own
--                  time. `stripe_event_id` is UNIQUE: an event is counted once,
--                  however often it is delivered.
--
-- Append-only by grant: a refund, once recorded, is history. No card data: ids,
-- amounts and times. Disputes and chargebacks are not refunds and are not here.
--
-- HOW THE EVENT FINDS ITS ACCOUNT. An event names a connected account, and
-- which of this platform's accounts holds it is what is being found out: the
-- lookup 0031 is for. `garage_stripe_accounts` gets that lookup's SELECT policy
-- and `resolve_stripe_account` turns it on, answering one garage and its
-- account and nothing else. Everything after it runs under that account's own
-- tenant: `exit_payments` gets no new policy.
--
-- Nothing is backfilled: a refund made before this is in `refunded_minor`
-- alone, and comes into the ledger when an event for that payment next arrives.
--
-- Numbered 0051: 0050 is the payments' index, 0049 is left free for an open
-- change.
--
-- Run as the database OWNER.

BEGIN;

CREATE TABLE exit_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id uuid NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  exit_payment_id uuid NOT NULL REFERENCES exit_payments(id),
  kind text NOT NULL CHECK (kind IN ('refund', 'reversal')),
  amount_minor integer NOT NULL,
  -- The payment's refunded total this row brought it to.
  refunded_total integer NOT NULL CHECK (refunded_total >= 0),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  stripe_event_id text NOT NULL CHECK (stripe_event_id ~ '^evt_[A-Za-z0-9_]+$'),
  refunded_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT exit_refunds_one_per_event UNIQUE (stripe_event_id),
  CONSTRAINT exit_refunds_amount_by_kind CHECK (
    (kind = 'refund' AND amount_minor > 0 AND refunded_total >= amount_minor)
    OR (kind = 'reversal' AND amount_minor < 0)
  )
);

CREATE INDEX exit_refunds_tenant_id_idx ON exit_refunds (tenant_id);
CREATE INDEX exit_refunds_payment_idx ON exit_refunds (tenant_id, exit_payment_id);
CREATE INDEX exit_refunds_garage_day_idx ON exit_refunds (tenant_id, garage_id, refunded_at);

ALTER TABLE exit_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE exit_refunds FORCE  ROW LEVEL SECURITY;

CREATE POLICY exit_refunds_tenant_isolation ON exit_refunds
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Written once, never changed or deleted.
GRANT SELECT, INSERT ON exit_refunds TO openparking_app;

-- A foreign key is checked without row-level security; this reads the payment
-- as the writer, after the row's own policy has had its say (as 0038's).
CREATE FUNCTION exit_refunds_own_payment() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM exit_payments p
       WHERE p.id = NEW.exit_payment_id AND p.garage_id = NEW.garage_id AND p.tenant_id = NEW.tenant_id
         AND p.currency = NEW.currency
    ) THEN
      RAISE EXCEPTION 'exit_refunds: a refund is of a payment of its own account and garage, in that payment''s currency'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER exit_refunds_on_own_payment
  AFTER INSERT ON exit_refunds
  FOR EACH ROW EXECUTE FUNCTION exit_refunds_own_payment();

-- ---------------------------------------------------------------------------
-- Which account an event of a connected account is for.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY garage_stripe_accounts_definer_lookup ON garage_stripe_accounts AS PERMISSIVE FOR SELECT TO %I '
    'USING (current_setting(''openparking.definer_lookup'', true) = ''on'')',
    current_user);
END
$$;

CREATE FUNCTION resolve_stripe_account_body(p_account text)
  RETURNS TABLE (tenant_id uuid, garage_id uuid)
  LANGUAGE sql STABLE
  SECURITY INVOKER
  SET search_path = pg_catalog, public
  AS $$
    SELECT a.tenant_id, a.garage_id FROM garage_stripe_accounts a WHERE a.account_id = p_account
  $$;

REVOKE EXECUTE ON FUNCTION resolve_stripe_account_body(text) FROM PUBLIC;

CREATE FUNCTION resolve_stripe_account(p_account text)
  RETURNS TABLE (tenant_id uuid, garage_id uuid)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_was text := current_setting('openparking.definer_lookup', true);
  BEGIN
    PERFORM set_config('openparking.definer_lookup', 'on', true);
    RETURN QUERY SELECT * FROM resolve_stripe_account_body(p_account);
    PERFORM set_config('openparking.definer_lookup', coalesce(v_was, ''), true);
  END
  $$;

REVOKE EXECUTE ON FUNCTION resolve_stripe_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_stripe_account(text) TO openparking_app;

COMMIT;
