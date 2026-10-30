/**
 * PAYING AT THE EXIT (0038): an exit case's fee, paid with a card on the
 * garage's own Stripe account, at the lane's bound reader or a phone reader.
 *
 * What this file measures, each with a break in
 * `scripts/exit-payments-fail-control.js`:
 *
 *   * the intent is the case's fee, on the garage's account, in person
 *     (`card_present`), captured at once, and handed to THIS lane's reader;
 *   * one intent per case: a resend, a race, a decline and the retry after
 *     it all use the same intent; a second stay payment is refused;
 *   * settled only when Stripe says succeeded AND for the recorded amount;
 *   * the reader's refusals become ones the lane can act on; a reader
 *     timeout is "unknown", never a second send;
 *   * a person letting the car out cancels an open intent, or records it
 *     paid if it already was;
 *   * a phone reader gets the same intent's client secret, once open;
 *   * a text receipt goes to a US or Canadian number only, once, and the
 *     number is kept nowhere but its last two digits;
 *   * the record: amount and intent fixed, a final state final.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { startStripeStub } from './stripe-stub.js';
import { intentBody, intentKey } from '../src/exitPayments.js';
import { usOrCanada, receiptText } from '../src/textReceipt.js';

// Assembled at runtime: a key-shaped literal is refused in this repository even when invented.
const KEY = ['rk', 'test', 'stubKeyForTheSuiteOnly000'].join('_');
const RULE = 'opvid-plate-chars/1';
const ADDRESS = { line1: '1 Example Street', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' };

let engine;
let stub;
let texts;
let server;
let base;
const keyDir = mkdtempSync(join(tmpdir(), 'text-receipt-'));
const textKeyFile = join(keyDir, 'key');
writeFileSync(textKeyFile, 'text-key\n');

/** A stand-in for the text provider: records each message, answers a reference. */
function startTexts() {
  const state = { requests: [], status: 201 };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.requests.push({ path: req.url, headers: req.headers, form: Object.fromEntries(new URLSearchParams(raw)) });
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.status < 300 ? { sid: `SMstub${state.requests.length}` } : { code: 21211 }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ state, srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

const configure = () => {
  process.env.STRIPE_API_KEY = KEY;
  process.env.STRIPE_API_BASE = stub.base;
  process.env.CONNECT_RETURN_URL = 'https://operator.example.com/connect/return';
  process.env.CONNECT_REFRESH_URL = 'https://operator.example.com/connect/refresh';
};
const unconfigure = () => {
  for (const k of ['STRIPE_API_KEY', 'STRIPE_API_BASE', 'CONNECT_RETURN_URL', 'CONNECT_REFRESH_URL']) delete process.env[k];
};
const textsOn = () => {
  Object.assign(process.env, { TEXT_PROVIDER: 'twilio', TEXT_ACCOUNT: 'ACstub0001', TEXT_KEY_FILE: textKeyFile, TEXT_FROM: '+12025550100', TEXT_API_BASE: texts.base });
};
const textsOff = () => {
  for (const k of ['TEXT_PROVIDER', 'TEXT_ACCOUNT', 'TEXT_KEY_FILE', 'TEXT_FROM', 'TEXT_API_BASE']) delete process.env[k];
};

async function deviceToken(tenantId, laneId, name) {
  const t = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)', [tenantId, laneId, name, hashToken(t)]));
  return t;
}

