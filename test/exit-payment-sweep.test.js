/**
 * THE EXIT PAYMENT NOBODY FINISHED (src/exitPaymentSweep.js): a card Stripe
 * took is recorded with nobody asking, once, and a person's let-out reads
 * Stripe before it writes a car down as unpaid.
 *
 * What this file measures, each with a break in
 * `scripts/exit-payments-fail-control.js`:
 *
 *   * a lane that stopped asking: the sweep records the payment, once, with the
 *     one `exit_paid` event, and the stay stays as it is;
 *   * it writes nothing at Stripe: an intent waiting for a card is untouched,
 *     and a lane can still finish it;
 *   * two sweeps at once, and a sweep and a lane at once, record once;
 *   * a payment on a closed case is kept and credited, the case and the stay as
 *     they were, written down once; a car let out unpaid stays let out unpaid;
 *   * a charge refunded whole first is final as canceled and never stops a car:
 *     its close, its stay's end and its next entry all go through; refunded in
 *     part it is paid for what it kept; another amount is not paid; each
 *     written down once;
 *   * a car that paid and is let out is not written as let out unpaid;
 *   * the paid date is Stripe's when the read carries it, the clock otherwise;
 *   * every row gets its turn, and Stripe's errors stop nothing.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant } from './helpers.js';
import {
  sweepOpenPayments, recordCaseIntent, whileHoldingSweepLock, writtenDownSince, MIN_AGE_MS, OLD_EVERY_MS, RECENT_MS,
} from '../src/exitPaymentSweep.js';
import {
  startHarness, cardGarage, enter, caseAt, pay, caseOf, close, rows, plateNo, unconfigure, configure,
} from './exit-harness.js';

let h;
const later = (ms = MIN_AGE_MS + 60_000) => new Date(Date.now() + ms);
const sweep = (g, options = {}) => sweepOpenPayments(g.tenant, { now: later(), ...options });

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h?.stop();
  await pool.end();
});

/** A car at the exit, its payment started on the reader: the lane then goes quiet. */
async function started(g, prefix = 'SWP') {
  const { plate } = await enter(h, g, { plate: plateNo(prefix) });
  const exit = await caseAt(h, g, plate);
  const paying = await pay(h, g, exit.id);
  return { plate, exit, intentId: paying.payment.payment_intent_id };
}
/** The same, and the card taken: the reader is free for the next car, and nothing has recorded it. */
async function paidAtTheReader(g, prefix) {
  const car = await started(g, prefix);
  h.stub.presentCard(car.intentId);
  return car;
}
const paymentOf = async (g, exitId) => (await rows(g, 'SELECT * FROM exit_payments WHERE exit_id = $1', [exitId]))[0];
const eventsOf = (g, kind, exitId) => rows(g, `SELECT * FROM events WHERE kind = $1 AND detail->>'exit_id' = $2`, [kind, exitId]);
const stayOf = async (g, sessionId) => (await rows(g, 'SELECT * FROM sessions WHERE id = $1', [sessionId]))[0];
const stripeWrites = (from) => h.stub.requests.slice(from).filter((r) => r.method !== 'GET');
const stripeReads = (from) => h.stub.requests.slice(from).filter((r) => r.method === 'GET');

/** Stripe out of reach for the length of `fn`; everything else as it was. */
async function silentStripe(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, opts) => (String(url).startsWith(h.stub.base) ? Promise.reject(new TypeError('fetch failed')) : real(url, opts));
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('THE LANE IS GONE: the card Stripe took is recorded once, with one exit_paid event, and the stay stays as it is', async () => {
  const g = await cardGarage(h, 'sweep-gone');
  const { exit, intentId } = await started(g);
  h.stub.presentCard(intentId);
  assert.equal((await paymentOf(g, exit.id)).status, 'open', 'nobody has asked: the record still says open');

  const from = h.stub.requests.length;
  assert.deepEqual(await sweep(g), { due: 1, paid: 1, unplaced: 0, failed: 0 });
  assert.deepEqual(stripeWrites(from), [], 'it only reads Stripe');
  const p = await paymentOf(g, exit.id);
  assert.deepEqual([p.status, p.stripe_status], ['succeeded', 'succeeded']);

  const told = await eventsOf(g, 'exit_paid', exit.id);
  assert.equal(told.length, 1);
  assert.deepEqual(Object.keys(told[0].detail).sort(),
    ['actor', 'amount_minor', 'channel', 'currency', 'exit_id', 'payment_intent_id'], "the lane path's event, and nothing of a card");
  assert.equal(told[0].detail.actor, 'platform:exit');

  assert.deepEqual(await sweep(g), { due: 0, paid: 0, unplaced: 0, failed: 0 }, 'nothing left to ask');
  assert.equal((await eventsOf(g, 'exit_paid', exit.id)).length, 1);

  const stay = await stayOf(g, exit.session_id);
  assert.deepEqual([stay.exit_at, stay.ended, stay.let_out], [null, null, null], 'closing a stay is the rules that close stays');
  assert.equal((await rows(g, 'SELECT closed_at FROM exits WHERE id = $1', [exit.id]))[0].closed_at, null);

  // The lane comes back: the case reads paid, and the close goes as it always did.
  const back = await caseOf(h, g, exit.id);
  assert.deepEqual([back.settled, back.why], [true, 'paid']);
  assert.equal((await close(h, g, exit.id)).status, 200);
  assert.equal((await eventsOf(g, 'exit_paid', exit.id)).length, 1, 'the close found it recorded');
});

