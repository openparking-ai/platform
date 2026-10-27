-- 0038: PAYING AT THE EXIT.
--
-- An exit case (0037) that owes a fee is paid with a card on the garage's own
-- Stripe account (direct charges, 0020): at the lane's bound reader (0021),
-- driven from here, or at a phone reader an attendant holds, which collects
-- the same PaymentIntent itself. One row per case, one PaymentIntent per row:
--
--   ONE PAYMENT PER STAY. The PaymentIntent is created once per case, with an
--   idempotency key derived from the case, and is the one a declined card is
--   tried again on (Stripe: "re-use the same PaymentIntent to help avoid
--   double charges"). A second case for the same stay cannot start a second
--   payment while the first is live or paid (the unique index below).
--
--   THE AMOUNT IS THE PLATFORM'S: the case's own fee, copied here when the
--   payment starts. Stripe's answer is settled only when its amount and
--   currency are these.
--
-- No card data is ever here: Stripe holds the card; this holds ids, amounts
-- and states. The text receipt keeps the last two digits of the number it
-- went to, and nothing else of it.
--
-- Numbered 0038: 0037 is the exit case.

BEGIN;

CREATE TABLE exit_payments (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id          uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  exit_id            uuid        NOT NULL REFERENCES exits(id),
  session_id         uuid        REFERENCES sessions(id),
  -- Where the payment was started -- lane_reader: the lane's bound reader,
  -- driven from here; phone_reader: an attendant's phone collects the
  -- intent itself. Either may then take the card: it is one intent.
  channel            text        NOT NULL CHECK (channel IN ('lane_reader', 'phone_reader')),
  -- The lane reader the payment was last sent to; null if none ever was.
  reader_id          text        CHECK (reader_id ~ '^tmr_[A-Za-z0-9]+$'),
  account_id         text        NOT NULL CHECK (account_id ~ '^acct_[A-Za-z0-9]+$'),
  payment_intent_id  text        NOT NULL CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  amount_minor       integer     NOT NULL CHECK (amount_minor > 0),
  currency           text        NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  -- open: started, not yet paid (on the reader, declined and waiting for
  -- another card, or not sent); succeeded: paid; canceled: will never be.
  status             text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'succeeded', 'canceled')),
  -- Stripe's own status at the last read, and why the last attempt failed.
  stripe_status      text,
  last_failure       text        CHECK (length(last_failure) <= 200),
  started_by         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  read_at            timestamptz,
  succeeded_at       timestamptz,
  canceled_at        timestamptz,
  -- {sent_at, to_last2, provider_ref}: a text receipt went, once.
  receipt            jsonb       CHECK (receipt IS NULL OR (jsonb_typeof(receipt) = 'object'
                                                          AND receipt ? 'sent_at' AND receipt ? 'to_last2')),

  CONSTRAINT exit_payments_one_per_case UNIQUE (tenant_id, exit_id),
  CONSTRAINT exit_payments_one_row_per_intent UNIQUE (payment_intent_id),
  CONSTRAINT exit_payments_state_times CHECK (
    (status = 'succeeded') = (succeeded_at IS NOT NULL)
    AND (status = 'canceled') = (canceled_at IS NOT NULL)
  ),
  CONSTRAINT exit_payments_reader_on_lane CHECK (channel <> 'lane_reader' OR reader_id IS NOT NULL),
  CONSTRAINT exit_payments_receipt_when_paid CHECK (receipt IS NULL OR status = 'succeeded')
);

CREATE INDEX exit_payments_tenant_id_idx ON exit_payments (tenant_id);
-- One live or paid payment per stay, whichever case started it.
CREATE UNIQUE INDEX exit_payments_one_per_stay ON exit_payments (tenant_id, session_id)
  WHERE session_id IS NOT NULL AND status <> 'canceled';

ALTER TABLE exit_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE exit_payments FORCE  ROW LEVEL SECURITY;

CREATE POLICY exit_payments_tenant_isolation ON exit_payments
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- A payment is never deleted: it is the record of money taken.
GRANT SELECT, INSERT, UPDATE ON exit_payments TO openparking_app;

-- A foreign key is checked without row-level security; this reads the case
-- as the writer, after the row's own policy has had its say (as 0037's).
CREATE FUNCTION exit_payments_own_case() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM exits e
       WHERE e.id = NEW.exit_id AND e.garage_id = NEW.garage_id AND e.tenant_id = NEW.tenant_id
         AND e.session_id IS NOT DISTINCT FROM NEW.session_id
    ) THEN
      RAISE EXCEPTION 'exit_payments: a payment is for an exit case of its own account, and that case''s stay'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.status <> 'open' OR NEW.receipt IS NOT NULL THEN
      RAISE EXCEPTION 'exit_payments: a payment begins open, with no receipt'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exit_payments_begins_open';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER exit_payments_on_own_case
  AFTER INSERT ON exit_payments
  FOR EACH ROW EXECUTE FUNCTION exit_payments_own_case();

-- What may change once written: the state moving forward, the reader it was
-- last sent to, what Stripe last said, the receipt once. Never the amount,
-- the intent, the account, the case or the stay; never back from succeeded
-- or canceled.
CREATE FUNCTION exit_payments_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF (NEW.id, NEW.tenant_id, NEW.garage_id, NEW.exit_id, NEW.session_id, NEW.account_id,
        NEW.payment_intent_id, NEW.amount_minor, NEW.currency, NEW.started_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.garage_id, OLD.exit_id, OLD.session_id, OLD.account_id,
        OLD.payment_intent_id, OLD.amount_minor, OLD.currency, OLD.started_by, OLD.created_at) THEN
      RAISE EXCEPTION 'exit_payments: what was paid for, how much and on which intent never changes'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exit_payments_fixed';
    END IF;
    IF OLD.status <> 'open' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'exit_payments: a payment that succeeded or was canceled stays so'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exit_payments_final';
    END IF;
    IF OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt THEN
      RAISE EXCEPTION 'exit_payments: a receipt is sent once'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exit_payments_receipt_once';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER exit_payments_guard
  BEFORE UPDATE ON exit_payments
  FOR EACH ROW EXECUTE FUNCTION exit_payments_guard();

COMMIT;
