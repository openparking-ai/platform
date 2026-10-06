/**
 * U4c, the platform's half: a closed lane the lane can act on, and the board.
 *
 *   7   FULL IS A WAY IN'S REASON. `full` on an exit is refused by name, by
 *       the route and by the database, and nothing changes.
 *   9   ONLY CHARACTERS THE SCREEN CAN DRAW. A closed lane's message and a
 *       board message with a character outside the screen's font, once
 *       upper-cased, are refused naming every such character; the list is
 *       served to the owner's screens.
 *   4   FAST. The fast read (`/lane/stays`, full set and delta) carries the
 *       lane's state and its board, so a close reaches the lane on it.
 *   13  A MESSAGE SHOWS ONLY ON ITS LANES (the platform's half): a lane's
 *       payload holds only its own messages, not ended ones, with instants
 *       turned from the garage's own time; the lane decides what is in force.
 *   B2  Add, change, remove; your garage only; every write in the change log
 *       (change-log.test.js holds the line for each).
 *   B3  The price switch travels to its lane and to no other.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { SCREEN_CHARACTERS } from '../src/screenText.js';
import { MESSAGES_MAX } from '../src/board.js';
import { startServer, owner, call, newGarage, newLane } from './u4-world.js';

let server;
let base;
let a;
let b;

before(async () => {
  ({ server, base } = await startServer());
  a = await owner(base, 'board-a');
  b = await owner(base, 'board-b');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

/** A lane computer's code for a lane, so the lane's own reads can be made. */
async function laneToken(tenant, laneId) {
  const token = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,'pi',$3)`, [tenant, laneId, hashToken(token)]));
  return token;
}

const laneGet = (token, path) => fetch(`${base}/api/v1/lane${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());

const snapshot = (tenant) =>
  withTenant(tenant, async (c) => JSON.stringify([
    (await c.query('SELECT * FROM lanes ORDER BY id')).rows,
    (await c.query('SELECT * FROM board_messages ORDER BY id')).rows,
    (await c.query('SELECT * FROM board_message_lanes ORDER BY id')).rows,
  ]));

async function world(as = a) {
  const g = await newGarage(base, as);
  const entry = await newLane(base, as, g.id, 'North entrance', 'entry');
  const entry2 = await newLane(base, as, g.id, 'South entrance', 'entry');
  const exit = await newLane(base, as, g.id, 'North exit', 'exit');
  const exit2 = await newLane(base, as, g.id, 'South exit', 'exit');
  return { g, entry, entry2, exit, exit2 };
}

// --- check 7 -----------------------------------------------------------------------------

test('FULL IS A WAY IN: full on a way out is refused by name and nothing changes; everyone closes it; the database holds the same', async () => {
  const { exit, entry } = await world();
  const before = await snapshot(a.tenant);
  for (const via of ['session', 'key']) {
    const r = await call(base, 'POST', `/lanes/${exit.id}/close`, { as: a, via, body: { reason: 'full', message: 'Garage is full.' } });
    assert.deepEqual([r.status, r.json.code], [400, 'lane_reason_refused'], r.text);
    assert.match(r.json.error, /full is for a way in/);
  }
  assert.equal(await snapshot(a.tenant), before, 'nothing changed');
  // A way in takes it, and a way out takes everyone.
  assert.equal((await call(base, 'POST', `/lanes/${entry.id}/close`, { as: a, body: { reason: 'full', message: 'Garage is full. Monthly parkers only.' } })).status, 200);
  assert.equal((await call(base, 'POST', `/lanes/${exit.id}/close`, { as: a, body: { reason: 'everyone', message: 'Closed tonight.' } })).status, 200);
  // The database refuses it from any writer, the route bypassed.
  await assert.rejects(
    withTenant(a.tenant, (c) => c.query("UPDATE lanes SET closed_reason = 'full' WHERE id = $1", [exit.id])),
    /lanes_full_is_a_way_in/,
  );
  // And nothing stored says otherwise.
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM lanes WHERE closed_reason = 'full' AND direction <> 'entry'");
  assert.equal(rows[0].n, 0, 'a stored full way out');
});

// --- check 9 -----------------------------------------------------------------------------

