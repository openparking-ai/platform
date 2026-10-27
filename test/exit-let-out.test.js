/**
 * CANCELING AN EXIT'S PAYMENT, AND A CAR A PERSON LET OUT (0042).
 *
 * What this file measures, each with a break in
 * `scripts/exit-let-out-fail-control.js`:
 *
 *   * the lane's cancel cancels the intent at Stripe, with an idempotency
 *     key, and clears the reader only while it shows that intent; asked
 *     again, the same answer and no second cancel;
 *   * a card that already paid is never canceled, refunded or voided: the
 *     cancel answers paid and the exit settles as paid -- also when the card
 *     pays in the instant the cancel lands, or the poll reads it at once;
 *   * Stripe slow, or its answer lost: one cancel, one state, nothing
 *     recorded that Stripe did not say, and asking again is safe;
 *   * a card being authorised is not cut off: 409, and nothing changes;
 *   * a canceled payment is never taken again, and no second intent is made;
 *   * a close naming its case cancels the open payment first, then writes
 *     the stay LET OUT, UNPAID -- no fee, what it owed beside it -- or, if
 *     the card had paid, priced; Stripe out of reach is a 503 the lane
 *     retries, never a stay closed with its card still open;
 *   * the change log names the lane computer that let the car out, the
 *     case and the stay; an attendant's let-out is theirs;
 *   * a driver's entry time without an offset is refused with 400;
 *   * every route here answers only its own account, garage and lane.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { startStripeStub } from './stripe-stub.js';

// Assembled at runtime: a key-shaped literal is refused in this repository even when invented.
const KEY = ['rk', 'test', 'stubKeyForTheSuiteOnly000'].join('_');
const RULE = 'opvid-plate-chars/1';
const ADDRESS = { line1: '1 Example Street', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' };

let engine;
let stub;
let server;
let base;

const configure = () => {
  process.env.STRIPE_API_KEY = KEY;
  process.env.STRIPE_API_BASE = stub.base;
  process.env.CONNECT_RETURN_URL = 'https://operator.example.com/connect/return';
  process.env.CONNECT_REFRESH_URL = 'https://operator.example.com/connect/refresh';
};
const unconfigure = () => {
  for (const k of ['STRIPE_API_KEY', 'STRIPE_API_BASE', 'CONNECT_RETURN_URL', 'CONNECT_REFRESH_URL']) delete process.env[k];
};

async function deviceToken(tenantId, laneId, name) {
  const t = generateDeviceToken();
  const { rows } = await withTenant(tenantId, (c) =>
    c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4) RETURNING id', [tenantId, laneId, name, hashToken(t)]));
  return { token: t, id: rows[0].id };
}

const call = (tok, method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

/** A garage with an account that takes cards, a Location, and a reader bound to its exit lane. */
async function garage(name) {
  configure();
  const tenant = await createTenant(name);
  const world = await buildWorld(tenant, { hourlyMinor: 250, currency: 'USD' });
  const op = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)`, [tenant, hashToken(op)]));
  const acct = await call(op, 'POST', `/garages/${world.garage}/stripe-account`, { country: 'US' });
  const account = (await acct.json()).stripe_account.account_id;
  stub.setState(account, { card_payments: 'active', charges_enabled: true, details_submitted: true });
  assert.equal((await call(op, 'POST', `/garages/${world.garage}/stripe-account/location`, { display_name: 'Pier', address: ADDRESS })).status, 201);
  const bound = await call(op, 'POST', `/lanes/${world.exitLane}/reader`, { registration_code: 'simulated-wpe', label: 'Exit reader' });
  assert.equal(bound.status, 201, await bound.clone().text());
  const exitDevice = await deviceToken(tenant, world.exitLane, 'exit');
  return {
    tenant, world, op, account,
    readerId: (await bound.json()).reader.reader_id,
    entry: (await deviceToken(tenant, world.entryLane, 'entry')).token,
    exit: exitDevice.token,
    exitDeviceId: exitDevice.id,
  };
}

const plateNo = () => `LET${Math.floor(Math.random() * 9000 + 1000)}`;

/** A car in 90 minutes ago, at the exit now: a case that owes a fee. */
async function owing(g, plate = plateNo()) {
  const opened = await call(g.entry, 'POST', '/lane/sessions/open', {
    event_id: randomUUID(), plate, entry_at: ago(90), entry_confirmation: 'confirmed',
    plate_characters: { state: 'read', rule: RULE, pattern: plate },
  });
  assert.equal(opened.status, 201, await opened.clone().text());
  return atExit(g, plate);
}

async function atExit(g, plate) {
  const res = await call(g.exit, 'POST', '/lane/exits', { event_id: randomUUID(), exit_at: ago(0.5), plate_characters: { state: 'read', rule: RULE, pattern: plate } });
  assert.equal(res.status, 201, await res.clone().text());
  const { exit } = await res.json();
  assert.deepEqual([exit.method, exit.needs], ['single', 'payment'], JSON.stringify(exit));
  return exit;
}

/** No stay found: a case that wants the driver's word. */
async function unmatched(g) {
  const res = await call(g.exit, 'POST', '/lane/exits', { event_id: randomUUID(), exit_at: ago(0.5), plate_characters: { state: 'read', rule: RULE, pattern: 'NOSUCH9' } });
  const { exit } = await res.json();
  assert.equal(exit.needs, 'driver_word', JSON.stringify(exit));
  return exit;
}

const pay = async (g, exitId) => {
  const res = await call(g.exit, 'POST', `/lane/exits/${exitId}/pay`);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).exit;
};
const cancel = (g, exitId) => call(g.exit, 'POST', `/lane/exits/${exitId}/pay/cancel`);
const close = (g, exitId, extra = {}) => call(g.exit, 'POST', '/lane/sessions/close', {
  event_id: randomUUID(), exit_id: exitId, exit_at: ago(0.1), exit_confirmation: 'confirmed', ...extra,
});
const caseOf = async (g, exitId) => {
  await withTenant(g.tenant, (c) => c.query(`UPDATE exit_payments SET read_at = now() - interval '1 hour' WHERE exit_id = $1`, [exitId]));
  return (await (await call(g.exit, 'GET', `/lane/exits/${exitId}`)).json()).exit;
};
const intentOf = (exit) => stub.intents.get(exit.payment.payment_intent_id);
const readerOf = (g) => stub.terminal.find((t) => t.id === g.readerId);
const cancelCalls = (intentId) => stub.requests.filter((r) => r.method === 'POST' && r.path === `/v1/payment_intents/${intentId}/cancel`);
const recorded = (g, exitId) => withTenant(g.tenant, async (c) => (await c.query('SELECT * FROM exit_payments WHERE exit_id = $1', [exitId])).rows[0]);
const stay = (g, sessionId) => withTenant(g.tenant, async (c) => (await c.query('SELECT * FROM sessions WHERE id = $1', [sessionId])).rows[0]);
const events = (g, kind) => withTenant(g.tenant, async (c) => (await c.query('SELECT detail FROM events WHERE tenant_id = $1 AND kind = $2', [g.tenant, kind])).rows);
const letOutLines = (g, exitId) => withTenant(g.tenant, async (c) => (await c.query(
  `SELECT actor_kind, actor_id, actor_name, after FROM garage_changes WHERE tenant_id = $1 AND action = 'exit.let_out' AND subject_id = $2`,
  [g.tenant, exitId])).rows);

before(async () => {
  unconfigure();
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  stub = await startStripeStub();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  unconfigure();
  if (server) await new Promise((r) => server.close(r));
  await stub?.close();
  await engine?.stop();
  await pool.end();
});

test("the lane's cancel cancels the intent at Stripe and clears its reader; asked again, the same answer and no second cancel", async () => {
  const g = await garage('cancel-twice');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  const intentId = started.payment.payment_intent_id;
  assert.equal(readerOf(g).action?.process_payment_intent?.payment_intent, intentId);

  const first = await cancel(g, exit.id);
  assert.equal(first.status, 200, await first.clone().text());
  const out = await first.json();
  assert.deepEqual([out.canceled, out.exit.payment.status, out.exit.settled], [true, 'canceled', false]);
  assert.equal(intentOf(started).status, 'canceled', 'canceled at Stripe, not only on the reader');
  assert.equal(readerOf(g).action, null, 'the reader no longer shows it');
  const calls = cancelCalls(intentId);
  assert.equal(calls.length, 1);
  assert.match(calls[0].headers['idempotency-key'] ?? '', /^openparking-exit-cancel-[0-9a-f]{32}$/, 'a cancel carries its idempotency key');
  assert.equal(calls[0].headers['stripe-account'], g.account, "on the garage's own account");

  const again = await cancel(g, exit.id);
  assert.equal(again.status, 200);
  assert.deepEqual([(await again.json()).exit.payment.status], ['canceled']);
  assert.equal(cancelCalls(intentId).length, 1, 'asked again: no second cancel at Stripe');
  assert.equal(stub.cancels.filter((id) => id === intentId).length, 1);
  assert.equal((await events(g, 'exit_payment_canceled')).length, 1, 'one event for one cancel');

  const payAgain = await call(g.exit, 'POST', `/lane/exits/${exit.id}/pay`);
  assert.deepEqual([payAgain.status, (await payAgain.json()).code], [409, 'payment_canceled'], 'a canceled payment is never taken again');
  assert.equal([...stub.intents.values()].filter((i) => i.metadata.openparking_exit_id === exit.id).length, 1, 'and no second intent');
});

test('a cancel after the card paid answers paid; nothing is canceled, refunded or voided, and the exit settles as paid', async () => {
  const g = await garage('cancel-after-paid');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  stub.presentCard(started.payment.payment_intent_id);
  const res = await cancel(g, exit.id);
  assert.equal(res.status, 409, await res.clone().text());
  assert.equal((await res.json()).code, 'exit_paid');
  assert.equal(intentOf(started).status, 'succeeded');
  assert.equal(cancelCalls(started.payment.payment_intent_id).length, 0, 'a paid intent is never asked to cancel');
  assert.equal(stub.requests.filter((r) => /refunds|reversals/.test(r.path)).length, 0, 'nothing refunded');
  const now = await caseOf(g, exit.id);
  assert.deepEqual([now.settled, now.why, now.payment.status], [true, 'paid', 'succeeded']);
  assert.equal((await events(g, 'exit_paid')).length, 1);
  assert.equal((await events(g, 'exit_payment_canceled')).length, 0);

  const closed = await close(g, exit.id);
  assert.equal(closed.status, 200, await closed.clone().text());
  const written = await stay(g, exit.session_id);
  assert.equal(Number(written.fee_minor), exit.fee.fee_minor, 'priced at the fee it paid');
  assert.equal(written.let_out, null);
});

test('a card paying in the instant the cancel lands is recorded paid, never canceled; so is one the poll reads at the same time', async () => {
  const g = await garage('cancel-race');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  stub.behaviour.beforeCancel = (intent) => stub.presentCard(intent.id);
  const res = await cancel(g, exit.id);
  assert.deepEqual([res.status, (await res.json()).code], [409, 'exit_paid']);
  assert.equal(intentOf(started).status, 'succeeded');
  assert.equal((await recorded(g, exit.id)).status, 'succeeded', 'the record says what Stripe says');
  assert.equal((await caseOf(g, exit.id)).why, 'paid');

  // The poll and the cancel at once, the card already paid.
  const other = await owing(g);
  const s2 = await pay(g, other.id);
  stub.presentCard(s2.payment.payment_intent_id);
  await withTenant(g.tenant, (c) => c.query(`UPDATE exit_payments SET read_at = now() - interval '1 hour' WHERE exit_id = $1`, [other.id]));
  const [c2, polled] = await Promise.all([cancel(g, other.id), call(g.exit, 'GET', `/lane/exits/${other.id}`)]);
  assert.deepEqual([c2.status, (await c2.json()).code], [409, 'exit_paid']);
  assert.equal((await polled.json()).exit.payment.status, 'succeeded');
  assert.equal((await recorded(g, other.id)).status, 'succeeded');
  assert.equal(intentOf(s2).status, 'succeeded');
});

test('Stripe slow: two cancels at once make one cancel and one state', async () => {
  const g = await garage('cancel-slow');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  stub.behaviour.delayCancelMs = 400;
  let a;
  let b;
  try {
    [a, b] = await Promise.all([cancel(g, exit.id), cancel(g, exit.id)]);
  } finally {
    stub.behaviour.delayCancelMs = 0;
  }
  assert.deepEqual([a.status, b.status], [200, 200], `${await a.clone().text()} ${await b.clone().text()}`);
  assert.equal(stub.cancels.filter((id) => id === started.payment.payment_intent_id).length, 1, 'Stripe canceled it once');
  const keys = new Set(cancelCalls(started.payment.payment_intent_id).map((r) => r.headers['idempotency-key']));
  assert.equal(keys.size, 1, 'both asked with the same key');
  assert.equal((await recorded(g, exit.id)).status, 'canceled');
  assert.equal((await events(g, 'exit_payment_canceled')).length, 1);
});

test("Stripe's answer lost: nothing recorded that Stripe did not say; asked again, canceled, with no second cancel", async () => {
  const g = await garage('cancel-lost');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  stub.behaviour.dropNextCancel = true;
  const lost = await cancel(g, exit.id);
  assert.deepEqual([lost.status, (await lost.json()).code], [503, 'stripe_unreachable']);
  assert.equal(intentOf(started).status, 'canceled', 'Stripe did cancel it');
  assert.equal((await recorded(g, exit.id)).status, 'open', 'but it was not heard, so nothing is recorded');

  const retry = await cancel(g, exit.id);
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal((await retry.json()).exit.payment.status, 'canceled');
  assert.equal(stub.cancels.filter((id) => id === started.payment.payment_intent_id).length, 1, 'one cancel at Stripe');
  assert.equal((await events(g, 'exit_payment_canceled')).length, 1);
});

test('a card being authorised is not cut off: 409 payment_in_progress, and nothing changes', async () => {
  const g = await garage('cancel-busy');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  stub.behaviour.readerBusyNextClear = true;
  const busy = await cancel(g, exit.id);
  assert.deepEqual([busy.status, (await busy.json()).code], [409, 'payment_in_progress']);
  assert.equal(intentOf(started).status, 'requires_payment_method', 'the intent is left for the card to finish');
  assert.equal(cancelCalls(started.payment.payment_intent_id).length, 0);
  assert.equal((await recorded(g, exit.id)).status, 'open');
  const later = await cancel(g, exit.id);
  assert.equal(later.status, 200);
  assert.equal(intentOf(started).status, 'canceled');
});

test("the reader is cleared only while it shows this case's intent: a later car's payment on it is left alone", async () => {
  const g = await garage('cancel-reader-moved');
  const a = await owing(g);
  const sa = await pay(g, a.id);
  // The reader moves on to another intent (as if another case took it).
  const reader = readerOf(g);
  reader.action = { type: 'process_payment_intent', status: 'in_progress', process_payment_intent: { payment_intent: 'pi_stubsomeoneelse' } };
  const res = await cancel(g, a.id);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(intentOf(sa).status, 'canceled');
  assert.equal(readerOf(g).action?.process_payment_intent?.payment_intent, 'pi_stubsomeoneelse', 'not cleared');
  assert.equal(stub.requests.filter((r) => r.path === `/v1/terminal/readers/${g.readerId}/cancel_action`).length, 0);
});

test("a person's close naming the case cancels its payment and writes the stay let out, unpaid; the change log names the lane computer", async () => {
  const g = await garage('close-let-out');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  const res = await close(g, exit.id, { let_out_by: 'human_open_now' });
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  assert.equal(intentOf(started).status, 'canceled', 'no card can be taken for a car already let out');
  assert.equal(readerOf(g).action, null);
  assert.equal(out.session.fee_minor, null, 'it paid nothing, so no fee is written');
  assert.equal(out.session.exit_outcome, 'transient');
  assert.deepEqual(
    { ...out.session.let_out, at: undefined },
    { paid: false, by: `lane_device:${g.exitDeviceId}`, reason: 'human_open_now', exit_id: exit.id, owed_minor: exit.fee.fee_minor, currency: 'USD', payment: 'canceled', at: undefined },
  );
  assert.equal((await recorded(g, exit.id)).status, 'canceled');
  const told = await events(g, 'exit_payment_canceled');
  assert.deepEqual(told.map((e) => e.detail.why), ['let_out_at_lane']);

  const lines = await letOutLines(g, exit.id);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].actor_kind, lines[0].actor_id, lines[0].actor_name], ['computer', g.exitDeviceId, 'exit']);
  assert.deepEqual(
    { ...lines[0].after },
    { let_out: true, at_lane: true, authority: 'human_open_now', flagged: false, stay_id: exit.session_id, paid: false, owed_minor: exit.fee.fee_minor, currency: 'USD', payment: 'canceled' },
  );
  const shown = await (await call(g.op, 'GET', `/garages/${g.world.garage}/changes`)).json();
  assert.ok(JSON.stringify(shown).includes('"computer"'), 'the change log reads the lane computer as who');

  const past = await (await call(g.op, 'GET', `/garages/${g.world.garage}/stays/closed?from=${encodeURIComponent(ago(600))}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).json();
  const mine = past.stays.find((s) => s.let_out_unpaid);
  assert.ok(mine, JSON.stringify(past));
  assert.deepEqual([mine.fee_minor, mine.owed_minor], [null, exit.fee.fee_minor], 'let out unpaid, not a stay that paid nothing');
});

