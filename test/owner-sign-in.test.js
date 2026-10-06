/**
 * The owner signs in (0024): the three auth routes, the cookie, the session
 * behind every operator route, and each way sign-in went wrong elsewhere,
 * held as a check.
 *
 * Every response this file receives is kept, body and Set-Cookie, and so is
 * every secret it handles -- the passwords, the session tokens, the stored
 * hashes. The last test requires no response body to hold any of them; and
 * `test/owner-sign-in-output.test.js` runs this file again with its output
 * captured and requires the output to hold none of them either.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import pg from 'pg';
import { createApp, BODY_TOO_LARGE, BODY_UNREADABLE } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { createAdmin, resetAdminPassword } from '../src/adminAccount.js';
import { hashCount, hashPassword } from '../src/passwords.js';
import * as signIn from '../src/signIn.js';
import { holdsSecret } from './secrets.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const FOREIGN_ORIGIN = 'https://elsewhere.example.test';
// Invented, and long enough for the length rule.
const PASSWORD = 'correct horse battery staple';
const WRONG = 'incorrect horse battery staple';

const secrets = new Set([PASSWORD, WRONG]);
const bodies = [];
const setCookies = [];
let admin; // the owner connection, for reading and ageing rows a test cannot reach otherwise

const servers = [];
async function serve(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
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
  return { app, base: `http://127.0.0.1:${server.address().port}` };
}

/** fetch, with every body and every Set-Cookie kept for the checks at the end. */
async function call(base, method, path, { body, raw, headers = {}, cookie, origin } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] ??= 'application/json';
  if (cookie) h.cookie = `${signIn.COOKIE}=${cookie}`;
  if (origin) h.origin = origin;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  bodies.push(text);
  const cookies = res.headers.getSetCookie();
  setCookies.push(...cookies);
  for (const c of cookies) {
    const value = c.split(';')[0].split('=').slice(1).join('=');
    if (value) secrets.add(value);
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  return { status: res.status, text, json, headers: res.headers, cookies };
}

const tokenOf = (r) => {
  const c = r.cookies.find((x) => x.startsWith(`${signIn.COOKIE}=`));
  return c ? c.split(';')[0].slice(signIn.COOKIE.length + 1) : null;
};

/** A tenant with its admin and a garage. */
async function owner(tag, email = `${tag}-${Math.random().toString(36).slice(2, 8)}@example.com`) {
  const tenant = await createTenant(tag);
  const world = await buildWorld(tenant);
  await createAdmin({ tenantId: tenant, email, password: PASSWORD });
  const { rows } = await admin.query('SELECT password_hash FROM operator_users WHERE tenant_id = $1', [tenant]);
  secrets.add(rows[0].password_hash);
  return { tenant, email, world };
}

async function signedIn(base, who, extra = {}) {
  const r = await call(base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD }, origin: ADMIN_ORIGIN, ...extra });
  assert.equal(r.status, 200, r.text);
  return tokenOf(r);
}

let main;
let trusted;
let limited;

before(async () => {
  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  // The floor at its least, so the many refusals here stay quick; THE FLOOR below holds it at a larger value.
  const quick = { SIGN_IN_REFUSAL_FLOOR_MS: '200', SESSION_COOKIE_INSECURE: undefined };
  main = await serve({ ADMIN_ORIGIN, SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000', TRUST_PROXY: undefined, ...quick });
  trusted = await serve({ ADMIN_ORIGIN, SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000', TRUST_PROXY: 'loopback', ...quick });
  limited = await serve({ ADMIN_ORIGIN, SIGN_IN_ATTEMPTS_PER_ADDRESS: '3', TRUST_PROXY: undefined, ...quick });
});

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  if (process.env.OWNER_SIGN_IN_SECRETS_OUT) {
    writeFileSync(process.env.OWNER_SIGN_IN_SECRETS_OUT, JSON.stringify([...secrets]));
  }
  await admin.end();
  await pool.end();
});

// --- the instruments first ------------------------------------------------------------

test('CONTROL: the secret finder finds a planted secret, plain, JSON-escaped and URL-encoded', () => {
  for (const planted of [`x ${PASSWORD} y`, JSON.stringify({ p: PASSWORD }), `?p=${encodeURIComponent(PASSWORD)}`]) {
    assert.equal(holdsSecret(planted, PASSWORD), true, planted);
  }
  assert.equal(holdsSecret('nothing of the sort', PASSWORD), false);
});

// --- reachable, and what a sign-in answers -----------------------------------------------

test('sign-in is mounted before the operator router: an unauthenticated sign-in reaches sign-in', async () => {
  const r = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: 'nobody@example.com', password: WRONG } });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, signIn.REFUSED, 'answered by sign-in, not by the operator router');
  assert.notEqual(r.json.error, 'operator token required');
});

test('a sign-in sets the cookie with all five properties, answers who and until when, and never the token', async () => {
  const who = await owner('si-ok');
  const r = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email.toUpperCase(), password: PASSWORD }, origin: ADMIN_ORIGIN });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.cookies.length, 1);
  const parts = r.cookies[0].split(';').map((p) => p.trim());
  const attrs = parts.slice(1).map((p) => p.split('=')[0].toLowerCase());
  assert.ok(attrs.includes('httponly'), 'HttpOnly');
  assert.ok(attrs.includes('secure'), 'Secure');
  assert.ok(parts.includes('SameSite=Strict'), 'SameSite=Strict');
  assert.ok(parts.includes('Path=/api'), 'Path=/api');
  assert.ok(!attrs.includes('domain'), 'no Domain');
  const token = tokenOf(r);
  assert.match(token, /^opl_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(r.json).sort(), ['email', 'language', 'session_ends_at', 'tenant_id']);
  assert.equal(r.json.email, who.email);
  assert.equal(r.json.tenant_id, who.tenant);
  assert.equal(r.text.includes(token), false);
  const stored = (await admin.query(`SELECT token_hash, kind, user_id FROM operator_tokens WHERE token_hash = $1`, [hashToken(token)])).rows;
  assert.equal(stored.length, 1, 'only the sha256 is stored');
  assert.equal(stored[0].kind, 'session');
  const ends = new Date(r.json.session_ends_at).getTime() - Date.now();
  assert.ok(ends > 29 * 60_000 && ends <= 30 * 60_000 + 5_000, 'the session ends 30 minutes after its last use');
});

test('the cookie authenticates every operator route, and /me says who, which tenant and when the session ends', async () => {
  const who = await owner('si-use');
  const token = await signedIn(main.base, who);
  const read = await call(main.base, 'GET', `/api/v1/garages/${who.world.garage}/activation`, { cookie: token });
  assert.equal(read.status, 200, read.text);
  const me = await call(main.base, 'GET', '/api/v1/auth/me', { cookie: token });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, who.email);
  assert.equal(me.json.tenant_id, who.tenant);
  assert.ok(new Date(me.json.session_ends_at) > new Date());
  const none = await call(main.base, 'GET', '/api/v1/auth/me');
  assert.equal(none.status, 401);
  assert.deepEqual(none.json, signIn.SIGN_IN_REQUIRED);
});

