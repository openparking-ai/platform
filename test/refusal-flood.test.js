/**
 * U4 fix 2 -- REFUSED ATTEMPTS CANNOT FLOOD THE LOG (0027).
 *
 * The same refused attempt from the same source within a minute is one line,
 * counted: 10,000 attempts from one source make a bounded number of lines
 * whose counts add up to 10,000, in a garage's log and in the platform's
 * security log alike. Attempts from another source stay apart. Changes that
 * were made each keep their own line.
 *
 * The sources are told apart by address: this app trusts the loopback proxy,
 * so each request names its address in X-Forwarded-For.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import pg from 'pg';
import { pool } from './helpers.js';
import { sourceKey } from '../src/changes.js';
import { owner, call, newGarage, newLane, linesOf } from './u4-world.js';

const WINDOW_MS = 60_000;
const SOURCE_A = '203.0.113.7';
const SOURCE_B = '198.51.100.9';

let server;
let base;
let a;

before(async () => {
  process.env.TRUST_PROXY = 'loopback';
  const world = await import('./u4-world.js');
  ({ server, base } = await world.startServer());
  delete process.env.TRUST_PROXY;
  a = await owner(base, 'flood');
});

after(async () => {
  agent.destroy();
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

// Kept-alive connections: ten thousand fresh ones run a computer out of local ports.
const agent = new Agent({ keepAlive: true, maxSockets: 32 });

/** One request with no credential from `address`; resolves to the status. */
function send(method, path, body, address) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(`${base}/api/v1${path}`, {
      method, agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-forwarded-for': address },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** `count` of the same request from `address`, `width` at a time. */
async function hammer(count, address, send, width = 32) {
  let sent = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: width }, async () => {
    while (sent < count) {
      sent += 1;
      await send(address);
    }
  }));
  return Date.now() - started;
}

const bound = (ms) => Math.ceil(ms / WINDOW_MS) + 1;

test('10,000 refused attempts from one source: a bounded number of lines, counting 10,000; another source stays apart', async () => {
  const g = await newGarage(base, a);
  const lane = await newLane(base, a, g.id, 'Hammered lane', 'entry');
  const attempt = (address) => send('PATCH', `/lanes/${lane.id}`, { name: 'Taken' }, address).then((status) => assert.equal(status, 401));
  const ms = await hammer(10_000, SOURCE_A, attempt);
  await hammer(200, SOURCE_B, attempt, 8);
  const refused = (await linesOf(a.tenant)).filter((l) => l.outcome === 'refused' && l.subject_id === lane.id);
  const fromA = refused.filter((l) => l.source_key === sourceKey(SOURCE_A));
  const fromB = refused.filter((l) => l.source_key === sourceKey(SOURCE_B));
  assert.equal(fromA.length + fromB.length, refused.length, 'every line is one source or the other');
  assert.equal(fromA.reduce((n, l) => n + l.attempts, 0), 10_000);
  assert.ok(fromA.length <= bound(ms), `${fromA.length} lines for 10,000 attempts in ${ms} ms, at most ${bound(ms)}`);
  assert.equal(fromB.reduce((n, l) => n + l.attempts, 0), 200);
  assert.ok(fromB.length >= 1 && fromB.length <= bound(ms));
  for (const l of [...fromA, ...fromB]) {
    assert.ok(l.last_at >= l.at && l.last_at - l.at < WINDOW_MS, 'the count stays inside its window');
    assert.deepEqual([l.actor_kind, l.action, l.refusal], ['nobody', 'lane.rename', 'not_signed_in']);
  }
});

test("the platform's security log is bounded the same way", async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const since = new Date();
    const ms = await hammer(2_000, SOURCE_A, (address) =>
      send('POST', '/garages', { name: 'Nobody', timezone: 'UTC', currency: 'USD' }, address).then((status) => assert.equal(status, 401)));
    const rows = (await client.query('SELECT attempts, source_key FROM platform_security_log WHERE at >= $1 AND request = $2', [since, 'POST /api/v1/garages'])).rows;
    const mine = rows.filter((r) => r.source_key === sourceKey(SOURCE_A));
    assert.equal(mine.reduce((n, r) => n + r.attempts, 0), 2_000);
    assert.ok(mine.length <= bound(ms), `${mine.length} rows for 2,000 attempts`);
  } finally {
    await client.end();
  }
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
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
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
