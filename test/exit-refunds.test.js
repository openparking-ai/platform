/**
 * A refund made at Stripe reaches the records (src/exitRefunds.js, 0051).
 *
 * Held here: the door is off with no secret, and nothing but Stripe's signature
 * over the bytes sent gets through it; a car that paid and left has its refund
 * recorded, dated by the event, and its numbers show it; an event counts once;
 * a failed refund is a reversal; the total is Stripe's now, not the event's;
 * `refunded_minor` follows, for the exit's credit; what is not ours is answered
 * 200 and touches nothing; what is not settled yet is answered 503; and the
 * ledger is append-only and of its own account's payments.
 *
 * `npm run garage-snapshot-fail-control` breaks each in turn.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { EVENTS_AT_ONCE, TOLERANCE_SECONDS } from '../src/exitRefunds.js';
import { startStripeStub } from './stripe-stub.js';

const SECRET = 'whsec_fakesigningsecret';
const KEY = 'sk_test_fake';
const PATH = '/api/v1/stripe/webhook';
// 15:00 on 10 September 2026 in New York.
const REFUNDED_AT = Date.parse('2026-09-10T19:00:00Z') / 1000;

let server;
let base;
let stub;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const signature = (raw, { secret = SECRET, t = nowSeconds() } = {}) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
const send = (raw, header = signature(raw)) => fetch(`${base}${PATH}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(header ? { 'stripe-signature': header } : {}) },
  body: raw,
}).then(async (r) => ({ status: r.status, text: await r.text(), retryAfter: r.headers.get('retry-after') }));

const evt = () => `evt_fake${randomUUID().replaceAll('-', '')}`;
const refundEvent = (w, { id = evt(), type = 'charge.refunded', account = w.account, intent = w.intent, created = REFUNDED_AT } = {}) => JSON.stringify({
  id, type, created, account, object: 'event', data: { object: { id: 'ch_fake', object: 'charge', payment_intent: intent } },
});

/** One more garage of an account, for its same car. */
const secondGarage = (w) => withTenant(w.tenantId, async (c) => {
  const garage = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Second','America/New_York','USD') RETURNING id`, [w.tenantId])).rows[0].id;
  const lane = async (name, direction) => (await c.query('INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id', [w.tenantId, garage, name, direction])).rows[0].id;
  return { garage, vehicle: w.vehicle, entryLane: await lane('Entry 2', 'entry'), exitLane: await lane('Exit 2', 'exit') };
});

