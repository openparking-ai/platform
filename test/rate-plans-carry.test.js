/**
 * CARRIED INTO THE LATER RATES (U7i fix 1, migration 0034).
 *
 * The owner's rule: rates are scheduled to start on a later date; today a
 * change is saved; on that later date the scheduled rates start WITH today's
 * change in them. A later version that has not started has priced nothing, so
 * the save withdraws it and stores its replacement, in one transaction. One
 * that has started is never touched.
 *
 * Against the real engine and the real close, measured:
 *
 *   - A STARTED PLAN IS NEVER WITHDRAWN: the save refuses it 409
 *     plan_already_started and changes nothing; the database refuses the same
 *     UPDATE as the application role, refuses any other UPDATE, and DELETE is
 *     still refused by the grant.
 *   - A WITHDRAWN PLAN NEVER PRICES: once its instant has passed, a stay
 *     entering after it is closed through the lane and priced by the
 *     replacement; `/lane/rules`, the try and the opening readout leave it out.
 *   - ALL OR NOTHING: a carry whose second later version has started is
 *     refused, and the first is NOT left withdrawn, no plan is stored and no
 *     change-log line is written.
 *   - THE SAVE AS THE OWNER MAKES IT: today's plan stored, each later version
 *     withdrawn and its replacement stored at the same instant, each with its
 *     change-log line; the read returns the withdrawn one, marked.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, flatHourlyPlan, stateTaxes, storePlan } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { readout } from '../src/activation.js';
import { startRateEngine } from './rate-engine.js';

const ZONE = 'America/New_York';
let engine;
let server;
let base;
let tenant;

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('carry');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

async function key() {
  const token = generateDeviceToken();
  await withTenant(tenant, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(token)]),
  );
  return token;
}
const as = (token) => async (method, path, body) => {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
};
const device = (token, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify({ event_id: randomUUID(), ...body }) }),
  });

/** A garage with a way in and a way out, no tax, and rates in force since 2000 at $3 an hour. */
async function garage() {
  return withTenant(tenant, async (c) => {
    const g = (await c.query(
      `INSERT INTO garages (tenant_id, name, timezone, currency, transient_available) VALUES ($1, 'Carry', $2, 'USD', true) RETURNING id`,
      [tenant, ZONE],
    )).rows[0];
    const lane = async (name, direction) => {
      const id = (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, g.id, name, direction])).rows[0].id;
      const token = generateDeviceToken();
      await c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [tenant, id, name, hashToken(token)]);
      return token;
    };
    const inForce = await storePlan(c, tenant, g.id, flatHourlyPlan({ hourlyMinor: 300, version: `now-300-${randomUUID().slice(0, 6)}` }));
    await stateTaxes(c, tenant, g.id, { rules: [] });
    await c.query('UPDATE garages SET activated_at = now() WHERE tenant_id = $1 AND id = $2', [tenant, g.id]);
    return { id: g.id, inForce, entry: await lane('In', 'entry'), exit: await lane('Out', 'exit') };
  });
}

const plan = (hourlyMinor, version, effectiveFrom) => flatHourlyPlan({ hourlyMinor, version, effectiveFrom });
const later = (ms) => new Date(Date.now() + ms).toISOString();
const rows = (g) => withTenant(tenant, async (c) => (await c.query(
  `SELECT id, plan_version, effective_from, withdrawn_at, withdrawn_by FROM rate_plans WHERE garage_id = $1 ORDER BY created_at`, [g.id])).rows);
const lines = (g) => withTenant(tenant, async (c) => (await c.query(
  `SELECT action, outcome, subject_id, before, after FROM garage_changes WHERE garage_id = $1 AND outcome = 'done' AND action LIKE 'rate_plan.%' ORDER BY at, id`, [g.id])).rows);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('A STARTED PLAN IS NEVER WITHDRAWN: the save refuses it 409 plan_already_started and changes nothing', async () => {
  const op = as(await key());
  const g = await garage();
  const before = await rows(g);
  const res = await op('POST', `/garages/${g.id}/rate-plans`, {
    plan: plan(400, 'today-400', later(60_000)),
    confirmed: true,
    carry: [{ withdraw: g.inForce, plan: plan(500, 'carried-500', '2000-01-01T00:00:00Z') }],
  });
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.equal(res.json.code, 'plan_already_started');
  assert.deepEqual(await rows(g), before, 'the save changed the plans');
  assert.deepEqual(await lines(g), []);
});

