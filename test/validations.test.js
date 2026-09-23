/**
 * A validation at the exit (migration 0019, amendment A1), driven through the
 * lane's routes against the REAL engine and a STAND-IN for the validations
 * module's door (`test/fixtures/validations-door`): the module is not in this
 * repository, and the stand-in speaks its contract and nothing else.
 *
 * What is held here is this platform's side: the claim is made AT THE READER,
 * on the fee the lane priced, and held on the open stay; the close RECORDS it
 * -- one line on the ledger, the fee its running total, no door asked, nothing
 * re-priced; a hold no close takes is GIVEN BACK, by the close or by the sweep,
 * so a driver who entered a phone and did not pay strands nothing; the phone
 * reaches the door on stdin and is kept nowhere; the reconciler compares the
 * engine's number with the fee WITHOUT the validation line.
 *
 * Amendment A2: the close records a hold only when it says the reader SHOWED
 * the discounted fee (`reader_shown`), and gives it back otherwise; and every
 * door call that changes the module is preceded by a committed record here --
 * `claiming` before a claim, `releasing` before a release -- neither of which
 * any close records as a discount, and both of which the sweep finishes.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { laneDecidedCloses, sweepLaneDecisions } from '../src/reconcile.js';
import {
  LINE_CODE, LINK_STATED_EVENT_KIND, REFUSED_EVENT_KIND, RELEASED_EVENT_KIND, RELEASED_BEFORE_CLOSE_EVENT_KIND, releaseStaleHolds,
} from '../src/validations.js';

const DOOR_DIR = new URL('./fixtures/validations-door/', import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), 'openparking-validations-'));
const STATE = join(scratch, 'state.json');
const LOG = join(scratch, 'calls.jsonl');

// Invented numbers, in the range set aside for fiction (555-0100..0199).
const PHONE = '(202) 555-0143';
const PHONE_DIGITS = '2025550143';
const OTHER_PHONE = '202-555-0177';

let engine;
let server;
let base;
let tenant;
let operatorToken;

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
const open = (token, plate) =>
  fetch(`${base}/api/v1/lane/sessions/open`, asDevice(token, { plate, entry_at: '2026-09-10T12:00:00Z', entry_confirmation: 'confirmed' }));
const closeRequest = (token, plate, extra = {}) =>
  asDevice(token, { plate, exit_at: '2026-09-10T14:00:00Z', exit_confirmation: 'confirmed', ...extra });
const close = (token, plate, extra = {}) => fetch(`${base}/api/v1/lane/sessions/close`, closeRequest(token, plate, extra));
const computedFrom = { rules_refreshed_at: 1, stays_refreshed_at: 1, stays_cursor: '1', day: '2026-09-10', clock: 'America/New_York' };
/** The lane's priced decision for a stay: two hours at 250 is 500, the engine's own lines. */
const priced = (sessionId, { feeMinor = 500, entryAt = '2026-09-10T12:00:00+00:00', exitAt = '2026-09-10T14:00:00+00:00' } = {}) => ({
  status: 'priced', covered_by: [], matched: [], fee_minor: feeMinor, currency: 'USD', plan_version: 'flat-250-USD',
  breakdown: [{ code: 'increment.first_period', rule_id: 'hourly', text: 'first hour', delta_minor: 250 },
    { code: 'increment.repeat_periods', rule_id: 'hourly', text: 'more hours', delta_minor: feeMinor - 250 }],
  entry_at: entryAt, exit_at: exitAt, session_id: sessionId, space_class: 'standard', computed_from: computedFrom,
});
/** What the reader showed: the discounted fee of the stand-in's default validation (500 - 200). */
const SHOWN = { fee_minor: 300, currency: 'USD' };
const coveredDecision = () => ({
  status: 'covered', covered_by: ['garage_pass'], matched: [{ module: 'garage_pass', pass: 'pass-x', agreement: null }], computed_from: computedFrom,
});
/** The reader's claim: the phone the driver entered, on the decision the reader shows. */
const claimAt = (token, sessionId, phone, decision) =>
  fetch(`${base}/api/v1/lane/sessions/${sessionId}/validation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ phone, local_decision: decision }),
  });
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
const rowFor = (id) => withTenant(tenant, async (c) => (await c.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0]);
const eventsOf = (kind, garageId) =>
  withTenant(tenant, async (c) =>
    (await c.query(`SELECT * FROM events WHERE tenant_id = $1 AND kind = $2 AND garage_id = $3 ORDER BY received_at`, [tenant, kind, garageId])).rows,
  );

/** An active garage with a flat 250/h plan: two hours is 500. */
async function garage() {
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Validations','America/New_York','USD') RETURNING id`, [tenant])).rows[0].id;
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

