/**
 * The close consumes the lane's decision (0017), and the reconciler
 * re-derives what a device wrote -- and reports, and stops.
 *
 * Every claim is paired with its control: a close that carries no decision
 * takes today's path exactly (the REAL engine and the REAL entitlement
 * modules, through their doors); a decision the platform cannot consume is
 * kept on the record with its reason and the close prices for itself; and
 * the planted lane -- one that writes `fee + 1` -- is what the reconciler
 * exists to name, without changing the row it names.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { startEntitlementModules } from './entitlement-modules.js';
import { laneDecidedCloses } from '../src/reconcile.js';
import * as ratePlans from '../src/ratePlans.js';

import http from 'node:http';

let engine;
let counting;  // a proxy in front of the engine that counts every request the platform makes to it
let modules;
let server;
let base;
let tenant;
let operatorToken;

/** A pass-through in front of the engine, counting: THE INSTRUMENT for "the close did not price again". */
async function countingProxy(target) {
  let count = 0;
  const proxy = http.createServer(async (req, res) => {
    count += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(`${target}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${proxy.address().port}`,
    requests: () => count,
    stop: () => new Promise((r) => proxy.close(r)),
  };
}

async function issueToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [tenantId, laneId, name, hashToken(token)]),
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
const op = (method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const asDevice = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ event_id: randomUUID(), ...body }),
});
const open = (token, plate, entryAt = '2026-09-10T12:00:00Z') =>
  fetch(`${base}/api/v1/lane/sessions/open`, asDevice(token, { plate, entry_at: entryAt, entry_confirmation: 'confirmed' }));
const close = (token, plate, extra = {}, exitAt = '2026-09-10T14:00:00Z') =>
  fetch(`${base}/api/v1/lane/sessions/close`, asDevice(token, { plate, exit_at: exitAt, exit_confirmation: 'confirmed', ...extra }));
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
const rowFor = (id) => withTenant(tenant, async (c) => (await c.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0]);
const eventsOf = (kind, garageId) =>
  withTenant(tenant, async (c) =>
    (await c.query(`SELECT * FROM events WHERE tenant_id = $1 AND kind = $2 AND garage_id = $3 ORDER BY received_at`, [tenant, kind, garageId])).rows,
  );

/** An active garage with a flat 250/h plan and both lanes. */
async function garage() {
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Consumes','America/New_York','USD') RETURNING id`, [tenant])).rows[0].id;
    const lane = async (name, direction) =>
      (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, id, name, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan());
    await activateGarage(c, tenant, id);
    return { id, entryLane, exitLane };
  });
  return { ...built, entry: await issueToken(tenant, built.entryLane, 'e'), exit: await issueToken(tenant, built.exitLane, 'x') };
}
const gpLink = (garageId) => ({ tenant_id: modules.garage_pass.tenant, garage_id: garageId });
const mbLink = (garageId) => ({ tenant_id: modules.monthly_billing.tenant, garage_id: garageId });

/** What the lane records at the barrier for a priced stay (lane-controller `ExitPricing.to_detail`). */
function pricedDecision(sessionId, { feeMinor = 500, planVersion = 'flat-250-USD', entryAt = '2026-09-10T12:00:00+00:00', exitAt = '2026-09-10T14:00:00+00:00', spaceClass = 'standard', currency = 'USD' } = {}) {
  return {
    status: 'priced',
    covered_by: [],
    matched: [],
    fee_minor: feeMinor,
    currency,
    plan_version: planVersion,
    breakdown: [{ stage: 'ACCUMULATE', rule: 'hourly', amount_minor: feeMinor }],
    entry_at: entryAt,
    exit_at: exitAt,
    session_id: sessionId,
    space_class: spaceClass,
    computed_from: { rules_refreshed_at: 1758480000.5, stays_refreshed_at: 1758480100.5, stays_cursor: '42', day: '2026-09-10', clock: 'America/New_York' },
  };
}
const coveredDecision = () => ({
  status: 'covered',
  covered_by: ['garage_pass'],
  matched: [{ module: 'garage_pass', pass: 'pass-xyz', agreement: null }],
  computed_from: { rules_refreshed_at: 1758480000.5, stays_refreshed_at: null, stays_cursor: '7', day: '2026-09-10', clock: 'America/New_York' },
});
const uncachedDecision = () => ({ status: 'no_cached_entry', covered_by: [], matched: [], computed_from: { rules_refreshed_at: 1, day: '2026-09-10', clock: 'UTC' } });

