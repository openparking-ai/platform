/**
 * The close prices through the engine, and a close that cannot price still
 * closes (migration 0013).
 *
 * Every fee here is the REAL engine's answer to the plans this platform
 * stored, driven through `POST /lane/sessions/close` as a lane would drive it.
 * What is measured, in order:
 *
 *   - the fee, the version, the breakdown and the space class are the
 *     engine's and are frozen on the row; the response is the row, not a
 *     recomputation, and a replay echoes what was frozen;
 *   - the ENTRY-TIME RULE is observed through the platform: a stay that
 *     entered under one version and left under a later one prices on the
 *     first, because the whole list went to the engine and the engine chose;
 *   - a later version never reprices a closed stay;
 *   - a garage with no plan closes UNPRICED: 200, no fee, the platform's own
 *     named reason, an event, a line in the reconciliation report -- never a
 *     409, which the lane drops;
 *   - no version in force at entry closes UNPRICED with the engine's finding;
 *   - an engine that cannot be reached is NOT an unpriced close: 5xx, nothing
 *     written, the stay still open, and the same close prices when the
 *     engine is back;
 *   - the garage's space class is what the stay is priced as, and a plan that
 *     does not declare it is refused at the store.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp, CLOSE_UNPRICED_EVENT_KIND, NO_RATE_PLAN_STORED } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';

let engine;
let server;
let base;
let tenant;
let operatorToken;

async function issueToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [
      tenantId, laneId, name, hashToken(token),
    ]),
  );
  return token;
}

async function issueOperatorToken(tenantId) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenantId, hashToken(token)]),
  );
  return token;
}

const asDevice = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ event_id: randomUUID(), ...body }),
});

/** A garage with both lanes, its tokens, and the plans the test names. */
async function garage({ plans = [flatHourlyPlan()], currency = 'USD', spaceClass = undefined } = {}) {
  const created = await withTenant(tenant, async (c) => {
    const g = (
      await c.query(
        `INSERT INTO garages (tenant_id, name, timezone, currency${spaceClass ? ', space_class' : ''})
         VALUES ($1, 'Pricing', 'America/New_York', $2${spaceClass ? ', $3' : ''}) RETURNING id, space_class`,
        spaceClass ? [tenant, currency, spaceClass] : [tenant, currency],
      )
    ).rows[0];
    const lane = async (name, direction) =>
      (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, g.id, name, direction])).rows[0].id;
    const entryLane = await lane('Entry', 'entry');
    const exitLane = await lane('Exit', 'exit');
    for (const p of plans) await storePlan(c, tenant, g.id, p);
    return { id: g.id, spaceClass: g.space_class, entryLane, exitLane };
  });
  return {
    ...created,
    entry: await issueToken(tenant, created.entryLane, 'entry'),
    exit: await issueToken(tenant, created.exitLane, 'exit'),
  };
}

const open = (token, plate, entryAt) =>
  fetch(`${base}/api/v1/lane/sessions/open`, asDevice(token, { plate, entry_at: entryAt, entry_confirmation: 'confirmed' }));
const close = (token, plate, exitAt, extra = {}) =>
  fetch(`${base}/api/v1/lane/sessions/close`, asDevice(token, { plate, exit_at: exitAt, exit_confirmation: 'confirmed', ...extra }));
const plate = () => `PR-${randomUUID().slice(0, 8)}`;

const rowFor = (id) =>
  withTenant(tenant, async (c) => (await c.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0]);
const unpricedEventsFor = (id) =>
  withTenant(tenant, async (c) =>
    (await c.query(`SELECT * FROM events WHERE tenant_id = $1 AND kind = $2 AND detail->>'session_id' = $3`, [tenant, CLOSE_UNPRICED_EVENT_KIND, id])).rows,
  );

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('pricing');
  await buildWorld(tenant);
  operatorToken = await issueOperatorToken(tenant);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

// --- the engine prices, and the row is the record ------------------------------------

