/**
 * U4 checks 2, 3, 5 and 7: lane setup and closing, your garage only, history
 * never lost, and the drivers answer never taken back.
 *
 *   2  YOUR GARAGE ONLY. Every new route: another owner's garage, lane or
 *      computer is not found and nothing changes; no session is 401; a write
 *      with a foreign or missing Origin is refused. Ids come from the session
 *      and the path only: a body naming another tenant or garage is ignored.
 *   3  HISTORY IS NEVER LOST. A lane that ever had a stay, a computer, a card
 *      reader or an event is refused by name and stays.
 *   5  CLOSING. Both reasons kept with their message, who and when; the last
 *      open lane of a direction is refused without the override and taken
 *      with it; reopening is kept the same way; /lane/rules carries it.
 *   7  THE DRIVERS ANSWER. Saved, changeable, never taken back to unanswered.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startServer, owner, call, newGarage, newLane, FOREIGN_ORIGIN } from './u4-world.js';

let server;
let base;
let a;
let b;

before(async () => {
  ({ server, base } = await startServer());
  a = await owner(base, 'lanes-a');
  b = await owner(base, 'lanes-b');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

const laneRow = (tenant, laneId) =>
  withTenant(tenant, async (c) => (await c.query('SELECT * FROM lanes WHERE id = $1', [laneId])).rows[0] ?? null);

/** Everything a lane write could touch, for "nothing changed". */
const snapshot = (tenant) =>
  withTenant(tenant, async (c) => JSON.stringify([
    (await c.query('SELECT * FROM lanes ORDER BY id')).rows,
    (await c.query('SELECT * FROM garages ORDER BY id')).rows,
    (await c.query('SELECT id, revoked_at FROM lane_devices ORDER BY id')).rows,
  ]));

async function garageWithLanes(as = a) {
  const g = await newGarage(base, as);
  const entry = await newLane(base, as, g.id, 'North entrance', 'entry');
  const exit = await newLane(base, as, g.id, 'North exit', 'exit');
  return { g, entry, exit };
}

// --- rename ------------------------------------------------------------------------------