test('a session token presented as a Bearer key is not a key, and an operator key is unchanged', async () => {
  const who = await owner('si-bearer');
  const token = await signedIn(main.base, who);
  const asBearer = await call(main.base, 'GET', `/api/v1/garages/${who.world.garage}/activation`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(asBearer.status, 401);
  const key = generateDeviceToken();
  secrets.add(key);
  await withTenant(who.tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [who.tenant, hashToken(key)]));
  const asKey = await call(main.base, 'GET', `/api/v1/garages/${who.world.garage}/activation`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(asKey.status, 200);
});

// --- no oracle ----------------------------------------------------------------------------

test('NO ORACLE: unknown email, wrong password and locked address answer byte-identically, and each runs exactly one hash', async () => {
  const who = await owner('si-oracle');
  const lockedWho = await owner('si-oracle-l');
  for (let i = 0; i < signIn.MAX_FAILED; i += 1) {
    await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: lockedWho.email, password: WRONG } });
  }
  const attempt = async (email, password) => {
    const before = hashCount();
    const r = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email, password } });
    return { status: r.status, text: r.text, cookies: r.cookies, hashes: hashCount() - before };
  };
  const unknown = await attempt('nobody-at-all@example.com', PASSWORD);
  const wrong = await attempt(who.email, WRONG);
  const locked = await attempt(lockedWho.email, PASSWORD);
  for (const [name, r] of Object.entries({ unknown, wrong, locked })) {
    assert.equal(r.status, 401, name);
    assert.equal(r.text, JSON.stringify(signIn.REFUSED), name);
    assert.deepEqual(r.cookies, [], name);
    assert.equal(r.hashes, 1, `${name} ran ${r.hashes} hash(es)`);
  }
});

// --- guessing: per account AND per caller address -----------------------------------------

test('LOCKOUT: attempt 10 locks; attempt 11 with the RIGHT password is refused like any refusal; after the window it works', async () => {
  const who = await owner('si-lock');
  for (let i = 1; i <= 9; i += 1) {
    const r = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: WRONG } });
    assert.equal(r.status, 401);
  }
  const lockRow = async () => (await admin.query('SELECT failed_count, locked_until FROM operator_sign_in_locks l JOIN operator_users u ON u.id = l.user_id WHERE u.tenant_id = $1', [who.tenant])).rows;
  assert.equal((await lockRow())[0].locked_until, null, 'nine wrong passwords do not lock');
  const tenth = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: WRONG } });
  assert.equal(tenth.status, 401);
  assert.ok((await lockRow())[0].locked_until > new Date(), 'the tenth locks');
  const eleventh = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD } });
  assert.equal(eleventh.status, 401);
  assert.equal(eleventh.text, JSON.stringify(signIn.REFUSED));
  assert.deepEqual(eleventh.cookies, []);
  await admin.query(`UPDATE operator_sign_in_locks SET locked_until = now() - interval '1 second' WHERE tenant_id = $1`, [who.tenant]);
  const afterWindow = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD } });
  assert.equal(afterWindow.status, 200, 'after the window the right password signs in');
  assert.deepEqual(await lockRow(), [], 'and a sign-in clears the count');
});

test('LOCKOUT ENDS: once a lock has ended the count starts again -- one wrong password is 1, not a new lock -- and ten are needed to lock again; during a lock a wrong one still re-arms it', async () => {
  const who = await owner('si-relock');
  const wrong = () => call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: WRONG } });
  const row = async () => (await admin.query('SELECT failed_count, locked_until, locked_until > now() AS locked FROM operator_sign_in_locks WHERE tenant_id = $1', [who.tenant])).rows[0];
  for (let i = 0; i < signIn.MAX_FAILED; i += 1) assert.equal((await wrong()).status, 401);
  assert.equal((await row()).locked, true, 'ten wrong passwords lock');
  // CONTROL: a wrong password DURING the lock still counts and re-arms it, as before.
  await admin.query(`UPDATE operator_sign_in_locks SET locked_until = now() + interval '1 minute' WHERE tenant_id = $1`, [who.tenant]);
  const shortened = (await row()).locked_until;
  await wrong();
  const during = await row();
  assert.equal(during.failed_count, signIn.MAX_FAILED + 1, 'CONTROL: counted during the lock');
  assert.ok(during.locked_until > shortened, 'CONTROL: and re-armed');
  // The clock past the lock.
  await admin.query(`UPDATE operator_sign_in_locks SET locked_until = now() - interval '1 second' WHERE tenant_id = $1`, [who.tenant]);
  assert.equal((await wrong()).status, 401);
  const first = await row();
  assert.deepEqual([first.failed_count, first.locked], [1, null], 'one wrong password after the lock ended is 1, and no lock');
  for (let n = 2; n < signIn.MAX_FAILED; n += 1) await wrong();
  const nine = await row();
  assert.deepEqual([nine.failed_count, nine.locked], [signIn.MAX_FAILED - 1, null], 'nine since the lock ended do not lock');
  await wrong();
  const ten = await row();
  assert.deepEqual([ten.failed_count, ten.locked], [signIn.MAX_FAILED, true], 'the tenth since the lock ended locks again');
});

test('LOCK IS PER ADDRESS: address A locked out; address B with the right password signs in', async () => {
  const who = await owner('si-addr');
  const A = '203.0.113.10';
  const B = '203.0.113.20';
  for (let i = 0; i < signIn.MAX_FAILED; i += 1) {
    await call(trusted.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: WRONG }, headers: { 'x-forwarded-for': A } });
  }
  const fromA = await call(trusted.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD }, headers: { 'x-forwarded-for': A } });
  assert.equal(fromA.status, 401, 'A is locked out of this account');
  const fromB = await call(trusted.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD }, headers: { 'x-forwarded-for': B } });
  assert.equal(fromB.status, 200, 'B is not: knowing the email is not enough to keep the admin out');
  const rows = (await admin.query('SELECT address FROM operator_sign_in_locks WHERE tenant_id = $1', [who.tenant])).rows;
  assert.deepEqual(rows.map((r) => r.address), [A]);
});

test('NO HEADER DODGE: with no trusted proxy, a fresh X-Forwarded-For on every attempt neither resets the lock nor the attempt limit', async () => {
  const who = await owner('si-xff');
  for (let i = 0; i < signIn.MAX_FAILED; i += 1) {
    await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: WRONG }, headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } });
  }
  const right = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD }, headers: { 'x-forwarded-for': '198.51.100.200' } });
  assert.equal(right.status, 401, 'the lock is on the socket address, which a header does not change');
  const rows = (await admin.query('SELECT address FROM operator_sign_in_locks WHERE tenant_id = $1', [who.tenant])).rows;
  assert.deepEqual(rows.map((r) => r.address), ['127.0.0.1']);

  const answers = [];
  for (let i = 0; i < 5; i += 1) {
    answers.push((await call(limited.base, 'POST', '/api/v1/auth/sign-in', { body: { email: 'nobody@example.com', password: WRONG }, headers: { 'x-forwarded-for': `192.0.2.${i + 1}` } })).status);
  }
  assert.deepEqual(answers, [401, 401, 401, 429, 429], 'three attempts per address, whatever the header says');
});

