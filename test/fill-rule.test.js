/**
 * The fill rule's figures (0034): the garage's number of spaces, and how full
 * it was when each car came in.
 *
 * His words, 2026-10-14: "when the garage is at least X% full, the time-based
 * charge is Y% more", priced on how full the garage was AT ENTRY -- all cars
 * inside against every switched-on spot -- and the cars inside keep the price
 * they came in on. The platform counts; the engine (at its pin, the real one)
 * prices. Nothing here is a stand-in for either.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { occupancyBp } from '../src/repository.js';
import { laneDecidedCloses } from '../src/reconcile.js';
import { pool, withTenant, createTenant, storePlan, flatHourlyPlan, activateGarage, superuserClient } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';

let engine;
let server;
let base;
let tenant;
let other;
let operatorToken;
let otherToken;

async function issueToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)', [tenantId, laneId, name, hashToken(token)]),
  );
  return token;
}
async function issueOperatorToken(tenantId) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query("INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)", [tenantId, hashToken(token)]),
  );
  return token;
}
const op = (method, path, body, token = operatorToken) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const asDevice = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ event_id: randomUUID(), ...body }),
});
const open = (token, plate, entryAt = '2026-09-10T12:00:00Z', extra = {}) =>
  fetch(`${base}/api/v1/lane/sessions/open`, asDevice(token, { plate, entry_at: entryAt, entry_confirmation: 'confirmed', ...extra }));
const close = (token, plate, exitAt = '2026-09-10T15:00:00Z', extra = {}) =>
  fetch(`${base}/api/v1/lane/sessions/close`, asDevice(token, { plate, exit_at: exitAt, exit_confirmation: 'confirmed', ...extra }));
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
const opened = async (res) => {
  assert.ok([200, 201].includes(res.status), await res.clone().text());
  return (await res.json()).session;
};

/** A plan of 10.00 an hour with a fill rule: at or above `threshold` bp full, the time costs `percent` bp more. */
function fillPlan({ version = 'fill-v1', effectiveFrom = '2000-01-01T00:00:00Z', threshold = 8000, percent = 2000, specials = 'yes', vip = 'no' } = {}) {
  const plan = flatHourlyPlan({ hourlyMinor: 1000, version, effectiveFrom });
  plan.rules.push({
    id: 'busy', type: 'fill_level', stage: 'ADJUST', space_classes: ['standard'],
    threshold_bp: threshold, percent_bp: percent, rounding: 'up', raises_specials: specials, raises_vip_extra: vip,
  });
  return plan;
}

