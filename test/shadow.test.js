/**
 * The shadow run: the search is called for real exits, its answer recorded,
 * nothing acts on it.
 *
 * THE RACE IS THE FIRST TEST. The close finds the stay and closes it; a
 * snapshot taken after that finds the true stay gone, and every plate-matched
 * exit reads as "absent true car". So the first assertion here is that the
 * stay the close closed is IN the candidate ids of the row the close wrote --
 * which can only be true if the snapshot was taken before `exit_at`.
 *
 * The identity service is a stand-in that speaks the documented shape of
 * `POST /v1/searches` (vehicle-id docs/CONTRACT.md, "Searching: one descriptor
 * against many") and records what it was sent, so the sweep for descriptors
 * and plates runs over the real payload.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { runShadowSearches, shadowReport, thresholdsFromEnv, SHADOW_EVENT_KIND } from '../src/shadow.js';

let server;
let base;
let tenant;
let world;
let entryToken;
let exitToken;

const THRESHOLDS = { structure: 0.75, colour_bhattacharyya: 0.69 };

async function issueDeviceToken(tenantId, laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [
      tenantId,
      laneId,
      name,
      hashToken(token),
    ]),
  );
  return token;
}

const post = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ event_id: randomUUID(), ...body }),
});

const plate = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
const descriptor = (tag) => `opvid-fp/1:${Buffer.from(`${tag}-${randomUUID()}`).toString('base64url')}`;

const openEntry = (body) => fetch(`${base}/api/v1/lane/sessions/open`, post(entryToken, body));
const closeExit = (body) => fetch(`${base}/api/v1/lane/sessions/close`, post(exitToken, body));

async function openStay(p, entryDescriptor = null) {
  const res = await openEntry({
    plate: p,
    entry_at: '2026-08-26T09:00:00Z',
    entry_confirmation: 'confirmed',
    ...(entryDescriptor ? { descriptor: entryDescriptor } : {}),
  });
  assert.equal(res.status, 201);
  return (await res.json()).session.id;
}

const shadowRows = (where = 'true', params = []) =>
  withTenant(tenant, async (c) =>
    (await c.query(`SELECT * FROM shadow_searches WHERE tenant_id = $1 AND (${where}) ORDER BY created_at`, [tenant, ...params])).rows,
  );

/**
 * A stand-in identity service. `answer(body)` decides the record; what it was
 * sent is kept for the sweeps.
 */
function fakeSearch(answer) {
  const sent = [];
  const search = async (body) => {
    sent.push(body);
    return answer(body);
  };
  return { search, sent };
}

/** The documented record for "exactly these ids matched". */
function recordMatching(ids, body) {
  const matched = ids.filter((id) => body.candidates.some((c) => c.id === id));
  const outcome = matched.length === 0 ? 'no_match' : matched.length === 1 ? 'match' : 'tie';
  return {
    schema_version: 1,
    search_id: randomUUID().replace(/-/g, ''),
    outcome,
    matched,
    counts: { candidates: body.candidates.length, matched: matched.length, excluded: body.candidates.length - matched.length, refused: 0 },
    candidates: body.candidates.map((c) => ({
      id: c.id,
      verdict: matched.includes(c.id) ? 'match' : 'no_match',
      reason: null,
      distances: {},
    })),
    thresholds_applied: body.thresholds,
    descriptor_version: 1,
    descriptor_kind: 'orb',
    rule: 'match when structure <= thresholds.structure AND colour_bhattacharyya <= thresholds.colour_bhattacharyya',
    time: new Date().toISOString(),
  };
}

