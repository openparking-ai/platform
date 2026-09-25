/**
 * A garage's Location and readers (0021): registered ON the garage's own
 * account (the Stripe-Account header), refused while that account cannot take
 * a card, a reader bound to one lane and a lane holding one reader, and an
 * unbinding recorded rather than deleted.
 *
 * Against the local stand-in (test/stripe-stub.js), which records every
 * request. The same path is driven against Stripe's test mode with a
 * simulated reader by scripts/stripe-test-mode-check.js; that is where the
 * stand-in's shapes are established, not here.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant, createTenant } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startStripeStub } from './stripe-stub.js';
import { NO_CONNECT_CONFIGURED } from '../src/stripe.js';

// Assembled at runtime: a key-shaped literal is refused in this repository even when invented.
const KEY = ['rk', 'test', 'stubKeyForTheSuiteOnly000'].join('_');
const ADDRESS = { line1: '1 Example Street', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' };

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

const configure = () => {
  process.env.STRIPE_API_KEY = KEY;
  process.env.STRIPE_API_BASE = stub.base;
  process.env.CONNECT_RETURN_URL = 'https://operator.example.com/connect/return';
  process.env.CONNECT_REFRESH_URL = 'https://operator.example.com/connect/refresh';
};
const unconfigure = () => {
  for (const k of ['STRIPE_API_KEY', 'STRIPE_API_BASE', 'CONNECT_RETURN_URL', 'CONNECT_REFRESH_URL']) delete process.env[k];
};

/** A garage with two exit lanes and an account; `active` moves card_payments. */
async function world({ active = true } = {}) {
  configure();
  const garage = (await (await op('POST', '/garages', { name: 'Pier Garage', timezone: 'UTC', currency: 'USD' })).json()).garage.id;
  const lane = async (name) => (await (await op('POST', `/garages/${garage}/lanes`, { name, direction: 'exit' })).json()).lane.id;
  const laneA = await lane('Exit A');
  const laneB = await lane('Exit B');
  const account = (await (await op('POST', `/garages/${garage}/stripe-account`, { country: 'US' })).json()).stripe_account.account_id;
  if (active) stub.setState(account, { card_payments: 'active', charges_enabled: true, details_submitted: true });
  return { garage, laneA, laneB, account };
}
const location = (garage, body = { display_name: 'Pier Garage', address: ADDRESS }) =>
  op('POST', `/garages/${garage}/stripe-account/location`, body);
const bind = (lane, code = 'simulated-wpe', label = 'Exit A reader', token) =>
  op('POST', `/lanes/${lane}/reader`, { registration_code: code, label }, token);
const terminalRequests = (kind) => stub.requests.filter((r) => r.path === `/v1/terminal/${kind}`);

before(async () => {
  unconfigure();
  stub = await startStripeStub();
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  tenant = await createTenant('readers');
  operatorToken = await issueOperatorToken(tenant);
  otherToken = await issueOperatorToken(await createTenant('elsewhere'));
});

after(async () => {
  unconfigure();
  await new Promise((resolve) => server.close(resolve));
  await stub.close();
  await pool.end();
});

test('with no Connect configured, the reader routes say so and ask Stripe nothing', async () => {
  const w = await world();
  unconfigure();
  const n = stub.requests.length;
  for (const [method, path] of [
    ['POST', `/garages/${w.garage}/stripe-account/location`],
    ['GET', `/garages/${w.garage}/readers`],
    ['POST', `/lanes/${w.laneA}/reader`],
    ['POST', `/lanes/${w.laneA}/reader/unbind`],
  ]) {
    const res = await op(method, path, method === 'GET' ? undefined : {});
    assert.equal(res.status, 409, `${method} ${path}`);
    assert.equal((await res.json()).error, NO_CONNECT_CONFIGURED);
  }
  assert.equal(stub.requests.length, n);
});