test("the fee, the version, the breakdown and the space class are the engine's, frozen on the row and echoed from it", async () => {
  const g = await garage({ plans: [flatHourlyPlan({ hourlyMinor: 400, version: 'v-400' })] });
  const p = plate();
  assert.equal((await open(g.entry, p, '2026-08-26T09:00:00Z')).status, 201);
  const res = await close(g.exit, p, '2026-08-26T11:10:00Z');
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const { session } = await res.json();
  // 2h10m at 400: first hour + 2 more = 1200. The engine's arithmetic, not ours.
  assert.equal(session.fee_minor, 1200);
  assert.equal(session.plan_version, 'v-400');
  assert.equal(session.space_class, 'standard');
  assert.equal(session.pricing_refusal, null);
  assert.equal(session.hourly_minor_applied, null, 'nothing writes the hourly shape any more');
  assert.equal(session.rate_id, null);
  assert.ok(Array.isArray(session.breakdown));
  assert.equal(session.breakdown.reduce((s, l) => s + l.delta_minor, 0), 1200, 'the ledger adds up to the fee');
  assert.ok(session.breakdown.every((l) => typeof l.text === 'string' && l.text.length > 0), 'every line has its sentence');

  // The response IS the row.
  const row = await rowFor(session.id);
  assert.equal(Number(row.fee_minor), 1200);
  assert.deepEqual(row.breakdown, session.breakdown);
  assert.equal(row.plan_version, 'v-400');
  assert.deepEqual(await unpricedEventsFor(session.id), [], 'a priced close leaves no unpriced event');
});

test('a replay echoes what was frozen, and a later version never reprices a closed stay', async () => {
  const g = await garage({ plans: [flatHourlyPlan({ hourlyMinor: 100, version: 'v-100' })] });
  const p = plate();
  await open(g.entry, p, '2026-08-26T09:00:00Z');
  const closeEvent = randomUUID();
  const first = await (await close(g.exit, p, '2026-08-26T10:00:00Z', { event_id: closeEvent })).json();
  assert.equal(first.session.fee_minor, 100);

  // A dearer version, in force since before the stay: the engine WOULD pick
  // it for a new close. The closed stay is not re-asked.
  await withTenant(tenant, (c) =>
    storePlan(c, tenant, g.id, flatHourlyPlan({ hourlyMinor: 900, version: 'v-900', effectiveFrom: '2020-01-01T00:00:00Z' })),
  );
  const replay = await (await close(g.exit, p, '2026-08-26T10:00:00Z', { event_id: closeEvent })).json();
  assert.equal(replay.replay, true);
  assert.equal(replay.session.fee_minor, 100, 'the replay echoes the frozen fee');
  assert.equal(replay.session.plan_version, 'v-100');
  assert.equal(Number((await rowFor(first.session.id)).fee_minor), 100);
});

test('THE ENTRY-TIME RULE, through the platform: a stay entering under v1 and leaving under v2 prices on v1', async () => {
  const g = await garage({
    plans: [
      flatHourlyPlan({ hourlyMinor: 100, version: 'v1', effectiveFrom: '2026-01-01T00:00:00Z' }),
      flatHourlyPlan({ hourlyMinor: 1000, version: 'v2', effectiveFrom: '2026-08-26T12:00:00Z' }),
    ],
  });
  const p = plate();
  await open(g.entry, p, '2026-08-26T11:00:00Z');
  const { session } = await (await close(g.exit, p, '2026-08-26T13:00:00Z')).json();
  assert.equal(session.plan_version, 'v1', 'the version in force at ENTRY priced the whole stay');
  assert.equal(session.fee_minor, 200, 'two hours at v1, not at v2, not split');

  // CONTROL: a stay that entered after v2 took effect prices on v2.
  const q = plate();
  await open(g.entry, q, '2026-08-26T12:30:00Z');
  const later = await (await close(g.exit, q, '2026-08-26T13:00:00Z')).json();
  assert.equal(later.session.plan_version, 'v2');
  assert.equal(later.session.fee_minor, 1000);
});

// --- the close that cannot price closes ---------------------------------------------------

