/**
 * A QR shown at a lane (`POST /api/v1/lane/redeem-enrolment`,
 * src/enrolments.js) -- against the REAL garage-pass, its own database built
 * from its own migrations, its QRs minted through its own `issue-enrolment`.
 *
 * Every open is paired with the same presentation staying shut for a reason
 * the module names; the module's could-not-answer is paired with the same
 * presentation answered once it is back. Which read passes for the QR's plate
 * is garage-pass's rule ("similar enough gets a pass", its G33); here, that
 * each way it passes reaches the lane and the event by name. And the token and
 * the plate are looked for everywhere this platform writes, and are not there.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, QR_PER_MINUTE } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startEntitlementModules } from './entitlement-modules.js';
import { QR_PRESENTED_EVENT_KIND, PRESENTED_MAX_AGE_SECONDS } from '../src/enrolments.js';

let modules;
let server;
let base;
let tenant;
let operatorToken;

async function issueToken(laneId, name) {
  const token = generateDeviceToken();
  await withTenant(tenant, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [tenant, laneId, name, hashToken(token)]),
  );
  return token;
}
const op = (method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const present = (device, body) =>
  fetch(`${base}/api/v1/lane/redeem-enrolment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${device}` },
    body: JSON.stringify({ presented_at: new Date().toISOString(), ...body }),
  });
const plate = (tag) => `${tag}${randomUUID().slice(0, 6).toUpperCase()}`;
/** `car` with its last `n` characters replaced by X, which no look-alike group holds. */
const offBy = (car, n) => `${car.slice(0, -n)}${'X'.repeat(n)}`;
const day = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const qrEvents = (garageId) =>
  withTenant(tenant, async (c) =>
    (await c.query(`SELECT * FROM events WHERE tenant_id = $1 AND kind = $2 AND garage_id = $3 ORDER BY received_at`, [tenant, QR_PRESENTED_EVENT_KIND, garageId])).rows,
  );

/**
 * A platform garage linked to a garage-pass garage, a pass valid around
 * today, and one QR minted for `car`. `enrolsAt` null: a pass-only garage
 * (no transient parking, so it enrols at entry, derived). 'exit': a garage
 * that takes transients and enrols at the exit.
 */
async function world({ enrolsAt = null, link = true } = {}) {
  const g = await withTenant(tenant, async (c) => {
    const id = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'QR','UTC','USD') RETURNING id`, [tenant])).rows[0].id;
    const lane = async (name, direction) =>
      (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant, id, name, direction])).rows[0].id;
    const entryLane = await lane('E', 'entry');
    const exitLane = await lane('X', 'exit');
    await storePlan(c, tenant, id, flatHourlyPlan());
    await activateGarage(c, tenant, id, { transientAvailable: enrolsAt !== null });
    return { id, entryLane, exitLane };
  });
  const short = g.id.slice(0, 8);
  const gpGarage = `gp-${short}`;
  const passId = `pass-${short}`;
  const car = plate('QR');
  const file = join(tmpdir(), `gp-garage-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify({ id: gpGarage, timezone: 'UTC', transient_available: enrolsAt !== null }));
  await modules.gp('create-garage', '--garage', file);
  if (enrolsAt) {
    await modules.gp('set-garage-enrols-at', '--garage', gpGarage, '--enrols-at', enrolsAt, '--by', 'the test',
      '--at', new Date().toISOString(), '--reason', 'the readers are at that end');
  }
  await modules.gpPass(passId, [gpGarage], { validFrom: day(-30), validTo: day(30) });
  const issued = JSON.parse(await modules.gp('issue-enrolment', '--garage', gpGarage, '--pass-id', passId,
    '--enrolment-id', `qr-${short}`, '--plate', car, '--starts-on', day(0), '--days-valid', '3',
    '--by', 'the desk', '--at', new Date().toISOString()));
  if (link) {
    const res = await op('PUT', `/garages/${g.id}/entitlement-links`, {
      garage_pass: { tenant_id: modules.garage_pass.tenant, garage_id: gpGarage }, monthly_billing: null,
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  }
  return {
    ...g, gpGarage, passId, car, qr: issued.token, enrolmentId: `qr-${short}`,
    entry: await issueToken(g.entryLane, `e-${short}`), exit: await issueToken(g.exitLane, `x-${short}`),
  };
}

before(async () => {
  modules = await startEntitlementModules();
  tenant = await createTenant('qr');
  await buildWorld(tenant);
  const token = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(token)]));
  operatorToken = token;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await modules?.stop();
  await pool.end();
});

test('a pass-only entry: the QR shown by its own car opens; the same QR under another plate stays shut', async () => {
  const w = await world();
  const res = await present(w.entry, { token: w.qr, vehicle: w.car });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.open, true);
  assert.equal(body.outcome, 'covered');
  assert.equal(body.answer.outcome, 'covered');
  assert.equal(body.enrolment.enrolment, w.enrolmentId);
  assert.equal(body.enrolment.recognised, true);
  assert.equal(body.enrolment.passed_by, 'same_plate');

  // CONTROL: the same QR, a plate clearly not the one it was made for -- the
  // module asks for a picture match, and nothing opens on this QR until one is
  // made.
  const other = await present(w.entry, { token: w.qr, vehicle: plate('ZZ') });
  const otherBody = await other.json();
  assert.equal(other.status, 200, JSON.stringify(otherBody));
  assert.equal(otherBody.open, false);
  assert.equal(otherBody.enrolment.match_required, true);
  assert.notEqual(otherBody.answer.outcome, 'covered');
});

