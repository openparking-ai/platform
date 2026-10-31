/**
 * THE EXIT'S RULES (the owner's, 2026-10-30/31; 0048).
 *
 * What this file measures, each with a break in
 * `scripts/exit-rules-fail-control.js`:
 *
 *   * PAID AND LEFT: a car that paid and backed out before the closing loop
 *     is the same stay. Each time it comes back the WHOLE stay is priced
 *     again, what the stay paid is credited and only the difference asked --
 *     never negative, never what it paid again; the stay closes at its whole
 *     price, the parts adding up to it;
 *   * NEVER CHARGED TWICE, at the database: a payment is exactly what its case
 *     asks for; what a stay paid and is paying never adds up to more than
 *     its case's whole fee; one open payment per stay;
 *   * a car let out owing the difference is let out unpaid owing it, with
 *     what it had paid beside it; a person's end takes off everything the
 *     stay paid at any of its cases;
 *   * A RETURN IS A NEW STAY: a car whose stay reached an exit is never
 *     folded back into it, however soon it comes in; the old stay is closed
 *     completely -- its open case closed, its unpaid payment canceled at
 *     Stripe first, a paid one kept paid on the old stay -- and the new stay
 *     carries no time, fee, payment or case; Stripe unable to settle the old
 *     payment is a 503 with nothing written; a re-approach at the entry is
 *     still one arrival;
 *   * THE END READS FIRST: a refused `left_at`, or a rate engine that cannot
 *     answer, fails a person's end with the stay's payment untouched at
 *     Stripe.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, withTenant } from './helpers.js';
import {
  startHarness, cardGarage, enter, caseAt, pay, caseOf, payAndPresent, close, row, rows, ago, plateNo,
} from './exit-harness.js';

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.stop();
  await pool.end();
});

const intentOf = (exit) => h.stub.intents.get(exit.payment.payment_intent_id);
const cancelCalls = (intentId) => h.stub.requests.filter((r) => r.method === 'POST' && r.path === `/v1/payment_intents/${intentId}/cancel`);
const paymentsOfStay = (g, sessionId) => rows(g,
  'SELECT exit_id, amount_minor, status FROM exit_payments WHERE session_id = $1 ORDER BY created_at, id', [sessionId]);

// ---------------------------------------------------------------------------
// Paid and left.
// ---------------------------------------------------------------------------

test('PAID AND LEFT, again and again: each return prices the whole stay, credits every payment and asks the difference -- 250, 250, 250: 750 in all, never more', async () => {
  const g = await cardGarage(h, 'rules-three-parts');
  const { plate } = await enter(h, g, { inMin: 150 });
  // At the barrier after 25 minutes: one hour. Paid; backed out.
  const first = await caseAt(h, g, plate, { exitMin: 125 });
  assert.deepEqual([first.fee.fee_minor, first.fee.stay_fee_minor, first.fee.credit_minor], [250, 250, 0]);
  await payAndPresent(h, g, first.id);
  // After 85 minutes: two hours, 250 paid -- 250 asked. Paid; backed out again.
  const second = await caseAt(h, g, plate, { exitMin: 65 });
  assert.deepEqual([second.needs, second.fee.fee_minor, second.fee.stay_fee_minor, second.fee.credit_minor], ['payment', 250, 500, 250]);
  const secondPaid = await payAndPresent(h, g, second.id);
  assert.equal(h.stub.intents.get(secondPaid.payment.payment_intent_id).amount, 250);
  // After 149 minutes: three hours, 500 paid -- 250 asked.
  const third = await caseAt(h, g, plate);
  assert.deepEqual([third.needs, third.fee.fee_minor, third.fee.stay_fee_minor, third.fee.credit_minor], ['payment', 250, 750, 500]);
  const thirdPaid = await payAndPresent(h, g, third.id);
  assert.equal(h.stub.intents.get(thirdPaid.payment.payment_intent_id).amount, 250);
  const closed = await close(h, g, third.id);
  assert.equal(closed.status, 200, await closed.clone().text());
  const stay = await row(g, 'sessions', first.session_id);
  assert.equal(Number(stay.fee_minor), 750, 'the stay at its whole price');
  assert.deepEqual((await paymentsOfStay(g, first.session_id)).map((p) => [p.exit_id, Number(p.amount_minor), p.status]),
    [[first.id, 250, 'succeeded'], [second.id, 250, 'succeeded'], [third.id, 250, 'succeeded']], 'three parts adding up to the stay, each once');
});

test('NEVER NEGATIVE: a stay priced again at less than it paid asks nothing, and keeps the figures it paid', async () => {
  const g = await cardGarage(h, 'rules-not-higher');
  const { plate } = await enter(h, g, { inMin: 150 });
  const first = await caseAt(h, g, plate, { exitMin: 0.5 });
  assert.equal(first.fee.fee_minor, 750);
  await payAndPresent(h, g, first.id);
  // The other lane's clock is behind: its case says the car was there 50
  // minutes ago, and the whole stay prices at 500 -- less than the 750 paid.
  // Nothing more is asked, never a negative figure.
  const second = await caseAt(h, g, plate, { exitMin: 50 });
  assert.deepEqual([second.settled, second.why, second.fee.fee_minor, second.fee.stay_fee_minor, second.fee.credit_minor], [true, 'paid', 0, 750, 750]);
  const q = (await row(g, 'exits', second.id)).quote;
  assert.deepEqual([q.fee_minor, q.due_minor, q.repriced.fee_minor, q.credit.paid_minor], [750, 0, 500, 750], 'the price asked again is kept beside what was paid');
  const closed = await close(h, g, second.id);
  assert.equal(closed.status, 200, await closed.clone().text());
  assert.equal(Number((await row(g, 'sessions', first.session_id)).fee_minor), 750, 'the stay at what it paid');
});

test('NEVER CHARGED TWICE, AT THE DATABASE: a payment is exactly what its case asks for; what a stay paid never adds up to more than its fee; one open payment per stay', async () => {
  const g = await cardGarage(h, 'rules-db');
  const { plate } = await enter(h, g, { inMin: 90 });
  const first = await caseAt(h, g, plate, { exitMin: 35 });
  await payAndPresent(h, g, first.id);
  const second = await caseAt(h, g, plate);
  assert.equal(second.fee.fee_minor, 250);
  const insert = (exitId, amount, intent = `pi_db${randomUUID().replace(/-/g, '')}`) => withTenant(g.tenant, (c) => c.query(
    `INSERT INTO exit_payments (tenant_id, garage_id, exit_id, session_id, channel, account_id, payment_intent_id, amount_minor, currency, started_by)
     VALUES ($1, $2, $3, $4, 'phone_reader', $5, $6, $7, 'usd', 'test')`,
    [g.tenant, g.world.garage, exitId, second.session_id, g.account, intent, amount]));

  await assert.rejects(insert(second.id, 500), /exit_payments_is_the_due|exactly what its case asks for/, 'the whole price again is refused');
  // A case priced before the stay's payment succeeded -- it asks the whole
  // price -- may not take it: the stay would pay 750 for 500.
  await withTenant(g.tenant, (c) => c.query(`UPDATE exits SET quote = quote || '{"due_minor": 500}'::jsonb WHERE id = $1`, [second.id]));
  await assert.rejects(insert(second.id, 500), /exit_payments_within_stay_fee|never adds up to more/);
  await withTenant(g.tenant, (c) => c.query(`UPDATE exits SET quote = quote || '{"due_minor": 250}'::jsonb WHERE id = $1`, [second.id]));
  await insert(second.id, 250);
  // A second open payment for the stay, whichever case: refused.
  const other = await withTenant(g.tenant, async (c) => (await c.query(
    `INSERT INTO exits (tenant_id, garage_id, lane_id, event_id, exit_at, method, session_id, quote, closed_at, ended)
     VALUES ($1, $2, $3, $4, now(), 'lane', $5, $6, now(), $7) RETURNING id`,
    [g.tenant, g.world.garage, g.world.exitLane, `db${randomUUID().replace(/-/g, '').slice(0, 20)}`, second.session_id,
      JSON.stringify({ outcome: 'transient', fee_minor: 750, due_minor: 250, currency: 'USD' }),
      JSON.stringify({ why: 'superseded', at: new Date().toISOString(), by_exit: second.id })])).rows[0].id);
  await assert.rejects(insert(other, 250), /exit_payments_one_open_per_stay/);
});

test('A CAR LET OUT OWING THE DIFFERENCE is let out unpaid owing the difference, with what it had paid beside it', async () => {
  const g = await cardGarage(h, 'rules-let-out-diff');
  const { plate } = await enter(h, g, { inMin: 90 });
  const first = await caseAt(h, g, plate, { exitMin: 35 });
  await payAndPresent(h, g, first.id);
  const second = await caseAt(h, g, plate);
  const res = await close(h, g, second.id, { let_out_by: 'human_open_now' });
  assert.equal(res.status, 200, await res.clone().text());
  const { session } = await res.json();
  assert.deepEqual([session.fee_minor, session.let_out.owed_minor, session.let_out.paid_minor], [null, 250, 250]);
});

test("A PERSON'S END after paying at a superseded case: the stay owes its price less everything it paid, at any of its cases", async () => {
  const g = await cardGarage(h, 'rules-end-sum');
  const { plate } = await enter(h, g, { inMin: 90 });
  const first = await caseAt(h, g, plate, { exitMin: 35 });
  await payAndPresent(h, g, first.id);
  const second = await caseAt(h, g, plate);
  const started = await pay(h, g, second.id);
  const res = await h.call(g.op, 'POST', `/garages/${g.world.garage}/stays/${second.session_id}/end`, { outcome: 'ended', reason: 'seen leaving' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(intentOf(started).status, 'canceled', 'the difference not yet paid is canceled');
  const stay = await row(g, 'sessions', second.session_id);
  assert.deepEqual([stay.ended.owed.fee_minor, stay.ended.paid.amount_minor, stay.ended.paid.exit_id], [500, 250, first.id]);
  assert.equal((await res.json()).stay.owed_minor, 250, '500 less the 250 paid at the first case');
});

// ---------------------------------------------------------------------------
// A return is a new stay.
// ---------------------------------------------------------------------------

test('A RETURN AFTER AN EXIT IS A NEW STAY, however soon: the old stay ends, its open case closes with its unpaid payment canceled at Stripe first, and nothing carries over', async () => {
  const g = await cardGarage(h, 'rules-return');
  // In 8 minutes ago; at the exit 5 minutes ago; the payment waits on the
  // reader; the car goes out without paying (the gate was up).
  const { plate, res: opened } = await enter(h, g, { inMin: 8 });
  const old = await caseAt(h, g, plate, { exitMin: 5 });
  const started = await pay(h, g, old.id);
  assert.equal(h.stub.terminal.find((t) => t.id === g.readerId).action?.process_payment_intent?.payment_intent, started.payment.payment_intent_id);

  // Back in 3 minutes ago: inside REAPPROACH_MINUTES of the first entry, but
  // the car had been at an exit -- a new stay.
  const { res: again } = await enter(h, g, { plate, inMin: 3 });
  assert.equal(again.created, true);
  assert.notEqual(again.session.id, opened.session.id);
  assert.equal(intentOf(started).status, 'canceled', 'the unpaid payment canceled at Stripe');
  assert.equal(h.stub.terminal.find((t) => t.id === g.readerId).action, null, 'and cleared from the reader');
  const oldStay = await row(g, 'sessions', opened.session.id);
  assert.deepEqual([oldStay.ended.reason, oldStay.ended.by_session, oldStay.ended.exit_cases, oldStay.ended.paid],
    ['superseded', again.session.id, [old.id], undefined]);
  const oldCase = await row(g, 'exits', old.id);
  assert.deepEqual([Boolean(oldCase.closed_at), oldCase.close_event_id, oldCase.ended.why, oldCase.ended.by, oldCase.ended.by_session],
    [true, null, 'stay_ended', `lane_device:${g.entryDeviceId}`, again.session.id]);
  const told = await rows(g, `SELECT detail FROM events WHERE kind = 'exit_stay_reentered'`);
  assert.deepEqual(told.map((e) => [e.detail.exit_id, e.detail.by_session]), [[old.id, again.session.id]]);
  const lines = await rows(g, `SELECT actor_kind, actor_id, after FROM garage_changes WHERE action = 'exit.closed_on_return' AND subject_id = $1`, [old.id]);
  assert.deepEqual(lines.map((l) => [l.actor_kind, l.actor_id, l.after.stay_id, l.after.payment]), [['computer', g.entryDeviceId, opened.session.id, 'canceled']]);
  assert.ok(!JSON.stringify(lines).includes(plate), 'no plate in the change log');

  // The new stay's exit: its own time from its own entry, no payment, no case carried.
  const fresh = await caseAt(h, g, plate);
  assert.equal(fresh.session_id, again.session.id);
  assert.deepEqual([fresh.needs, fresh.fee.fee_minor, fresh.fee.credit_minor, fresh.payment], ['payment', 250, 0, null]);
  assert.equal((await caseOf(h, g, old.id)).closed, true);
});

test('THE PAID ONE STAYS PAID ON THE OLD STAY: a car that paid, backed out and came back in later is a new stay, owing its own time; nothing it paid moves', async () => {
  const g = await cardGarage(h, 'rules-return-paid');
  const { plate, res: opened } = await enter(h, g, { inMin: 120 });
  const old = await caseAt(h, g, plate, { exitMin: 100 });
  const started = await payAndPresent(h, g, old.id);
  const { res: again } = await enter(h, g, { plate, inMin: 30 });
  assert.equal(again.created, true);
  assert.equal(cancelCalls(started.payment.payment_intent_id).length, 0, 'a paid intent is never asked to cancel');
  const oldStay = await row(g, 'sessions', opened.session.id);
  assert.deepEqual(oldStay.ended.paid, { exit_id: old.id, amount_minor: 250, currency: 'usd' });
  assert.deepEqual((await paymentsOfStay(g, opened.session.id)).map((p) => [Number(p.amount_minor), p.status]), [[250, 'succeeded']]);
  const fresh = await caseAt(h, g, plate);
  assert.equal(fresh.session_id, again.session.id);
  assert.deepEqual([fresh.settled, fresh.needs, fresh.fee.fee_minor, fresh.fee.credit_minor, fresh.paid_at_exit], [false, 'payment', 250, 0, null],
    'its own 30 minutes, nothing credited from the stay before');
});

test('A RE-APPROACH AT THE ENTRY IS STILL ONE ARRIVAL: with no exit between, the second open answers the first stay', async () => {
  const g = await cardGarage(h, 'rules-reapproach');
  const { plate, res: opened } = await enter(h, g, { inMin: 6 });
  const { res: again } = await enter(h, g, { plate, inMin: 4, status: 200 });
  assert.deepEqual([again.created, again.session.id], [false, opened.session.id]);
});

test('A RETURN WHOSE OLD PAYMENT STRIPE CANNOT SETTLE NOW: 503 and nothing written; sent again, the new stay opens with one cancel', async () => {
  const g = await cardGarage(h, 'rules-return-unsettled');
  const { plate, res: opened } = await enter(h, g, { inMin: 60 });
  const old = await caseAt(h, g, plate, { exitMin: 30 });
  const started = await pay(h, g, old.id);
  const eventId = randomUUID();
  h.stub.behaviour.readerBusyNextClear = true;
  const busy = await h.call(g.entry, 'POST', '/lane/sessions/open', {
    event_id: eventId, plate, entry_at: ago(5), entry_confirmation: 'confirmed', plate_characters: { state: 'read', rule: 'opvid-plate-chars/1', pattern: plate },
  });
  assert.deepEqual([busy.status, (await busy.json()).code], [503, 'payment_unsettled']);
  assert.equal(intentOf(started).status, 'requires_payment_method');
  assert.equal((await row(g, 'sessions', opened.session.id)).exit_at, null, 'the old stay stays open');
  assert.equal((await rows(g, 'SELECT 1 FROM sessions WHERE open_event_id = $1', [eventId])).length, 0, 'no stay written');
  const { res: again } = await enter(h, g, { plate, inMin: 5, eventId });
  assert.equal(again.created, true);
  assert.equal(h.stub.cancels.filter((id) => id === started.payment.payment_intent_id).length, 1, 'one cancel at Stripe');
});

// ---------------------------------------------------------------------------
// A person's end: the reads first.
// ---------------------------------------------------------------------------

test("THE END READS FIRST: a refused left_at, or a rate engine that cannot answer, fails the end with the stay's payment untouched at Stripe", async () => {
  const g = await cardGarage(h, 'rules-end-order');
  const { plate } = await enter(h, g, { inMin: 90, plate: plateNo('END') });
  const exit = await caseAt(h, g, plate);
  const started = await pay(h, g, exit.id);
  const intent = started.payment.payment_intent_id;
  const end = (body) => h.call(g.op, 'POST', `/garages/${g.world.garage}/stays/${exit.session_id}/end`, body);

  const early = await end({ outcome: 'ended', reason: 'seen leaving', left_at: ago(200) });
  assert.deepEqual([early.status, (await early.json()).code], [400, 'left_at_before_entry']);
  const later = await end({ outcome: 'ended', reason: 'seen leaving', left_at: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(later.status, 409, await later.clone().text());
  assert.equal(h.stub.intents.get(intent).status, 'requires_payment_method');
  assert.equal(cancelCalls(intent).length, 0, 'nothing asked of Stripe for a refused end');

  const url = process.env.RATE_ENGINE_URL;
  process.env.RATE_ENGINE_URL = 'http://127.0.0.1:9';
  try {
    const down = await end({ outcome: 'ended', reason: 'seen leaving' });
    assert.ok(down.status >= 500, `the engine down fails the end (${down.status})`);
  } finally {
    process.env.RATE_ENGINE_URL = url;
  }
  assert.equal(h.stub.intents.get(intent).status, 'requires_payment_method', 'the payment untouched while the stay could not be priced');
  assert.equal(cancelCalls(intent).length, 0);
  assert.equal((await row(g, 'exit_payments', (await rows(g, 'SELECT id FROM exit_payments WHERE exit_id = $1', [exit.id]))[0].id)).status, 'open');

  const ok = await end({ outcome: 'ended', reason: 'seen leaving' });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(h.stub.intents.get(intent).status, 'canceled', 'then canceled, and the stay ended');
});

// ---------------------------------------------------------------------------
// A close that arrives after the car came back in.
// ---------------------------------------------------------------------------

test('A CLOSE AFTER THE CAR CAME BACK IN, PAID: the old stay closes at the time the lane sent, at what it paid; a resend is the same close; the new stay is untouched', async () => {
  const g = await cardGarage(h, 'rules-late-paid');
  const { plate, res: opened } = await enter(h, g, { inMin: 60 });
  const old = await caseAt(h, g, plate, { exitMin: 40 });
  await payAndPresent(h, g, old.id);
  // The exit lane is offline: the car crossed at 39 minutes ago, the close waits in its outbox.
  const { res: again } = await enter(h, g, { plate, inMin: 10 });
  assert.equal((await row(g, 'sessions', opened.session.id)).ended.reason, 'superseded');
  const eventId = randomUUID();
  const sent = ago(39);
  const late = () => h.call(g.exit, 'POST', '/lane/sessions/close', { event_id: eventId, exit_id: old.id, exit_at: sent, exit_confirmation: 'confirmed' });
  const res = await late();
  assert.equal(res.status, 200, await res.clone().text());
  const stay = await row(g, 'sessions', opened.session.id);
  assert.deepEqual([stay.ended, Number(stay.fee_minor), stay.exit_at.toISOString(), stay.let_out, stay.close_event_id],
    [null, 250, new Date(sent).toISOString(), null, eventId], 'closed at its real exit, at what it paid');
  const told = await rows(g, `SELECT detail FROM events WHERE kind = 'ended_stay_closed' AND detail->>'session_id' = $1`, [opened.session.id]);
  assert.equal(told.length, 1);
  const again2 = await late();
  assert.deepEqual([again2.status, (await again2.json()).replay], [200, true], 'a resend is the same close');
  const other = await h.call(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: old.id, exit_at: ago(38), exit_confirmation: 'confirmed' });
  assert.deepEqual([other.status, (await other.json()).code], [409, 'exit_closed'], 'a second close of it is refused');
  assert.equal((await row(g, 'sessions', again.session.id)).exit_at, null, 'the stay the car is in now stays open');
});

test('A CLOSE AFTER THE CAR CAME BACK IN, A PERSON OPENED: the old stay is let out unpaid, owing, with its exception -- once; never after the return', async () => {
  const g = await cardGarage(h, 'rules-late-letout');
  const { plate, res: opened } = await enter(h, g, { inMin: 60 });
  const old = await caseAt(h, g, plate, { exitMin: 40 });
  const started = await pay(h, g, old.id);
  const { res: again } = await enter(h, g, { plate, inMin: 10 });
  assert.equal(intentOf(started).status, 'canceled');
  const eventId = randomUUID();
  // The lane's clock is ahead: it says the car left after it came back in.
  const send = () => h.call(g.exit, 'POST', '/lane/sessions/close', {
    event_id: eventId, exit_id: old.id, exit_at: ago(5), exit_confirmation: 'confirmed', let_out_by: 'human_open_now',
  });
  const res = await send();
  assert.equal(res.status, 200, await res.clone().text());
  const stay = await row(g, 'sessions', opened.session.id);
  assert.deepEqual([stay.fee_minor, stay.let_out.owed_minor, stay.let_out.by], [null, 250, `lane_device:${g.exitDeviceId}`]);
  assert.equal(stay.exit_at.getTime(), (await row(g, 'sessions', again.session.id)).entry_at.getTime(), 'never after the car came back in');
  await (await import('../src/exceptions.js')).copiesSettled();
  const x = await rows(g, 'SELECT kind, source, authority, owed_minor, session_id FROM exceptions WHERE exit_id = $1', [old.id]);
  assert.deepEqual(x, [{ kind: 'let_out_unpaid', source: 'lane', authority: 'human_open_now', owed_minor: 250, session_id: opened.session.id }]);
  assert.equal((await send()).status, 200);
  assert.equal((await rows(g, 'SELECT 1 FROM exceptions WHERE exit_id = $1', [old.id])).length, 1, 'once');
});

// ---------------------------------------------------------------------------
// A refund is not paid.
// ---------------------------------------------------------------------------

test("A REFUND IS NOT PAID: a refund made at Stripe's dashboard is read when the stay is priced again, and only what the payment kept is credited", async () => {
  const g = await cardGarage(h, 'rules-refund');
  const { plate } = await enter(h, g, { inMin: 90 });
  const first = await caseAt(h, g, plate, { exitMin: 1 });
  const paid = await payAndPresent(h, g, first.id);
  h.stub.refund(paid.payment.payment_intent_id, 200);
  const second = await caseAt(h, g, plate);
  assert.deepEqual([second.needs, second.fee.fee_minor, second.fee.stay_fee_minor, second.fee.credit_minor], ['payment', 200, 500, 300],
    '500 paid, 200 of it refunded: 300 kept, 200 asked');
  const recorded = (await rows(g, 'SELECT refunded_minor, refunds_read_at FROM exit_payments WHERE exit_id = $1', [first.id]))[0];
  assert.deepEqual([recorded.refunded_minor, Boolean(recorded.refunds_read_at)], [200, true], 'kept on the payment');
  const diff = await payAndPresent(h, g, second.id);
  assert.equal(h.stub.intents.get(diff.payment.payment_intent_id).amount, 200);
  assert.equal((await close(h, g, second.id)).status, 200);
});

test('REFUNDS UNREAD: Stripe not answering for refunds holds no exit up -- the payment is credited as last read, and the case says so', async () => {
  const g = await cardGarage(h, 'rules-refund-unread');
  const { plate } = await enter(h, g, { inMin: 90 });
  const first = await caseAt(h, g, plate, { exitMin: 1 });
  const paid = await payAndPresent(h, g, first.id);
  h.stub.refund(paid.payment.payment_intent_id, 500);
  h.stub.behaviour.failNext = { status: 500, type: 'api_error', code: 'api_error', message: 'down', path: /latest_charge/ };
  const second = await caseAt(h, g, plate);
  assert.deepEqual([second.settled, second.fee.credit_minor], [true, 500]);
  const q = (await row(g, 'exits', second.id)).quote;
  assert.deepEqual(q.credit.refunds_unread, [(await rows(g, 'SELECT id FROM exit_payments WHERE exit_id = $1', [first.id]))[0].id]);
  // Asked again once Stripe answers: the refund counts.
  const third = await caseAt(h, g, plate);
  assert.deepEqual([third.needs, third.fee.fee_minor, third.fee.credit_minor], ['payment', 500, 0]);
});