/** Open a stay and return its id. */
async function opened(g, car) {
  const res = await open(g.entry, car);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).session.id;
}

before(async () => {
  engine = await startRateEngine();
  counting = await countingProxy(engine.url);
  process.env.RATE_ENGINE_URL = counting.url;
  modules = await startEntitlementModules();
  tenant = await createTenant('consumes');
  await buildWorld(tenant);
  operatorToken = await issueOperatorToken(tenant);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await counting?.stop();
  await engine?.stop();
  await modules?.stop();
  await pool.end();
});

// --- the close consumes -------------------------------------------------------------

test('a close carrying a priced decision writes the lane\'s numbers and does not run the engine or the doors', async () => {
  const g = await garage();
  const car = plate('LANE');
  const id = await opened(g, car);
  // THE INSTRUMENT: the engine's own request log. The close must not add to it.
  const before = counting.requests();
  const decision = pricedDecision(id, { feeMinor: 425 });  // NOT what the engine would say (500): consumed, not recomputed
  const res = await close(g.exit, car, { local_decision: decision });
  assert.equal(res.status, 200, await res.clone().text());
  const { session } = await res.json();
  assert.equal(session.fee_minor, 425, 'the lane\'s fee, as written, not the engine\'s');
  assert.equal(session.plan_version, 'flat-250-USD');
  assert.equal(session.exit_outcome, 'transient');
  assert.equal(session.decided_by, 'lane');
  assert.deepEqual(session.breakdown, decision.breakdown);
  assert.equal(counting.requests(), before, 'the close priced the stay again');
  // WHAT IT DECIDED FROM, beside the fee: the inputs, and the cache's synced_at.
  const row = await rowFor(id);
  assert.deepEqual(row.decision_inputs, {
    status: 'priced',
    entry_at: '2026-09-10T12:00:00+00:00',
    exit_at: '2026-09-10T14:00:00+00:00',
    space_class: 'standard',
    plan_version: 'flat-250-USD',
    currency: 'USD',
    fee_minor: 425,
    session_id: id,
    synced_at: decision.computed_from,
  });
  assert.equal(row.entitlement.decided_by, 'lane');
  assert.deepEqual(row.entitlement.local_decision, decision);
  assert.equal(row.entitlement.garage_pass, undefined, 'the doors were not asked');
});

test('a close carrying a covered decision leaves with no fee, records who covered it, and asks no door', async () => {
  const g = await garage();
  const car = plate('COVR');
  const id = await opened(g, car);
  const res = await close(g.exit, car, { local_decision: coveredDecision() });
  assert.equal(res.status, 200, await res.clone().text());
  const { session } = await res.json();
  assert.equal(session.exit_outcome, 'covered');
  assert.equal(session.fee_minor, null);
  assert.equal(session.decided_by, 'lane');
  const row = await rowFor(id);
  assert.deepEqual(row.entitlement.covered_by, ['garage_pass']);
  assert.equal(row.decision_inputs.status, 'covered');
  assert.equal(row.decision_inputs.synced_at.stays_cursor, '7');
  const covered = (await eventsOf('exit_covered', g.id)).filter((e) => e.detail.session_id === id);
  assert.equal(covered.length, 1);
  assert.equal(covered[0].detail.actor, 'lane:decision');
  assert.equal(covered[0].detail.decided_by, 'lane');
  assert.equal(covered[0].detail.pass_id, 'pass-xyz');
});