/** An active garage of `spaces` (or none) with both lanes and device tokens; its plan `plan` stored directly. */
async function garage({ spaces = null, plan = flatHourlyPlan({ hourlyMinor: 1000 }), tenantId = tenant } = {}) {
  const built = await withTenant(tenantId, async (c) => {
    const id = (await c.query(
      "INSERT INTO garages (tenant_id, name, timezone, currency, spaces) VALUES ($1,'Fill','America/New_York','USD',$2) RETURNING id",
      [tenantId, spaces],
    )).rows[0].id;
    const lane = async (name, direction) =>
      (await c.query('INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id', [tenantId, id, name, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const entryLane2 = await lane('E2', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenantId, id, plan);
    await activateGarage(c, tenantId, id);
    return { id, entryLane, entryLane2, exitLane };
  });
  return {
    ...built,
    entry: await issueToken(tenantId, built.entryLane, 'e'),
    entry2: await issueToken(tenantId, built.entryLane2, 'e2'),
    exit: await issueToken(tenantId, built.exitLane, 'x'),
  };
}
const figureOf = async (sessionId) =>
  (await withTenant(tenant, (c) => c.query('SELECT occupancy_at_entry_bp FROM sessions WHERE id = $1', [sessionId]))).rows[0].occupancy_at_entry_bp;
const planCount = async (garageId) =>
  (await withTenant(tenant, (c) => c.query('SELECT count(*)::int AS n FROM rate_plans WHERE garage_id = $1', [garageId]))).rows[0].n;
const now = () => new Date().toISOString();

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('fill');
  other = await createTenant('fill-other');
  operatorToken = await issueOperatorToken(tenant);
  otherToken = await issueOperatorToken(other);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

// --- the figure ---------------------------------------------------------------------

test('how full: floor of 10000 x cars inside over spaces, never more than full, and nothing without a number of spaces', () => {
  assert.equal(occupancyBp(0, 10), 0);
  assert.equal(occupancyBp(1, 3), 3333, 'a third is 3333 bp, rounded down');
  assert.equal(occupancyBp(2, 3), 6666);
  assert.equal(occupancyBp(8, 10), 8000);
  assert.equal(occupancyBp(10, 10), 10000);
  assert.equal(occupancyBp(12, 10), 10000, 'more cars than spaces is full, never more');
  assert.equal(occupancyBp(5, null), null);
});

test('each car is counted against the cars already inside when it came in, every car of every kind; closed stays are not inside', async () => {
  const g = await garage({ spaces: 4 });
  const cars = [plate('A'), plate('B'), plate('C')];
  const figures = [];
  for (const car of cars) figures.push(await figureOf((await opened(await open(g.entry, car))).id));
  assert.deepEqual(figures, [0, 2500, 5000]);
  assert.equal((await close(g.exit, cars[0])).status, 200);
  // D came in at 12:00 too, and its open arrives after A's close (15:00): at
  // D's entry, A was still inside (0035) -- A, B and C, not B and C.
  const d = await opened(await open(g.entry, plate('D')));
  assert.equal(await figureOf(d.id), 7500, 'A, B and C were inside when D came in');
  // After A and B left: C and D inside when E came in at 16:00.
  assert.equal((await close(g.exit, cars[1])).status, 200);
  const e = await opened(await open(g.entry, plate('E'), '2026-09-10T16:00:00Z'));
  assert.equal(await figureOf(e.id), 5000, 'A and B had left: C and D were inside');
});

test('AT THE CAR\'S OWN ENTRY: an open a lane delivers late is counted against the cars that were in when it came in, not when it arrived', async () => {
  const g = await garage({ spaces: 4 });
  const a = plate('A');
  await opened(await open(g.entry, a, '2026-09-10T12:00:00Z'));
  assert.equal((await close(g.exit, a, '2026-09-10T13:00:00Z')).status, 200);
  // B came in at 12:30, while A was inside; its open arrives after A left.
  const b = await opened(await open(g.entry2, plate('B'), '2026-09-10T12:30:00Z'));
  assert.equal(await figureOf(b.id), 2500, 'A was inside at 12:30');
  // C came in at 11:00, before anyone: its late open counts nobody.
  const c = await opened(await open(g.entry2, plate('C'), '2026-09-10T11:00:00Z'));
  assert.equal(await figureOf(c.id), 0, 'nobody was inside at 11:00');
});

test('A STAY NOTHING CLOSES STOPS COUNTING: one that came in OCCUPANCY_MAX_STAY_HOURS (24) or more before an entry is not inside it', async () => {
  const g = await garage({ spaces: 4 });
  // An orphan: in on the 8th, never closed.
  await opened(await open(g.entry, plate('ORPHAN'), '2026-09-08T12:00:00Z'));
  const x = await opened(await open(g.entry, plate('X'), '2026-09-09T11:00:00Z'));
  assert.equal(await figureOf(x.id), 2500, 'twenty-three hours on, it is still counted');
  const y = await opened(await open(g.entry, plate('Y'), '2026-09-09T13:00:00Z'));
  assert.equal(await figureOf(y.id), 2500, 'twenty-five hours on, the orphan is not counted; X is');
});

test('more cars inside than spaces (the map changed under them): the figure is 10000, never more', async () => {
  const g = await garage({ spaces: 2 });
  for (const car of [plate('A'), plate('B'), plate('C')]) await opened(await open(g.entry, car));
  const d = await opened(await open(g.entry, plate('D')));
  assert.equal(await figureOf(d.id), 10000);
});

test('a garage with no number of spaces: the stay carries no figure, and a plan without a fill rule prices as before', async () => {
  const g = await garage({ spaces: null });
  const car = plate('N');
  const s = await opened(await open(g.entry, car));
  assert.equal(await figureOf(s.id), null);
  const res = await close(g.exit, car, '2026-09-10T15:00:00Z');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).session.subtotal_minor, 3000);
});

test('a lane cannot set the figure: one sent on the open, or in a lane event, is ignored and the platform counts its own', async () => {
  const g = await garage({ spaces: 10 });
  const s = await opened(await open(g.entry, plate('L'), '2026-09-10T12:00:00Z', { occupancy_at_entry_bp: 9999 }));
  assert.equal(await figureOf(s.id), 0, 'the platform counted no car inside');
  const ev = await fetch(`${base}/api/v1/lane/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${g.entry}` },
    body: JSON.stringify({ events: [{ event_id: randomUUID(), kind: 'armed', occurred_at: '2026-09-10T12:01:00Z', detail: { occupancy_at_entry_bp: 9999, session_id: s.id } }] }),
  });
  assert.ok(ev.status >= 200 && ev.status < 300, await ev.clone().text());
  assert.equal(await figureOf(s.id), 0, 'still the platform\'s figure');
});