// --- the stand-in's state and what it was asked ------------------------------------------

function setState(state) {
  writeFileSync(STATE, JSON.stringify({ mode: 'normal', garages: {}, ...state }));
}
const readState = () => JSON.parse(readFileSync(STATE, 'utf8'));
function setMode(mode) {
  writeFileSync(STATE, JSON.stringify({ ...readState(), mode }));
}
const calls = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const validation = (over = {}) => ({
  phone: PHONE_DIGITS, validator_name: 'Invented Bistro', discount_type: 'flat', discount_value: 2, discount_minor: 200, claimed_ref: null, ...over,
});

const heldRef = (g) => readState().garages[`${g.link.tenant_id}/${g.link.garage_id}`][0].claimed_ref;
/** A garage linked to the stand-in, which holds `list` for it. */
async function linked(list = [validation()]) {
  const g = await garage();
  const link = { tenant_id: 'vt-1', garage_id: `vg-${g.id.slice(0, 8)}` };
  setState({ garages: { [`${link.tenant_id}/${link.garage_id}`]: list } });
  const res = await op('PUT', `/garages/${g.id}/validations-link`, { validations: link });
  assert.equal(res.status, 200, await res.clone().text());
  writeFileSync(LOG, '');
  return { ...g, link };
}
async function opened(g, car) {
  const res = await open(g.entry, car);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).session.id;
}

// --- the phone, anywhere it could be kept ------------------------------------------------

/** Does `text` hold the number, in any of the ways people write one? */
function holdsPhone(text, digits = PHONE_DIGITS) {
  const spaced = new RegExp(digits.split('').join('[\\s().+-]{0,3}'));
  return spaced.test(text) || text.includes('phone_last4') || text.includes(`"${digits.slice(-4)}"`);
}
/** Everything this platform stored about a garage: its row, its stays, its events. */
async function storedAbout(garageId) {
  return withTenant(tenant, async (c) => {
    const rows = [];
    for (const [sql] of [
      ['SELECT * FROM garages WHERE id = $1'],
      ['SELECT * FROM sessions WHERE garage_id = $1'],
      ['SELECT * FROM events WHERE garage_id = $1'],
    ]) rows.push(...(await c.query(sql, [garageId])).rows);
    return JSON.stringify(rows);
  });
}

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  process.env.ENTITLEMENT_BIN_DIR = DOOR_DIR;
  process.env.VALIDATIONS_STANDIN_STATE = STATE;
  process.env.VALIDATIONS_STANDIN_LOG = LOG;
  tenant = await createTenant('validations');
  await buildWorld(tenant);
  const token = generateDeviceToken();
  await withTenant(tenant, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(token)]),
  );
  operatorToken = token;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

beforeEach(async () => {
  setState({});
  writeFileSync(LOG, '');
  // The sweep is per tenant: holds an earlier test left on its open stays --
  // whose module state is gone with it -- are cleared, so each test's sweep
  // counts its own.
  await withTenant(tenant, (c) =>
    c.query(`UPDATE sessions SET validation = NULL WHERE tenant_id = $1 AND validation->>'state' IN ('held', 'claiming', 'releasing')`, [tenant]),
  );
});

// --- the check first: it can see a number -----------------------------------------------

test('CONTROL: the phone check finds a planted number, in a stored row, in every way it is written', async () => {
  for (const written of [PHONE, PHONE_DIGITS, '+1 202 555 0143', '202.555.0143', '{"phone_last4":"0143"}']) {
    assert.equal(holdsPhone(JSON.stringify({ planted: written })), true, written);
  }
  assert.equal(holdsPhone(JSON.stringify({ at: '2026-09-10T14:00:00Z', id: randomUUID() })), false);
  // And through the database: a planted record on a real stay is found.
  const g = await linked();
  const car = plate('CTRL');
  const id = await opened(g, car);
  assert.equal(holdsPhone(await storedAbout(g.id)), false, 'the premise: nothing planted yet');
  await withTenant(tenant, (c) =>
    c.query(`UPDATE sessions SET validation = $2 WHERE id = $1`, [id, JSON.stringify({ state: 'held', planted: PHONE })]),
  );
  assert.equal(holdsPhone(await storedAbout(g.id)), true);
});