test('a close carrying no decision takes today\'s path exactly: the engine prices, the platform decided', async () => {
  const g = await garage();
  const car = plate('NONE');
  const id = await opened(g, car);
  const before = counting.requests();
  const res = await close(g.exit, car);
  assert.equal(res.status, 200);
  const { session } = await res.json();
  assert.equal(session.fee_minor, 500, 'two hours at 250');
  assert.equal(session.decided_by, 'platform');
  assert.equal(counting.requests(), before + 1, 'the engine was asked once');
  const row = await rowFor(id);
  assert.equal(row.decision_inputs, null);
  assert.equal(row.entitlement.local_decision_ignored, undefined);
});

test('a lane that could not decide says so, the close prices, and the decision is on the record as not taken', async () => {
  const g = await garage();
  const car = plate('UNCA');
  const id = await opened(g, car);
  const res = await close(g.exit, car, { local_decision: uncachedDecision() });
  assert.equal(res.status, 200, await res.clone().text());
  const { session } = await res.json();
  assert.equal(session.fee_minor, 500);
  assert.equal(session.decided_by, 'platform');
  const row = await rowFor(id);
  assert.equal(row.decision_inputs, null);
  assert.match(row.entitlement.local_decision_ignored.reason, /could not decide at the barrier: no_cached_entry/);
  assert.equal(row.entitlement.local_decision_ignored.local_decision.status, 'no_cached_entry');
});

test('a decision about a different stay, another currency, another class or an unknown plan is not taken -- said by name, never a 5xx', async () => {
  const g = await garage();
  const cases = [
    ['other session', () => pricedDecision(randomUUID()), /different session/],
    ['other currency', (id) => pricedDecision(id, { currency: 'EUR' }), /prices in EUR/],
    ['other class', (id) => pricedDecision(id, { spaceClass: 'compact' }), /space class compact/],
    ['unknown plan', (id) => pricedDecision(id, { planVersion: 'v-nobody' }), /plan version v-nobody/],
  ];
  for (const [label, make, why] of cases) {
    const car = plate('MISM');
    const id = await opened(g, car);
    const res = await close(g.exit, car, { local_decision: make(id) });
    assert.equal(res.status, 200, `${label}: ${await res.clone().text()}`);
    const { session } = await res.json();
    assert.equal(session.decided_by, 'platform', label);
    assert.equal(session.fee_minor, 500, `${label}: the platform priced for itself`);
    const row = await rowFor(id);
    assert.match(row.entitlement.local_decision_ignored.reason, why, label);
  }
});