test('ONLY CHARACTERS THE SCREEN CAN DRAW: a closed message or a board message with one the screen lacks is refused naming each; the screen\'s own are taken in any case', async () => {
  const { g, entry } = await world();
  const refusedCases = [
    ['Garage full — monthly only', ['—']],
    ['Full € 10', ['€']],
    ['Straße closed', ['ß']],
    ['Full; try (later) & soon', [';', '(', ')', '&']],
    ['Lleno 🚗', ['🚗']],
  ];
  for (const [text, chars] of refusedCases) {
    const before = await snapshot(a.tenant);
    const closed = await call(base, 'POST', `/lanes/${entry.id}/close`, { as: a, body: { reason: 'full', message: text, override: true } });
    assert.deepEqual([closed.status, closed.json.code, closed.json.details], [400, 'lane_message_refused', { characters: chars }], text);
    for (const c of chars) assert.ok(closed.json.error.includes(`"${c}"`), `the refusal names ${c}: ${closed.json.error}`);
    const posted = await call(base, 'POST', `/garages/${g.id}/board-messages`, { as: a, body: { text, lanes: [entry.id] } });
    assert.deepEqual([posted.status, posted.json.code, posted.json.details], [400, 'board_text_refused', { characters: chars }], text);
    assert.equal(await snapshot(a.tenant), before, `nothing changed: ${text}`);
  }
  // Lower case, the accented letters and every character of the list are taken.
  for (const text of ['Garage is full. Monthly parkers only.', 'Estacionamiento lleno. Solo mensuales.', 'Ñandú: ¿no? Sí, señor', SCREEN_CHARACTERS.trim()]) {
    const ok = text.includes('¿') ? null : text;
    if (ok === null) {
      const r = await call(base, 'POST', `/garages/${g.id}/board-messages`, { as: a, body: { text, lanes: [entry.id] } });
      assert.deepEqual([r.status, r.json.details], [400, { characters: ['¿'] }], 'the inverted question mark is not on the screen');
      continue;
    }
    const r = await call(base, 'POST', `/garages/${g.id}/board-messages`, { as: a, body: { text: ok, lanes: [entry.id] } });
    assert.equal(r.status, 201, `${ok}: ${r.text}`);
  }
  // The list is served to the owner's screens, with the bound.
  const lanes = (await call(base, 'GET', `/garages/${g.id}/lanes`, { as: a })).json;
  assert.deepEqual(lanes.screen, { characters: SCREEN_CHARACTERS, message_max: 160 });
  const read = (await call(base, 'GET', `/garages/${g.id}/board`, { as: a })).json;
  assert.deepEqual(read.screen, { characters: SCREEN_CHARACTERS, message_max: 160 });
});

// --- check 4 and 13 ----------------------------------------------------------------------

test('FAST: the fast read carries the lane\'s state and board on the full set and on every delta, so a close reaches the lane on it', async () => {
  const { entry, entry2 } = await world();
  const token = await laneToken(a.tenant, entry.id);
  const first = await laneGet(token, '/stays');
  assert.deepEqual(first.lane, { state: 'open', reason: null, message: null, closed_at: null });
  assert.deepEqual(first.board, { prices: false, messages: [] });
  assert.equal((await call(base, 'POST', `/lanes/${entry.id}/close`, { as: a, body: { reason: 'full', message: 'Garage is full. Monthly parkers only.' } })).status, 200);
  // The delta: no stay changed, the closing is on it.
  const delta = await laneGet(token, `/stays?since=${first.cursor}`);
  assert.deepEqual(delta.changes, []);
  assert.deepEqual([delta.lane.state, delta.lane.reason, delta.lane.message], ['closed', 'full', 'Garage is full. Monthly parkers only.']);
  // The full set too, and the slow read says the same.
  const full = await laneGet(token, '/stays');
  assert.deepEqual(full.lane, delta.lane);
  assert.deepEqual((await laneGet(token, '/rules')).lane, delta.lane);
  // The other way in is open, on its own read.
  assert.equal((await laneGet(await laneToken(a.tenant, entry2.id), `/stays?since=${first.cursor}`)).lane.state, 'open');
  assert.equal((await call(base, 'POST', `/lanes/${entry.id}/reopen`, { as: a })).status, 200);
  assert.equal((await laneGet(token, `/stays?since=${first.cursor}`)).lane.state, 'open');
});