// --- claimed at the reader, recorded at the close ------------------------------------------

test('the phone is claimed when it is entered: the reader is answered the discounted fee, and the claim is held on the open stay', async () => {
  const g = await linked();
  const car = plate('RDR');
  const id = await opened(g, car);
  const res = await claimAt(g.exit, id, PHONE, priced(id));
  assert.equal(res.status, 200, await res.clone().text());
  const { validation } = await res.json();
  assert.deepEqual(validation, {
    outcome: 'held', replay: false, currency: 'USD', fee_before_minor: 500, discount_minor: 200, fee_minor: 300,
    line: { code: LINE_CODE, rule_id: null, delta_minor: -200, text: 'Validation from Invented Bistro (2.00 USD off): -2.00 USD' },
    held_at: validation.held_at,
  });
  const row = await rowFor(id);
  assert.equal(row.exit_at, null, 'the stay is still open: nothing has left');
  assert.equal(row.validation.state, 'held');
  assert.equal(row.fee_minor, null, 'no fee is written before the close');
  assert.equal(heldRef(g), id, 'the module holds the claim for this stay');
  // The phone went on stdin, to both verbs, and on no argv; it is nowhere kept.
  const asked = calls();
  assert.deepEqual(asked.map((c) => c.argv[0]), ['validation-in-store', 'claim-in-store']);
  for (const c of asked) {
    assert.equal(c.stdin, `${PHONE}\n`);
    assert.equal(holdsPhone(JSON.stringify(c.argv)), false);
  }
  assert.deepEqual(asked[1].argv.slice(-8), ['--consumer', 'openparking', '--ref', id, '--base-minor', '500', '--currency', 'USD']);
  assert.equal(holdsPhone(await storedAbout(g.id)), false);
});

test('the close records what was claimed: the same line on the ledger, no door asked, nothing re-priced, and the reconciler agrees', async () => {
  const own = await createTenant('validations-lane');
  const saved = { tenant, operatorToken };
  tenant = own;
  try {
    await buildWorld(own);
    const token = generateDeviceToken();
    await withTenant(own, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [own, hashToken(token)]));
    operatorToken = token;
    const g = await linked();
    const car = plate('REC');
    const id = await opened(g, car);
    const shown = (await (await claimAt(g.exit, id, PHONE, priced(id))).json()).validation;
    writeFileSync(LOG, '');
    const res = await close(g.exit, car, { local_decision: priced(id), reader_shown: SHOWN });
    assert.equal(res.status, 200, await res.clone().text());
    const row = await rowFor(id);
    assert.deepEqual(calls(), [], 'the close asked the door nothing');
    assert.equal(row.fee_minor, String(shown.fee_minor), 'the row says what the reader said');
    assert.deepEqual(row.breakdown.at(-1), shown.line);
    assert.equal(row.breakdown.reduce((sum, l) => sum + l.delta_minor, 0), 300, 'the fee IS the running total');
    assert.equal(row.validation.state, 'recorded');
    assert.deepEqual([row.validation.fee_before_minor, row.validation.fee_after_minor], [500, 300]);
    const report = await withTenant(own, (c) => laneDecidedCloses(c, own, g.id, '2026-09-10T00:00:00Z'));
    assert.deepEqual([report.checked, report.agreed, report.diverged.length], [1, 1, 0]);
    await sweepLaneDecisions(own);
    assert.equal((await rowFor(id)).decision_check.verdict, 'agreed');
    assert.equal(holdsPhone(await storedAbout(g.id)), false);
  } finally {
    ({ tenant, operatorToken } = saved);
  }
});

test('a close the platform prices itself at the same fee records the hold too', async () => {
  const g = await linked();
  const car = plate('SELF');
  const id = await opened(g, car);
  assert.equal((await claimAt(g.exit, id, PHONE, priced(id))).status, 200);
  assert.equal((await close(g.exit, car, { reader_shown: SHOWN })).status, 200);
  const row = await rowFor(id);
  assert.equal(row.decided_by, 'platform');
  assert.equal(row.fee_minor, '300');
  assert.equal(row.validation.state, 'recorded');
});

// --- a hold no close takes is given back -------------------------------------------------

