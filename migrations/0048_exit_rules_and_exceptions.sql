-- 0048 — the exit's rules (the owner's, 2026-10-30/31), and the record of a
-- car a person let out: the exceptions.
--
-- PAID AND LEFT. A stay is finished when the car crosses the closing loop
-- after the gate. A car that paid and backed out before it is the same stay:
-- at its next exit the WHOLE stay is priced again, what it already paid is a
-- credit, and only the difference is charged -- nothing when the price is not
-- higher. So a stay may now hold more than one succeeded payment, each the
-- difference its own case asked for:
--
--   exit_payments_one_open_per_stay   one OPEN payment per stay, whichever case
--                                     started it (it was one live OR PAID: a
--                                     stay could never pay the difference);
--   exit_payments_within_stay_fee     a payment is exactly what its case asks
--                                     for (`quote.due_minor`, or the fee on a
--                                     case with no credit), and what the stay
--                                     paid and is paying never adds up to more
--                                     than its case's whole fee: never charged
--                                     twice.
--
-- A RETURN IS A NEW STAY; A PASS'S VISIT IS A SESSION OF THE PASS.
--
--   sessions.entry_qr      a stay a registration QR let in (the lane's `qr`:
--                          `{enrolment, passed_by, qr_plate}`): the exit asks
--                          garage-pass by the QR's plate, so a car let in on one
--                          difference or with nothing read is the pass's car.
--                          `qr_plate` is a plate: the retention purge takes it
--                          with the vehicle.
--   sessions.pass_session  the pass this stay was a session of, as its exit's
--                          garage-pass or monthly-billing answer named it:
--                          `{module, pass_id | agreement, covered, ...}`. Each
--                          visit is its own session of the pass, asked about at
--                          its own exit with its own entry; nothing carries
--                          from one to the next.
--
-- THE EXCEPTIONS. Whenever a person lets a car out unpaid -- an attendant's
-- let-out, or a person at the lane opening for a car that owed -- and whenever a
-- person opens the barrier at all, one record per exit case: which garage,
-- lane, stay and case, who pressed it and when, the reason typed, what was
-- owed and what was paid, every payment attempt on the stay (states and times,
-- never card data), the lane's events around it, kept as they were at that
-- moment (`exceptions.story`). What is learned after it -- the gate agent's
-- messages and calls for the lane in [case opened - 15 min, let-out + 15 min],
-- copied with their source ids, and the payment as it stood once the let-out
-- canceled it -- is appended (`exception_records`), each row as copied at its
-- moment, never edited. A gate agent not configured, or not reachable, is a
-- row saying so; the let-out is never held up by it.
--
-- No plate is ever in either table: ids, people's names as the change log
-- names them, times, amounts and what the gate agent sent.
--
-- Nothing is backfilled.
--
-- Numbered 0048: 0047 is left free for the linked accounts (#78).
--
-- Run as the database OWNER.

BEGIN;

-- ---------------------------------------------------------------------------
-- Paying the difference.
-- ---------------------------------------------------------------------------

DROP INDEX exit_payments_one_per_stay;
CREATE UNIQUE INDEX exit_payments_one_open_per_stay ON exit_payments (tenant_id, session_id)
  WHERE session_id IS NOT NULL AND status = 'open';

CREATE FUNCTION exit_payments_within_stay_fee() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    fee   bigint;
    due   bigint;
    taken bigint;
  BEGIN
    IF NEW.session_id IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT (e.quote->>'fee_minor')::bigint,
           COALESCE((e.quote->>'due_minor')::bigint, (e.quote->>'fee_minor')::bigint)
      INTO fee, due
      FROM exits e
     WHERE e.id = NEW.exit_id AND e.tenant_id = NEW.tenant_id;
    IF due IS NULL OR NEW.amount_minor <> due THEN
      RAISE EXCEPTION 'exit_payments: a payment is exactly what its case asks for -- the whole stay less what it paid'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exit_payments_is_the_due';
    END IF;
    SELECT COALESCE(sum(p.amount_minor), 0) INTO taken
      FROM exit_payments p
     WHERE p.tenant_id = NEW.tenant_id AND p.session_id = NEW.session_id AND p.status <> 'canceled';
    IF taken > fee THEN
      RAISE EXCEPTION 'exit_payments: what a stay paid and is paying never adds up to more than its whole fee'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exit_payments_within_stay_fee';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER exit_payments_within_stay_fee
  AFTER INSERT ON exit_payments
  FOR EACH ROW EXECUTE FUNCTION exit_payments_within_stay_fee();

-- ---------------------------------------------------------------------------
-- A stay a QR let in, and the pass a stay was a session of.
-- ---------------------------------------------------------------------------

ALTER TABLE sessions
  ADD COLUMN entry_qr jsonb
    CONSTRAINT sessions_entry_qr_shape CHECK (
      entry_qr IS NULL OR (
        jsonb_typeof(entry_qr) = 'object'
        AND entry_qr <> '{}'::jsonb
        AND (entry_qr - ARRAY['enrolment', 'passed_by', 'qr_plate']) = '{}'::jsonb
        AND coalesce(jsonb_typeof(entry_qr->'enrolment'), 'string') = 'string'
        AND coalesce(entry_qr->>'enrolment', 'x') ~ '^[!-~]{1,128}$'
        AND coalesce(entry_qr->>'passed_by', 'same_plate') IN ('same_plate', 'look_alike', 'one_difference', 'nothing_read')
        AND coalesce(jsonb_typeof(entry_qr->'qr_plate'), 'string') = 'string'
        AND coalesce(entry_qr->>'qr_plate', 'x') ~ '^[^[:space:][:cntrl:]]{1,32}$'
      )
    ),
  ADD COLUMN pass_session jsonb
    CONSTRAINT sessions_pass_session_shape CHECK (
      pass_session IS NULL OR (
        jsonb_typeof(pass_session) = 'object'
        AND coalesce(pass_session->>'module', '') IN ('garage_pass', 'monthly_billing')
        AND coalesce(jsonb_typeof(pass_session->'covered'), '') = 'boolean'
        AND (pass_session->>'module' <> 'garage_pass' OR coalesce(pass_session->>'pass_id', '') <> '')
        AND (pass_session->>'module' <> 'monthly_billing' OR coalesce(pass_session->>'agreement', '') <> '')
      )
    );

-- A pass's sessions, read by the pass.
CREATE INDEX sessions_pass_session_idx ON sessions (tenant_id, garage_id, (pass_session->>'pass_id'), entry_at)
  WHERE pass_session IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The exceptions.
-- ---------------------------------------------------------------------------

CREATE TABLE exceptions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  garage_id       uuid        NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  lane_id         uuid        NOT NULL REFERENCES lanes(id),
  exit_id         uuid        NOT NULL REFERENCES exits(id),
  session_id      uuid        REFERENCES sessions(id),
  -- let_out_unpaid: the car owed (a fee not paid, or one that could not be
  -- priced) and a person let it out; barrier_opened: a person opened the
  -- barrier for a car that owed nothing more.
  kind            text        NOT NULL CHECK (kind IN ('let_out_unpaid', 'barrier_opened')),
  -- attendant: the let-out route; lane: a person at the lane, named on the close.
  source          text        NOT NULL CHECK (source IN ('attendant', 'lane')),
  done_by         text        NOT NULL CHECK (length(done_by) BETWEEN 1 AND 300),
  authority       text        CHECK (authority IN ('display_code_confirmed', 'human_open_now', 'human_open_and_flag')),
  reason          text        CHECK (length(reason) BETWEEN 1 AND 500),
  let_out_at      timestamptz NOT NULL,
  case_opened_at  timestamptz NOT NULL,
  -- The gate agent's window: [case opened - 15 min, let-out + 15 min].
  window_from     timestamptz NOT NULL,
  window_to       timestamptz NOT NULL,
  -- What it still owed at that moment (null: it could not be priced), and
  -- what the stay had paid at its exits before it.
  owed_minor      integer     CHECK (owed_minor >= 0),
  paid_minor      integer     NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  currency        text        CHECK (currency ~ '^[A-Z]{3}$'),
  story           jsonb       NOT NULL CHECK (jsonb_typeof(story) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exceptions_one_per_case UNIQUE (tenant_id, exit_id),
  CONSTRAINT exceptions_window CHECK (window_from <= let_out_at AND let_out_at < window_to),
  CONSTRAINT exceptions_opened_owing_nothing CHECK (kind <> 'barrier_opened' OR coalesce(owed_minor, 0) = 0)
);

CREATE INDEX exceptions_tenant_id_idx ON exceptions (tenant_id);
CREATE INDEX exceptions_garage_day_idx ON exceptions (tenant_id, garage_id, let_out_at);

CREATE TABLE exception_records (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  exception_id  uuid        NOT NULL REFERENCES exceptions(id),
  -- gate_agent_messages / gate_agent_calls: the gate agent's records for the
  -- lane, copied; payment_after_let_out: the case's payment once the let-out
  -- canceled it (or found it paid); lane_events_after: this platform's events
  -- at the lane after the let-out, to the window's end.
  source        text        NOT NULL CHECK (source IN ('gate_agent_messages', 'gate_agent_calls', 'payment_after_let_out', 'lane_events_after')),
  -- copied: the records are here; not_configured / not_reachable / refused:
  -- nothing was copied, and `detail` says why.
  state         text        NOT NULL CHECK (state IN ('copied', 'not_configured', 'not_reachable', 'refused')),
  -- The gate agent's own name for the lane it was asked about (not a lane id).
  asked_name    text        CHECK (length(asked_name) BETWEEN 1 AND 128),
  asked_from    timestamptz,
  asked_to      timestamptz,
  -- The copy covers the whole window: asked after the window ended.
  complete      boolean     NOT NULL DEFAULT false,
  detail        text        CHECK (length(detail) <= 300),
  records       jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(records) = 'array'),
  copied_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exception_records_copied_or_why CHECK (
    (state = 'copied') OR (records = '[]'::jsonb AND NOT complete AND detail IS NOT NULL)
  )
);