test('nothing read: a valid QR passes as nothing_read; an unknown QR is refused by name; status 200, because it answered', async () => {
  const w = await world();
  const blind = await present(w.entry, { token: w.qr, vehicle: null });
  const blindBody = await blind.json();
  assert.equal(blind.status, 200, JSON.stringify(blindBody));
  assert.equal(blindBody.open, true);
  assert.equal(blindBody.enrolment.recognised, true);
  assert.equal(blindBody.enrolment.passed_by, 'nothing_read');
  assert.equal(blindBody.enrolment.match_required, false);
  assert.equal(blindBody.enrolment.qr_plate, w.car);
  // CONTROL: nothing read opens on a valid QR and on nothing else -- an
  // unknown QR with nothing read is refused by name, and stays shut.
  const blindUnknown = await present(w.entry, { token: `not-a-qr-${randomUUID()}`, vehicle: null });
  const blindUnknownBody = await blindUnknown.json();
  assert.equal(blindUnknown.status, 200, JSON.stringify(blindUnknownBody));
  assert.equal(blindUnknownBody.open, false);
  assert.equal(typeof blindUnknownBody.enrolment.refused, 'string');

  const unknown = await present(w.entry, { token: `not-a-qr-${randomUUID()}`, vehicle: plate('ZZ') });
  const unknownBody = await unknown.json();
  assert.equal(unknown.status, 200, JSON.stringify(unknownBody));
  assert.equal(unknownBody.open, false);
  assert.equal(typeof unknownBody.enrolment.refused, 'string');
  assert.ok(unknownBody.enrolment.detail.length > 0);
  // CONTROL: a refused QR is not a refused car. The answer is the car's own,
  // and a car the registers already cover is let through on its pass.
  const covered = await present(w.entry, { token: `not-a-qr-${randomUUID()}`, vehicle: w.car });
  const coveredBody = await covered.json();
  assert.equal(typeof coveredBody.enrolment.refused, 'string');
  assert.equal(coveredBody.open, true);
});

test('similar enough gets a pass: a look-alike and one difference open, by name; two differences ask for a person', async () => {
  const w = await world();
  // Q and O are one look-alike group; the car's plate starts QR (see `plate`).
  const lookAlike = await present(w.entry, { token: w.qr, vehicle: `O${w.car.slice(1)}` });
  const lookAlikeBody = await lookAlike.json();
  assert.equal(lookAlike.status, 200, JSON.stringify(lookAlikeBody));
  assert.equal(lookAlikeBody.open, true);
  assert.equal(lookAlikeBody.enrolment.passed_by, 'look_alike');

  const oneOff = await present(w.entry, { token: w.qr, vehicle: offBy(w.car, 1) });
  const oneOffBody = await oneOff.json();
  assert.equal(oneOff.status, 200, JSON.stringify(oneOffBody));
  assert.equal(oneOffBody.open, true);
  assert.equal(oneOffBody.enrolment.passed_by, 'one_difference');

  // CONTROL: one more difference is a clearly different car -- shut on this
  // QR, no pass named, and a person or a picture match decides.
  const twoOff = await present(w.entry, { token: w.qr, vehicle: offBy(w.car, 2) });
  const twoOffBody = await twoOff.json();
  assert.equal(twoOff.status, 200, JSON.stringify(twoOffBody));
  assert.equal(twoOffBody.open, false);
  assert.equal(twoOffBody.enrolment.match_required, true);
  assert.equal(twoOffBody.enrolment.passed_by, null);

  const events = await qrEvents(w.id);
  assert.deepEqual(events.map((e) => [e.detail.open, e.detail.passed_by, e.detail.match_required]),
    [[true, 'look_alike', false], [true, 'one_difference', false], [false, null, true]]);
});

test('an exit at a garage that enrols at the exit: the QR answers covered there', async () => {
  const w = await world({ enrolsAt: 'exit' });
  const res = await present(w.exit, { token: w.qr, vehicle: w.car });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.open, true);
  assert.equal(body.answer.direction, 'exit');
  // CONTROL: an exit never refuses -- a stranger's car is not covered, and still answered.
  const stranger = await present(w.exit, { token: `nope-${randomUUID()}`, vehicle: plate('XX') });
  const strangerBody = await stranger.json();
  assert.equal(stranger.status, 200);
  assert.equal(strangerBody.open, false);
  assert.equal(strangerBody.answer.outcome, 'not_covered');
});

