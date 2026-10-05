/**
 * U4 fix round, finding 2 -- NO CHANGE RACES.
 *
 * Every U4 route that checks something and then writes is sent in pairs, at
 * the same moment, thirty times: closing (the last two ways out, and an entry
 * with an exit), closing one lane twice, reopening, removing, removing while
 * a computer is connected, connecting, the drivers answer, and renaming while
 * closing. No pair may end in an internal error, every answer must be one of
 * the right ones, and the last way in or out is never closed without the
 * override.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant } from './helpers.js';
import { startServer, owner, call, newGarage, newLane, linesOf, secrets } from './u4-world.js';

const PAIRS = 30;

let server;
let base;
let a;

before(async () => {
  ({ server, base } = await startServer());
  a = await owner(base, 'races');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

const key = (method, path, body) => call(base, method, path, { as: a, via: 'key', body });
const pair = (x, y) => Promise.all([x(), y()]);
const statuses = (rs) => rs.map((r) => r.status).sort((p, q) => p - q);
const laneRow = (laneId) => withTenant(a.tenant, async (c) => (await c.query('SELECT * FROM lanes WHERE id = $1', [laneId])).rows[0] ?? null);

/** Tally of status pairs, with any 5xx named. */
function tally() {
  const seen = {};
  return {
    add(rs) {
      const k = statuses(rs).join('+');
      seen[k] = (seen[k] ?? 0) + 1;
      for (const r of rs) assert.ok(r.status < 500, `an internal error in a race: ${r.status} ${r.text}`);
    },
    seen,
  };
}

test('NO CHANGE RACES: the last two ways out closed at once -- one is closed, the other gets the warning; never both, never an error', async () => {
  const g = await newGarage(base, a);
  await newLane(base, a, g.id, 'Way in', 'entry');
  const x = await newLane(base, a, g.id, 'West exit', 'exit');
  const y = await newLane(base, a, g.id, 'East exit', 'exit');
  const t = tally();
  for (let i = 0; i < PAIRS; i += 1) {
    const rs = await pair(
      () => key('POST', `/lanes/${x.id}/close`, { reason: 'everyone', message: 'Closed' }),
      () => key('POST', `/lanes/${y.id}/close`, { reason: 'everyone', message: 'Closed' }),
    );
    t.add(rs);
    assert.deepEqual(statuses(rs), [200, 409], `round ${i}`);
    assert.equal(rs.find((r) => r.status === 409).json.code, 'last_open_lane');
    const closed = [(await laneRow(x.id)).closed_reason, (await laneRow(y.id)).closed_reason].filter(Boolean);
    assert.equal(closed.length, 1, 'never both ways out closed without the override');
    for (const l of [x, y]) if ((await laneRow(l.id)).closed_reason) assert.equal((await key('POST', `/lanes/${l.id}/reopen`)).status, 200);
  }
  assert.deepEqual(t.seen, { '200+409': PAIRS });
});

test('NO CHANGE RACES: an entry and an exit closed at once, each with the override -- both closed, never an error', async () => {
  const g = await newGarage(base, a);
  const x = await newLane(base, a, g.id, 'Only in', 'entry');
  const y = await newLane(base, a, g.id, 'Only out', 'exit');
  const t = tally();
  for (let i = 0; i < PAIRS; i += 1) {
    const rs = await pair(
      () => key('POST', `/lanes/${x.id}/close`, { reason: 'everyone', message: 'Night', override: true }),
      () => key('POST', `/lanes/${y.id}/close`, { reason: 'everyone', message: 'Night', override: true }),
    );
    t.add(rs);
    assert.deepEqual(statuses(rs), [200, 200]);
    for (const l of [x, y]) assert.equal((await key('POST', `/lanes/${l.id}/reopen`)).status, 200);
  }
  assert.deepEqual(t.seen, { '200+200': PAIRS });
});

test('NO CHANGE RACES: one lane closed twice at once, then reopened twice at once -- one reopen answers "already open"', async () => {
  const g = await newGarage(base, a);
  const x = await newLane(base, a, g.id, 'North in', 'entry');
  await newLane(base, a, g.id, 'South in', 'entry');
  const closes = tally();
  const reopens = tally();
  for (let i = 0; i < PAIRS; i += 1) {
    const c = await pair(
      () => key('POST', `/lanes/${x.id}/close`, { reason: 'full', message: 'Full' }),
      () => key('POST', `/lanes/${x.id}/close`, { reason: 'full', message: 'Full' }),
    );
    closes.add(c);
    const r = await pair(() => key('POST', `/lanes/${x.id}/reopen`), () => key('POST', `/lanes/${x.id}/reopen`));
    reopens.add(r);
    assert.deepEqual(statuses(r), [200, 409]);
    assert.equal(r.find((q) => q.status === 409).json.code, 'lane_already_open');
  }
  assert.deepEqual([closes.seen, reopens.seen], [{ '200+200': PAIRS }, { '200+409': PAIRS }]);
  // Each round closed once and reopened once: a second close that changed nothing wrote nothing.
  const mine = (await linesOf(a.tenant)).filter((l) => l.subject_id === x.id && l.outcome === 'done');
  assert.equal(mine.filter((l) => l.action === 'lane.close').length, PAIRS);
  assert.equal(mine.filter((l) => l.action === 'lane.reopen').length, PAIRS);
  assert.equal(mine.filter((l) => l.action === 'lane.close_again').length, 0);
});

