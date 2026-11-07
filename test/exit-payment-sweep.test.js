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
 *   * a charge refunded first is not paid, at any later read; another amount is
 *     not paid; each written down once;
 *   * a car that paid and is let out is not written as let out unpaid;
 *   * the paid date is Stripe's when the read carries it, the clock otherwise;
 *   * every row gets its turn, and Stripe's errors stop nothing.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant } from './helpers.js';
import {
  sweepOpenPayments, MIN_AGE_MS, OLD_EVERY_MS, RECENT_MS,
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

test('REFUNDED FIRST: not paid, at any later read, written down once; the case still owes', async () => {
  const g = await cardGarage(h, 'sweep-refunded');
  const { exit, intentId } = await started(g);
  h.stub.presentCard(intentId);
  h.stub.refund(intentId, exit.fee.fee_minor);

  assert.deepEqual(await sweep(g), { due: 1, paid: 0, unplaced: 1, failed: 0 });
  const p = await paymentOf(g, exit.id);
  assert.deepEqual([p.status, p.last_failure, p.succeeded_at], ['open', 'refunded_before_recorded', null]);
  assert.deepEqual(await eventsOf(g, 'exit_paid', exit.id), []);
  const noted = await eventsOf(g, 'exit_payment_unplaced', exit.id);
  assert.deepEqual([noted.length, noted[0].detail.why], [1, 'refunded_before_recorded']);

  assert.deepEqual(await sweep(g), { due: 1, paid: 0, unplaced: 0, failed: 0 }, 'asked again, written once');
  assert.equal((await eventsOf(g, 'exit_payment_unplaced', exit.id)).length, 1);

  // The lane's poll reads no charge: what the sweep learned holds.
  const polled = await caseOf(h, g, exit.id);
  assert.deepEqual([polled.settled, polled.needs, polled.payment.status], [false, 'payment', 'open']);
  assert.deepEqual(await eventsOf(g, 'exit_paid', exit.id), []);
  assert.equal(h.stub.cancels.includes(intentId), false);
});

test('PART REFUNDED FIRST is not paid either: a person decides', async () => {
  const g = await cardGarage(h, 'sweep-part');
  const { exit, intentId } = await started(g);
  h.stub.presentCard(intentId);
  h.stub.refund(intentId, 1);
  assert.deepEqual(await sweep(g), { due: 1, paid: 0, unplaced: 1, failed: 0 });
  assert.equal((await paymentOf(g, exit.id)).status, 'open');
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
