/**
 * A refund made at Stripe reaches this platform's records (0051).
 *
 * A refund is made on the garage's own Stripe account: this platform has no
 * refund button. Stripe tells a Connect webhook, and this answers it:
 *
 *   POST /api/v1/stripe/webhook
 *     200 {received: true}    taken, or nothing this platform needs to do
 *     400                     the signature is not Stripe's
 *     503                     not now: Stripe sends it again
 *
 * OFF UNLESS THE DEPLOYMENT SETS `STRIPE_WEBHOOK_SECRET`, the signing secret of
 * the Connect endpoint it made at Stripe. Read at each request, like every
 * Stripe setting (src/stripe.js). Unset, the path is one that does not exist.
 *
 * THE SIGNATURE IS OVER THE BYTES SENT: the body is read raw, never parsed
 * first, and an event whose signed time is more than TOLERANCE_SECONDS away is
 * refused, so a captured delivery cannot be replayed later.
 *
 * STRIPE'S CURRENT TRUTH, NOT THE EVENT'S. An event is a snapshot: it can
 * arrive late, out of order, or twice. So on any of REFUND_EVENTS the payment's
 * refunded total is read from Stripe, on the garage's account, by the read the
 * exit's credit already rests on (`refundedOf`), and the difference from what
 * the ledger holds is one row, dated when Stripe reported it:
 *
 *   a total that grew     a `refund` row;
 *   a total that shrank   a `reversal` row, negative, which nets out on its day;
 *   no difference         nothing (a repeat, or an older event arriving late).
 *
 * `stripe_event_id` is UNIQUE, so the same event is never counted twice even
 * under a race. Two events of one payment take turns: a transaction-scoped
 * advisory lock on the payment is held from before Stripe is read until the row
 * is written, so the later one reads later and the total never goes back.
 *
 * `refunded_minor` IS KEPT TO THE SAME TOTAL: it is what the exit's credit reads
 * (0048), so a car that comes back is credited what its payment kept. The
 * ledger is what is dated; the difference is taken from the ledger and not from
 * `refunded_minor`, so a refund the exit read first still gets its dated row.
 *
 * WHAT IS NOT OURS IS LEFT ALONE, and answered 200 so Stripe stops sending it:
 * another event type, an account no garage holds, a payment no exit took. A
 * payment still open here is answered 503: its refund is real and the poll has
 * not caught up, so Stripe sends it again. Any failure reading Stripe is the
 * same 503, and a retry is safe. So is an event past EVENTS_AT_ONCE: the turn
 * above needs the Stripe read inside the transaction, so a connection is held
 * for it, and the lanes share that pool. The count is this process's. No charge dispute is read here: a dispute is
 * not a refund.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { query, withTenant } from './db.js';
import { refundedOf } from './exitPayments.js';
import { connectConfig, StripeError, StripeUnreachable } from './stripe.js';

//: Stripe's own default for a signed time.
export const TOLERANCE_SECONDS = 300;

//: The most events at work at once, each holding a connection while Stripe is
//: read and while it waits its payment's turn. Past it, 503: Stripe sends it again.
export const EVENTS_AT_ONCE = 2;

//: Every one but `charge.refunded` carries a Refund; all name the PaymentIntent.
export const REFUND_EVENTS = Object.freeze(['charge.refunded', 'refund.created', 'refund.updated', 'refund.failed', 'charge.refund.updated']);

const EVENT_ID = /^evt_[A-Za-z0-9_]+$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;
const INTENT_ID = /^pi_[A-Za-z0-9]+$/;
const SIGNATURE_MAX = 1024;

/** The signing secret, read now, or null: the door is off. */
export const webhookSecret = (env = process.env) => env.STRIPE_WEBHOOK_SECRET || null;

/** Stripe could not be read, or the payment is not settled here yet: answered 503 and sent again. */
export class TryAgainLater extends Error {}

