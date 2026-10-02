/**
 * AN ID THAT IS NOT AN ID, AND AN ID THAT NAMES NOTHING.
 *
 * Every path parameter of the operator and lane routers is a uuid. One that is
 * not answers what that route answers for an id that names nothing -- 404 and
 * that route's not-found body; on the lane's validation claim, 409
 * `stay_not_open` -- decided before the handler reads the body and before the
 * database is reached, where it was a 500 (Postgres 22P02).
 *
 * And no id value, malformed or unknown, produces a 500 on any route: adding a
 * lane to a garage that is not there, or a device to a lane that is not there,
 * was a foreign-key violation and a 500; it is a 404.
 *
 * The routes are found by walking the routers, not listed, so a new route with
 * an id is held by the same checks.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp, ID_PARAMS } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, flatHourlyPlan } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { startStripeStub } from './stripe-stub.js';

const CONNECT = {
  STRIPE_API_KEY: ['rk', 'test', 'stubKeyForTheIdsSuite00000'].join('_'),
  CONNECT_RETURN_URL: 'https://operator.example.com/connect/return',
  CONNECT_REFRESH_URL: 'https://operator.example.com/connect/refresh',
};
const MALFORMED = ['not-a-uuid', '123', `${randomUUID()}x`, randomUUID().slice(0, -1), "x'%20OR%20'1'%3D'1", '%00', '%20'];

let app;
let server;
let base;
let engine;
let stub;
let key;
let device;

before(async () => {
  engine = await startRateEngine();
  stub = await startStripeStub();
  app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const tenant = await createTenant('ids');
  const world = await buildWorld(tenant);
  key = generateDeviceToken();
  device = generateDeviceToken();
  await withTenant(tenant, async (c) => {
    await c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(key)]);
    await c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,'ids-exit',$3)`, [tenant, world.exitLane, hashToken(device)]);
  });
});

after(async () => {
  for (const k of ['STRIPE_API_KEY', 'STRIPE_API_BASE', 'CONNECT_RETURN_URL', 'CONNECT_REFRESH_URL', 'RATE_ENGINE_URL']) delete process.env[k];
  await new Promise((r) => server.close(r));
  await engine.stop();
  await stub.close?.();
  await pool.end();
});

/** Every route of the operator and lane routers that has a path parameter. */
function idRoutes() {
  const out = [];
  for (const layer of app._router.stack) {
    if (layer.name !== 'router') continue;
    const source = layer.regexp.source;
    if (source.includes('auth')) continue;
    const router = source.includes('lane') ? 'lane' : 'operator';
    for (const l of layer.handle.stack) {
      if (!l.route) continue;
      const params = [...l.route.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
      if (!params.length) continue;
      for (const method of Object.keys(l.route.methods)) out.push({ router, method: method.toUpperCase(), path: l.route.path, params });
    }
  }
  return out;
}

const prefix = (r) => (r.router === 'lane' ? '/api/v1/lane' : '/api/v1');
const auth = (r) => ({ authorization: `Bearer ${r.router === 'lane' ? device : key}` });

/** A body each route accepts, so an unknown id reaches as far into the route as it can. */
function bodyFor(r, id) {
  const cf = { rules_refreshed_at: 1, stays_refreshed_at: 1, stays_cursor: '1', day: '2026-09-10', clock: 'America/New_York' };
  const bodies = {
    'PATCH /garages/:garageId': { default_action: 'deny' },
    'PUT /garages/:garageId/entitlement-links': { garage_pass: null, monthly_billing: null },
    'PUT /garages/:garageId/validations-link': { validations: null },
    'POST /garages/:garageId/stripe-account': { country: 'US' },
    'POST /garages/:garageId/stripe-account/location': { display_name: 'Ids Garage', address: { line1: '1 Main St', city: 'Springfield', postal_code: '12345', country: 'US' } },
    'POST /lanes/:laneId/reader': { registration_code: 'simulated-wpe' },
    'POST /garages/:garageId/lanes': { name: 'Ids Lane', direction: 'entry' },
    'POST /garages/:garageId/rate-plans': { plan: flatHourlyPlan() },
    'POST /lanes/:laneId/devices': { name: 'ids-device' },
    'POST /garages/:garageId/tax-sets': { tax_set: { effective_from: '2026-01-01T00:00:00Z', rules: [] } },
    'POST /sessions/:sessionId/validation': {
      phone: '(202) 555-0143',
      local_decision: {
        status: 'priced', covered_by: [], matched: [], fee_minor: 500, currency: 'USD', plan_version: 'flat-250-USD', breakdown: [],
        entry_at: '2026-09-10T12:00:00+00:00', exit_at: '2026-09-10T14:00:00+00:00', session_id: id, space_class: 'standard', computed_from: cf, subtotal_minor: 500,
      },
    },
  };
  return bodies[`${r.method} ${r.path}`] ?? {};
}

async function send(r, id, body = bodyFor(r, id)) {
  const path = r.path.replace(/:[A-Za-z]+/g, id) + (r.path.endsWith('/reconciliation') ? '?max_stay_hours=24' : '');
  const res = await fetch(`${base}${prefix(r)}${path}`, {
    method: r.method,
    headers: { ...auth(r), ...(r.method === 'GET' ? {} : { 'content-type': 'application/json' }) },
    ...(r.method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

/** The statements every pg client runs while `fn` runs. */
async function statementsDuring(fn) {
  const seen = [];
  const real = pg.Client.prototype.query;
  pg.Client.prototype.query = function query(q, ...rest) {
    seen.push(typeof q === 'string' ? q : q?.text);
    return real.call(this, q, ...rest);
  };
  try {
    return { result: await fn(), seen };
  } finally {
    pg.Client.prototype.query = real;
  }
}
// Authenticating the caller is the only database work a malformed id may cause.
const AUTH_ONLY = /resolve_operator_token|touch_operator_token|resolve_lane_device|touch_lane_device/;

/** What the route answers for an id that names nothing, as the check states it. */
function expected(r) {
  const err = ID_PARAMS[r.router][r.params[0]](r.path);
  return { status: err.status, text: JSON.stringify(err.code ? { error: err.message, code: err.code } : { error: err.message }) };
}

test('the walk finds every route with an id on both routers, and every parameter is one the check knows', (t) => {
  const routes = idRoutes();
  const unknownParams = routes.flatMap((r) => r.params.filter((p) => !(p in ID_PARAMS[r.router])).map((p) => `${r.router} ${r.path} :${p}`));
  assert.deepEqual(unknownParams, []);
  const count = (router) => {
    const rs = routes.filter((r) => r.router === router);
    return `${rs.length} routes, ${rs.reduce((n, r) => n + r.params.length, 0)} parameters (${[...new Set(rs.flatMap((r) => r.params))].join(', ')})`;
  };
  t.diagnostic(`operator: ${count('operator')}; lane: ${count('lane')}`);
  assert.ok(routes.filter((r) => r.router === 'operator').length >= 20);
  assert.equal(routes.filter((r) => r.router === 'lane').length, 1);
});

test('A MALFORMED ID answers what an id naming nothing answers, before the body and before the database', async () => {
  const wrong = [];
  for (const configured of [false, true]) {
    if (configured) Object.assign(process.env, CONNECT, { STRIPE_API_BASE: stub.base, RATE_ENGINE_URL: engine.url });
    for (const r of idRoutes()) {
      for (const id of MALFORMED) {
        const { result, seen } = await statementsDuring(() => send(r, id));
        const want = expected(r);
        if (result.status !== want.status || result.text !== want.text) wrong.push(`${r.method} ${r.path} [${id}]: ${result.status} ${result.text.slice(0, 80)}`);
        const reached = seen.filter((q) => !AUTH_ONLY.test(q));
        if (reached.length) wrong.push(`${r.method} ${r.path} [${id}] reached the database: ${reached[0].slice(0, 60)}`);
      }
    }
  }
  for (const k of [...Object.keys(CONNECT), 'STRIPE_API_BASE', 'RATE_ENGINE_URL']) delete process.env[k];
  assert.deepEqual(wrong, []);
});

test('the lane\'s validation claim: a malformed stay id is answered exactly as a stay that is not there', async () => {
  const r = idRoutes().find((x) => x.router === 'lane');
  const unknown = await send(r, randomUUID());
  const malformed = await send(r, 'not-a-uuid');
  assert.equal(unknown.status, 409);
  assert.equal(JSON.parse(unknown.text).code, 'stay_not_open');
  assert.deepEqual(malformed, unknown);
});

test('NO ID VALUE PRODUCES A 500: an id naming nothing, with a body each route accepts, with and without Connect and the engine', async () => {
  const fivehundreds = [];
  const seen = {};
  for (const configured of [false, true]) {
    if (configured) Object.assign(process.env, CONNECT, { STRIPE_API_BASE: stub.base, RATE_ENGINE_URL: engine.url });
    for (const r of idRoutes()) {
      const res = await send(r, randomUUID());
      seen[`${configured ? 'on ' : 'off'} ${r.method} ${r.path}`] = res.status;
      if (res.status === 500) fivehundreds.push(`${configured ? 'configured' : 'standalone'} ${r.method} ${r.path}: ${res.status} ${res.text.slice(0, 80)}`);
    }
  }
  for (const k of [...Object.keys(CONNECT), 'STRIPE_API_BASE', 'RATE_ENGINE_URL']) delete process.env[k];
  assert.deepEqual(fivehundreds, []);
  // The two that were foreign-key violations.
  const lanes = await send({ router: 'operator', method: 'POST', path: '/garages/:garageId/lanes' }, randomUUID());
  assert.deepEqual(lanes, { status: 404, text: JSON.stringify({ error: 'garage not found' }) });
  const devices = await send({ router: 'operator', method: 'POST', path: '/lanes/:laneId/devices' }, randomUUID());
  assert.deepEqual(devices, { status: 404, text: JSON.stringify({ error: 'lane not found' }) });
});