test('NOT PAID: the driver entered a phone and did not leave; the sweep gives the claim back and the phone claims again', async () => {
  const g = await linked();
  const car = plate('NPAY');
  const id = await opened(g, car);
  assert.equal((await claimAt(g.exit, id, PHONE, priced(id))).status, 200);
  const heldAt = new Date((await rowFor(id)).validation.held_at);
  assert.equal(heldRef(g), id);

  // Inside the window: the hold stands.
  let summary = await releaseStaleHolds(tenant, { holdMinutes: 30, now: new Date(heldAt.getTime() + 29 * 60_000) });
  assert.equal(summary.released, 0);
  assert.equal((await rowFor(id)).validation.state, 'held');

  // Past it: given back through the door, said on the stay and in an event.
  summary = await releaseStaleHolds(tenant, { holdMinutes: 30, now: new Date(heldAt.getTime() + 31 * 60_000) });
  assert.deepEqual([summary.stale, summary.released, summary.failed], [1, 1, 0]);
  assert.equal(heldRef(g), null, 'the module holds no claim: the validation is unclaimed again');
  const row = await rowFor(id);
  assert.equal(row.exit_at, null);
  assert.equal(row.validation.state, 'released');
  assert.equal(row.validation.released_by, 'sweep');
  assert.equal(calls().at(-1).argv[0], 'release-in-store');
  assert.equal(calls().at(-1).stdin, '\n', 'a release carries no phone');
  assert.equal((await eventsOf(RELEASED_EVENT_KIND, g.id)).length, 1);

  // The driver comes back to the reader: the phone claims again, for the same stay.
  const again = await claimAt(g.exit, id, PHONE, priced(id));
  assert.equal((await again.json()).validation.outcome, 'held');
  assert.equal(heldRef(g), id);
  assert.equal(holdsPhone(await storedAbout(g.id)), false);
});

test('given back while the car was still inside: another stay can use the validation', async () => {
  const g = await linked();
  const first = plate('FRST');
  const second = plate('SCND');
  const a = await opened(g, first);
  const b = await opened(g, second);
  assert.equal((await claimAt(g.exit, a, PHONE, priced(a))).status, 200);
  const refused = await (await claimAt(g.exit, b, PHONE, priced(b))).json();
  assert.deepEqual(refused.validation, { outcome: 'not_validated', reason: 'already_claimed' });
  const heldAt = new Date((await rowFor(a)).validation.held_at);
  await releaseStaleHolds(tenant, { holdMinutes: 30, now: new Date(heldAt.getTime() + 31 * 60_000) });
  const taken = await (await claimAt(g.exit, b, PHONE, priced(b))).json();
  assert.equal(taken.validation.outcome, 'held');
  assert.equal(heldRef(g), b);
});

test('the sweep leaves a hold the close already recorded', async () => {
  const g = await linked();
  const car = plate('SWPC');
  const id = await opened(g, car);
  assert.equal((await claimAt(g.exit, id, PHONE, priced(id))).status, 200);
  assert.equal((await close(g.exit, car, { local_decision: priced(id), reader_shown: SHOWN })).status, 200);
  const summary = await releaseStaleHolds(tenant, { holdMinutes: 30, now: new Date(Date.now() + 24 * 3600_000) });
  assert.equal(summary.stale, 0);
  assert.equal((await rowFor(id)).validation.state, 'recorded');
  assert.equal(heldRef(g), id);
});

test('a close after the sweep gave the hold back records no discount, and a human is told', async () => {
  const g = await linked();
  const car = plate('LATE');
  const id = await opened(g, car);
  assert.equal((await claimAt(g.exit, id, PHONE, priced(id))).status, 200);
  const heldAt = new Date((await rowFor(id)).validation.held_at);
  await releaseStaleHolds(tenant, { holdMinutes: 30, now: new Date(heldAt.getTime() + 31 * 60_000) });
  assert.equal((await close(g.exit, car, { local_decision: priced(id) })).status, 200);
  const row = await rowFor(id);
  assert.equal(row.fee_minor, '500');
  assert.equal(row.breakdown.some((l) => l.code === LINE_CODE), false);
  assert.equal(row.validation.state, 'released');
  assert.equal((await eventsOf(RELEASED_BEFORE_CLOSE_EVENT_KIND, g.id)).length, 1);
});