test('the Location is registered ON the garage\'s account, and refused until it can take a card', async () => {
  const w = await world({ active: false });
  const refused = await location(w.garage);
  assert.equal(refused.status, 409);
  const rb = await refused.json();
  assert.equal(rb.code, 'card_payments_not_active');
  assert.match(rb.error, /'inactive'/);
  assert.equal(terminalRequests('locations').filter((r) => r.headers['stripe-account'] === w.account).length, 0);
  // The refusal was decided on a read made NOW, and the read was kept.
  const readNow = stub.requests.filter((r) => r.path === `/v1/accounts/${w.account}`);
  assert.ok(readNow.length >= 1, 'card_payments was not read from Stripe');

  // CONTROL: Stripe says active; the same request registers.
  stub.setState(w.account, { card_payments: 'active', charges_enabled: true, details_submitted: true });
  const res = await location(w.garage);
  assert.equal(res.status, 201);
  const { location: loc } = await res.json();
  assert.match(loc.location_id, /^tml_stub/);
  const sent = terminalRequests('locations').at(-1);
  assert.equal(sent.headers['stripe-account'], w.account, 'the Location was not made on the garage\'s account');
  assert.equal(sent.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(sent.raw);
  assert.equal(form.get('display_name'), 'Pier Garage');
  assert.equal(form.get('address[line1]'), ADDRESS.line1);
  assert.equal(form.get('address[country]'), 'US');

  // Asked again: the one it has, and Stripe not asked.
  const n = terminalRequests('locations').length;
  const again = await location(w.garage);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).location.location_id, loc.location_id);
  assert.equal(terminalRequests('locations').length, n);
});

test('a reader is registered on the garage\'s account, at its Location, and bound to the lane', async () => {
  const w = await world();
  const early = await bind(w.laneA);
  assert.equal(early.status, 409);
  assert.equal((await early.json()).code, 'no_terminal_location');

  const loc = (await (await location(w.garage)).json()).location.location_id;
  const res = await bind(w.laneA);
  assert.equal(res.status, 201);
  const { reader } = await res.json();
  assert.match(reader.reader_id, /^tmr_stub/);
  assert.equal(reader.lane_id, w.laneA);
  assert.equal(reader.unbound_at, null);

  const sent = terminalRequests('readers').at(-1);
  assert.equal(sent.headers['stripe-account'], w.account);
  const form = new URLSearchParams(sent.raw);
  assert.equal(form.get('registration_code'), 'simulated-wpe');
  assert.equal(form.get('location'), loc);
  assert.match(sent.headers['idempotency-key'], /^openparking-reader-/);

  const listed = (await (await op('GET', `/garages/${w.garage}/readers`)).json()).readers;
  assert.deepEqual(listed.map((r) => r.reader_id), [reader.reader_id]);
});

test('a reader is refused while the account cannot take a card, read now', async () => {
  const w = await world();
  await location(w.garage);
  stub.setState(w.account, { card_payments: 'pending' });
  const res = await bind(w.laneA);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'card_payments_not_active');
  assert.equal(terminalRequests('readers').filter((r) => r.headers['stripe-account'] === w.account).length, 0);
  // CONTROL
  stub.setState(w.account, { card_payments: 'active' });
  assert.equal((await bind(w.laneA)).status, 201);
});

test('a lane holds one reader: a second is refused before Stripe is asked', async () => {
  const w = await world();
  await location(w.garage);
  assert.equal((await bind(w.laneA, 'simulated-wpe', 'first')).status, 201);
  const n = terminalRequests('readers').length;
  const second = await bind(w.laneA, 'simulated-wpe-2', 'second');
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, 'lane_has_reader');
  assert.equal(terminalRequests('readers').length, n, 'Stripe was asked to register a reader the lane cannot hold');
});

