-- 0020 — a garage's own Stripe account.
--
-- A garage that takes cards takes them into ITS OWN Stripe account: the
-- garage pays Stripe's fees, and Stripe, not the deployment, is responsible
-- for the account's losses. The account has no Stripe dashboard of its own;
-- Stripe's hosted onboarding asks the garage about the garage. A deployment that runs
-- Stripe Connect creates that account on the operator's request and hands the
-- operator Stripe's onboarding link; Stripe collects what it needs from the
-- garage directly. This table is the platform's side of that: which account is
-- the garage's, and what Stripe last said about whether it can take a card.
--
-- ONE ACCOUNT PER GARAGE, NEVER TWO. A create is RESERVED here -- a row with
-- its idempotency key, committed -- BEFORE Stripe is asked, and Stripe is asked
-- with that key. A retry, a double click, or two operators at once all ask
-- with the same key and get the same account back. Once the account id is
-- recorded it never changes: the trigger below refuses it.
--
-- PULL, NOT PUSH. There is no webhook here. The state columns are what Stripe
-- answered the last time the platform asked, each with WHEN it was asked, and
-- the operator asks again on demand. A value with no read time is a value
-- nobody read, and the constraints refuse one without the other.
--
--   card_payments       the capability's status as Stripe words it
--                       ('active', 'pending', 'inactive', ...). 'active' is
--                       what a Terminal payment needs; Stripe's own words:
--                       "Terminal connected accounts must have the
--                       card_payments capability to perform transactions."
--   charges_enabled     as Stripe reports it.
--   details_submitted   as Stripe reports it.
--
-- NOTHING HERE IS AN ACTIVATION CONDITION. Activation (0014) is the rate setup
-- and the transient mode, and a garage that takes no cards at all is a garage.
--
-- No card number, and nothing about a card, is ever stored.
--
-- Tenant-owned; docs/RLS_TEMPLATE.md. INSERT and UPDATE, never DELETE: the
-- record that a garage had an account outlives any change to it.
--
-- Run as the database OWNER.

BEGIN;

CREATE TABLE garage_stripe_accounts (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id                 uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,

  -- The reservation, written before Stripe is asked.
  create_idempotency_key    text        NOT NULL,
  create_requested_at       timestamptz NOT NULL DEFAULT now(),
  create_requested_by       text        NOT NULL,

  -- Stripe's answer. NULL between the reservation and the answer.
  account_id                text,
  account_recorded_at       timestamptz,

  -- The last read, fact by fact.
  card_payments             text,
  card_payments_read_at     timestamptz,
  charges_enabled           boolean,
  charges_enabled_read_at   timestamptz,
  details_submitted         boolean,
  details_submitted_read_at timestamptz,

  CONSTRAINT garage_stripe_accounts_one_per_garage UNIQUE (garage_id),
  CONSTRAINT garage_stripe_accounts_one_key UNIQUE (create_idempotency_key),
  CONSTRAINT garage_stripe_accounts_one_garage_per_account UNIQUE (account_id),
  CONSTRAINT garage_stripe_accounts_account_id_shape CHECK (
    account_id IS NULL OR account_id ~ '^acct_[A-Za-z0-9]+$'
  ),
  CONSTRAINT garage_stripe_accounts_recorded_together CHECK (
    (account_id IS NULL) = (account_recorded_at IS NULL)
  ),
  CONSTRAINT garage_stripe_accounts_card_payments_shape CHECK (
    card_payments IS NULL OR card_payments ~ '^[a-z_]+$'
  ),
  -- A value and its read time come together, and only for an account that
  -- exists.
  CONSTRAINT garage_stripe_accounts_card_payments_read CHECK (
    (card_payments IS NULL) = (card_payments_read_at IS NULL)
  ),
  CONSTRAINT garage_stripe_accounts_charges_enabled_read CHECK (
    (charges_enabled IS NULL) = (charges_enabled_read_at IS NULL)
  ),
  CONSTRAINT garage_stripe_accounts_details_submitted_read CHECK (
    (details_submitted IS NULL) = (details_submitted_read_at IS NULL)
  ),
  CONSTRAINT garage_stripe_accounts_read_needs_an_account CHECK (
    account_id IS NOT NULL
    OR (card_payments_read_at IS NULL AND charges_enabled_read_at IS NULL AND details_submitted_read_at IS NULL)
  )
);
CREATE INDEX garage_stripe_accounts_tenant_id_idx ON garage_stripe_accounts (tenant_id);

-- The garage is this tenant's, and the account, once recorded, is frozen.
CREATE FUNCTION garage_stripe_accounts_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A foreign-key check runs as the table owner and sees every tenant's
    -- garages; this one runs under the caller's policy and does not.
    IF NOT EXISTS (SELECT 1 FROM garages g WHERE g.id = NEW.garage_id AND g.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'garage_stripe_accounts: garage % is not this tenant''s under row-level security', NEW.garage_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.garage_id IS DISTINCT FROM OLD.garage_id
     OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key
     OR NEW.create_requested_at IS DISTINCT FROM OLD.create_requested_at
     OR NEW.create_requested_by IS DISTINCT FROM OLD.create_requested_by THEN
    RAISE EXCEPTION 'garage_stripe_accounts: the reservation is never rewritten'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'garage_stripe_accounts_reservation_frozen';
  END IF;
  IF OLD.account_id IS NOT NULL AND (
       NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.account_recorded_at IS DISTINCT FROM OLD.account_recorded_at) THEN
    RAISE EXCEPTION 'garage_stripe_accounts: a garage''s account, once recorded, never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'garage_stripe_accounts_account_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER garage_stripe_accounts_guard
  BEFORE INSERT OR UPDATE ON garage_stripe_accounts
  FOR EACH ROW EXECUTE FUNCTION garage_stripe_accounts_guard();

ALTER TABLE garage_stripe_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE garage_stripe_accounts FORCE  ROW LEVEL SECURITY;

CREATE POLICY garage_stripe_accounts_tenant_isolation ON garage_stripe_accounts
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- No DELETE. See above.
GRANT SELECT, INSERT, UPDATE ON garage_stripe_accounts TO openparking_app;

COMMIT;