test('a close the hold does not fit gives it back: covered, or another fee', async () => {
  const g = await linked();
  const covered = plate('CVRD');
  const c = await opened(g, covered);
  assert.equal((await claimAt(g.exit, c, PHONE, priced(c))).status, 200);
  assert.equal((await close(g.exit, covered, { local_decision: coveredDecision() })).status, 200);
  let row = await rowFor(c);
  assert.equal(row.exit_outcome, 'covered');
  assert.equal(row.validation.state, 'released');
  assert.equal(row.validation.reason, 'the stay closed covered');
  assert.equal(heldRef(g), null);

  const other = plate('OTHR');
  const o = await opened(g, other);
  assert.equal((await claimAt(g.exit, o, PHONE, priced(o))).status, 200);
  // The platform prices three hours, not the two the claim was made on.
  const res = await close(g.exit, other, { exit_at: '2026-09-10T15:00:00Z', reader_shown: SHOWN });
  assert.equal(res.status, 200);
  row = await rowFor(o);
  assert.equal(row.fee_minor, '750');
  assert.equal(row.validation.state, 'released');
  assert.match(row.validation.reason, /750, not the 500/);
  assert.equal(heldRef(g), null);
  assert.equal((await eventsOf(RELEASED_EVENT_KIND, g.id)).length, 2);
});

test('a close that must give a hold back and cannot still closes: the hold is left releasing, never recorded, and the sweep finishes it', async () => {
  const g = await linked();
  const car = plate('RLSD');
  const id = await opened(g, car);
  assert.equal((await claimAt(g.exit, id, PHONE, priced(id))).status, 200);
  setMode('exit2');
  assert.equal((await close(g.exit, car, { local_decision: coveredDecision() })).status, 200);
  let row = await rowFor(id);
  assert.notEqual(row.exit_at, null, 'the stay closed: the barrier has opened, the close is not refused');
  assert.equal(row.validation.state, 'releasing');
  assert.equal(heldRef(g), id, 'the module could not be asked: it still holds the claim');
  setMode('normal');
  const summary = await releaseStaleHolds(tenant, { holdMinutes: 30 });
  assert.equal(summary.unfinished, 1);
  row = await rowFor(id);
  assert.equal(row.validation.state, 'released');
  assert.equal(heldRef(g), null);
});

// --- A2.2: the row says what the reader showed -------------------------------------------

test('SHOWN IS RECORDED: a hold is recorded only when the close says the reader showed the discounted fee', async () => {
  for (const [label, extra, fee, state] of [
    ['showed the discount', { reader_shown: SHOWN }, '300', 'recorded'],
    ['showed the fee as priced', { reader_shown: { fee_minor: 500, currency: 'USD' } }, '500', 'released'],
    ['said nothing about the reader', {}, '500', 'released'],
  ]) {
    const g = await linked();
    const car = plate('SHWN');
    const id = await opened(g, car);
    assert.equal((await (await claimAt(g.exit, id, PHONE, priced(id))).json()).validation.outcome, 'held', label);
    assert.equal((await close(g.exit, car, { local_decision: priced(id), ...extra })).status, 200, label);
    const row = await rowFor(id);
    assert.equal(row.fee_minor, fee, label);
    assert.equal(row.validation.state, state, label);
    assert.equal(row.breakdown.some((l) => l.code === LINE_CODE), state === 'recorded', label);
    assert.equal(heldRef(g), state === 'recorded' ? id : null, `${label}: the module agrees`);
  }
});