test('A MESSAGE SHOWS ONLY ON ITS LANES: a lane\'s payload holds its own messages, not another lane\'s, not an ended one; times are the garage\'s, sent as instants', async () => {
  const { g, entry, entry2, exit } = await world();
  const tokens = { entry: await laneToken(a.tenant, entry.id), entry2: await laneToken(a.tenant, entry2.id), exit: await laneToken(a.tenant, exit.id) };
  const both = (await call(base, 'POST', `/garages/${g.id}/board-messages`, { as: a, body: { text: 'Event tonight', lanes: [entry.id, exit.id], starts: '2030-01-01T08:00', ends: '2030-01-01T23:30' } })).json.message;
  const only2 = (await call(base, 'POST', `/garages/${g.id}/board-messages`, { as: a, body: { text: 'Use the south door', lanes: [entry2.id] } })).json.message;
  // The garage is in New York: 08:00 there on 1 January is 13:00 UTC.
  assert.deepEqual([both.starts, both.ends, both.starts_at, both.ends_at], ['2030-01-01T08:00', '2030-01-01T23:30', '2030-01-01T13:00:00.000Z', '2030-01-02T04:30:00.000Z']);
  const want = (m) => ({ id: m.id, text: m.text, starts_at: m.starts_at, ends_at: m.ends_at });
  for (const path of ['/rules', '/stays', '/stays?since=0']) {
    assert.deepEqual((await laneGet(tokens.entry, path)).board.messages, [want(both)], `entry ${path}`);
    assert.deepEqual((await laneGet(tokens.exit, path)).board.messages, [want(both)], `exit ${path}`);
    assert.deepEqual((await laneGet(tokens.entry2, path)).board.messages, [want(only2)], `entry2 ${path}`);
  }
  // Moved off a lane: gone from that lane's read.
  assert.equal((await call(base, 'PATCH', `/garages/${g.id}/board-messages/${both.id}`, { as: a, body: { lanes: [exit.id] } })).status, 200);
  assert.deepEqual((await laneGet(tokens.entry, '/stays')).board.messages, []);
  // An ended message is not sent: the database's clock passes its end.
  await withTenant(a.tenant, (c) => c.query("UPDATE board_messages SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 minute' WHERE id = $1", [both.id]));
  assert.deepEqual((await laneGet(tokens.exit, '/stays')).board.messages, []);
  // Another garage's lane sees none of it.
  const other = await world();
  assert.deepEqual((await laneGet(await laneToken(a.tenant, other.entry.id), '/stays')).board.messages, []);
});

// --- B2 ----------------------------------------------------------------------------------

test('MESSAGES: added, changed and removed; refused by name for no lane, a lane of another garage, a time that is not one, an end not after the start or already past, and past the most a garage holds', async () => {
  const { g, entry, exit } = await world();
  const other = await world();
  const cases = [
    [{ text: 'Hi', lanes: [] }, 'board_lanes_refused'],
    [{ text: 'Hi', lanes: [other.entry.id] }, 'board_lanes_refused'],
    [{ text: 'Hi', lanes: [entry.id, entry.id] }, 'board_lanes_refused'],
    [{ text: 'Hi', lanes: [entry.id], starts: '2030-02-30T08:00' }, 'board_time_refused'],
    [{ text: 'Hi', lanes: [entry.id], starts: '2030-01-01 08:00' }, 'board_time_refused'],
    [{ text: 'Hi', lanes: [entry.id], starts: '2030-01-01T09:00', ends: '2030-01-01T08:00' }, 'board_time_refused'],
    [{ text: 'Hi', lanes: [entry.id], ends: '2001-01-01T08:00' }, 'board_time_refused'],
    [{ text: '', lanes: [entry.id] }, 'board_text_refused'],
    [{ text: 'x'.repeat(161), lanes: [entry.id] }, 'board_text_refused'],
    [{ text: 'Hi', lanes: [entry.id], colour: 'red' }, undefined],
  ];
  for (const [body, code] of cases) {
    const before = await snapshot(a.tenant);
    const r = await call(base, 'POST', `/garages/${g.id}/board-messages`, { as: a, body });
    assert.deepEqual([r.status, r.json.code], [400, code], JSON.stringify(body));
    assert.equal(await snapshot(a.tenant), before);
  }
  const m = (await call(base, 'POST', `/garages/${g.id}/board-messages`, { as: a, via: 'key', body: { text: '  Event tonight  ', lanes: [entry.id] } })).json.message;
  assert.deepEqual([m.text, m.lanes, m.starts, m.ends], ['Event tonight', [entry.id], null, null]);
  const changed = await call(base, 'PATCH', `/garages/${g.id}/board-messages/${m.id}`, { as: a, body: { lanes: [exit.id, entry.id], ends: '2031-06-01T02:00' } });
  assert.equal(changed.status, 200, changed.text);
  assert.deepEqual([changed.json.message.lanes, changed.json.message.ends], [[entry.id, exit.id], '2031-06-01T02:00']);
  const read = (await call(base, 'GET', `/garages/${g.id}/board`, { as: a })).json;
  assert.deepEqual(read.messages.map((x) => x.id), [m.id]);
  assert.equal(read.timezone, 'America/New_York');
  assert.deepEqual(read.lanes.map((l) => [l.name, l.prices]), [['North entrance', false], ['South entrance', false], ['North exit', false], ['South exit', false]]);
  assert.equal((await call(base, 'DELETE', `/garages/${g.id}/board-messages/${m.id}`, { as: a })).status, 204);
  assert.equal((await call(base, 'DELETE', `/garages/${g.id}/board-messages/${m.id}`, { as: a })).json.code, 'board_message_not_found');
  // The most a garage holds, then one more refused by name.
  for (let i = 0; i < MESSAGES_MAX; i += 1) {
    assert.equal((await call(base, 'POST', `/garages/${g.id}/board-messages`, { as: a, via: 'key', body: { text: `Notice ${i}`, lanes: [entry.id] } })).status, 201);
  }
  const over = await call(base, 'POST', `/garages/${g.id}/board-messages`, { as: a, body: { text: 'One more', lanes: [entry.id] } });
  assert.deepEqual([over.status, over.json.code], [409, 'board_messages_full']);
  // A lane removed takes its message rows with it; the message stays, on no lane.
  const spare = await newLane(base, a, other.g.id, 'Spare', 'entry');
  const onSpare = (await call(base, 'POST', `/garages/${other.g.id}/board-messages`, { as: a, body: { text: 'Spare only', lanes: [spare.id] } })).json.message;
  assert.equal((await call(base, 'DELETE', `/lanes/${spare.id}`, { as: a })).status, 204);
  const left = (await call(base, 'GET', `/garages/${other.g.id}/board`, { as: a })).json.messages.find((x) => x.id === onSpare.id);
  assert.deepEqual(left.lanes, []);
});