test('the caller address: IPv4-mapped is IPv4, and an IPv6 address counts by its /64', () => {
  const settings = { trustProxy: null };
  const at = (remoteAddress) => signIn.callerAddress({ socket: { remoteAddress } }, settings);
  assert.equal(at('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(at('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(at('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64');
  assert.equal(at('2001:db8::1'), '2001:db8:0:0::/64');
});

// --- sessions end ------------------------------------------------------------------------

const ageSession = (token, sql) => admin.query(`UPDATE operator_tokens SET ${sql} WHERE token_hash = $1`, [hashToken(token)]);
const garageRead = (base, who, token) => call(base, 'GET', `/api/v1/garages/${who.world.garage}/activation`, { cookie: token });

test('SESSIONS END — idle: 30 minutes after its last use the next request is 401 session_ended, and presenting it again revives nothing', async () => {
  const who = await owner('si-idle');
  const token = await signedIn(main.base, who);
  await ageSession(token, `last_seen_at = now() - interval '29 minutes'`);
  assert.equal((await garageRead(main.base, who, token)).status, 200, 'inside the window, and the use slides it');
  await ageSession(token, `last_seen_at = now() - interval '31 minutes'`);
  const ended = await garageRead(main.base, who, token);
  assert.equal(ended.status, 401);
  assert.equal(ended.json.code, 'session_ended');
  assert.ok(ended.cookies.some((c) => c.startsWith(`${signIn.COOKIE}=;`) && c.includes('Max-Age=0')), 'the cookie is cleared');
  assert.equal((await garageRead(main.base, who, token)).status, 401, 'presented again, still ended');
  assert.equal((await call(main.base, 'GET', '/api/v1/auth/me', { cookie: token })).json.code, 'session_ended');
});

test('SESSIONS END — absolute: 12 hours after sign-in, however recently used', async () => {
  const who = await owner('si-abs');
  const token = await signedIn(main.base, who);
  const row = (await admin.query('SELECT expires_at - created_at AS lifetime FROM operator_tokens WHERE token_hash = $1', [hashToken(token)])).rows[0];
  assert.equal(row.lifetime.hours, 12);
  await ageSession(token, `expires_at = now() - interval '1 second', last_seen_at = now()`);
  const ended = await garageRead(main.base, who, token);
  assert.equal(ended.status, 401);
  assert.equal(ended.json.code, 'session_ended');
  assert.equal((await garageRead(main.base, who, token)).status, 401);
});

test('SESSIONS END — sign-out revokes the row; the token presented again is refused', async () => {
  const who = await owner('si-out');
  const token = await signedIn(main.base, who);
  const out = await call(main.base, 'POST', '/api/v1/auth/sign-out', { cookie: token, origin: ADMIN_ORIGIN });
  assert.equal(out.status, 204);
  assert.ok(out.cookies.some((c) => c.includes('Max-Age=0')));
  const row = (await admin.query('SELECT revoked_at FROM operator_tokens WHERE token_hash = $1', [hashToken(token)])).rows[0];
  assert.notEqual(row.revoked_at, null);
  assert.equal((await garageRead(main.base, who, token)).status, 401);
  assert.equal((await call(main.base, 'POST', '/api/v1/auth/sign-out', { cookie: token, origin: ADMIN_ORIGIN })).json.code, 'session_ended');
});

test('SESSIONS END — a password reset revokes every session of that admin and clears every lock on it', async () => {
  const who = await owner('si-reset');
  const one = await signedIn(main.base, who);
  const two = await signedIn(main.base, who);
  for (let i = 0; i < signIn.MAX_FAILED; i += 1) {
    await call(trusted.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: WRONG }, headers: { 'x-forwarded-for': '203.0.113.99' } });
  }
  const NEW = 'a brand new passphrase here';
  secrets.add(NEW);
  const done = await resetAdminPassword({ email: who.email, password: NEW });
  assert.deepEqual([done.sessions_revoked, done.locks_cleared], [2, 1]);
  secrets.add((await admin.query('SELECT password_hash FROM operator_users WHERE tenant_id = $1', [who.tenant])).rows[0].password_hash);
  assert.equal((await garageRead(main.base, who, one)).status, 401);
  assert.equal((await garageRead(main.base, who, two)).status, 401);
  const back = await call(trusted.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: NEW }, headers: { 'x-forwarded-for': '203.0.113.99' } });
  assert.equal(back.status, 200, 'the reset cleared the lock on that address');
  const old = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD } });
  assert.equal(old.status, 401, 'the old password no longer signs in');
});

test('SESSIONS END — a password changed in the database, with no session revoked, ends every session signed in before the change', async () => {
  const who = await owner('si-pwchg');
  const before = await signedIn(main.base, who);
  assert.equal((await garageRead(main.base, who, before)).status, 200);
  const NEW = 'changed straight in the database';
  secrets.add(NEW);
  const hash = await hashPassword(NEW);
  secrets.add(hash);
  // The change as SQL would make it, around the command: the hash and its time, and nothing revoked.
  await admin.query('UPDATE operator_users SET password_hash = $2, password_changed_at = now() WHERE tenant_id = $1', [who.tenant, hash]);
  const live = async () => Number((await admin.query(
    `SELECT count(*) FROM operator_tokens t JOIN operator_users u ON u.id = t.user_id WHERE u.tenant_id = $1 AND t.kind = 'session' AND t.revoked_at IS NULL`,
    [who.tenant],
  )).rows[0].count);
  assert.equal(await live(), 1, 'the session row is still unrevoked');
  const read = await garageRead(main.base, who, before);
  assert.equal(read.status, 401, 'a read with the session from before the change');
  assert.deepEqual(read.json, signIn.SESSION_ENDED);
  assert.equal((await call(main.base, 'GET', '/api/v1/auth/me', { cookie: before })).status, 401, '/me with it');
  const write = await call(main.base, 'POST', '/api/v1/garages', { cookie: before, origin: ADMIN_ORIGIN, body: { name: 'After the change', timezone: 'UTC', currency: 'USD' } });
  assert.equal(write.status, 401, 'a write with it');
  // CONTROL: a sign-in after the change, with the new password, is a session that works.
  const after = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: NEW }, origin: ADMIN_ORIGIN });
  assert.equal(after.status, 200, after.text);
  const fresh = tokenOf(after);
  assert.equal((await garageRead(main.base, who, fresh)).status, 200, 'CONTROL: a session from after the change reads');
  assert.equal((await call(main.base, 'GET', '/api/v1/auth/me', { cookie: fresh })).status, 200);
  // And the command's path still revokes, the fresh session too.
  const done = await resetAdminPassword({ email: who.email, password: PASSWORD });
  assert.equal(done.sessions_revoked, 2, 'the reset revokes both rows: the one ended by the change, and the fresh one');
  secrets.add((await admin.query('SELECT password_hash FROM operator_users WHERE tenant_id = $1', [who.tenant])).rows[0].password_hash);
  assert.equal(await live(), 0);
  assert.equal((await garageRead(main.base, who, fresh)).status, 401, 'after the reset the fresh session is refused');
});

test('SESSIONS END — the hash changed alone in the database, its time left as it was, ends every session signed in before the change', async () => {
  const who = await owner('si-hashonly');
  const before = await signedIn(main.base, who);
  const changedAt = async () => (await admin.query('SELECT password_changed_at FROM operator_users WHERE tenant_id = $1', [who.tenant])).rows[0].password_changed_at;
  // CONTROL: a change that leaves the hash alone ends nothing and moves no time.
  const at = await changedAt();
  await admin.query("UPDATE operator_users SET email = email || '' , created_at = created_at WHERE tenant_id = $1", [who.tenant]);
  assert.deepEqual(await changedAt(), at, 'a change without the hash leaves password_changed_at');
  assert.equal((await garageRead(main.base, who, before)).status, 200, 'CONTROL: and the session still reads');
  const NEW = 'only the hash was changed here';
  secrets.add(NEW);
  const hash = await hashPassword(NEW);
  secrets.add(hash);
  await admin.query('UPDATE operator_users SET password_hash = $2 WHERE tenant_id = $1', [who.tenant, hash]);
  assert.ok((await changedAt()) > at, 'the hash change moved password_changed_at');
  assert.equal((await garageRead(main.base, who, before)).status, 401, 'a read with the session from before the change');
  assert.equal((await call(main.base, 'GET', '/api/v1/auth/me', { cookie: before })).status, 401, '/me with it');
  // CONTROL: a sign-in after the change, with the new password, works.
  const after = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: NEW }, origin: ADMIN_ORIGIN });
  assert.equal(after.status, 200, after.text);
  const fresh = tokenOf(after);
  assert.equal((await call(main.base, 'GET', '/api/v1/auth/me', { cookie: fresh })).status, 200, 'CONTROL: a session from after the change');
  // A change made in a transaction OPENED BEFORE a sign-in, and run after it: the
  // session was signed in before the change, so it ends with it.
  const NEWER = 'and then changed once again';
  secrets.add(NEWER);
  const newer = await hashPassword(NEWER);
  secrets.add(newer);
  await admin.query('BEGIN');
  try {
    await admin.query('SELECT now()');
    const during = tokenOf(await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: NEW }, origin: ADMIN_ORIGIN }));
    assert.ok(during);
    await admin.query('UPDATE operator_users SET password_hash = $2 WHERE tenant_id = $1', [who.tenant, newer]);
    await admin.query('COMMIT');
    assert.equal((await call(main.base, 'GET', '/api/v1/auth/me', { cookie: during })).status, 401, 'signed in before the change ran, though after its transaction began');
  } catch (err) {
    await admin.query('ROLLBACK').catch(() => {});
    throw err;
  }
  assert.equal((await call(main.base, 'GET', '/api/v1/auth/me', { cookie: fresh })).status, 401);
});