test('reader_shown is checked for shape and refused 400 by name', async () => {
  const g = await linked();
  const car = plate('SHPR');
  const id = await opened(g, car);
  for (const bad of [[300], { fee_minor: -1, currency: 'USD' }, { fee_minor: 3.5, currency: 'USD' }, { fee_minor: 300 }, { fee_minor: 300, currency: 'USD', phone: PHONE }]) {
    const res = await close(g.exit, car, { local_decision: priced(id), reader_shown: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(await res.text(), /reader_shown/);
  }
  assert.equal((await rowFor(id)).exit_at, null);
});

// --- A2.3: no claim strands, in either direction ------------------------------------------

test('FORWARD: a claim the module made whose hold this platform never stored is named claiming, never recorded, and given back', async () => {
  // `bad_money`: the stand-in claims, then answers money this platform will
  // not take -- the platform's transaction rolls back AFTER the module
  // committed, exactly the window a crash or a lost connection leaves.
  const g = await linked();
  const kept = plate('FWDK');
  const k = await opened(g, kept);
  setMode('bad_money');
  assert.equal((await claimAt(g.exit, k, PHONE, priced(k))).status, 500);
  setMode('normal');
  assert.equal((await rowFor(k)).validation.state, 'claiming');
  assert.equal(heldRef(g), k, 'the module holds a claim this platform never held');
  // The driver pays in full and leaves: the close gives it back.
  assert.equal((await close(g.exit, kept, { local_decision: priced(k), reader_shown: SHOWN })).status, 200);
  let row = await rowFor(k);
  assert.equal(row.fee_minor, '500', 'a claim that was never held is never a discount');
  assert.equal(row.validation.state, 'released');
  assert.equal(heldRef(g), null);

  // The driver does not leave: the sweep gives it back.
  const stays = plate('FWDS');
  const s2 = await opened(g, stays);
  setMode('bad_money');
  assert.equal((await claimAt(g.exit, s2, PHONE, priced(s2))).status, 500);
  setMode('normal');
  assert.equal(heldRef(g), s2);
  let summary = await releaseStaleHolds(tenant, { holdMinutes: 30 });
  assert.equal(summary.claiming, 0, 'inside the grace, a claim may still be in flight');
  summary = await releaseStaleHolds(tenant, { holdMinutes: 30, now: new Date(Date.now() + 120_000) });
  assert.equal(summary.claiming, 1);
  row = await rowFor(s2);
  assert.equal(row.validation.state, 'released');
  assert.equal(heldRef(g), null, 'nothing stranded: the validation is unclaimed again');
});

test('REVERSE: a release the module made whose bookkeeping here did not finish is never recorded, and another car can take it once', async () => {
  const g = await linked();
  const first = plate('RVS1');
  const a = await opened(g, first);
  assert.equal((await claimAt(g.exit, a, PHONE, priced(a))).status, 200);
  // The state a release leaves when the module released and this platform's
  // write after it rolled back: the record `releasing`, the module unclaimed.
  await withTenant(tenant, (c) => c.query(
    `UPDATE sessions SET validation = validation || '{"state":"releasing","releasing_at":"2026-09-10T13:00:00.000Z","released_by":"sweep"}'::jsonb WHERE id = $1`, [a]));
  const st = readState();
  st.garages[`${g.link.tenant_id}/${g.link.garage_id}`][0].claimed_ref = null;
  writeFileSync(STATE, JSON.stringify(st));

  const second = plate('RVS2');
  const b = await opened(g, second);
  assert.equal((await (await claimAt(g.exit, b, PHONE, priced(b))).json()).validation.outcome, 'held');
  assert.equal((await close(g.exit, first, { local_decision: priced(a), reader_shown: SHOWN })).status, 200);
  assert.equal((await close(g.exit, second, { local_decision: priced(b), reader_shown: SHOWN })).status, 200);
  const [ra, rb] = [await rowFor(a), await rowFor(b)];
  assert.equal(ra.fee_minor, '500', 'the stay whose release began records no discount');
  assert.equal(ra.validation.state, 'released');
  assert.equal(rb.fee_minor, '300');
  assert.equal(heldRef(g), b, 'the one validation, used once, by the stay that holds it');
});

// --- the claim route's answers// --- the claim route's answers ------------------------------------------------------------

test('asked again on the same fee: the held claim, without the door; on another fee: given back and claimed on that one', async () => {
  const g = await linked();
  const car = plate('AGIN');
  const id = await opened(g, car);
  const first = (await (await claimAt(g.exit, id, PHONE, priced(id))).json()).validation;
  writeFileSync(LOG, '');
  const again = (await (await claimAt(g.exit, id, PHONE, priced(id))).json()).validation;
  assert.equal(again.replay, true);
  assert.equal(again.fee_minor, first.fee_minor);
  assert.deepEqual(calls(), []);
  const later = priced(id, { feeMinor: 750, exitAt: '2026-09-10T15:00:00+00:00' });
  const moved = (await (await claimAt(g.exit, id, PHONE, later)).json()).validation;
  assert.deepEqual([moved.outcome, moved.fee_before_minor, moved.fee_minor], ['held', 750, 550]);
  assert.deepEqual(calls().map((c) => c.argv[0]), ['release-in-store', 'validation-in-store', 'claim-in-store']);
});

test('a claim the platform failed to hold is asked on: already_claimed is answered with this stay\'s own claim', async () => {
  const g = await linked();
  const car = plate('RPLY');
  const id = await opened(g, car);
  const state = readState();
  state.garages[`${g.link.tenant_id}/${g.link.garage_id}`][0].claimed_ref = id;
  writeFileSync(STATE, JSON.stringify(state));
  const out = (await (await claimAt(g.exit, id, PHONE, priced(id))).json()).validation;
  assert.equal(out.outcome, 'held');
  assert.equal((await rowFor(id)).validation.claimed.answer.replay, true);
});

test('a phone that matches nothing: not validated, nothing held, no error', async () => {
  const g = await linked();
  const car = plate('UNKN');
  const id = await opened(g, car);
  const res = await claimAt(g.exit, id, OTHER_PHONE, priced(id));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).validation, { outcome: 'not_validated', reason: 'none' });
  assert.equal((await rowFor(id)).validation, null);
  assert.deepEqual(calls().map((c) => c.argv[0]), ['validation-in-store']);
  assert.equal((await close(g.exit, car, { local_decision: priced(id) })).status, 200);
  assert.equal((await rowFor(id)).fee_minor, '500');
});

