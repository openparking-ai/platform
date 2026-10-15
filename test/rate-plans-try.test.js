/**
 * TRY A STAY (U7g): what a car would pay, through the close's own pricing,
 * with nothing stored. `POST /api/v1/garages/<id>/rate-plans/try`.
 *
 * Against the real engine and the real close, measured:
 *
 *   - THE SAME ANSWER: 50 stays priced by the try on a draft, then the draft
 *     stored and each stay closed through the lane routes -- every fee, every
 *     subtotal and every line identical (check 8). The stays cross the draft's
 *     start, a tax change, a weekend, an early bird, a discount day, grace and
 *     a daily maximum.
 *   - NOTHING STORED: plans, events, change-log lines and stays counted before
 *     and after 20 tries, unchanged (check 9).
 *   - THE DRAFT BESIDE THE STORED PLANS: a draft starting tomorrow prices a car
 *     in today and out tomorrow by TODAY's plan (check 10).
 *   - the refusals: another account's garage 404, a draft the engine cannot
 *     load the store's own 400, one the store would refuse for this garage
 *     the store's own refusal, stays that cannot be read 400, no rates at all
 *     409, the 21st try in a minute 429; a draft with a gap is still tried and
 *     the stay it touches comes back refused with the engine's findings.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, flatHourlyPlan, stateTaxes, storePlan } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { localToInstant } from '../src/garageTime.js';
import { startRateEngine } from './rate-engine.js';

const ZONE = 'America/New_York';
let engine;
let server;
let base;
let tenant;
let other;

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('try');
  other = await createTenant('try-other');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

/** A key of its own for each test: the 20-a-minute limit is per caller. */
async function key(tenantId = tenant) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenantId, hashToken(token)]),
  );
  return token;
}
const as = (token) => (method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const device = (token, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ event_id: randomUUID(), ...body }),
  });

/** A garage with a way in and a way out, each with its computer's code. */
async function garage(tenantId = tenant, { currency = 'USD' } = {}) {
  return withTenant(tenantId, async (c) => {
    const g = (await c.query(
      `INSERT INTO garages (tenant_id, name, timezone, currency, transient_available) VALUES ($1, 'Try', $2, $3, true) RETURNING id`,
      [tenantId, ZONE, currency],
    )).rows[0];
    const lane = async (name, direction) => {
      const id = (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenantId, g.id, name, direction])).rows[0].id;
      const token = generateDeviceToken();
      await c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [tenantId, id, name, hashToken(token)]);
      return token;
    };
    return { id: g.id, entry: await lane('In', 'entry'), exit: await lane('Out', 'exit') };
  });
}

const RESOLUTION = { QUALIFY: { mode: 'cheapest_wins' }, ACCUMULATE: { mode: 'cheapest_wins' } };

