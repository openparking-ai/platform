/**
 * U4 fix round, finding 1 -- NOBODY CAN BURY AN OWNER'S REAL CHANGES (0028).
 *
 *   - A refused attempt with no working sign-in or key goes to the platform's
 *     security log only, whatever garage or id it names: 2,000 of them from
 *     one sender, every one naming a different id -- and as many again naming
 *     the owner's real garage -- make no line in the owner's log.
 *   - The bound is per SOURCE, across every route and id: one source makes at
 *     most REFUSED_PER_MINUTE lines a minute in a log, and one more line
 *     carries the count of the rest. The counts add up to every attempt.
 *     Two sources stay apart.
 *   - A signed-in caller is bounded the same way, in its own log and in the
 *     log of another account's garage it aims at.
 *   - The owner's real changes are on top of the changes page whatever was
 *     refused; every real change keeps its own line.
 *
 * Unsigned senders are told apart by address: this app trusts the loopback
 * proxy, so each request names its address in X-Forwarded-For. Each test
 * uses addresses of its own, because a source's minute spans tests.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Agent, request } from 'node:http';
import pg from 'pg';
import { pool } from './helpers.js';
import { sourceKey } from '../src/changes.js';
import { owner, call, newGarage, newLane, linesOf } from './u4-world.js';

const WINDOW_MS = 60_000;
export const REFUSED_PER_MINUTE = 20;

let server;
let base;
let a;
let b;

before(async () => {
  process.env.TRUST_PROXY = 'loopback';
  const world = await import('./u4-world.js');
  ({ server, base } = await world.startServer());
  delete process.env.TRUST_PROXY;
  a = await owner(base, 'flood-a');
  b = await owner(base, 'flood-b');
});

after(async () => {
  agent.destroy();
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

// Kept-alive connections: thousands of fresh ones run a computer out of local ports.
const agent = new Agent({ keepAlive: true, maxSockets: 32 });

/** One request from `address`, with a key when one is given; resolves to the status. */
function send(method, path, body, address, key = null) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-forwarded-for': address };
    if (key) headers.authorization = `Bearer ${key}`;
    const req = request(`${base}/api/v1${path}`, { method, agent, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** `count` requests, each made by `make(i)`, `width` at a time. */
async function hammer(count, make, width = 32) {
  let sent = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: width }, async () => {
    while (sent < count) {
      const i = sent;
      sent += 1;
      await make(i);
    }
  }));
  return Date.now() - started;
}

/** The most lines one source may make in a log over `ms`: a minute's worth, and its overflow line, per minute it spans. */
const bound = (ms) => (Math.ceil(ms / WINDOW_MS) + 1) * (REFUSED_PER_MINUTE + 1);

const owner_ = () => new pg.Client({ connectionString: process.env.DATABASE_URL });
async function securityFrom(address, since) {
  const client = owner_();
  await client.connect();
  try {
    return (await client.query('SELECT * FROM platform_security_log WHERE source_key = $1 AND at >= $2', [sourceKey(address), since])).rows;
  } finally {
    await client.end();
  }
}

test("2,000 refused requests from one unsigned sender, each naming a different id, and 2,000 naming the owner's real garage: none in the owner's log, a bounded number in the security log counting every one; the owner's changes on top", async () => {
  const SOURCE = '203.0.113.7';
  const OTHER = '198.51.100.9';
  const g = await newGarage(base, a);
  const lane = await newLane(base, a, g.id, 'Hammered lane', 'entry');
  const linesBefore = (await linesOf(a.tenant)).length;
  const since = new Date();
  const ms = await hammer(2_000, () => send('POST', `/lanes/${randomUUID()}/close`, { reason: 'full', message: 'x' }, SOURCE).then((s) => assert.equal(s, 401)))
    + await hammer(2_000, (i) => send('PATCH', i % 2 ? `/garages/${g.id}/x${i}` : `/lanes/${lane.id}`, { name: `Taken ${i}` }, SOURCE).then((s) => assert.ok(s === 401 || s === 404, String(s))));
  await hammer(200, () => send('POST', `/lanes/${randomUUID()}/close`, {}, OTHER), 8);

  assert.equal((await linesOf(a.tenant)).length, linesBefore, "a refused attempt with no sign-in reached the owner's log");
  const mine = await securityFrom(SOURCE, since);
  assert.equal(mine.reduce((n, r) => n + r.attempts, 0), 4_000, 'every attempt is counted');
  assert.ok(mine.length <= bound(ms), `${mine.length} lines for 4,000 attempts in ${ms} ms; at most ${bound(ms)}`);
  assert.ok(mine.some((r) => r.refusal === 'too_many_refused' && r.attempts > 1), 'one line carries the rest');
  const theirs = await securityFrom(OTHER, since);
  assert.equal(theirs.reduce((n, r) => n + r.attempts, 0), 200, 'another source stays apart');

  // The owner's real change, made after the flood, is the first thing on the changes page.
  assert.equal((await call(base, 'PATCH', `/lanes/${lane.id}`, { as: a, body: { name: 'After the flood' } })).status, 200);
  const page = (await call(base, 'GET', `/garages/${g.id}/changes`, { as: a })).json.changes;
  assert.deepEqual([page[0].action, page[0].after], ['lane.rename', { name: 'After the flood' }]);
  assert.ok(page.every((c) => c.outcome === 'done'));
});