/**
 * A sign-in whose hash check is under way when the password changes: `during`
 * runs inside the check, after the stored hash was read; `settle` once the
 * sign-in has answered. Answers what each attempt's sign-in got and whether
 * its session works afterwards.
 */
async function signInDuringChange(who, attempts, during, settle = async () => {}) {
  const realVerify = signIn.internals.verifyPassword;
  const seen = [];
  let current = PASSWORD;
  try {
    for (let i = 0; i < attempts; i += 1) {
      const next = `the password after change ${i} here`;
      secrets.add(next);
      signIn.internals.verifyPassword = async (...a) => {
        const matched = await realVerify(...a);
        await during(next, i);
        return matched;
      };
      const r = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: current }, origin: ADMIN_ORIGIN });
      signIn.internals.verifyPassword = realVerify;
      await settle();
      secrets.add((await admin.query('SELECT password_hash FROM operator_users WHERE tenant_id = $1', [who.tenant])).rows[0].password_hash);
      const token = tokenOf(r);
      const me = token ? (await call(main.base, 'GET', '/api/v1/auth/me', { cookie: token })).status : null;
      seen.push({ status: r.status, works: me === 200 });
      current = next;
    }
  } finally {
    signIn.internals.verifyPassword = realVerify;
  }
  return seen;
}

test('A SIGN-IN IN FLIGHT DURING A PASSWORD CHANGE never yields a working session: the change by SQL, committed during the hash check, 12 attempts', async () => {
  const who = await owner('si-race-sql');
  const seen = await signInDuringChange(who, 12, async (next) => {
    await admin.query('UPDATE operator_users SET password_hash = $2 WHERE tenant_id = $1', [who.tenant, await hashPassword(next)]);
  });
  assert.deepEqual(seen.filter((s) => s.works), [], `working sessions: ${JSON.stringify(seen)}`);
  assert.deepEqual(seen.map((s) => s.status), Array(12).fill(401));
});

test('A SIGN-IN IN FLIGHT DURING A PASSWORD CHANGE never yields a working session: the reset command during the hash check, 12 attempts', async () => {
  const who = await owner('si-race-reset');
  const seen = await signInDuringChange(who, 12, async (next) => {
    await resetAdminPassword({ email: who.email, password: next });
  });
  assert.deepEqual(seen.filter((s) => s.works), [], `working sessions: ${JSON.stringify(seen)}`);
  assert.deepEqual(seen.map((s) => s.status), Array(12).fill(401));
});

test('A SIGN-IN IN FLIGHT DURING A PASSWORD CHANGE: a change begun during the hash check and committed only after the sign-in has gone on to make its session holds the sign-in until it lands, then refuses it; 6 attempts', async () => {
  const who = await owner('si-race-held');
  const changer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await changer.connect();
  let committed = Promise.resolve();
  try {
    const seen = await signInDuringChange(who, 6, async (next) => {
      const hash = await hashPassword(next);
      await committed;
      await changer.query('BEGIN');
      await changer.query('UPDATE operator_users SET password_hash = $2 WHERE tenant_id = $1', [who.tenant, hash]);
      // Committed once the sign-in has had time to reach its session write.
      committed = new Promise((r) => setTimeout(r, 300)).then(() => changer.query('COMMIT'));
    }, () => committed);
    assert.deepEqual(seen.filter((s) => s.works), [], `working sessions: ${JSON.stringify(seen)}`);
    assert.deepEqual(seen.map((s) => s.status), Array(6).fill(401));
  } finally {
    await changer.query('ROLLBACK').catch(() => {});
    await changer.end();
  }
});

// --- cross-site ---------------------------------------------------------------------------

test('CROSS-SITE: a cookie-authenticated change with a foreign Origin, or none, is refused and changes nothing; from the admin site it works', async () => {
  const who = await owner('si-csrf');
  const token = await signedIn(main.base, who);
  const garages = async () => Number((await admin.query('SELECT count(*) FROM garages WHERE tenant_id = $1', [who.tenant])).rows[0].count);
  const before = await garages();
  const body = { name: 'Made cross-site', timezone: 'UTC', currency: 'USD' };
  const foreign = await call(main.base, 'POST', '/api/v1/garages', { cookie: token, origin: FOREIGN_ORIGIN, body });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.json.code, 'origin_refused');
  const none = await call(main.base, 'POST', '/api/v1/garages', { cookie: token, body });
  assert.equal(none.status, 403);
  assert.equal(await garages(), before, 'nothing was made');
  const signOutForeign = await call(main.base, 'POST', '/api/v1/auth/sign-out', { cookie: token, origin: FOREIGN_ORIGIN });
  assert.equal(signOutForeign.status, 403);
  assert.equal((await garageRead(main.base, who, token)).status, 200, 'a refused sign-out revoked nothing');
  const ours = await call(main.base, 'POST', '/api/v1/garages', { cookie: token, origin: ADMIN_ORIGIN, body });
  assert.equal(ours.status, 201, ours.text);
  assert.equal(await garages(), before + 1);
});

test('CROSS-SITE: a sign-in with a foreign Origin, or not sent as JSON, is refused', async () => {
  const who = await owner('si-login-csrf');
  const foreign = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD }, origin: FOREIGN_ORIGIN });
  assert.equal(foreign.status, 403);
  assert.deepEqual(foreign.cookies, []);
  const form = await call(main.base, 'POST', '/api/v1/auth/sign-in', {
    raw: JSON.stringify({ email: who.email, password: PASSWORD }), headers: { 'content-type': 'text/plain' },
  });
  assert.equal(form.status, 400);
  assert.deepEqual(form.json, signIn.UNREADABLE);
  assert.deepEqual(form.cookies, []);
});

/** Every route the operator and auth routers serve, from the router itself. */
function routeTable(app) {
  const out = [];
  for (const layer of app._router.stack) {
    if (layer.name !== 'router') continue;
    const source = layer.regexp.source;
    const base = source.includes('auth') ? '/api/v1/auth' : source.includes('lane') ? '/api/v1/lane' : '/api/v1';
    if (base === '/api/v1/lane') continue;
    for (const l of layer.handle.stack) {
      if (!l.route) continue;
      for (const method of Object.keys(l.route.methods)) out.push({ base, method: method.toUpperCase(), path: l.route.path });
    }
  }
  return out;
}
const concrete = (path) => path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

