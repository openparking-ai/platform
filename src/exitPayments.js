/**
 * PAYING AT THE EXIT (0038): an exit case that owes a fee, paid with a card
 * on the garage's own Stripe account (direct charges).
 *
 *   lane_reader   the lane's bound reader (0021). The platform creates the
 *                 PaymentIntent and hands it to the reader
 *                 (`process_payment_intent`); Stripe drives the device.
 *   phone_reader  an attendant's phone with Stripe's Terminal SDK. The
 *                 platform creates the same PaymentIntent and answers its
 *                 client secret; the phone collects it.
 *
 * ONE PAYMENT PER STAY. One PaymentIntent per case, created with an
 * idempotency key derived from the case; a declined card is tried again on
 * the SAME intent (Stripe: "re-use the same PaymentIntent to help avoid
 * double charges"), never a new one. A second case for the same stay cannot
 * start a second payment while the first is live or paid (0038's index).
 *
 * THE AMOUNT IS THE PLATFORM'S: the case's fee as shown. Stripe's answer is
 * taken as paid only when its amount and currency are the ones recorded.
 *
 * CANCELED ONLY ON STRIPE'S WORD. A cancel reads the intent first: one that
 * succeeded is paid, and is never refunded or voided here; one a card is
 * being authorised on is left to finish and asked about again. The record
 * says canceled only when Stripe answered with a canceled intent.
 *
 * PULL, NOT PUSH, as the account's state is (0020): nothing listens for
 * Stripe's webhooks. The lane polls the case while the driver pays; each
 * poll reads the intent from Stripe, at most once every READ_EVERY_MS.
 *
 * Offline: the lane's reader is driven from here (Stripe's server-driven
 * integration), which takes no card while the reader or Stripe is offline.
 * A phone reader may store a card offline and forward it later; such a
 * payment is not seen here until Stripe has it (README, "Paying at the exit").
 */
import { createHash } from 'node:crypto';
import { stripeCall, StripeError, StripeUnreachable } from './stripe.js';
import { ConnectRefusal } from './stripeAccount.js';

export const PAYMENT_STARTED_EVENT_KIND = 'exit_payment_started';
export const PAID_EVENT_KIND = 'exit_paid';
export const PAYMENT_CANCELED_EVENT_KIND = 'exit_payment_canceled';

/** The least time between two reads of one intent from Stripe, while a lane polls. */
export const READ_EVERY_MS = 2000;

/** One intent per case, whatever retries or races ask for it. */
export const intentKey = (exitId) =>
  `openparking-exit-pay-${createHash('sha256').update(String(exitId)).digest('hex').slice(0, 32)}`;

/** The states Stripe lets an intent be canceled from without a refund: nothing was taken. */
export const CANCELABLE = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);

/**
 * One cancel per intent per card attempt. Stripe keeps the first answer to a
 * key for a day, a refusal included: keyed on the intent alone, a cancel
 * refused while a card was being authorised would be refused again after that
 * card was declined, and the intent would stay open. The latest charge names
 * the attempt, so a retry of the same cancel replays its answer and a cancel
 * after another card is asked afresh.
 */
export const cancelKey = (intent) =>
  `openparking-exit-cancel-${createHash('sha256')
    .update(`${intent.id}:${intent.latest_charge ?? 'none'}:${intent.status}`).digest('hex').slice(0, 32)}`;

/**
 * The PaymentIntent for a case's fee. In person: `card_present`, and
 * `interac_present` beside it for Canadian dollars (Interac is how most
 * Canadian debit cards pay in person). Under the pinned API version (dahlia)
 * Terminal still names its types with `payment_method_types`; from endive it
 * is `allowed_payment_method_types`. Captured at once: the amount is final.
 */
export function intentBody({ amountMinor, currency, exitId, garageId }) {
  const cur = String(currency).toLowerCase();
  return {
    amount: amountMinor,
    currency: cur,
    payment_method_types: cur === 'cad' ? ['card_present', 'interac_present'] : ['card_present'],
    capture_method: 'automatic',
    description: 'Parking',
    metadata: { openparking_exit_id: exitId, openparking_garage_id: garageId },
  };
}

