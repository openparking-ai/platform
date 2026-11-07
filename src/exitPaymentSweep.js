/**
 * THE EXIT PAYMENT NOBODY FINISHED (src/exitPayments.js). A payment is recorded
 * by whoever asks about it: the lane's poll, a person, the next case. A driver
 * whose card Stripe took at a lane that then stopped asking is a payment nobody
 * asks about, so the record would say open for ever. This asks.
 *
 * IT ONLY READS STRIPE. It creates nothing, confirms nothing, captures nothing
 * and cancels nothing: an intent still waiting for a card stays exactly as it
 * is, because a lane may still be using it. Whatever it finds is written by
 * `recordCaseIntent`, the one way a lane's answer is written: the case locked,
 * the payment read under that lock, `exitPayments.recordIntent`, and the one
 * `exit_paid` event -- so two sweeps, or a sweep and a lane, record it once.
 *
 * WHAT IT FINDS AND WHERE IT GOES:
 *
 *   paid, case open         recorded paid. The case reads settled at the lane's
 *                           next ask; the stay stays as it is, for the rules
 *                           that close stays.
 *   paid, case or stay over recorded paid: the money was taken, and a stay
 *                           still open credits it at its next case. Nothing the
 *                           case, the stay or a let-out wrote is changed, so a
 *                           car let out unpaid stays let out unpaid. Written
 *                           down once, and on the case's exception if it has one.
 *   let out, case open      recorded paid, and on the case's exception.
 *   refunded first          not paid. Left open, written down once.
 *   another amount          not paid (as the lane reads it). Left open, written
 *                           down once.
 *   waiting for a card      nothing changes but what Stripe last said.
 *
 * Written down is one `exit_payment_unplaced` event, and a line on the error
 * output of the run. Nothing is refunded.
 *
 * WHAT IT ASKS ABOUT: open payments at least MIN_AGE_MS old, which a lane has
 * had its turn at, not read in the last READ_QUIET_MS -- those older than
 * RECENT_MS only every OLD_EVERY_MS, since an intent nobody paid stays open.
 * The longest unread first, and a read that failed goes to the back of the
 * line, so `limit` is never spent on the same rows: every row gets its turn.
 * There is no age past which a payment stops being asked about.
 */
import { withTenant } from './db.js';
import * as exits from './exits.js';
import * as exitPayments from './exitPayments.js';
import * as exceptions from './exceptions.js';
import * as repo from './repository.js';
import { connectConfig } from './stripe.js';

export const MIN_AGE_MS = 2 * 60_000;
export const READ_QUIET_MS = 30_000;
export const RECENT_MS = 60 * 60_000;
export const OLD_EVERY_MS = 15 * 60_000;
/** How many payments per account per run. */
export const SWEEP_LIMIT = 200;
export const SWEEP_READ_TIMEOUT_MS = 10_000;

const paidEvent = (client, tenantId, row, payment) => repo.appendEvents(client, tenantId, [{
  garageId: row.garage_id,
  laneId: row.lane_id,
  eventId: `${exitPayments.PAID_EVENT_KIND}:${payment.id}`,
  kind: exitPayments.PAID_EVENT_KIND,
  occurredAt: new Date(payment.succeeded_at),
  detail: {
    actor: 'platform:exit',
    exit_id: row.id,
    amount_minor: payment.amount_minor,
    currency: payment.currency,
    payment_intent_id: payment.payment_intent_id,
    channel: payment.channel,
  },
}]);

/**
 * What Stripe says of the case's intent, written down, under the case's lock;
 * the case as it now stands. `after` runs in the same transaction, given the
 * case as locked and what was written; a retried transaction runs it again.
 */
export const recordCaseIntent = (tenantId, garageId, exitId, intent, readerId = null, after = null) => withTenant(tenantId, async (client) => {
  const row = await exits.caseById(client, tenantId, garageId, exitId, { lock: true });
  let payment = await exitPayments.paymentOf(client, tenantId, exitId);
  if (readerId) payment = await exitPayments.recordReader(client, tenantId, payment, readerId);
  const written = await exitPayments.recordIntent(client, tenantId, payment, intent);
  if (written.paidNow) await paidEvent(client, tenantId, row, written.row);
  await after?.(client, row, written);
  return exits.caseById(client, tenantId, garageId, exitId);
});

