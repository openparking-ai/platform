/**
 * THE EXIT CASE (0037): the car at an exit lane, found by its ID.
 *
 * What this file measures, each with a break in `scripts/exits-fail-control.js`:
 *
 *   * an entry keeps its ID (plate characters, colour code, size), and the
 *     exit finds the stay by it -- one clear stay, priced here;
 *   * an unread stay is found by an unreadable exit of its colour, and closed
 *     through the case: no plate needed;
 *   * a few candidates go to the picker with pictures only, within its time
 *     limit; its number is the stay; "none", a timeout or nonsense is none;
 *     a resend never asks it twice; off, it is never asked;
 *   * none found: an event for the attendants, then the driver's word priced
 *     by the engine, once, no later than the exit and no more than 90 days
 *     before it;
 *   * the gate's word: settled only covered, at zero, or let out by a person;
 *     a person's letting out is recorded with who and why, in the change log;
 *   * the close names the case and writes the case's fee; a case of another
 *     tenant is not found.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { redactExpiredVehicles } from '../src/retention.js';

const RULE = 'opvid-plate-chars/1';
const RED = 'opvid-colour/1:m:f000000000000000';
const GREY = 'opvid-colour/1:m:000000000000f000';
const JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();

let engine;
let server;
let base;
let picker;
const keyDir = mkdtempSync(join(tmpdir(), 'exit-picker-'));
const keyFile = join(keyDir, 'key');
writeFileSync(keyFile, 'test-key\n');

/** A stand-in for the Messages API: records each request, answers what it is told. */
function startPicker() {
  const state = { requests: [], answer: '1', delayMs: 0, status: 200 };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.requests.push({ headers: req.headers, body: JSON.parse(raw) });
      setTimeout(() => {
        res.writeHead(state.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: state.answer }] }));
      }, state.delayMs);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ state, srv, url: `http://127.0.0.1:${srv.address().port}/v1/messages` })));
}

function pickerOn() {
  process.env.EXIT_PICKER_KEY_FILE = keyFile;
  process.env.EXIT_PICKER_URL = picker.url;
  process.env.EXIT_PICKER_TIMEOUT_MS = '1000';
}
function pickerOff() {
  delete process.env.EXIT_PICKER_KEY_FILE;
  delete process.env.EXIT_PICKER_URL;
  delete process.env.EXIT_PICKER_TIMEOUT_MS;
}

async function token(tenantId, laneId, name) {
  const t = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)', [tenantId, laneId, name, hashToken(t)]));
  return t;
}

