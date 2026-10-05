/**
 * U4 check 6 -- EVERY CHANGE IS LOGGED, AND THE LOG CANNOT BE CHANGED.
 *
 *   - The router's write routes are exactly WRITE_ROUTES (22), and with the
 *     owner's language that is 23 writes. For EVERY one: one change makes
 *     exactly one line, naming who, what, before and after; a request that
 *     changes nothing makes none, on every route that can be asked again.
 *   - For every one that changes something: when its line cannot be written,
 *     the change does not happen.
 *   - Refused attempts land in the right log: with a working sign-in or key,
 *     the garage aimed at (another account's attempt as "outside") and the
 *     caller's own; this account's own cancelled key or ended sign-in, in
 *     this account's log only, named; with no credential, or one that is no
 *     account's, the platform's own security log only, whatever it names.
 *   - Every line names who: an owner by email, a key by its name.
 *   - UPDATE, DELETE and TRUNCATE of either log are refused for the
 *     application's role and for the owner of the tables.
 *   - No password, key, connection code, cookie or session value is in any
 *     line or in anything the server printed.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pool, withTenant, storePlan, flatHourlyPlan, stateTaxes } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { WRITE_ROUTES } from '../src/app.js';
import * as changes from '../src/changes.js';
import { startRateEngine } from './rate-engine.js';
import { startStripeStub } from './stripe-stub.js';
import { startServer, owner, call, newGarage, newLane, linesOf, secrets, signIn, ADMIN_ORIGIN, FOREIGN_ORIGIN } from './u4-world.js';

// Assembled at runtime: a key-shaped literal is refused in this repository even when invented.
const STRIPE_KEY = ['rk', 'test', 'stubKeyForTheChangeLog000'].join('_');
const ADDRESS = { line1: '1 Example Street', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' };

let server;
let base;
let app;
let expressApp;
const STARTED = new Date();
let engine;
let stripe;
let a;
let b;

// Everything the server prints while this file runs, to be scanned at the end.
const printed = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

before(async () => {
  process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return realOut(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { printed.push(String(chunk)); return realErr(chunk, ...rest); };
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  stripe = await startStripeStub();
  ({ server, base, app: expressApp } = await startServer());
  app = server;
  a = await owner(base, 'log-a');
  b = await owner(base, 'log-b');
});

after(async () => {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
  for (const k of ['STRIPE_API_KEY', 'STRIPE_API_BASE', 'CONNECT_RETURN_URL', 'CONNECT_REFRESH_URL']) delete process.env[k];
  if (app) await new Promise((r) => app.close(r));
  await stripe?.close();
  await engine?.stop();
  await pool.end();
});

const connect = () => {
  process.env.STRIPE_API_KEY = STRIPE_KEY;
  process.env.STRIPE_API_BASE = stripe.base;
  process.env.CONNECT_RETURN_URL = 'https://operator.example.com/connect/return';
  process.env.CONNECT_REFRESH_URL = 'https://operator.example.com/connect/refresh';
};

/** Lines of `a` added since `before`. */
async function newLines(since) {
  const all = await linesOf(a.tenant);
  return all.filter((l) => !since.has(l.id));
}
const ids = async () => new Set((await linesOf(a.tenant)).map((l) => l.id));

const one = (tenant, sql, params) => withTenant(tenant, async (c) => (await c.query(sql, params)).rows[0] ?? null);

/** A garage with an account that takes cards (Stripe stand-in), for the payment routes. */
async function paidGarage() {
  connect();
  const g = await newGarage(base, a, { name: 'Paid Garage' });
  const exit = await newLane(base, a, g.id, 'Pay exit', 'exit');
  const r = await call(base, 'POST', `/garages/${g.id}/stripe-account`, { as: a, body: { country: 'US' } });
  assert.equal(r.status, 201, r.text);
  stripe.setState(r.json.stripe_account.account_id, { card_payments: 'active', charges_enabled: true, details_submitted: true });
  return { g, exit, account: r.json.stripe_account.account_id };
}

let planN = 0;
const plan = () => flatHourlyPlan({ version: `log-plan-${(planN += 1)}`, effectiveFrom: new Date(Date.UTC(2020, 0, 1) + planN * 60_000).toISOString() });

/**
 * Every write, as a recipe: how to set it up fresh, the request that makes the
 * change, what its line must say, and -- for the failure half -- the state the
 * change would move, read before and after.
 */
