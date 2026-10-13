/**
 * A rate plan never reaches back into a car that is already parked (U7g,
 * Defect 2).
 *
 * The README promises "A rate change never ... reaches back into a car that is
 * already parked", and the engine keeps that promise by pricing a stay on the
 * plan in force at ENTRY. That is only true while every plan starts in the
 * future of the moment it is saved. The store took any `effective_from`, so a
 * plan dated one hour back was in force at the entry of a car that came in
 * half an hour ago -- and that car's close was priced by it.
 *
 * Measured first, through the real routes and the real engine:
 *
 *   - THE MEASUREMENT: a plan at 2.50 an hour in force; a car in 30 minutes
 *     ago; a plan at 10.00 an hour stored dated one hour back; the car closes
 *     now. Before U7g this close cost 10.00 -- the new plan priced a car that
 *     was already inside. The test asserts what is true NOW: the backdated
 *     plan is refused, and the car pays 2.50.
 *   - a plan dated 2 minutes back is `409 plan_starts_in_the_past`;
 *   - a plan dated now is stored (60 s of clock difference between the
 *     owner's screen and this server are allowed for).
 *
 * U7i, nothing scheduled: a plan starting later than it is saved is
 * `422 rates_start_when_saved`, and a save checked against rates that are no
 * longer the newest is `409 rates_changed_since_check` -- both storing nothing.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, flatHourlyPlan, stateTaxes, storePlan } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import * as ratePlans from '../src/ratePlans.js';

let engine;
let server;
let base;
let tenant;
let operatorToken;

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('plan-start');
  operatorToken = generateDeviceToken();
  await withTenant(tenant, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(operatorToken)]),
  );
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

const op = (method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const device = (token, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ event_id: randomUUID(), ...body }),
  });

/** A garage with both lanes and their computers, taxes stated as none, the drivers answer given. */
async function garage() {
  return withTenant(tenant, async (c) => {
    const g = (
      await c.query(
        `INSERT INTO garages (tenant_id, name, timezone, currency, transient_available)
         VALUES ($1, 'Plan start', 'America/New_York', 'USD', true) RETURNING id`,
        [tenant],
      )
    ).rows[0];
    const lane = async (name, direction) => {
      const id = (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, g.id, name, direction])).rows[0].id;
      const token = generateDeviceToken();
      await c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [tenant, id, name, hashToken(token)]);
      return token;
    };
    await stateTaxes(c, tenant, g.id);
    return { id: g.id, entry: await lane('In', 'entry'), exit: await lane('Out', 'exit') };
  });
}

/** The id of the garage's newest plan, or null: what a save says it was checked against (U7i). */
const newestId = (garageId) => withTenant(tenant, async (c) => (await ratePlans.newestRatePlan(c, tenant, garageId))?.id ?? null);

const save = async (garageId, document, basedOn) =>
  op('POST', `/garages/${garageId}/rate-plans`, { plan: document, confirmed: true, based_on: basedOn === undefined ? await newestId(garageId) : basedOn });

test('THE MEASUREMENT: a plan dated one hour back does not price a car that came in 30 minutes ago', async () => {
  const g = await garage();
  // The plan in force when the car came in, stored on the database's side: the
  // store's route no longer takes a plan dated back, which is the point.
  await withTenant(tenant, async (c) => {
    await storePlan(c, tenant, g.id, flatHourlyPlan({ hourlyMinor: 250, version: 'v-250' }));
    await c.query('UPDATE garages SET activated_at = now() WHERE tenant_id = $1 AND id = $2', [tenant, g.id]);
  });

  const plate = `PS-${randomUUID().slice(0, 8)}`;
  const entryAt = new Date(Date.now() - 30 * 60_000).toISOString();
  assert.equal((await device(g.entry, '/lane/sessions/open', { plate, entry_at: entryAt, entry_confirmation: 'confirmed' })).status, 201);

  const backdated = await save(g.id, flatHourlyPlan({ hourlyMinor: 1000, version: 'v-1000', effectiveFrom: new Date(Date.now() - 60 * 60_000).toISOString() }));
  assert.equal(backdated.status, 409, 'a plan dated one hour back was stored');
  assert.equal((await backdated.json()).code, 'plan_starts_in_the_past');

  const closed = await device(g.exit, '/lane/sessions/close', { plate, exit_at: new Date().toISOString(), exit_confirmation: 'confirmed' });
  assert.equal(closed.status, 200, JSON.stringify(await closed.clone().json()));
  const { session } = await closed.json();
  assert.equal(session.plan_version, 'v-250', 'the car was priced by a plan that started after it came in');
  assert.equal(session.fee_minor, 250);
});