test('two lanes opening at once count each other: n and n+1, never n twice', async () => {
  const g = await garage({ spaces: 10 });
  await opened(await open(g.entry, plate('P')));
  for (let round = 0; round < 5; round += 1) {
    const before = (await withTenant(tenant, (c) => c.query('SELECT count(*)::int AS n FROM sessions WHERE garage_id = $1 AND exit_at IS NULL', [g.id]))).rows[0].n;
    const [a, b] = await Promise.all([open(g.entry, plate('Q')), open(g.entry2, plate('R'))]);
    const figures = [await figureOf((await opened(a)).id), await figureOf((await opened(b)).id)].sort((x, y) => x - y);
    assert.deepEqual(figures, [occupancyBp(before, 10), occupancyBp(before + 1, 10)]);
  }
});

// --- the number of spaces -----------------------------------------------------------

test('PATCH /garages/:id takes spaces: stored, read back, and written in the change log with what it was', async () => {
  const g = await garage({ spaces: null });
  const res = await op('PATCH', `/garages/${g.id}`, { spaces: 120 });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).garage.spaces, 120);
  assert.equal((await (await op('GET', `/garages/${g.id}`)).json()).garage.spaces, 120);
  assert.equal((await (await op('GET', '/garages')).json()).garages.find((x) => x.id === g.id).spaces, 120);
  const { rows } = await withTenant(tenant, (c) => c.query(
    "SELECT before, after FROM garage_changes WHERE garage_id = $1 AND action = 'garage.update' ORDER BY at DESC LIMIT 1", [g.id]));
  assert.deepEqual(rows[0], { before: { spaces: null }, after: { spaces: 120 } });
});

test('spaces that are not a whole number of at least one are refused by name, and nothing changes', async () => {
  const g = await garage({ spaces: 7 });
  for (const bad of [0, -3, 1.5, '10', true, 100001, [], {}]) {
    const res = await op('PATCH', `/garages/${g.id}`, { spaces: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).code, 'garage_spaces_refused');
  }
  assert.equal((await (await op('GET', `/garages/${g.id}`)).json()).garage.spaces, 7);
  // CONTROL: a good one through the same door is taken.
  assert.equal((await op('PATCH', `/garages/${g.id}`, { spaces: 8 })).status, 200);
});

test('another account cannot read or set a garage\'s spaces: not found, and the number stays', async () => {
  const g = await garage({ spaces: 30 });
  const res = await op('PATCH', `/garages/${g.id}`, { spaces: 1 }, otherToken);
  assert.equal(res.status, 404);
  assert.equal((await op('GET', `/garages/${g.id}`, undefined, otherToken)).status, 404);
  assert.equal((await (await op('GET', `/garages/${g.id}`)).json()).garage.spaces, 30);
});

test('the database holds the shapes too: spaces above zero, a figure from 0 to 10000', async () => {
  const su = superuserClient();
  await su.connect();
  try {
    await assert.rejects(su.query("UPDATE garages SET spaces = 0 WHERE name = 'Fill'"), /garages_spaces_check/);
    await assert.rejects(su.query('UPDATE sessions SET occupancy_at_entry_bp = 10001 WHERE id = (SELECT id FROM sessions LIMIT 1)'), /sessions_occupancy_at_entry_bp_check/);
    await assert.rejects(su.query('UPDATE sessions SET occupancy_at_entry_bp = -1 WHERE id = (SELECT id FROM sessions LIMIT 1)'), /sessions_occupancy_at_entry_bp_check/);
  } finally {
    await su.end();
  }
});

// --- the store ----------------------------------------------------------------------

test('rates with a fill rule are refused for a garage with no number of spaces, in plain words, and nothing is stored', async () => {
  const g = await garage({ spaces: null });
  const plan = fillPlan({ version: 'fill-store', effectiveFrom: now() });
  const res = await op('POST', `/garages/${g.id}/rate-plans`, { plan, confirmed: true, based_on: null });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'plan_needs_spaces');
  assert.match(body.error, /number of spaces/);
  assert.equal(await planCount(g.id), 1, 'only the plan the garage started with');
  // The try says the same about the draft.
  const tried = await op('POST', `/garages/${g.id}/rate-plans/try`, { plan, stays: [{ entry: '2030-01-05T10:00', exit: '2030-01-05T12:00' }] });
  assert.equal(tried.status, 409);
  assert.equal((await tried.json()).code, 'plan_needs_spaces');
});