test("YOUR GARAGE ONLY: another owner's garage, message or lane is not found, by session and by key, and nothing changes; the database refuses a lane of another garage", async () => {
  const mine = await world();
  const theirs = await world(b);
  const theirMessage = (await call(base, 'POST', `/garages/${theirs.g.id}/board-messages`, { as: b, body: { text: 'Theirs', lanes: [theirs.entry.id] } })).json.message;
  const beforeB = await snapshot(b.tenant);
  for (const via of ['session', 'key']) {
    const attempts = [
      ['GET', `/garages/${theirs.g.id}/board`, undefined, 'garage not found'],
      ['POST', `/garages/${theirs.g.id}/board-messages`, { text: 'Mine', lanes: [theirs.entry.id] }, 'garage not found'],
      ['PATCH', `/garages/${theirs.g.id}/board-messages/${theirMessage.id}`, { text: 'Mine' }, 'garage not found'],
      ['DELETE', `/garages/${theirs.g.id}/board-messages/${theirMessage.id}`, undefined, 'garage not found'],
      ['PATCH', `/garages/${mine.g.id}/board-messages/${theirMessage.id}`, { text: 'Mine' }, 'board message not found'],
      ['DELETE', `/garages/${mine.g.id}/board-messages/${theirMessage.id}`, undefined, 'board message not found'],
      ['PUT', `/lanes/${theirs.entry.id}/board-prices`, { show: true }, 'lane not found'],
    ];
    for (const [method, path, body, error] of attempts) {
      const r = await call(base, method, path, { as: a, via, body });
      assert.deepEqual([r.status, r.json?.error], [404, error], `${via} ${method} ${path}`);
    }
    const r = await call(base, 'POST', `/garages/${mine.g.id}/board-messages`, { as: a, via, body: { text: 'Mine', lanes: [theirs.entry.id] } });
    assert.deepEqual([r.status, r.json.code], [400, 'board_lanes_refused']);
  }
  assert.equal(await snapshot(b.tenant), beforeB, 'nothing of theirs changed');
  // The database, the route bypassed: a lane of another garage of the same account.
  const m = (await call(base, 'POST', `/garages/${mine.g.id}/board-messages`, { as: a, body: { text: 'Mine', lanes: [mine.entry.id] } })).json.message;
  const sameAccount = await world();
  await assert.rejects(
    withTenant(a.tenant, (c) => c.query('INSERT INTO board_message_lanes (tenant_id, message_id, lane_id) VALUES ($1,$2,$3)', [a.tenant, m.id, sameAccount.entry.id])),
    /a message shows only on lanes of its own garage/,
  );
});

// --- B3 ----------------------------------------------------------------------------------

test('THE PRICE SWITCH: on for one lane travels to that lane alone, on both reads; refused by name for anything but true or false', async () => {
  const { entry, entry2 } = await world();
  const t1 = await laneToken(a.tenant, entry.id);
  const t2 = await laneToken(a.tenant, entry2.id);
  for (const body of [{ show: 'yes' }, {}, { show: true, price: 5 }]) {
    const r = await call(base, 'PUT', `/lanes/${entry.id}/board-prices`, { as: a, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const on = await call(base, 'PUT', `/lanes/${entry.id}/board-prices`, { as: a, body: { show: true } });
  assert.deepEqual(on.json, { lane: { id: entry.id, prices: true } });
  for (const path of ['/rules', '/stays', '/stays?since=0']) {
    assert.equal((await laneGet(t1, path)).board.prices, true, path);
    assert.equal((await laneGet(t2, path)).board.prices, false, path);
  }
  assert.equal((await call(base, 'PUT', `/lanes/${entry.id}/board-prices`, { as: a, body: { show: false } })).status, 200);
  assert.equal((await laneGet(t1, '/stays')).board.prices, false);
});
