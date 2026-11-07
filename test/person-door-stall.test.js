/**
 * A stalled database, a flood and a held row at the trusted server's door
 * (src/personDoor.js, src/boundedDatabase.js).
 *
 * THE STALL IS REAL: a TCP proxy between the door and Postgres that goes silent
 * -- no error, no close, nothing -- as a network does. Only the door's
 * connections go through it, the way only the door's would stall in the test
 * that matters: the shared pool beside it must not notice.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { createApp } from '../src/app.js';
import { pool, createTenant, superuserClient } from './helpers.js';
import { createAdmin } from '../src/adminAccount.js';
import * as signIn from '../src/signIn.js';
import { boundedDatabase, DatabaseDidNotAnswer, internals as databaseInternals, LIMITS, LOCK_BUSY } from '../src/boundedDatabase.js';
import { DEADLINE_MS, PATHS, PLACES } from '../src/personDoor.js';
import { FORGOT_SENT } from '../src/accountDoors.js';
import { DATABASE_UNAVAILABLE } from '../src/db.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const KEY = `tsk_${randomBytes(32).toString('base64url')}`;
const KEY_SHA256 = createHash('sha256').update(KEY).digest('hex');
const PASSWORD = 'correct horse battery staple';
const WRONG = 'incorrect horse battery staple';
const FLOOR_MS = 200;
const AUTH = '/api/v1/auth';
// What a slow test machine may add to a stated bound.
const MARGIN_MS = 1000;

let su;
const printed = [];
const real = { log: console.log, error: console.error, warn: console.warn };

/** Forwards to Postgres until told not to; then swallows every byte both ways and closes nothing. */
function silentProxy(target) {
  let silent = false;
  const pairs = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    pairs.add(client).add(upstream);
    client.on('data', (d) => { if (!silent) upstream.write(d); });
    upstream.on('data', (d) => { if (!silent) client.write(d); });
    const end = () => { client.destroy(); upstream.destroy(); pairs.delete(client); pairs.delete(upstream); };
    for (const s of [client, upstream]) {
      s.on('close', end);
      s.on('error', end);
    }
  });
  return {
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    silence: () => { silent = true; },
    speak: () => { silent = false; },
    close: () => { for (const s of pairs) s.destroy(); server.close(); },
  };
}