before(async () => {
  tenant = await createTenant('shadow');
  world = await buildWorld(tenant, { hourlyMinor: 250 });
  entryToken = await issueDeviceToken(tenant, world.entryLane, 'entry device');
  exitToken = await issueDeviceToken(tenant, world.exitLane, 'exit device');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

// --- the snapshot, inside the close ----------------------------------------

test('THE RACE: the stay the close closed is in the snapshot — so the snapshot was taken before exit_at', async () => {
  const p = plate('RACE');
  const trueStay = await openStay(p, descriptor('RACE-IN'));
  const other = await openStay(plate('RACE2'), descriptor('RACE2-IN'));
  const noDesc = await openStay(plate('RACE3')); // open, not comparable

  const closeEvent = randomUUID();
  const res = await closeExit({
    event_id: closeEvent,
    plate: p,
    exit_at: '2026-08-26T11:00:00Z',
    exit_confirmation: 'confirmed',
    descriptor: descriptor('RACE-OUT'),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).closed, true);

  const [row] = await shadowRows('close_event_id = $2', [closeEvent]);
  assert.ok(row, 'the close wrote a shadow row');
  assert.equal(row.session_id, trueStay);
  assert.ok(row.candidate_ids.includes(trueStay), 'the TRUE STAY is a candidate: the snapshot preceded the close');
  assert.ok(row.candidate_ids.includes(other), 'and so is the other open, comparable stay');
  assert.ok(!row.candidate_ids.includes(noDesc), 'a stay with no descriptor is not sent');
  assert.equal(row.true_stay_comparable, true);
  assert.ok(row.candidates_open >= 3, 'the denominator counts every open stay, comparable or not');
  assert.equal(row.candidates_with_descriptor, row.candidate_ids.length);
  assert.equal(row.searched_at, null, 'nothing has searched yet');

  // And the stay IS closed -- the snapshot did not stop the close.
  const closed = await withTenant(tenant, async (c) =>
    (await c.query('SELECT exit_at FROM sessions WHERE id = $1', [trueStay])).rows[0],
  );
  assert.ok(closed.exit_at);

  // The control on the race assertion: a snapshot taken NOW, after the close,
  // does not contain the true stay. That is what a wrong ordering would have
  // written, and it is what the assertion above would have caught.
  const { candidateSnapshot } = await import('../src/candidates.js');
  const after = await withTenant(tenant, (c) => candidateSnapshot(c, tenant, world.garage));
  assert.ok(!after.ids.includes(trueStay), 'after the close the true stay is gone from any snapshot');
});

test('a close that carries no descriptor snapshots nothing', async () => {
  const p = plate('NOSHADOW');
  await openStay(p, descriptor('NOSHADOW-IN'));
  const closeEvent = randomUUID();
  const res = await closeExit({ event_id: closeEvent, plate: p, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed' });
  assert.equal(res.status, 200);
  assert.deepEqual(await shadowRows('close_event_id = $2', [closeEvent]), []);
});

test('a close that matches nothing (404) inserts no row — the tailgater is not in any figure', async () => {
  const closeEvent = randomUUID();
  const res = await closeExit({
    event_id: closeEvent,
    plate: plate('NEVERIN'),
    exit_at: '2026-08-26T11:00:00Z',
    exit_confirmation: 'confirmed',
    descriptor: descriptor('NEVERIN-OUT'),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await shadowRows('close_event_id = $2', [closeEvent]), []);
});

test('a replayed close does not snapshot twice', async () => {
  const p = plate('REPLAY');
  await openStay(p, descriptor('REPLAY-IN'));
  const body = { event_id: randomUUID(), plate: p, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed', descriptor: descriptor('REPLAY-OUT') };
  assert.equal((await closeExit(body)).status, 200);
  assert.equal((await closeExit(body)).status, 200);
  assert.equal((await shadowRows('close_event_id = $2', [body.event_id])).length, 1);
});

test('a stay whose entry read had no descriptor closes with one: the row says the true stay was not comparable', async () => {
  const p = plate('NOTCOMP');
  const stay = await openStay(p); // no entry descriptor
  const closeEvent = randomUUID();
  await closeExit({ event_id: closeEvent, plate: p, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed', descriptor: descriptor('NOTCOMP-OUT') });
  const [row] = await shadowRows('close_event_id = $2', [closeEvent]);
  assert.equal(row.session_id, stay);
  assert.equal(row.true_stay_comparable, false);
  assert.ok(!row.candidate_ids.includes(stay));
});

// --- the search, later, outside any request --------------------------------

test('the worker sends ids and descriptors only, records the outcome on the row and in an event with SESSION IDS ONLY', async () => {
  const p = plate('WORK');
  const dIn = descriptor('WORK-IN');
  const dOut = descriptor('WORK-OUT');
  const trueStay = await openStay(p, dIn);
  const otherIn = descriptor('WORK2-IN');
  const other = await openStay(plate('WORK2'), otherIn);
  const closeEvent = randomUUID();
  await closeExit({ event_id: closeEvent, plate: p, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed', descriptor: dOut });

  // The stand-in answers "the true stay matched" -- the oracle agrees.
  const { search, sent } = fakeSearch((body) => recordMatching([trueStay], body));
  const summary = await runShadowSearches(tenant, { search, thresholds: THRESHOLDS });
  assert.ok(summary.searched >= 1);
  assert.equal(summary.failed, 0);

  // WHAT LEFT FOR THE IDENTITY SERVICE: the exit descriptor, {id, descriptor}
  // per candidate, the thresholds -- and no plate, no ticket, no attribute.
  const body = sent.find((b) => b.descriptor === dOut);
  assert.ok(body, 'the exit descriptor the close carried is what was searched');
  assert.deepEqual(Object.keys(body).sort(), ['candidates', 'descriptor', 'thresholds']);
  assert.deepEqual(body.thresholds, THRESHOLDS);
  const byId = Object.fromEntries(body.candidates.map((c) => [c.id, c]));
  assert.equal(byId[trueStay].descriptor, dIn, 'the candidate descriptors were read by id, later');
  assert.equal(byId[other].descriptor, otherIn);
  for (const c of body.candidates) assert.deepEqual(Object.keys(c).sort(), ['descriptor', 'id']);
  assert.ok(!JSON.stringify(body).includes(p), 'no plate reached the search');

  // THE ROW.
  const [row] = await shadowRows('close_event_id = $2', [closeEvent]);
  assert.ok(row.searched_at);
  assert.equal(row.outcome, 'match');
  assert.deepEqual(row.matched_ids, [trueStay]);
  assert.equal(row.true_stay_matched, true);
  assert.deepEqual(row.thresholds, THRESHOLDS);
  assert.ok(row.search_ref);
  assert.equal(row.attempts, 1);

  // THE EVENT: session ids and verdicts. SESSION IDS, NEVER DESCRIPTORS.
  const events = await withTenant(tenant, async (c) =>
    (await c.query(`SELECT * FROM events WHERE tenant_id = $1 AND kind = $2 AND detail->>'close_event_id' = $3`, [tenant, SHADOW_EVENT_KIND, closeEvent])).rows,
  );
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.lane_id, world.exitLane);
  assert.equal(ev.detail.actor, 'platform:shadow');
  assert.equal(ev.detail.session_id, trueStay);
  assert.deepEqual(ev.detail.matched_ids, [trueStay]);
  assert.equal(ev.detail.true_stay_matched, true);
  assert.equal(ev.detail.outcome, 'match');
  const text = JSON.stringify(ev.detail) + JSON.stringify(row);
  for (const d of [dIn, dOut, otherIn]) assert.ok(!text.includes(d), 'a descriptor reached the record');
  assert.ok(!text.includes(p), 'a plate reached the record');
  // The control on that sweep: the descriptors ARE on the sessions, where they belong.
  const onSessions = await withTenant(tenant, async (c) =>
    (await c.query('SELECT entry_descriptor, exit_descriptor FROM sessions WHERE id = $1', [trueStay])).rows[0],
  );
  assert.equal(onSessions.entry_descriptor, dIn);
  assert.equal(onSessions.exit_descriptor, dOut);

  // Idempotent: a second run finds nothing pending for this row.
  const again = await runShadowSearches(tenant, { search, thresholds: THRESHOLDS });
  assert.ok(!sent.slice(sent.indexOf(body) + 1).some((b) => b.descriptor === dOut), 'not searched twice');
  assert.equal(again.failed, 0);
});

test('a wrong match and a tie are recorded as what they are — the oracle disagreeing is the finding', async () => {
  const p1 = plate('WRONG');
  const s1 = await openStay(p1, descriptor('WRONG-IN'));
  const s2 = await openStay(plate('WRONG2'), descriptor('WRONG2-IN'));
  const e1 = randomUUID();
  await closeExit({ event_id: e1, plate: p1, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed', descriptor: descriptor('WRONG-OUT') });
  // The search names the OTHER car.
  let run = fakeSearch((body) => recordMatching([s2], body));
  await runShadowSearches(tenant, { search: run.search, thresholds: THRESHOLDS });
  let [row] = await shadowRows('close_event_id = $2', [e1]);
  assert.equal(row.outcome, 'match');
  assert.deepEqual(row.matched_ids, [s2]);
  assert.equal(row.true_stay_matched, false, 'the search was wrong and the record says so');

  // A tie between the true stay and another.
  const p3 = plate('TIE');
  const s3 = await openStay(p3, descriptor('TIE-IN'));
  const e3 = randomUUID();
  await closeExit({ event_id: e3, plate: p3, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed', descriptor: descriptor('TIE-OUT') });
  run = fakeSearch((body) => recordMatching([s3, s2], body));
  await runShadowSearches(tenant, { search: run.search, thresholds: THRESHOLDS });
  [row] = await shadowRows('close_event_id = $2', [e3]);
  assert.equal(row.outcome, 'tie');
  assert.equal(row.true_stay_matched, true, 'the true stay is among the tied; the tie is the finding');
  assert.equal(row.matched_ids.length, 2);
  assert.ok(s1, 'the first stay still exists');
});

test('a search that cannot be obtained leaves the row pending, counted, and is retried next run', async () => {
  const p = plate('DOWN');
  await openStay(p, descriptor('DOWN-IN'));
  const e = randomUUID();
  await closeExit({ event_id: e, plate: p, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed', descriptor: descriptor('DOWN-OUT') });

  const dead = fakeSearch(() => { throw new Error('search answered HTTP 503: down'); });
  const summary = await runShadowSearches(tenant, { search: dead.search, thresholds: THRESHOLDS });
  assert.ok(summary.failed >= 1);
  let [row] = await shadowRows('close_event_id = $2', [e]);
  assert.equal(row.searched_at, null);
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /503/);
  const events = await withTenant(tenant, async (c) =>
    (await c.query(`SELECT 1 FROM events WHERE tenant_id = $1 AND kind = $2 AND detail->>'close_event_id' = $3`, [tenant, SHADOW_EVENT_KIND, e])).rowCount,
  );
  assert.equal(events, 0, 'no event for a search that did not happen');

  // Back up: the next run finishes it.
  const alive = fakeSearch((body) => recordMatching([], body));
  await runShadowSearches(tenant, { search: alive.search, thresholds: THRESHOLDS });
  [row] = await shadowRows('close_event_id = $2', [e]);
  assert.ok(row.searched_at);
  assert.equal(row.outcome, 'no_match');
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error, null);
});

test('an outcome outside the closed set is refused, not recorded', async () => {
  const p = plate('ODD');
  await openStay(p, descriptor('ODD-IN'));
  const e = randomUUID();
  await closeExit({ event_id: e, plate: p, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed', descriptor: descriptor('ODD-OUT') });
  const odd = fakeSearch((body) => ({ ...recordMatching([], body), outcome: 'probably' }));
  const summary = await runShadowSearches(tenant, { search: odd.search, thresholds: THRESHOLDS });
  assert.ok(summary.failed >= 1);
  const [row] = await shadowRows('close_event_id = $2', [e]);
  assert.equal(row.searched_at, null);
  assert.match(row.last_error, /outcome this build does not know/);
});

test('the thresholds are the operator\'s to state: no default', () => {
  assert.throws(() => thresholdsFromEnv({}), /SHADOW_THRESHOLD_STRUCTURE is required/);
  assert.throws(() => thresholdsFromEnv({ SHADOW_THRESHOLD_STRUCTURE: '0.75' }), /SHADOW_THRESHOLD_COLOUR is required/);
  assert.throws(() => thresholdsFromEnv({ SHADOW_THRESHOLD_STRUCTURE: '1.5', SHADOW_THRESHOLD_COLOUR: '0.5' }), /\[0, 1\]/);
  assert.deepEqual(
    thresholdsFromEnv({ SHADOW_THRESHOLD_STRUCTURE: '0.75', SHADOW_THRESHOLD_COLOUR: '0.69' }),
    THRESHOLDS,
  );
});

// --- what may be published -------------------------------------------------

test('the report: every rate over the comparable rows, the denominator and the oracle on it, nothing over all exits', async () => {
  // A garage of its own, so the arithmetic is exact.
  const g = await withTenant(tenant, async (c) => {
    const garage = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Report','UTC','USD') RETURNING id`, [tenant])).rows[0].id;
    const lane = async (name, dir) => (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, garage, name, dir])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const exitLane = await lane('X', 'exit');
    await c.query(`INSERT INTO rates (tenant_id, garage_id, name, hourly_minor) VALUES ($1,$2,'H',100)`, [tenant, garage]);
    return { garage, entryLane, exitLane };
  });
  const gEntry = await issueDeviceToken(tenant, g.entryLane, 'e');
  const gExit = await issueDeviceToken(tenant, g.exitLane, 'x');
  const gOpen = (p, d) => fetch(`${base}/api/v1/lane/sessions/open`, post(gEntry, { plate: p, entry_at: '2026-08-26T09:00:00Z', entry_confirmation: 'confirmed', ...(d ? { descriptor: d } : {}) }));
  const gClose = (p, d) => fetch(`${base}/api/v1/lane/sessions/close`, post(gExit, { plate: p, exit_at: '2026-08-26T11:00:00Z', exit_confirmation: 'confirmed', descriptor: d }));

  // Four comparable exits: matched, wrong, tie, no_match. One not comparable
  // (no entry descriptor). One pending (never searched).
  const stays = {};
  for (const name of ['M', 'W', 'T', 'N', 'P']) {
    const p = plate(name);
    const res = await gOpen(p, descriptor(`${name}-IN`));
    stays[name] = { plate: p, id: (await res.json()).session.id };
  }
  const pNC = plate('NC');
  await gOpen(pNC, null);
  // Close them all with descriptors.
  for (const name of ['M', 'W', 'T', 'N']) await gClose(stays[name].plate, descriptor(`${name}-OUT`));
  await gClose(pNC, descriptor('NC-OUT'));
  // The stand-in answers by the exit descriptor's tag: M matches itself, W
  // matches P instead (wrong), T ties with P, N nothing, NC nothing.
  const byTag = fakeSearch((body) => {
    const tag = Buffer.from(body.descriptor.slice('opvid-fp/1:'.length), 'base64url').toString().split('-')[0];
    const P = stays.P.id;
    return {
      M: () => recordMatching([stays.M.id], body),
      W: () => recordMatching([P], body),
      T: () => recordMatching([stays.T.id, P], body),
      N: () => recordMatching([], body),
      NC: () => recordMatching([], body),
    }[tag]();
  });
  await runShadowSearches(tenant, { search: byTag.search, thresholds: THRESHOLDS });
  // P: close it now so it is pending and unsearched.
  await gClose(stays.P.plate, descriptor('P-OUT'));

  const report = await shadowReport(tenant, g.garage);
  assert.deepEqual(report.denominator, { exits: 6, searched: 5, pending: 1, comparable: 4, not_comparable: 1 });
  assert.equal(report.match_rate, 1 / 4);
  assert.equal(report.wrong_match_rate, 1 / 4);
  assert.equal(report.tie_rate, 1 / 4);
  assert.equal(report.no_match_rate, 1 / 4);
  assert.deepEqual(report.counts, { true_stay_matched: 1, wrong_match: 1, ties: 1, no_match: 1 });
  assert.match(report.oracle, /plate or ticket, independently of the search/);
  assert.match(report.oracle, /plate reader's own errors/);
  assert.match(report.oracle, /404/);
  assert.equal(report.not_measurable, 'a match rate over ALL exits');
  // The rates are over `comparable`, not over `exits` or `searched`: with the
  // not-comparable and the pending rows folded in they would read 1/6 or 1/5.
  assert.notEqual(report.match_rate, 1 / 6);
  assert.notEqual(report.match_rate, 1 / 5);
});