test('A GET never changes anything: every operator GET, cookie-authenticated from a foreign Origin, leaves the tenant\'s rows as they were', async () => {
  const who = await owner('si-get');
  const token = await signedIn(main.base, who);
  const snapshot = async () => {
    const tables = (await admin.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       ORDER BY 1`)).rows.map((r) => r.relname);
    const out = {};
    for (const t of tables) {
      const rows = (await admin.query(`SELECT * FROM ${pg.escapeIdentifier(t)} WHERE tenant_id = $1 ORDER BY 1`, [who.tenant])).rows;
      // A session's own use is recorded on its row; that is the one write a read makes.
      out[t] = rows.map((r) => (t === 'operator_tokens' ? { ...r, last_seen_at: null } : r));
    }
    return JSON.stringify(out);
  };
  const before = await snapshot();
  const gets = routeTable(main.app).filter((r) => r.method === 'GET' && r.base === '/api/v1');
  assert.ok(gets.length >= 8, `the walk found the operator reads: ${gets.length}`);
  for (const r of gets) {
    const path = r.path.replace(':garageId', who.world.garage).replace(':laneId', who.world.entryLane);
    await call(main.base, 'GET', `${r.base}${concrete(path)}`, { cookie: token, origin: FOREIGN_ORIGIN });
  }
  assert.equal(await snapshot(), before);
});

// --- no credential in a URL ---------------------------------------------------------------

test('NO CREDENTIAL IN A URL: no auth route has a path parameter, and the auth code reads no query', async () => {
  const auth = routeTable(main.app).filter((r) => r.base === '/api/v1/auth');
  assert.deepEqual(auth.map((r) => `${r.method} ${r.path}`).sort(), ['GET /me', 'POST /sign-in', 'POST /sign-out', 'PUT /language']);
  for (const r of auth) assert.equal(r.path.includes(':'), false, `${r.method} ${r.path}`);
  const source = readFileSync(new URL('../src/signIn.js', import.meta.url), 'utf8');
  assert.equal(/req\.(query|params)\b/.test(source), false, 'src/signIn.js reads req.query or req.params');
  // And behaviourally: credentials in the query sign nobody in.
  const who = await owner('si-url');
  const q = `?email=${encodeURIComponent(who.email)}&password=${encodeURIComponent(PASSWORD)}&token=x`;
  const r = await call(main.base, 'POST', `/api/v1/auth/sign-in${q}`, { headers: { 'content-type': 'application/json' }, raw: '{}' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.cookies, []);
});

// --- a body that cannot be read -----------------------------------------------------------

test('A GARBLED REQUEST DOES NOT ECHO: unreadable and wrong-shaped bodies answer the one sentence', async () => {
  const cases = [
    `{"email":"x@example.com","password":"${PASSWORD}`, // truncated JSON holding the password
    `{"email":"x@example.com","password":"${PASSWORD}",}`,
    `["x@example.com","${PASSWORD}"]`,
    `{"email":"x@example.com","password":"${PASSWORD}","extra":1}`,
    '{"email":"x@example.com","password":12345678901234}',
    '{"email":"x@example.com"}',
    '"just a string"',
    `{"email":"x@example.com","password":"${'p'.repeat(5000)}"}`, // past the body limit
  ];
  for (const raw of cases) {
    const r = await call(main.base, 'POST', '/api/v1/auth/sign-in', { raw, headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400, raw.slice(0, 40));
    assert.equal(r.text, JSON.stringify(signIn.UNREADABLE), raw.slice(0, 40));
  }
});

// --- headers ------------------------------------------------------------------------------

test('NO-STORE EVERYWHERE: every operator and auth route answers Cache-Control: no-store and nosniff, signed in or not', async () => {
  const who = await owner('si-headers');
  const token = await signedIn(main.base, who);
  const routes = routeTable(main.app);
  assert.ok(routes.length >= 25, `the walk found ${routes.length} routes`);
  const missing = [];
  for (const r of routes) {
    for (const auth of [{ cookie: token, origin: ADMIN_ORIGIN }, {}]) {
      const res = await call(main.base, r.method, `${r.base}${concrete(r.path)}`, { ...auth, ...(r.method === 'GET' ? {} : { body: {} }) });
      if (res.headers.get('cache-control') !== 'no-store' || res.headers.get('x-content-type-options') !== 'nosniff') {
        missing.push(`${r.method} ${r.base}${r.path} (${res.status})`);
      }
    }
  }
  assert.deepEqual(missing, []);
  // The sign-out above is part of the walk; the session it ended is not reused.
});

// --- a failure inside sign-in ------------------------------------------------------------

test('A FORCED 500 inside sign-in answers "internal error" and logs the failure by its class -- never its message', async () => {
  const who = await owner('si-500');
  const logged = [];
  const realError = console.error;
  const realMint = signIn.internals.mintSession;
  signIn.internals.mintSession = async () => {
    const leak = generateDeviceToken();
    secrets.add(leak);
    throw Object.assign(new Error(`could not mint for ${who.email} / ${PASSWORD} / ${leak}`), { code: 'PLANTED' });
  };
  console.error = (...a) => logged.push(a.map(String).join(' '));
  let r;
  try {
    r = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD } });
  } finally {
    console.error = realError;
    signIn.internals.mintSession = realMint;
  }
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'internal error' });
  assert.deepEqual(logged, ['[auth] sign-in failed: Error PLANTED']);
});

test('a stored hash this code does not know is refused by name, never compared, and never counted as a wrong password', async () => {
  const who = await owner('si-kdf');
  await admin.query(`UPDATE operator_users SET password_hash = 'scrypt$N=bad' WHERE tenant_id = $1`, [who.tenant]);
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  const before = hashCount();
  let r;
  try {
    r = await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD } });
  } finally {
    console.error = realError;
  }
  assert.equal(r.status, 500);
  assert.equal(hashCount() - before, 0, 'not compared');
  assert.deepEqual(logged, ['[auth] sign-in failed: PasswordHashUnrecognised']);
  assert.equal((await admin.query('SELECT count(*) FROM operator_sign_in_locks WHERE tenant_id = $1', [who.tenant])).rows[0].count, '0');
});

// --- one tenant never sees another -------------------------------------------------------

test('ONE TENANT NEVER SEES ANOTHER: A\'s session reads A, and B\'s garage answers 404', async () => {
  const a = await owner('si-iso-a');
  const b = await owner('si-iso-b');
  const token = await signedIn(main.base, a);
  assert.equal((await call(main.base, 'GET', '/api/v1/auth/me', { cookie: token })).json.tenant_id, a.tenant);
  const theirs = await call(main.base, 'GET', `/api/v1/garages/${b.world.garage}/activation`, { cookie: token });
  assert.equal(theirs.status, 404);
  assert.deepEqual(theirs.json, { error: 'garage not found' });
});

// --- the settings -------------------------------------------------------------------------

test('the settings: no admin origin means sign-in is off, by name; a malformed one refuses to start; insecure is exactly "true"', async () => {
  const off = await serve({ ADMIN_ORIGIN: undefined });
  const r = await call(off.base, 'POST', '/api/v1/auth/sign-in', { body: { email: 'x@example.com', password: PASSWORD } });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, signIn.NOT_CONFIGURED);
  assert.throws(() => signIn.readAuthSettings({ ADMIN_ORIGIN: 'https://admin.example.test/path' }), /origin/);
  assert.throws(() => signIn.readAuthSettings({ SESSION_COOKIE_INSECURE: 'yes' }), /exactly "true"/);
  assert.throws(() => signIn.readAuthSettings({ SESSION_IDLE_MINUTES: '0' }), /SESSION_IDLE_MINUTES must be a whole number from 1 to 1440/);
  assert.equal(signIn.readAuthSettings({}).cookieSecure, true, 'Secure by default');
  assert.equal(signIn.readAuthSettings({ SESSION_COOKIE_INSECURE: 'true' }).cookieSecure, false);
});

// --- no oracle, in work: the same statements, and the floor --------------------------------

/** The text of every statement any pg client runs while `fn` runs. */
async function statementsDuring(fn) {
  const seen = [];
  const real = pg.Client.prototype.query;
  pg.Client.prototype.query = function query(q, ...rest) {
    seen.push(typeof q === 'string' ? q : q?.text);
    return real.call(this, q, ...rest);
  };
  try {
    await fn();
  } finally {
    pg.Client.prototype.query = real;
  }
  return seen;
}

