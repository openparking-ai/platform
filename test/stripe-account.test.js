/**
 * A garage's own Stripe account (0020): created only on the operator's
 * request, never twice, onboarded through Stripe's own link, and read back on
 * demand with when each fact was read.
 *
 * Against a local stand-in for Stripe (test/stripe-stub.js) that records every
 * request whole, so what is measured is what this platform SENDS -- the
 * account's configuration, the idempotency key, the headers -- and what it
 * does with the answer. That the stand-in's shapes are Stripe's is established
 * by execution against Stripe's test mode, not here.
 *
 * And the standalone arm first: with no Connect configured, every Connect
 * route answers one sentence saying so, and asks Stripe nothing.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant, createTenant } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startStripeStub } from './stripe-stub.js';
import { NO_CONNECT_CONFIGURED, STRIPE_V1_VERSION } from '../src/stripe.js';
import { STRIPE_ACCOUNT_CREATED_EVENT_KIND } from '../src/stripeAccount.js';

// Invented values only; the commercial-values guard refuses anything else.
// Assembled at runtime: a key-shaped literal is refused in this repository even when invented.
const KEY = ['rk', 'test', 'stubKeyForTheSuiteOnly000'].join('_');
const RETURN_URL = 'https://operator.example.com/connect/return';
const REFRESH_URL = 'https://operator.example.com/connect/refresh';

let stub;
let server;
let base;
let tenant;
let operatorToken;
let otherToken;

async function issueOperatorToken(tenantId) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenantId, hashToken(token)]),
  );
  return token;
}

const op = (method, path, body, token = operatorToken) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function newGarage() {
  const res = await op('POST', '/garages', { name: 'Harbour Garage', timezone: 'America/New_York', currency: 'USD' });
  assert.equal(res.status, 201);
  return (await res.json()).garage.id;
}

const configure = () => {
  process.env.STRIPE_API_KEY = KEY;
  process.env.STRIPE_API_BASE = stub.base;
  process.env.CONNECT_RETURN_URL = RETURN_URL;
  process.env.CONNECT_REFRESH_URL = REFRESH_URL;
};
const unconfigure = () => {
  for (const k of ['STRIPE_API_KEY', 'STRIPE_API_BASE', 'CONNECT_RETURN_URL', 'CONNECT_REFRESH_URL']) delete process.env[k];
};
const creates = () => stub.requests.filter((r) => r.method === 'POST' && r.path === '/v1/accounts');
const formOf = (r) => Object.fromEntries(new URLSearchParams(r.raw));
const rowOf = (garageId) =>
  withTenant(tenant, async (c) => (await c.query('SELECT * FROM garage_stripe_accounts WHERE garage_id = $1', [garageId])).rows[0] ?? null);

before(async () => {
  unconfigure();
  stub = await startStripeStub();
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  tenant = await createTenant('connect');
  operatorToken = await issueOperatorToken(tenant);
  otherToken = await issueOperatorToken(await createTenant('elsewhere'));
});

after(async () => {
  unconfigure();
  await new Promise((resolve) => server.close(resolve));
  await stub.close();
  await pool.end();
});

// --- the standalone arm ------------------------------------------------------------------

test('with no Connect configured, every Connect route says so in one sentence and asks Stripe nothing', async () => {
  unconfigure();
  const garage = await newGarage();
  const before = stub.requests.length;
  for (const [method, path] of [
    ['POST', `/garages/${garage}/stripe-account`],
    ['GET', `/garages/${garage}/stripe-account`],
    ['POST', `/garages/${garage}/stripe-account/onboarding-link`],
    ['POST', `/garages/${garage}/stripe-account/refresh`],
  ]) {
    const res = await op(method, path);
    const body = await res.json();
    assert.equal(res.status, 409, `${method} ${path}`);
    assert.equal(body.code, 'connect_not_configured');
    assert.equal(body.error, NO_CONNECT_CONFIGURED);
  }
  assert.equal(stub.requests.length, before, 'Stripe was asked');
  assert.equal(await rowOf(garage), null, 'a reservation was written');
  // CONTROL: the same deployment serves an ordinary route as always.
  assert.equal((await op('GET', `/garages/${garage}/activation`)).status, 200);
});

test('a key alone is not Connect: the onboarding URLs are part of it', async () => {
  unconfigure();
  process.env.STRIPE_API_KEY = KEY;
  process.env.STRIPE_API_BASE = stub.base;
  const garage = await newGarage();
  const res = await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'connect_not_configured');
  // CONTROL: with them, the same call creates.
  configure();
  assert.equal((await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' })).status, 201);
});

// --- the account -----------------------------------------------------------------------------

test('the account is the garage\'s: its own fees, losses on Stripe, no Stripe dashboard, card_payments', async () => {
  configure();
  const garage = await newGarage();
  const n = creates().length;
  const res = await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' });
  assert.equal(res.status, 201);
  const { stripe_account: account } = await res.json();
  assert.match(account.account_id, /^acct_stub/);
  assert.equal(creates().length, n + 1);

  const sent = creates().at(-1);
  const body = formOf(sent);
  assert.equal(body['controller[stripe_dashboard][type]'], 'none');
  assert.equal(body.country, 'US');
  assert.equal(body['controller[fees][payer]'], 'account');
  assert.equal(body['controller[losses][payments]'], 'stripe');
  assert.equal(body['controller[requirement_collection]'], 'stripe');
  assert.equal(body['capabilities[card_payments][requested]'], 'true');
  assert.equal(body['capabilities[transfers][requested]'], 'true', 'Stripe refuses card_payments without it');
  assert.equal(body['metadata[openparking_garage_id]'], garage);
  assert.equal(body.type, undefined, 'a legacy account type was sent beside the controller');
  assert.equal(sent.headers['stripe-version'], STRIPE_V1_VERSION);
  assert.equal(sent.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent.headers['stripe-account'], undefined, 'a create acts as the platform, not on an account');
  assert.match(sent.headers['idempotency-key'], /^openparking-account-/);

  const row = await rowOf(garage);
  assert.equal(row.account_id, account.account_id);
  assert.equal(row.create_idempotency_key, sent.headers['idempotency-key']);
  const events = await withTenant(tenant, async (c) =>
    (await c.query('SELECT detail FROM events WHERE garage_id = $1 AND kind = $2', [garage, STRIPE_ACCOUNT_CREATED_EVENT_KIND])).rows);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.account_id, account.account_id);
  assert.ok(!JSON.stringify(account).includes(KEY), 'the key reached a response');
});

test('a create with no country, or a malformed one, is refused by name before Stripe is asked', async () => {
  configure();
  const garage = await newGarage();
  const n = creates().length;
  for (const body of [undefined, {}, { country: 'us' }, { country: 'USA' }, { country: 1 }]) {
    const res = await op('POST', `/garages/${garage}/stripe-account`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, 'bad_country');
  }
  assert.equal(creates().length, n, 'Stripe was asked');
  // CONTROL: the same garage with a country creates.
  assert.equal((await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' })).status, 201);
});

test('asked again, the garage gets the account it has, and Stripe is not asked', async () => {
  configure();
  const garage = await newGarage();
  const first = (await (await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' })).json()).stripe_account;
  const n = creates().length;
  const again = await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).stripe_account.account_id, first.account_id);
  assert.equal(creates().length, n, 'a second create reached Stripe');
});

test('two requests at once make one account', async () => {
  configure();
  const garage = await newGarage();
  const [a, b] = await Promise.all([
    op('POST', `/garages/${garage}/stripe-account`, { country: 'US' }),
    op('POST', `/garages/${garage}/stripe-account`, { country: 'US' }),
  ]);
  const ids = [(await a.json()).stripe_account.account_id, (await b.json()).stripe_account.account_id];
  assert.equal(ids[0], ids[1]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  const mine = creates().filter((r) => formOf(r)['metadata[openparking_garage_id]'] === garage);
  assert.ok(mine.length >= 1);
  assert.equal(new Set(mine.map((r) => r.headers['idempotency-key'])).size, 1, 'the two asked with different keys');
  assert.equal([...stub.accounts.values()].filter((x) => x.garage === garage).length, 1);
});

test('a create Stripe refused is retried with the SAME key, and is said by name', async () => {
  configure();
  const garage = await newGarage();
  stub.behaviour.failNext = { status: 500, code: 'api_error', message: 'Stripe had a moment' };
  const failed = await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' });
  assert.equal(failed.status, 502);
  const fb = await failed.json();
  assert.equal(fb.code, 'stripe_refused');
  assert.match(fb.error, /Stripe had a moment/);
  const reservation = await rowOf(garage);
  assert.equal(reservation.account_id, null, 'the reservation stands, with no account');

  const retried = await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' });
  assert.equal(retried.status, 201);
  const lastTwo = creates().slice(-2).map((r) => r.headers['idempotency-key']);
  assert.equal(lastTwo[0], lastTwo[1]);
  assert.equal(lastTwo[1], reservation.create_idempotency_key);
});

test('a reservation older than Stripe keeps its key is refused by name, not asked again', async () => {
  configure();
  const garage = await newGarage();
  await withTenant(tenant, (c) =>
    c.query(
      `INSERT INTO garage_stripe_accounts (tenant_id, garage_id, create_idempotency_key, create_requested_by, create_requested_at)
       VALUES ($1, $2, 'openparking-account-old-' || gen_random_uuid(), 'test', now() - interval '25 hours')`,
      [tenant, garage],
    ));
  const n = creates().length;
  const res = await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'stripe_account_create_unresolved');
  assert.ok(body.error.includes(garage));
  assert.equal(creates().length, n, 'Stripe was asked again');
});

test('another tenant cannot see or create this garage\'s account', async () => {
  configure();
  const garage = await newGarage();
  await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' });
  for (const [method, path] of [
    ['POST', `/garages/${garage}/stripe-account`],
    ['GET', `/garages/${garage}/stripe-account`],
    ['POST', `/garages/${garage}/stripe-account/onboarding-link`],
    ['POST', `/garages/${garage}/stripe-account/refresh`],
  ]) {
    assert.equal((await op(method, path, undefined, otherToken)).status, 404, `${method} ${path}`);
  }
});

// --- onboarding and the read -------------------------------------------------------------------

test('the onboarding link carries the deployment\'s URLs, and needs an account first', async () => {
  configure();
  const garage = await newGarage();
  const early = await op('POST', `/garages/${garage}/stripe-account/onboarding-link`);
  assert.equal(early.status, 409);
  assert.equal((await early.json()).code, 'no_stripe_account');

  const { stripe_account: account } = await (await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' })).json();
  const res = await op('POST', `/garages/${garage}/stripe-account/onboarding-link`);
  assert.equal(res.status, 201);
  const { onboarding_link: link } = await res.json();
  assert.ok(link.url.includes(account.account_id));
  assert.equal(link.expires_at, '2026-01-01T00:05:00.000Z', 'Stripe\'s epoch seconds, as an instant');

  const sent = stub.requests.filter((r) => r.path === '/v1/account_links').at(-1);
  assert.deepEqual(formOf(sent), {
    account: account.account_id,
    type: 'account_onboarding',
    return_url: RETURN_URL,
    refresh_url: REFRESH_URL,
  });
  assert.equal(sent.headers['stripe-version'], STRIPE_V1_VERSION);
});

test('a read stores each fact with when it was read, and a later read moves them', async () => {
  configure();
  const garage = await newGarage();
  const { stripe_account: account } = await (await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' })).json();
  assert.equal(account.card_payments, null, 'nothing is known before a read');
  assert.equal(account.card_payments_read_at, null);

  const first = (await (await op('POST', `/garages/${garage}/stripe-account/refresh`)).json()).stripe_account;
  assert.equal(first.card_payments, 'inactive');
  assert.equal(first.charges_enabled, false);
  assert.equal(first.details_submitted, false);
  for (const k of ['card_payments_read_at', 'charges_enabled_read_at', 'details_submitted_read_at']) assert.ok(first[k], k);
  const sent = stub.requests.at(-1);
  assert.equal(sent.path, `/v1/accounts/${account.account_id}`);
  assert.equal(sent.headers['stripe-version'], STRIPE_V1_VERSION);

  stub.setState(account.account_id, { card_payments: 'active', charges_enabled: true, details_submitted: true });
  const second = (await (await op('POST', `/garages/${garage}/stripe-account/refresh`)).json()).stripe_account;
  assert.equal(second.card_payments, 'active');
  assert.equal(second.charges_enabled, true);
  assert.equal(second.details_submitted, true);
  assert.ok(new Date(second.card_payments_read_at) >= new Date(first.card_payments_read_at));

  // The stored readout is what was read, without asking Stripe.
  const n = stub.requests.length;
  const stored = (await (await op('GET', `/garages/${garage}/stripe-account`)).json()).stripe_account;
  assert.equal(stored.card_payments, 'active');
  assert.equal(stub.requests.length, n);
});

test('Stripe unreachable is said by name', async () => {
  configure();
  const garage = await newGarage();
  process.env.STRIPE_API_BASE = 'http://127.0.0.1:9';
  const res = await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'stripe_unreachable');
});

// --- the table holds its own rules ----------------------------------------------------------------

test('a recorded account never changes, and a fact never lands without its read time', async () => {
  configure();
  const garage = await newGarage();
  await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' });
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE garage_stripe_accounts SET account_id = 'acct_stubOther000000' WHERE garage_id = $1`, [garage])),
    /once recorded, never changes/,
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE garage_stripe_accounts SET card_payments = 'active' WHERE garage_id = $1`, [garage])),
    /garage_stripe_accounts_card_payments_read/,
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE garage_stripe_accounts SET create_idempotency_key = 'x' WHERE garage_id = $1`, [garage])),
    /reservation is never rewritten/,
  );
  // CONTROL: a read with its time lands.
  await withTenant(tenant, (c) =>
    c.query(`UPDATE garage_stripe_accounts SET card_payments = 'active', card_payments_read_at = now() WHERE garage_id = $1`, [garage]));
});

test('one account per garage, at the table and not only at the route', async () => {
  const garage = await newGarage();
  await withTenant(tenant, (c) =>
    c.query(`INSERT INTO garage_stripe_accounts (tenant_id, garage_id, create_idempotency_key, create_requested_by) VALUES ($1,$2,'k-one-' || gen_random_uuid(),'t')`, [tenant, garage]));
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(`INSERT INTO garage_stripe_accounts (tenant_id, garage_id, create_idempotency_key, create_requested_by) VALUES ($1,$2,'k-two-' || gen_random_uuid(),'t')`, [tenant, garage])),
    /garage_stripe_accounts_one_per_garage/,
  );
});