test('A PAYMENT A LANE IS STILL AT is left to the lane: nothing younger than the minimum age is read', async () => {
  const g = await cardGarage(h, 'sweep-young');
  const { exit, intentId } = await started(g);
  h.stub.presentCard(intentId);
  await withTenant(g.tenant, (c) => c.query(`UPDATE exit_payments SET read_at = now() - interval '1 hour'`));
  const from = h.stub.requests.length;
  assert.deepEqual(await sweep(g, { now: new Date() }), { due: 0, paid: 0, unplaced: 0, failed: 0 });
  assert.deepEqual(stripeReads(from), []);
  assert.equal((await paymentOf(g, exit.id)).status, 'open');
  // Control: the same row, old enough.
  assert.equal((await sweep(g)).paid, 1);
});

test('AN INTENT WAITING FOR A CARD is untouched: no write at Stripe, still open, and the lane can finish it', async () => {
  const g = await cardGarage(h, 'sweep-waiting');
  const { exit, intentId } = await started(g);
  const from = h.stub.requests.length;
  assert.deepEqual(await sweep(g), { due: 1, paid: 0, unplaced: 0, failed: 0 });
  assert.deepEqual(stripeWrites(from), [], 'never a cancel, a confirm or a capture');
  assert.equal(stripeReads(from).length, 1, 'one read');
  assert.equal(h.stub.intents.get(intentId).status, 'requires_payment_method');
  assert.deepEqual(h.stub.cancels.filter((id) => id === intentId), []);
  assert.equal((await h.stub.terminal.find((t) => t.id === g.readerId)).action.status, 'in_progress', 'still on the reader');
  const p = await paymentOf(g, exit.id);
  assert.deepEqual([p.status, p.stripe_status], ['open', 'requires_payment_method']);
  assert.deepEqual(await eventsOf(g, 'exit_paid', exit.id), []);
  // Control: the driver pays after the sweep.
  h.stub.presentCard(intentId);
  assert.equal((await caseOf(h, g, exit.id)).why, 'paid');
});

test('TWO SWEEPS AT ONCE record each payment once', async () => {
  const g = await cardGarage(h, 'sweep-two');
  const cars = [];
  for (let i = 0; i < 6; i += 1) cars.push(await paidAtTheReader(g, `TW${i}`));
  const [a, b] = await Promise.all([sweep(g), sweep(g)]);
  assert.equal(a.paid + b.paid, cars.length, JSON.stringify({ a, b }));
  for (const c of cars) {
    assert.equal((await eventsOf(g, 'exit_paid', c.exit.id)).length, 1);
    assert.equal((await paymentOf(g, c.exit.id)).status, 'succeeded');
  }
});

test('A SWEEP AND A LANE POLL AT ONCE record once', async () => {
  const g = await cardGarage(h, 'sweep-lane');
  const cars = [];
  for (let i = 0; i < 6; i += 1) cars.push(await paidAtTheReader(g, `SL${i}`));
  await withTenant(g.tenant, (c) => c.query(`UPDATE exit_payments SET read_at = now() - interval '1 hour'`));
  const [swept, ...polls] = await Promise.all([
    sweep(g),
    ...cars.map((c) => h.call(g.exit, 'GET', `/lane/exits/${c.exit.id}`).then((r) => r.json())),
  ]);
  assert.equal(swept.failed, 0);
  for (const poll of polls) assert.ok(poll.exit, JSON.stringify(poll));
  for (const c of cars) {
    assert.equal((await eventsOf(g, 'exit_paid', c.exit.id)).length, 1);
    assert.equal((await paymentOf(g, c.exit.id)).status, 'succeeded');
  }
});

