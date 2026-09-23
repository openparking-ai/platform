/**
 * A validation at the exit (migration 0019), driven through the lane's close
 * against the REAL engine and a STAND-IN for the validations module's door
 * (`test/fixtures/validations-door`): the module is not in this repository,
 * and the stand-in speaks its contract and nothing else -- see its header.
 *
 * What is held here is this platform's side: the phone reaches the door on
 * stdin and is kept nowhere; a claimed discount becomes ONE line on the
 * ledger and the fee is the running total including it; nothing re-prices;
 * a module that could not decide is not no-validation; a module that refused
 * does not refuse the close; the reconciler compares the engine's number with
 * the fee WITHOUT the validation line.
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
import { LINE_CODE, LINK_STATED_EVENT_KIND, REFUSED_EVENT_KIND } from '../src/validations.js';

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

beforeEach(() => {
  setState({});
  writeFileSync(LOG, '');
});

// --- the check first: it can see a number -----------------------------------------------

test('CONTROL: the phone check finds a planted number, in a stored row, in every way it is written', async () => {
  for (const written of [PHONE, PHONE_DIGITS, '+1 202 555 0143', '202.555.0143', '{"phone_last4":"0143"}']) {
    assert.equal(holdsPhone(JSON.stringify({ planted: written })), true, written);
  }
  assert.equal(holdsPhone(JSON.stringify({ at: '2026-09-10T14:00:00Z', id: randomUUID() })), false);
  // And through the database: a planted record on a real closed row is found.
  const g = await linked();
  const car = plate('CTRL');
  const id = await opened(g, car);
  assert.equal((await close(g.exit, car)).status, 200);
  assert.equal(holdsPhone(await storedAbout(g.id)), false, 'the premise: nothing planted yet');
  await withTenant(tenant, (c) =>
    c.query(`UPDATE sessions SET validation = $2 WHERE id = $1`, [id, JSON.stringify({ consulted: true, planted: PHONE })]),
  );
  assert.equal(holdsPhone(await storedAbout(g.id)), true);
});

// --- the discount is a line --------------------------------------------------------------

test('a phone with a live validation: one line on the ledger, the fee its running total, the phone kept nowhere', async () => {
  const g = await linked();
  const car = plate('VALD');
  const id = await opened(g, car);
  const res = await close(g.exit, car, { phone: PHONE });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  const row = await rowFor(id);

  // The engine priced 500; the module answered 200; the ledger says both.
  assert.equal(row.fee_minor, '300');
  assert.equal(body.session.fee_minor, 300);
  const last = row.breakdown.at(-1);
  assert.deepEqual(last, {
    code: LINE_CODE, rule_id: null, delta_minor: -200,
    text: 'Validation from Invented Bistro (2.00 USD off): -2.00 USD',
  });
  const engineLines = row.breakdown.slice(0, -1);
  assert.equal(engineLines.some((l) => l.code === LINE_CODE), false);
  assert.equal(row.breakdown.reduce((sum, l) => sum + l.delta_minor, 0), 300, 'the fee IS the running total');
  assert.equal(engineLines.reduce((sum, l) => sum + l.delta_minor, 0), 500, 'the engine\'s lines are the engine\'s');

  // The record: what was asked, what was answered, what was done.
  assert.equal(row.validation.consulted, true);
  assert.equal(row.validation.applied, true);
  assert.equal(row.validation.asserted_by, 'validations');
  assert.deepEqual(
    [row.validation.discount_minor, row.validation.fee_before_minor, row.validation.fee_after_minor],
    [200, 500, 300],
  );
  assert.deepEqual(row.validation.claimed.argv, [
    'claim-in-store', '--tenant', g.link.tenant_id, '--garage', g.link.garage_id, '--at', '2026-09-10T14:00:00.000Z',
    '--consumer', 'openparking', '--ref', id, '--base-minor', '500', '--currency', 'USD',
  ]);

  // The phone went on stdin, to both verbs, and on no argv.
  const asked = calls();
  assert.deepEqual(asked.map((c) => c.argv[0]), ['validation-in-store', 'claim-in-store']);
  for (const c of asked) {
    assert.equal(c.stdin, `${PHONE}\n`);
    assert.equal(holdsPhone(JSON.stringify(c.argv)), false);
  }
  // And it is nowhere this platform keeps anything, nor in what it answered.
  assert.equal(holdsPhone(await storedAbout(g.id)), false);
  assert.equal(holdsPhone(JSON.stringify(body)), false);
});

test('the lane decided the fee: the validation is a line on the lane\'s ledger, and the reconciler still agrees', async () => {
  // A tenant of its own, so the sweep below sees these closes and no others.
  const own = await createTenant('validations-lane');
  const saved = tenant;
  tenant = own;
  try {
    await buildWorld(own);
    const token = generateDeviceToken();
    await withTenant(own, (c) =>
      c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [own, hashToken(token)]),
    );
    const savedOp = operatorToken;
    operatorToken = token;
    try {
      const g = await linked();
      const car = plate('LANE');
      const id = await opened(g, car);
      const decision = {
        status: 'priced', covered_by: [], matched: [], fee_minor: 500, currency: 'USD', plan_version: 'flat-250-USD',
        breakdown: [{ code: 'increment.first_period', rule_id: 'hourly', text: 'first hour', delta_minor: 250 },
          { code: 'increment.repeat_periods', rule_id: 'hourly', text: 'one more hour', delta_minor: 250 }],
        entry_at: '2026-09-10T12:00:00+00:00', exit_at: '2026-09-10T14:00:00+00:00', session_id: id, space_class: 'standard',
        computed_from: { rules_refreshed_at: 1, stays_refreshed_at: 1, stays_cursor: '1', day: '2026-09-10', clock: 'America/New_York' },
      };
      const res = await close(g.exit, car, { local_decision: decision, phone: PHONE });
      assert.equal(res.status, 200, await res.clone().text());
      const row = await rowFor(id);
      assert.equal(row.decided_by, 'lane');
      assert.equal(row.fee_minor, '300');
      assert.deepEqual(row.breakdown.slice(0, 2), decision.breakdown, 'the lane\'s lines, untouched');
      assert.equal(row.breakdown[2].delta_minor, -200);

      const report = await withTenant(own, (c) => laneDecidedCloses(c, own, g.id, '2026-09-10T00:00:00Z'));
      assert.deepEqual([report.checked, report.agreed, report.diverged.length], [1, 1, 0]);
      await sweepLaneDecisions(own);
      assert.equal((await rowFor(id)).decision_check.verdict, 'agreed');
    } finally {
      operatorToken = savedOp;
    }
  } finally {
    tenant = saved;
  }
});

// --- nothing to discount, nothing asked --------------------------------------------------

test('no phone: the door is not asked and the record is null', async () => {
  const g = await linked();
  const car = plate('NOPH');
  const id = await opened(g, car);
  assert.equal((await close(g.exit, car)).status, 200);
  const row = await rowFor(id);
  assert.equal(row.fee_minor, '500');
  assert.equal(row.validation, null);
  assert.deepEqual(calls(), []);
});

test('a phone at a garage that links no module: not consulted, said so, the fee as priced', async () => {
  const g = await garage();
  const car = plate('NOLK');
  const id = await opened(g, car);
  assert.equal((await close(g.exit, car, { phone: PHONE })).status, 200);
  const row = await rowFor(id);
  assert.equal(row.fee_minor, '500');
  assert.deepEqual(row.validation, { consulted: false, reason: 'not linked: the garage names no garage in a validations module' });
  assert.deepEqual(calls(), []);
});

test('a phone that matches nothing: no discount, no error, and the claim is never made', async () => {
  const g = await linked();
  const car = plate('UNKN');
  const id = await opened(g, car);
  const res = await close(g.exit, car, { phone: OTHER_PHONE });
  assert.equal(res.status, 200);
  const row = await rowFor(id);
  assert.equal(row.fee_minor, '500');
  assert.equal(row.validation.applied, false);
  assert.equal(row.validation.asked.answer.reason, 'none');
  assert.equal(row.breakdown.some((l) => l.code === LINE_CODE), false);
  assert.deepEqual(calls().map((c) => c.argv[0]), ['validation-in-store']);
  assert.equal(holdsPhone(await storedAbout(g.id), OTHER_PHONE.replace(/\D/g, '')), false);
});

test('a validation already used by another stay: the second stay pays in full', async () => {
  const g = await linked();
  const first = plate('ONE');
  const second = plate('TWO');
  const a = await opened(g, first);
  const b = await opened(g, second);
  assert.equal((await close(g.exit, first, { phone: PHONE })).status, 200);
  assert.equal((await close(g.exit, second, { phone: PHONE })).status, 200);
  assert.equal((await rowFor(a)).fee_minor, '300');
  const row = await rowFor(b);
  assert.equal(row.fee_minor, '500');
  assert.equal(row.validation.asked.answer.reason, 'already_claimed');
  // Asked on -- it might have been this stay's -- and it was not.
  assert.equal(row.validation.claimed.answer.reason, 'already_claimed');
  assert.equal(row.validation.applied, false);
});

test('a covered stay and a zero fee have nothing to discount: the door is not asked and the validation is not spent', async () => {
  const g = await linked();
  const computedFrom = { rules_refreshed_at: 1, stays_refreshed_at: 1, stays_cursor: '1', day: '2026-09-10', clock: 'America/New_York' };
  const covered = plate('COVR');
  const coveredId = await opened(g, covered);
  const res = await close(g.exit, covered, {
    phone: PHONE,
    local_decision: { status: 'covered', covered_by: ['garage_pass'], matched: [{ module: 'garage_pass', pass: 'pass-x', agreement: null }], computed_from: computedFrom },
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await rowFor(coveredId)).validation, { consulted: false, reason: 'nothing to discount: the stay is covered' });

  const free = plate('ZERO');
  const freeId = await opened(g, free);
  const zero = await close(g.exit, free, {
    phone: PHONE,
    local_decision: {
      status: 'priced', covered_by: [], matched: [], fee_minor: 0, currency: 'USD', plan_version: 'flat-250-USD', breakdown: [],
      entry_at: '2026-09-10T12:00:00+00:00', exit_at: '2026-09-10T14:00:00+00:00', session_id: freeId, space_class: 'standard', computed_from: computedFrom,
    },
  });
  assert.equal(zero.status, 200, await zero.clone().text());
  assert.deepEqual((await rowFor(freeId)).validation, { consulted: false, reason: 'nothing to discount: the fee is zero' });

  assert.deepEqual(calls(), []);
  assert.equal(readState().garages[`${g.link.tenant_id}/${g.link.garage_id}`][0].claimed_ref, null, 'still unspent');
});

// --- a door that could not decide, or refused --------------------------------------------

test('a door that could not decide is not no-validation: 5xx, the stay stays open, and the retry gets the discount', async () => {
  const g = await linked();
  const car = plate('DOWN');
  const id = await opened(g, car);
  setMode('exit2');
  const request = closeRequest(g.exit, car, { phone: PHONE });
  const down = await fetch(`${base}/api/v1/lane/sessions/close`, request);
  assert.equal(down.status, 500);
  assert.equal(holdsPhone(await down.text()), false);
  assert.equal((await rowFor(id)).exit_at, null, 'the stay is still open: nothing was recorded on an outage');
  setMode('normal');
  const back = await fetch(`${base}/api/v1/lane/sessions/close`, request);
  assert.equal(back.status, 200);
  assert.equal((await rowFor(id)).fee_minor, '300');
});

test('a claim the platform\'s own transaction lost is answered again, not refused: the retry gets the discount', async () => {
  const g = await linked();
  const car = plate('RPLY');
  const id = await opened(g, car);
  // The module already holds this stay's claim, as it would if the first close
  // had claimed and then rolled back.
  const state = readState();
  state.garages[`${g.link.tenant_id}/${g.link.garage_id}`][0].claimed_ref = id;
  writeFileSync(STATE, JSON.stringify(state));
  // The read says already claimed -- it cannot say by whom -- so the claim is
  // asked, and answers this stay's claim again.
  assert.equal((await close(g.exit, car, { phone: PHONE })).status, 200);
  const row = await rowFor(id);
  assert.equal(row.validation.asked.answer.reason, 'already_claimed');
  assert.equal(row.validation.claimed.answer.replay, true);
  assert.equal(row.fee_minor, '300');
  assert.deepEqual(calls().map((c) => c.argv[0]), ['validation-in-store', 'claim-in-store']);
});

test('a door that refused the request: the stay closes undiscounted and a human is told', async () => {
  const g = await linked();
  const car = plate('RFSD');
  const id = await opened(g, car);
  setMode('refuse_claims');
  const res = await close(g.exit, car, { phone: PHONE });
  assert.equal(res.status, 200);
  const row = await rowFor(id);
  assert.equal(row.fee_minor, '500');
  assert.equal(row.validation.applied, false);
  assert.equal(row.validation.refused.refused, 'currency_unsupported');
  const events = await eventsOf(REFUSED_EVENT_KIND, g.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.refused.refused, 'currency_unsupported');
  assert.equal(holdsPhone(await storedAbout(g.id)), false);
});

test('money the module asserts that does not fit the question is not taken: 5xx, the stay stays open', async () => {
  // A discount larger than the fee, and a claim answered for another fee.
  for (const mode of ['bad_money', 'wrong_base']) {
    const g = await linked();
    const car = plate('MONY');
    const id = await opened(g, car);
    setMode(mode);
    const res = await close(g.exit, car, { phone: PHONE });
    assert.equal(res.status, 500, mode);
    assert.equal((await rowFor(id)).exit_at, null, mode);
  }
});

// --- the field and the link --------------------------------------------------------------

test('a phone that is not a phone number is refused 400 by name, and its value is not echoed', async () => {
  const g = await linked();
  for (const bad of ['call me at 2025550143', ['2025550143'], 2025550143, '---', 'x'.repeat(40)]) {
    const car = plate('BADP');
    const id = await opened(g, car);
    const res = await close(g.exit, car, { phone: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    const text = await res.text();
    assert.match(text, /phone must be/);
    assert.equal(holdsPhone(text), false);
    assert.equal((await rowFor(id)).exit_at, null);
  }
  assert.deepEqual(calls(), []);
});

test('a replayed close answers the stay it closed and asks the door nothing', async () => {
  const g = await linked();
  const car = plate('RPLC');
  await opened(g, car);
  const request = closeRequest(g.exit, car, { phone: PHONE });
  const first = await (await fetch(`${base}/api/v1/lane/sessions/close`, request)).json();
  writeFileSync(LOG, '');
  const again = await fetch(`${base}/api/v1/lane/sessions/close`, request);
  const body = await again.json();
  assert.equal(body.replay, true);
  assert.equal(body.session.fee_minor, first.session.fee_minor);
  assert.deepEqual(calls(), []);
});

test('a link is probed before it is stored: a garage the module does not know is refused by name', async () => {
  const g = await garage();
  setState({ garages: { 'vt-1/known': [] } });
  const refused = await op('PUT', `/garages/${g.id}/validations-link`, { validations: { tenant_id: 'vt-1', garage_id: 'unknown' } });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'validations_link_unanswerable');
  const ok = await op('PUT', `/garages/${g.id}/validations-link`, { validations: { tenant_id: 'vt-1', garage_id: 'known' } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).garage.validations_link, { tenant_id: 'vt-1', garage_id: 'known' });
  // The probe asked a read, with a stdin that is not a phone number.
  assert.deepEqual(calls().map((c) => [c.argv[0], c.stdin]), [['validation-in-store', 'probe\n'], ['validation-in-store', 'probe\n']]);
  const unlinked = await op('PUT', `/garages/${g.id}/validations-link`, { validations: null });
  assert.equal((await unlinked.json()).garage.validations_link, null);
  const stated = await eventsOf(LINK_STATED_EVENT_KIND, g.id);
  assert.equal(stated.length, 2);
  assert.equal(stated[1].detail.after, null);
  assert.equal((await op('PUT', `/garages/${g.id}/validations-link`, { validations: { tenant_id: '' } })).status, 400);
  assert.equal((await op('PUT', `/garages/${g.id}/validations-link`, { garage_pass: null })).status, 400);
});

test('the schema holds the shapes: a link is a link, a record is a record and only on a closed stay', async () => {
  const g = await garage();
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE garages SET validations_link = '{"tenant_id":"t"}'::jsonb WHERE id = $1`, [g.id])),
    (err) => err.constraint === 'garages_validations_link_is_a_link',
  );
  const car = plate('SHPE');
  const id = await opened(g, car);
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE sessions SET validation = '{"consulted":true}'::jsonb WHERE id = $1`, [id])),
    (err) => err.constraint === 'sessions_validation_only_when_closed',
  );
  assert.equal((await close(g.exit, car)).status, 200);
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE sessions SET validation = '{"applied":true}'::jsonb WHERE id = $1`, [id])),
    (err) => err.constraint === 'sessions_validation_is_a_record',
  );
});