test('the token and the plate are kept nowhere: not in an event, not in a log line', async () => {
  const w = await world();
  const logged = [];
  const LEVELS = ['error', 'warn', 'log', 'info', 'debug'];
  const original = Object.fromEntries(LEVELS.map((level) => [level, console[level]]));
  for (const level of LEVELS) console[level] = (...args) => logged.push(args.map(String).join(' '));
  try {
    await present(w.entry, { token: w.qr, vehicle: w.car });
    await present(w.entry, { token: w.qr, vehicle: null });
  } finally {
    Object.assign(console, original);
  }
  const events = await qrEvents(w.id);
  assert.equal(events.length, 2);
  for (const e of events) {
    const text = JSON.stringify(e.detail);
    assert.ok(!text.includes(w.qr), 'the token is in an event');
    assert.ok(!text.includes(w.car), 'the plate is in an event');
  }
  // What the event does say: how the car passed for the QR, and which QR.
  assert.deepEqual(events.map((e) => [e.detail.open, e.detail.read_identity, e.detail.passed_by]),
    [[true, true, 'same_plate'], [true, false, 'nothing_read']]);
  for (const e of events) assert.equal(e.detail.enrolment, w.enrolmentId);
  for (const line of logged) {
    assert.ok(!line.includes(w.qr), 'the token is in a log line');
    assert.ok(!line.includes(w.car), 'the plate is in a log line');
  }
  // CONTROL: the event is the presentation's -- it names the lane that saw it.
  assert.equal(events[0].lane_id, w.entryLane);
});

test('a garage-pass that cannot answer is a 503 the lane treats as offline; back, the same QR is answered', async () => {
  const w = await world();
  const saved = process.env.ENTITLEMENT_BIN_DIR;
  process.env.ENTITLEMENT_BIN_DIR = await mkdtemp(join(tmpdir(), 'no-modules-'));
  let down;
  try {
    down = await present(w.entry, { token: w.qr, vehicle: w.car });
  } finally {
    if (saved === undefined) delete process.env.ENTITLEMENT_BIN_DIR;
    else process.env.ENTITLEMENT_BIN_DIR = saved;
  }
  const downBody = await down.json();
  assert.equal(down.status, 503, JSON.stringify(downBody));
  assert.equal(downBody.code, 'qr_unanswered');
  assert.ok(!JSON.stringify(downBody).includes(w.qr), 'the token is in the 503');
  const [event] = await qrEvents(w.id);
  assert.equal(event.detail.answered, false);
  // CONTROL: the module back, the same presentation opens.
  const up = await present(w.entry, { token: w.qr, vehicle: w.car });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).open, true);
});

test('a garage that names no garage-pass garage cannot check a QR, and says so', async () => {
  const w = await world({ link: false });
  const res = await present(w.entry, { token: w.qr, vehicle: w.car });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.code, 'qr_not_linked');
  assert.equal((await qrEvents(w.id)).length, 0);
});

test('a presentation from the past or the future is refused; one without a token is refused by name', async () => {
  const w = await world();
  const stale = await present(w.entry, { token: w.qr, vehicle: w.car, presented_at: new Date(Date.now() - (PRESENTED_MAX_AGE_SECONDS + 30) * 1000).toISOString() });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'qr_stale');
  const ahead = await present(w.entry, { token: w.qr, vehicle: w.car, presented_at: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(ahead.status, 409);
  assert.equal((await ahead.json()).code, 'clock_skew');
  const empty = await present(w.entry, { token: '  ', vehicle: w.car });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /token/);
  const control = await present(w.entry, { token: `bad\u0000${w.qr}`, vehicle: w.car });
  const controlBody = await control.json();
  assert.equal(control.status, 400);
  assert.ok(!JSON.stringify(controlBody).includes(w.qr), 'a refusal quoted the token');
  assert.equal((await qrEvents(w.id)).length, 0);
});

test(`a device presents at most ${QR_PER_MINUTE} QRs a minute; another device is not held by it`, async () => {
  const w = await world();
  const statuses = [];
  for (let i = 0; i <= QR_PER_MINUTE; i += 1) {
    statuses.push((await present(w.entry, { token: `guess-${i}-${randomUUID()}`, vehicle: w.car })).status);
  }
  assert.deepEqual(statuses.slice(0, QR_PER_MINUTE), Array(QR_PER_MINUTE).fill(200));
  assert.equal(statuses[QR_PER_MINUTE], 429);
  // CONTROL: the exit lane's device has its own minute.
  assert.equal((await present(w.exit, { token: `guess-x-${randomUUID()}`, vehicle: w.car })).status, 200);
});

test('a lane posts qr_presented only for a QR it could not present, and never with the token or a plate', async () => {
  const w = await world();
  const post = (detail) =>
    fetch(`${base}/api/v1/lane/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${w.entry}` },
      body: JSON.stringify({ events: [{ event_id: randomUUID(), kind: QR_PRESENTED_EVENT_KIND, occurred_at: new Date().toISOString(), detail }] }),
    });
  assert.equal((await post({ answered: false, reason: 'offline', direction: 'entry', read_identity: true })).status, 202);
  assert.equal((await post({ answered: false, reason: 'offline', token: w.qr })).status, 400);
  assert.equal((await post({ answered: false, plate: w.car })).status, 400);
  assert.equal((await post({ answered: true })).status, 400);
  const events = await qrEvents(w.id);
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes(w.qr));
});