test('A CASE ALREADY CLOSED: the payment is kept and credited, the case and the stay as they were, written down once', async () => {
  const g = await cardGarage(h, 'sweep-closed');
  const { plate, exit, intentId } = await started(g);
  h.stub.presentCard(intentId);
  // The record of a case some other path closed with its payment still open.
  await withTenant(g.tenant, (c) => c.query(
    `UPDATE exits SET closed_at = now(), ended = $2 WHERE id = $1`,
    [exit.id, { why: 'stay_ended', by: 'user:someone', at: new Date().toISOString() }]));
  const closed = (await rows(g, 'SELECT closed_at, ended FROM exits WHERE id = $1', [exit.id]))[0];

  assert.deepEqual(await sweep(g), { due: 1, paid: 1, unplaced: 1, failed: 0 });
  assert.equal((await paymentOf(g, exit.id)).status, 'succeeded', 'the money was taken: the record says so');
  assert.equal((await eventsOf(g, 'exit_paid', exit.id)).length, 1);
  const noted = await eventsOf(g, 'exit_payment_unplaced', exit.id);
  assert.equal(noted.length, 1);
  assert.equal(noted[0].detail.why, 'case_closed');
  assert.deepEqual((await rows(g, 'SELECT closed_at, ended FROM exits WHERE id = $1', [exit.id]))[0], closed);
  assert.equal((await stayOf(g, exit.session_id)).exit_at, null);

  assert.equal((await sweep(g)).unplaced, 0);
  assert.equal((await eventsOf(g, 'exit_payment_unplaced', exit.id)).length, 1, 'once');

  // Credited as any payment of the stay: the car's next case asks nothing more.
  const next = await caseAt(h, g, plate, { exitMin: 0.2 });
  assert.equal(next.fee.credit_minor, exit.fee.fee_minor);
  assert.deepEqual([next.settled, next.why], [true, 'paid']);
});

test('A CASE STILL OPEN is not written down: paid and placed is nothing for a person', async () => {
  const g = await cardGarage(h, 'sweep-placed');
  const { exit, intentId } = await started(g);
  h.stub.presentCard(intentId);
  assert.equal((await sweep(g)).unplaced, 0);
  assert.deepEqual(await eventsOf(g, 'exit_payment_unplaced', exit.id), []);
});

test('A STAY ALREADY OVER: the payment is kept, the stay is not changed, written down once', async () => {
  const g = await cardGarage(h, 'sweep-stay-over');
  const { exit, intentId } = await started(g);
  h.stub.presentCard(intentId);
  await withTenant(g.tenant, (c) => c.query(
    `UPDATE sessions SET exit_at = now(), ended = $2 WHERE id = $1`,
    [exit.session_id, { reason: 'abandoned', by: 'user:someone', why: 'towed', at: new Date().toISOString() }]));
  const stay = await stayOf(g, exit.session_id);
  assert.equal((await sweep(g)).unplaced, 1);
  assert.equal((await eventsOf(g, 'exit_payment_unplaced', exit.id))[0].detail.why, 'stay_ended');
  assert.deepEqual(await stayOf(g, exit.session_id), stay);
});