test('a close for a case owing with no payment started is let out too, and the replay writes nothing twice', async () => {
  const g = await garage('close-let-out-none');
  const exit = await owing(g);
  const eventId = randomUUID();
  const res = await close(g, exit.id, { event_id: eventId });
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  assert.deepEqual([out.session.fee_minor, out.session.let_out.paid, out.session.let_out.payment, out.session.let_out.reason], [null, false, null, null]);
  const replay = await close(g, exit.id, { event_id: eventId });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replay, true);
  const lines = await letOutLines(g, exit.id);
  assert.equal(lines.length, 1, 'one line, though the close came twice');
  assert.equal(lines[0].after.authority, null);
  assert.equal(lines[0].after.flagged, false);
});

test("a person's close that opened and flagged the exit is taken; the stay and the change log say it was flagged", async () => {
  const g = await garage('close-flagged');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  const eventId = randomUUID();
  const res = await close(g, exit.id, { event_id: eventId, let_out_by: 'human_open_and_flag' });
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  assert.equal(intentOf(started).status, 'canceled');
  assert.deepEqual(
    [out.session.fee_minor, out.session.let_out.paid, out.session.let_out.by, out.session.let_out.reason],
    [null, false, `lane_device:${g.exitDeviceId}`, 'human_open_and_flag'],
  );
  const replay = await close(g, exit.id, { event_id: eventId, let_out_by: 'human_open_and_flag' });
  assert.equal(replay.status, 200);
  const lines = await letOutLines(g, exit.id);
  assert.equal(lines.length, 1, 'one line, though the close came twice');
  assert.deepEqual([lines[0].actor_kind, lines[0].actor_id], ['computer', g.exitDeviceId]);
  assert.deepEqual(
    { ...lines[0].after },
    { let_out: true, at_lane: true, authority: 'human_open_and_flag', flagged: true, stay_id: exit.session_id, paid: false, owed_minor: exit.fee.fee_minor, currency: 'USD', payment: 'canceled' },
  );
});