/** A garage of its own, so each test matches against its own stays only. */
async function garage(name) {
  const tenant = await createTenant(name);
  const world = await buildWorld(tenant, { hourlyMinor: 250 });
  const op = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)`, [tenant, hashToken(op)]));
  return { tenant, world, entry: await token(tenant, world.entryLane, 'entry'), exit: await token(tenant, world.exitLane, 'exit'), op };
}

const call = (tok, method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const read = (pattern) => ({ state: 'read', rule: RULE, pattern });

async function enter(g, { plate = null, unread = false, id = {}, minutes = 90 } = {}) {
  const eventId = randomUUID();
  const res = await call(g.entry, 'POST', '/lane/sessions/open', {
    event_id: eventId,
    ...(unread ? { plate_unreadable: true } : { plate }),
    entry_at: ago(minutes),
    entry_confirmation: 'confirmed',
    ...id,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return { eventId, session: (await res.json()).session };
}

async function picture(tok, eventId) {
  const res = await call(tok, 'POST', '/lane/pictures', { picture_ref: randomUUID().slice(0, 30), event_id: eventId, taken_at: ago(1), image: JPEG.toString('base64') });
  assert.equal(res.status, 201, await res.clone().text());
}

const atExit = (g, body) => call(g.exit, 'POST', '/lane/exits', { event_id: randomUUID(), exit_at: ago(0.5), ...body });

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  picker = await startPicker();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pickerOff();
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => picker.srv.close(r));
  await engine?.stop();
  await pool.end();
});

test('an entry keeps its ID, the exit finds the stay by it, and the close writes the fee it showed', async () => {
  const g = await garage('exit-single');
  const { session } = await enter(g, { plate: 'OBS7123', id: { plate_characters: read('085712?'), color_code: RED, size: 'small' } });
  assert.equal(session.entry_plate_pattern, '085712?');
  assert.equal(session.entry_colour_code, RED);
  assert.equal(session.entry_size, 'small');
  await enter(g, { plate: 'ZZZ9999', id: { plate_characters: read('ZZZ9999') } });

  const res = await atExit(g, { plate_characters: read('08571?3'), color_code: RED });
  assert.equal(res.status, 201);
  const { exit } = await res.json();
  assert.equal(exit.method, 'single');
  assert.equal(exit.session_id, session.id);
  assert.equal(exit.fee.outcome, 'transient');
  assert.ok(exit.fee.fee_minor > 0, 'a 90-minute stay at 2.50 an hour costs something');
  assert.deepEqual([exit.settled, exit.needs], [false, 'payment'], 'a fee above zero does not open the gate');

  const closed = await call(g.exit, 'POST', '/lane/sessions/close', {
    event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.2), exit_confirmation: 'confirmed',
  });
  assert.equal(closed.status, 200, await closed.clone().text());
  const out = await closed.json();
  assert.equal(out.session.id, session.id);
  assert.equal(out.session.fee_minor, exit.fee.fee_minor, 'the fee written is the fee shown');
  assert.equal(out.exit.closed, true);
});

test('an unread stay is found by an unreadable exit of its colour, and closed through the case', async () => {
  const g = await garage('exit-unread');
  const { session } = await enter(g, { unread: true, id: { plate_characters: { state: 'unreadable', rule: RULE }, color_code: RED } });
  await enter(g, { unread: true, id: { plate_characters: { state: 'unreadable', rule: RULE }, color_code: GREY } });
  await enter(g, { plate: 'RED1234', id: { plate_characters: read('RED1234'), color_code: RED } });
  const { exit } = await (await atExit(g, { plate_characters: { state: 'unreadable', rule: RULE }, color_code: RED })).json();
  assert.deepEqual([exit.method, exit.session_id], ['single', session.id]);
  const closed = await call(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.2), exit_confirmation: 'confirmed' });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).session.id, session.id, 'a stay no plate could close is closed');
});

test('a few candidates go to the picker as pictures; its number is the stay, and a resend does not ask again', async () => {
  const g = await garage('exit-picker');
  const a = await enter(g, { plate: 'AB12345', id: { plate_characters: read('AB?????') } });
  const b = await enter(g, { plate: 'AB67890', id: { plate_characters: read('AB?????') } });
  for (const s of [a, b]) await picture(g.entry, s.eventId);
  const eventId = randomUUID();
  await picture(g.exit, eventId);

  pickerOn();
  try {
    picker.state.requests.length = 0;
    picker.state.answer = '2';
    const res = await atExit(g, { event_id: eventId, plate_characters: read('AB?????') });
    const { exit } = await res.json();
    assert.equal(picker.state.requests.length, 1);
    const sent = picker.state.requests[0];
    assert.equal(sent.headers['x-api-key'], 'test-key');
    const content = sent.body.messages[0].content;
    assert.equal(content.filter((c) => c.type === 'image').length, 3, 'one exit picture and one for each candidate');
    assert.doesNotMatch(JSON.stringify(sent.body), /AB12345|AB67890|AB\?|opvid|entry_at/, 'pictures only');
    const shown = exit.method === 'picker' ? exit.session_id : null;
    assert.ok([a.session.id, b.session.id].includes(shown), 'the stay is the one the number names');
    const cases = await (await call(g.op, 'GET', `/garages/${g.world.garage}/exits`)).json();
    const kept = cases.exits.find((e) => e.id === exit.id);
    assert.equal(kept.picker.answer, 2);
    assert.equal(kept.candidates[1], shown, 'number 2 is the second candidate shown');
    assert.equal(typeof kept.picker.elapsed_ms, 'number');

    const again = await atExit(g, { event_id: eventId, plate_characters: read('AB?????') });
    assert.equal(again.status, 200);
    assert.equal(picker.state.requests.length, 1, 'never asked twice for one car');
  } finally {
    pickerOff();
  }
});

test('"none", a timeout, nonsense, or the picker off: no stay, and the attendants are told', async () => {
  const g = await garage('exit-picker-none');
  for (const p of ['CD11111', 'CD22222']) {
    const s = await enter(g, { plate: p, id: { plate_characters: read('CD?????') } });
    await picture(g.entry, s.eventId);
  }
  const ask = async () => {
    const eventId = randomUUID();
    await picture(g.exit, eventId);
    return (await (await atExit(g, { event_id: eventId, plate_characters: read('CD?????') })).json()).exit;
  };
  pickerOn();
  try {
    for (const [answer, delayMs, outcome] of [['0', 0, 'none'], ['1', 1500, 'timeout'], ['the first one', 0, 'unclear']]) {
      Object.assign(picker.state, { answer, delayMs });
      const exit = await ask();
      assert.deepEqual([exit.method, exit.needs], ['none', 'driver_word'], outcome);
      const cases = await (await call(g.op, 'GET', `/garages/${g.world.garage}/exits`)).json();
      assert.equal(cases.exits.find((e) => e.id === exit.id).picker.outcome, outcome);
    }
  } finally {
    Object.assign(picker.state, { answer: '1', delayMs: 0 });
    pickerOff();
  }
  const before = picker.state.requests.length;
  const off = await ask();
  assert.equal(off.method, 'none');
  assert.equal(picker.state.requests.length, before, 'off is never asked');
  const events = await withTenant(g.tenant, async (c) =>
    (await c.query("SELECT detail FROM events WHERE kind = 'exit_unmatched' AND garage_id = $1", [g.world.garage])).rows);
  assert.equal(events.length, 4, 'every unmatched car is an event for the attendants');
});

test('a candidate without pictures is one the picker could never choose: it is not asked', async () => {
  const g = await garage('exit-picker-blind');
  const seen = await enter(g, { plate: 'EF11111', id: { plate_characters: read('EF?????') } });
  await picture(g.entry, seen.eventId);
  await enter(g, { plate: 'EF22222', id: { plate_characters: read('EF?????') } });
  const eventId = randomUUID();
  await picture(g.exit, eventId);
  pickerOn();
  try {
    const before = picker.state.requests.length;
    const { exit } = await (await atExit(g, { event_id: eventId, plate_characters: read('EF?????') })).json();
    assert.equal(exit.method, 'none');
    assert.equal(picker.state.requests.length, before, 'not asked with a car hidden');
    const cases = await (await call(g.op, 'GET', `/garages/${g.world.garage}/exits`)).json();
    assert.equal(cases.exits.find((e) => e.id === exit.id).picker.outcome, 'not_asked');
  } finally {
    pickerOff();
  }
});

test('the close writes the case\'s figures -- the fee shown and paid -- and never prices the stay again', async () => {
  const g = await garage('exit-as-shown');
  const { session } = await enter(g, { plate: 'SHOWN12', id: { plate_characters: read('5H0WN12') } });
  const { exit } = await (await atExit(g, { plate_characters: read('5H0WN12') })).json();
  // As if the engine had said 7.77 when the car reached the barrier.
  await withTenant(g.tenant, (c) => c.query(
    `UPDATE exits SET quote = quote || jsonb_build_object('fee_minor', 777, 'subtotal_minor', 777,
                                                          'pre_tax', (quote->'pre_tax') || jsonb_build_object('feeMinor', 777))
      WHERE id = $1`, [exit.id]));
  const closed = await call(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.2), exit_confirmation: 'confirmed' });
  const out = await closed.json();
  assert.equal(out.session.id, session.id);
  assert.equal(out.session.fee_minor, 777, 'the figure on the case, not a second price');
});

test('the database holds the shapes: a read plate with nothing sure, a word beyond 90 days', async () => {
  const g = await garage('exit-db-shape');
  await assert.rejects(withTenant(g.tenant, (c) => c.query(
    `WITH v AS (INSERT INTO vehicles (tenant_id, plate) VALUES ($1, 'DB-' || gen_random_uuid()) RETURNING id)
     INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency, open_event_id, entry_confirmation,
                           entry_plate_state, entry_plate_rule, entry_plate_pattern)
     SELECT $1, $2, v.id, $3, now(), 'USD', gen_random_uuid()::text, 'confirmed', 'read', $4, '???????' FROM v`,
    [g.tenant, g.world.garage, g.world.entryLane, RULE])), /sessions_entry_plate_id_shape/);
  const word = (days) => withTenant(g.tenant, (c) => c.query(
    `INSERT INTO exits (tenant_id, garage_id, lane_id, event_id, exit_at, method, claimed_entry_at)
     VALUES ($1, $2, $3, 'db' || replace(gen_random_uuid()::text, '-', ''), now(), 'driver_word', now() - make_interval(days => $4))`,
    [g.tenant, g.world.garage, g.world.exitLane, days]));
  await assert.rejects(word(91), /exits_word_is_a_time/);
  await word(89);
});

test("no stay found: the driver's word is priced by the engine, once, within the exit and 90 days", async () => {
  const g = await garage('exit-word');
  await enter(g, { plate: 'XYZ1234', id: { plate_characters: read('XYZ1234') } });
  const { exit } = await (await atExit(g, { plate_characters: read('QQQ9999') })).json();
  assert.deepEqual([exit.method, exit.needs, exit.fee], ['none', 'driver_word', null]);

  const word = (entryAt) => call(g.exit, 'POST', `/lane/exits/${exit.id}/word`, { entry_at: entryAt });
  assert.equal((await word(new Date(Date.now() + 60_000).toISOString())).status, 409, 'after the exit');
  assert.equal((await word(new Date(Date.now() - 91 * 86_400_000).toISOString())).status, 409, 'more than 90 days');
  const said = await word(ago(120));
  assert.equal(said.status, 200, await said.clone().text());
  const priced = (await said.json()).exit;
  assert.equal(priced.method, 'driver_word');
  assert.equal(priced.fee.fee_minor, 500, 'two hours at 2.50, by the engine');
  assert.deepEqual([priced.settled, priced.needs], [false, 'payment']);
  assert.equal((await word(ago(30))).status, 409, 'said once');
  const told = await withTenant(g.tenant, async (c) =>
    (await c.query("SELECT detail FROM events WHERE kind = 'exit_driver_word' AND garage_id = $1", [g.world.garage])).rows);
  assert.equal(told.length, 1);
  assert.equal(told[0].detail.fee_minor, 500);

  const closed = await call(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.2), exit_confirmation: 'confirmed' });
  assert.equal(closed.status, 200);
  const out = await closed.json();
  assert.equal(out.session, null, 'no stay is invented for the word');
  assert.equal(out.exit.closed, true);
});

test('a person lets the car out with a reason: settled, recorded, once', async () => {
  const g = await garage('exit-person');
  const { exit } = await (await atExit(g, { plate_characters: read('NOPE123') })).json();
  assert.equal(exit.settled, false);
  const path = `/garages/${g.world.garage}/exits/${exit.id}/let-out`;
  assert.equal((await call(g.op, 'POST', path, {})).status, 400, 'a reason is required');
  const res = await call(g.op, 'POST', path, { reason: 'driver showed a paper ticket' });
  assert.equal(res.status, 200, await res.clone().text());
  const after = (await res.json()).exit;
  assert.deepEqual([after.settled, after.why], [true, 'person']);
  assert.equal(after.person.reason, 'driver showed a paper ticket');
  assert.match(after.person.by, /^key:/);
  assert.equal((await call(g.op, 'POST', path, { reason: 'again' })).status, 409);
  const polled = (await (await call(g.exit, 'GET', `/lane/exits/${exit.id}`)).json()).exit;
  assert.equal(polled.settled, true, 'the lane reads it');
  const lines = await withTenant(g.tenant, async (c) =>
    (await c.query("SELECT subject_kind, after FROM garage_changes WHERE action = 'exit.let_out' AND outcome = 'done'")).rows);
  assert.equal(lines.length, 1, 'one done line; the refused attempts are lines of their own');
  assert.equal(lines[0].subject_kind, 'exit');
});

test('the lane may name the stay it matched itself; a stay not open is refused', async () => {
  const g = await garage('exit-lane-named');
  const { session } = await enter(g, { plate: 'LANE123' });
  const { exit } = await (await atExit(g, { session_id: session.id })).json();
  assert.deepEqual([exit.method, exit.session_id], ['lane', session.id]);
  assert.ok(exit.fee.fee_minor > 0);
  const gone = await atExit(g, { session_id: randomUUID() });
  assert.equal(gone.status, 409);
  assert.equal((await gone.json()).code, 'stay_not_open');
});

test("a case is its tenant's: another tenant's lane does not find it, nor close it", async () => {
  const g = await garage('exit-own');
  const other = await garage('exit-other');
  const { exit } = await (await atExit(g, { plate_characters: read('MINE123') })).json();
  assert.equal((await call(other.exit, 'GET', `/lane/exits/${exit.id}`)).status, 404);
  const closed = await call(other.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.2), exit_confirmation: 'confirmed' });
  assert.equal(closed.status, 404);
  assert.equal((await call(other.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/let-out`, { reason: 'x' })).status, 404);
});