test('A CAR LET OUT UNPAID WITH STRIPE SILENT stays let out unpaid: the charge found after is on its exception, and the exception is not rewritten', async () => {
  const g = await cardGarage(h, 'sweep-let-out');
  const { exit, intentId } = await started(g);
  const res = await silentStripe(() => h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/let-out`, { reason: 'reader frozen' }));
  assert.equal(res.status, 200, 'the let-out is never held up');
  const [written] = await rows(g, 'SELECT * FROM exceptions WHERE exit_id = $1', [exit.id]);
  assert.deepEqual([written.kind, written.owed_minor], ['let_out_unpaid', exit.fee.fee_minor]);

  h.stub.presentCard(intentId);
  assert.equal((await sweep(g)).paid, 1);
  assert.equal((await paymentOf(g, exit.id)).status, 'succeeded');
  const [still] = await rows(g, 'SELECT * FROM exceptions WHERE exit_id = $1', [exit.id]);
  assert.deepEqual(still, written, 'what was written at the let-out stands');
  const appended = await rows(g, `SELECT records FROM exception_records WHERE exception_id = $1 AND source = 'payment_after_let_out' ORDER BY copied_at, id`, [written.id]);
  assert.equal(appended.at(-1).records[0].status, 'succeeded');
  const whole = (await (await h.call(g.op, 'GET', `/garages/${g.world.garage}/exceptions/${written.id}`)).json()).exception;
  assert.equal(whole.payment_after_let_out.status, 'succeeded', 'the latest is the one read back');
});

/** A car whose charge Stripe took and refunded whole, recorded by nothing yet. */
async function refundedWhole(g) {
  const car = await paidAtTheReader(g);
  h.stub.refund(car.intentId, car.exit.fee.fee_minor);
  return car;
}

test('REFUNDED WHOLE FIRST: no money was kept. Final as canceled, written down once, nothing at Stripe; the case owes as normal', async () => {
  const g = await cardGarage(h, 'sweep-refunded');
  const { exit, intentId } = await refundedWhole(g);
  const from = h.stub.requests.length;
  assert.deepEqual(await sweep(g), { due: 1, paid: 0, unplaced: 1, failed: 0 });
  assert.deepEqual(stripeWrites(from), []);
  const p = await paymentOf(g, exit.id);
  assert.deepEqual([p.status, p.last_failure, p.succeeded_at, p.refunded_minor], ['canceled', 'refunded_before_recorded', null, exit.fee.fee_minor]);
  assert.deepEqual(await eventsOf(g, 'exit_paid', exit.id), []);
  const noted = await eventsOf(g, 'exit_payment_unplaced', exit.id);
  assert.deepEqual([noted.length, noted[0].detail.why], [1, 'refunded_before_recorded']);
  assert.equal((await eventsOf(g, 'exit_payment_canceled', exit.id)).length, 1);

  assert.deepEqual(await sweep(g), { due: 0, paid: 0, unplaced: 0, failed: 0 }, 'final: not asked about again');
  const polled = await caseOf(h, g, exit.id);
  assert.deepEqual([polled.settled, polled.needs, polled.payment.status], [false, 'payment', 'canceled']);
  assert.equal(h.stub.cancels.includes(intentId), false);
});

for (const [how, first] of [['the sweep found it', true], ['nothing had read it', false]]) {
  test(`A FULL REFUND NEVER STOPS A CAR, ${how}: the close goes through, the car owing as normal`, async () => {
    const g = await cardGarage(h, `refund-close-${first}`);
    const { exit } = await refundedWhole(g);
    if (first) await sweep(g);
    const res = await close(h, g, exit.id);
    assert.equal(res.status, 200, await res.clone().text());
    const stay = await stayOf(g, exit.session_id);
    assert.deepEqual([stay.let_out?.paid, stay.let_out?.owed_minor], [false, exit.fee.fee_minor], 'it left owing');
    assert.equal((await paymentOf(g, exit.id)).status, 'canceled');
    assert.equal((await eventsOf(g, 'exit_payment_unplaced', exit.id)).length, 1, 'written down once, whoever found it');
    assert.equal((await eventsOf(g, 'exit_payment_canceled', exit.id)).length, 1);
  });

  test(`A FULL REFUND NEVER STOPS A CAR, ${how}: a person ends the stay`, async () => {
    const g = await cardGarage(h, `refund-end-${first}`);
    const { exit } = await refundedWhole(g);
    if (first) await sweep(g);
    const res = await h.call(g.op, 'POST', `/garages/${g.world.garage}/stays/${exit.session_id}/end`, { outcome: 'ended', reason: 'seen leaving' });
    assert.equal(res.status, 200, await res.clone().text());
    const stay = await stayOf(g, exit.session_id);
    assert.equal(stay.ended.reason, 'ended');
    assert.equal(stay.ended.paid, undefined, 'nothing paid');
    assert.equal((await paymentOf(g, exit.id)).status, 'canceled');
    assert.equal((await eventsOf(g, 'exit_payment_unplaced', exit.id)).length, 1);
  });

  test(`A FULL REFUND NEVER STOPS A CAR, ${how}: the car comes in again`, async () => {
    const g = await cardGarage(h, `refund-entry-${first}`);
    const { plate, exit } = await refundedWhole(g);
    if (first) await sweep(g);
    await enter(h, g, { plate, inMin: 0.1 });
    const stay = await stayOf(g, exit.session_id);
    assert.equal(stay.ended.reason, 'superseded');
    assert.equal((await paymentOf(g, exit.id)).status, 'canceled');
    assert.equal((await eventsOf(g, 'exit_payment_unplaced', exit.id)).length, 1);
  });

  test(`A FULL REFUND NEVER STOPS A CAR, ${how}: its next case asks the whole fee and can be paid`, async () => {
    const g = await cardGarage(h, `refund-next-${first}`);
    const { plate } = await refundedWhole(g);
    if (first) await sweep(g);
    const next = await caseAt(h, g, plate, { exitMin: 0.2 });
    assert.deepEqual([next.settled, next.needs, next.fee.credit_minor], [false, 'payment', 0]);
    const again = await pay(h, g, next.id);
    h.stub.presentCard(again.payment.payment_intent_id);
    assert.equal((await caseOf(h, g, next.id)).why, 'paid');
  });
}

test('Control: an unrefunded car closes paid, with nothing written down', async () => {
  const g = await cardGarage(h, 'refund-control');
  const { exit } = await paidAtTheReader(g);
  await sweep(g);
  assert.equal((await close(h, g, exit.id)).status, 200);
  assert.equal((await stayOf(g, exit.session_id)).let_out, null);
  assert.deepEqual(await eventsOf(g, 'exit_payment_unplaced', exit.id), []);
});

test('A FULL REFUND AT A LET-OUT: the car is written as it is, owing, and the let-out goes through', async () => {
  const g = await cardGarage(h, 'refund-let-out');
  const { exit } = await refundedWhole(g);
  const res = await h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/let-out`, { reason: 'gate jammed' });
  assert.equal(res.status, 200, await res.clone().text());
  const [x] = await rows(g, 'SELECT * FROM exceptions WHERE exit_id = $1', [exit.id]);
  assert.deepEqual([x.kind, x.owed_minor, x.paid_minor], ['let_out_unpaid', exit.fee.fee_minor, 0]);
  assert.equal((await close(h, g, exit.id)).status, 200);
});