/** Stripe's intent status, as this record keeps it. */
export function stateOf(intent) {
  if (intent.status === 'succeeded') return 'succeeded';
  if (intent.status === 'canceled') return 'canceled';
  return 'open';
}

/** Why the last attempt did not pay, in Stripe's own codes; null when nothing failed. */
export function failureOf(intent) {
  const e = intent.last_payment_error;
  if (!e) return null;
  return [e.code, e.decline_code].filter(Boolean).join(':').slice(0, 200) || 'failed';
}

export async function paymentOf(client, tenantId, exitId) {
  const { rows } = await client.query('SELECT * FROM exit_payments WHERE tenant_id = $1 AND exit_id = $2', [tenantId, exitId]);
  return rows[0] ?? null;
}

export async function boundReader(client, tenantId, laneId) {
  const { rows } = await client.query(
    'SELECT * FROM lane_readers WHERE tenant_id = $1 AND lane_id = $2 AND unbound_at IS NULL', [tenantId, laneId]);
  return rows[0] ?? null;
}

export async function garageAccount(client, tenantId, garageId) {
  const { rows } = await client.query(
    'SELECT account_id FROM garage_stripe_accounts WHERE tenant_id = $1 AND garage_id = $2 AND account_id IS NOT NULL',
    [tenantId, garageId]);
  return rows[0]?.account_id ?? null;
}

/** A new row for a created intent; a race for the same case keeps the first. */
export async function insertPayment(client, tenantId, p) {
  try {
    const { rows } = await client.query(
      `INSERT INTO exit_payments (tenant_id, garage_id, exit_id, session_id, channel, reader_id, account_id,
                                  payment_intent_id, amount_minor, currency, stripe_status, started_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id, exit_id) DO NOTHING
       RETURNING *`,
      [tenantId, p.garageId, p.exitId, p.sessionId, p.channel, p.readerId, p.accountId,
        p.intentId, p.amountMinor, p.currency, p.stripeStatus, p.startedBy],
    );
    return { row: rows[0] ?? (await paymentOf(client, tenantId, p.exitId)), created: rows.length === 1 };
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'exit_payments_one_per_stay') {
      throw new ConnectRefusal(409, 'stay_payment_elsewhere',
        "this car's stay already has a payment started or taken at another exit case; a person decides");
    }
    throw err;
  }
}

/**
 * What Stripe says of the intent, written down. Paid only when Stripe's
 * amount and currency are the ones recorded: an intent whose amount moved is
 * never taken as payment for this fee. Answers the row and whether this read
 * is the one that found it paid.
 */
