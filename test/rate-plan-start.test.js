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
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, flatHourlyPlan, stateTaxes, storePlan } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';

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

const save = (garageId, document) => op('POST', `/garages/${garageId}/rate-plans`, { plan: document, confirmed: true });

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