test('a decision that is not one is refused 400 by name, and the stay stays open', async () => {
  const g = await garage();
  const car = plate('BAD');
  const id = await opened(g, car);
  for (const [bad, why] of [
    [['not', 'an', 'object'], /must be an object/],
    [{ status: 'guessed', computed_from: {} }, /status must be one of/],
    [{ status: 'priced', computed_from: {} }, /fee_minor must be a whole number/],
    [{ status: 'priced', fee_minor: 5, computed_from: {} }, /currency must be a non-empty string/],
    [{ status: 'priced', fee_minor: 5, currency: 'USD', plan_version: 'p', entry_at: 'e', exit_at: 'x', session_id: id, space_class: 's', computed_from: {}, breakdown: 'ledger' }, /breakdown must be/],
    [{ status: 'covered', computed_from: {} }, /covered_by must name/],
    [{ status: 'priced', fee_minor: 5 }, /computed_from must be an object/],
  ]) {
    const res = await close(g.exit, car, { local_decision: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match((await res.json()).error, why);
  }
  assert.equal((await rowFor(id)).exit_at, null, 'a refused close left the stay open');
});

test('a replayed close echoes the row the lane-decided close wrote, not a recomputation', async () => {
  const g = await garage();
  const car = plate('RPLY');
  const id = await opened(g, car);
  const request = asDevice(g.exit, { plate: car, exit_at: '2026-09-10T14:00:00Z', exit_confirmation: 'confirmed', local_decision: pricedDecision(id, { feeMinor: 333 }) });
  const first = await (await fetch(`${base}/api/v1/lane/sessions/close`, request)).json();
  assert.equal(first.closed, true);
  assert.equal(first.session.fee_minor, 333);
  const before = counting.requests();
  const again = await (await fetch(`${base}/api/v1/lane/sessions/close`, request)).json();
  assert.equal(again.replay, true);
  assert.equal(again.session.fee_minor, 333);
  assert.equal(again.session.decided_by, 'lane');
  assert.equal(counting.requests(), before, 'a replay priced nothing');
});

// --- the reconciler: reports, and stops -------------------------------------------------

test('the reconciler recomputes each lane-decided fee out of band and names the lane that wrote fee + 1', async () => {
  const g = await garage();
  const honest = plate('HONS');
  const honestId = await opened(g, honest);
  assert.equal((await close(g.exit, honest, { local_decision: pricedDecision(honestId, { feeMinor: 500 }) })).status, 200);
  // THE PLANTED LANE: fee + 1, everything else as the honest one.
  const planted = plate('PLNT');
  const plantedId = await opened(g, planted);
  assert.equal((await close(g.exit, planted, { local_decision: pricedDecision(plantedId, { feeMinor: 501 }) })).status, 200);
  const rowBefore = await rowFor(plantedId);
  assert.equal(rowBefore.fee_minor, '501', 'the premise: the close consumed the planted fee');

  const report = await withTenant(tenant, (c) => laneDecidedCloses(c, tenant, g.id, '2026-09-10T00:00:00Z'));
  assert.equal(report.checked, 2);
  assert.equal(report.agreed, 1);
  assert.deepEqual(report.diverged.map((d) => d.session_id), [plantedId]);
  assert.deepEqual(report.diverged[0].lane, { fee_minor: 501, plan_version: 'flat-250-USD' });
  assert.deepEqual(report.diverged[0].recomputed, { fee_minor: 500, plan_version: 'flat-250-USD' });
  assert.equal(report.diverged[0].synced_at.stays_cursor, '42');
  assert.deepEqual(report.inputs_disagree, []);
  assert.deepEqual(report.unrecomputable, []);
  // AND IT CORRECTED NOTHING: the row is byte for byte what the close wrote.
  const rowAfter = await rowFor(plantedId);
  assert.deepEqual(rowAfter, rowBefore);
  // through the operator's route, the same report under `lane_decisions`
  const res = await op('GET', `/garages/${g.id}/reconciliation?hours=720&max_stay_hours=48`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.lane_decisions.diverged.map((d) => d.session_id), [plantedId]);
  assert.equal(body.lane_decisions.agreed, 1);
});

test('inputs that are not the row\'s are reported as their own fact, beside the recomputation', async () => {
  const g = await garage();
  const car = plate('INPT');
  const id = await opened(g, car);
  // The lane priced from an entry an hour later than the stay's own: one hour at 250.
  const decision = pricedDecision(id, { feeMinor: 250, entryAt: '2026-09-10T13:00:00+00:00' });
  assert.equal((await close(g.exit, car, { local_decision: decision })).status, 200);
  const report = await withTenant(tenant, (c) => laneDecidedCloses(c, tenant, g.id, '2026-09-10T00:00:00Z'));
  assert.deepEqual(report.inputs_disagree.map((d) => [d.session_id, d.fields]), [[id, ['entry_at']]]);
  assert.equal(report.inputs_disagree[0].lane.entry_at, '2026-09-10T13:00:00+00:00');
  assert.equal(report.inputs_disagree[0].row.entry_at, '2026-09-10T12:00:00.000Z');
  // From ITS inputs the fee recomputes: agreed, not diverged. The disagreement is the finding.
  assert.equal(report.agreed, 1);
  assert.deepEqual(report.diverged, []);
});

test('an engine that cannot be asked makes a row unrecomputable, never agreed and never diverged', async () => {
  const g = await garage();
  const car = plate('UNRC');
  const id = await opened(g, car);
  assert.equal((await close(g.exit, car, { local_decision: pricedDecision(id, { feeMinor: 999 }) })).status, 200);
  const dead = () => Promise.reject(new ratePlans.EngineUnavailable('no engine at this address'));
  const report = await withTenant(tenant, (c) => laneDecidedCloses(c, tenant, g.id, '2026-09-10T00:00:00Z', { quote: dead }));
  assert.equal(report.checked, 1);
  assert.equal(report.agreed, 0);
  assert.deepEqual(report.diverged, []);
  assert.deepEqual(report.unrecomputable.map((u) => [u.session_id, u.reason]), [[id, 'the engine could not be asked: no engine at this address']]);
  // and a refusal is unrecomputable with the engine's findings, not a divergence
  const refusing = () => Promise.reject(new ratePlans.PricingRefused([{ code: 'NO_RULE', kind: 'gap', text: 'nothing prices this' }]));
  const refused = await withTenant(tenant, (c) => laneDecidedCloses(c, tenant, g.id, '2026-09-10T00:00:00Z', { quote: refusing }));
  assert.equal(refused.unrecomputable[0].reason, 'the engine refused the inputs');
  assert.equal(refused.unrecomputable[0].findings[0].code, 'NO_RULE');
});

test('covered-by-lane stays are listed with what they matched and are not re-consulted', async () => {
  const g = await garage();
  const car = plate('CLST');
  const id = await opened(g, car);
  assert.equal((await close(g.exit, car, { local_decision: coveredDecision() })).status, 200);
  let asked = 0;
  const counting = async (...args) => { asked += 1; return ratePlans.quoteWithEngine(...args); };
  const report = await withTenant(tenant, (c) => laneDecidedCloses(c, tenant, g.id, '2026-09-10T00:00:00Z', { quote: counting }));
  assert.deepEqual(report.covered_by_lane, [{ session_id: id, exit_at: report.covered_by_lane[0].exit_at, covered_by: ['garage_pass'], matched: [{ module: 'garage_pass', pass: 'pass-xyz', agreement: null }] }]);
  assert.equal(report.checked, 0);
  assert.equal(asked, 0, 'a covered stay has no fee to recompute');
});

// --- the schema holds the pair together ---------------------------------------------------

test('a lane-decided row carries its inputs and a platform-decided one carries none: the constraint', async () => {
  const g = await garage();
  const car = plate('CONS');
  const id = await opened(g, car);
  assert.equal((await close(g.exit, car, { local_decision: pricedDecision(id) })).status, 200);
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE sessions SET decision_inputs = NULL WHERE id = $1`, [id])),
    /sessions_decision_is_attributed/,
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE sessions SET decided_by = 'platform' WHERE id = $1`, [id])),
    /sessions_decision_is_attributed/,
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE sessions SET decision_inputs = '{"entry_at": 1}' WHERE id = $1`, [id])),
    /sessions_decision_inputs_is_a_record/,
  );
  // and every row closed before 0017 says the platform decided it
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE exit_outcome IS NOT NULL AND decided_by IS NULL`);
  assert.equal(rows[0].n, 0);
});