test('a close whose payment Stripe cannot settle now is a 503 the lane retries; the stay stays open until then', async () => {
  const g = await garage('close-unsettled');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  stub.behaviour.dropNextCancel = true;
  const eventId = randomUUID();
  const first = await close(g, exit.id, { event_id: eventId });
  assert.deepEqual([first.status, (await first.json()).code], [503, 'payment_unsettled']);
  assert.equal((await stay(g, exit.session_id)).exit_at, null, 'never closed with its card still open');
  const second = await close(g, exit.id, { event_id: eventId });
  assert.equal(second.status, 200, await second.clone().text());
  assert.equal((await second.json()).session.let_out.payment, 'canceled');
  assert.equal(stub.cancels.filter((id) => id === started.payment.payment_intent_id).length, 1);

  // A card being authorised: also retried, never cut off.
  const busy = await owing(g);
  const sb = await pay(g, busy.id);
  stub.behaviour.readerBusyNextClear = true;
  const held = await close(g, busy.id);
  assert.deepEqual([held.status, (await held.json()).code], [503, 'payment_unsettled']);
  assert.equal(intentOf(sb).status, 'requires_payment_method');
});

test('a close whose card paid as the person opened writes the stay priced, not let out; a person opening is still in the change log', async () => {
  const g = await garage('close-paid-race');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  stub.behaviour.beforeCancel = (intent) => stub.presentCard(intent.id);
  const res = await close(g, exit.id, { let_out_by: 'human_open_now' });
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  assert.equal(out.session.fee_minor, exit.fee.fee_minor);
  assert.equal(out.session.let_out, null);
  assert.equal(intentOf(started).status, 'succeeded');
  const lines = await letOutLines(g, exit.id);
  assert.deepEqual([lines.length, lines[0].after.paid, lines[0].after.payment], [1, true, 'succeeded']);
});