const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Whether `header` (`t=<seconds>,v1=<hex>[,v1=<hex>]`) signs `raw` with `secret`
 * at about `nowSeconds`. Never throws.
 */
export function signedByStripe(raw, header, secret, nowSeconds) {
  if (typeof header !== 'string' || header.length > SIGNATURE_MAX || !Buffer.isBuffer(raw)) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  if (!t || !/^\d{1,12}$/.test(t) || Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS) return false;
  const want = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  return parts.some(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/.test(v ?? '') && same(want, Buffer.from(v, 'hex')));
}

/** What an event is about: `{eventId, account, intent, at}`, or null when it is nothing of ours. */
export function refundEvent(event) {
  if (!event || typeof event !== 'object' || !REFUND_EVENTS.includes(event.type)) return null;
  const intent = event.data?.object?.payment_intent;
  const eventId = event.id;
  const at = event.created;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId) || !Number.isInteger(at) || at <= 0) return null;
  if (typeof event.account !== 'string' || !ACCOUNT_ID.test(event.account)) return null;
  if (typeof intent !== 'string' || !INTENT_ID.test(intent)) return null;
  return { eventId, account: event.account, intent, at: new Date(at * 1000) };
}

/** Bring one payment's records to what Stripe says now. Answers what happened. */
async function settle(client, tenantId, { eventId, account, intent, at }, config) {
  const payment = (await client.query(
    `SELECT id, garage_id, amount_minor, refunded_minor, refunds_read_at, currency, status
       FROM exit_payments WHERE tenant_id = $1 AND account_id = $2 AND payment_intent_id = $3`,
    [tenantId, account, intent],
  )).rows[0];
  if (!payment || payment.status === 'canceled') return 'ignored';
  if (payment.status !== 'succeeded') throw new TryAgainLater('a refund of a payment still open here');

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`exit_refund:${payment.id}`]);
  const { rows } = await client.query(
    'SELECT coalesce(sum(amount_minor), 0)::bigint AS held FROM exit_refunds WHERE tenant_id = $1 AND exit_payment_id = $2',
    [tenantId, payment.id],
  );
  const held = Number(rows[0].held);
  let total;
  try {
    total = Math.min(await refundedOf(config, account, intent), payment.amount_minor);
  } catch (err) {
    if (err instanceof StripeUnreachable || err instanceof StripeError) throw new TryAgainLater('Stripe could not be read');
    throw err;
  }
  await client.query(
    `UPDATE exit_payments SET refunded_minor = $3, refunds_read_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'succeeded'`,
    [tenantId, payment.id, total],
  );
  if (total === held) return 'unchanged';
  const { rowCount } = await client.query(
    `INSERT INTO exit_refunds (tenant_id, garage_id, exit_payment_id, kind, amount_minor, refunded_total, currency, stripe_event_id, refunded_at)
     VALUES ($1, $2, $3, $4, $5,
             $6, $7, $8, $9)
     ON CONFLICT (stripe_event_id) DO NOTHING`,
    [tenantId, payment.garage_id, payment.id, total > held ? 'refund' : 'reversal', total - held, total, payment.currency, eventId, at],
  );
  return rowCount === 1 ? 'recorded' : 'unchanged';
}

let eventsGoing = 0;

/** One verified event. Answers `recorded`, `unchanged` or `ignored`; throws TryAgainLater. */
export async function handleEvent(event, config = connectConfig()) {
  const about = refundEvent(event);
  if (!about) return 'ignored';
  if (eventsGoing >= EVENTS_AT_ONCE) throw new TryAgainLater('too many events at once');
  eventsGoing += 1;
  try {
    const { rows } = await query('SELECT tenant_id FROM resolve_stripe_account($1)', [about.account]);
    if (rows.length === 0) return 'ignored';
    return await withTenant(rows[0].tenant_id, (client) => settle(client, rows[0].tenant_id, about, config));
  } finally {
    eventsGoing -= 1;
  }
}