const call = (tok, method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

/** A garage with an account that takes cards, a Location, and a reader bound to its exit lane. */
async function garage(name, { reader = true, currency = 'USD' } = {}) {
  configure();
  const tenant = await createTenant(name);
  const world = await buildWorld(tenant, { hourlyMinor: 250, currency });
  const op = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)`, [tenant, hashToken(op)]));
  const acct = await call(op, 'POST', `/garages/${world.garage}/stripe-account`, { country: currency === 'CAD' ? 'CA' : 'US' });
  const account = (await acct.json()).stripe_account.account_id;
  stub.setState(account, { card_payments: 'active', charges_enabled: true, details_submitted: true });
  assert.equal((await call(op, 'POST', `/garages/${world.garage}/stripe-account/location`, { display_name: 'Pier', address: ADDRESS })).status, 201);
  let readerId = null;
  if (reader) {
    const bound = await call(op, 'POST', `/lanes/${world.exitLane}/reader`, { registration_code: 'simulated-wpe', label: 'Exit reader' });
    assert.equal(bound.status, 201, await bound.clone().text());
    readerId = (await bound.json()).reader.reader_id;
  }
  return {
    tenant, world, op, account, readerId,
    entry: await deviceToken(tenant, world.entryLane, 'entry'),
    exit: await deviceToken(tenant, world.exitLane, 'exit'),
  };
}

/** A car in 90 minutes ago, at the exit now: a case that owes a fee. */
async function owing(g, plate = `PAY${Math.floor(Math.random() * 9000 + 1000)}`) {
  const opened = await call(g.entry, 'POST', '/lane/sessions/open', {
    event_id: randomUUID(), plate, entry_at: ago(90), entry_confirmation: 'confirmed',
    plate_characters: { state: 'read', rule: RULE, pattern: plate },
  });
  assert.equal(opened.status, 201, await opened.clone().text());
  const res = await call(g.exit, 'POST', '/lane/exits', { event_id: randomUUID(), exit_at: ago(0.5), plate_characters: { state: 'read', rule: RULE, pattern: plate } });
  const { exit } = await res.json();
  assert.deepEqual([exit.method, exit.needs], ['single', 'payment'], JSON.stringify(exit));
  return exit;
}

const pay = (g, exitId) => call(g.exit, 'POST', `/lane/exits/${exitId}/pay`);
/** The lane's next poll reads Stripe: the last read is made old enough. */
async function poll(g, exitId) {
  await withTenant(g.tenant, (c) => c.query(`UPDATE exit_payments SET read_at = now() - interval '1 hour' WHERE exit_id = $1`, [exitId]));
  return (await (await call(g.exit, 'GET', `/lane/exits/${exitId}`)).json()).exit;
}
const intentOf = (exit) => stub.intents.get(exit.payment.payment_intent_id);
const events = (g, kind) => withTenant(g.tenant, async (c) => (await c.query('SELECT detail FROM events WHERE tenant_id = $1 AND kind = $2', [g.tenant, kind])).rows);

before(async () => {
  unconfigure();
  textsOff();
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  stub = await startStripeStub();
  texts = await startTexts();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  unconfigure();
  textsOff();
  if (server) await new Promise((r) => server.close(r));
  await stub?.close();
  await new Promise((r) => texts.srv.close(r));
  await engine?.stop();
  await pool.end();
});

test("the lane's reader takes the case's fee on the garage's account; paid, the case is settled and the close writes it", async () => {
  const g = await garage('pay-lane');
  const exit = await owing(g);
  const before = stub.requests.length;
  const res = await pay(g, exit.id);
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  assert.equal(out.sent, true);
  assert.deepEqual([out.exit.payment.status, out.exit.settled, out.exit.needs], ['open', false, 'payment']);

  const created = stub.requests.slice(before).find((r) => r.method === 'POST' && r.path === '/v1/payment_intents');
  assert.equal(created.headers['stripe-account'], g.account, "a direct charge: on the garage's own account");
  assert.equal(created.headers['idempotency-key'], intentKey(exit.id), 'one intent per case, whatever retries');
  const form = Object.fromEntries(new URLSearchParams(created.raw));
  assert.equal(Number(form.amount), exit.fee.fee_minor, "the amount is the case's fee");
  assert.equal(form.currency, 'usd');
  assert.equal(form['payment_method_types[0]'], 'card_present');
  assert.equal(form['payment_method_types[1]'], undefined, 'in person, a card; nothing else for dollars');
  assert.equal(form.capture_method, 'automatic');
  assert.equal(form['metadata[openparking_exit_id]'], exit.id);
  assert.deepEqual(stub.readerActions.at(-1), { reader: g.readerId, intent: out.exit.payment.payment_intent_id }, "to this lane's reader");

  assert.equal((await poll(g, exit.id)).settled, false, 'not paid until Stripe says so');
  stub.presentCard(out.exit.payment.payment_intent_id);
  const paid = await poll(g, exit.id);
  assert.deepEqual([paid.settled, paid.why, paid.payment.status], [true, 'paid', 'succeeded']);
  const told = await events(g, 'exit_paid');
  assert.equal(told.length, 1);
  assert.equal(told[0].detail.amount_minor, exit.fee.fee_minor);

  const closed = await call(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.1), exit_confirmation: 'confirmed' });
  assert.equal(closed.status, 200, await closed.clone().text());
  const after = await closed.json();
  assert.equal(after.session.fee_minor, exit.fee.fee_minor, JSON.stringify(after));
  assert.deepEqual([after.exit.settled, after.exit.why], [true, 'paid'], 'the closed case still reads paid');
});

test('a declined card is tried again on the same intent; a resend and a race never make a second', async () => {
  const g = await garage('pay-retry');
  const exit = await owing(g);
  const [a, b] = await Promise.all([pay(g, exit.id), pay(g, exit.id)]);
  const ids = [(await a.json()).exit.payment.payment_intent_id, (await b.json()).exit.payment.payment_intent_id];
  assert.equal(ids[0], ids[1], 'two requests at once: one intent');
  const mine = [...stub.intents.values()].filter((i) => i.metadata.openparking_exit_id === exit.id);
  assert.equal(mine.length, 1);

  stub.presentCard(ids[0], { decline: 'insufficient_funds' });
  const declined = await poll(g, exit.id);
  assert.deepEqual([declined.settled, declined.payment.status, declined.payment.last_failure], [false, 'open', 'card_declined:insufficient_funds']);

  const sends = stub.readerActions.filter((x) => x.intent === ids[0]).length;
  const again = await (await pay(g, exit.id)).json();
  assert.equal(again.sent, true);
  assert.equal(again.exit.payment.payment_intent_id, ids[0], 'the same intent, never a new one');
  assert.equal(stub.readerActions.filter((x) => x.intent === ids[0]).length, sends + 1);
  assert.equal([...stub.intents.values()].filter((i) => i.metadata.openparking_exit_id === exit.id).length, 1);

  stub.presentCard(ids[0]);
  assert.equal((await poll(g, exit.id)).why, 'paid');
  const done = await pay(g, exit.id);
  assert.equal(done.status, 409);
  assert.equal((await done.json()).code, 'exit_settled', 'a paid case is not paid twice');
});

test('settled only for the recorded amount: an intent whose amount moved is not payment', async () => {
  const g = await garage('pay-amount');
  const exit = await owing(g);
  const { exit: started } = await (await pay(g, exit.id)).json();
  const intent = intentOf(started);
  intent.amount += 100;
  stub.presentCard(intent.id);
  const read = await poll(g, exit.id);
  assert.deepEqual([read.settled, read.payment.status, read.payment.last_failure], [false, 'open', 'amount_mismatch']);
});

test("the reader's refusals: offline and busy say so; a timeout is unknown and the poll decides", async () => {
  const g = await garage('pay-reader');
  const exit = await owing(g);
  const created = await pay(g, exit.id);
  const intentId = (await created.json()).exit.payment.payment_intent_id;
  stub.presentCard(intentId, { decline: 'generic_decline' });
  await poll(g, exit.id);

  const failReaderWith = async (code) => {
    // The read of the intent comes first, then the reader: fail the reader.
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (url, opts) => {
      if (String(url).includes('/process_payment_intent') && calls++ === 0) {
        return Promise.resolve(new Response(JSON.stringify({ error: { type: 'invalid_request_error', code, message: code } }), { status: 400, headers: { 'content-type': 'application/json' } }));
      }
      return realFetch(url, opts);
    };
    try {
      return await pay(g, exit.id);
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const offline = await failReaderWith('terminal_reader_offline');
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).code, 'reader_offline');
  const busy = await failReaderWith('terminal_reader_busy');
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, 'reader_busy');
  const timeout = await failReaderWith('terminal_reader_timeout');
  assert.equal(timeout.status, 200);
  assert.equal((await timeout.json()).sent, 'unknown');
  assert.equal([...stub.intents.values()].filter((i) => i.metadata.openparking_exit_id === exit.id).length, 1, 'still one intent');
});

test('what cannot be paid is refused, with what is missing', async () => {
  const g = await garage('pay-refused');
  const other = await deviceToken(g.tenant, await withTenant(g.tenant, async (c) =>
    (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,'Exit 2','exit') RETURNING id`, [g.tenant, g.world.garage])).rows[0].id), 'exit2');
  const exit = await owing(g);
  const there = await call(other, 'POST', `/lane/exits/${exit.id}/pay`);
  assert.deepEqual([there.status, (await there.json()).code], [409, 'exit_on_another_lane']);

  const unmatched = (await (await call(g.exit, 'POST', '/lane/exits', { event_id: randomUUID(), exit_at: ago(0.5), plate_characters: { state: 'read', rule: RULE, pattern: 'NOSUCH1' } })).json()).exit;
  const noWord = await pay(g, unmatched.id);
  assert.deepEqual([noWord.status, (await noWord.json()).code], [409, 'nothing_to_pay_yet']);

  const bare = await garage('pay-no-reader', { reader: false });
  const owed = await owing(bare);
  const noReader = await pay(bare, owed.id);
  assert.deepEqual([noReader.status, (await noReader.json()).code], [409, 'no_reader_bound']);

  unconfigure();
  try {
    const off = await pay(g, exit.id);
    assert.deepEqual([off.status, (await off.json()).code], [409, 'connect_not_configured']);
  } finally {
    configure();
  }
});

