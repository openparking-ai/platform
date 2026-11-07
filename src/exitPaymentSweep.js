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
 * WHAT IS FOUND AND WHERE IT GOES, whichever read finds it first -- this sweep,
 * a lane's poll, a close, a let-out, the next case (`place`):
 *
 *   paid, case open         recorded paid. The case reads settled at the lane's
 *                           next ask; the stay stays as it is, for the rules
 *                           that close stays.
 *   paid, case or stay over recorded paid: the money was taken, and a stay
 *                           still open credits it at its next case. Nothing the
 *                           case, the stay or a let-out wrote is changed, so a
 *                           car let out unpaid stays let out unpaid. Written
 *                           down once.
 *   on a case let out       the payment as it now stands is appended to the
 *                           case's exception, which is not rewritten.
 *   refunded whole first    no money was kept: final as canceled, and the car
 *                           owes as normal, so nothing is ever held up by it.
 *                           Written down once.
 *   refunded in part first  paid, for what it kept: the stay is credited that
 *                           and no more. Written down once.
 *   another amount          not paid. Left open, written down once.
 *   waiting for a card      nothing changes but what Stripe last said.
 *
 * Written down is one `exit_payment_unplaced` event, and a line on the error
 * output of whichever process found it. The scheduled run exits 1 for any
 * written down lately, by anyone (`writtenDownSince`). Nothing is refunded here.
 *
 * WHAT IT ASKS ABOUT: open payments at least MIN_AGE_MS old, which a lane has
 * had its turn at, not read in the last READ_QUIET_MS -- those older than
 * RECENT_MS only every OLD_EVERY_MS, since an intent nobody paid stays open.
 * The longest unread first, and a read that failed goes to the back of the
 * line, so `limit` is never spent on the same rows: every row gets its turn.
 * There is no age past which a payment stops being asked about.
 *
 * ONE RUN AT A TIME (`whileHoldingSweepLock`): reads are one after another, so a
 * Stripe that hangs would stack a process a minute. A run that finds another
 * working stops, and a run stops reading at its deadline (RUN_DEADLINE_MS).
 */
import { pool, withTenant } from './db.js';
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
/** A run stops reading after this long; what it did not reach is the next run's. */
export const RUN_DEADLINE_MS = 5 * 60_000;
/** How far back a scheduled run looks for charges written down: two runs see each, so none is missed. */
export const ALARM_WINDOW_MS = 2 * 60_000;

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

/** Refunded whole first: what a cancel writes, by the same id, so it is one event however it was found. */
const canceledEvent = (client, tenantId, row, payment) => repo.appendEvents(client, tenantId, [{
  garageId: row.garage_id,
  laneId: row.lane_id,
  eventId: `${exitPayments.PAYMENT_CANCELED_EVENT_KIND}:${payment.id}`,
  kind: exitPayments.PAYMENT_CANCELED_EVENT_KIND,
  occurredAt: new Date(),
  detail: { actor: 'platform:exit', exit_id: row.id, payment_intent_id: payment.payment_intent_id, why: exitPayments.REFUNDED_FIRST },
}]);

/** One event per payment, whatever runs find it again. Answers whether this was the one. */
async function writeDown(client, tenantId, row, payment, why, also = null) {
  const { accepted } = await repo.appendEvents(client, tenantId, [{
    garageId: row.garage_id,
    laneId: row.lane_id,
    eventId: `${exitPayments.UNPLACED_EVENT_KIND}:${payment.id}`,
    kind: exitPayments.UNPLACED_EVENT_KIND,
    occurredAt: new Date(),
    detail: {
      actor: 'platform:exit',
      why,
      ...(also && also !== why ? { also } : {}),
      exit_id: row.id,
      stay_id: row.session_id,
      payment_id: payment.id,
      payment_intent_id: payment.payment_intent_id,
      amount_minor: payment.amount_minor,
      currency: payment.currency,
    },
  }]);
  if (accepted === 1) console.error(`[exit-payments] a charge is written down for a person: payment ${payment.id}, ${why}`);
  return accepted === 1;
}