test("a signed-in caller's refused attempts are bounded the same way: in its own log across every id, and in another account's garage it aims at", async () => {
  const SOURCE = '203.0.113.8';
  const theirs = await newGarage(base, b);
  // More of b's lanes than a minute's lines: each a different id to aim at.
  const lanes = [];
  for (let i = 0; i < REFUSED_PER_MINUTE + 10; i += 1) lanes.push(await newLane(base, b, theirs.id, `Their lane ${i}`, 'entry'));
  const sinceA = new Set((await linesOf(a.tenant)).map((l) => l.id));
  const sinceB = new Set((await linesOf(b.tenant)).map((l) => l.id));
  // a's key: 1,000 ids that are no one's, and 1,000 attempts on b's real lanes, round the thirty of them.
  const ms = await hammer(1_000, () => send('POST', `/lanes/${randomUUID()}/close`, { reason: 'full', message: 'x' }, SOURCE, a.key).then((s) => assert.equal(s, 404)))
    + await hammer(1_000, (i) => send('PATCH', `/lanes/${lanes[i % lanes.length].id}`, { name: 'Mine now' }, SOURCE, a.key).then((s) => assert.equal(s, 404)));
  const inA = (await linesOf(a.tenant)).filter((l) => !sinceA.has(l.id));
  const inB = (await linesOf(b.tenant)).filter((l) => !sinceB.has(l.id));
  assert.equal(inA.reduce((n, l) => n + l.attempts, 0), 2_000, "every attempt counted in the caller's own log");
  assert.ok(inA.length <= bound(ms), `${inA.length} lines in the caller's log`);
  assert.ok(inA.every((l) => l.actor_kind === 'key' && l.actor_name === 'Front desk key' && l.garage_id === null));
  assert.equal(inB.reduce((n, l) => n + l.attempts, 0), 1_000, "every attempt counted in the aimed-at garage's log");
  assert.ok(inB.length <= bound(ms), `${inB.length} lines in the other account's log`);
  assert.ok(inB.every((l) => l.actor_kind === 'outside' && l.actor_name === null && l.garage_id === theirs.id));
});

test('the same refused attempt repeated is still one line, counted', async () => {
  const SOURCE = '203.0.113.9';
  const since = new Date();
  await hammer(500, () => send('POST', '/garages', { name: 'Nobody', timezone: 'UTC', currency: 'USD' }, SOURCE).then((s) => assert.equal(s, 401)));
  const rows = await securityFrom(SOURCE, since);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].attempts, rows[0].refusal, rows[0].request], [500, 'not_signed_in', 'POST /api/v1/garages']);
});

test('every real change still writes its own line', async () => {
  const g = await newGarage(base, a);
  const lane = await newLane(base, a, g.id, 'Renamed often', 'entry');
  const before = (await linesOf(a.tenant)).length;
  for (let i = 0; i < 50; i += 1) assert.equal((await call(base, 'PATCH', `/lanes/${lane.id}`, { as: a, body: { name: `Name ${i}` } })).status, 200);
  const added = (await linesOf(a.tenant)).slice(before);
  assert.equal(added.length, 50);
  assert.ok(added.every((l) => l.outcome === 'done' && l.attempts === 1 && l.last_at === null));
});

test('the count is the only change a line allows, and only on a refused line, for the owner of the table too', async () => {
  const client = owner_();
  await client.connect();
  try {
    const lines = await linesOf(a.tenant);
    const refused = lines.find((l) => l.outcome === 'refused');
    const done = lines.find((l) => l.outcome === 'done');
    for (const [sql, params] of [
      ['UPDATE garage_changes SET attempts = attempts + 1, last_at = clock_timestamp() WHERE id = $1', [done.id]],
      ['UPDATE garage_changes SET attempts = 1 WHERE id = $1', [refused.id]],
      ["UPDATE garage_changes SET attempts = attempts + 1, last_at = clock_timestamp(), refusal = 'edited' WHERE id = $1", [refused.id]],
      ['DELETE FROM garage_changes WHERE id = $1', [refused.id]],
    ]) await assert.rejects(client.query(sql, params), /append-only/, sql);
  } finally {
    await client.end();
  }
});