const WRITES = [
  {
    action: 'garage.create',
    setup: async () => ({}),
    run: () => call(base, 'POST', '/garages', { as: a, body: { name: 'Created Garage', timezone: 'America/Chicago', currency: 'USD' } }),
    line: (l) => {
      assert.equal(l.before, null);
      assert.deepEqual([l.after.name, l.after.timezone, l.after.currency], ['Created Garage', 'America/Chicago', 'USD']);
    },
    state: () => one(a.tenant, "SELECT count(*)::int AS n FROM garages WHERE name = 'Created Garage'"),
  },
  {
    action: 'garage.update',
    setup: async () => ({ g: await newGarage(base, a) }),
    run: (s) => call(base, 'PATCH', `/garages/${s.g.id}`, { as: a, body: { transient_available: true } }),
    line: (l) => assert.deepEqual([l.before, l.after], [{ transient_available: null }, { transient_available: true }]),
    state: (s) => one(a.tenant, 'SELECT transient_available FROM garages WHERE id = $1', [s.g.id]),
  },
  {
    action: 'garage.open',
    setup: async () => {
      const g = await newGarage(base, a, { transient_available: false });
      await withTenant(a.tenant, async (c) => { await storePlan(c, a.tenant, g.id, flatHourlyPlan()); await stateTaxes(c, a.tenant, g.id); });
      return { g };
    },
    run: (s) => call(base, 'POST', `/garages/${s.g.id}/activate`, { as: a }),
    line: (l) => assert.deepEqual([l.before, l.after], [{ open: false }, { open: true }]),
    state: (s) => one(a.tenant, 'SELECT activated_at FROM garages WHERE id = $1', [s.g.id]),
  },
  {
    action: 'garage.pass_links',
    setup: async () => ({ g: await newGarage(base, a) }),
    run: (s) => call(base, 'PUT', `/garages/${s.g.id}/entitlement-links`, { as: a, body: { garage_pass: null, monthly_billing: null } }),
    // Stated as it already was -- linked to neither -- so nothing changed: no line.
    noop: true,
  },
  {
    action: 'garage.validations_link',
    setup: async () => ({ g: await newGarage(base, a) }),
    run: (s) => call(base, 'PUT', `/garages/${s.g.id}/validations-link`, { as: a, body: { validations: null } }),
    noop: true,
  },
  {
    action: 'payment_account.create',
    setup: async () => { connect(); return { g: await newGarage(base, a) }; },
    run: (s) => call(base, 'POST', `/garages/${s.g.id}/stripe-account`, { as: a, body: { country: 'US' } }),
    line: (l) => assert.deepEqual([l.before, l.after], [{ account: false }, { account: true }]),
    state: (s) => one(a.tenant, 'SELECT account_id FROM garage_stripe_accounts WHERE garage_id = $1', [s.g.id]).then((r) => r?.account_id ?? null),
  },
  {
    action: 'payment_account.setup_link',
    setup: paidGarage,
    run: (s) => call(base, 'POST', `/garages/${s.g.id}/stripe-account/onboarding-link`, { as: a }),
    // Nothing of the platform's changes -- Stripe made a link -- so no line.
    noop: true,
  },
  {
    action: 'payment_account.read',
    setup: async () => {
      connect();
      const g = await newGarage(base, a);
      const r = await call(base, 'POST', `/garages/${g.id}/stripe-account`, { as: a, body: { country: 'US' } });
      stripe.setState(r.json.stripe_account.account_id, { card_payments: 'active', charges_enabled: true, details_submitted: true });
      return { g };
    },
    run: (s) => call(base, 'POST', `/garages/${s.g.id}/stripe-account/refresh`, { as: a }),
    line: (l) => {
      assert.equal(l.before.charges_enabled, null);
      assert.deepEqual(l.after, { card_payments: 'active', charges_enabled: true, details_submitted: true });
    },
    state: (s) => one(a.tenant, 'SELECT charges_enabled, card_payments FROM garage_stripe_accounts WHERE garage_id = $1', [s.g.id]),
  },
  {
    action: 'payment_account.reader_place',
    setup: paidGarage,
    run: (s) => call(base, 'POST', `/garages/${s.g.id}/stripe-account/location`, { as: a, body: { display_name: 'Paid Garage', address: ADDRESS } }),
    line: (l) => assert.deepEqual([l.before, l.after], [null, { place_name: 'Paid Garage' }]),
    state: (s) => one(a.tenant, 'SELECT count(*)::int AS n FROM garage_terminal_locations WHERE garage_id = $1', [s.g.id]),
  },
  {
    action: 'lane.card_reader_connect',
    setup: async () => {
      const s = await paidGarage();
      assert.equal((await call(base, 'POST', `/garages/${s.g.id}/stripe-account/location`, { as: a, body: { display_name: 'Paid Garage', address: ADDRESS } })).status, 201);
      return s;
    },
    run: (s) => call(base, 'POST', `/lanes/${s.exit.id}/reader`, { as: a, body: { registration_code: 'simulated-wpe', label: 'Exit reader' } }),
    line: (l) => {
      assert.deepEqual([l.before, l.after], [null, { lane: 'Pay exit', label: 'Exit reader' }]);
      assert.ok(!JSON.stringify(l).includes('simulated-wpe'), "the reader's registration code is never in a line");
    },
    state: (s) => one(a.tenant, 'SELECT count(*)::int AS n FROM lane_readers WHERE lane_id = $1 AND unbound_at IS NULL', [s.exit.id]),
  },
  {
    action: 'lane.card_reader_disconnect',
    setup: async () => {
      const s = await paidGarage();
      assert.equal((await call(base, 'POST', `/garages/${s.g.id}/stripe-account/location`, { as: a, body: { display_name: 'Paid Garage', address: ADDRESS } })).status, 201);
      assert.equal((await call(base, 'POST', `/lanes/${s.exit.id}/reader`, { as: a, body: { registration_code: 'simulated-wpe', label: 'Exit reader' } })).status, 201);
      return s;
    },
    run: (s) => call(base, 'POST', `/lanes/${s.exit.id}/reader/unbind`, { as: a }),
    line: (l) => assert.deepEqual([l.before, l.after], [{ label: 'Exit reader' }, null]),
    state: (s) => one(a.tenant, 'SELECT count(*)::int AS n FROM lane_readers WHERE lane_id = $1 AND unbound_at IS NULL', [s.exit.id]),
  },
  {
    action: 'lane.add',
    setup: async () => ({ g: await newGarage(base, a) }),
    run: (s) => call(base, 'POST', `/garages/${s.g.id}/lanes`, { as: a, body: { name: 'West gate', direction: 'entry' } }),
    line: (l) => assert.deepEqual([l.before, l.after, l.subject_name], [null, { name: 'West gate', direction: 'entry' }, 'West gate']),
    state: (s) => one(a.tenant, 'SELECT count(*)::int AS n FROM lanes WHERE garage_id = $1', [s.g.id]),
  },
  {
    action: 'rate_plan.add',
    setup: async () => ({ g: await newGarage(base, a), plan: plan() }),
    run: (s) => call(base, 'POST', `/garages/${s.g.id}/rate-plans`, { as: a, body: { plan: s.plan } }),
    line: (l, s) => assert.deepEqual([l.before, l.after.plan_version], [null, s.plan.plan_version]),
    state: (s) => one(a.tenant, 'SELECT count(*)::int AS n FROM rate_plans WHERE garage_id = $1', [s.g.id]),
  },
  {
    action: 'computer.connect',
    setup: async () => {
      const g = await newGarage(base, a);
      return { g, lane: await newLane(base, a, g.id, 'East gate', 'entry') };
    },
    run: async (s) => {
      const r = await call(base, 'POST', `/lanes/${s.lane.id}/devices`, { as: a, body: { name: 'East pi' } });
      if (r.json?.token) secrets.add(r.json.token);
      return r;
    },
    line: (l) => assert.deepEqual([l.before, l.after], [null, { name: 'East pi', lane: 'East gate' }]),
    state: (s) => one(a.tenant, 'SELECT count(*)::int AS n FROM lane_devices WHERE lane_id = $1', [s.lane.id]),
  },
  {
    action: 'computer.cancel',
    setup: async () => {
      const g = await newGarage(base, a);
      const lane = await newLane(base, a, g.id, 'East gate', 'entry');
      const r = await call(base, 'POST', `/lanes/${lane.id}/devices`, { as: a, body: { name: 'East pi' } });
      secrets.add(r.json.token);
      return { g, device: r.json.device };
    },
    run: (s) => call(base, 'POST', `/devices/${s.device.id}/revoke`, { as: a }),
    line: (l) => assert.deepEqual([l.before, l.after], [{ access: 'connected', lane: 'East gate' }, { access: 'cancelled', lane: 'East gate' }]),
    state: (s) => one(a.tenant, 'SELECT revoked_at FROM lane_devices WHERE id = $1', [s.device.id]),
  },
  {
    action: 'key.cancel',
    setup: async () => {
      const key = generateDeviceToken();
      secrets.add(key);
      const id = (await one(a.tenant, `INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'Old key',$2) RETURNING id`, [a.tenant, hashToken(key)])).id;
      return { id };
    },
    run: (s) => call(base, 'POST', `/operator-tokens/${s.id}/revoke`, { as: a }),
    line: (l) => assert.deepEqual([l.before, l.after, l.subject_name, l.garage_id], [{ access: 'active' }, { access: 'cancelled' }, 'Old key', null]),
    state: (s) => one(a.tenant, 'SELECT revoked_at FROM operator_tokens WHERE id = $1', [s.id]),
  },
  {
    action: 'tax_set.add',
    setup: async () => ({ g: await newGarage(base, a) }),
    run: (s) => call(base, 'POST', `/garages/${s.g.id}/tax-sets`, { as: a, body: { tax_set: { effective_from: '2026-01-01T00:00:00Z', rules: [{ id: 'city', label: 'City parking tax', percent_bp: 1850, rounding: 'nearest', sequence: 1 }] } } }),
    line: (l) => assert.deepEqual([l.before, l.after.taxes], [null, [{ label: 'City parking tax', percent_bp: 1850 }]]),
    state: (s) => one(a.tenant, 'SELECT count(*)::int AS n FROM garage_tax_sets WHERE garage_id = $1', [s.g.id]),
  },
  {
    action: 'lane.rename',
    setup: async () => {
      const g = await newGarage(base, a);
      return { lane: await newLane(base, a, g.id, 'Old name', 'entry') };
    },
    run: (s) => call(base, 'PATCH', `/lanes/${s.lane.id}`, { as: a, body: { name: 'New name' } }),
    line: (l) => assert.deepEqual([l.before, l.after], [{ name: 'Old name' }, { name: 'New name' }]),
    state: (s) => one(a.tenant, 'SELECT name FROM lanes WHERE id = $1', [s.lane.id]),
  },
  {
    action: 'lane.remove',
    setup: async () => {
      const g = await newGarage(base, a);
      return { lane: await newLane(base, a, g.id, 'Spare', 'exit') };
    },
    run: (s) => call(base, 'DELETE', `/lanes/${s.lane.id}`, { as: a }),
    line: (l) => assert.deepEqual([l.before, l.after], [{ name: 'Spare', direction: 'exit' }, null]),
    state: (s) => one(a.tenant, 'SELECT count(*)::int AS n FROM lanes WHERE id = $1', [s.lane.id]),
  },
  {
    action: 'lane.close',
    setup: async () => {
      const g = await newGarage(base, a);
      const lane = await newLane(base, a, g.id, 'North', 'entry');
      await newLane(base, a, g.id, 'South', 'entry');
      return { lane };
    },
    run: (s) => call(base, 'POST', `/lanes/${s.lane.id}/close`, { as: a, body: { reason: 'full', message: 'Garage full' } }),
    line: (l) => assert.deepEqual([l.before, l.after], [{ state: 'open' }, { state: 'closed', reason: 'full', message: 'Garage full' }]),
    state: (s) => one(a.tenant, 'SELECT closed_reason FROM lanes WHERE id = $1', [s.lane.id]),
  },
  {
    action: 'lane.reopen',
    setup: async () => {
      const g = await newGarage(base, a);
      const lane = await newLane(base, a, g.id, 'North', 'entry');
      assert.equal((await call(base, 'POST', `/lanes/${lane.id}/close`, { as: a, body: { reason: 'everyone', message: 'Night', override: true } })).status, 200);
      return { lane };
    },
    run: (s) => call(base, 'POST', `/lanes/${s.lane.id}/reopen`, { as: a }),
    line: (l) => assert.deepEqual([l.before, l.after], [{ state: 'closed', reason: 'everyone', message: 'Night' }, { state: 'open' }]),
    state: (s) => one(a.tenant, 'SELECT closed_reason FROM lanes WHERE id = $1', [s.lane.id]),
  },
  {
    action: 'language.change',
    setup: async () => ({}),
    run: () => call(base, 'PUT', '/auth/language', { as: a, body: { language: 'es' } }),
    line: (l) => assert.deepEqual([l.before, l.after, l.garage_id], [{ language: 'en' }, { language: 'es' }, null]),
    state: () => one(a.tenant, 'SELECT language FROM operator_users WHERE id = $1', [a.userId]),
    after: () => call(base, 'PUT', '/auth/language', { as: a, body: { language: 'en' } }),
  },
];