test('NO ORACLE, IN WORK: unknown email, wrong password and locked address run the same statements, and an unknown email makes no lock row', async () => {
  const who = await owner('si-same');
  const lockedWho = await owner('si-same-l');
  for (let i = 0; i < signIn.MAX_FAILED; i += 1) {
    await call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: lockedWho.email, password: WRONG } });
  }
  // Counted at an address of this test's own, and for this test's own users at
  // ANY address -- rows and their counts -- not over the whole table: other
  // files in the suite write lock rows while this runs, but none for these
  // users. A lock row needs a real user, so an unknown email could only ever
  // be charged to one: at the caller's address, or somewhere else. The
  // controls show each count sees a row when one is written. Each address is
  // counted before and after, never against zero: a test database that is
  // used again still holds the lock rows earlier runs wrote at these addresses.
  const locksAt = async (address) => Number((await admin.query('SELECT count(*) FROM operator_sign_in_locks WHERE address = $1', [address])).rows[0].count);
  const ownLocks = async () => (await admin.query(
    `SELECT count(*)::int AS rows, coalesce(sum(l.failed_count), 0)::int AS failed
       FROM operator_sign_in_locks l JOIN operator_users u ON u.id = l.user_id WHERE u.tenant_id = ANY($1::uuid[])`,
    [[who.tenant, lockedWho.tenant]],
  )).rows[0];
  const salt = Math.floor(Math.random() * 250) + 1;
  const [nobodyAt, controlAt] = [`203.0.113.${salt}`, `198.18.200.${salt}`];
  const ownBefore = await ownLocks();
  const [nobodyBefore, controlBefore] = [await locksAt(nobodyAt), await locksAt(controlAt)];
  await call(trusted.base, 'POST', '/api/v1/auth/sign-in', { body: { email: 'nobody-same@example.com', password: WRONG }, headers: { 'x-forwarded-for': nobodyAt } });
  assert.equal(await locksAt(nobodyAt), nobodyBefore, 'an unknown email makes no lock row');
  assert.deepEqual(await ownLocks(), ownBefore, "an unknown email is charged to none of this test's users, at any address");
  await call(trusted.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: WRONG }, headers: { 'x-forwarded-for': controlAt } });
  assert.equal(await locksAt(controlAt), controlBefore + 1, 'CONTROL: a wrong password from that kind of address makes one');
  assert.deepEqual(await ownLocks(), { rows: ownBefore.rows + 1, failed: ownBefore.failed + 1 }, "CONTROL: and this test's users' count sees it");
  const unknown = await statementsDuring(() => call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: 'nobody-same@example.com', password: WRONG } }));
  const wrong = await statementsDuring(() => call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: WRONG } }));
  const locked = await statementsDuring(() => call(main.base, 'POST', '/api/v1/auth/sign-in', { body: { email: lockedWho.email, password: PASSWORD } }));
  assert.ok(unknown.some((q) => /operator_sign_in_locks/.test(q) && /^\s*SELECT/.test(q)), 'the unknown email ran the lock lookup');
  assert.ok(unknown.some((q) => /INSERT INTO operator_sign_in_locks/.test(q)), 'and the failure write');
  assert.deepEqual(wrong, unknown, 'a wrong password runs what an unknown email runs');
  assert.deepEqual(locked, unknown, 'a locked address runs what an unknown email runs');
});

test('THE FLOOR: no sign-in refusal of any kind is answered sooner than SIGN_IN_REFUSAL_FLOOR_MS after it arrived; a sign-in is not held to it', async () => {
  const FLOOR = 900;
  const floored = await serve({
    ADMIN_ORIGIN, TRUST_PROXY: 'loopback', SIGN_IN_REFUSAL_FLOOR_MS: String(FLOOR), SIGN_IN_ATTEMPTS_PER_ADDRESS: '2',
    SIGN_IN_HASH_LINE: '1', SIGN_IN_HASH_LINE_PER_ADDRESS: '1',
  });
  const off = await serve({ ADMIN_ORIGIN: undefined, SIGN_IN_REFUSAL_FLOOR_MS: String(FLOOR) });
  const who = await owner('si-floor');
  const timed = async (base, opts) => {
    const t0 = performance.now();
    const r = await call(base, 'POST', '/api/v1/auth/sign-in', opts);
    return { ...r, ms: performance.now() - t0 };
  };
  const from = (n, extra = {}) => ({ ...extra, headers: { 'x-forwarded-for': `192.0.2.${n}`, ...(extra.headers ?? {}) } });
  const seen = {};
  seen.unknown = await timed(floored.base, from(11, { body: { email: 'nobody-floor@example.com', password: WRONG } }));
  seen.wrong = await timed(floored.base, from(12, { body: { email: who.email, password: WRONG } }));
  seen.unreadable = await timed(floored.base, from(13, { raw: '{"email":', headers: { 'content-type': 'application/json' } }));
  seen.not_gzip = await timed(floored.base, from(14, { raw: '{"email":1}', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }));
  seen.wrong_shape = await timed(floored.base, from(15, { body: { email: 'x@example.com' } }));
  seen.foreign_origin = await timed(floored.base, from(16, { body: { email: who.email, password: PASSWORD }, origin: FOREIGN_ORIGIN }));
  seen.not_configured = await timed(off.base, { body: { email: who.email, password: PASSWORD } });
  await call(floored.base, 'POST', '/api/v1/auth/sign-in', from(17, { body: { email: 'a-floor@example.com', password: WRONG } }));
  await call(floored.base, 'POST', '/api/v1/auth/sign-in', from(17, { body: { email: 'a-floor@example.com', password: WRONG } }));
  seen.rate_limited = await timed(floored.base, from(17, { body: { email: 'a-floor@example.com', password: WRONG } }));
  // The line holds one: an attempt held at its hash keeps it full while the busy one is timed.
  let release;
  const held = new Promise((r) => { release = r; });
  // Under a break a probe below can itself be held at its hash, and then it
  // is never answered: let every hash go after a while, so the test fails on
  // what the probe was answered rather than on the client's five-minute timeout.
  const letGo = setTimeout(() => release(), 30_000);
  const realVerify = signIn.internals.verifyPassword;
  signIn.internals.verifyPassword = async (...a) => {
    await held;
    return realVerify(...a);
  };
  try {
    const holding = call(floored.base, 'POST', '/api/v1/auth/sign-in', from(18, { body: { email: 'holder@example.com', password: WRONG } }));
    await new Promise((r) => setTimeout(r, 150));
    seen.busy = await timed(floored.base, from(19, { body: { email: who.email, password: PASSWORD } }));
    release();
    await holding;
  } finally {
    clearTimeout(letGo);
    signIn.internals.verifyPassword = realVerify;
  }
  const statuses = Object.fromEntries(Object.entries(seen).map(([k, r]) => [k, r.status]));
  assert.deepEqual(statuses, {
    unknown: 401, wrong: 401, unreadable: 400, not_gzip: 400, wrong_shape: 400, foreign_origin: 403, not_configured: 409, rate_limited: 429, busy: 503,
  });
  const early = Object.entries(seen).filter(([, r]) => r.ms < FLOOR - 2).map(([k, r]) => `${k} ${r.ms.toFixed(0)} ms`);
  assert.deepEqual(early, [], `answered sooner than the ${FLOOR} ms floor`);
  const ok = await timed(floored.base, from(20, { body: { email: who.email, password: PASSWORD }, origin: ADMIN_ORIGIN }));
  assert.equal(ok.status, 200);
  assert.ok(ok.ms < FLOOR, `a sign-in is not held to the floor (${ok.ms.toFixed(0)} ms)`);
});

// --- waiting: the hash line ----------------------------------------------------------------