test('the same rates are stored once the garage has its number of spaces', async () => {
  const g = await garage({ spaces: null });
  const { rows } = await withTenant(tenant, (c) => c.query('SELECT id FROM rate_plans WHERE garage_id = $1', [g.id]));
  assert.equal((await op('PATCH', `/garages/${g.id}`, { spaces: 50 })).status, 200);
  const res = await op('POST', `/garages/${g.id}/rate-plans`, { plan: fillPlan({ version: 'fill-ok', effectiveFrom: now() }), confirmed: true, based_on: rows[0].id });
  assert.equal(res.status, 201, await res.clone().text());
});

test('a fill rule that leaves out either of the owner\'s answers, or says anything but yes or no, is refused by name; nothing stored', async () => {
  const g = await garage({ spaces: 20 });
  const cases = [
    ['raises_specials', undefined], ['raises_vip_extra', undefined],
    ['raises_specials', true], ['raises_vip_extra', false], ['raises_specials', 'YES'], ['raises_vip_extra', ''],
  ];
  for (const [field, value] of cases) {
    const plan = fillPlan({ version: `fill-${field}-${String(value)}`, effectiveFrom: now() });
    if (value === undefined) delete plan.rules[1][field];
    else plan.rules[1][field] = value;
    const res = await op('POST', `/garages/${g.id}/rate-plans`, { plan, confirmed: true, based_on: null });
    assert.equal(res.status, 409, `${field}=${value}`);
    const body = await res.json();
    assert.equal(body.code, 'fill_rule_answers_missing');
    assert.match(body.error, new RegExp(field));
  }
  assert.equal(await planCount(g.id), 1);
});

test('the number of spaces is not taken away from rates that need it; it can be once the rates do not', async () => {
  const g = await garage({ spaces: 10, plan: fillPlan() });
  const res = await op('PATCH', `/garages/${g.id}`, { spaces: null });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'spaces_needed_by_fill_rule');
  assert.equal((await (await op('GET', `/garages/${g.id}`)).json()).garage.spaces, 10);
  // CONTROL: a garage whose rates have no fill rule clears it.
  const plain = await garage({ spaces: 10 });
  const cleared = await op('PATCH', `/garages/${plain.id}`, { spaces: null });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).garage.spaces, null);
});

test('THE NUMBER OF SPACES IS NOT TAKEN BELOW THE CARS INSIDE NOW: refused by name, and nothing changes', async () => {
  const g = await garage({ spaces: 10 });
  const recently = new Date(Date.now() - 30 * 60_000).toISOString();
  for (const car of [plate('I'), plate('J'), plate('K')]) await opened(await open(g.entry, car, recently));
  const res = await op('PATCH', `/garages/${g.id}`, { spaces: 2 });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'spaces_below_cars_inside');
  assert.match(body.error, /3 cars are inside/);
  assert.equal((await (await op('GET', `/garages/${g.id}`)).json()).garage.spaces, 10);
  // CONTROL: as many spaces as cars inside is taken.
  assert.equal((await op('PATCH', `/garages/${g.id}`, { spaces: 3 })).status, 200);
});