test('REFUNDED IN PART FIRST: paid for what it kept, written down once; the stay is credited that and no more', async () => {
  const g = await cardGarage(h, 'sweep-part');
  const { plate, exit, intentId } = await paidAtTheReader(g);
  h.stub.refund(intentId, 100);
  assert.deepEqual(await sweep(g), { due: 1, paid: 1, unplaced: 1, failed: 0 });
  const p = await paymentOf(g, exit.id);
  assert.deepEqual([p.status, p.refunded_minor, p.last_failure], ['succeeded', 100, null]);
  assert.equal((await eventsOf(g, 'exit_paid', exit.id)).length, 1);
  assert.equal((await eventsOf(g, 'exit_payment_unplaced', exit.id))[0].detail.why, 'part_refunded_before_recorded');
  const next = await caseAt(h, g, plate, { exitMin: 0.2 });
  assert.equal(next.fee.credit_minor, exit.fee.fee_minor - 100, 'credited only what was kept');
  assert.equal(next.fee.fee_minor, 100, 'and asked the rest');
});

test('ANOTHER AMOUNT REFUNDED WHOLE kept no money either: canceled, not left in the way', async () => {
  const g = await cardGarage(h, 'refund-amount');
  const { exit, intentId } = await started(g);
  h.stub.intents.get(intentId).amount += 100;
  h.stub.presentCard(intentId);
  h.stub.refund(intentId, h.stub.intents.get(intentId).amount);
  assert.equal((await sweep(g)).unplaced, 1);
  assert.equal((await paymentOf(g, exit.id)).status, 'canceled');
});

test('REFUNDED AFTER IT WAS RECORDED is paid, as it was: the credit reads the refund as before', async () => {
  const g = await cardGarage(h, 'sweep-after');
  const { exit, intentId } = await started(g);
  h.stub.presentCard(intentId);
  assert.equal((await sweep(g)).paid, 1);
  h.stub.refund(intentId, exit.fee.fee_minor);
  assert.deepEqual(await sweep(g), { due: 0, paid: 0, unplaced: 0, failed: 0 });
  assert.equal((await paymentOf(g, exit.id)).status, 'succeeded');
});

test('ANOTHER AMOUNT is not paid, and is written down once', async () => {
  const g = await cardGarage(h, 'sweep-amount');
  const { exit, intentId } = await started(g);
  h.stub.intents.get(intentId).amount += 100;
  h.stub.presentCard(intentId);
  assert.deepEqual(await sweep(g), { due: 1, paid: 0, unplaced: 1, failed: 0 });
  assert.deepEqual(await sweep(g), { due: 1, paid: 0, unplaced: 0, failed: 0 });
  const p = await paymentOf(g, exit.id);
  assert.deepEqual([p.status, p.last_failure], ['open', 'amount_mismatch']);
  assert.equal((await eventsOf(g, 'exit_payment_unplaced', exit.id))[0].detail.why, 'amount_mismatch');
});

test('A PAID CAR LET OUT IS NOT WRITTEN UNPAID: Stripe is read before the exception is built', async () => {
  const g = await cardGarage(h, 'letout-paid');
  const { exit, intentId } = await started(g);
  h.stub.presentCard(intentId);
  assert.equal((await paymentOf(g, exit.id)).status, 'open', 'the record has not heard yet');

  const res = await h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/let-out`, { reason: 'gate jammed' });
  assert.equal(res.status, 200, await res.clone().text());
  const [x] = await rows(g, 'SELECT * FROM exceptions WHERE exit_id = $1', [exit.id]);
  assert.deepEqual([x.kind, x.owed_minor, x.paid_minor], ['barrier_opened', 0, exit.fee.fee_minor]);
  assert.equal(x.story.payments[0].status, 'succeeded');
  assert.equal((await eventsOf(g, 'exit_paid', exit.id)).length, 1);
  assert.equal(h.stub.cancels.includes(intentId), false, 'a paid intent is never canceled');

  const closed = await close(h, g, exit.id);
  assert.equal(closed.status, 200, await closed.clone().text());
  assert.equal((await stayOf(g, exit.session_id)).let_out, null, 'not a car let out owing');
});

test('Control: a car that did not pay, let out, is written unpaid and its intent canceled, as before', async () => {
  const g = await cardGarage(h, 'letout-unpaid');
  const { exit, intentId } = await started(g);
  const res = await h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/let-out`, { reason: 'reader broken' });
  assert.equal(res.status, 200);
  const [x] = await rows(g, 'SELECT * FROM exceptions WHERE exit_id = $1', [exit.id]);
  assert.deepEqual([x.kind, x.owed_minor, x.paid_minor], ['let_out_unpaid', exit.fee.fee_minor, 0]);
  assert.equal(h.stub.intents.get(intentId).status, 'canceled');
});