/** Whether the stay is over: nothing closed the case, but the stay has an exit. */
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
    return { paid: false, unplaced };
  }
  if (!written.finalNow) return { paid: false, unplaced: false };
  const exception = await exceptions.ofCase(client, tenantId, row.id);
  if (exception) await exceptions.recordPaymentAfter(client, tenantId, exception, payment);
  let over = null;
  if (written.paidNow) over = row.closed_at ? 'case_closed' : (await stayIsOver(client, tenantId, row.session_id)) ? 'stay_ended' : null;
  const why = written.refunded ?? over;
  return { paid: written.paidNow, unplaced: Boolean(why) && await writeDown(client, tenantId, row, payment, why, over) };
}

/**
 * What Stripe says of the case's intent, written down, under the case's lock,
 * and placed; the case as it now stands. `told` hears what was placed; a retried
 * transaction tells it again.
 */
export const recordCaseIntent = (tenantId, garageId, exitId, intent, readerId = null, told = null) => withTenant(tenantId, async (client) => {
  const row = await exits.caseById(client, tenantId, garageId, exitId, { lock: true });
  let payment = await exitPayments.paymentOf(client, tenantId, exitId);
  if (readerId) payment = await exitPayments.recordReader(client, tenantId, payment, readerId);
  const written = await exitPayments.recordIntent(client, tenantId, payment, intent);
  if (written.paidNow) await paidEvent(client, tenantId, row, written.row);
  if (written.refunded === exitPayments.REFUNDED_FIRST) await canceledEvent(client, tenantId, row, written.row);
  const placed = await place(client, tenantId, row, written, intent);
  told?.(placed);
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

/**
 * One run over one account. Answers counts: `due` asked about, `paid` recorded
 * paid by this run, `unplaced` written down by this run, `failed` left for the
 * next. A deployment with no Stripe key has nothing to ask.
 */
export async function sweepOpenPayments(tenantId, { now = new Date(), limit = SWEEP_LIMIT, config = connectConfig(), deadline = Infinity } = {}) {
  const summary = { due: 0, paid: 0, unplaced: 0, failed: 0 };
  if (!config.key) return summary;
  const due = await withTenant(tenantId, (client) => duePayments(client, tenantId, now, limit));
  summary.due = due.length;
  for (const p of due) {
    if (Date.now() >= deadline) break;
    try {
      const intent = await exitPayments.readIntentWithCharge(config, p.account_id, p.payment_intent_id, { timeoutMs: SWEEP_READ_TIMEOUT_MS });
      let found = null;
      await recordCaseIntent(tenantId, p.garage_id, p.exit_id, intent, null, (placed) => { found = placed; });
      if (found.paid) summary.paid += 1;
      if (found.unplaced) summary.unplaced += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(`[exit-payments] payment ${p.id} left for the next run: ${err.code ?? err.message ?? err}`);
      await backOfTheLine(tenantId, p.id).catch(() => {});
    }
  }
  return summary;
}

/** How many charges this account had written down since `since`, by any read: what a scheduled run alarms on. */
export async function writtenDownSince(tenantId, since) {
  const { rows } = await withTenant(tenantId, (client) => client.query(
    'SELECT count(*)::int AS n FROM events WHERE tenant_id = $1 AND kind = $2 AND occurred_at >= $3',
    [tenantId, exitPayments.UNPLACED_EVENT_KIND, since],
  ));
  return rows[0].n;
}

/**
 * `fn` while no other run holds this lock, on a connection kept for it, so a
 * process that dies lets go. Answers `{ran: false}` when another run has it.
 */
export async function whileHoldingSweepLock(fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtextextended('exit-payment-sweep', 0)) AS got`);
    if (!rows[0].got) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended('exit-payment-sweep', 0))`);
    }
  } finally {
    client.release();
  }
}