test('a plan dated 2 minutes back is refused by name; one dated now is stored', async () => {
  const g = await garage();
  const back = await save(g.id, flatHourlyPlan({ version: 'v-back', effectiveFrom: new Date(Date.now() - 120_000).toISOString() }));
  assert.equal(back.status, 409);
  const body = await back.json();
  assert.equal(body.code, 'plan_starts_in_the_past');
  assert.match(body.error, /before this server's clock/);
  // CONTROL: now, and a second ago (inside the 60 s allowed for clocks), are stored.
  const now = await save(g.id, flatHourlyPlan({ version: 'v-now', effectiveFrom: new Date().toISOString() }));
  assert.equal(now.status, 201, JSON.stringify(await now.clone().json()));
  const second = await save(g.id, flatHourlyPlan({ version: 'v-second', effectiveFrom: new Date(Date.now() - 1_000).toISOString() }));
  assert.equal(second.status, 201, JSON.stringify(await second.clone().json()));
});

// --- U7i: nothing scheduled, and the rates checked are still the newest ---------

const count = (garageId) => withTenant(tenant, async (c) => Number((await c.query('SELECT count(*) FROM rate_plans WHERE garage_id = $1', [garageId])).rows[0].count));

test('U7i P1: a plan that starts one hour after it is saved is refused by name, and nothing is stored', async () => {
  const g = await garage();
  const later = await save(g.id, flatHourlyPlan({ version: 'v-later', effectiveFrom: new Date(Date.now() + 3600_000).toISOString() }));
  assert.equal(later.status, 422);
  const body = await later.json();
  assert.equal(body.code, 'rates_start_when_saved');
  assert.match(body.error, /after this server's clock/);
  // Two minutes ahead is past the 60 s allowed for clocks, too.
  assert.equal((await save(g.id, flatHourlyPlan({ version: 'v-2min', effectiveFrom: new Date(Date.now() + 120_000).toISOString() }))).status, 422);
  assert.equal(await count(g.id), 0, 'a plan starting later was stored');
  // CONTROL: the same plan starting now, and 30 s ahead (a screen's clock running fast), are stored.
  const now = await save(g.id, flatHourlyPlan({ version: 'v-now', effectiveFrom: new Date().toISOString() }));
  assert.equal(now.status, 201, JSON.stringify(await now.clone().json()));
  const ahead = await save(g.id, flatHourlyPlan({ version: 'v-ahead', effectiveFrom: new Date(Date.now() + 30_000).toISOString() }));
  assert.equal(ahead.status, 201, JSON.stringify(await ahead.clone().json()));
});

test('U7i P2: a save checked against rates that are no longer the newest is refused, and nothing is stored', async () => {
  const g = await garage();
  // The first rates of a garage are checked against none.
  assert.equal((await save(g.id, flatHourlyPlan({ version: 'v-first', effectiveFrom: new Date(Date.now() - 20_000).toISOString() }), null)).status, 201);
  const first = await newestId(g.id);
  // A second owner saves while the first is checking...
  assert.equal((await save(g.id, flatHourlyPlan({ version: 'v-other', effectiveFrom: new Date(Date.now() - 10_000).toISOString() }), first)).status, 201);
  // ...and the first confirms what they checked against the first rates.
  const stale = await save(g.id, flatHourlyPlan({ version: 'v-mine', hourlyMinor: 900, effectiveFrom: new Date().toISOString() }), first);
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.code, 'rates_changed_since_check');
  assert.equal(await count(g.id), 2, 'the stale save was stored');
  // Checked against none, on a garage that has rates: refused too; so is a body with no based_on at all.
  assert.equal((await save(g.id, flatHourlyPlan({ version: 'v-none', effectiveFrom: new Date().toISOString() }), null)).status, 409);
  const missing = await op('POST', `/garages/${g.id}/rate-plans`, { plan: flatHourlyPlan({ version: 'v-missing', effectiveFrom: new Date().toISOString() }), confirmed: true });
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).code, 'rates_changed_since_check');
  assert.equal(await count(g.id), 2);
  // CONTROL: checked again, against the newest, the same plan is stored.
  const fresh = await save(g.id, flatHourlyPlan({ version: 'v-mine', hourlyMinor: 900, effectiveFrom: new Date().toISOString() }), await newestId(g.id));
  assert.equal(fresh.status, 201, JSON.stringify(await fresh.clone().json()));
});

test('U7i P2: a save waits for one in flight on the same garage, then sees it and is refused', async () => {
  const g = await garage();
  assert.equal((await save(g.id, flatHourlyPlan({ version: 'v-base', effectiveFrom: new Date(Date.now() - 20_000).toISOString() }), null)).status, 201);
  const base = await newestId(g.id);
  // Another save in flight: its transaction holds the garage's rates and has
  // stored its plan, not yet committed. The route's save, checked against the
  // same base, must wait for it -- and then find it is no longer the newest.
  let route;
  let settledEarly = false;
  await withTenant(tenant, async (c) => {
    await ratePlans.lockGarageRates(c, g.id);
    await storePlan(c, tenant, g.id, flatHourlyPlan({ version: 'v-in-flight', effectiveFrom: new Date(Date.now() - 5_000).toISOString() }));
    route = save(g.id, flatHourlyPlan({ version: 'v-second', hourlyMinor: 900, effectiveFrom: new Date().toISOString() }), base);
    route.then(() => { settledEarly = true; }, () => { settledEarly = true; });
    await new Promise((r) => setTimeout(r, 750));
    assert.equal(settledEarly, false, 'the second save did not wait for the one in flight');
  });
  const res = await route;
  assert.equal(res.status, 409, JSON.stringify(await res.clone().json()));
  assert.equal((await res.json()).code, 'rates_changed_since_check');
  assert.equal(await count(g.id), 2, 'both saves were stored on the same rates');
});