test('NO CHANGE RACES: an unused lane removed twice at once -- one goes, the other is not found', async () => {
  const g = await newGarage(base, a);
  const t = tally();
  for (let i = 0; i < PAIRS; i += 1) {
    const x = await newLane(base, a, g.id, `Spare ${i}`, 'exit');
    const rs = await pair(() => key('DELETE', `/lanes/${x.id}`), () => key('DELETE', `/lanes/${x.id}`));
    t.add(rs);
    assert.deepEqual(statuses(rs), [204, 404]);
    assert.equal(await laneRow(x.id), null);
  }
  assert.deepEqual(t.seen, { '204+404': PAIRS });
});

test('NO CHANGE RACES: a lane removed while a computer is connected to it -- one wins, the other is refused by name; never a computer on no lane', async () => {
  const g = await newGarage(base, a);
  const t = tally();
  for (let i = 0; i < PAIRS; i += 1) {
    const x = await newLane(base, a, g.id, `Contested ${i}`, 'entry');
    const rs = await pair(() => key('DELETE', `/lanes/${x.id}`), () => key('POST', `/lanes/${x.id}/devices`, { name: `Pi ${i}` }));
    for (const r of rs) if (r.json?.token) secrets.add(r.json.token);
    t.add(rs);
    const [removed, connected] = rs;
    const ok = (removed.status === 204 && connected.status === 404)
      || (removed.status === 409 && removed.json.code === 'lane_has_history' && connected.status === 201);
    assert.ok(ok, `round ${i}: remove ${removed.status} ${removed.text}, connect ${connected.status} ${connected.text}`);
    const lane = await laneRow(x.id);
    assert.equal(lane === null, removed.status === 204);
  }
  for (const k of Object.keys(t.seen)) assert.ok(['201+409', '204+404'].includes(k), k);
});

test('NO CHANGE RACES: two computers connected to one lane at once -- both connected', async () => {
  const g = await newGarage(base, a);
  const x = await newLane(base, a, g.id, 'Busy lane', 'entry');
  const t = tally();
  for (let i = 0; i < PAIRS; i += 1) {
    const rs = await pair(
      () => key('POST', `/lanes/${x.id}/devices`, { name: `First ${i}` }),
      () => key('POST', `/lanes/${x.id}/devices`, { name: `Second ${i}` }),
    );
    for (const r of rs) if (r.json?.token) secrets.add(r.json.token);
    t.add(rs);
    assert.deepEqual(statuses(rs), [201, 201]);
  }
  assert.deepEqual(t.seen, { '201+201': PAIRS });
});

test('NO CHANGE RACES: the drivers answer given two ways at once -- both kept in turn, and the log says each change as it happened', async () => {
  const g = await newGarage(base, a);
  const t = tally();
  for (let i = 0; i < PAIRS; i += 1) {
    const rs = await pair(
      () => key('PATCH', `/garages/${g.id}`, { transient_available: true }),
      () => key('PATCH', `/garages/${g.id}`, { transient_available: false }),
    );
    t.add(rs);
    assert.deepEqual(statuses(rs), [200, 200]);
  }
  assert.deepEqual(t.seen, { '200+200': PAIRS });
  // The lines read as one history: each one's before is the one before's after.
  const lines = (await linesOf(a.tenant)).filter((l) => l.garage_id === g.id && l.action === 'garage.update');
  assert.ok(lines.length >= PAIRS, `${lines.length} lines`);
  for (let i = 1; i < lines.length; i += 1) {
    assert.deepEqual(lines[i].before, lines[i - 1].after, `line ${i} does not follow the one before`);
    assert.notDeepEqual(lines[i].before, lines[i].after, 'a line that changed nothing');
  }
  const final = await withTenant(a.tenant, async (c) => (await c.query('SELECT transient_available FROM garages WHERE id = $1', [g.id])).rows[0]);
  assert.deepEqual({ transient_available: final.transient_available }, lines.at(-1).after);
});

test('NO CHANGE RACES: a lane renamed while it is closed -- both kept, never an error', async () => {
  const g = await newGarage(base, a);
  const x = await newLane(base, a, g.id, 'Name 0', 'entry');
  await newLane(base, a, g.id, 'Other in', 'entry');
  const t = tally();
  for (let i = 0; i < PAIRS; i += 1) {
    const rs = await pair(
      () => key('PATCH', `/lanes/${x.id}`, { name: `Name ${i + 1}` }),
      () => key('POST', `/lanes/${x.id}/close`, { reason: 'full', message: `Full ${i}` }),
    );
    t.add(rs);
    assert.deepEqual(statuses(rs), [200, 200]);
    assert.equal((await key('POST', `/lanes/${x.id}/reopen`)).status, 200);
  }
  assert.deepEqual(t.seen, { '200+200': PAIRS });
});