export async function recordIntent(client, tenantId, row, intent) {
  if (intent.id !== row.payment_intent_id) throw new Error('recordIntent: a different intent');
  let state = stateOf(intent);
  let failure = failureOf(intent);
  if (state === 'succeeded' && (intent.amount !== row.amount_minor || String(intent.currency).toLowerCase() !== row.currency)) {
    state = 'open';
    failure = 'amount_mismatch';
  }
  if (row.status !== 'open') state = row.status;
  const { rows } = await client.query(
    `UPDATE exit_payments
        SET status = $3, stripe_status = $4, last_failure = $5, read_at = now(),
            succeeded_at = CASE WHEN $3 = 'succeeded' THEN COALESCE(succeeded_at, now()) END,
            canceled_at  = CASE WHEN $3 = 'canceled'  THEN COALESCE(canceled_at, now())  END
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [tenantId, row.id, state, String(intent.status).slice(0, 40), failure],
  );
  return { row: rows[0], paidNow: row.status === 'open' && state === 'succeeded' };
}

export async function recordReader(client, tenantId, row, readerId) {
  if (row.reader_id === readerId) return row;
  const { rows } = await client.query(
    'UPDATE exit_payments SET reader_id = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *', [tenantId, row.id, readerId]);
  return rows[0];
}

export async function recordReceipt(client, tenantId, row, receipt) {
  const { rows } = await client.query(
    `UPDATE exit_payments SET receipt = $3 WHERE tenant_id = $1 AND id = $2 AND receipt IS NULL AND status = 'succeeded'
      RETURNING *`,
    [tenantId, row.id, JSON.stringify(receipt)],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Stripe, on the garage's account. Each call is named for what it does.
// ---------------------------------------------------------------------------

export function createIntent(config, accountId, body, exitId) {
  return stripeCall({ method: 'POST', path: '/v1/payment_intents', account: accountId, form: body, idempotencyKey: intentKey(exitId) }, config);
}

export function readIntent(config, accountId, intentId) {
  return stripeCall({ method: 'GET', path: `/v1/payment_intents/${encodeURIComponent(intentId)}`, account: accountId }, config);
}

export function cancelIntent(config, accountId, intentId, idempotencyKey = undefined) {
  return stripeCall({ method: 'POST', path: `/v1/payment_intents/${encodeURIComponent(intentId)}/cancel`, account: accountId, form: {}, idempotencyKey }, config);
}

/** The intent the reader is working on now, or null: another car's is never cleared. */
export async function readerIntent(config, accountId, readerId) {
  const reader = await stripeCall({ method: 'GET', path: `/v1/terminal/readers/${encodeURIComponent(readerId)}`, account: accountId }, config);
  return reader?.action?.process_payment_intent?.payment_intent ?? null;
}

/**
 * Hand the intent to the reader. Stripe acknowledges at once and the reader
 * works on; the outcome is read from the intent. A refusal that says what to
 * do next becomes one the lane can act on.
 */
export async function sendToReader(config, accountId, readerId, intentId) {
  try {
    await stripeCall({
      method: 'POST',
      path: `/v1/terminal/readers/${encodeURIComponent(readerId)}/process_payment_intent`,
      account: accountId,
      form: { payment_intent: intentId },
    }, config);
    return { sent: true };
  } catch (err) {
    if (err instanceof StripeError) {
      if (err.code === 'terminal_reader_offline') {
        throw new ConnectRefusal(503, 'reader_offline', "the lane's card reader is offline: it takes no card until it is back");
      }
      if (err.code === 'terminal_reader_busy') {
        throw new ConnectRefusal(409, 'reader_busy', "the lane's card reader is busy with another action; cancel it or wait");
      }
      // Stripe: "a terminal_reader_timeout ... is a false negative" on rare
      // occasions -- the reader may have it. The intent says what happened.
      if (err.code === 'terminal_reader_timeout') return { sent: 'unknown' };
      // Not in requires_payment_method: paid, or paying. The intent says which.
      if (err.code === 'intent_invalid_state') return { sent: false };
    }
    throw err;
  }
}

/** Clear what the reader is doing. */
export async function clearReader(config, accountId, readerId) {
  try {
    await stripeCall({ method: 'POST', path: `/v1/terminal/readers/${encodeURIComponent(readerId)}/cancel_action`, account: accountId, form: {} }, config);
  } catch (err) {
    if (err instanceof StripeError && err.code === 'terminal_reader_busy') {
      throw new ConnectRefusal(409, 'reader_busy', 'the card is being authorised; it cannot be stopped now, wait for the answer');
    }
    if (err instanceof StripeError && err.code === 'terminal_reader_offline') {
      throw new ConnectRefusal(503, 'reader_offline', "the lane's card reader is offline");
    }
    throw err;
  }
}

/** The payment as the lane and an attendant read it: no ids beyond the intent's. */
export function presentPayment(row) {
  if (!row) return null;
  return {
    status: row.status,
    channel: row.channel,
    amount_minor: row.amount_minor,
    currency: row.currency,
    payment_intent_id: row.payment_intent_id,
    last_failure: row.last_failure,
    receipt_sent: Boolean(row.receipt),
  };
}

export { StripeUnreachable };