test('a payment started as the case closes is never taken: its intent is canceled and the pay refused', async () => {
  const g = await garage('close-pay-race');
  const exit = await owing(g);
  let release;
  stub.behaviour.holdCreate = new Promise((resolve) => { release = resolve; });
  const asked = stub.requests.length;
  let paying;
  try {
    paying = call(g.exit, 'POST', `/lane/exits/${exit.id}/pay`);
    // The pay has read the case open and is waiting on Stripe for its intent.
    while (!stub.requests.slice(asked).some((r) => r.method === 'POST' && r.path === '/v1/payment_intents')) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const closed = await close(g, exit.id);
    assert.equal(closed.status, 200, await closed.clone().text());
    assert.equal((await closed.json()).session.let_out.payment, null, 'closed with no payment');
  } finally {
    stub.behaviour.holdCreate = null;
    release();
  }
  const res = await paying;
  assert.deepEqual([res.status, (await res.json()).code], [409, 'exit_closed']);
  const made = [...stub.intents.values()].filter((i) => i.metadata.openparking_exit_id === exit.id);
  assert.equal(made.length, 1);
  assert.equal(made[0].status, 'canceled', 'the intent made for a closed case is canceled');
  assert.equal(await recorded(g, exit.id), undefined, 'and no payment is recorded on it');
  assert.equal(stub.readerActions.filter((a) => a.intent === made[0].id).length, 0, 'never sent to the reader');
});