/** The open payments due a read, oldest read first. */
async function duePayments(client, tenantId, now, limit) {
  const { rows } = await client.query(
    `SELECT id, garage_id, exit_id, account_id, payment_intent_id
       FROM exit_payments
      WHERE tenant_id = $1 AND status = 'open'
        AND created_at <= $2::timestamptz - $3 * interval '1 millisecond'
        AND (read_at IS NULL OR read_at <= $2::timestamptz - interval '1 millisecond' *
              CASE WHEN created_at > $2::timestamptz - $5 * interval '1 millisecond' THEN $4::double precision ELSE $6 END)
      ORDER BY read_at NULLS FIRST, created_at, id
      LIMIT $7`,
    [tenantId, now, MIN_AGE_MS, READ_QUIET_MS, RECENT_MS, OLD_EVERY_MS, limit],
  );
  return rows;
}

/** A read that failed goes to the back of the line, and nothing else moves. */
const backOfTheLine = (tenantId, paymentId) => withTenant(tenantId, (client) => client.query(
  `UPDATE exit_payments SET read_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'open'`, [tenantId, paymentId]));

/** One event per payment, whatever runs find it again. Answers whether this was the one. */
async function writeDown(client, tenantId, row, payment, why) {
  const { accepted } = await repo.appendEvents(client, tenantId, [{
    garageId: row.garage_id,
    laneId: row.lane_id,
    eventId: `${exitPayments.UNPLACED_EVENT_KIND}:${payment.id}`,
    kind: exitPayments.UNPLACED_EVENT_KIND,
    occurredAt: new Date(),
    detail: {
      actor: 'platform:exit_payment_sweep',
      why,
      exit_id: row.id,
      stay_id: row.session_id,
      payment_id: payment.id,
      payment_intent_id: payment.payment_intent_id,
      amount_minor: payment.amount_minor,
      currency: payment.currency,
    },
  }]);
  return accepted === 1;
}

async function stayIsOver(client, tenantId, sessionId) {
  if (!sessionId) return false;
  const { rows } = await client.query('SELECT exit_at FROM sessions WHERE tenant_id = $1 AND id = $2', [tenantId, sessionId]);
  return Boolean(rows[0]?.exit_at);
}

/** Where what was found goes, beyond the record of the payment: the table at the top of this file. */
async function place(client, tenantId, row, written, intent) {
  const payment = written.row;
  if (payment.status === 'open') {
    const unplaced = intent.status === 'succeeded' && await writeDown(client, tenantId, row, payment, payment.last_failure);
    return { paid: false, unplaced, why: payment.last_failure };
  }
  if (!written.paidNow) return { paid: false, unplaced: false };
  const exception = await exceptions.ofCase(client, tenantId, row.id);
  if (exception) await exceptions.recordPaymentAfter(client, tenantId, exception, payment);
  const why = row.closed_at ? 'case_closed' : (await stayIsOver(client, tenantId, row.session_id)) ? 'stay_ended' : null;
  return { paid: true, unplaced: Boolean(why) && await writeDown(client, tenantId, row, payment, why), why };
}

/**
 * One run over one account. Answers counts: `due` asked about, `paid` recorded
 * paid by this run, `unplaced` written down by this run, `failed` left for the
 * next. A deployment with no Stripe key has nothing to ask.
 */
export async function sweepOpenPayments(tenantId, { now = new Date(), limit = SWEEP_LIMIT, config = connectConfig() } = {}) {
  const summary = { due: 0, paid: 0, unplaced: 0, failed: 0 };
  if (!config.key) return summary;
  const due = await withTenant(tenantId, (client) => duePayments(client, tenantId, now, limit));
  summary.due = due.length;
  for (const p of due) {
    try {
      const intent = await exitPayments.readIntentWithCharge(config, p.account_id, p.payment_intent_id, { timeoutMs: SWEEP_READ_TIMEOUT_MS });
      let found = null;
      await recordCaseIntent(tenantId, p.garage_id, p.exit_id, intent, null, async (client, row, written) => {
        found = await place(client, tenantId, row, written, intent);
      });
      if (found.paid) summary.paid += 1;
      if (found.unplaced) {
        summary.unplaced += 1;
        console.error(`[exit-payments] a charge is written down for a person: payment ${p.id}, ${found.why}`);
      }
    } catch (err) {
      summary.failed += 1;
      console.error(`[exit-payments] payment ${p.id} left for the next run: ${err.code ?? err.message ?? err}`);
      await backOfTheLine(tenantId, p.id).catch(() => {});
    }
  }
  return summary;
}