test('A LOWER NUMBER OF SPACES UNDER A FILL RULE needs the owner\'s word: refused without spaces_confirmed, taken with it; a higher one needs nothing', async () => {
  const g = await garage({ spaces: 300, plan: fillPlan() });
  const lower = await op('PATCH', `/garages/${g.id}`, { spaces: 40 });
  assert.equal(lower.status, 409);
  assert.equal((await lower.json()).code, 'spaces_lowering_not_confirmed');
  assert.equal((await (await op('GET', `/garages/${g.id}`)).json()).garage.spaces, 300);
  for (const bad of ['yes', 1, {}]) {
    const r = await op('PATCH', `/garages/${g.id}`, { spaces: 40, spaces_confirmed: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const confirmed = await op('PATCH', `/garages/${g.id}`, { spaces: 40, spaces_confirmed: true });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  assert.equal((await confirmed.json()).garage.spaces, 40);
  assert.equal((await op('PATCH', `/garages/${g.id}`, { spaces: 50 })).status, 200, 'raising needs no word');
  // CONTROL: a garage whose rates have no fill rule lowers it plainly.
  const plain = await garage({ spaces: 300 });
  assert.equal((await op('PATCH', `/garages/${plain.id}`, { spaces: 40 })).status, 200);
});

test('THE NUMBER OF SPACES IS NOT CLEARED UNDER AN OLDER FILL RULE that can still price a stay, though the newest rates have none', async () => {
  // Rates with a fill rule, then plain rates from two hours ago; a car came in
  // three hours ago, under the fill rule, and is still inside.
  const g = await garage({ spaces: 10, plan: fillPlan({ version: 'fill-old' }) });
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  await withTenant(tenant, (c) => storePlan(c, tenant, g.id, flatHourlyPlan({ hourlyMinor: 1000, version: 'plain-new', effectiveFrom: twoHoursAgo })));
  const car = plate('UNDER');
  await opened(await open(g.entry, car, new Date(Date.now() - 3 * 3600_000).toISOString()));
  const res = await op('PATCH', `/garages/${g.id}`, { spaces: null });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'spaces_needed_by_fill_rule');
  assert.equal((await (await op('GET', `/garages/${g.id}`)).json()).garage.spaces, 10);
  // CONTROL: once no stay inside came in under it, and the plain rates are
  // past the start allowance, it clears.
  assert.equal((await close(g.exit, car, new Date(Date.now() - 3600_000).toISOString())).status, 200);
  const cleared = await op('PATCH', `/garages/${g.id}`, { spaces: null });
  assert.equal(cleared.status, 200, await cleared.clone().text());
});

// --- the price ----------------------------------------------------------------------

test('the close prices on the figure the car came in with: below the threshold not raised, at it raised by the percent', async () => {
  // 5 spaces, 80%: the fifth car in sees 4 inside (8000), the fourth sees 3 (6000).
  const g = await garage({ spaces: 5, plan: fillPlan() });
  const cars = [plate('A'), plate('B'), plate('C'), plate('D'), plate('E')];
  const sessions = [];
  for (const car of cars) sessions.push(await opened(await open(g.entry, car)));
  assert.deepEqual(await Promise.all(sessions.map((s) => figureOf(s.id))), [0, 2000, 4000, 6000, 8000]);
  const fourth = await (await close(g.exit, cars[3])).json();
  const fifth = await (await close(g.exit, cars[4])).json();
  assert.equal(fourth.session.subtotal_minor, 3000, 'three hours at 10.00, not raised');
  assert.equal(fifth.session.subtotal_minor, 3600, 'three hours at 10.00, +20%');
  const line = fifth.session.breakdown.find((l) => l.code === 'fill_level.applied');
  assert.equal(line.delta_minor, 600);
  assert.match(line.text, /^Garage was 80% full at entry \(at or above 80%\): time-based charge \+20%/);
  assert.ok(fourth.session.breakdown.some((l) => l.code === 'fill_level.not_applied'));
});

test('cars inside keep their price: one in at 70% stays unraised after the rates gain a fill rule and the garage fills', async () => {
  const g = await garage({ spaces: 10 });
  // Fifty minutes ago: inside the hours a stay is counted for (0035), and
  // under the hour a plain stay is priced at.
  const earlier = new Date(Date.now() - 50 * 60_000).toISOString();
  for (let i = 0; i < 7; i += 1) await opened(await open(g.entry, plate('F'), earlier));
  const early = plate('EARLY');
  const s = await opened(await open(g.entry, early, earlier));
  assert.equal(await figureOf(s.id), 7000);
  // New rates with a fill rule, from now on; then the garage fills past 80%.
  const { rows } = await withTenant(tenant, (c) => c.query('SELECT id FROM rate_plans WHERE garage_id = $1', [g.id]));
  const stored = await op('POST', `/garages/${g.id}/rate-plans`, { plan: fillPlan({ version: 'busy-now', effectiveFrom: now() }), confirmed: true, based_on: rows[0].id });
  assert.equal(stored.status, 201, await stored.clone().text());
  const late = plate('LATE');
  const t = await opened(await open(g.entry, late, now()));
  assert.equal(await figureOf(t.id), 8000);
  const leave = new Date(Date.now()).toISOString();
  const a = await (await close(g.exit, early, leave)).json();
  assert.equal(a.session.subtotal_minor, 1000, 'priced by the rates in force at its entry, with no fill rule');
  assert.ok(!a.session.breakdown.some((l) => l.code.startsWith('fill_level')));
  const b = await (await close(g.exit, late, leave)).json();
  assert.equal(b.session.subtotal_minor, 1200, 'the first hour at 10.00, +20%: it came in at 80% under the fill rule');
});

test('the lane\'s copy of the open stays carries each figure, on the slow read and the fast one', async () => {
  const g = await garage({ spaces: 4 });
  await opened(await open(g.entry, plate('A')));
  await opened(await open(g.entry, plate('B')));
  const rules = await (await fetch(`${base}/api/v1/lane/rules`, { headers: { authorization: `Bearer ${g.exit}` } })).json();
  assert.deepEqual(rules.stays.open.map((s) => s.occupancy_at_entry_bp), [0, 2500]);
  assert.equal(rules.spaces, 4, 'and the number of spaces, for the lane\'s price board');
  const fast = await (await fetch(`${base}/api/v1/lane/stays`, { headers: { authorization: `Bearer ${g.exit}` } })).json();
  assert.deepEqual(fast.open.map((s) => s.occupancy_at_entry_bp), [0, 2500]);
  const delta = await (await fetch(`${base}/api/v1/lane/stays?since=0`, { headers: { authorization: `Bearer ${g.exit}` } })).json();
  assert.deepEqual(delta.changes.map((s) => s.occupancy_at_entry_bp), [0, 2500]);
});

test('the past stays carry how full the garage was at entry, and nothing of who', async () => {
  const g = await garage({ spaces: 2 });
  const car = plate('PAST');
  await opened(await open(g.entry, plate('IN')));
  await opened(await open(g.entry, car));
  assert.equal((await close(g.exit, car)).status, 200);
  const res = await op('GET', `/garages/${g.id}/stays/closed?from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z`);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.stays.length, 1);
  assert.equal(body.stays[0].occupancy_at_entry_bp, 5000);
  assert.ok(!text.includes(car), 'no plate');
});

test('a try prices a stay at the figure it is given, refuses one out of range by name, and without one a fill rule says it cannot price', async () => {
  const g = await garage({ spaces: 10, plan: fillPlan() });
  const stay = { entry: '2030-01-05T10:00', exit: '2030-01-05T12:00' };
  const res = await op('POST', `/garages/${g.id}/rate-plans/try`, { stays: [{ ...stay, occupancy_at_entry_bp: 7999 }, { ...stay, occupancy_at_entry_bp: 8000 }, stay] });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.stays[0].subtotal_minor, 2000);
  assert.equal(body.stays[1].subtotal_minor, 2400);
  assert.equal(body.stays[1].occupancy_at_entry_bp, 8000);
  assert.equal(body.stays[2].refused, true);
  assert.deepEqual(body.stays[2].findings.map((f) => f.code), ['GAP_NO_OCCUPANCY_AT_ENTRY']);
  for (const bad of [-1, 10001, 50.5, '8000', true]) {
    const r = await op('POST', `/garages/${g.id}/rate-plans/try`, { stays: [{ ...stay, occupancy_at_entry_bp: bad }] });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match((await r.json()).error, /occupancy_at_entry_bp/);
  }
});