// The retired rates route is always refused: its one line is the refused line (below).
const ALWAYS_REFUSED = ['rates.retired'];

/** The operator router's routes, as test/owner-sign-in.test.js walks them. */
function routeTable(expressApp) {
  const out = [];
  for (const layer of expressApp._router.stack) {
    if (layer.name !== 'router') continue;
    const source = layer.regexp.source;
    const mount = source.includes('auth') ? '/api/v1/auth' : source.includes('lane') ? '/api/v1/lane' : '/api/v1';
    for (const l of layer.handle.stack) {
      if (!l.route) continue;
      for (const method of Object.keys(l.route.methods)) out.push({ mount, method: method.toUpperCase(), path: l.route.path });
    }
  }
  return out;
}

test('THE LIST: the operator router\'s write routes are exactly WRITE_ROUTES -- 22 -- and every one has a recipe here, or is always refused', () => {
  const writes = routeTable(expressApp).filter((r) => r.mount === '/api/v1' && r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(writes.sort(), WRITE_ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  assert.equal(WRITE_ROUTES.length, 22);
  const covered = new Set([...WRITES.map((w) => w.action), ...ALWAYS_REFUSED]);
  assert.deepEqual(WRITE_ROUTES.map(([, , action]) => action).filter((x) => !covered.has(x)), [], 'a write route with no recipe here');
  // The owner's one write outside the operator router: the language.
  assert.deepEqual(routeTable(expressApp).filter((r) => r.mount === '/api/v1/auth' && r.method === 'PUT').map((r) => r.path), ['/language']);
  assert.equal(WRITES.length, 22, '21 operator writes that can succeed, and the language: 23 writes with the retired rates route');
});

test('EVERY WRITE: one change, exactly one line -- who, what, before and after -- by the session, and by the key the same way', async () => {
  for (const w of WRITES) {
    const s = await w.setup();
    const since = await ids();
    const r = await w.run(s);
    assert.ok(r.status >= 200 && r.status < 300, `${w.action}: ${r.status} ${r.text}`);
    const lines = await newLines(since);
    if (w.noop) {
      assert.equal(lines.length, 0, `${w.action}: it changed nothing, and wrote ${lines.length} lines`);
      continue;
    }
    assert.equal(lines.length, 1, `${w.action}: ${lines.length} lines`);
    const [l] = lines;
    assert.deepEqual([l.outcome, l.action, l.actor_kind, l.actor_id, l.actor_name, l.refusal], ['done', w.action, 'owner', a.userId, a.email, null], w.action);
    assert.ok(l.at instanceof Date);
    w.line(l, s);
    await w.after?.();
  }
  // A key is named by the name it was issued under.
  const g = await newGarage(base, a);
  const since = await ids();
  assert.equal((await call(base, 'POST', `/garages/${g.id}/lanes`, { as: a, via: 'key', body: { name: 'By key', direction: 'exit' } })).status, 201);
  const [byKey] = await newLines(since);
  assert.deepEqual([byKey.actor_kind, byKey.actor_id, byKey.actor_name], ['key', a.keyId, 'Front desk key']);
});

test('A CHANGE WITHOUT ITS LINE CANNOT HAPPEN: with the line made to fail, every write that changes something answers 500 and changes nothing', async () => {
  const real = changes.internals.insert;
  try {
    for (const w of WRITES.filter((x) => x.state && !x.noop)) {
      const s = await w.setup();
      const before = JSON.stringify(await w.state(s));
      changes.internals.insert = async () => { throw new Error('the change log is unavailable'); };
      const r = await w.run(s);
      changes.internals.insert = real;
      assert.equal(r.status, 500, `${w.action}: ${r.status} ${r.text}`);
      assert.equal(JSON.stringify(await w.state(s)), before, `${w.action}: the change happened without its line`);
    }
  } finally {
    changes.internals.insert = real;
  }
});

test('A LINE IS PART OF ITS CHANGE: a transaction that fails after its line was written leaves no line', async () => {
  const g = await newGarage(base, a);
  const since = await ids();
  const ctx = changes.context({ tenantId: a.tenant, actor: { kind: 'owner', id: a.userId, name: a.email } });
  await assert.rejects(withTenant(a.tenant, async (c) => {
    await changes.record(c, ctx, { garageId: g.id, action: 'lane.rename', subject: { kind: 'lane', id: null, name: 'Rolled back' } });
    throw new Error('the change failed after its line');
  }), /failed after its line/);
  assert.deepEqual((await newLines(since)).map((l) => l.subject_name), [], 'a line outlived the change it described');
});

/** The refused lines of a tenant since `since`. */
const refusedSince = async (tenant, since) => (await linesOf(tenant)).filter((l) => !since.has(l.id) && l.outcome === 'refused');
const idsOf = async (tenant) => new Set((await linesOf(tenant)).map((l) => l.id));
const securityRows = () => new pg.Client({ connectionString: process.env.DATABASE_URL });

test("REFUSED ATTEMPTS land in the right log: the wrong site, an ended session, a cancelled key, a forbidden change, another owner's garage, nobody, and nothing", async () => {
  const g = await newGarage(base, a);
  const lane = await newLane(base, a, g.id, 'Only way in', 'entry');
  const exit = await newLane(base, a, g.id, 'Only way out', 'exit');
  const theirs = await newGarage(base, b);
  const theirLane = await newLane(base, b, theirs.id, 'Their lane', 'entry');

  // The wrong site: the owner's own cookie, sent from elsewhere.
  let sinceA = await idsOf(a.tenant);
  assert.equal((await call(base, 'PATCH', `/lanes/${lane.id}`, { as: a, body: { name: 'X' }, origin: FOREIGN_ORIGIN })).status, 403);
  let got = await refusedSince(a.tenant, sinceA);
  assert.deepEqual(got.map((l) => [l.garage_id, l.action, l.refusal, l.actor_kind, l.actor_name, l.subject_name]), [[g.id, 'lane.rename', 'origin_refused', 'owner', a.email, 'Only way in']]);

  // A forbidden change: the last way in, a drivers answer taken back.
  sinceA = await idsOf(a.tenant);
  assert.equal((await call(base, 'POST', `/lanes/${lane.id}/close`, { as: a, body: { reason: 'full', message: 'Full' } })).status, 409);
  assert.equal((await call(base, 'PATCH', `/garages/${g.id}`, { as: a, body: { transient_available: null } })).status, 400);
  got = await refusedSince(a.tenant, sinceA);
  assert.deepEqual(got.map((l) => [l.garage_id, l.action, l.refusal]), [[g.id, 'lane.close', 'last_open_lane'], [g.id, 'garage.update', 'bad_request']]);

  // Another owner's garage: in theirs, and in the asker's own.
  sinceA = await idsOf(a.tenant);
  let sinceB = await idsOf(b.tenant);
  assert.equal((await call(base, 'PATCH', `/lanes/${theirLane.id}`, { as: a, body: { name: 'Mine' } })).status, 404);
  const inTheirs = await refusedSince(b.tenant, sinceB);
  assert.deepEqual(inTheirs.map((l) => [l.garage_id, l.action, l.refusal, l.actor_kind, l.actor_id, l.actor_name, l.subject_name]),
    [[theirs.id, 'lane.rename', 'lane_not_found', 'outside', null, null, 'Their lane']]);
  const inMine = await refusedSince(a.tenant, sinceA);
  assert.deepEqual(inMine.map((l) => [l.garage_id, l.action, l.actor_name, l.subject_kind, l.subject_id, l.subject_name]),
    [[null, 'lane.rename', a.email, 'unknown', null, null]], "the asker's log never names the other account's lane");

  // Another owner's garage, by session and by key: "garage_not_found", and the key named in its own log.
  sinceA = await idsOf(a.tenant);
  sinceB = await idsOf(b.tenant);
  assert.equal((await call(base, 'PATCH', `/garages/${theirs.id}`, { as: a, body: { transient_available: true } })).status, 404);
  assert.equal((await call(base, 'PATCH', `/garages/${theirs.id}`, { as: a, via: 'key', body: { transient_available: false } })).status, 404);
  assert.deepEqual((await refusedSince(b.tenant, sinceB)).map((l) => [l.garage_id, l.refusal, l.actor_kind, l.actor_name, l.subject_name]),
    [[theirs.id, 'garage_not_found', 'outside', null, 'Harbor Garage'], [theirs.id, 'garage_not_found', 'outside', null, 'Harbor Garage']]);
  assert.deepEqual((await refusedSince(a.tenant, sinceA)).map((l) => [l.garage_id, l.refusal, l.actor_kind, l.actor_name]),
    [[null, 'garage_not_found', 'owner', a.email], [null, 'garage_not_found', 'key', 'Front desk key']]);

  // A key refused in its own garage: named by the name it was issued under.
  sinceA = await idsOf(a.tenant);
  assert.equal((await call(base, 'POST', `/lanes/${exit.id}/close`, { as: a, via: 'key', body: { reason: 'full', message: 'Full' } })).status, 409);
  assert.deepEqual((await refusedSince(a.tenant, sinceA)).map((l) => [l.garage_id, l.refusal, l.actor_kind, l.actor_id, l.actor_name]),
    [[g.id, 'last_open_lane', 'key', a.keyId, 'Front desk key']]);

  // This account's own key, cancelled, and its own sign-in, ended, used again:
  // in THIS account's log, named, and in no other's -- a cancelled key used
  // again may be a stolen one. Aimed at another account's lane, it is still
  // only this account's line.
  const cookie = await signIn(base, a.email);
  const ended = { ...a, cookie };
  assert.equal((await call(base, 'POST', '/auth/sign-out', { as: ended })).status, 204);
  const old = generateDeviceToken();
  secrets.add(old);
  const oldId = (await one(a.tenant, `INSERT INTO operator_tokens (tenant_id, name, token_hash, revoked_at) VALUES ($1,'Lost key',$2, now()) RETURNING id`, [a.tenant, hashToken(old)])).id;
  sinceA = await idsOf(a.tenant);
  sinceB = await idsOf(b.tenant);
  const endedR = await call(base, 'PATCH', `/garages/${g.id}`, { as: ended, body: { transient_available: true } });
  assert.deepEqual([endedR.status, endedR.json.code], [401, 'session_ended']);
  assert.equal((await call(base, 'DELETE', `/lanes/${exit.id}`, { as: { key: old }, via: 'key' })).status, 401);
  assert.equal((await call(base, 'PATCH', `/lanes/${theirLane.id}`, { as: { key: old }, via: 'key', body: { name: 'Mine' } })).status, 401);
  assert.equal((await call(base, 'PUT', '/auth/language', { as: ended, body: { language: 'es' } })).status, 401);
  assert.deepEqual((await refusedSince(a.tenant, sinceA)).map((l) => [l.garage_id, l.action, l.refusal, l.actor_kind, l.actor_id, l.actor_name, l.subject_name]), [
    [g.id, 'garage.update', 'session_ended', 'owner', a.userId, a.email, 'Harbor Garage'],
    [g.id, 'lane.remove', 'key_cancelled', 'key', oldId, 'Lost key', 'Only way out'],
    [null, 'lane.rename', 'key_cancelled', 'key', oldId, 'Lost key', null],
    [null, 'language.change', 'session_ended', 'owner', a.userId, a.email, null],
  ]);
  assert.deepEqual(await refusedSince(b.tenant, sinceB), [], "never in the other account's log");

  // No credential at all, or one that is no account's, naming this garage: the
  // platform's own log, never an owner's.
  {
    const client = securityRows();
    await client.connect();
    try {
      const count = async () => (await client.query('SELECT coalesce(sum(attempts), 0)::int AS n FROM platform_security_log')).rows[0].n;
      const was = await count();
      const t0 = (await client.query('SELECT clock_timestamp() AS t')).rows[0].t;
      sinceA = await idsOf(a.tenant);
      assert.equal((await call(base, 'POST', `/lanes/${exit.id}/reopen`)).status, 401);
      assert.equal((await call(base, 'DELETE', `/lanes/${exit.id}`, { as: { key: generateDeviceToken() }, via: 'key' })).status, 401);
      assert.deepEqual(await refusedSince(a.tenant, sinceA), [], "no line in the owner's log");
      // Other suites run beside this one from the same address, so the
      // security log is read for what these did: each on a line of its own
      // kind, or counted on the source's too-many line (0028).
      assert.ok(await count() >= was + 2);
      const touched = (await client.query('SELECT refusal, credential FROM platform_security_log WHERE coalesce(last_at, at) >= $1', [t0])).rows;
      for (const [refusal, credential] of [['not_signed_in', 'none'], ['not_signed_in', 'key']]) {
        assert.ok(touched.some((r) => (r.credential === credential && r.refusal === refusal) || r.refusal === 'too_many_refused'), `${refusal}/${credential} in the security log`);
      }
    } finally {
      await client.end();
    }
  }

  // The owner's language, refused: the account's log.
  sinceA = await idsOf(a.tenant);
  assert.equal((await call(base, 'PUT', '/auth/language', { as: a, body: { language: 'fr' } })).status, 400);
  assert.equal((await call(base, 'PUT', '/auth/language', { as: a, body: { language: 'es' }, origin: FOREIGN_ORIGIN })).status, 403);
  got = await refusedSince(a.tenant, sinceA);
  assert.deepEqual(got.map((l) => [l.garage_id, l.action, l.refusal]), [[null, 'language.change', 'language_refused'], [null, 'language.change', 'origin_refused']]);

  // The retired rates route: refused, in the garage's log.
  sinceA = await idsOf(a.tenant);
  assert.equal((await call(base, 'POST', `/garages/${g.id}/rates`, { as: a, body: {} })).status, 410);
  got = await refusedSince(a.tenant, sinceA);
  assert.deepEqual(got.map((l) => [l.garage_id, l.action, l.refusal]), [[g.id, 'rates.retired', 'rates_retired']]);

  // Nothing named and nobody asking: the platform's own log, and no owner's.
  const client = securityRows();
  await client.connect();
  try {
    // Attempts, not rows: a refusal repeated within a minute is counted on its line (0027).
    const count = async () => (await client.query('SELECT coalesce(sum(attempts), 0)::int AS n FROM platform_security_log')).rows[0].n;
    const was = await count();
    sinceA = await idsOf(a.tenant);
    sinceB = await idsOf(b.tenant);
    assert.equal((await call(base, 'POST', '/garages', { body: { name: 'Nobody', timezone: 'UTC', currency: 'USD' } })).status, 401);
    assert.equal((await call(base, 'DELETE', '/lanes/00000000-0000-4000-8000-000000000000', { body: {} })).status, 401);
    assert.ok(await count() >= was + 2);
    assert.deepEqual([(await refusedSince(a.tenant, sinceA)).length, (await refusedSince(b.tenant, sinceB)).length], [0, 0]);
  } finally {
    await client.end();
  }
});

test('THE READ: changes newest first, the garage and the account, paged; refused attempts apart, with their count; another owner cannot read it', async () => {
  const g = await newGarage(base, a);
  const lane = await newLane(base, a, g.id, 'Paged lane', 'entry');
  for (let i = 0; i < 55; i += 1) assert.equal((await call(base, 'PATCH', `/lanes/${lane.id}`, { as: a, body: { name: `Paged ${i}` } })).status, 200);
  const first = await call(base, 'GET', `/garages/${g.id}/changes`, { as: a });
  assert.equal(first.status, 200);
  assert.equal(first.json.changes.length, 50);
  assert.ok(first.json.next);
  const times = first.json.changes.map((c) => Date.parse(c.at));
  assert.deepEqual(times, [...times].sort((x, y) => y - x), 'newest first');
  assert.deepEqual(first.json.changes[0].after, { name: 'Paged 54' });
  assert.deepEqual(Object.keys(first.json.changes[0]).sort(), ['action', 'after', 'at', 'attempts', 'before', 'garage_id', 'id', 'last_at', 'outcome', 'refusal', 'subject', 'who']);
  assert.deepEqual(first.json.changes[0].who, { kind: 'owner', name: a.email });
  const second = await call(base, 'GET', `/garages/${g.id}/changes/${first.json.next}`, { as: a });
  assert.equal(second.status, 200);
  const seen = new Set(first.json.changes.map((c) => c.id));
  assert.ok(second.json.changes.every((c) => !seen.has(c.id)), 'no line twice');
  assert.ok(second.json.changes.some((c) => c.action === 'garage.create' && c.garage_id === g.id));
  // The account's own lines (the language) are in every garage's log.
  assert.ok([...first.json.changes, ...second.json.changes].every((c) => c.garage_id === g.id || c.garage_id === null));
  assert.deepEqual((await call(base, 'GET', `/garages/${g.id}/changes/00000000-0000-4000-8000-000000000000`, { as: a })).json, { error: 'change not found' });
  assert.equal((await call(base, 'GET', `/garages/${g.id}/changes/not-an-id`, { as: a })).status, 404);
  // Another owner's line is not a page of this log.
  const theirs = (await linesOf(b.tenant))[0];
  assert.equal((await call(base, 'GET', `/garages/${g.id}/changes/${theirs.id}`, { as: a })).status, 404);
  assert.equal((await call(base, 'GET', `/garages/${g.id}/changes`, { as: b })).status, 404);
  const countWas = (await call(base, 'GET', `/garages/${g.id}/refused-attempts`, { as: a })).json.count;
  for (let i = 0; i < 3; i += 1) assert.equal((await call(base, 'PATCH', `/lanes/${lane.id}`, { as: a, body: { name: '' } })).status, 400);
  // A refused attempt is never on the changes page: it cannot push a change out of sight.
  const changesNow = (await call(base, 'GET', `/garages/${g.id}/changes`, { as: a })).json.changes;
  assert.ok(changesNow.every((c) => c.outcome === 'done'));
  assert.deepEqual(changesNow[0].after, { name: 'Paged 54' });
  const refusedNow = await call(base, 'GET', `/garages/${g.id}/refused-attempts`, { as: a });
  assert.equal(refusedNow.status, 200);
  assert.deepEqual(Object.keys(refusedNow.json).sort(), ['count', 'next', 'refused']);
  const latest = refusedNow.json.refused[0];
  assert.deepEqual([latest.outcome, latest.refusal, latest.action, latest.attempts], ['refused', 'lane_name_refused', 'lane.rename', 3]);
  assert.ok(refusedNow.json.refused.every((c) => c.outcome === 'refused'));
  assert.deepEqual(refusedNow.json.count, { lines: countWas.lines + 1, attempts: countWas.attempts + 3 });
  assert.equal((await call(base, 'GET', `/garages/${g.id}/refused-attempts/${first.json.changes[0].id}`, { as: a })).status, 404, 'a change is not a page of the refused attempts');
  assert.equal((await call(base, 'GET', `/garages/${g.id}/refused-attempts`, { as: b })).status, 404);
});

/**
 * Every request that can be asked again and change nothing: it writes no
 * line. Each is set up so the thing is already as asked, then asked.
 */
test('NOTHING CHANGED, NO LINE: every route asked for what is already so writes nothing', async () => {
  const g = await newGarage(base, a, { transient_available: true });
  const lane = await newLane(base, a, g.id, 'Same name', 'entry');
  await newLane(base, a, g.id, 'Other way in', 'entry');
  assert.equal((await call(base, 'POST', `/lanes/${lane.id}/close`, { as: a, body: { reason: 'full', message: 'Full' } })).status, 200);
  const dev = await call(base, 'POST', `/lanes/${lane.id}/devices`, { as: a, body: { name: 'Pi' } });
  secrets.add(dev.json.token);
  assert.equal((await call(base, 'POST', `/devices/${dev.json.device.id}/revoke`, { as: a })).status, 200);
  const k = generateDeviceToken();
  secrets.add(k);
  const kid = (await one(a.tenant, `INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'Spare key',$2) RETURNING id`, [a.tenant, hashToken(k)])).id;
  assert.equal((await call(base, 'POST', `/operator-tokens/${kid}/revoke`, { as: a })).status, 200);
  const open = await newGarage(base, a, { transient_available: false, name: 'Open Garage' });
  await withTenant(a.tenant, async (c) => { await storePlan(c, a.tenant, open.id, flatHourlyPlan()); await stateTaxes(c, a.tenant, open.id); });
  assert.equal((await call(base, 'POST', `/garages/${open.id}/activate`, { as: a })).status, 201);
  const paid = await paidGarage();
  assert.equal((await call(base, 'POST', `/garages/${paid.g.id}/stripe-account/refresh`, { as: a })).status, 200);
  assert.equal((await call(base, 'POST', `/garages/${paid.g.id}/stripe-account/location`, { as: a, body: { display_name: 'Paid Garage', address: ADDRESS } })).status, 201);

  const again = [
    ['the drivers answer, the same', () => call(base, 'PATCH', `/garages/${g.id}`, { as: a, body: { transient_available: true } }), 200],
    ['a rename to the name it has', () => call(base, 'PATCH', `/lanes/${lane.id}`, { as: a, body: { name: 'Same name' } }), 200],
    ['a closing with the same reason and message', () => call(base, 'POST', `/lanes/${lane.id}/close`, { as: a, body: { reason: 'full', message: 'Full' } }), 200],
    ['a cancelled computer cancelled again', () => call(base, 'POST', `/devices/${dev.json.device.id}/revoke`, { as: a }), 200],
    ['a cancelled key cancelled again', () => call(base, 'POST', `/operator-tokens/${kid}/revoke`, { as: a }), 200],
    ['an open garage opened again', () => call(base, 'POST', `/garages/${open.id}/activate`, { as: a }), 200],
    ['the pass links, as they are', () => call(base, 'PUT', `/garages/${g.id}/entitlement-links`, { as: a, body: { garage_pass: null, monthly_billing: null } }), 200],
    ['the validations link, as it is', () => call(base, 'PUT', `/garages/${g.id}/validations-link`, { as: a, body: { validations: null } }), 200],
    ['the payment account asked for again', () => call(base, 'POST', `/garages/${paid.g.id}/stripe-account`, { as: a, body: { country: 'US' } }), 200],
    ['a setup link', () => call(base, 'POST', `/garages/${paid.g.id}/stripe-account/onboarding-link`, { as: a }), 201],
    ['the payment account read again, unchanged', () => call(base, 'POST', `/garages/${paid.g.id}/stripe-account/refresh`, { as: a }), 200],
    ['the reader place asked for again', () => call(base, 'POST', `/garages/${paid.g.id}/stripe-account/location`, { as: a, body: { display_name: 'Paid Garage', address: ADDRESS } }), 200],
    ['the language it already is', () => call(base, 'PUT', '/auth/language', { as: a, body: { language: 'en' } }), 200],
  ];
  for (const [what, run, status] of again) {
    const since = await ids();
    const r = await run();
    assert.equal(r.status, status, `${what}: ${r.status} ${r.text}`);
    assert.deepEqual((await newLines(since)).map((l) => l.action), [], `${what} wrote a line`);
  }
});

test('EVERY LINE NAMES WHO: an owner by email, a key by its name; only another account goes unnamed', async () => {
  const lines = [...(await linesOf(a.tenant)), ...(await linesOf(b.tenant))];
  assert.ok(lines.some((l) => l.actor_kind === 'key' && l.outcome === 'refused'), 'a refused line by a key is among them');
  for (const l of lines) {
    if (l.actor_kind === 'owner') assert.ok(l.actor_name && l.actor_name.includes('@'), `an owner line with no email: ${l.id}`);
    else if (l.actor_kind === 'key') assert.ok(l.actor_name, `a key line with no key name: ${l.id} ${l.outcome} ${l.action}`);
    else assert.deepEqual([l.actor_kind, l.actor_id, l.actor_name], ['outside', null, null], `${l.id}`);
  }
});

test('THE LOG CANNOT BE CHANGED: UPDATE, DELETE and TRUNCATE are refused for the application and for the owner of the tables; the security log is not the application\'s to read', async () => {
  const g = await newGarage(base, a);
  const line = (await linesOf(a.tenant)).find((l) => l.garage_id === g.id);
  for (const sql of ['UPDATE garage_changes SET action = \'garage.edited\' WHERE id = $1', 'DELETE FROM garage_changes WHERE id = $1']) {
    await assert.rejects(withTenant(a.tenant, (c) => c.query(sql, [line.id])), /permission denied/, `app: ${sql}`);
  }
  await assert.rejects(withTenant(a.tenant, (c) => c.query('TRUNCATE garage_changes')), /permission denied/);
  await assert.rejects(pool.query('SELECT * FROM platform_security_log'), /permission denied/);
  await assert.rejects(pool.query("INSERT INTO platform_security_log (refusal, request, credential) VALUES ('x', 'x', 'none')"), /permission denied/);

  const owner = securityRows();
  await owner.connect();
  try {
    for (const sql of [
      ["UPDATE garage_changes SET action = 'garage.edited' WHERE id = $1", [line.id]],
      ['DELETE FROM garage_changes WHERE id = $1', [line.id]],
      ['TRUNCATE garage_changes', []],
      ["UPDATE platform_security_log SET refusal = 'edited'", []],
      ['DELETE FROM platform_security_log', []],
      ['TRUNCATE platform_security_log', []],
    ]) {
      await assert.rejects(owner.query(sql[0], sql[1]), /append-only/, `owner: ${sql[0]}`);
    }
    const still = (await owner.query('SELECT action FROM garage_changes WHERE id = $1', [line.id])).rows[0];
    assert.equal(still.action, 'garage.create');
  } finally {
    await owner.end();
  }
});

test('NO SECRET IN THE LOG OR THE OUTPUT: no password, key, connection code, cookie or session value in any line or anything printed', async () => {
  const owner = securityRows();
  await owner.connect();
  let text;
  try {
    // This file's own owners, and the security log since it began: other
    // suites run beside this one and their lines are theirs to answer for.
    const lines = (await owner.query('SELECT * FROM garage_changes WHERE tenant_id = ANY($1)', [[a.tenant, b.tenant]])).rows;
    const security = (await owner.query('SELECT * FROM platform_security_log WHERE coalesce(last_at, at) >= $1', [STARTED])).rows;
    // One line or more: with every suite's unsigned requests from one address,
    // they may all be counted on that source's one too-many line (0028).
    assert.ok(security.length >= 1, `a scan of ${security.length} security lines`);
    assert.ok(lines.length > 30, `a scan of ${lines.length} lines`);
    text = JSON.stringify([lines, security]);
  } finally {
    await owner.end();
  }
  const out = printed.join('');
  const all = [...secrets].filter(Boolean);
  assert.ok(all.length >= 8, `${all.length} secrets made in this file`);
  const inLog = all.filter((s) => text.includes(s));
  const inOutput = all.filter((s) => out.includes(s));
  assert.deepEqual(inLog.map((s) => `${s.slice(0, 6)}...`), [], 'a secret is in the change log');
  assert.deepEqual(inOutput.map((s) => `${s.slice(0, 6)}...`), [], 'a secret was printed');
  for (const shape of [/opl_[A-Za-z0-9_-]{20,}/, /op_session=/, /scrypt\$/]) {
    assert.equal(shape.test(text), false, `the log holds something shaped like ${shape}`);
  }
});

test('the guard itself: a line holding a credential is refused before it is written, by shape and by the request\'s own value', () => {
  assert.throws(() => changes.assertNoCredential({ after: { code: generateDeviceToken() } }), changes.SecretInLine);
  assert.throws(() => changes.assertNoCredential({ after: { note: 'op_session=abc' } }), changes.SecretInLine);
  assert.throws(() => changes.assertNoCredential({ after: { name: 'a-very-own-value' } }, ['a-very-own-value']), changes.SecretInLine);
  assert.doesNotThrow(() => changes.assertNoCredential({ after: { name: 'A'.repeat(70) } }), 'a long name is not a credential');
  void ADMIN_ORIGIN;
});