test('the database refuses withdrawing a started plan, any other UPDATE, and DELETE -- as the application role', async () => {
  const g = await garage();
  const future = await withTenant(tenant, (c) => storePlan(c, tenant, g.id, plan(400, 'later-400', later(3_600_000))));
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE rate_plans SET withdrawn_at = now(), withdrawn_by = 'key:x' WHERE id = $1`, [g.inForce])),
    (err) => err.constraint === 'rate_plans_withdrawn_before_start',
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE rate_plans SET document = '{}'::jsonb WHERE id = $1`, [future])),
    /permission denied/i,
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`DELETE FROM rate_plans WHERE id = $1`, [future])),
    /permission denied/i,
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE rate_plans SET withdrawn_at = NULL, withdrawn_by = NULL WHERE id = $1`, [future])),
    (err) => err.constraint === 'rate_plans_never_edited',
  );
  // CONTROL: the same role withdraws the plan that has not started, once.
  await withTenant(tenant, (c) => c.query(`UPDATE rate_plans SET withdrawn_at = now(), withdrawn_by = 'key:x' WHERE id = $1`, [future]));
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE rate_plans SET withdrawn_at = now(), withdrawn_by = 'key:y' WHERE id = $1`, [future])),
    (err) => err.constraint === 'rate_plans_withdrawn_once',
  );
});

test('A WITHDRAWN PLAN NEVER PRICES: after its instant, the close prices a stay by its replacement; /lane/rules, the try and the readout leave it out', async () => {
  const op = as(await key());
  const g = await garage();
  // Later rates at $9 an hour, starting in 4 s.
  const start = later(4_000);
  const scheduled = await op('POST', `/garages/${g.id}/rate-plans`, { plan: plan(900, 'later-900', start), confirmed: true });
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.json));
  // Today's change, carried into them: the later rates become $7.
  const saved = await op('POST', `/garages/${g.id}/rate-plans`, {
    plan: plan(500, 'today-500', later(1_000)),
    confirmed: true,
    carry: [{ withdraw: scheduled.json.rate_plan.id, plan: plan(700, 'later-700', start) }],
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  await sleep(Math.max(0, Date.parse(start) - Date.now()) + 1_500);

  // The close: a car in after the later rates started, out 61 s later.
  const plate = `CARRY-${randomUUID().slice(0, 6)}`;
  const entryAt = new Date(Date.now() - 62_000 > Date.parse(start) ? Date.now() - 62_000 : Date.parse(start) + 500);
  const opened = await device(g.entry, '/lane/sessions/open', { plate, entry_at: entryAt.toISOString(), entry_confirmation: 'confirmed' });
  assert.equal(opened.status, 201, await opened.clone().text());
  const closed = await device(g.exit, '/lane/sessions/close', {
    plate, exit_at: new Date(entryAt.getTime() + 61_000).toISOString(), exit_confirmation: 'confirmed',
  });
  const stay = await closed.json();
  assert.equal(closed.status, 200, JSON.stringify(stay));
  const session = stay.session ?? stay;
  assert.equal(session.plan_version, 'later-700', JSON.stringify(session));
  // Hand sum: 61 s is the first started hour of the replacement, 700 -- not
  // the withdrawn plan's 900, not today's 500.
  assert.equal(session.fee_minor, 700);

  // /lane/rules hands the lane the plans that price, and not the withdrawn one.
  const rulesRes = await device(g.entry, '/lane/rules');
  const rules = await rulesRes.json();
  assert.equal(rulesRes.status, 200, JSON.stringify(rules));
  const served = rules.rate_plans.map((p) => p.plan_version);
  assert.ok(served.includes('later-700'), `the replacement is not served: ${served}`);
  assert.ok(!served.includes('later-900'), `the withdrawn plan is served to the lane: ${served}`);

  // The try prices the same stay the same way.
  // (The try reads minutes, so its car comes in the minute after the start.)
  const tryEntry = new Date(Date.parse(start) + 60_000);
  const tried = await op('POST', `/garages/${g.id}/rate-plans/try`, { stays: [{ entry: local(tryEntry), exit: local(new Date(tryEntry.getTime() + 61 * 60_000)) }] });
  assert.equal(tried.status, 200, JSON.stringify(tried.json));
  assert.equal(tried.json.stays[0].plan_version, 'later-700');
  assert.equal(tried.json.stays[0].fee_minor, 1400, '61 minutes: two started hours of the replacement, 2 × 700');

  // The opening readout counts only the plans that price.
  const facts = await withTenant(tenant, async (c) => {
    const garageRow = (await c.query('SELECT * FROM garages WHERE id = $1', [g.id])).rows[0];
    return (await readout(c, tenant, garageRow)).facts.rate_plans;
  });
  assert.equal(facts.stored, 3, `in force + today + the replacement, not the withdrawn one: ${JSON.stringify(facts)}`);
});

