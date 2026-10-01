/**
 * Tax on what the driver pays (0023).
 *
 *     base lines  ->  the validation line  ->  the tax lines      fee = running total
 *
 * The tax is the ENGINE's (`POST /v1/tax` here, `contract.run_tax` in-process
 * on the lane), on the subtotal after any validation, at the stay's exit
 * instant. Every claim below is paired with the case that would falsify it.
 *
 * THE LANE IN THIS FILE is the lane's arithmetic, not a fixture's numbers:
 * `laneDecides` takes `/lane/rules` as the platform served it and runs the
 * engine's `run_quote` and `run_tax` IN-PROCESS in Python, exactly the two
 * calls `lane-controller`'s `price_exit` makes. So "the lane and the platform
 * agree" compares two real computations.
 *
 * `scripts/tax-on-paid-fail-control.js` breaks each property and requires
 * this file to go red.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, storePlan, flatHourlyPlan, stateTaxes } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { laneDecidedCloses } from '../src/reconcile.js';

const DOOR_DIR = new URL('./fixtures/validations-door/', import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), 'openparking-tax-on-paid-'));
const STATE = join(scratch, 'state.json');
const LOG = join(scratch, 'calls.jsonl');
// Invented, in the range set aside for fiction (555-0100..0199).
const PHONE = '2025550143';

/** 8.75%, rounded UP: 43.75 on 500 is 44; 26.25 on 300 is 27. The two differ. */
const CITY = { id: 'city', label: 'City parking tax', percent_bp: 875, rounding: 'up', sequence: 1 };
/** 10%, a law change: what a later set states. */
const CITY_10 = { ...CITY, percent_bp: 1000 };

const ENTRY = '2026-09-10T12:00:00Z';
const EXIT = '2026-09-10T14:00:00Z';
/** Two hours at 250. */
const BASE = 500;

let engine;
let server;
let base;
let tenant;
let operatorToken;
let admin;

const python = process.env.RATE_ENGINE_PYTHON || 'python3';

async function issueToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [tenantId, laneId, name, hashToken(token)]),
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
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
const rowFor = (id) => withTenant(tenant, async (c) => (await c.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0]);
const rules = async (token) => (await fetch(`${base}/api/v1/lane/rules`, { headers: { authorization: `Bearer ${token}` } })).json();
const taxLines = (breakdown) => breakdown.filter((l) => l.code === 'tax.applied');
/** The argv of the last claim the stand-in door was asked. */
const lastClaimArgv = () =>
  readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.argv[0] === 'claim-in-store').at(-1).argv;
const sum = (lines) => lines.reduce((s, l) => s + Number(l.delta_minor), 0);

/**
 * An active garage: a flat 250/h plan, both lanes, and `sets` as its tax
 * sets (each `{ effectiveFrom, rules }`). Linked to the stand-in door when
 * `validations` is given (the list the door holds for it).
 */