test('the ID is shaped or refused, and the purge takes it with the plate', async () => {
  const g = await garage('exit-shape');
  for (const id of [
    { plate_characters: { state: 'read', rule: RULE, pattern: '????' } },
    { plate_characters: { state: 'read', pattern: 'AB12' } },
    { plate_characters: { state: 'unreadable', rule: RULE, pattern: 'AB12' } },
    { color_code: 'red' },
    { size: 'Big Truck' },
  ]) {
    assert.equal((await atExit(g, id)).status, 400, JSON.stringify(id));
  }
  const { session } = await enter(g, { plate: 'GONE123', id: { plate_characters: read('G0NE123'), color_code: RED }, minutes: 600 });
  const { exit } = await (await atExit(g, { plate_characters: read('G0NE123') })).json();
  await call(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.2), exit_confirmation: 'confirmed' });
  await redactExpiredVehicles(g.tenant, { now: new Date(Date.now() + 400 * 86_400_000) });
  const row = await withTenant(g.tenant, async (c) => (await c.query(
    `SELECT s.entry_plate_pattern, s.entry_colour_code, x.plate_pattern FROM sessions s JOIN exits x ON x.session_id = s.id WHERE s.id = $1`,
    [session.id],
  )).rows[0]);
  assert.deepEqual(row, { entry_plate_pattern: null, entry_colour_code: null, plate_pattern: null });
});