test('the reconciler re-prices a lane\'s decision on the stay\'s own figure', async () => {
  const seen = [];
  const quote = async (args) => { seen.push(args.occupancyAtEntryBp); return { feeMinor: 0, currency: 'USD', planVersion: 'x', breakdown: [] }; };
  const g = await garage({ spaces: 4 });
  const su = superuserClient();
  await su.connect();
  try {
    const car = plate('REC');
    const s = await opened(await open(g.entry, car));
    await su.query(
      `UPDATE sessions SET exit_at = entry_at + interval '1 hour', exit_lane_id = $2, exit_confirmation = 'confirmed',
              close_event_id = $3, exit_outcome = 'transient', fee_minor = 1000, subtotal_minor = 1000, plan_version = 'flat-1000-USD',
              space_class = 'standard', breakdown = '[]', decided_by = 'lane', occupancy_at_entry_bp = 2500,
              decision_inputs = jsonb_build_object('entry_at', entry_at::text, 'exit_at', (entry_at + interval '1 hour')::text,
                                                   'space_class', 'standard', 'synced_at', '{}'::jsonb)
        WHERE id = $1`, [s.id, g.exitLane, randomUUID()]);
  } finally {
    await su.end();
  }
  await withTenant(tenant, (c) => laneDecidedCloses(c, tenant, g.id, '2000-01-01T00:00:00Z', { quote, plans: [] }));
  assert.deepEqual(seen, [2500]);
});