/** An instant as 'YYYY-MM-DDTHH:MM' in the garage's time. */
function local(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

test('ALL OR NOTHING: a carry with one started plan refuses the whole save -- nothing withdrawn, nothing stored, no line', async () => {
  const op = as(await key());
  const g = await garage();
  const first = await op('POST', `/garages/${g.id}/rate-plans`, { plan: plan(900, 'later-900', later(3_600_000)), confirmed: true });
  assert.equal(first.status, 201);
  const before = await rows(g);
  const linesBefore = await lines(g);
  const res = await op('POST', `/garages/${g.id}/rate-plans`, {
    plan: plan(500, 'today-500', later(60_000)),
    confirmed: true,
    carry: [
      { withdraw: first.json.rate_plan.id, plan: plan(700, 'later-700', first.json.rate_plan.effective_from) },
      { withdraw: g.inForce, plan: plan(600, 'old-600', '2000-01-01T00:00:00Z') },
    ],
  });
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.equal(res.json.code, 'plan_already_started');
  assert.deepEqual(await rows(g), before, 'a partial carry was left behind');
  assert.deepEqual(await lines(g), linesBefore);
  // And a replacement the engine refuses refuses the save the same way.
  const bad = await op('POST', `/garages/${g.id}/rate-plans`, {
    plan: plan(500, 'today-500b', later(60_000)),
    confirmed: true,
    carry: [{ withdraw: first.json.rate_plan.id, plan: { ...plan(700, 'later-700b', first.json.rate_plan.effective_from), surprise: 1 } }],
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.json));
  assert.deepEqual(await rows(g), before, 'an engine refusal left a partial carry behind');
});

test('THE SAVE AS THE OWNER MAKES IT: today stored, each later version withdrawn and replaced at its instant, every line written, the read marks the withdrawn one', async () => {
  const op = as(await key());
  const g = await garage();
  const a = await op('POST', `/garages/${g.id}/rate-plans`, { plan: plan(900, 'oct-14', later(2 * 86_400_000)), confirmed: true });
  const b = await op('POST', `/garages/${g.id}/rate-plans`, { plan: plan(950, 'oct-20', later(8 * 86_400_000)), confirmed: true });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const res = await op('POST', `/garages/${g.id}/rate-plans`, {
    plan: plan(500, 'today', later(30_000)),
    confirmed: true,
    carry: [
      { withdraw: a.json.rate_plan.id, plan: plan(700, 'oct-14-carried', a.json.rate_plan.effective_from) },
      { withdraw: b.json.rate_plan.id, plan: plan(750, 'oct-20-carried', b.json.rate_plan.effective_from) },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.deepEqual(res.json.carried.map((c) => [c.withdrawn.plan_version, c.rate_plan.plan_version]), [['oct-14', 'oct-14-carried'], ['oct-20', 'oct-20-carried']]);
  assert.ok(res.json.carried.every((c) => c.withdrawn.withdrawn_at && c.withdrawn.withdrawn_by.startsWith('key:')));

  const read = await op('GET', `/garages/${g.id}/rate-plans`);
  const byName = Object.fromEntries(read.json.rate_plans.map((p) => [p.plan_version, p]));
  assert.ok(byName['oct-14'].withdrawn_at, 'the withdrawn plan is not marked');
  assert.equal(byName['oct-14-carried'].withdrawn_at, null);
  assert.equal(byName['oct-14-carried'].effective_from, byName['oct-14'].effective_from, 'the replacement took another instant');

  const got = (await lines(g)).slice(2).map((l) => [l.action, l.after.plan_version ?? l.after.replaced_by_version]);
  assert.deepEqual(got, [
    ['rate_plan.add', 'today'],
    ['rate_plan.withdraw', 'oct-14-carried'],
    ['rate_plan.add', 'oct-14-carried'],
    ['rate_plan.withdraw', 'oct-20-carried'],
    ['rate_plan.add', 'oct-20-carried'],
  ]);
  // A replacement starts when the plan it replaces would have.
  const moved = await op('POST', `/garages/${g.id}/rate-plans`, {
    plan: plan(500, 'today-2', later(40_000)),
    confirmed: true,
    carry: [{ withdraw: byName['oct-14-carried'].id, plan: plan(700, 'moved', later(3 * 86_400_000)) }],
  });
  assert.equal(moved.status, 409);
  assert.equal(moved.json.code, 'carry_start_differs');
  // A withdrawn plan's name stays taken, for the try as for the store.
  const tried = await op('POST', `/garages/${g.id}/rate-plans/try`, { plan: plan(1, 'oct-14', later(9 * 86_400_000)), stays: [{ entry: '2026-01-05T09:00', exit: '2026-01-05T10:00' }] });
  assert.equal(tried.json.code, 'plan_version_exists');
});

test('THE SAVE REPLACES A LATER VERSION AT ITS OWN START: a carry entry with no plan is replaced by the plan saved', async () => {
  const op = as(await key());
  const g = await garage();
  const a = await op('POST', `/garages/${g.id}/rate-plans`, { plan: plan(900, 'oct-14-x', later(2 * 86_400_000)), confirmed: true });
  const start = a.json.rate_plan.effective_from;
  const res = await op('POST', `/garages/${g.id}/rate-plans`, { plan: plan(800, 'oct-14-changed', start), confirmed: true, carry: [{ withdraw: a.json.rate_plan.id }] });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const byName = Object.fromEntries((await rows(g)).map((r) => [r.plan_version, r]));
  assert.ok(byName['oct-14-x'].withdrawn_at, 'the later version was not withdrawn');
  assert.equal(byName['oct-14-changed'].withdrawn_at, null);
  const got = (await lines(g)).map((l) => [l.action, l.after.plan_version ?? l.after.replaced_by_version]);
  assert.deepEqual(got.slice(-2), [['rate_plan.add', 'oct-14-changed'], ['rate_plan.withdraw', 'oct-14-changed']]);
  // CONTROL: without the carry, the same save is refused -- two versions at one instant.
  const b = await op('POST', `/garages/${g.id}/rate-plans`, { plan: plan(700, 'oct-14-again', start), confirmed: true });
  assert.equal(b.json.code, 'plan_effective_from_taken');
  // A save whose start is not the later version's cannot replace it.
  const moved = await op('POST', `/garages/${g.id}/rate-plans`, { plan: plan(600, 'other-day', later(3 * 86_400_000)), confirmed: true, carry: [{ withdraw: byName['oct-14-changed'].id }] });
  assert.equal(moved.json.code, 'carry_start_differs');
});

test('THE TRY TAKES THE SAME CARRY: a stay after the later date is priced by the rebuilt version, nothing stored', async () => {
  const op = as(await key());
  const g = await garage();
  const a = await op('POST', `/garages/${g.id}/rate-plans`, { plan: plan(900, 'later-try', later(2 * 86_400_000)), confirmed: true });
  const start = a.json.rate_plan.effective_from;
  const after = new Date(Date.parse(start) + 86_400_000);
  const stay = { entry: local(after), exit: local(new Date(after.getTime() + 30 * 60_000)) };
  const before = await rows(g);
  // Without the carry the later version prices it; with it, its replacement does.
  const plain = await op('POST', `/garages/${g.id}/rate-plans/try`, { plan: plan(500, 'today-try', later(60_000)), stays: [stay] });
  assert.equal(plain.json.stays[0].plan_version, 'later-try');
  assert.equal(plain.json.stays[0].fee_minor, 900);
  const carried = await op('POST', `/garages/${g.id}/rate-plans/try`, {
    plan: plan(500, 'today-try', later(60_000)), stays: [stay],
    carry: [{ withdraw: a.json.rate_plan.id, plan: plan(700, 'later-try-carried', start) }],
  });
  assert.equal(carried.status, 200, JSON.stringify(carried.json));
  assert.equal(carried.json.stays[0].plan_version, 'later-try-carried');
  assert.equal(carried.json.stays[0].fee_minor, 700, 'hand sum: 30 minutes is the first started hour of the replacement, 700');
  // Replaced by the draft itself.
  const bySave = await op('POST', `/garages/${g.id}/rate-plans/try`, { plan: plan(650, 'later-try-same', start), stays: [stay], carry: [{ withdraw: a.json.rate_plan.id }] });
  assert.equal(bySave.json.stays[0].plan_version, 'later-try-same');
  assert.equal(bySave.json.stays[0].fee_minor, 650);
  assert.deepEqual(await rows(g), before, 'a try stored something');
  // A carry naming a plan that does not price here is refused by name.
  const unknown = await op('POST', `/garages/${g.id}/rate-plans/try`, { plan: plan(500, 'x-try', later(60_000)), stays: [stay], carry: [{ withdraw: randomUUID(), plan: plan(1, 'y-try', start) }] });
  assert.equal(unknown.json.code, 'plan_not_found');
});
