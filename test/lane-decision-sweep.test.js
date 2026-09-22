/**
 * The reconciler looks WITHOUT BEING ASKED (0018).
 *
 * 0017 gave a device-written fee two things to stand behind it: the inputs it
 * was decided from, and a reconciler that re-derives it. The second only ran
 * when an operator asked, inside the reconciliation route's window -- so a fee
 * nobody queried inside that day was never re-derived. The sweep is what
 * looks: every lane-decided close nothing has checked yet, oldest first, no
 * window over it, on a schedule.
 *
 * Every claim is paired with its control. The planted lane -- one that wrote
 * `fee + 1`, a YEAR ago, far outside any window the route would report on --
 * is what the sweep exists to name, and the row it names is byte-identical
 * afterwards except for the two columns 0018 added.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { DECISION_CHECK_EVENT_KIND, sweepLaneDecisions } from '../src/reconcile.js';
import * as ratePlans from '../src/ratePlans.js';

let engine;
let server;
let base;

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
const asDevice = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ event_id: randomUUID(), ...body }),
});
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
const rowFor = (t, id) => withTenant(t, async (c) => (await c.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0]);

/** A YEAR ago: outside every window the reconciliation route would report on. */
const LONG_AGO_IN = '2025-09-10T12:00:00Z';
const LONG_AGO_OUT = '2025-09-10T14:00:00Z';

/**
 * A TENANT OF ITS OWN per test, with one active garage in it.
 *
 * The sweep's unit is the tenant -- it takes every unchecked lane-decided
 * close the tenant has, across its garages, because a backlog nobody has
 * checked is not a per-garage question. So a test that shared a tenant with
 * another would be sweeping the other's rows too, and its counts would depend
 * on what ran before it. One tenant per test is the isolation the thing under
 * test actually has.
 */