test("THE PAID DATE IS STRIPE'S: a late find lands on the day the card was taken, on the record and the event", async () => {
  const g = await cardGarage(h, 'sweep-date');
  const { exit, intentId } = await started(g);
  const taken = new Date(Date.UTC(2026, 0, 15, 23, 59, 0));
  h.stub.presentCard(intentId, { at: taken });
  await sweep(g);
  assert.equal((await paymentOf(g, exit.id)).succeeded_at.toISOString(), taken.toISOString());
  assert.equal((await eventsOf(g, 'exit_paid', exit.id))[0].occurred_at.toISOString(), taken.toISOString());
});

test("A LATE FIND AT THE NEXT CASE OR A LET-OUT is Stripe's date too", async () => {
  const taken = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
  const g = await cardGarage(h, 'found-date');
  const first = await started(g);
  h.stub.presentCard(first.intentId, { at: taken });
  await caseAt(h, g, first.plate, { exitMin: 0.2 });
  assert.equal((await paymentOf(g, first.exit.id)).succeeded_at.toISOString(), taken.toISOString(), 'found by the case that superseded it');

  const second = await started(g);
  h.stub.presentCard(second.intentId, { at: taken });
  await h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${second.exit.id}/let-out`, { reason: 'gate jammed' });
  assert.equal((await paymentOf(g, second.exit.id)).succeeded_at.toISOString(), taken.toISOString(), 'found by the let-out');
});

test("Control: the lane's own poll keeps the clock", async () => {
  const g = await cardGarage(h, 'poll-clock');
  const { exit, intentId } = await started(g);
  h.stub.presentCard(intentId, { at: new Date(Date.UTC(2026, 0, 15)) });
  const before = Date.now();
  assert.equal((await caseOf(h, g, exit.id)).why, 'paid');
  const at = (await paymentOf(g, exit.id)).succeeded_at.getTime();
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, 'read as it happens');
});

test("EVERY ROW GETS ITS TURN: a read Stripe refuses goes to the back of the line, and stops nothing", async () => {
  const g = await cardGarage(h, 'sweep-turns');
  const stuck = await paidAtTheReader(g, 'ST1');
  const other = await paidAtTheReader(g, 'ST2');
  await withTenant(g.tenant, (c) => c.query(`UPDATE exit_payments SET read_at = now() - interval '1 hour' WHERE exit_id = $1`, [stuck.exit.id]));
  const real = globalThis.fetch;
  globalThis.fetch = (url, opts) => (String(url).includes(stuck.intentId)
    ? Promise.resolve(new Response(JSON.stringify({ error: { type: 'api_error', message: 'stub refused' } }), { status: 500, headers: { 'content-type': 'application/json' } }))
    : real(url, opts));
  try {
    assert.deepEqual(await sweep(g, { limit: 1 }), { due: 1, paid: 0, unplaced: 0, failed: 1 });
    assert.equal((await paymentOf(g, stuck.exit.id)).status, 'open', 'nothing recorded on an error');
    assert.deepEqual(await sweep(g, { limit: 1 }), { due: 1, paid: 1, unplaced: 0, failed: 0 }, 'the next run reads the next row');
    assert.equal((await paymentOf(g, other.exit.id)).status, 'succeeded');
  } finally {
    globalThis.fetch = real;
  }
  assert.equal((await sweep(g, { limit: 1 })).paid, 1, 'and the refused one on the run after Stripe answers');
  assert.equal((await paymentOf(g, stuck.exit.id)).status, 'succeeded');
});

test('STRIPE OUT OF REACH: every row is logged and left for the next run; the run ends', async () => {
  const g = await cardGarage(h, 'sweep-silent');
  await paidAtTheReader(g, 'OUT');
  await paidAtTheReader(g, 'OUB');
  assert.deepEqual(await silentStripe(() => sweep(g)), { due: 2, paid: 0, unplaced: 0, failed: 2 });
  assert.deepEqual(await sweep(g), { due: 2, paid: 2, unplaced: 0, failed: 0 });
});

test('AN OLD ROW NOBODY PAID is read every so often, with no age past which it stops', async () => {
  const g = await cardGarage(h, 'sweep-old');
  await started(g);
  assert.equal((await sweep(g)).due, 1);
  const old = RECENT_MS + MIN_AGE_MS;
  // `read_at` is now: an hour on it is old, and read at the slower pace.
  assert.equal((await sweep(g, { now: later(old) })).due, 1, 'not read for over an hour');
  assert.equal((await sweep(g, { now: new Date(Date.now() + RECENT_MS + 60_000) })).due, 1);
  await withTenant(g.tenant, (c) => c.query(`UPDATE exit_payments SET read_at = now() + interval '1 day'`));
  const quiet = 24 * 3_600_000 + OLD_EVERY_MS;
  assert.equal((await sweep(g, { now: later(quiet - 60_000) })).due, 0, 'read within the slower pace: left');
  assert.equal((await sweep(g, { now: later(quiet + 60_000) })).due, 1, 'past it: read');
  assert.equal((await sweep(g, { now: later(400 * 24 * 3_600_000) })).due, 1, 'a year on, still asked about');
});

test('A DEPLOYMENT WITH NO STRIPE KEY has nothing to ask', async () => {
  const g = await cardGarage(h, 'sweep-off');
  const { intentId } = await started(g);
  h.stub.presentCard(intentId);
  unconfigure();
  try {
    assert.deepEqual(await sweep(g), { due: 0, paid: 0, unplaced: 0, failed: 0 });
  } finally {
    configure(h.stub);
  }
});

test('ONE ACCOUNT AT A TIME: a sweep of one tenant never reads another tenant\'s payment', async () => {
  const a = await cardGarage(h, 'sweep-a');
  const b = await cardGarage(h, 'sweep-b');
  const inA = await started(a);
  const inB = await started(b);
  h.stub.presentCard(inA.intentId);
  h.stub.presentCard(inB.intentId);
  assert.equal((await sweep(a)).paid, 1);
  assert.equal((await paymentOf(b, inB.exit.id)).status, 'open');
});

/** A car let out while Stripe was silent, its card then taken: its record is yet to hear. */
async function letOutThenPaid(g) {
  const c = await started(g);
  const res = await silentStripe(() => h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${c.exit.id}/let-out`, { reason: 'reader frozen' }));
  assert.equal(res.status, 200);
  h.stub.presentCard(c.intentId);
  const [x] = await rows(g, 'SELECT * FROM exceptions WHERE exit_id = $1', [c.exit.id]);
  return { ...c, x };
}
const afterLetOut = async (g, x) => (await (await h.call(g.op, 'GET', `/garages/${g.world.garage}/exceptions/${x.id}`)).json()).exception.payment_after_let_out?.status;