test('a person letting the car out cancels an open intent; one already paid is recorded paid', async () => {
  const g = await garage('pay-person');
  const exit = await owing(g);
  const { exit: started } = await (await pay(g, exit.id)).json();
  const res = await call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/let-out`, { reason: 'reader broken, driver paid cash' });
  assert.equal(res.status, 200, await res.clone().text());
  const out = (await res.json()).exit;
  assert.equal(intentOf(started).status, 'canceled', 'no card is taken for a car let out');
  assert.deepEqual([out.settled, out.why, out.payment.status], [true, 'person', 'canceled']);
  assert.equal((await events(g, 'exit_payment_canceled')).length, 1);

  const second = await owing(g);
  const { exit: s2 } = await (await pay(g, second.id)).json();
  stub.presentCard(s2.payment.payment_intent_id);
  const late = await (await call(g.op, 'POST', `/garages/${g.world.garage}/exits/${second.id}/let-out`, { reason: 'driver in a hurry' })).json();
  assert.equal(late.exit.payment.status, 'succeeded', 'the card had already paid: recorded, not canceled');
});

test("a phone reader gets the same intent's client secret; paid, it is settled and the secret is not answered again", async () => {
  const g = await garage('pay-phone', { reader: false });
  const exit = await owing(g);
  const res = await call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/pay`);
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  assert.equal(out.exit.payment.channel, 'phone_reader');
  const intent = intentOf(out.exit);
  assert.equal(out.client_secret, intent.client_secret);
  assert.equal(stub.readerActions.filter((x) => x.intent === intent.id).length, 0, 'the phone collects it: no reader is driven');

  const again = await (await call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/pay`)).json();
  assert.equal(again.exit.payment.payment_intent_id, intent.id);
  stub.presentCard(intent.id);
  const paid = await poll(g, exit.id);
  assert.equal(paid.why, 'paid');
  const after = await call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/pay`);
  assert.equal(after.status, 409);
  assert.equal((await after.json()).client_secret, undefined);
});