async function world(name) {
  const tenant = await createTenant(`sweep-${name.toLowerCase()}-${randomUUID().slice(0, 8)}`);
  await buildWorld(tenant);
  const operatorToken = await issueOperatorToken(tenant);
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,$2,'America/New_York','USD') RETURNING id`, [tenant, name])).rows[0].id;
    const lane = async (n, direction) =>
      (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, id, n, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan());
    await activateGarage(c, tenant, id);
    return { id, entryLane, exitLane };
  });
  return {
    tenant, operatorToken, ...built,
    entry: await issueToken(tenant, built.entryLane, 'e'),
    exit: await issueToken(tenant, built.exitLane, 'x'),
  };
}

function pricedDecision(sessionId, { feeMinor = 500, planVersion = 'flat-250-USD', entryAt = '2025-09-10T12:00:00+00:00', exitAt = '2025-09-10T14:00:00+00:00', spaceClass = 'standard', currency = 'USD' } = {}) {
  return {
    status: 'priced', covered_by: [], matched: [],
    fee_minor: feeMinor, currency, plan_version: planVersion,
    breakdown: [{ stage: 'ACCUMULATE', rule: 'hourly', amount_minor: feeMinor }],
    entry_at: entryAt, exit_at: exitAt, session_id: sessionId, space_class: spaceClass,
    computed_from: { rules_refreshed_at: 1726920000.5, stays_refreshed_at: 1726920100.5, stays_cursor: '42', day: '2025-09-10', clock: 'America/New_York' },
  };
}

/** A lane-decided close a year old: open, then close carrying `decision`. */
async function laneDecidedClose(g, { feeMinor = 500, decision = null, car = null, exitAt = LONG_AGO_OUT } = {}) {
  const vehicle = car ?? plate('SWEEP');
  const opened = await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(g.entry, { plate: vehicle, entry_at: LONG_AGO_IN, entry_confirmation: 'confirmed' }));
  assert.equal(opened.status, 201, await opened.clone().text());
  const id = (await opened.json()).session.id;
  const carried = decision ?? pricedDecision(id, { feeMinor, exitAt: new Date(exitAt).toISOString() });
  const closed = await fetch(`${base}/api/v1/lane/sessions/close`, asDevice(g.exit, { plate: vehicle, exit_at: exitAt, exit_confirmation: 'confirmed', local_decision: carried }));
  assert.equal(closed.status, 200, await closed.clone().text());
  const row = await rowFor(g.tenant, id);
  assert.equal(row.decided_by, 'lane');
  assert.equal(row.decision_checked_at, null, 'a close is unchecked until something checks it');
  return { id, plate: vehicle, row };
}

const quoteFor = (g) => async (args) =>
  withTenant(g.tenant, async (c) =>
    ratePlans.quoteWithEngine({ ...args, plans: ratePlans.documents(await ratePlans.ratePlansForGarage(c, g.tenant, g.id)) }),
  );

const reconciliation = (g) =>
  fetch(`${base}/api/v1/garages/${g.id}/reconciliation?max_stay_hours=48`, {
    headers: { authorization: `Bearer ${g.operatorToken}` },
  }).then((r) => r.json());

const unchecked = (g) =>
  withTenant(g.tenant, async (c) =>
    Number((await c.query(`SELECT count(*) FROM sessions WHERE garage_id = $1 AND decided_by = 'lane' AND decision_checked_at IS NULL`, [g.id])).rows[0].count),
  );

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

// --- it runs unprompted, and no window bounds it ------------------------------------

test('the sweep names a fee+1 lane on a close a YEAR old, which no window of the route reports on', async () => {
  const g = await world('Unprompted');
  const honest = await laneDecidedClose(g, { feeMinor: 500 });   // what the engine says
  const planted = await laneDecidedClose(g, { feeMinor: 501 });  // fee + 1

  // THE CONTROL: the operator's route, asked with its own default window, sees
  // neither of them -- they are a year outside it. That is the gap.
  const reported = await reconciliation(g);
  assert.equal(reported.lane_decisions.checked, 0, 'the route\'s window reaches a year back');
  assert.deepEqual(reported.lane_decisions.diverged, []);
  assert.equal(reported.lane_decisions_unchecked, 2, 'and it says how many nothing has checked');

  const summary = await sweepLaneDecisions(g.tenant, { quote: quoteFor(g) });
  assert.equal(summary.checked, 2);
  assert.equal(summary.agreed, 1);
  assert.equal(summary.diverged, 1);

  const plantedRow = await rowFor(g.tenant, planted.id);
  assert.equal(plantedRow.decision_check.verdict, 'diverged');
  assert.deepEqual(plantedRow.decision_check.lane, { fee_minor: 501, plan_version: 'flat-250-USD' });
  assert.deepEqual(plantedRow.decision_check.recomputed, { fee_minor: 500, plan_version: 'flat-250-USD' });
  assert.equal(plantedRow.decision_check.synced_at.stays_cursor, '42', 'what the lane decided from, kept with the finding');
  const honestRow = await rowFor(g.tenant, honest.id);
  assert.equal(honestRow.decision_check.verdict, 'agreed');

  // And the route now says nothing is unchecked.
  const after = await reconciliation(g);
  assert.equal(after.lane_decisions_unchecked, 0);
});

test('the sweep corrects nothing: every other column of the named row is byte-identical', async () => {
  const g = await world('Corrects');
  const planted = await laneDecidedClose(g, { feeMinor: 501 });
  const before = await rowFor(g.tenant, planted.id);
  await sweepLaneDecisions(g.tenant, { quote: quoteFor(g) });
  const after = await rowFor(g.tenant, planted.id);

  const moved = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  assert.deepEqual(moved.sort(), ['decision_check', 'decision_checked_at'], `the sweep wrote ${moved}`);
  assert.equal(Number(after.fee_minor), 501, 'the lane\'s wrong fee is still on the row: the evidence');
  assert.equal(Number(after.change_seq), Number(before.change_seq), 'a correction would have bumped the cursor');
});

test('a divergence is also in events, which is append-only by grant', async () => {
  const g = await world('Evented');
  const planted = await laneDecidedClose(g, { feeMinor: 777 });
  const honest = await laneDecidedClose(g, { feeMinor: 500 });
  await sweepLaneDecisions(g.tenant, { quote: quoteFor(g) });
  const events = await withTenant(g.tenant, async (c) =>
    (await c.query(`SELECT * FROM events WHERE tenant_id = $1 AND kind = $2 AND garage_id = $3`, [g.tenant, DECISION_CHECK_EVENT_KIND, g.id])).rows,
  );
  assert.equal(events.length, 1, 'one finding, and only the finding');
  assert.equal(events[0].detail.session_id, planted.id);
  assert.equal(events[0].detail.verdict, 'diverged');
  assert.equal(events[0].detail.actor, 'platform:reconciler');
  assert.equal(events[0].detail.recomputed.fee_minor, 500);
  assert.ok(!JSON.stringify(events[0].detail).includes(planted.plate), 'the plate reached an append-only event');
  assert.ok(!events.some((e) => e.detail.session_id === honest.id), 'an agreed check wrote an event');
});

// --- the queue: once each, oldest first, and one bad row does not stop it ------------

test('a checked close is not checked again, and the sweep takes the oldest first', async () => {
  const g = await world('Queue');
  // DIFFERENT INSTANTS, and the newer one created first: two closes at the
  // same instant are a tie, broken by a random uuid, which is a defensible
  // queue but not something "oldest first" can be asked of. Nothing but the
  // exit time can produce the expected order here.
  const second = await laneDecidedClose(g, { feeMinor: 500, exitAt: '2025-09-10T15:00:00Z' });
  const first = await laneDecidedClose(g, { feeMinor: 500, exitAt: '2025-09-10T14:00:00Z' });
  let asked = 0;
  const counting = async (args) => { asked += 1; return quoteFor(g)(args); };

  const one = await sweepLaneDecisions(g.tenant, { quote: counting, limit: 1 });
  assert.equal(one.checked, 1);
  assert.equal(asked, 1);
  const firstRow = await rowFor(g.tenant, first.id);
  assert.notEqual(firstRow.decision_checked_at, null, 'the oldest was not taken first');
  assert.equal((await rowFor(g.tenant, second.id)).decision_checked_at, null);

  const two = await sweepLaneDecisions(g.tenant, { quote: counting, limit: 10 });
  assert.equal(two.checked, 1, 'a checked close went round again');
  assert.equal(asked, 2, 'the engine was asked about an already-checked close');
  assert.equal(await unchecked(g), 0);

  const third = await sweepLaneDecisions(g.tenant, { quote: counting, limit: 10 });
  assert.deepEqual([third.pending, third.checked], [0, 0]);
});

test('an engine that cannot be asked is itself the verdict, recorded once, and the row untouched', async () => {
  const g = await world('Unaskable');
  const car = await laneDecidedClose(g, { feeMinor: 500 });
  const throwing = async () => { throw new ratePlans.EngineUnavailable('the engine is not there'); };
  const first = await sweepLaneDecisions(g.tenant, { quote: throwing });
  assert.equal(first.checked, 1);
  assert.equal(first.unrecomputable, 1);
  const row = await rowFor(g.tenant, car.id);
  assert.equal(row.decision_check.verdict, 'unrecomputable');
  assert.match(row.decision_check.reason, /could not be asked/);
  assert.equal(Number(row.fee_minor), 500, 'an unrecomputable row was touched');

  // A verdict IS a check: it is recorded, not retried for ever -- the finding
  // is that the engine could not answer, and it is on the row and in events.
  const again = await sweepLaneDecisions(g.tenant, { quote: quoteFor(g) });
  assert.equal(again.checked, 0);
});

test('one row the engine refused does not stop the sweep checking the rest', async () => {
  const g = await world('Failing');
  const first = await laneDecidedClose(g, { feeMinor: 500 });
  const second = await laneDecidedClose(g, { feeMinor: 500 });
  let calls = 0;
  const failingOnce = async (args) => {
    calls += 1;
    if (calls === 1) throw new Error('boom, and not a pricing refusal');
    return quoteFor(g)(args);
  };
  const summary = await sweepLaneDecisions(g.tenant, { quote: failingOnce });
  assert.equal(summary.failed, 0, 'an engine error is a verdict, not a failure to check');
  assert.equal(summary.checked, 2);
  // WHICH of the two got the refusal is not this test's question -- they close
  // at the same instant and the queue breaks that tie by uuid. That BOTH were
  // checked, and that the refusal stopped at its own row, is.
  const verdicts = [
    (await rowFor(g.tenant, first.id)).decision_check.verdict,
    (await rowFor(g.tenant, second.id)).decision_check.verdict,
  ].sort();
  assert.deepEqual(verdicts, ['agreed', 'unrecomputable']);
  assert.deepEqual([summary.agreed, summary.unrecomputable], [1, 1]);
});

// --- what it does with the other kinds ----------------------------------------------

test('a covered close is recorded as covered and the engine is never asked about it', async () => {
  const g = await world('Covered');
  const car = plate('COV');
  const opened = await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(g.entry, { plate: car, entry_at: LONG_AGO_IN, entry_confirmation: 'confirmed' }));
  const id = (await opened.json()).session.id;
  const closed = await fetch(`${base}/api/v1/lane/sessions/close`, asDevice(g.exit, { plate: car, exit_at: LONG_AGO_OUT, exit_confirmation: 'confirmed', local_decision: {
    status: 'covered', covered_by: ['garage_pass'],
    matched: [{ module: 'garage_pass', pass: 'pass-xyz', agreement: null }],
    computed_from: { rules_refreshed_at: 1726920000.5, day: '2025-09-10', clock: 'America/New_York' },
  } }));
  assert.equal(closed.status, 200, await closed.clone().text());

  let asked = 0;
  const summary = await sweepLaneDecisions(g.tenant, { quote: async (a) => { asked += 1; return quoteFor(g)(a); } });
  assert.equal(summary.covered, 1);
  assert.equal(asked, 0, 'the engine was asked to price a covered stay');
  const row = await rowFor(g.tenant, id);
  assert.equal(row.decision_check.verdict, 'covered');
  assert.deepEqual(row.decision_check.covered_by, ['garage_pass']);
  assert.equal(row.fee_minor, null);
});

test('a platform-decided close is not the sweep\'s business and is never taken', async () => {
  const g = await world('Platform');
  const car = plate('PLAT');
  await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(g.entry, { plate: car, entry_at: LONG_AGO_IN, entry_confirmation: 'confirmed' }));
  const closed = await fetch(`${base}/api/v1/lane/sessions/close`, asDevice(g.exit, { plate: car, exit_at: LONG_AGO_OUT, exit_confirmation: 'confirmed' }));
  assert.equal(closed.status, 200, await closed.clone().text());
  const id = (await closed.json()).session.id;
  assert.equal((await rowFor(g.tenant, id)).decided_by, 'platform');
  const summary = await sweepLaneDecisions(g.tenant, { quote: quoteFor(g) });
  assert.equal(summary.pending, 0, 'the sweep took a close this platform priced itself');
  assert.equal((await rowFor(g.tenant, id)).decision_checked_at, null);
});

test('inputs that disagree with the row are named even when the fee agrees', async () => {
  const g = await world('Disagree');
  const car = plate('DIS');
  const opened = await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(g.entry, { plate: car, entry_at: LONG_AGO_IN, entry_confirmation: 'confirmed' }));
  const id = (await opened.json()).session.id;
  // The lane priced from an entry an hour after the one on the row -- and its
  // fee is what the engine says about ITS inputs, so the figure agrees.
  const decision = pricedDecision(id, { feeMinor: 250, entryAt: '2025-09-10T13:00:00+00:00' });
  const closed = await fetch(`${base}/api/v1/lane/sessions/close`, asDevice(g.exit, { plate: car, exit_at: LONG_AGO_OUT, exit_confirmation: 'confirmed', local_decision: decision }));
  assert.equal(closed.status, 200, await closed.clone().text());
  await sweepLaneDecisions(g.tenant, { quote: quoteFor(g) });
  const row = await rowFor(g.tenant, id);
  assert.equal(row.decision_check.verdict, 'inputs_disagree');
  assert.deepEqual(row.decision_check.fields, ['entry_at']);
  assert.equal(row.decision_check.row.entry_at, '2025-09-10T12:00:00.000Z');
  assert.equal(row.decision_check.lane.entry_at, '2025-09-10T13:00:00+00:00');
});

// --- the schema holds the verdict to the check --------------------------------------

test('a row cannot say it was checked without saying what was found, or the other way round', async () => {
  const g = await world('Constraint');
  const car = await laneDecidedClose(g, { feeMinor: 500 });
  await assert.rejects(
    withTenant(g.tenant, (c) => c.query(`UPDATE sessions SET decision_checked_at = now() WHERE id = $1`, [car.id])),
    /sessions_decision_check_is_attributed/,
  );
  await assert.rejects(
    withTenant(g.tenant, (c) => c.query(`UPDATE sessions SET decision_check = '{"verdict":"agreed"}'::jsonb WHERE id = $1`, [car.id])),
    /sessions_decision_check_is_attributed/,
  );
  await assert.rejects(
    withTenant(g.tenant, (c) => c.query(`UPDATE sessions SET decision_checked_at = now(), decision_check = '{"verdict":"corrected"}'::jsonb WHERE id = $1`, [car.id])),
    /sessions_decision_check_is_a_verdict/,
  );
});

test('a platform-decided close cannot carry a check at all', async () => {
  const g = await world('NotLane');
  const car = plate('NL');
  await fetch(`${base}/api/v1/lane/sessions/open`, asDevice(g.entry, { plate: car, entry_at: LONG_AGO_IN, entry_confirmation: 'confirmed' }));
  const closed = await fetch(`${base}/api/v1/lane/sessions/close`, asDevice(g.exit, { plate: car, exit_at: LONG_AGO_OUT, exit_confirmation: 'confirmed' }));
  const id = (await closed.json()).session.id;
  await assert.rejects(
    withTenant(g.tenant, (c) => c.query(`UPDATE sessions SET decision_checked_at = now(), decision_check = '{"verdict":"agreed"}'::jsonb WHERE id = $1`, [id])),
    /sessions_decision_check_is_attributed/,
  );
});