test('THE LANE FINDS IT FIRST: the charge found after a let-out is on the exception all the same', async () => {
  const g = await cardGarage(h, 'found-lane');
  const c = await letOutThenPaid(g);
  await caseOf(h, g, c.exit.id);
  assert.equal(await afterLetOut(g, c.x), 'succeeded');
});

test('THE CLOSE FINDS IT FIRST: the same', async () => {
  const g = await cardGarage(h, 'found-close');
  const c = await letOutThenPaid(g);
  const res = await close(h, g, c.exit.id);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(await afterLetOut(g, c.x), 'succeeded');
});

test('A LANE POLL REACHES A CLOSED CASE FIRST: written down once all the same, and counted for the alarm', async () => {
  const g = await cardGarage(h, 'found-closed');
  const since = new Date();
  assert.equal(await writtenDownSince(g.tenant, since), 0, 'control: nothing yet');
  const c = await paidAtTheReader(g);
  await withTenant(g.tenant, (cl) => cl.query(`UPDATE exits SET closed_at = now(), ended = $2 WHERE id = $1`,
    [c.exit.id, { why: 'stay_ended', by: 'user:someone', at: new Date().toISOString() }]));
  await caseOf(h, g, c.exit.id);
  assert.equal((await eventsOf(g, 'exit_payment_unplaced', c.exit.id)).length, 1);
  assert.equal(await writtenDownSince(g.tenant, since), 1);
  assert.equal(await writtenDownSince(g.tenant, new Date(Date.now() + 60_000)), 0, 'control: only since then');
});