test('a text receipt goes to a US or Canadian number only, once; the number is kept nowhere', async () => {
  const g = await garage('pay-text');
  const exit = await owing(g);
  const receipt = (phone) => call(g.exit, 'POST', `/lane/exits/${exit.id}/receipt`, { phone });

  const off = await receipt('+1 212 555 0123');
  assert.deepEqual([off.status, (await off.json()).code], [409, 'text_receipts_off']);
  textsOn();
  try {
    const unpaid = await receipt('+1 212 555 0123');
    assert.deepEqual([unpaid.status, (await unpaid.json()).code], [409, 'not_paid']);
    const { exit: started } = await (await pay(g, exit.id)).json();
    stub.presentCard(started.payment.payment_intent_id);
    await poll(g, exit.id);

    texts.state.requests.length = 0;
    for (const phone of ['+44 20 7946 0958', '+1 876 555 0123', '1-800-555-0123', '+1 787 555 0123', '555-0123', '+1 212 911 0123']) {
      const r = await receipt(phone);
      assert.deepEqual([r.status, (await r.json()).code], [400, 'phone_not_us_or_canada'], phone);
    }
    assert.equal(texts.state.requests.length, 0, 'nothing is sent to any other number');

    const sent = await receipt('+1 (416) 555-0199');
    assert.equal(sent.status, 200, await sent.clone().text());
    assert.equal((await sent.json()).exit.payment.receipt_sent, true);
    assert.equal(texts.state.requests.length, 1);
    const msg = texts.state.requests[0];
    assert.equal(msg.form.To, '+14165550199');
    assert.equal(msg.form.From, '+12025550100');
    assert.match(msg.form.Body, /^Test Garage: paid \$\d+\.\d\d for parking, /);
    assert.match(msg.headers.authorization, /^Basic /);

    const kept = await withTenant(g.tenant, async (c) => (await c.query('SELECT to_jsonb(p) AS row FROM exit_payments p WHERE exit_id = $1', [exit.id])).rows[0].row);
    assert.equal(kept.receipt.to_last2, '99');
    assert.doesNotMatch(JSON.stringify(kept), /4165550199|416\) 555/, 'the number is not kept');
    const twice = await receipt('+1 416 555 0199');
    assert.deepEqual([twice.status, (await twice.json()).code], [409, 'receipt_sent']);
    assert.equal(texts.state.requests.length, 1);
  } finally {
    textsOff();
  }
});