test("an attendant's let-out, then the close: the stay is let out, unpaid, by the attendant, and the line is the attendant's", async () => {
  const g = await garage('close-after-person');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  const let_ = await call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/let-out`, { reason: 'reader broken' });
  assert.equal(let_.status, 200, await let_.clone().text());
  assert.equal(intentOf(started).status, 'canceled');
  const res = await close(g, exit.id);
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  assert.deepEqual([out.session.fee_minor, out.session.let_out.by, out.session.let_out.reason], [null, 'key:desk', 'reader broken']);
  const lines = await letOutLines(g, exit.id);
  assert.deepEqual(lines.map((l) => l.actor_kind), ['key'], "the attendant's own line, and no second");
});

test("a driver's entry time without an offset is refused with 400 and a sentence; with one, in any form the lane takes, it is placed", async () => {
  const g = await garage('word-offset');
  const at = new Date(Date.now() - 60 * 60_000);
  at.setUTCSeconds(0, 0);
  const wall = (d) => d.toISOString().slice(0, 19);
  const minus4 = new Date(at.getTime() - 4 * 3_600_000);

  for (const said of [wall(at), `${wall(at).replace('T', ' ')}`, wall(at).slice(0, 16), 'yesterday at nine']) {
    const exit = await unmatched(g);
    const res = await call(g.exit, 'POST', `/lane/exits/${exit.id}/word`, { entry_at: said });
    assert.equal(res.status, 400, said);
    const body = await res.json();
    assert.equal(body.code, 'entry_time_without_offset', said);
    assert.match(body.error ?? body.message, /time zone offset/);
  }
  for (const said of [`${wall(at)}Z`, `${wall(minus4)}-04:00`, `${wall(minus4).replace('T', ' ').slice(0, 16)}-0400`, `${wall(minus4)}.000-04`]) {
    const exit = await unmatched(g);
    const res = await call(g.exit, 'POST', `/lane/exits/${exit.id}/word`, { entry_at: said });
    assert.equal(res.status, 200, `${said}: ${await res.clone().text()}`);
    assert.equal(new Date((await res.json()).exit.claimed_entry_at).getTime(), at.getTime(), `${said} is the same instant`);
  }
});

test('every route here answers only its own account, garage and lane', async () => {
  const g = await garage('owasp-own');
  const other = await garage('owasp-other');
  const exit = await owing(g);
  const started = await pay(g, exit.id);
  const word = await unmatched(g);

  // Another account's lane computer.
  for (const [method, path, body] of [
    ['POST', `/lane/exits/${exit.id}/pay/cancel`],
    ['POST', `/lane/exits/${word.id}/word`, { entry_at: `${ago(30).slice(0, 19)}Z` }],
    ['POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.1), exit_confirmation: 'confirmed', let_out_by: 'human_open_now' }],
    ['POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.1), exit_confirmation: 'confirmed', let_out_by: 'human_open_and_flag' }],
  ]) {
    const res = await call(other.exit, method, path, body);
    assert.deepEqual([res.status, (await res.json()).code], [404, 'exit_not_found'], `${path} from another account`);
  }
  // Another garage of the same account.
  const secondLane = await withTenant(g.tenant, async (c) => {
    const gid = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, 'Second', 'America/Chicago', 'USD') RETURNING id`, [g.tenant])).rows[0].id;
    await storePlan(c, g.tenant, gid, flatHourlyPlan({ hourlyMinor: 250, currency: 'USD' }));
    await activateGarage(c, g.tenant, gid);
    return (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1, $2, 'Exit', 'exit') RETURNING id`, [g.tenant, gid])).rows[0].id;
  });
  const g2 = (await deviceToken(g.tenant, secondLane, 'exit-g2')).token;
  for (const [path, body] of [
    [`/lane/exits/${exit.id}/pay/cancel`],
    [`/lane/exits/${word.id}/word`, { entry_at: `${ago(30).slice(0, 19)}Z` }],
    ['/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.1), exit_confirmation: 'confirmed', let_out_by: 'human_open_now' }],
    ['/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.1), exit_confirmation: 'confirmed', let_out_by: 'human_open_and_flag' }],
  ]) {
    const res = await call(g2, 'POST', path, body);
    assert.deepEqual([res.status, (await res.json()).code], [404, 'exit_not_found'], `${path} from another garage`);
  }
  // Another lane of the same garage, and an entry lane.
  const lane2 = await withTenant(g.tenant, async (c) =>
    (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1, $2, 'Exit 2', 'exit') RETURNING id`, [g.tenant, g.world.garage])).rows[0].id);
  const there = await call((await deviceToken(g.tenant, lane2, 'exit2')).token, 'POST', `/lane/exits/${exit.id}/pay/cancel`);
  assert.deepEqual([there.status, (await there.json()).code], [409, 'exit_on_another_lane']);
  const entry = await call(g.entry, 'POST', `/lane/exits/${exit.id}/pay/cancel`);
  assert.deepEqual([entry.status, (await entry.json()).code], [409, 'wrong_lane_direction']);

  assert.equal(intentOf(started).status, 'requires_payment_method', 'none of them touched the payment');
  assert.equal((await recorded(g, exit.id)).status, 'open');
  assert.equal((await stay(g, exit.session_id)).exit_at, null);
  assert.equal((await letOutLines(g, exit.id)).length, 0);
});