// --- the modules are still linked, and a lane decision still wins over them -----------------

test('with both modules linked, a priced lane decision is consumed without asking them; no decision asks them', async () => {
  const g = await garage();
  const tag = g.id.slice(0, 8);
  await modules.gpGarage(`gp-${tag}`);
  await modules.mbSeed({ garage: `mb-${tag}`, agreement: `ag-${tag}`, payer: `payer-${tag}`, vehicles: [plate('MNTH')] });
  const linked = await op('PUT', `/garages/${g.id}/entitlement-links`, { garage_pass: gpLink(`gp-${tag}`), monthly_billing: mbLink(`mb-${tag}`) });
  assert.equal(linked.status, 200, await linked.clone().text());
  const car = plate('LNKD');
  const id = await opened(g, car);
  assert.equal((await close(g.exit, car, { local_decision: pricedDecision(id, { feeMinor: 500 }) })).status, 200);
  const row = await rowFor(id);
  assert.equal(row.entitlement.garage_pass, undefined);
  assert.equal(row.entitlement.monthly_billing, undefined);
  assert.equal(row.decided_by, 'lane');
  const other = plate('LNKD');
  const otherId = await opened(g, other);
  assert.equal((await close(g.exit, other)).status, 200);
  const otherRow = await rowFor(otherId);
  assert.equal(otherRow.entitlement.garage_pass.consulted, true, 'today\'s path asks the doors');
  assert.equal(otherRow.decided_by, 'platform');
});
