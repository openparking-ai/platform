#!/usr/bin/env node
/**
 * ONE EXIT PAYMENT AGAINST STRIPE'S TEST MODE, with a simulated reader.
 *
 * The suite runs against a stand-in (test/stripe-stub.js) that answers in
 * the shapes Stripe's API reference gives; CI holds no Stripe key and never
 * will. This is where those shapes are checked against Stripe itself, by
 * running the platform's OWN calls (src/exitPayments.js, src/stripe.js) on
 * the test mode of an account you name, with a simulated reader:
 *
 *    1  the Location and a simulated reader (`simulated-wpe`), made once and
 *       found again on later runs;
 *    2  a PaymentIntent for a fee, made with the case's idempotency key --
 *       asked twice, the same intent;
 *    3  handed to the reader: the reader's action is in progress on it;
 *    4  a second intent handed to the busy reader: Stripe refuses it
 *       (`terminal_reader_busy`), and the first stays on the reader -- what
 *       the stand-in does, and what the platform's handling of another car's
 *       fee on the reader rests on;
 *    5  the reader cleared, and the second intent canceled with its cancel
 *       key -- asked again, the same answer;
 *    6  a declined card on the first intent: back to waiting for a card, the
 *       decline on it, the reader's action failed;
 *    7  a good card on the same intent: succeeded, at the amount made;
 *    8  a cancel of the succeeded intent: refused by Stripe, still succeeded
 *       -- a paid intent is never canceled.
 *
 * NEVER LIVE. The key must be a TEST key (`sk_test_` or `rk_test_`): any
 * other key is refused before anything is sent. The key is read from the
 * file STRIPE_TEST_KEY_FILE names (preferred: it stays out of the shell's
 * history), or from STRIPE_API_KEY; it is never printed, not even in part.
 *
 * THE ACCOUNT. STRIPE_TEST_ACCOUNT, an `acct_` id: a connected account in
 * test mode that can take cards, acted on as a garage's own account is
 * (the `Stripe-Account` header, direct charges). Unset, the calls act on the
 * key's own account, the same calls with no header.
 *
 * With no test key at all, nothing is run: it says so and exits 2.
 *
 *   STRIPE_TEST_KEY_FILE=~/stripe-test-key STRIPE_TEST_ACCOUNT=acct_... \
 *     node scripts/stripe-test-mode-check.js
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripeCall, StripeError } from '../src/stripe.js';
import * as exitPayments from '../src/exitPayments.js';

const LOCATION_NAME = 'openparking-test-mode-check';
const AMOUNT = 1234;
const DECLINED_CARD = '4000000000000002';

/** The test key, or a refusal that names what is wrong and never the key. */
export function testKey(env = process.env) {
  let key = null;
  if (env.STRIPE_TEST_KEY_FILE) {
    try {
      key = readFileSync(env.STRIPE_TEST_KEY_FILE, 'utf8').trim();
    } catch {
      return { refused: 'STRIPE_TEST_KEY_FILE names a file that cannot be read' };
    }
  } else if (env.STRIPE_API_KEY) {
    key = env.STRIPE_API_KEY.trim();
  }
  if (!key) return { none: true };
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) {
    return { refused: 'the key is not a Stripe TEST key (sk_test_ or rk_test_); nothing was sent' };
  }
  const account = env.STRIPE_TEST_ACCOUNT || null;
  if (account !== null && !/^acct_[A-Za-z0-9]+$/.test(account)) {
    return { refused: 'STRIPE_TEST_ACCOUNT must be an acct_ id' };
  }
  return { key, account };
}