const servers = [];
async function serve(env = {}) {
  const all = { ADMIN_ORIGIN, SIGN_IN_REFUSAL_FLOOR_MS: String(FLOOR_MS), TRUSTED_SERVER_KEY_SHA256: KEY_SHA256, ...env };
  const saved = {};
  for (const [k, v] of Object.entries(all)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  let app;
  try {
    app = createApp();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

let proxy;
let base;
let n = 0;
const address = () => { n += 1; return `203.0.113.${(n % 250) + 1}`; };
const unique = (tag) => `${tag}-${randomBytes(5).toString('hex')}@example.com`;

async function admin(tag) {
  const tenant = await createTenant(tag);
  const email = unique(tag);
  const user = await createAdmin({ tenantId: tenant, email, password: PASSWORD });
  return { tenant, email, id: user.id };
}

async function send(at, path, body) {
  const started = performance.now();
  const res = await fetch(`${at}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, took: performance.now() - started };
}
const check = (at, email, password, clientAddress) => send(at, `${AUTH}${PATHS.password}`, { email, password, clientAddress });
const who = (at, person) => send(at, `${AUTH}${PATHS.check}`, { personId: person.id, tenantId: person.tenant });
const forgot = (at, email, clientAddress) => send(at, `${AUTH}${PATHS.forgot}`, { email, clientAddress });

/** Traffic that has nothing to do with the door: the health check and the dashboard's sign-in, on the shared pool. */
async function othersFine(at, person) {
  const started = performance.now();
  const health = await fetch(`${at}/healthz`);
  assert.equal(health.status, 200);
  const res = await fetch(`${at}${AUTH}/sign-in`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN }, body: JSON.stringify({ email: person.email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return performance.now() - started;
}

const eventually = async (attempt, { within = 5000 } = {}) => {
  const until = performance.now() + within;
  for (;;) {
    const r = await attempt();
    if (r.status === 200 || performance.now() > until) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
};

before(async () => {
  console.log = (...a) => { printed.push(a.join(' ')); };
  console.error = (...a) => { printed.push(a.join(' ')); };
  su = superuserClient();
  await su.connect();
  const target = new URL(process.env.APP_DATABASE_URL);
  proxy = silentProxy({ host: target.hostname, port: Number(target.port || 5432) });
  const port = await proxy.listen();
  const through = new URL(process.env.APP_DATABASE_URL);
  through.hostname = '127.0.0.1';
  through.port = String(port);
  databaseInternals.connectionString = () => through.toString();
  base = await serve({ SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000', ACCOUNT_LINK_ATTEMPTS_PER_ADDRESS: '1000' });
});

beforeEach(() => proxy.speak());

after(async () => {
  Object.assign(console, real);
  for (const s of servers) s.close();
  proxy.close();
  await su.end();
  await pool.end();
});

const assertStalled = (r, bound) => {
  assert.equal(r.status, 503, r.text);
  assert.equal(r.text, JSON.stringify(DATABASE_UNAVAILABLE));
  assert.equal(r.headers.get('retry-after'), '2');
  assert.ok(r.took <= bound + MARGIN_MS, `answered in ${Math.round(r.took)} ms, past the bound of ${bound}`);
};

test('A SILENT NETWORK, WITH CONNECTIONS ALREADY OPEN: all three answer 503 within their bound, and the door reopens alone', async () => {
  const a = await admin('stall-open');
  assert.equal((await who(base, a)).status, 200);
  assert.equal((await check(base, a.email, PASSWORD, address())).status, 200);

  proxy.silence();
  const [password, byId, reset] = await Promise.all([check(base, a.email, PASSWORD, address()), who(base, a), forgot(base, a.email, address())]);
  assertStalled(password, DEADLINE_MS.password);
  assertStalled(byId, DEADLINE_MS.check);
  assertStalled(reset, DEADLINE_MS.forgot);
  // The stall took no one else down.
  assert.ok(await othersFine(base, a) < 2000);

  proxy.speak();
  assert.equal((await eventually(() => who(base, a))).status, 200, 'the check by id came back with no restart');
  assert.equal((await eventually(() => check(base, a.email, PASSWORD, address()))).status, 200, 'and the password check');
  assert.equal((await eventually(() => forgot(base, unique('stall-back'), address()))).status, 200, 'and forgot');
});

test('A SILENT NETWORK, ON A NEW CONNECTION: it never opens, the same 503', async () => {
  const proxied = await serve({ SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000' }); // its own pool, nothing open yet
  const a = await admin('stall-new');
  proxy.silence();
  assertStalled(await who(proxied, a), Math.min(DEADLINE_MS.check, LIMITS.connectMs));
  proxy.speak();
  assert.equal((await eventually(() => who(proxied, a))).status, 200);
});

test('A STALL NEVER KEEPS A PLACE: a call turned away waits for nothing, and when the stall ends every place is back', async () => {
  const a = await admin('stall-places');
  assert.equal((await who(base, a)).status, 200);
  proxy.silence();
  const stuck = Array.from({ length: PLACES.check }, () => who(base, a));
  await new Promise((r) => setTimeout(r, 100));
  const turnedAway = await who(base, a);
  assert.equal(turnedAway.status, 503);
  assert.equal(turnedAway.text, JSON.stringify(signIn.BUSY));
  assert.equal(turnedAway.headers.get('retry-after'), '2');
  assert.ok(turnedAway.took < 500, `waited ${Math.round(turnedAway.took)} ms`);
  for (const r of await Promise.all(stuck)) assertStalled(r, DEADLINE_MS.check);
  proxy.speak();
  await eventually(() => who(base, a));
  const again = await Promise.all(Array.from({ length: PLACES.check }, () => who(base, a)));
  for (const r of again) assert.equal(r.status, 200);
});

test('THE SHARED POOL NEVER SEES THE DOOR: a stall leaves it as it was, and a flood of the door takes nothing from it', async () => {
  const a = await admin('stall-pool');
  const before1 = { total: pool.totalCount, waiting: pool.waitingCount };
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? who(base, a) : check(base, unique('stall-flood'), WRONG, address()))));
  assert.ok(pool.totalCount <= before1.total + 1, 'the door did not borrow from the shared pool');
  assert.equal(pool.waitingCount, 0);
  proxy.silence();
  const stuck = Promise.all([who(base, a), check(base, a.email, WRONG, address()), forgot(base, a.email, address())]);
  const slowest = [];
  for (let i = 0; i < 5; i += 1) slowest.push(await othersFine(base, a));
  await stuck;
  assert.ok(Math.max(...slowest) < 2000, `the dashboard took ${Math.round(Math.max(...slowest))} ms`);
});

test('PLACES ARE APART: a flood of passwords leaves the check by id and forgot; a flood of forgot leaves the other two', async () => {
  const a = await admin('apart');
  const passwords = await Promise.all(Array.from({ length: 12 }, () => check(base, unique('apart-flood'), WRONG, address())).concat([who(base, a), forgot(base, unique('apart-f'), address())]));
  const reset = passwords.pop();
  const byId = passwords.pop();
  assert.equal(byId.status, 200, 'the check by id, under a flood of passwords');
  assert.equal(reset.status, 200, 'forgot, under a flood of passwords');
  assert.equal(passwords.filter((r) => r.status === 401).length, PLACES.password, 'exactly the places were answered');
  for (const r of passwords.filter((x) => x.status !== 401)) {
    assert.equal(r.status, 503);
    assert.equal(r.text, JSON.stringify(signIn.BUSY));
    assert.equal(r.headers.get('retry-after'), '2');
  }
  const forgots = await Promise.all(Array.from({ length: 12 }, () => forgot(base, unique('apart-flood'), address())).concat([who(base, a), check(base, a.email, PASSWORD, address())]));
  const password = forgots.pop();
  const byId2 = forgots.pop();
  assert.equal(password.status, 200);
  assert.equal(byId2.status, 200);
  assert.equal(forgots.filter((r) => r.status === 200).length, PLACES.forgot);
  // A check by id is not held to any floor, so these cannot fill its places for long.
  const reads = await Promise.all(Array.from({ length: 12 }, () => who(base, a)));
  for (const r of reads) assert.ok([200, 503].includes(r.status));
  assert.ok(reads.filter((r) => r.status === 200).length >= PLACES.check);
});

test('A PLACE IS HELD TO THE FLOOR: its hash long done, the next call is still turned away, so the door hashes its places per floor at most', async () => {
  const slow = await serve({ SIGN_IN_REFUSAL_FLOOR_MS: '1000', SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000' });
  let hashes = 0;
  const real1 = signIn.internals.verifyPassword;
  signIn.internals.verifyPassword = async (p, s) => {
    hashes += 1;
    return real1(p, s);
  };
  try {
    const first = [check(slow, unique('floor-flood'), WRONG, address()), check(slow, unique('floor-flood'), WRONG, address())];
    await new Promise((r) => setTimeout(r, 600)); // both hashes are done; their floors are not
    const third = await check(slow, unique('floor-flood'), WRONG, address());
    assert.equal(third.text, JSON.stringify(signIn.BUSY));
    assert.equal(hashes, PLACES.password);
    for (const r of await Promise.all(first)) assert.equal(r.status, 401);
  } finally {
    signIn.internals.verifyPassword = real1;
  }
});

test('THE HASH LINE IS SIGN-IN\'S: with the line full the door is turned away, and it holds a place there as it hashes', async () => {
  const short = await serve({ SIGN_IN_HASH_LINE: '1', SIGN_IN_HASH_LINE_PER_ADDRESS: '1', SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000' });
  const rs = await Promise.all([check(short, unique('line'), WRONG, address()), check(short, unique('line'), WRONG, address())]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [401, 503]);
});

test('A HASH THAT OUTLIVES THE DEADLINE: 503 in time, and its place stays taken until it ends', async () => {
  const a = await admin('slow-hash');
  const real1 = signIn.internals.verifyPassword;
  let finish;
  signIn.internals.verifyPassword = () => new Promise((r) => { finish = () => r(false); });
  try {
    const stuck = check(base, a.email, PASSWORD, address());
    const beside = await check(base, a.email, PASSWORD, address()); // the second place: its hash never ends either
    assert.equal(beside.status, 503);
    const r = await stuck;
    assertStalled(r, DEADLINE_MS.password);
    const third = await check(base, a.email, PASSWORD, address());
    assert.equal(third.text, JSON.stringify(signIn.BUSY), 'the two hashes still run, so their places are taken');
    finish();
  } finally {
    signIn.internals.verifyPassword = real1;
  }
});

test('A ROW HELD BY SOMETHING ELSE IS NOT ON THE WIRE: the one refusal, or forgot\'s one sentence, at about the floor, and no link', async () => {
  const a = await admin('held');
  const hold = superuserClient();
  await hold.connect();
  try {
    await hold.query('BEGIN');
    await hold.query('SELECT 1 FROM operator_users WHERE id = $1 FOR UPDATE', [a.id]);
    const right = await check(base, a.email, PASSWORD, address());
    assert.equal(right.status, 401);
    assert.equal(right.text, JSON.stringify(signIn.REFUSED));
    assert.ok(right.took <= FLOOR_MS + LIMITS.lockMs + MARGIN_MS, `answered in ${Math.round(right.took)} ms`);

    const asked = await forgot(base, a.email, address());
    assert.equal(asked.status, 200);
    assert.equal(asked.text, JSON.stringify(FORGOT_SENT));
    assert.ok(asked.took <= FLOOR_MS + LIMITS.lockMs + MARGIN_MS, `answered in ${Math.round(asked.took)} ms`);

    const wrong = await check(base, a.email, WRONG, address());
    assert.equal(wrong.status, 401, 'a wrong password meets the row too, at its failure write');
    await hold.query('ROLLBACK');
    const { rows } = await su.query('SELECT count(*)::int AS n FROM operator_password_resets WHERE tenant_id = $1', [a.tenant]);
    assert.equal(rows[0].n, 0, 'no link was made');
    assert.equal((await check(base, a.email, PASSWORD, address())).status, 200, 'and once the row is free, the first try passes');
  } finally {
    await hold.end();
  }
});

test('THE PASSWORD CHANGED WHILE IT WAS CHECKED: the one refusal, uncounted, as at sign-in', async () => {
  const a = await admin('changed');
  const real1 = signIn.internals.verifyPassword;
  signIn.internals.verifyPassword = async (p, s) => {
    const out = await real1(p, s);
    await su.query(`UPDATE operator_users SET password_hash = 'scrypt$changed' WHERE id = $1`, [a.id]);
    return out;
  };
  try {
    const r = await check(base, a.email, PASSWORD, address());
    assert.equal(r.status, 401);
    assert.equal(r.text, JSON.stringify(signIn.REFUSED));
  } finally {
    signIn.internals.verifyPassword = real1;
  }
  const { rows } = await su.query('SELECT count(*)::int AS n FROM operator_sign_in_locks WHERE tenant_id = $1', [a.tenant]);
  assert.equal(rows[0].n, 0);
});

test('THE DOOR\'S CONNECTIONS CARRY THEIR LIMITS, and Postgres holds them to it', async () => {
  const db = boundedDatabase({ connections: 1 });
  try {
    const show = async (name) => (await db.forRequest(2000).query(`SHOW ${name}`)).rows[0][name];
    assert.equal(await show('statement_timeout'), `${LIMITS.statementMs / 1000}s`);
    assert.equal(await show('lock_timeout'), `${LIMITS.lockMs}ms`);
    assert.equal(await show('idle_in_transaction_session_timeout'), `${LIMITS.idleInTransactionMs / 1000}s`);

    const started = performance.now();
    await assert.rejects(db.forRequest(5000).query('SELECT pg_sleep(30)'), (err) => err instanceof DatabaseDidNotAnswer && err.code === '57014');
    assert.ok(performance.now() - started < LIMITS.statementMs + MARGIN_MS);
    assert.equal((await db.forRequest(2000).query('SELECT 1 AS one')).rows[0].one, 1, 'and the next call has a fresh connection');
  } finally {
    await db.close();
  }
});

test('THE DEADLINE IS THE WHOLE CALL\'S: statements add up, and nothing starts once the time is gone', async () => {
  const db = boundedDatabase({ connections: 2 });
  const tenant = await createTenant('deadline');
  try {
    const call = db.forRequest(300);
    const started = performance.now();
    await assert.rejects(
      call.inTenant(tenant, async (c) => { await c.query('SELECT pg_sleep(0.1)'); await c.query('SELECT pg_sleep(0.1)'); await c.query('SELECT pg_sleep(0.5)'); }),
      DatabaseDidNotAnswer,
    );
    assert.ok(performance.now() - started < 300 + MARGIN_MS);
    await assert.rejects(call.query('SELECT 1'), DatabaseDidNotAnswer, 'nothing starts once the time is gone');
  } finally {
    await db.close();
  }
});

test('A REAL ERROR IS NOT A STALL: it comes through as itself, and a lock not got keeps its code', async () => {
  const db = boundedDatabase({ connections: 1 });
  const a = await admin('errors');
  const hold = superuserClient();
  await hold.connect();
  try {
    await assert.rejects(db.forRequest(2000).query('SELECT no_such_column FROM operator_users'), (err) => err.code === '42703');
    await hold.query('BEGIN');
    await hold.query('SELECT 1 FROM operator_users WHERE id = $1 FOR UPDATE', [a.id]);
    await assert.rejects(
      db.forRequest(2000).inTenant(a.tenant, (c) => c.query('SELECT 1 FROM operator_users WHERE id = $1 FOR UPDATE', [a.id])),
      (err) => err.code === LOCK_BUSY && !(err instanceof DatabaseDidNotAnswer),
    );
    await hold.query('ROLLBACK');
  } finally {
    await hold.end();
    await db.close();
  }
});

test('A FAILURE IS LOGGED BY ITS CLASS AND CODE: no email, password or key in any line', () => {
  for (const line of printed) {
    assert.equal(line.includes(PASSWORD), false);
    assert.equal(line.includes(WRONG), false);
    assert.equal(line.includes(KEY), false);
    assert.equal(/@example\.com/.test(line), false);
  }
  assert.ok(printed.some((l) => l.includes('[auth] person check: the database did not answer')), 'the stall was said');
  assert.ok(printed.some((l) => l.includes('[auth] person check: a row was held')), 'the held row was said');
});