/** A garage on its own Stripe account, with a car that paid `amount` and left. */
async function paidAndLeft(tag, { amount = 1250, status = 'succeeded', beside = null } = {}) {
  const tenant = beside?.tenantId ?? await createTenant(tag);
  const world = beside ? await secondGarage(beside) : await buildWorld(tenant);
  const account = `acct_stub${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const intent = `pi_stub${randomUUID().replaceAll('-', '')}`;
  const key = generateDeviceToken();
  const stay = randomUUID();
  const payment = await withTenant(tenant, async (c) => {
    await c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(key)]);
    await c.query(
      `INSERT INTO garage_stripe_accounts (tenant_id, garage_id, create_idempotency_key, create_requested_by, account_id, account_recorded_at)
       VALUES ($1,$2,$3,'test',$4,now())`,
      [tenant, world.garage, `k-${world.garage}`, account],
    );
    await c.query(
      `INSERT INTO sessions (id, tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, open_event_id, currency, entry_confirmation)
       VALUES ($1,$2,$3,$4,$5,'2026-09-08T13:00:00Z',$6,'USD','confirmed')`,
      [stay, tenant, world.garage, world.vehicle, world.entryLane, `open-${stay}`],
    );
    const exit = (await c.query(
      `INSERT INTO exits (tenant_id, garage_id, lane_id, event_id, exit_at, method, session_id, quote)
       VALUES ($1,$2,$3,$4,'2026-09-08T14:00:00Z','single',$5,$6) RETURNING id`,
      [tenant, world.garage, world.exitLane, `case-${stay}`, stay, JSON.stringify({ outcome: 'transient', fee_minor: amount, currency: 'USD' })],
    )).rows[0].id;
    const id = (await c.query(
      `INSERT INTO exit_payments (tenant_id, garage_id, exit_id, session_id, channel, account_id, payment_intent_id, amount_minor, currency, started_by)
       VALUES ($1,$2,$3,$4,'phone_reader',$5,$6,$7,'usd','test') RETURNING id`,
      [tenant, world.garage, exit, stay, account, intent, amount],
    )).rows[0].id;
    if (status === 'succeeded') {
      await c.query(`UPDATE exit_payments SET status = 'succeeded', succeeded_at = '2026-09-08T13:59:00Z' WHERE id = $1`, [id]);
    } else if (status === 'canceled') {
      await c.query(`UPDATE exit_payments SET status = 'canceled', canceled_at = '2026-09-08T13:59:00Z' WHERE id = $1`, [id]);
    }
    await c.query(
      `UPDATE sessions SET exit_at = '2026-09-08T14:00:00Z', exit_lane_id = $2, close_event_id = $3, exit_confirmation = 'confirmed',
                           hourly_minor_applied = 250, fee_minor = $4 WHERE id = $1`,
      [stay, world.exitLane, `close-${stay}`, amount],
    );
    return id;
  });
  stub.paidIntent(intent, account, amount);
  return { ...world, tenantId: tenant, account, intent, payment, key };
}

const ledger = (w) => withTenant(w.tenantId, async (c) => (await c.query(
  'SELECT kind, amount_minor, refunded_total, currency, stripe_event_id, refunded_at FROM exit_refunds WHERE exit_payment_id = $1 ORDER BY recorded_at, id', [w.payment],
)).rows);
const onPayment = (w) => withTenant(w.tenantId, async (c) => (await c.query('SELECT refunded_minor, refunds_read_at FROM exit_payments WHERE id = $1', [w.payment])).rows[0]);
const snapshot = (w, from, to) => fetch(`${base}/api/v1/garages/${w.garage}/snapshot?from=${from}&to=${to}`, { headers: { authorization: `Bearer ${w.key}` } }).then((r) => r.json());

before(async () => {
  stub = await startStripeStub();
  process.env.STRIPE_API_KEY = KEY;
  process.env.STRIPE_API_BASE = stub.base;
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const k of ['STRIPE_API_KEY', 'STRIPE_API_BASE', 'STRIPE_WEBHOOK_SECRET']) delete process.env[k];
  await new Promise((r) => server.close(r));
  await stub.close();
  await pool.end();
});

test('NO SECRET, NO DOOR: the path answers as one that does not exist, and nothing is read or written', async () => {
  const w = await paidAndLeft('wh-off');
  stub.setRefunded(w.intent, 100);
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    const raw = refundEvent(w);
    const r = await send(raw);
    const none = await fetch(`${base}/api/v1/stripe/nothing-here`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 401);
    assert.equal(none.status, 401);
    assert.deepEqual(await ledger(w), []);
  } finally {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  }
});

test("ONLY STRIPE'S SIGNATURE OVER THE BYTES SENT: anything else is 400 and nothing happens", async () => {
  const w = await paidAndLeft('wh-signature');
  stub.setRefunded(w.intent, 500);
  const raw = refundEvent(w);
  const old = nowSeconds() - TOLERANCE_SECONDS - 5;
  const ahead = nowSeconds() + TOLERANCE_SECONDS + 5;
  for (const [what, header] of [
    ['none', null],
    ['another secret', signature(raw, { secret: 'whsec_fakeanothersecret' })],
    ['too old', signature(raw, { t: old })],
    ['from the future', signature(raw, { t: ahead })],
    ['not hex', `t=${nowSeconds()},v1=zz`],
    ['no v1', `t=${nowSeconds()}`],
    ['no time', 'v1=00'],
    ['the wrong scheme', signature(raw).replace('v1=', 'v0=')],
  ]) {
    const r = await send(raw, header);
    assert.equal(r.status, 400, what);
    assert.match(r.text, /signature_refused/, what);
  }
  // A signature over other bytes: the same event, one figure changed.
  const r = await send(raw.replace('1250', '1251').replace(w.intent, `${w.intent}x`), signature(raw));
  assert.equal(r.status, 400);
  assert.deepEqual(await ledger(w), []);
  assert.equal((await onPayment(w)).refunded_minor, 0);
});

test('THE BYTES AS SENT ARE WHAT IS SIGNED: the same event with other spacing is taken under its own signature', async () => {
  const w = await paidAndLeft('wh-raw');
  stub.setRefunded(w.intent, 100);
  const raw = `  ${JSON.stringify(JSON.parse(refundEvent(w)), null, 3)}\n`;
  const r = await send(raw);
  assert.equal(r.status, 200, r.text);
  assert.equal((await ledger(w)).length, 1);
});

test('PAID, LEFT, REFUNDED THE NEXT DAYS: recorded on the day Stripe reported it, on the payment and in the numbers', async () => {
  const w = await paidAndLeft('wh-refund');
  stub.setRefunded(w.intent, 500);
  const id = evt();
  const r = await send(refundEvent(w, { id }));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(r.text), { received: true });

  const rows = await ledger(w);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].kind, rows[0].amount_minor, rows[0].refunded_total, rows[0].currency, rows[0].stripe_event_id, rows[0].refunded_at.toISOString()],
    ['refund', 500, 500, 'usd', id, '2026-09-10T19:00:00.000Z'],
  );
  const kept = await onPayment(w);
  assert.equal(kept.refunded_minor, 500, 'what the exit credits from');
  assert.ok(kept.refunds_read_at);

  const asked = stub.requests.filter((q) => q.path.includes(w.intent));
  assert.ok(asked.length >= 1);
  assert.ok(asked.every((q) => q.headers['stripe-account'] === w.account), 'read on the garage\'s own account');

  const s = await snapshot(w, '2026-09-08', '2026-09-10');
  assert.deepEqual(s.days.map((d) => [d.date, d.takings_minor, d.refunds_minor]), [['2026-09-08', 1250, 0], ['2026-09-09', 0, 0], ['2026-09-10', 0, 500]]);
  assert.equal(s.by_hour[15].refunds_minor, 500);
});

test('AN EVENT COUNTS ONCE: delivered again, in any state of the total', async () => {
  const w = await paidAndLeft('wh-repeat');
  stub.setRefunded(w.intent, 300);
  const raw = refundEvent(w);
  assert.equal((await send(raw)).status, 200);
  assert.equal((await send(raw)).status, 200);
  assert.equal((await ledger(w)).length, 1);
  // Stripe's total moved, and the old event comes a third time: it is not that refund's record.
  stub.setRefunded(w.intent, 400);
  assert.equal((await send(raw)).status, 200);
  assert.deepEqual((await ledger(w)).map((x) => x.amount_minor), [300]);
  // The new refund's own event records the difference.
  assert.equal((await send(refundEvent(w))).status, 200);
  assert.deepEqual((await ledger(w)).map((x) => x.amount_minor), [300, 100]);
});

test("A LATE OR OUT-OF-ORDER EVENT: Stripe's total now is what counts, and a second event with nothing new writes nothing", async () => {
  const w = await paidAndLeft('wh-order');
  stub.setRefunded(w.intent, 700);
  assert.equal((await send(refundEvent(w, { type: 'refund.updated', created: REFUNDED_AT + 100 }))).status, 200);
  assert.equal((await send(refundEvent(w, { created: REFUNDED_AT }))).status, 200);
  const rows = await ledger(w);
  assert.deepEqual(rows.map((x) => [x.amount_minor, x.refunded_total]), [[700, 700]]);
});

test('A REFUND THAT FAILED is a reversal: negative, on its own day, and the payment keeps its money again', async () => {
  const w = await paidAndLeft('wh-failed');
  stub.setRefunded(w.intent, 500);
  assert.equal((await send(refundEvent(w))).status, 200);
  stub.setRefunded(w.intent, 200);
  const later = REFUNDED_AT + 2 * 86_400;
  assert.equal((await send(refundEvent(w, { type: 'refund.failed', created: later }))).status, 200);
  assert.deepEqual((await ledger(w)).map((x) => [x.kind, x.amount_minor, x.refunded_total]), [['refund', 500, 500], ['reversal', -300, 200]]);
  assert.equal((await onPayment(w)).refunded_minor, 200);
  const s = await snapshot(w, '2026-09-10', '2026-09-12');
  assert.deepEqual(s.days.map((d) => d.refunds_minor), [500, 0, -300]);
});

test('A REFUND THE EXIT READ FIRST still gets its dated line', async () => {
  const w = await paidAndLeft('wh-exit-first');
  await withTenant(w.tenantId, (c) => c.query('UPDATE exit_payments SET refunded_minor = 200, refunds_read_at = now() WHERE id = $1', [w.payment]));
  stub.setRefunded(w.intent, 200);
  assert.equal((await send(refundEvent(w))).status, 200);
  assert.deepEqual((await ledger(w)).map((x) => x.amount_minor), [200]);
});

test('NEVER MORE THAN THE PAYMENT TOOK', async () => {
  const w = await paidAndLeft('wh-cap');
  stub.setRefunded(w.intent, 99_999);
  assert.equal((await send(refundEvent(w))).status, 200);
  assert.equal((await onPayment(w)).refunded_minor, 1250);
  assert.deepEqual((await ledger(w)).map((x) => x.amount_minor), [1250]);
});

test('WHAT IS NOT OURS is 200 and touches nothing, and Stripe is not asked', async () => {
  const w = await paidAndLeft('wh-ignored');
  const other = await paidAndLeft('wh-ignored-other');
  stub.setRefunded(w.intent, 100);
  stub.setRefunded(other.intent, 100);
  const asked = () => stub.requests.filter((q) => q.path.includes(w.intent) || q.path.includes(other.intent)).length;
  const before_ = asked();
  for (const [what, raw] of [
    ['another event type', refundEvent(w, { type: 'charge.dispute.created' })],
    ['a payment that succeeded', refundEvent(w, { type: 'payment_intent.succeeded' })],
    ['an account no garage holds', refundEvent(w, { account: 'acct_stubnobody' })],
    ['a payment no exit took', refundEvent(w, { intent: 'pi_stubnobody' })],
    ["another account's payment, under this account", refundEvent(w, { intent: other.intent })],
    ['no account at all', JSON.stringify({ id: evt(), type: 'charge.refunded', created: REFUNDED_AT, data: { object: { payment_intent: w.intent } } })],
    ['no payment named', JSON.stringify({ id: evt(), type: 'charge.refunded', created: REFUNDED_AT, account: w.account, data: { object: {} } })],
    ['no event id', JSON.stringify({ type: 'charge.refunded', created: REFUNDED_AT, account: w.account, data: { object: { payment_intent: w.intent } } })],
    ['not JSON', 'not json at all'],
    ['JSON of nothing', 'null'],
  ]) {
    const r = await send(raw);
    assert.equal(r.status, 200, `${what}: ${r.text}`);
  }
  assert.equal(asked(), before_, 'Stripe was not asked');
  assert.deepEqual(await ledger(w), []);
  assert.deepEqual(await ledger(other), []);
  assert.equal((await onPayment(other)).refunded_minor, 0);
});

test("ANOTHER GARAGE OF THE SAME ACCOUNT: an event names its own garage's Stripe account, and no other garage's payment", async () => {
  const w = await paidAndLeft('wh-garages');
  const second = await paidAndLeft('wh-garages', { beside: w });
  stub.setRefunded(second.intent, 100);
  assert.equal((await send(refundEvent(w, { intent: second.intent }))).status, 200);
  assert.deepEqual(await ledger(second), []);
  assert.equal((await send(refundEvent(second))).status, 200);
  assert.deepEqual((await ledger(second)).map((x) => x.amount_minor), [100]);
});

test('TWO EVENTS OF ONE REFUND AT ONCE take turns: the total is recorded once', async () => {
  const w = await paidAndLeft('wh-race');
  stub.setRefunded(w.intent, 500);
  stub.behaviour.delayRefundReadMs = 150;
  try {
    const answers = await Promise.all([send(refundEvent(w)), send(refundEvent(w, { type: 'refund.updated' }))]);
    assert.deepEqual(answers.map((r) => r.status), [200, 200]);
  } finally {
    stub.behaviour.delayRefundReadMs = 0;
  }
  assert.deepEqual((await ledger(w)).map((x) => x.amount_minor), [500]);
});

test('TOO MANY EVENTS AT ONCE: past the limit each is 503 at once and holds no connection, the limit comes back, and each is taken when sent again', async () => {
  const worlds = await Promise.all(Array.from({ length: EVENTS_AT_ONCE + 3 }, (_, i) => paidAndLeft(`wh-busy-${i}`)));
  const events = worlds.map((w) => {
    stub.setRefunded(w.intent, 100);
    return refundEvent(w);
  });
  stub.behaviour.delayRefundReadMs = 300;
  let answers;
  try {
    answers = await Promise.all(events.map((raw) => send(raw)));
  } finally {
    stub.behaviour.delayRefundReadMs = 0;
  }
  const statuses = answers.map((r) => r.status);
  assert.equal(statuses.filter((x) => x === 200).length, EVENTS_AT_ONCE, statuses.join());
  assert.equal(statuses.filter((x) => x === 503).length, events.length - EVENTS_AT_ONCE, statuses.join());
  assert.ok(answers.filter((r) => r.status === 503).every((r) => Number(r.retryAfter) >= 1));

  for (const raw of events) assert.equal((await send(raw)).status, 200);
  for (const w of worlds) assert.deepEqual((await ledger(w)).map((x) => x.amount_minor), [100]);
});

test('AN EVENT THAT FAILS gives its place back', async () => {
  const w = await paidAndLeft('wh-gives-back');
  stub.setRefunded(w.intent, 100);
  const raw = refundEvent(w);
  for (let i = 0; i < EVENTS_AT_ONCE + 1; i += 1) {
    stub.behaviour.failNext = { status: 500, path: /payment_intents/, message: 'down' };
    assert.equal((await send(raw)).status, 503);
  }
  assert.equal((await send(raw)).status, 200);
});

test('A PAYMENT CANCELED here is left alone', async () => {
  const w = await paidAndLeft('wh-canceled', { status: 'canceled' });
  stub.setRefunded(w.intent, 100);
  assert.equal((await send(refundEvent(w))).status, 200);
  assert.deepEqual(await ledger(w), []);
});

test('NOT NOW: a payment still open here, or Stripe not answering, is 503 and nothing is written; the same event is taken later', async () => {
  const w = await paidAndLeft('wh-open', { status: 'open' });
  stub.setRefunded(w.intent, 100);
  const raw = refundEvent(w);
  const open = await send(raw);
  assert.equal(open.status, 503, open.text);
  assert.ok(Number(open.retryAfter) >= 1);
  await withTenant(w.tenantId, (c) => c.query(`UPDATE exit_payments SET status = 'succeeded', succeeded_at = now() WHERE id = $1`, [w.payment]));

  stub.behaviour.failNext = { status: 500, path: /payment_intents/, body: { error: { message: 'down' } } };
  const down = await send(raw);
  assert.equal(down.status, 503, down.text);
  assert.doesNotMatch(down.text, /down/);
  assert.deepEqual(await ledger(w), []);

  assert.equal((await send(raw)).status, 200);
  assert.deepEqual((await ledger(w)).map((x) => x.amount_minor), [100]);
});

test('THE LEDGER: a refund of a payment of its own account, in its currency, of the right sign, once', async () => {
  const w = await paidAndLeft('wh-ledger');
  const other = await paidAndLeft('wh-ledger-other');
  const row = (over = {}) => {
    const v = { garage: w.garage, payment: w.payment, kind: 'refund', amount: 100, total: 100, currency: 'usd', event: evt(), ...over };
    return withTenant(w.tenantId, (c) => c.query(
      `INSERT INTO exit_refunds (tenant_id, garage_id, exit_payment_id, kind, amount_minor, refunded_total, currency, stripe_event_id, refunded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [w.tenantId, v.garage, v.payment, v.kind, v.amount, v.total, v.currency, v.event],
    ));
  };
  await assert.rejects(row({ payment: other.payment }), /of its own account/);
  await assert.rejects(row({ currency: 'eur' }), /of its own account/);
  await assert.rejects(row({ amount: -100 }), /exit_refunds_amount_by_kind/);
  await assert.rejects(row({ kind: 'reversal' }), /exit_refunds_amount_by_kind/);
  await assert.rejects(row({ amount: 0 }), /exit_refunds_amount_by_kind/);
  await assert.rejects(row({ total: 50 }), /exit_refunds_amount_by_kind/);
  const event = evt();
  await row({ event });
  await assert.rejects(row({ event }), /exit_refunds_one_per_event/);
  await assert.rejects(withTenant(w.tenantId, (c) => c.query('UPDATE exit_refunds SET amount_minor = 1')), /permission denied/);
  await assert.rejects(withTenant(w.tenantId, (c) => c.query('DELETE FROM exit_refunds')), /permission denied/);
});

test('THE ACCOUNT LOOKUP says a garage and its account, of a known account only, and opens nothing else', async () => {
  const w = await paidAndLeft('wh-lookup');
  const found = await pool.query('SELECT * FROM resolve_stripe_account($1)', [w.account]);
  assert.deepEqual(found.rows, [{ tenant_id: w.tenantId, garage_id: w.garage }]);
  assert.deepEqual((await pool.query('SELECT * FROM resolve_stripe_account($1)', ['acct_stubnobody'])).rows, []);
  assert.deepEqual((await pool.query('SELECT 1 FROM garage_stripe_accounts')).rows, [], 'the application role reads no account with no tenant');
  await pool.query(`SELECT set_config('openparking.definer_lookup', 'on', false)`).catch(() => {});
  assert.deepEqual((await pool.query('SELECT 1 FROM garage_stripe_accounts')).rows, [], 'and setting it opens nothing for that role');
  await pool.query(`SELECT set_config('openparking.definer_lookup', '', false)`).catch(() => {});
});