/** The draft every check below tries: every kind of rule the Rates form writes. */
function draftPlan({ version = 'draft-2026-04', effectiveFrom = '2026-04-01T00:00:00-04:00' } = {}) {
  return {
    plan_version: version,
    effective_from: effectiveFrom,
    timezone: ZONE,
    currency: 'USD',
    space_classes: ['standard'],
    resolution: RESOLUTION,
    adjust_order: null,
    rules: [
      { id: 'r-grace', type: 'grace', stage: 'QUALIFY', space_classes: ['standard'], minutes: 10 },
      { id: 'r-time', type: 'increment', stage: 'ACCUMULATE', space_classes: ['standard'],
        first_period_minutes: 60, first_period_minor: 800, repeat_period_minutes: 60, repeat_period_minor: 400,
        rounding: 'ceil', max_duration_minutes: null },
      { id: 'r-day', type: 'daily_max', stage: 'CAP', space_classes: ['standard'], max_minor: 3000, day_boundary: 'calendar_day' },
      { id: 's-early', type: 'time_window', stage: 'QUALIFY', space_classes: ['standard'], label: 'Early bird',
        applies_on: { kind: 'days_of_week', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
        enter_from: '06:00', enter_by: '09:00', exit_by: '18:00', day_span: 'same_day',
        effect: { kind: 'flat', price_minor: 1500 } },
      { id: 's-weekend', type: 'time_window', stage: 'QUALIFY', space_classes: ['standard'], label: 'Weekend',
        applies_on: { kind: 'days_of_week', days: ['sat', 'sun'] },
        enter_from: '00:00', enter_by: '23:59', exit_by: '23:59', day_span: 'next_day',
        effect: { kind: 'flat', price_minor: 2000 } },
      { id: 's-wednesday', type: 'time_window', stage: 'ADJUST', space_classes: ['standard'], label: 'Wednesday 10% off',
        applies_on: { kind: 'days_of_week', days: ['wed'] },
        enter_from: '00:00', enter_by: '23:59', exit_by: '23:59', day_span: 'any_span',
        effect: { kind: 'adjust', direction: 'discount', amount: { kind: 'percent', percent_bp: 1000 }, rounding: 'down' } },
    ],
    decisions: [],
  };
}

/** 'YYYY-MM-DDTHH:MM' in the garage's time, plus minutes, in the garage's time. */
function plus(local, minutes) {
  const at = new Date(localToInstant(local, ZONE).getTime() + minutes * 60_000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * 50 stays: before the draft starts and after, on weekdays, a Wednesday and a
 * weekend, under each tax set and across the change, inside grace and one
 * minute over, an early bird inside and out, a day's maximum and a week.
 */
function fiftyStays() {
  const days = ['2026-03-30', '2026-04-01', '2026-04-04', '2026-04-30', '2026-05-06', '2026-06-13', '2026-06-16'];
  const shapes = [['07:30', 10], ['07:30', 11], ['08:59', 540], ['09:01', 540], ['12:00', 61], ['12:00', 180], ['22:30', 1500]];
  const stays = [];
  for (const day of days) for (const [time, minutes] of shapes) {
    const entry = `${day}T${time}`;
    stays.push({ entry, exit: plus(entry, minutes) });
  }
  stays.push({ entry: '2026-06-20T10:00', exit: plus('2026-06-20T10:00', 7 * 1440) });
  assert.equal(stays.length, 50);
  return stays;
}

const TAX_A = { id: 'city', label: 'City tax', percent_bp: 800, rounding: 'nearest', sequence: 1 };
const TAX_B = { id: 'city', label: 'City tax', percent_bp: 1000, rounding: 'nearest', sequence: 1 };

test('THE SAME ANSWER: 50 stays priced by the try, then closed through the lane after the draft is stored -- every fee and every line identical', async () => {
  const op = as(await key());
  const g = await garage();
  await withTenant(tenant, async (c) => {
    await storePlan(c, tenant, g.id, flatHourlyPlan({ hourlyMinor: 300, version: 'old-300', effectiveFrom: '2026-01-01T05:00:00Z' }));
    await stateTaxes(c, tenant, g.id, { rules: [TAX_A] });
    await stateTaxes(c, tenant, g.id, { rules: [TAX_B], effectiveFrom: '2026-05-01T04:00:00Z' });
  });
  const stays = fiftyStays();
  const tried = await op('POST', `/garages/${g.id}/rate-plans/try`, { plan: draftPlan(), stays });
  assert.equal(tried.status, 200, JSON.stringify(await tried.clone().json()));
  const answer = await tried.json();
  assert.deepEqual(answer.draft_findings, []);
  assert.equal(answer.stays.length, 50);
  assert.deepEqual(answer.stays.filter((s) => s.refused), [], 'a stay was refused');
  // The premises, so "identical" is not bought by fifty copies of one case.
  const versions = new Set(answer.stays.map((s) => s.plan_version));
  assert.deepEqual([...versions].sort(), ['draft-2026-04', 'old-300'], 'both plans priced something');
  const specials = new Set(answer.stays.map((s) => s.special?.rule_id ?? 'none'));
  for (const id of ['r-grace', 's-early', 's-weekend', 'none']) assert.ok(specials.has(id), `no stay was priced by ${id}`);
  assert.ok(answer.stays.some((s) => s.adjustments.some((a) => a.rule_id === 's-wednesday')), 'the Wednesday discount never applied');
  assert.ok(answer.stays.some((s) => s.rate_lines.some((l) => l.rule_id === 'r-day' && l.delta_minor < 0)), 'the daily maximum never took over');
  const rates = new Set(answer.stays.flatMap((s) => s.tax_lines.map((l) => l.text)));
  assert.ok(rates.size >= 2, `one tax set taxed everything: ${[...rates]}`);

  // Now save it as the close will read it -- on the database's side: the
  // route refuses a plan that starts in the past, and these stays are past.
  await withTenant(tenant, async (c) => {
    await storePlan(c, tenant, g.id, draftPlan());
    await c.query('UPDATE garages SET activated_at = now() WHERE tenant_id = $1 AND id = $2', [tenant, g.id]);
  });
  for (const [i, stay] of stays.entries()) {
    const plate = `TRY-${i}-${randomUUID().slice(0, 6)}`;
    const opened = await device(g.entry, '/lane/sessions/open', {
      plate, entry_at: localToInstant(stay.entry, ZONE).toISOString(), entry_confirmation: 'confirmed',
    });
    assert.equal(opened.status, 201, `stay ${i} open: ${await opened.clone().text()}`);
    const closed = await device(g.exit, '/lane/sessions/close', {
      plate, exit_at: localToInstant(stay.exit, ZONE).toISOString(), exit_confirmation: 'confirmed',
    });
    assert.equal(closed.status, 200, `stay ${i} close: ${await closed.clone().text()}`);
    const { session } = await closed.json();
    const t = answer.stays[i];
    const where = `stay ${i} (${stay.entry} -> ${stay.exit})`;
    assert.equal(session.fee_minor, t.fee_minor, `${where}: the driver pays a different amount`);
    assert.equal(session.subtotal_minor, t.subtotal_minor, `${where}: subtotal`);
    assert.equal(session.plan_version, t.plan_version, `${where}: plan`);
    assert.deepEqual(session.breakdown, [...t.rate_lines, ...t.tax_lines], `${where}: the lines`);
  }
});

test('NOTHING STORED: 20 tries leave plans, events, change-log lines and stays exactly as they were; the 21st in the minute is refused', async () => {
  const op = as(await key());
  const g = await garage();
  await withTenant(tenant, async (c) => {
    await storePlan(c, tenant, g.id, flatHourlyPlan({ version: 'v-count', effectiveFrom: '2026-01-01T05:00:00Z' }));
    await stateTaxes(c, tenant, g.id, { rules: [TAX_A] });
  });
  const counts = () => withTenant(tenant, async (c) => (await c.query(
    `SELECT (SELECT count(*) FROM rate_plans WHERE tenant_id = $1)::int AS plans,
            (SELECT count(*) FROM events WHERE tenant_id = $1)::int AS events,
            (SELECT count(*) FROM garage_changes WHERE tenant_id = $1)::int AS changes,
            (SELECT count(*) FROM sessions WHERE tenant_id = $1)::int AS stays`,
    [tenant],
  )).rows[0]);
  const before = await counts();
  for (let i = 0; i < 20; i += 1) {
    const res = await op('POST', `/garages/${g.id}/rate-plans/try`, {
      ...(i % 2 ? { plan: draftPlan({ version: `d-${i}` }) } : {}),
      stays: [{ entry: '2026-06-16T08:00', exit: '2026-06-16T12:30' }],
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  }
  assert.deepEqual(await counts(), before, 'a try stored something');
  const limited = await op('POST', `/garages/${g.id}/rate-plans/try`, { stays: [{ entry: '2026-06-16T08:00', exit: '2026-06-16T09:00' }] });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'too_many_tries');
  assert.deepEqual(await counts(), before, 'and the refusal wrote nothing either');
  // CONTROL: the limit is per caller -- another key is not held back.
  assert.equal((await as(await key())('POST', `/garages/${g.id}/rate-plans/try`, { stays: [{ entry: '2026-06-16T08:00', exit: '2026-06-16T09:00' }] })).status, 200);
});

test("THE DRAFT BESIDE THE STORED PLANS: a draft starting tomorrow prices a car in today and out tomorrow by today's plan", async () => {
  const op = as(await key());
  const g = await garage();
  await withTenant(tenant, (c) => storePlan(c, tenant, g.id, flatHourlyPlan({ hourlyMinor: 300, version: 'today-300', effectiveFrom: '2026-01-01T05:00:00Z' })));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
  const tomorrow = plus(`${today}T12:00`, 1440).slice(0, 10);
  const draft = draftPlan({ version: 'tomorrow', effectiveFrom: localToInstant(`${tomorrow}T00:00`, ZONE).toISOString() });
  const res = await op('POST', `/garages/${g.id}/rate-plans/try`, {
    plan: draft,
    stays: [{ entry: `${today}T20:00`, exit: `${tomorrow}T10:00` }, { entry: `${tomorrow}T12:00`, exit: `${tomorrow}T13:30` }],
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const [overnight, after] = (await res.json()).stays;
  assert.equal(overnight.refused, false, JSON.stringify(overnight));
  assert.equal(overnight.plan_version, 'today-300', 'the car already inside was priced by the draft');
  assert.equal(overnight.subtotal_minor, 14 * 300);
  // CONTROL: a car that comes in after the draft starts is priced by it.
  assert.equal(after.plan_version, 'tomorrow');
});

test('a garage whose taxes are not stated yet is tried without tax, and says so', async () => {
  const op = as(await key());
  const g = await garage();
  const res = await op('POST', `/garages/${g.id}/rate-plans/try`, { plan: draftPlan(), stays: [{ entry: '2026-06-16T12:00', exit: '2026-06-16T13:01' }] });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const [stay] = (await res.json()).stays;
  assert.equal(stay.taxes_stated, false);
  assert.deepEqual(stay.tax_lines, []);
  assert.equal(stay.fee_minor, stay.subtotal_minor);
  assert.equal(stay.fee_minor, 1200, 'first hour 8.00, then 4.00 for the started second hour');
});

test('the refusals: another account, a draft that cannot load or does not fit, stays that cannot be read, nothing to try', async () => {
  const op = as(await key());
  const g = await garage();
  const stays = [{ entry: '2026-06-16T12:00', exit: '2026-06-16T13:00' }];
  const t = (body, garageId = g.id) => op('POST', `/garages/${garageId}/rate-plans/try`, body);

  // Another account's garage is not there.
  const theirs = await garage(other);
  assert.equal((await t({ plan: draftPlan(), stays }, theirs.id)).status, 404);
  assert.equal((await t({ plan: draftPlan(), stays }, randomUUID())).status, 404);

  // Nothing stored and no draft: nothing to try.
  const none = await t({ stays });
  assert.equal(none.status, 409);
  assert.equal((await none.json()).code, 'no_rate_plan');

  // A draft the engine cannot load: the store's own 400, the engine's sentence.
  const broken = { ...draftPlan(), surprise: true };
  const tried = await t({ plan: broken, stays });
  const stored = await op('POST', `/garages/${g.id}/rate-plans`, { plan: broken, confirmed: true });
  assert.equal(tried.status, 400);
  assert.equal(stored.status, 400);
  assert.equal((await tried.json()).error, (await stored.json()).error);

  // A draft the store would refuse for this garage: the store's refusal.
  const euros = await t({ plan: { ...draftPlan(), currency: 'EUR' }, stays });
  assert.equal(euros.status, 409);
  assert.equal((await euros.json()).code, 'plan_currency_disagrees_with_garage');
  await withTenant(tenant, (c) => storePlan(c, tenant, g.id, flatHourlyPlan({ version: 'taken', effectiveFrom: '2026-04-01T04:00:00Z' })));
  const taken = await t({ plan: draftPlan(), stays });
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).code, 'plan_effective_from_taken');
  const named = await t({ plan: draftPlan({ version: 'taken', effectiveFrom: '2026-04-02T04:00:00Z' }), stays });
  assert.equal((await named.json()).code, 'plan_version_exists');

  // Stays that cannot be read.
  for (const [body, words] of [
    [{ stays: [] }, /1 to 100 stays/],
    [{ stays: Array.from({ length: 101 }, () => stays[0]) }, /1 to 100 stays/],
    [{ stays: [{ entry: '2026-06-16 12:00', exit: '2026-06-16T13:00' }] }, /YYYY-MM-DDTHH:MM/],
    [{ stays: [{ entry: '2026-02-30T12:00', exit: '2026-06-16T13:00' }] }, /not a real date/],
    [{ stays: [{ entry: '2026-03-08T02:30', exit: '2026-03-08T05:00' }] }, /clocks go forward/],
    [{ stays: [{ entry: '2026-06-16T13:00', exit: '2026-06-16T12:00' }] }, /leaves .* before it came in/],
  ]) {
    const res = await t(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match((await res.json()).error, words);
  }
  // CONTROL: the same garage and the same draft, read correctly, are tried.
  assert.equal((await t({ plan: draftPlan({ version: 'fine', effectiveFrom: '2026-04-03T04:00:00Z' }), stays })).status, 200);
});

test('a draft with a gap is still tried: the stay it touches comes back refused, with the findings named', async () => {
  const op = as(await key());
  const g = await garage();
  const gap = draftPlan();
  gap.rules = gap.rules.map((r) => (r.id === 'r-time' ? { ...r, max_duration_minutes: 1440 } : r)).filter((r) => r.id !== 'r-day');
  const res = await op('POST', `/garages/${g.id}/rate-plans/try`, {
    plan: gap,
    stays: [{ entry: '2026-06-16T12:00', exit: '2026-06-16T13:00' }, { entry: '2026-06-16T12:00', exit: '2026-06-17T13:00' }],
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.ok(body.draft_findings.some((f) => f.code === 'GAP_STAY_EXCEEDS_MAX_DURATION'), JSON.stringify(body.draft_findings));
  const [short, long] = body.stays;
  assert.equal(short.refused, false);
  assert.equal(long.refused, true);
  assert.deepEqual(long.findings.map((f) => f.code), ['GAP_STAY_EXCEEDS_MAX_DURATION']);
  // CONTROL: the store refuses that same draft outright.
  const stored = await op('POST', `/garages/${g.id}/rate-plans`, { plan: { ...gap, effective_from: new Date(Date.now() + 86_400_000).toISOString() }, confirmed: true });
  assert.equal((await stored.json()).code, 'plan_has_findings');
});

test('saving needs confirmed: true from every caller, and the line records that it was confirmed', async () => {
  const op = as(await key());
  const g = await garage();
  const plan = draftPlan({ version: 'confirm-me', effectiveFrom: new Date().toISOString() });
  for (const body of [{ plan }, { plan, confirmed: false }, { plan, confirmed: 'true' }, { plan, confirmed: 1 }]) {
    const res = await op('POST', `/garages/${g.id}/rate-plans`, body);
    assert.equal(res.status, 400, JSON.stringify(body.confirmed));
    assert.equal((await res.json()).code, 'not_confirmed');
  }
  const count = () => withTenant(tenant, async (c) => (await c.query('SELECT count(*)::int AS n FROM rate_plans WHERE garage_id = $1', [g.id])).rows[0].n);
  assert.equal(await count(), 0);
  // CONTROL: confirmed, it is stored, and the line says so.
  const ok = await op('POST', `/garages/${g.id}/rate-plans`, { plan, confirmed: true });
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  assert.equal(await count(), 1);
  const line = await withTenant(tenant, async (c) => (await c.query(
    `SELECT action, after, actor_kind, at FROM garage_changes WHERE garage_id = $1 AND outcome = 'done' AND action = 'rate_plan.add'`, [g.id],
  )).rows[0]);
  assert.equal(line.after.confirmed, true);
  assert.equal(line.actor_kind, 'key');
  assert.ok(line.at, "when it was confirmed");
});