test('a garage with no plan closes the stay UNPRICED: 200, no fee, the reason by name, an event, and a line in the report', async () => {
  const g = await garage({ plans: [] });
  const p = plate();
  await open(g.entry, p, '2026-08-26T09:00:00Z');
  const res = await close(g.exit, p, '2026-08-26T10:00:00Z');
  assert.equal(res.status, 200, 'never a 409 -- the lane drops those and the stay never closes');
  const { session, closed } = await res.json();
  assert.equal(closed, true);
  assert.ok(session.exit_at, 'the stay IS closed');
  assert.equal(session.fee_minor, null);
  assert.equal(session.plan_version, null);
  assert.deepEqual(session.pricing_refusal.map((f) => f.code), [NO_RATE_PLAN_STORED]);
  assert.match(session.pricing_refusal[0].text, /no rate plan stored/);

  const [event] = await unpricedEventsFor(session.id);
  assert.ok(event, 'the record, beside the row');
  assert.equal(event.lane_id, g.exitLane);
  assert.equal(event.detail.actor, 'platform:close');
  assert.deepEqual(event.detail.findings.map((f) => f.code), [NO_RATE_PLAN_STORED]);
  assert.deepEqual(event.detail.plan_versions_offered, []);
  assert.equal(event.detail.space_class, 'standard');

  const report = await (
    await fetch(`${base}/api/v1/garages/${g.id}/reconciliation?max_stay_hours=24&hours=2160`, { headers: { authorization: `Bearer ${operatorToken}` } })
  ).json();
  const listed = report.closes_unpriced.sessions.find((s) => s.session_id === session.id);
  assert.ok(listed, 'the reconciliation report lists it');
  assert.deepEqual(listed.refusal_codes, [NO_RATE_PLAN_STORED]);
  assert.equal('plate' in listed, false, 'and sprays no identity');

  // The car is not counted inside for ever.
  const stillOpen = await withTenant(tenant, async (c) =>
    (await c.query('SELECT count(*) FROM sessions WHERE garage_id = $1 AND exit_at IS NULL', [g.id])).rows[0].count,
  );
  assert.equal(Number(stillOpen), 0);
});

test("no version in force at entry closes UNPRICED with the engine's own finding -- the first morning of a plan", async () => {
  const g = await garage({ plans: [flatHourlyPlan({ version: 'from-sep', effectiveFrom: '2026-09-01T00:00:00-04:00' })] });
  const p = plate();
  await open(g.entry, p, '2026-08-31T23:00:00-04:00');
  const { session } = await (await close(g.exit, p, '2026-09-01T01:00:00-04:00')).json();
  assert.equal(session.fee_minor, null);
  assert.deepEqual(session.pricing_refusal.map((f) => f.code), ['GAP_NO_PLAN_IN_FORCE_AT_ENTRY']);
  assert.match(session.pricing_refusal[0].text, /no plan version was in force at entry/);
  const [event] = await unpricedEventsFor(session.id);
  assert.deepEqual(event.detail.plan_versions_offered, ['from-sep'], 'the record says which versions the engine was given');

  // CONTROL: the next car, entering after midnight, prices.
  const q = plate();
  await open(g.entry, q, '2026-09-01T00:30:00-04:00');
  const next = await (await close(g.exit, q, '2026-09-01T01:00:00-04:00')).json();
  assert.equal(next.session.fee_minor, 250);
  assert.equal(next.session.plan_version, 'from-sep');
  // And the report tells the two mornings apart from a garage with no plan.
  const report = await (
    await fetch(`${base}/api/v1/garages/${g.id}/reconciliation?max_stay_hours=24&hours=2160`, { headers: { authorization: `Bearer ${operatorToken}` } })
  ).json();
  assert.deepEqual(report.closes_unpriced.sessions.map((s) => s.refusal_codes), [['GAP_NO_PLAN_IN_FORCE_AT_ENTRY']]);
});