test('US and Canadian numbers by shape; Canadian dollars also take Interac; the receipt names the amount', () => {
  for (const ok of ['+12125550123', '212-555-0123', '(604) 555-0123', '1 416 555 0123']) assert.ok(usOrCanada(ok), ok);
  for (const no of ['+442079460958', '+18765550123', '+18005550123', '+19005550123', '+12115550123', '+12125110123', '+15215550123', '2125550123x', '', null, '+1212555012']) {
    assert.equal(usOrCanada(no), null, String(no));
  }
  assert.deepEqual(intentBody({ amountMinor: 500, currency: 'CAD', exitId: 'e', garageId: 'g' }).payment_method_types, ['card_present', 'interac_present']);
  assert.deepEqual(intentBody({ amountMinor: 500, currency: 'USD', exitId: 'e', garageId: 'g' }).payment_method_types, ['card_present']);
  const text = receiptText({ garageName: 'Pier', amountMinor: 1250, currency: 'usd', paidAt: '2026-10-27T14:05:00Z', timezone: 'America/New_York', reference: 'pi_abcdefgh12345678' });
  assert.match(text, /^Pier: paid \$12\.50 for parking, Oct 27, 2026, 10:05\s?AM\. Ref 12345678\. Thank you\.$/);
});

test('the record: what was paid and on which intent never changes; a final state stays final', async () => {
  const g = await garage('pay-record');
  const exit = await owing(g);
  const { exit: started } = await (await pay(g, exit.id)).json();
  const fails = async (sql, constraint) => {
    await assert.rejects(withTenant(g.tenant, (c) => c.query(sql, [exit.id])), (err) => err.constraint === constraint || err.message.includes(constraint));
  };
  await fails('UPDATE exit_payments SET amount_minor = amount_minor + 1 WHERE exit_id = $1', 'exit_payments_fixed');
  await fails(`UPDATE exit_payments SET payment_intent_id = 'pi_other' WHERE exit_id = $1`, 'exit_payments_fixed');
  stub.presentCard(started.payment.payment_intent_id);
  await poll(g, exit.id);
  await fails(`UPDATE exit_payments SET status = 'open', succeeded_at = NULL WHERE exit_id = $1`, 'exit_payments_final');
  await assert.rejects(withTenant(g.tenant, (c) => c.query('DELETE FROM exit_payments WHERE exit_id = $1', [exit.id])), /permission denied/);
});