async function main() {
  const found = testKey();
  if (found.none) {
    console.log('stripe-test-mode-check: no Stripe test key is set (STRIPE_TEST_KEY_FILE or STRIPE_API_KEY); nothing was run.');
    process.exit(2);
  }
  if (found.refused) {
    console.error(`stripe-test-mode-check: ${found.refused}`);
    process.exit(1);
  }
  // Stripe itself, whatever STRIPE_API_BASE says: this checks Stripe, not a stand-in.
  const config = { configured: true, key: found.key, base: 'https://api.stripe.com' };
  const account = found.account;
  const call = (args) => stripeCall({ ...args, account }, config);
  let failures = 0;
  const check = (n, ok, said) => {
    console.log(`  ${String(n).padStart(2)} ${ok ? 'PASS' : 'FAIL'}  ${said}`);
    if (!ok) failures += 1;
  };
  const until = async (read, done, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await read();
      if (done(v) || Date.now() > end) return v;
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  console.log(`stripe-test-mode-check: Stripe test mode, ${account ? 'on the connected account named' : "on the key's own account"}`);

  // 1. The Location and the simulated reader, made once.
  const locations = await call({ method: 'GET', path: '/v1/terminal/locations?limit=100' });
  let location = locations.data.find((l) => l.display_name === LOCATION_NAME);
  if (!location) {
    location = await call({
      method: 'POST', path: '/v1/terminal/locations',
      form: { display_name: LOCATION_NAME, address: { line1: '1 Example Street', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' } },
    });
  }
  const readers = await call({ method: 'GET', path: `/v1/terminal/readers?location=${encodeURIComponent(location.id)}&limit=100` });
  let reader = readers.data.find((r) => r.device_type?.startsWith('simulated'));
  if (!reader) {
    reader = await call({ method: 'POST', path: '/v1/terminal/readers', form: { registration_code: 'simulated-wpe', label: LOCATION_NAME, location: location.id } });
  }
  if ((await exitPayments.readerAction(config, account, reader.id))?.status === 'in_progress') {
    await exitPayments.clearReader(config, account, reader.id);
  }
  check(1, Boolean(location.id && reader.id), 'a Location and a simulated reader');

  // 2. The intent, once per case.
  const exitId = randomUUID();
  const body = exitPayments.intentBody({ amountMinor: AMOUNT, currency: 'usd', exitId, garageId: LOCATION_NAME });
  const a = await exitPayments.createIntent(config, account, body, exitId);
  const again = await exitPayments.createIntent(config, account, body, exitId);
  check(2, a.status === 'requires_payment_method' && a.amount === AMOUNT && again.id === a.id
    && a.capture_method === 'automatic' && a.payment_method_types?.includes('card_present'),
  `a card_present intent for ${AMOUNT}, captured at once; asked twice with the case's key, one intent`);

  // 3. On the reader.
  const sent = await exitPayments.sendToReader(config, account, reader.id, a.id);
  const onReader = await exitPayments.readerAction(config, account, reader.id);
  check(3, sent.sent === true && onReader?.status === 'in_progress' && onReader.intent === a.id, "handed to the reader: its action is in progress on the intent");

  // 4. A second intent to the busy reader: refused, never replacing the first.
  const otherCase = randomUUID();
  const b = await exitPayments.createIntent(config, account,
    exitPayments.intentBody({ amountMinor: AMOUNT + 1, currency: 'usd', exitId: otherCase, garageId: LOCATION_NAME }), otherCase);
  let busy = null;
  try {
    await exitPayments.sendToReader(config, account, reader.id, b.id);
  } catch (err) {
    busy = err.code ?? 'error';
  }
  const stillA = await exitPayments.readerAction(config, account, reader.id);
  check(4, busy === 'reader_busy' && stillA?.intent === a.id && stillA.status === 'in_progress',
    `another intent to the busy reader is refused (${busy ?? 'not refused'}), and the first stays on it`);

  // 5. Cleared, and the second canceled with its key; asked again, the same answer.
  await exitPayments.clearReader(config, account, reader.id);
  const cleared = await exitPayments.readerIntent(config, account, reader.id);
  const key = exitPayments.cancelKey(b);
  const canceled = await exitPayments.cancelIntent(config, account, b.id, key);
  const replay = await exitPayments.cancelIntent(config, account, b.id, key);
  check(5, cleared === null && canceled.status === 'canceled' && replay.status === 'canceled',
    'the reader cleared; the second intent canceled, and the same cancel asked again answers the same');

  // 6. A declined card on the first intent.
  await exitPayments.sendToReader(config, account, reader.id, a.id);
  await call({ method: 'POST', path: `/v1/test_helpers/terminal/readers/${encodeURIComponent(reader.id)}/present_payment_method`, form: { type: 'card_present', card_present: { number: DECLINED_CARD } } });
  const declined = await until(() => exitPayments.readIntent(config, account, a.id), (i) => Boolean(i.last_payment_error));
  const failedAction = await exitPayments.readerAction(config, account, reader.id);
  check(6, declined.status === 'requires_payment_method' && Boolean(exitPayments.failureOf(declined)) && failedAction?.status === 'failed',
    `a declined card: the intent waits for another (${exitPayments.failureOf(declined) ?? 'no decline seen'}), the reader's action failed`);

  // 7. A good card on the same intent.
  await exitPayments.sendToReader(config, account, reader.id, a.id);
  await call({ method: 'POST', path: `/v1/test_helpers/terminal/readers/${encodeURIComponent(reader.id)}/present_payment_method`, form: { type: 'card_present' } });
  const paid = await until(() => exitPayments.readIntent(config, account, a.id), (i) => i.status === 'succeeded');
  const doneAction = await exitPayments.readerAction(config, account, reader.id);
  check(7, paid.status === 'succeeded' && paid.amount === AMOUNT && exitPayments.stateOf(paid) === 'succeeded' && doneAction?.status === 'succeeded',
    `the same intent paid, at ${AMOUNT}; the reader's action succeeded`);

  // 8. A paid intent is never canceled.
  let refusedCancel = null;
  try {
    await exitPayments.cancelIntent(config, account, a.id, exitPayments.cancelKey(paid));
  } catch (err) {
    refusedCancel = err instanceof StripeError ? err.code ?? 'refused' : 'error';
  }
  const stillPaid = await exitPayments.readIntent(config, account, a.id);
  check(8, refusedCancel !== null && stillPaid.status === 'succeeded', `a cancel of the paid intent is refused (${refusedCancel ?? 'not refused'}); it stays paid`);

  if (failures) {
    console.error(`\n${failures} check(s) failed: the stand-in's shapes and Stripe's test mode disagree there.`);
    process.exit(1);
  }
  console.log('\nall checks passed against Stripe test mode.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    // Stripe's own code and message; never the key, never a header.
    console.error(`stripe-test-mode-check: stopped: ${err.code ? `${err.code}: ` : ''}${err.message}`);
    process.exit(1);
  });
}