test('the hash line: at most its length held, at most the per-address share from one address, and a place given back once', () => {
  const line = signIn.hashLine({ max: 3, perAddress: 2 });
  const a1 = line.enter('a');
  const a2 = line.enter('a');
  assert.equal(line.enter('a'), null, 'a third place for one address');
  const b1 = line.enter('b');
  assert.equal(line.enter('c'), null, 'the line is full');
  assert.equal(line.held, 3);
  a1();
  a1();
  assert.equal(line.held, 2, 'a place given back twice is given back once');
  assert.ok(line.enter('c'));
  a2();
  b1();
});

test('THE LINE: a full line answers busy before the email is looked at -- the same for every email -- and one address holds only its share', async () => {
  const lined = await serve({ ADMIN_ORIGIN, TRUST_PROXY: 'loopback', SIGN_IN_HASH_LINE: '2', SIGN_IN_HASH_LINE_PER_ADDRESS: '1', SIGN_IN_REFUSAL_FLOOR_MS: '200' });
  const who = await owner('si-line');
  let release;
  const held = new Promise((r) => { release = r; });
  // Under a break a probe below can itself be held at its hash, and then it
  // is never answered: let every hash go after a while, so the test fails on
  // what the probe was answered rather than on the client's five-minute timeout.
  const letGo = setTimeout(() => release(), 30_000);
  const realVerify = signIn.internals.verifyPassword;
  signIn.internals.verifyPassword = async (...a) => {
    await held;
    return realVerify(...a);
  };
  const at = (address, email, password = WRONG) =>
    call(lined.base, 'POST', '/api/v1/auth/sign-in', { body: { email, password }, headers: { 'x-forwarded-for': address } });
  let first;
  let second;
  const busy = [];
  try {
    first = at('198.51.100.1', 'held-one@example.com');
    await new Promise((r) => setTimeout(r, 150));
    busy.push(await at('198.51.100.1', who.email, PASSWORD)); // its address holds its one place
    second = at('198.51.100.2', 'held-two@example.com');
    await new Promise((r) => setTimeout(r, 150));
    busy.push(await at('198.51.100.3', 'nobody-line@example.com')); // the line is full
    busy.push(await at('198.51.100.4', who.email, PASSWORD));
    busy.push(await at('198.51.100.5', who.email, WRONG));
  } finally {
    clearTimeout(letGo);
    release();
    signIn.internals.verifyPassword = realVerify;
  }
  for (const r of busy) {
    assert.equal(r.status, 503);
    assert.equal(r.text, JSON.stringify(signIn.BUSY));
    assert.equal(r.headers.get('retry-after'), '2');
    assert.deepEqual(r.cookies, []);
  }
  assert.equal((await first).status, 401);
  assert.equal((await second).status, 401);
  const locks = (await admin.query('SELECT count(*) FROM operator_sign_in_locks WHERE tenant_id = $1', [who.tenant])).rows[0].count;
  assert.equal(locks, '0', 'a busy answer counted nothing against the account');
  const back = await call(lined.base, 'POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD }, origin: ADMIN_ORIGIN, headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(back.status, 200, 'with the line free, the admin signs in');
});

// --- a body that lies about itself --------------------------------------------------------

test('A BODY THAT LIES ABOUT ITS ENCODING: under /api/v1/auth any body that cannot be read is the one sentence, never a 500; a path that is not a route is 404', async () => {
  const lies = [
    { 'content-encoding': 'gzip' },
    { 'content-encoding': 'deflate' },
    { 'content-encoding': 'br' },
    { 'content-encoding': 'x-made-up' },
    { 'content-type': 'application/json; charset=koi8-r' },
  ];
  for (const headers of lies) {
    const r = await call(main.base, 'POST', '/api/v1/auth/sign-in', { raw: `{"email":"x@example.com","password":"${PASSWORD}"}`, headers: { 'content-type': 'application/json', ...headers } });
    assert.equal(r.status, 400, JSON.stringify(headers));
    assert.deepEqual(r.json, signIn.UNREADABLE, JSON.stringify(headers));
  }
  for (const path of ['/api/v1/auth/nope', '/api/v1/auth/sign-in/more', '/api/v1/auth/']) {
    for (const headers of [{}, { 'content-encoding': 'gzip' }]) {
      const r = await call(main.base, 'POST', path, { raw: 'not gzip, not json', headers: { 'content-type': 'application/json', ...headers } });
      assert.equal(r.status, 404, `${path} ${JSON.stringify(headers)}`);
      assert.deepEqual(r.json, { error: 'not found' });
    }
  }
});

test('A BODY THE OPERATOR SURFACE CANNOT READ: malformed, not JSON, oversized or wrongly encoded, on every changing operator route and whatever the letter case of the path, is one fixed sentence with no-store and nosniff', async () => {
  const who = await owner('si-body');
  const token = await signedIn(main.base, who);
  const key = generateDeviceToken();
  secrets.add(key);
  await withTenant(who.tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [who.tenant, hashToken(key)]));
  const changing = routeTable(main.app).filter((r) => r.base === '/api/v1' && r.method !== 'GET');
  // U4's 22, U4b's four people-to-tell writes and U4c's four board writes.
  assert.equal(changing.length, 30, `the walk found ${changing.length} changing operator routes`);
  const cases = [
    { name: 'malformed', raw: '{"name": "Echo-Me-Back", oops', headers: {}, status: 400, body: BODY_UNREADABLE },
    // The parser's own text for this one quotes what was sent.
    { name: 'not JSON', raw: 'Echo-Me-Back, not JSON at all', headers: {}, status: 400, body: BODY_UNREADABLE },
    { name: 'oversized', raw: JSON.stringify({ name: `Echo-Me-Back${'x'.repeat(1024 * 1024)}` }), headers: {}, status: 413, body: BODY_TOO_LARGE },
    { name: 'not gzip', raw: '{"name":"Echo-Me-Back"}', headers: { 'content-encoding': 'gzip' }, status: 400, body: BODY_UNREADABLE },
    { name: 'bad charset', raw: '{"name":"Echo-Me-Back"}', headers: { 'content-type': 'application/json; charset=koi8-r' }, status: 400, body: BODY_UNREADABLE },
  ];
  const wrong = [];
  let answers = 0;
  // Routing ignores the letter case of the path, so the answer must too: the
  // path as written, and three other spellings of it.
  const spellings = [
    (p) => p,
    (p) => p.replace('/api/v1/', '/Api/v1/'),
    (p) => p.replace('/api/v1/', '/API/V1/'),
    (p) => p.toUpperCase(),
  ];
  for (const r of changing) {
    for (const spell of spellings) {
      const path = spell(`${r.base}${concrete(r.path)}`);
      for (const c of cases) {
        for (const auth of [{ headers: { authorization: `Bearer ${key}` } }, { cookie: token, origin: ADMIN_ORIGIN, headers: {} }]) {
          const res = await call(main.base, r.method, path, {
            ...auth, raw: c.raw, headers: { 'content-type': 'application/json', ...auth.headers, ...c.headers },
          });
          answers += 1;
          const ok = res.status === c.status && res.text === JSON.stringify(c.body) && !res.text.includes('Echo-Me-Back')
            && res.headers.get('cache-control') === 'no-store' && res.headers.get('x-content-type-options') === 'nosniff';
          if (!ok) wrong.push(`${r.method} ${path} ${c.name}: ${res.status} ${res.text.slice(0, 80)} cc=${res.headers.get('cache-control')}`);
        }
      }
    }
  }
  assert.equal(answers, 30 * spellings.length * cases.length * 2);
  assert.deepEqual(wrong, []);
});

// --- settings are checked at start -----------------------------------------------------------