test('rename: the new name is kept; an empty, too long or control-character name is refused by name', async () => {
  const { entry } = await garageWithLanes();
  const r = await call(base, 'PATCH', `/lanes/${entry.id}`, { as: a, body: { name: '  Main gate  ' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.lane.name, 'Main gate');
  assert.equal((await laneRow(a.tenant, entry.id)).name, 'Main gate');
  for (const name of ['', '   ', 'x'.repeat(81), 'Gate\u0007A', 42, null]) {
    const no = await call(base, 'PATCH', `/lanes/${entry.id}`, { as: a, body: { name } });
    assert.deepEqual([no.status, no.json?.code], [400, 'lane_name_refused'], JSON.stringify(name));
  }
  assert.equal((await laneRow(a.tenant, entry.id)).name, 'Main gate');
  const extra = await call(base, 'PATCH', `/lanes/${entry.id}`, { as: a, body: { name: 'X', direction: 'exit' } });
  assert.equal(extra.status, 400, 'a lane changes its name here and nothing else');
});

// --- check 3: history is never lost ---------------------------------------------------

test('remove: a lane that was never used goes; one with a stay, a computer, a card reader or an event is refused by name and stays', async () => {
  const { g } = await garageWithLanes();
  const spare = await newLane(base, a, g.id, 'Spare', 'entry');
  const gone = await call(base, 'DELETE', `/lanes/${spare.id}`, { as: a });
  assert.equal(gone.status, 204, gone.text);
  assert.equal(await laneRow(a.tenant, spare.id), null);

  const used = {};
  for (const kind of ['stay', 'computer', 'reader', 'event', 'cancelled computer']) {
    const lane = await newLane(base, a, g.id, `Used by ${kind}`, kind === 'stay' ? 'entry' : 'exit');
    used[kind] = lane.id;
    await withTenant(a.tenant, async (c) => {
      if (kind === 'stay') {
        await c.query(
          `WITH v AS (INSERT INTO vehicles (tenant_id, plate) VALUES ($1, 'U4-' || gen_random_uuid()) RETURNING id)
           INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency, open_event_id, entry_confirmation)
           SELECT $1, $2, v.id, $3, now(), 'USD', gen_random_uuid()::text, 'confirmed' FROM v`, [a.tenant, g.id, lane.id]);
      } else if (kind === 'computer' || kind === 'cancelled computer') {
        await c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash, revoked_at) VALUES ($1,$2,'pi',$3, ${kind === 'computer' ? 'NULL' : 'now()'})`,
          [a.tenant, lane.id, hashToken(generateDeviceToken())]);
      } else if (kind === 'reader') {
        await c.query(
          `INSERT INTO lane_readers (tenant_id, garage_id, lane_id, account_id, location_id, reader_id, label, bound_by)
           VALUES ($1,$2,$3,'acct_stubU4','tml_stubU4', 'tmr_u4' || replace(gen_random_uuid()::text, '-', ''),'R','test')`, [a.tenant, g.id, lane.id]);
        await c.query(`UPDATE lane_readers SET unbound_at = now(), unbound_by = 'test' WHERE lane_id = $1`, [lane.id]);
      } else {
        await c.query(`INSERT INTO events (tenant_id, garage_id, lane_id, event_id, kind, occurred_at, detail) VALUES ($1,$2,$3,gen_random_uuid()::text,'loop_tripped',now(),'{}')`,
          [a.tenant, g.id, lane.id]);
      }
    });
  }
  for (const [kind, laneId] of Object.entries(used)) {
    const before = await snapshot(a.tenant);
    const r = await call(base, 'DELETE', `/lanes/${laneId}`, { as: a });
    assert.deepEqual([r.status, r.json?.code], [409, 'lane_has_history'], `${kind}: ${r.text}`);
    assert.match(r.json.error, /cannot be removed/);
    assert.ok(await laneRow(a.tenant, laneId), `${kind}: the lane is still there`);
    assert.equal(await snapshot(a.tenant), before, `${kind}: nothing changed`);
  }
  const stay = await call(base, 'DELETE', `/lanes/${used.stay}`, { as: a });
  assert.deepEqual(stay.json.details, { stays: 1, computers: 0, card_readers: 0, events: 0 });
});

// --- check 5: closing -------------------------------------------------------------------

test('close and reopen: both reasons kept with the message, who and when; reopening kept the same way; the lane payload carries it', async () => {
  const { g, entry } = await garageWithLanes();
  await newLane(base, a, g.id, 'South entrance', 'entry');
  const full = await call(base, 'POST', `/lanes/${entry.id}/close`, { as: a, body: { reason: 'full', message: 'Garage full. Monthly parkers may enter.' } });
  assert.equal(full.status, 200, full.text);
  let row = await laneRow(a.tenant, entry.id);
  assert.deepEqual([row.closed_reason, row.closed_message, row.closed_by], ['full', 'Garage full. Monthly parkers may enter.', `owner:${a.email}`]);
  assert.ok(row.closed_at);

  const lanes = (await call(base, 'GET', `/garages/${g.id}/lanes`, { as: a })).json.lanes;
  const shown = lanes.find((l) => l.id === entry.id);
  assert.deepEqual([shown.closed.reason, shown.closed.message, shown.closed.by], ['full', 'Garage full. Monthly parkers may enter.', { kind: 'owner', name: a.email }]);

  // The lane's own payload: what U4c's lane will act on.
  const token = generateDeviceToken();
  await withTenant(a.tenant, (c) => c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,'pi',$3)`, [a.tenant, entry.id, hashToken(token)]));
  const rules = await fetch(`${base}/api/v1/lane/rules`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  assert.deepEqual([rules.lane.state, rules.lane.reason, rules.lane.message], ['closed', 'full', 'Garage full. Monthly parkers may enter.']);

  const everyone = await call(base, 'POST', `/lanes/${entry.id}/close`, { as: a, via: 'key', body: { reason: 'everyone', message: 'Cerrado por obras.' } });
  assert.equal(everyone.status, 200, everyone.text);
  row = await laneRow(a.tenant, entry.id);
  assert.deepEqual([row.closed_reason, row.closed_message, row.closed_by], ['everyone', 'Cerrado por obras.', 'key:Front desk key']);

  const reopened = await call(base, 'POST', `/lanes/${entry.id}/reopen`, { as: a });
  assert.equal(reopened.status, 200, reopened.text);
  row = await laneRow(a.tenant, entry.id);
  assert.deepEqual([row.closed_reason, row.closed_message, row.closed_by, row.closed_at, row.reopened_by], [null, null, null, null, `owner:${a.email}`]);
  assert.ok(row.reopened_at);
  const after = await fetch(`${base}/api/v1/lane/rules`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  assert.deepEqual(after.lane, { state: 'open', reason: null, message: null, closed_at: null });

  const again = await call(base, 'POST', `/lanes/${entry.id}/reopen`, { as: a });
  assert.deepEqual([again.status, again.json.code], [409, 'lane_already_open']);
});

test('close: an unknown reason, an empty or overlong message, or an override that is not true is refused by name, and nothing changes', async () => {
  const { g, entry } = await garageWithLanes();
  await newLane(base, a, g.id, 'Second way in', 'entry');
  const cases = [
    [{ reason: 'night', message: 'x' }, 'lane_reason_refused'],
    [{ reason: 'full', message: '' }, 'lane_message_refused'],
    [{ reason: 'full', message: 'x'.repeat(161) }, 'lane_message_refused'],
    [{ reason: 'full', message: 'Closed\u0000' }, 'lane_message_refused'],
    [{ reason: 'full', message: 'Closed', override: 'yes' }, 'lane_override_refused'],
  ];
  for (const [body, code] of cases) {
    const before = await snapshot(a.tenant);
    const r = await call(base, 'POST', `/lanes/${entry.id}/close`, { as: a, body });
    assert.deepEqual([r.status, r.json?.code], [400, code], JSON.stringify(body));
    assert.equal(await snapshot(a.tenant), before);
  }
});

test('the last open lane of a direction: refused with a warning that names it, and taken with the override', async () => {
  const { g, entry, exit } = await garageWithLanes();
  const second = await newLane(base, a, g.id, 'Second exit', 'exit');
  // Two ways out: the first closes freely.
  assert.equal((await call(base, 'POST', `/lanes/${exit.id}/close`, { as: a, body: { reason: 'everyone', message: 'Closed tonight.' } })).status, 200);
  // The second is now the last way out.
  const before = await snapshot(a.tenant);
  const refused = await call(base, 'POST', `/lanes/${second.id}/close`, { as: a, body: { reason: 'everyone', message: 'Closed tonight.' } });
  assert.deepEqual([refused.status, refused.json.code, refused.json.details], [409, 'last_open_lane', { direction: 'exit' }]);
  assert.match(refused.json.error, /last open way out/);
  assert.equal(await snapshot(a.tenant), before, 'nothing changed');
  const taken = await call(base, 'POST', `/lanes/${second.id}/close`, { as: a, body: { reason: 'everyone', message: 'Closed tonight.', override: true } });
  assert.equal(taken.status, 200, taken.text);
  assert.equal((await laneRow(a.tenant, second.id)).closed_reason, 'everyone');
  // The only way in, the same.
  const inRefused = await call(base, 'POST', `/lanes/${entry.id}/close`, { as: a, body: { reason: 'full', message: 'Full.' } });
  assert.deepEqual([inRefused.status, inRefused.json.code, inRefused.json.details], [409, 'last_open_lane', { direction: 'entry' }]);
  assert.match(inRefused.json.error, /last open way in/);
  // A closed lane closed again changes its reason and message, and is not the last-lane question.
  const reclose = await call(base, 'POST', `/lanes/${second.id}/close`, { as: a, body: { reason: 'full', message: 'Full now.' } });
  assert.equal(reclose.status, 200, reclose.text);
});

// --- check 2: your garage only -----------------------------------------------------------

test("YOUR GARAGE ONLY: another owner's garage, lane or computer is not found, by session and by key, and nothing changes", async () => {
  const theirs = await garageWithLanes(b);
  const token = generateDeviceToken();
  const device = await withTenant(b.tenant, async (c) => (await c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,'pi',$3) RETURNING id`, [b.tenant, theirs.entry.id, hashToken(token)])).rows[0].id);
  const routes = [
    ['GET', `/garages/${theirs.g.id}/setup`],
    ['GET', `/garages/${theirs.g.id}/changes`],
    ['PATCH', `/lanes/${theirs.entry.id}`, { name: 'Mine now' }],
    ['DELETE', `/lanes/${theirs.exit.id}`],
    ['POST', `/lanes/${theirs.entry.id}/close`, { reason: 'everyone', message: 'Closed', override: true }],
    ['POST', `/lanes/${theirs.entry.id}/reopen`],
    ['POST', `/lanes/${theirs.entry.id}/devices`, { name: 'my pi' }],
    ['POST', `/devices/${device}/revoke`],
    ['PATCH', `/garages/${theirs.g.id}`, { transient_available: true }],
    ['POST', `/garages/${theirs.g.id}/lanes`, { name: 'Mine', direction: 'entry' }],
  ];
  const before = await snapshot(b.tenant);
  for (const [method, path, body] of routes) {
    for (const via of ['session', 'key']) {
      const r = await call(base, method, path, { as: a, via, body });
      assert.equal(r.status, 404, `${method} ${path} by ${via}: ${r.text}`);
    }
  }
  assert.equal(await snapshot(b.tenant), before, 'nothing of the other owner changed');
});

test('YOUR GARAGE ONLY: ids come from the session and the path; a body naming another tenant, garage or lane is not read', async () => {
  const mine = await garageWithLanes(a);
  const theirs = await garageWithLanes(b);
  const smuggled = { tenant_id: b.tenant, tenantId: b.tenant, garage_id: theirs.g.id, garageId: theirs.g.id, lane_id: theirs.entry.id, laneId: theirs.entry.id };
  const beforeB = await snapshot(b.tenant);
  // Each of these is refused for its unknown fields or applies to the path's lane only.
  await call(base, 'PATCH', `/lanes/${mine.entry.id}`, { as: a, body: { name: 'Renamed', ...smuggled } });
  await call(base, 'POST', `/lanes/${mine.entry.id}/close`, { as: a, body: { reason: 'everyone', message: 'Closed', override: true, ...smuggled } });
  await call(base, 'POST', `/lanes/${mine.exit.id}/reopen`, { as: a, body: smuggled });
  const extra = await call(base, 'POST', `/garages/${mine.g.id}/lanes`, { as: a, body: { name: 'Extra', direction: 'entry', ...smuggled } });
  assert.equal(extra.status, 201);
  assert.equal(extra.json.lane.garage_id, mine.g.id, "the path's garage, not the body's");
  assert.equal(extra.json.lane.tenant_id, a.tenant, "the session's tenant, not the body's");
  // And straight at their lane, with their tenant in the body: refused, as
  // an unknown field or as not found, and never applied.
  const r = await call(base, 'PATCH', `/lanes/${theirs.entry.id}`, { as: a, body: { name: 'Taken', ...smuggled } });
  assert.ok([400, 404].includes(r.status), r.text);
  const plain = await call(base, 'PATCH', `/lanes/${theirs.entry.id}`, { as: a, body: { name: 'Taken' } });
  assert.equal(plain.status, 404);
  const s = await call(base, 'GET', `/garages/${theirs.g.id}/setup?tenant_id=${b.tenant}`, { as: a });
  assert.equal(s.status, 404);
  assert.equal(await snapshot(b.tenant), beforeB, 'nothing of the other owner changed');
});

test('YOUR GARAGE ONLY: no session is 401; a write with a foreign Origin or none is refused, and nothing changes', async () => {
  const { g, entry, exit } = await garageWithLanes();
  await newLane(base, a, g.id, 'Second way in', 'entry');
  const writes = [
    ['PATCH', `/lanes/${entry.id}`, { name: 'Gate' }],
    ['DELETE', `/lanes/${exit.id}`],
    ['POST', `/lanes/${entry.id}/close`, { reason: 'full', message: 'Full' }],
    ['POST', `/lanes/${entry.id}/reopen`],
  ];
  const before = await snapshot(a.tenant);
  for (const [method, path, body] of writes) {
    assert.equal((await call(base, method, path, { body })).status, 401, `${method} ${path} with no session`);
    for (const origin of [FOREIGN_ORIGIN, null]) {
      const r = await call(base, method, path, { as: a, body, origin });
      assert.deepEqual([r.status, r.json?.code], [403, 'origin_refused'], `${method} ${path} origin ${origin}`);
    }
  }
  for (const path of [`/garages/${g.id}/setup`, `/garages/${g.id}/changes`]) assert.equal((await call(base, 'GET', path)).status, 401);
  assert.equal(await snapshot(a.tenant), before);
});

// --- check 7: the drivers answer ----------------------------------------------------------

test('the drivers answer: saved, changed, and never taken back to unanswered -- by the route or by the database', async () => {
  const g = await newGarage(base, a);
  const row = () => withTenant(a.tenant, async (c) => (await c.query('SELECT transient_available FROM garages WHERE id = $1', [g.id])).rows[0].transient_available);
  assert.equal(await row(), null);
  assert.equal((await call(base, 'PATCH', `/garages/${g.id}`, { as: a, body: { transient_available: true } })).status, 200);
  assert.equal(await row(), true);
  assert.equal((await call(base, 'PATCH', `/garages/${g.id}`, { as: a, body: { transient_available: false } })).status, 200);
  assert.equal(await row(), false);
  for (const value of [null, 'unanswered', 0]) {
    const r = await call(base, 'PATCH', `/garages/${g.id}`, { as: a, body: { transient_available: value } });
    assert.equal(r.status, 400, JSON.stringify(value));
  }
  assert.equal(await row(), false);
  await assert.rejects(withTenant(a.tenant, (c) => c.query('UPDATE garages SET transient_available = NULL WHERE id = $1', [g.id])));
  assert.equal(await row(), false);
});