test('a garage that links no module: not_linked, nothing asked', async () => {
  const g = await garage();
  const car = plate('NOLK');
  const id = await opened(g, car);
  const out = (await (await claimAt(g.exit, id, PHONE, priced(id))).json()).validation;
  assert.equal(out.outcome, 'not_linked');
  assert.deepEqual(calls(), []);
});

test('a door that could not decide at the reader: 5xx, nothing held; asked again it holds', async () => {
  const g = await linked();
  const car = plate('DOWN');
  const id = await opened(g, car);
  setMode('exit2');
  const down = await claimAt(g.exit, id, PHONE, priced(id));
  assert.equal(down.status, 500);
  assert.equal(holdsPhone(await down.text()), false);
  assert.equal((await rowFor(id)).validation.state, 'claiming', 'begun and not held: never a discount');
  setMode('normal');
  assert.equal((await (await claimAt(g.exit, id, PHONE, priced(id))).json()).validation.outcome, 'held');
});

test('a door that refused: nothing held, and a human is told', async () => {
  const g = await linked();
  const car = plate('RFSD');
  const id = await opened(g, car);
  setMode('refuse_claims');
  const out = (await (await claimAt(g.exit, id, PHONE, priced(id))).json()).validation;
  assert.equal(out.outcome, 'refused');
  assert.equal((await rowFor(id)).validation, null);
  const events = await eventsOf(REFUSED_EVENT_KIND, g.id);
  assert.equal(events.length, 1);
  assert.equal(holdsPhone(await storedAbout(g.id)), false);
});

test('money the module asserts that does not fit the question is not held: 5xx', async () => {
  for (const mode of ['bad_money', 'wrong_base']) {
    const g = await linked();
    const car = plate('MONY');
    const id = await opened(g, car);
    setMode(mode);
    assert.equal((await claimAt(g.exit, id, PHONE, priced(id))).status, 500, mode);
    assert.equal((await rowFor(id)).validation.state, 'claiming', mode);
  }
});

test('a claim is made before the close and on a fee the close would write, or not at all', async () => {
  const g = await linked();
  const car = plate('ORDR');
  const id = await opened(g, car);
  const code = async (res) => (await res.json()).code;
  assert.equal(await code(await claimAt(g.exit, id, PHONE, null)), 'nothing_to_discount');
  assert.equal(await code(await claimAt(g.exit, id, PHONE, coveredDecision())), 'nothing_to_discount');
  assert.equal(await code(await claimAt(g.exit, id, PHONE, priced(id, { feeMinor: 0 }))), 'nothing_to_discount');
  assert.equal(await code(await claimAt(g.exit, id, PHONE, priced(randomUUID()))), 'decision_not_consumable');
  assert.equal(await code(await claimAt(g.exit, id, PHONE, { ...priced(id), currency: 'EUR' })), 'decision_not_consumable');
  assert.equal(await code(await claimAt(g.entry, id, PHONE, priced(id))), 'wrong_lane_direction');
  assert.equal((await close(g.exit, car, { local_decision: priced(id) })).status, 200);
  assert.equal(await code(await claimAt(g.exit, id, PHONE, priced(id))), 'stay_not_open');
  assert.deepEqual(calls(), []);
});

test('a phone that is not a phone number is refused 400 by name, and its value is not echoed', async () => {
  const g = await linked();
  const car = plate('BADP');
  const id = await opened(g, car);
  for (const bad of ['call me at 2025550143', ['2025550143'], 2025550143, '---', 'x'.repeat(40), null]) {
    const res = await claimAt(g.exit, id, bad, priced(id));
    assert.equal(res.status, 400, JSON.stringify(bad));
    const text = await res.text();
    assert.match(text, /phone/);
    assert.equal(holdsPhone(text), false);
  }
  assert.deepEqual(calls(), []);
});