test('SETTINGS ARE CHECKED AT START: every value the gate tried is refused by name with its range, and one good value of each is taken', () => {
  const bad = ['abc', '0', '-5', '1e400', '0.4', '0.001', '0.0001', '0x10', '1e12', '999999999999', ' 30', '30.0'];
  for (const [name, { min, max, fallback }] of Object.entries(signIn.NUMBER_SETTINGS)) {
    for (const value of bad) {
      assert.throws(() => signIn.readAuthSettings({ [name]: value }), new RegExp(`^Error: ${name} must be a whole number from ${min} to ${max}, not `), `${name}=${value}`);
    }
    assert.throws(() => signIn.readAuthSettings({ [name]: String(max + 1) }), new RegExp(`^Error: ${name} must be a whole number`), `${name} above its range`);
    assert.doesNotThrow(() => signIn.readAuthSettings({ [name]: String(fallback) }), `${name}=${fallback}`);
  }
  const s = signIn.readAuthSettings({ SESSION_IDLE_MINUTES: '45', SESSION_MAX_HOURS: '24', SIGN_IN_ATTEMPTS_PER_ADDRESS: '10', SIGN_IN_ATTEMPTS_WINDOW_MINUTES: '5', SIGN_IN_REFUSAL_FLOOR_MS: '750', SIGN_IN_HASH_LINE: '20', SIGN_IN_HASH_LINE_PER_ADDRESS: '3' });
  assert.deepEqual([s.idleSeconds, s.maxSeconds, s.attemptsPerAddress, s.attemptsWindowSeconds, s.refusalFloorMs, s.hashLine, s.hashLinePerAddress], [2700, 86400, 10, 300, 750, 20, 3]);
  assert.throws(() => signIn.readAuthSettings({ SESSION_IDLE_MINUTES: '1440', SESSION_MAX_HOURS: '12' }), /SESSION_IDLE_MINUTES cannot be longer than SESSION_MAX_HOURS/);
  assert.throws(() => signIn.readAuthSettings({ SIGN_IN_HASH_LINE: '4', SIGN_IN_HASH_LINE_PER_ADDRESS: '5' }), /SIGN_IN_HASH_LINE_PER_ADDRESS cannot be more than SIGN_IN_HASH_LINE/);

  for (const value of ['true', 'TRUE', 'yes', 'abc', '-1', '0', '6', '999999999999', 'loopback,true', 'linklocal', 'uniquelocal', '10.0.0.0/0', '::/0', '10.0.0.1/33', '10.0.0.1/8/1', '300.1.1.1', '10.0.0.1,,10.0.0.2']) {
    assert.throws(() => signIn.readAuthSettings({ TRUST_PROXY: value }), /^Error: TRUST_PROXY must be a number of proxy hops from 1 to 5, "loopback", or a comma-separated list/, `TRUST_PROXY=${value}`);
  }
  assert.equal(signIn.readAuthSettings({ TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(signIn.readAuthSettings({ TRUST_PROXY: '5' }).trustProxy, 5);
  assert.equal(signIn.readAuthSettings({ TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  assert.deepEqual(signIn.readAuthSettings({ TRUST_PROXY: '10.0.0.1, 10.8.0.0/16,2001:db8::/32' }).trustProxy, ['10.0.0.1', '10.8.0.0/16', '2001:db8::/32']);
  assert.equal(signIn.readAuthSettings({}).trustProxy, null);
});

test('the real entrypoint refuses a bad setting by name and with no stack trace', async () => {
  // A free port, not PORT=0: 0 is refused by name before these settings are read.
  const free = http.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  for (const [name, value] of [['TRUST_PROXY', 'true'], ['TRUST_PROXY', '999999999999'], ['SIGN_IN_ATTEMPTS_WINDOW_MINUTES', '0.0001'], ['SESSION_MAX_HOURS', '1e12'], ['SIGN_IN_HASH_LINE', '0']]) {
    const env = { ...process.env, PORT: String(port), ADMIN_ORIGIN, [name]: value };
    const r = spawnSync(process.execPath, ['src/server.js'], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 1, `${name}=${value}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^\\[platform\\] REFUSING TO SERVE: ${name} must be`, 'm'), `${name}=${value}`);
    assert.equal(/\n\s+at /.test(r.stderr), false, `${name}=${value} printed a stack trace`);
  }
});

// --- decisions 4 and 6 -----------------------------------------------------------------------

/** One request with the cookie header sent as given: one header, or one per value. */
function rawCookie(base, path, cookies) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${path}`, { method: 'GET' }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        bodies.push(text);
        resolve({ status: res.statusCode, json: JSON.parse(text) });
      });
    });
    r.setHeader('cookie', cookies);
    r.on('error', reject);
    r.end();
  });
}

test('DECISION 4: a cookie sent twice is no cookie it can use -- the same value or two live sessions, in one header or in two -- and answers session_ended', async () => {
  const who = await owner('si-twice');
  const a = await signedIn(main.base, who);
  const b = await signedIn(main.base, who);
  const c = signIn.COOKIE;
  for (const cookies of [`${c}=${a}; ${c}=${a}`, `${c}=${a}; ${c}=${b}`, [`${c}=${a}`, `${c}=${a}`], [`${c}=${a}`, `${c}=${b}`]]) {
    const r = await rawCookie(main.base, '/api/v1/auth/me', cookies);
    const label = Array.isArray(cookies) ? 'two headers' : 'one header';
    assert.equal(r.status, 401, label);
    assert.equal(r.json.code, 'session_ended', label);
  }
  // Control: each one alone is a live session.
  assert.equal((await rawCookie(main.base, '/api/v1/auth/me', `${c}=${a}`)).status, 200);
  assert.equal((await rawCookie(main.base, '/api/v1/auth/me', `${c}=${b}`)).status, 200);
});

test('DECISION 6: a sign-in deletes that admin\'s ended sessions -- signed out, idle or past their end -- and leaves the live ones and the keys', async () => {
  const who = await owner('si-prune');
  // All four first: each sign-in prunes, so the endings come after.
  const out = await signedIn(main.base, who);
  const idle = await signedIn(main.base, who);
  const old = await signedIn(main.base, who);
  const live = await signedIn(main.base, who);
  assert.equal((await call(main.base, 'POST', '/api/v1/auth/sign-out', { cookie: out, origin: ADMIN_ORIGIN })).status, 204);
  await ageSession(idle, `last_seen_at = now() - interval '31 minutes'`);
  await ageSession(old, `expires_at = now() - interval '1 second', last_seen_at = now()`);
  const key = generateDeviceToken();
  secrets.add(key);
  await withTenant(who.tenant, (cl) => cl.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [who.tenant, hashToken(key)]));
  const rows = async () => (await admin.query('SELECT token_hash FROM operator_tokens WHERE tenant_id = $1 ORDER BY 1', [who.tenant])).rows.map((r) => r.token_hash);
  assert.equal((await rows()).length, 5);
  const fresh = await signedIn(main.base, who);
  assert.deepEqual(await rows(), [hashToken(live), hashToken(fresh), hashToken(key)].sort());
});

// --- last: nothing secret in any response ---------------------------------------------------

test('NOTHING SECRET IN ANY RESPONSE: no body this file received holds a password, a token, a cookie value or a stored hash; and no cookie was set without Secure', () => {
  assert.ok(bodies.length > 100, `bodies kept: ${bodies.length}`);
  assert.ok(secrets.size > 20, `secrets kept: ${secrets.size}`);
  const found = [];
  for (const secret of secrets) {
    if (bodies.some((b) => holdsSecret(b, secret))) found.push(secret.slice(0, 6));
  }
  assert.deepEqual(found, []);
  assert.ok(setCookies.length > 10);
  assert.deepEqual(setCookies.filter((c) => !/;\s*Secure(;|$)/.test(c)), [], 'every Set-Cookie carries Secure');
});