async function garage({ sets = [{ effectiveFrom: '2000-01-01T00:00:00Z', rules: [CITY] }], validations = null } = {}) {
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Taxed','America/New_York','USD') RETURNING id`, [tenant])).rows[0].id;
    const lane = async (name, direction) =>
      (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, id, name, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan());
    for (const s of sets) await stateTaxes(c, tenant, id, { rules: s.rules, effectiveFrom: s.effectiveFrom });
    await c.query(`UPDATE garages SET transient_available = true, activated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenant, id]);
    return { id, entryLane, exitLane };
  });
  const g = { ...built, entry: await issueToken(tenant, built.entryLane, 'e'), exit: await issueToken(tenant, built.exitLane, 'x') };
  if (validations) {
    g.link = { tenant_id: 'vt-1', garage_id: `vg-${g.id.slice(0, 8)}` };
    writeFileSync(STATE, JSON.stringify({ mode: 'normal', garages: { [`${g.link.tenant_id}/${g.link.garage_id}`]: validations } }));
    const res = await op('PUT', `/garages/${g.id}/validations-link`, { validations: g.link });
    assert.equal(res.status, 200, await res.clone().text());
  }
  return g;
}
const validation = (discountMinor) => ({
  phone: PHONE, validator_name: 'Example Name', discount_type: 'flat', discount_value: discountMinor / 100,
  discount_minor: discountMinor, claimed_ref: null,
});

async function opened(g, car) {
  const res = await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(g.entry, { plate: car, entry_at: ENTRY, entry_confirmation: 'confirmed' }));
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).session.id;
}
const close = (g, car, extra = {}, exitAt = EXIT) =>
  fetch(`${base}/api/v1/lane/sessions/close`, asDevice(g.exit, { plate: car, exit_at: exitAt, exit_confirmation: 'confirmed', ...extra }));
const claim = (g, sessionId, decision) =>
  fetch(`${base}/api/v1/lane/sessions/${sessionId}/validation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${g.exit}` },
    body: JSON.stringify({ phone: PHONE, local_decision: decision }),
  });

/**
 * THE LANE: `/lane/rules` as served, priced in-process -- `run_quote`, then
 * `run_tax` on its fee at the exit -- and reported as `ExitPricing.to_detail`
 * writes a priced decision, with the two facts about its tax cache.
 */
function laneDecides(payload, { sessionId, exitAt = EXIT }) {
  const script = `
import json, sys
from datetime import datetime
from rate_engine.contract import run_quote, run_tax
p = json.load(sys.stdin)
qs, q = run_quote({"plans": p["rate_plans"], "currency": p["currency"], "space_class": p["space_class"],
                   "entry_at": p["entry_at"], "exit_at": p["exit_at"]})
assert qs == 200, q
ts, t = run_tax({"tax_sets": p["tax_sets"], "subtotal_minor": q["fee_minor"], "currency": q["currency"], "at": p["exit_at"]})
assert ts == 200, t
sets = p["tax_sets"]
newest = max(sets, key=lambda s: datetime.fromisoformat(s["effective_from"].replace("Z", "+00:00")))["effective_from"] if sets else None
print(json.dumps({"fee_minor": q["fee_minor"] + t["total_minor"], "currency": q["currency"],
                  "plan_version": q["plan_version"], "breakdown": q["breakdown"] + t["lines"],
                  "subtotal_minor": q["fee_minor"],
                  "tax_sets_held": {"count": len(sets), "newest_effective_from": newest}}))
`;
  const exitIso = new Date(exitAt).toISOString().replace('.000Z', '+00:00');
  const entryIso = new Date(ENTRY).toISOString().replace('.000Z', '+00:00');
  const out = spawnSync(python, ['-c', script], { input: JSON.stringify({ ...payload, entry_at: entryIso, exit_at: exitIso }), encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return {
    status: 'priced', covered_by: [], matched: [],
    ...JSON.parse(out.stdout),
    entry_at: entryIso, exit_at: exitIso, session_id: sessionId, space_class: payload.space_class,
    computed_from: { rules_refreshed_at: 1, stays_refreshed_at: 1, stays_cursor: '1', day: '2026-09-10', clock: 'America/New_York' },
  };
}

/** The engine's tax over HTTP, for a control that needs a figure the code under test did not produce. */
async function engineTax(taxSets, subtotalMinor, at = EXIT) {
  const res = await fetch(`${engine.url}/v1/tax`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tax_sets: taxSets, subtotal_minor: subtotalMinor, currency: 'USD', at }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  process.env.ENTITLEMENT_BIN_DIR = DOOR_DIR;
  process.env.VALIDATIONS_STANDIN_STATE = STATE;
  process.env.VALIDATIONS_STANDIN_LOG = LOG;
  tenant = await createTenant('tax-on-paid');
  const token = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(token)]));
  operatorToken = token;
  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Guarded: a `before` that threw leaves these unset.
  if (server) await new Promise((r) => server.close(r));
  if (admin) await admin.end();
  if (engine) await engine.stop();
  await pool.end();
});

beforeEach(() => {
  writeFileSync(STATE, JSON.stringify({ mode: 'normal', garages: {} }));
  writeFileSync(LOG, '');
});

// --- the sets reach the lane --------------------------------------------------------------

test('/lane/rules serves the garage\'s WHOLE list of tax sets, as a load takes them, and nothing of the store\'s', async () => {
  const g = await garage({
    sets: [
      { effectiveFrom: '2000-01-01T00:00:00Z', rules: [CITY] },
      { effectiveFrom: '2030-01-01T00:00:00Z', rules: [CITY_10] }, // future: still served
      { effectiveFrom: '2001-06-01T00:00:00.000001Z', rules: [] },
    ],
  });
  const payload = await rules(g.entry);
  assert.deepEqual(payload.tax_sets, [
    { effective_from: '2000-01-01T00:00:00.000000Z', rules: [CITY] },
    { effective_from: '2001-06-01T00:00:00.000001Z', rules: [] },
    { effective_from: '2030-01-01T00:00:00.000000Z', rules: [CITY_10] },
  ], 'every set, oldest first, each one exactly its instant to the microsecond and its rules');
  // CONTROL: the store's own read carries more than a load takes.
  const stored = (await (await op('GET', `/garages/${g.id}/tax-sets`)).json()).tax_sets;
  assert.ok('id' in stored[0] && 'rule_count' in stored[0] && 'created_at' in stored[0]);
});

// --- no validation ----------------------------------------------------------------------

test('NO VALIDATION, priced here: the tax lines come last, the subtotal is kept, and the ledger is the fee', async () => {
  const g = await garage();
  const car = plate('PLAT');
  const id = await opened(g, car);
  const res = await close(g, car);
  assert.equal(res.status, 200, await res.clone().text());
  const { session } = await res.json();
  const row = await rowFor(id);
  assert.equal(session.subtotal_minor, BASE);
  assert.deepEqual(taxLines(row.breakdown).map((l) => [l.rule_id, l.delta_minor]), [['city', 44]], '8.75% of 5.00, up');
  assert.equal(row.breakdown.at(-1).code, 'tax.applied', 'the tax is the last line');
  assert.equal(session.fee_minor, BASE + 44);
  assert.equal(sum(row.breakdown), session.fee_minor, 'the ledger sums to the fee');
  assert.equal(Number(row.subtotal_minor) + sum(taxLines(row.breakdown)), Number(row.fee_minor));
});

test('CONTROL: a garage whose set states no rules -- no tax lines, and the fee is the fee it was before this round', async () => {
  const g = await garage({ sets: [{ effectiveFrom: '2000-01-01T00:00:00Z', rules: [] }] });
  const car = plate('NONE');
  const id = await opened(g, car);
  assert.equal((await close(g, car)).status, 200);
  const row = await rowFor(id);
  assert.deepEqual(taxLines(row.breakdown), []);
  assert.deepEqual([Number(row.fee_minor), Number(row.subtotal_minor)], [BASE, BASE]);
});

test('NO VALIDATION, the lane decided: the row is the lane\'s decision exactly, tax included', async () => {
  const g = await garage();
  const car = plate('LANE');
  const id = await opened(g, car);
  const decision = laneDecides(await rules(g.exit), { sessionId: id });
  assert.equal(decision.fee_minor, BASE + 44, 'the lane taxed it');
  const res = await close(g, car, { local_decision: decision });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await rowFor(id);
  assert.equal(row.decided_by, 'lane', JSON.stringify(row.entitlement?.local_decision_ignored));
  // Every line, every value, in the lane's order. (Not the JSON text: `jsonb`
  // stores an object's keys in its own order, which is storage, not value.)
  assert.deepStrictEqual(row.breakdown, decision.breakdown, 'the ledger, exactly as the lane decided it');
  assert.equal(Number(row.fee_minor), decision.fee_minor);
  assert.equal(Number(row.subtotal_minor), decision.subtotal_minor);
});

// --- with a validation ------------------------------------------------------------------

test('WITH A VALIDATION: the claim is on the pre-tax subtotal, the tax is on the DISCOUNTED subtotal, and the order holds', async () => {
  const g = await garage({ validations: [validation(200)] });
  const car = plate('VAL');
  const id = await opened(g, car);
  const decision = laneDecides(await rules(g.exit), { sessionId: id });
  const claimed = await claim(g, id, decision);
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const answer = (await claimed.json()).validation;
  assert.equal(answer.fee_before_minor, BASE, 'the claim was made on the subtotal, not the taxed 544');
  assert.equal(answer.subtotal_minor, BASE - 200);
  assert.deepEqual(answer.tax_lines.map((l) => l.delta_minor), [27], '8.75% of 3.00, up');
  assert.equal(answer.fee_minor, BASE - 200 + 27, 'the reader is told the TAXED discounted figure');
  const argv = lastClaimArgv();
  assert.equal(argv[argv.indexOf('--base-minor') + 1], String(BASE), 'the door was asked about the subtotal');

  const res = await close(g, car, { local_decision: decision, reader_shown: { fee_minor: answer.fee_minor, currency: 'USD' } });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await rowFor(id);
  assert.equal(row.validation.state, 'recorded', row.validation.reason);
  assert.deepEqual(row.breakdown.map((l) => l.code).slice(-2), ['validation', 'tax.applied'], 'validation, then tax');
  assert.ok(!row.breakdown.slice(0, -2).some((l) => l.code === 'tax.applied'), "the lane's tax on the full fee is gone");
  assert.equal(Number(row.subtotal_minor), BASE - 200);
  assert.deepEqual(taxLines(row.breakdown).map((l) => l.delta_minor), [27]);
  assert.equal(Number(row.fee_minor), answer.fee_minor, 'the row says what the reader said');
  assert.equal(sum(row.breakdown), Number(row.fee_minor));
  assert.deepEqual([row.validation.fee_before_minor, row.validation.fee_after_minor], [BASE, BASE - 200], 'the record stays pre-tax');

  // THE CONTROL THAT MATTERS: tax on the UNDISCOUNTED fee is another number,
  // so a build taxing the full fee cannot pass the line above.
  const undiscounted = await engineTax((await rules(g.exit)).tax_sets, BASE);
  assert.equal(undiscounted.total_minor, 44);
  assert.notEqual(undiscounted.total_minor, sum(taxLines(row.breakdown)));
});

test('A VALIDATION LEAVING THE DRIVER AT ZERO: no tax line at all -- not a zero one', async () => {
  const g = await garage({ validations: [validation(BASE)] });
  const car = plate('ZERO');
  const id = await opened(g, car);
  const decision = laneDecides(await rules(g.exit), { sessionId: id });
  const answer = (await (await claim(g, id, decision)).json()).validation;
  assert.deepEqual([answer.subtotal_minor, answer.tax_lines, answer.fee_minor], [0, [], 0]);
  const res = await close(g, car, { local_decision: decision, reader_shown: { fee_minor: 0, currency: 'USD' } });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await rowFor(id);
  assert.equal(row.validation.state, 'recorded', row.validation.reason);
  assert.deepEqual(taxLines(row.breakdown), [], 'no tax line, of any value');
  assert.deepEqual([Number(row.fee_minor), Number(row.subtotal_minor)], [0, 0]);
});

test('CONTROL: the same stay with a PARTIAL validation carries tax lines', async () => {
  const g = await garage({ validations: [validation(BASE - 1)] });
  const car = plate('PART');
  const id = await opened(g, car);
  const decision = laneDecides(await rules(g.exit), { sessionId: id });
  const answer = (await (await claim(g, id, decision)).json()).validation;
  assert.deepEqual(answer.tax_lines.map((l) => l.delta_minor), [1], '8.75% of 0.01, up, is 0.01');
  assert.equal((await close(g, car, { local_decision: decision, reader_shown: { fee_minor: answer.fee_minor, currency: 'USD' } })).status, 200);
  assert.deepEqual(taxLines((await rowFor(id)).breakdown).map((l) => l.delta_minor), [1]);
});

test('THE READER: a reader that showed the UNTAXED discounted figure is not what the close records', async () => {
  const g = await garage({ validations: [validation(200)] });
  const car = plate('SHOW');
  const id = await opened(g, car);
  const decision = laneDecides(await rules(g.exit), { sessionId: id });
  assert.equal((await claim(g, id, decision)).status, 200);
  const res = await close(g, car, { local_decision: decision, reader_shown: { fee_minor: BASE - 200, currency: 'USD' } });
  assert.equal(res.status, 200);
  const row = await rowFor(id);
  assert.notEqual(row.validation.state, 'recorded');
  assert.match(row.validation.reason, /not the discounted 327 USD/);
  assert.equal(Number(row.fee_minor), decision.fee_minor, "the lane's taxed fee, undiscounted, as shown at the barrier");
});

test('a close the platform prices itself records a hold on the same subtotal, taxed at its own exit', async () => {
  const g = await garage({ validations: [validation(200)] });
  const car = plate('SELF');
  const id = await opened(g, car);
  const answer = (await (await claim(g, id, laneDecides(await rules(g.exit), { sessionId: id }))).json()).validation;
  const res = await close(g, car, { reader_shown: { fee_minor: answer.fee_minor, currency: 'USD' } });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await rowFor(id);
  assert.equal(row.decided_by, 'platform');
  assert.equal(row.validation.state, 'recorded', row.validation.reason);
  assert.equal(Number(row.fee_minor), 327);
});

// --- the lane and the platform agree --------------------------------------------------------

test('THE LANE AND THE PLATFORM AGREE: one stay, one instant, one set -- the same lines', async () => {
  const g = await garage();
  const car = plate('AGREE');
  const id = await opened(g, car);
  const lane = laneDecides(await rules(g.exit), { sessionId: id });
  assert.equal((await close(g, car)).status, 200, 'the platform prices it itself');
  const row = await rowFor(id);
  assert.equal(row.decided_by, 'platform');
  assert.deepEqual(taxLines(row.breakdown), taxLines(lane.breakdown));
  assert.equal(Number(row.fee_minor), lane.fee_minor);
});

test('CONTROL: two instants either side of a set\'s effective_from are taxed differently', async () => {
  const sets = [
    { effectiveFrom: '2000-01-01T00:00:00Z', rules: [CITY] },
    { effectiveFrom: '2026-09-10T14:00:00Z', rules: [CITY_10] },
  ];
  const g = await garage({ sets });
  const before = plate('EDGEA');
  const at = plate('EDGEB');
  const a = await opened(g, before);
  const b = await opened(g, at);
  assert.equal((await close(g, before, {}, '2026-09-10T13:59:59Z')).status, 200);
  assert.equal((await close(g, at, {}, '2026-09-10T14:00:00Z')).status, 200);
  const [ra, rb] = [await rowFor(a), await rowFor(b)];
  assert.deepEqual(taxLines(ra.breakdown).map((l) => l.delta_minor), [44], 'one second before: the old set');
  assert.deepEqual(taxLines(rb.breakdown).map((l) => l.delta_minor), [50], 'at the instant: the new set');
});

test('A STALE CACHE missing a LATER-dated set is refused, and the close prices for itself', async () => {
  const g = await garage();
  const car = plate('LATER');
  const id = await opened(g, car);
  const decision = laneDecides(await rules(g.exit), { sessionId: id });
  await withTenant(tenant, (c) => stateTaxes(c, tenant, g.id, { rules: [CITY_10], effectiveFrom: '2026-09-10T13:00:00Z' }));
  const res = await close(g, car, { local_decision: decision });
  assert.equal(res.status, 200);
  const row = await rowFor(id);
  assert.equal(row.decided_by, 'platform');
  assert.match(row.entitlement.local_decision_ignored.reason, /held 1 tax set\(s\) and the garage has stated 2/);
  assert.deepEqual(taxLines(row.breakdown).map((l) => l.delta_minor), [50], 'taxed with the set in force');
});

test('A STALE CACHE missing a BACKDATED set -- one inserted between two it holds -- is ALSO refused (the count test)', async () => {
  const g = await garage({
    sets: [
      { effectiveFrom: '2000-01-01T00:00:00Z', rules: [CITY] },
      { effectiveFrom: '2027-01-01T00:00:00Z', rules: [CITY] },
    ],
  });
  const car = plate('BACK');
  const id = await opened(g, car);
  const decision = laneDecides(await rules(g.exit), { sessionId: id });
  assert.equal(decision.tax_sets_held.newest_effective_from, '2027-01-01T00:00:00.000000Z');
  // Backdated: between the two the lane holds, and in force at the exit. The
  // window test cannot see it -- it is not later than the lane's newest.
  await withTenant(tenant, (c) => stateTaxes(c, tenant, g.id, { rules: [CITY_10], effectiveFrom: '2026-07-01T00:00:00Z' }));
  assert.equal((await close(g, car, { local_decision: decision })).status, 200);
  const row = await rowFor(id);
  assert.equal(row.decided_by, 'platform', 'the lane taxed 44 with the old set; the row must not say so');
  assert.match(row.entitlement.local_decision_ignored.reason, /held 2 tax set\(s\) and the garage has stated 3/);
  assert.deepEqual(taxLines(row.breakdown).map((l) => l.delta_minor), [50]);
});

test('THE WINDOW TEST stands on its own: when the count premise breaks, a later set in force is still refused', async () => {
  const g = await garage({
    sets: [
      { effectiveFrom: '2000-01-01T00:00:00Z', rules: [CITY] },
      { effectiveFrom: '2001-01-01T00:00:00Z', rules: [CITY] },
    ],
  });
  const car = plate('WIN');
  const id = await opened(g, car);
  const decision = laneDecides(await rules(g.exit), { sessionId: id });
  // The premise broken by hand, as only the owner can: a set removed, so a
  // new one leaves the count where the lane saw it.
  await admin.query(`DELETE FROM garage_tax_sets WHERE garage_id = $1 AND effective_from = '2001-01-01T00:00:00Z'`, [g.id]);
  await withTenant(tenant, (c) => stateTaxes(c, tenant, g.id, { rules: [CITY_10], effectiveFrom: '2026-09-10T13:00:00Z' }));
  assert.equal((await close(g, car, { local_decision: decision })).status, 200);
  const row = await rowFor(id);
  assert.equal(row.decided_by, 'platform');
  assert.match(row.entitlement.local_decision_ignored.reason, /taking effect after the newest the lane held/);
});

// --- the refusal window -----------------------------------------------------------------

test('THE REFUSAL WINDOW: after a set is stated, claims at that garage are refused until the lane refreshes -- then accepted', async () => {
  const g = await garage({ validations: [validation(200)] });
  const car = plate('WINDOW');
  const id = await opened(g, car);
  const stale = laneDecides(await rules(g.exit), { sessionId: id });
  // A set for next year: changes no figure today, and still refuses (count).
  await withTenant(tenant, (c) => stateTaxes(c, tenant, g.id, { rules: [CITY_10], effectiveFrom: '2027-01-01T00:00:00Z' }));
  const refused = await claim(g, id, stale);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'decision_not_consumable');
  // The lane refreshes: its copy now holds both sets.
  const fresh = laneDecides(await rules(g.exit), { sessionId: id });
  assert.equal(fresh.tax_sets_held.count, 2);
  const accepted = await claim(g, id, fresh);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal((await accepted.json()).validation.outcome, 'held');
});

test('CONTROL: a garage with no new set stated keeps accepting claims throughout', async () => {
  const g = await garage({ validations: [validation(200)] });
  const other = await garage({ validations: [validation(200)] });
  const car = plate('CALM');
  const id = await opened(g, car);
  const decision = laneDecides(await rules(g.exit), { sessionId: id });
  // A set stated at ANOTHER garage changes nothing here.
  await withTenant(tenant, (c) => stateTaxes(c, tenant, other.id, { rules: [CITY_10], effectiveFrom: '2027-01-01T00:00:00Z' }));
  writeFileSync(STATE, JSON.stringify({ mode: 'normal', garages: { [`${g.link.tenant_id}/${g.link.garage_id}`]: [validation(200)] } }));
  const res = await claim(g, id, decision);
  assert.equal(res.status, 200, await res.clone().text());
});

// --- the reconciler -----------------------------------------------------------------------

test('THE RECONCILER: a taxed, validated row re-derives to the engine\'s base and agrees; a planted minor unit diverges', async () => {
  const own = await createTenant('tax-on-paid-reconcile');
  const saved = { tenant, operatorToken };
  tenant = own;
  try {
    const token = generateDeviceToken();
    await withTenant(own, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [own, hashToken(token)]));
    operatorToken = token;
    const g = await garage({ validations: [validation(200)] });
    const car = plate('RECON');
    const id = await opened(g, car);
    const decision = laneDecides(await rules(g.exit), { sessionId: id });
    const answer = (await (await claim(g, id, decision)).json()).validation;
    assert.equal((await close(g, car, { local_decision: decision, reader_shown: { fee_minor: answer.fee_minor, currency: 'USD' } })).status, 200);
    assert.equal((await rowFor(id)).validation.state, 'recorded');
    let report = await withTenant(own, (c) => laneDecidedCloses(c, own, g.id, '2026-09-10T00:00:00Z'));
    assert.deepEqual([report.checked, report.agreed, report.diverged.length], [1, 1, 0]);

    // CONTROL: a lane one minor unit off on its BASE, consistent in itself.
    const car2 = plate('RECON');
    const id2 = await opened(g, car2);
    const off = laneDecides(await rules(g.exit), { sessionId: id2 });
    off.breakdown = off.breakdown.map((l, i) => (i === 0 ? { ...l, delta_minor: l.delta_minor + 1 } : l));
    off.subtotal_minor += 1;
    off.fee_minor += 1;
    assert.equal((await close(g, car2, { local_decision: off })).status, 200);
    assert.equal((await rowFor(id2)).decided_by, 'lane');
    report = await withTenant(own, (c) => laneDecidedCloses(c, own, g.id, '2026-09-10T00:00:00Z'));
    assert.equal(report.diverged.length, 1);
    assert.equal(report.diverged[0].session_id, id2);
  } finally {
    ({ tenant, operatorToken } = saved);
  }
});

// --- an old lane --------------------------------------------------------------------------

test('AN OLD LANE\'S DECISION, with no subtotal, is not consumed and the reason is on the row', async () => {
  const g = await garage();
  const car = plate('OLD');
  const id = await opened(g, car);
  const old = laneDecides(await rules(g.exit), { sessionId: id });
  delete old.subtotal_minor;
  delete old.tax_sets_held;
  old.fee_minor = BASE;
  old.breakdown = old.breakdown.filter((l) => l.code !== 'tax.applied');
  assert.equal((await close(g, car, { local_decision: old })).status, 200);
  const row = await rowFor(id);
  assert.equal(row.decided_by, 'platform');
  assert.match(row.entitlement.local_decision_ignored.reason, /no pre-tax subtotal/);
  assert.equal(Number(row.fee_minor), BASE + 44, 'the untaxed fee was not written');
});

test('CONTROL: the same decision carrying its subtotal IS consumed', async () => {
  const g = await garage();
  const car = plate('NEW');
  const id = await opened(g, car);
  assert.equal((await close(g, car, { local_decision: laneDecides(await rules(g.exit), { sessionId: id }) })).status, 200);
  assert.equal((await rowFor(id)).decided_by, 'lane');
});

test('a decision whose subtotal and tax lines do not add up to its fee is not consumed', async () => {
  const g = await garage();
  const car = plate('SUMS');
  const id = await opened(g, car);
  const decision = laneDecides(await rules(g.exit), { sessionId: id });
  decision.fee_minor += 1;
  assert.equal((await close(g, car, { local_decision: decision })).status, 200);
  const row = await rowFor(id);
  assert.equal(row.decided_by, 'platform');
  assert.match(row.entitlement.local_decision_ignored.reason, /do not add up to its fee/);
});

// --- the table ----------------------------------------------------------------------------

test('THE TABLE refuses a row whose subtotal and tax lines do not add up to its fee', async () => {
  const g = await garage();
  const car = plate('TABLE');
  const id = await opened(g, car);
  assert.equal((await close(g, car)).status, 200);
  await assert.rejects(
    admin.query('UPDATE sessions SET subtotal_minor = subtotal_minor + 1 WHERE id = $1', [id]),
    (err) => err.constraint === 'sessions_subtotal_plus_tax_is_the_fee',
  );
  // CONTROL: a row that adds up is accepted -- the same values written again.
  await admin.query('UPDATE sessions SET subtotal_minor = subtotal_minor WHERE id = $1', [id]);
  // And a row with no subtotal -- every row closed before this round -- is not judged.
  await admin.query('UPDATE sessions SET subtotal_minor = NULL, fee_minor = fee_minor + 1 WHERE id = $1', [id]);
});