test('an engine that cannot be reached is NOT an unpriced close: 5xx, nothing written, and the same close prices when it is back', async () => {
  const g = await garage();
  const p = plate();
  await open(g.entry, p, '2026-08-26T09:00:00Z');
  const before = await withTenant(tenant, async (c) =>
    (await c.query('SELECT count(*) FROM events WHERE tenant_id = $1', [tenant])).rows[0].count,
  );
  const live = process.env.RATE_ENGINE_URL;
  const closeEvent = randomUUID();
  try {
    process.env.RATE_ENGINE_URL = 'http://127.0.0.1:1';
    const res = await close(g.exit, p, '2026-08-26T10:00:00Z', { event_id: closeEvent });
    assert.equal(res.status, 500, 'retryable, so the lane keeps the close in its outbox');
    assert.deepEqual(await res.json(), { error: 'internal error' });
  } finally {
    process.env.RATE_ENGINE_URL = live;
  }
  const still = await withTenant(tenant, async (c) =>
    (await c.query('SELECT exit_at, fee_minor, pricing_refusal FROM sessions WHERE garage_id = $1', [g.id])).rows,
  );
  assert.equal(still.length, 1);
  assert.equal(still[0].exit_at, null, 'the stay is still open -- the transaction rolled back');
  assert.equal(still[0].pricing_refusal, null);
  const after = await withTenant(tenant, async (c) =>
    (await c.query('SELECT count(*) FROM events WHERE tenant_id = $1', [tenant])).rows[0].count,
  );
  assert.equal(after, before, 'no event of any kind was written');

  // The lane retries with the SAME event id; the engine is back; it prices.
  const retry = await close(g.exit, p, '2026-08-26T10:00:00Z', { event_id: closeEvent });
  assert.equal(retry.status, 200);
  const { session, replay } = await retry.json();
  assert.equal(replay, false);
  assert.equal(session.fee_minor, 250);
});

// --- the space class --------------------------------------------------------------------

test("the stay is priced as the garage's space class, and a plan that does not declare it is refused at the store", async () => {
  const g = await garage({
    spaceClass: 'vip',
    plans: [{ ...flatHourlyPlan({ hourlyMinor: 700, version: 'vip-plan' }), space_classes: ['standard', 'vip'],
      rules: [
        { ...flatHourlyPlan({ hourlyMinor: 100 }).rules[0], id: 'std', space_classes: ['standard'] },
        { ...flatHourlyPlan({ hourlyMinor: 700 }).rules[0], id: 'vip', space_classes: ['vip'] },
      ] }],
  });
  assert.equal(g.spaceClass, 'vip');
  const p = plate();
  await open(g.entry, p, '2026-08-26T09:00:00Z');
  const { session } = await (await close(g.exit, p, '2026-08-26T10:00:00Z')).json();
  assert.equal(session.space_class, 'vip');
  assert.equal(session.fee_minor, 700, "the vip rule priced it, not the standard one");
  assert.ok(session.breakdown.some((l) => l.rule_id === 'vip'));

  // The store refuses a plan that would refuse every exit here.
  const res = await fetch(`${base}/api/v1/garages/${g.id}/rate-plans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ plan: flatHourlyPlan({ version: 'standard-only', effectiveFrom: '2027-01-01T00:00:00Z' }) }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'plan_does_not_price_garage_space_class');
  assert.match(body.error, /"vip"/);
  // CONTROL: the same plan declaring vip is stored.
  const ok = await fetch(`${base}/api/v1/garages/${g.id}/rate-plans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ plan: flatHourlyPlan({ version: 'vip-only', spaceClass: 'vip', effectiveFrom: '2027-01-01T00:00:00Z' }) }),
  });
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
});

test('a garage names its space class at creation, or gets the one place the default lives; blank is refused', async () => {
  const create = (body) =>
    fetch(`${base}/api/v1/garages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ name: 'G', timezone: 'UTC', currency: 'USD', ...body }),
    });
  assert.equal((await (await create({})).json()).garage.space_class, 'standard');
  assert.equal((await (await create({ space_class: 'compact' })).json()).garage.space_class, 'compact');
  assert.equal((await create({ space_class: '' })).status, 400);
  assert.equal((await create({ space_class: 7 })).status, 400);
});

test('src/fees.js is gone and nothing in src prices outside the engine', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const files = await readdir(new URL('../src', import.meta.url));
  assert.ok(!files.includes('fees.js'));
  for (const f of files) {
    const source = await readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(!/computeFee|billableHours/.test(source), `${f} still prices by the hour`);
  }
  // CONTROL: the sweep sees the engine client, so it is reading the sources.
  const client = await readFile(new URL('../src/ratePlans.js', import.meta.url), 'utf8');
  assert.ok(/\/v1\/quote/.test(client));
});