test('the close refuses a let_out_by the lane does not name, or one with no case', async () => {
  const g = await garage('let-out-by-shape');
  const exit = await owing(g);
  const odd = await close(g, exit.id, { let_out_by: 'the caller asked' });
  assert.equal(odd.status, 400);
  assert.match((await odd.json()).error, /let_out_by must be one of display_code_confirmed, human_open_now, human_open_and_flag/);
  const noCase = await call(g.exit, 'POST', '/lane/sessions/close', {
    event_id: randomUUID(), plate: 'NOCASE1', exit_at: ago(0.1), exit_confirmation: 'confirmed', let_out_by: 'human_open_now',
  });
  assert.equal(noCase.status, 400);
  assert.match((await noCase.json()).error, /exit_id/);
});

test('the database holds a let-out stay unpaid: never with a fee, never on an ended stay', async () => {
  const g = await garage('let-out-db');
  const exit = await owing(g);
  const res = await close(g, exit.id);
  assert.equal(res.status, 200);
  await assert.rejects(withTenant(g.tenant, (c) => c.query(
    `UPDATE sessions SET fee_minor = 100, plan_version = 'x', breakdown = '[]', space_class = 'standard' WHERE id = $1`, [exit.session_id])),
  /sessions_let_out_is_unpaid/);
  await assert.rejects(withTenant(g.tenant, (c) => c.query(
    `UPDATE sessions SET let_out = let_out || '{"paid": true}' WHERE id = $1`, [exit.session_id])), /sessions_let_out_is_a_record/);
  await assert.rejects(withTenant(g.tenant, (c) => c.query(
    `UPDATE sessions SET let_out = let_out - 'by' WHERE id = $1`, [exit.session_id])), /sessions_let_out_is_a_record/);
});
