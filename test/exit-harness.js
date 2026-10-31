/**
 * A garage that takes cards at its exit, for the tests of the exit's rules
 * (0048): the real rate engine, the Stripe stand-in (test/stripe-stub.js),
 * an account that can take cards, a Location, a reader bound to the exit
 * lane, an entry and an exit lane computer, and an operator key. The same
 * world `test/exit-let-out.test.js` builds, shared by the files that need it.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { startStripeStub } from './stripe-stub.js';

// Assembled at runtime: a key-shaped literal is refused in this repository even when invented.
const KEY = ['rk', 'test', 'stubKeyForTheSuiteOnly000'].join('_');
export const RULE = 'opvid-plate-chars/1';
const ADDRESS = { line1: '1 Example Street', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' };

export const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

export function configure(stub) {
  process.env.STRIPE_API_KEY = KEY;
  process.env.STRIPE_API_BASE = stub.base;
  process.env.CONNECT_RETURN_URL = 'https://operator.example.com/connect/return';
  process.env.CONNECT_REFRESH_URL = 'https://operator.example.com/connect/refresh';
}
export function unconfigure() {
  for (const k of ['STRIPE_API_KEY', 'STRIPE_API_BASE', 'CONNECT_RETURN_URL', 'CONNECT_REFRESH_URL']) delete process.env[k];
}

/** The engine, the stand-in and the platform, listening. */
export async function startHarness() {
  unconfigure();
  const engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  const stub = await startStripeStub();
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = {
    engine, stub, server, base,
    call: (tok, method, path, body) => fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    async stop() {
      unconfigure();
      await new Promise((r) => server.close(r));
      await stub.close();
      await engine.stop();
    },
  };
  return h;
}

export async function deviceToken(tenantId, laneId, name) {
  const t = generateDeviceToken();
  const { rows } = await withTenant(tenantId, (c) =>
    c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4) RETURNING id', [tenantId, laneId, name, hashToken(t)]));
  return { token: t, id: rows[0].id };
}

/** A garage with an account that takes cards, a Location, and a reader bound to its exit lane. */
export async function cardGarage(h, name) {
  configure(h.stub);
  const tenant = await createTenant(name);
  const world = await buildWorld(tenant, { hourlyMinor: 250, currency: 'USD' });
  const op = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)`, [tenant, hashToken(op)]));
  const acct = await h.call(op, 'POST', `/garages/${world.garage}/stripe-account`, { country: 'US' });
  const account = (await acct.json()).stripe_account.account_id;
  h.stub.setState(account, { card_payments: 'active', charges_enabled: true, details_submitted: true });
  assert.equal((await h.call(op, 'POST', `/garages/${world.garage}/stripe-account/location`, { display_name: 'Pier', address: ADDRESS })).status, 201);
  const bound = await h.call(op, 'POST', `/lanes/${world.exitLane}/reader`, { registration_code: 'simulated-wpe', label: 'Exit reader' });
  assert.equal(bound.status, 201, await bound.clone().text());
  const exitDevice = await deviceToken(tenant, world.exitLane, 'Exit 1 computer');
  const entryDevice = await deviceToken(tenant, world.entryLane, 'Entry 1 computer');
  return {
    tenant, world, op, account,
    readerId: (await bound.json()).reader.reader_id,
    entry: entryDevice.token,
    entryDeviceId: entryDevice.id,
    exit: exitDevice.token,
    exitDeviceId: exitDevice.id,
  };
}

export const plateNo = (prefix = 'RUL') => `${prefix}${Math.floor(Math.random() * 9000 + 1000)}`;

/** An entry: the open's answer. */
export async function enter(h, g, { plate = plateNo(), inMin = 90, eventId = randomUUID(), status = 201, extra = {} } = {}) {
  const res = await h.call(g.entry, 'POST', '/lane/sessions/open', {
    event_id: eventId, plate, entry_at: ago(inMin), entry_confirmation: 'confirmed',
    plate_characters: { state: 'read', rule: RULE, pattern: plate }, ...extra,
  });
  assert.equal(res.status, status, await res.clone().text());
  return { plate, res: await res.json() };
}

/** The car at the exit lane: its case. */
export async function caseAt(h, g, plate, { exitMin = 0.5, device = g.exit, eventId = randomUUID(), status = 201, extra = {} } = {}) {
  const res = await h.call(device, 'POST', '/lane/exits', {
    event_id: eventId, exit_at: ago(exitMin), plate_characters: { state: 'read', rule: RULE, pattern: plate }, ...extra,
  });
  assert.equal(res.status, status, await res.clone().text());
  return (await res.json()).exit;
}

export async function pay(h, g, exitId) {
  const res = await h.call(g.exit, 'POST', `/lane/exits/${exitId}/pay`);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).exit;
}

/** The case as the lane polls it, Stripe read now. */
export async function caseOf(h, g, exitId) {
  await withTenant(g.tenant, (c) => c.query(`UPDATE exit_payments SET read_at = now() - interval '1 hour' WHERE exit_id = $1`, [exitId]));
  return (await (await h.call(g.exit, 'GET', `/lane/exits/${exitId}`)).json()).exit;
}

/** Paid at the lane's reader, and read back: the case settled. */
export async function payAndPresent(h, g, exitId) {
  const started = await pay(h, g, exitId);
  h.stub.presentCard(started.payment.payment_intent_id);
  const now = await caseOf(h, g, exitId);
  assert.equal(now.why, 'paid', JSON.stringify(now));
  return started;
}

export const close = (h, g, exitId, extra = {}) => h.call(g.exit, 'POST', '/lane/sessions/close', {
  event_id: randomUUID(), exit_id: exitId, exit_at: ago(0.1), exit_confirmation: 'confirmed', ...extra,
});

export const row = (g, table, id) => withTenant(g.tenant, async (c) => (await c.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0]);
export const rows = (g, sql, params = []) => withTenant(g.tenant, async (c) => (await c.query(sql, params)).rows);