CREATE INDEX exception_records_tenant_id_idx ON exception_records (tenant_id);
CREATE INDEX exception_records_exception_idx ON exception_records (tenant_id, exception_id, copied_at);

ALTER TABLE exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exceptions FORCE  ROW LEVEL SECURITY;
ALTER TABLE exception_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE exception_records FORCE  ROW LEVEL SECURITY;

CREATE POLICY exceptions_tenant_isolation ON exceptions
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY exception_records_tenant_isolation ON exception_records
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- The record of what happened: written once, appended to, never edited or
-- deleted.
GRANT SELECT, INSERT ON exceptions TO openparking_app;
GRANT SELECT, INSERT ON exception_records TO openparking_app;

-- A foreign key is checked without row-level security; these read the
-- garage, lane, case and stay as the writer, as 0037's do.
CREATE FUNCTION exceptions_own_case() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM exits e
       WHERE e.id = NEW.exit_id AND e.tenant_id = NEW.tenant_id AND e.garage_id = NEW.garage_id
         AND e.lane_id = NEW.lane_id AND e.session_id IS NOT DISTINCT FROM NEW.session_id
    ) THEN
      RAISE EXCEPTION 'exceptions: an exception is about an exit case of its own account''s garage, at that case''s lane and stay'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER exceptions_on_own_case
  AFTER INSERT ON exceptions
  FOR EACH ROW EXECUTE FUNCTION exceptions_own_case();

CREATE FUNCTION exception_records_own_exception() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM exceptions x WHERE x.id = NEW.exception_id AND x.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'exception_records: a record is about an exception of its own account'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER exception_records_on_own_exception
  AFTER INSERT ON exception_records
  FOR EACH ROW EXECUTE FUNCTION exception_records_own_exception();

COMMIT;