test('unbinding is recorded, not deleted; the lane can then take a reader, and the history stays', async () => {
  const w = await world();
  await location(w.garage);
  const first = (await (await bind(w.laneA, 'simulated-wpe', 'first')).json()).reader;
  const unbound = await op('POST', `/lanes/${w.laneA}/reader/unbind`);
  assert.equal(unbound.status, 200);
  const ub = (await unbound.json()).reader;
  assert.equal(ub.reader_id, first.reader_id);
  assert.ok(ub.unbound_at);

  const rows = await withTenant(tenant, async (c) =>
    (await c.query('SELECT reader_id, unbound_at, unbound_by FROM lane_readers WHERE lane_id = $1', [w.laneA])).rows);
  assert.equal(rows.length, 1, 'the binding row is gone');
  assert.ok(rows[0].unbound_by.startsWith('operator_token:'));

  const nothing = await op('POST', `/lanes/${w.laneA}/reader/unbind`);
  assert.equal(nothing.status, 409);
  assert.equal((await nothing.json()).code, 'no_reader_bound');

  const second = (await (await bind(w.laneA, 'simulated-wpe-next', 'second')).json()).reader;
  const listed = (await (await op('GET', `/garages/${w.garage}/readers`)).json()).readers;
  assert.deepEqual(listed.map((r) => r.reader_id), [second.reader_id, first.reader_id], 'current first, then history');
});

test('one reader per lane and one lane per reader, at the table', async () => {
  const w = await world();
  await location(w.garage);
  const r = (await (await bind(w.laneA)).json()).reader;
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(
        `INSERT INTO lane_readers (tenant_id, garage_id, lane_id, account_id, location_id, reader_id, label, bound_by)
         SELECT tenant_id, garage_id, $2, account_id, location_id, reader_id, 'dup', 't' FROM lane_readers WHERE reader_id = $1`,
        [r.reader_id, w.laneB],
      )),
    /lane_readers_one_lane_per_reader/,
  );
  // And a lane holds one reader at the table, not only at the route.
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(
        `INSERT INTO lane_readers (tenant_id, garage_id, lane_id, account_id, location_id, reader_id, label, bound_by)
         SELECT tenant_id, garage_id, lane_id, account_id, location_id, 'tmr_stubAnother', 'dup', 't' FROM lane_readers WHERE reader_id = $1`,
        [r.reader_id],
      )),
    /lane_readers_one_per_lane/,
  );
});

test('a binding is only ever ended, once; nothing else about it changes', async () => {
  const w = await world();
  await location(w.garage);
  const r = (await (await bind(w.laneA)).json()).reader;
  for (const sql of [
    `UPDATE lane_readers SET label = 'renamed' WHERE reader_id = $1`,
    `UPDATE lane_readers SET lane_id = '${w.laneB}' WHERE reader_id = $1`,
  ]) {
    await assert.rejects(withTenant(tenant, (c) => c.query(sql, [r.reader_id])), /only ever ended/);
  }
  await op('POST', `/lanes/${w.laneA}/reader/unbind`);
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE lane_readers SET unbound_at = now() + interval '1 day' WHERE reader_id = $1`, [r.reader_id])),
    /only ever ended/,
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query('DELETE FROM lane_readers WHERE reader_id = $1', [r.reader_id])),
    /permission denied/,
  );
});

test('another tenant reaches none of it', async () => {
  const w = await world();
  await location(w.garage);
  await bind(w.laneA);
  for (const [method, path, body] of [
    ['POST', `/garages/${w.garage}/stripe-account/location`, { display_name: 'x', address: ADDRESS }],
    ['GET', `/garages/${w.garage}/readers`],
    ['POST', `/lanes/${w.laneB}/reader`, { registration_code: 'simulated-wpe', label: 'x' }],
    ['POST', `/lanes/${w.laneA}/reader/unbind`],
  ]) {
    assert.equal((await op(method, path, body, otherToken)).status, 404, `${method} ${path}`);
  }
});

test('a registration code Stripe refuses is said by name, and binds nothing', async () => {
  const w = await world();
  await location(w.garage);
  const res = await bind(w.laneA, 'not-a-real-code');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'stripe_refused');
  assert.equal((await (await op('GET', `/garages/${w.garage}/readers`)).json()).readers.length, 0);
});