test("THE SWEEP LANDS WHILE A LET-OUT'S CANCEL HANGS: the let-out's older copy does not cover what it found", async () => {
  const g = await cardGarage(h, 'found-overlap');
  const c = await started(g);
  const real = globalThis.fetch;
  let release;
  const gate = new Promise((r) => { release = r; });
  let reached;
  const atReader = new Promise((r) => { reached = r; });
  let silent = true;
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (!silent || !u.startsWith(h.stub.base)) return real(url, opts);
    if (u.includes('/terminal/readers/') && (opts?.method ?? 'GET') === 'GET') {
      reached();
      silent = false;
      return gate.then(() => Promise.reject(new TypeError('fetch failed')));
    }
    return Promise.reject(new TypeError('fetch failed'));
  };
  try {
    const letOut = h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${c.exit.id}/let-out`, { reason: 'reader frozen' });
    await Promise.race([atReader, letOut]);
    h.stub.presentCard(c.intentId);
    assert.equal((await sweep(g)).paid, 1);
    release();
    assert.equal((await letOut).status, 200);
  } finally {
    release();
    globalThis.fetch = real;
  }
  const [x] = await rows(g, 'SELECT * FROM exceptions WHERE exit_id = $1', [c.exit.id]);
  assert.equal(await afterLetOut(g, x), 'succeeded');
});

test('A FINAL ROW KEEPS WHAT IT SAYS: a read in hand from before does not wipe the mark', async () => {
  const g = await cardGarage(h, 'final-kept');
  const c = await started(g);
  const intent = {
    id: c.intentId, status: 'succeeded', amount: c.exit.fee.fee_minor, currency: 'usd', last_payment_error: null,
    latest_charge: { id: 'ch_x', created: 1700000000, amount_refunded: c.exit.fee.fee_minor },
  };
  await recordCaseIntent(g.tenant, g.world.garage, c.exit.id, intent);
  await recordCaseIntent(g.tenant, g.world.garage, c.exit.id, { ...intent, status: 'requires_payment_method', latest_charge: null });
  const p = await paymentOf(g, c.exit.id);
  assert.deepEqual([p.status, p.last_failure, p.stripe_status], ['canceled', 'refunded_before_recorded', 'succeeded']);
});

test('THREE SWEEPS AT ONCE over refunded charges keep every mark', async () => {
  const g = await cardGarage(h, 'final-race');
  const cars = [];
  for (let i = 0; i < 8; i += 1) cars.push(await refundedWhole(g));
  await Promise.all([sweep(g), sweep(g), sweep(g)]);
  for (const c of cars) assert.equal((await paymentOf(g, c.exit.id)).last_failure, 'refunded_before_recorded');
});

test('REFUNDED IN PART, FOUND AT A LET-OUT: the exception shows what was kept', async () => {
  const g = await cardGarage(h, 'part-let-out');
  const c = await paidAtTheReader(g);
  h.stub.refund(c.intentId, 100);
  assert.equal((await h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${c.exit.id}/let-out`, { reason: 'gate jammed' })).status, 200);
  const [x] = await rows(g, 'SELECT * FROM exceptions WHERE exit_id = $1', [c.exit.id]);
  assert.deepEqual([x.owed_minor, x.paid_minor], [0, c.exit.fee.fee_minor - 100]);
});

test('A PART REFUND ON A CLOSED CASE is written down once, naming both', async () => {
  const g = await cardGarage(h, 'part-closed');
  const c = await paidAtTheReader(g);
  h.stub.refund(c.intentId, 100);
  await withTenant(g.tenant, (cl) => cl.query(`UPDATE exits SET closed_at = now(), ended = $2 WHERE id = $1`,
    [c.exit.id, { why: 'stay_ended', by: 'user:someone', at: new Date().toISOString() }]));
  assert.equal((await sweep(g)).unplaced, 1);
  const [e] = await eventsOf(g, 'exit_payment_unplaced', c.exit.id);
  assert.deepEqual([e.detail.why, e.detail.also], ['part_refunded_before_recorded', 'case_closed']);
});

test('ONE RUN AT A TIME: a run finding another at work stops, and the lock is free after', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  let inside;
  const entered = new Promise((r) => { inside = r; });
  const first = whileHoldingSweepLock(async () => { inside(); await held; return 'first'; });
  await entered;
  let second;
  try {
    second = await whileHoldingSweepLock(async () => 'second');
  } finally {
    release();
  }
  assert.deepEqual(second, { ran: false });
  assert.deepEqual(await first, { ran: true, value: 'first' });
  assert.deepEqual(await whileHoldingSweepLock(async () => 'third'), { ran: true, value: 'third' }, 'control: free again');
});

test('A RUN PAST ITS DEADLINE reads no more; the next reads them', async () => {
  const g = await cardGarage(h, 'sweep-deadline');
  const c = await paidAtTheReader(g);
  const from = h.stub.requests.length;
  assert.equal((await sweep(g, { deadline: Date.now() - 1 })).paid, 0);
  assert.deepEqual(stripeReads(from), []);
  assert.equal((await sweep(g)).paid, 1, 'control: the next run');
  assert.equal((await paymentOf(g, c.exit.id)).status, 'succeeded');
});