test('the close no longer takes a phone: one sent there asks nothing and is kept nowhere', async () => {
  const g = await linked();
  const car = plate('CLPH');
  const id = await opened(g, car);
  assert.equal((await close(g.exit, car, { local_decision: priced(id), phone: PHONE })).status, 200);
  const row = await rowFor(id);
  assert.equal(row.fee_minor, '500');
  assert.equal(row.validation, null);
  assert.deepEqual(calls(), []);
  assert.equal(holdsPhone(await storedAbout(g.id)), false);
});

test('a replayed close answers the stay it closed and asks the door nothing', async () => {
  const g = await linked();
  const car = plate('RPLC');
  const id = await opened(g, car);
  assert.equal((await claimAt(g.exit, id, PHONE, priced(id))).status, 200);
  const request = closeRequest(g.exit, car, { local_decision: priced(id), reader_shown: SHOWN });
  const first = await (await fetch(`${base}/api/v1/lane/sessions/close`, request)).json();
  writeFileSync(LOG, '');
  const body = await (await fetch(`${base}/api/v1/lane/sessions/close`, request)).json();
  assert.equal(body.replay, true);
  assert.equal(body.session.fee_minor, first.session.fee_minor);
  assert.deepEqual(calls(), []);
});

// --- the link and the schema ---------------------------------------------------------------

test('a link is probed before it is stored: a garage the module does not know is refused by name', async () => {
  const g = await garage();
  setState({ garages: { 'vt-1/known': [] } });
  const refused = await op('PUT', `/garages/${g.id}/validations-link`, { validations: { tenant_id: 'vt-1', garage_id: 'unknown' } });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'validations_link_unanswerable');
  const ok = await op('PUT', `/garages/${g.id}/validations-link`, { validations: { tenant_id: 'vt-1', garage_id: 'known' } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).garage.validations_link, { tenant_id: 'vt-1', garage_id: 'known' });
  assert.deepEqual(calls().map((c) => [c.argv[0], c.stdin]), [['validation-in-store', 'probe\n'], ['validation-in-store', 'probe\n']]);
  const unlinked = await op('PUT', `/garages/${g.id}/validations-link`, { validations: null });
  assert.equal((await unlinked.json()).garage.validations_link, null);
  const stated = await eventsOf(LINK_STATED_EVENT_KIND, g.id);
  assert.equal(stated.length, 2);
  assert.equal(stated[1].detail.after, null);
  assert.equal((await op('PUT', `/garages/${g.id}/validations-link`, { validations: { tenant_id: '' } })).status, 400);
  assert.equal((await op('PUT', `/garages/${g.id}/validations-link`, { garage_pass: null })).status, 400);
});

test('the schema holds the shapes: a link is a link; a hold only on an open stay, a recorded one only on a closed one', async () => {
  const g = await garage();
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE garages SET validations_link = '{"tenant_id":"t"}'::jsonb WHERE id = $1`, [g.id])),
    (err) => err.constraint === 'garages_validations_link_is_a_link',
  );
  const car = plate('SHPE');
  const id = await opened(g, car);
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE sessions SET validation = '{"state":"recorded"}'::jsonb WHERE id = $1`, [id])),
    (err) => err.constraint === 'sessions_validation_state_fits_the_stay',
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE sessions SET validation = '{"consulted":true}'::jsonb WHERE id = $1`, [id])),
    (err) => err.constraint === 'sessions_validation_is_a_record',
  );
  await withTenant(tenant, (c) => c.query(`UPDATE sessions SET validation = '{"state":"held"}'::jsonb WHERE id = $1`, [id]));
  // A close with no garage link cannot give it back; clear it as a human would, then close.
  await withTenant(tenant, (c) => c.query(`UPDATE sessions SET validation = NULL WHERE id = $1`, [id]));
  assert.equal((await close(g.exit, car)).status, 200);
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE sessions SET validation = '{"state":"held"}'::jsonb WHERE id = $1`, [id])),
    (err) => err.constraint === 'sessions_validation_state_fits_the_stay',
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE sessions SET validation = '{"state":"claiming"}'::jsonb WHERE id = $1`, [id])),
    (err) => err.constraint === 'sessions_validation_state_fits_the_stay',
  );
  await withTenant(tenant, (c) => c.query(`UPDATE sessions SET validation = '{"state":"releasing"}'::jsonb WHERE id = $1`, [id]));
  await withTenant(tenant, (c) => c.query(`UPDATE sessions SET validation = NULL WHERE id = $1`, [id]));
});
