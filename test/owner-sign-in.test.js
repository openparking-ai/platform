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
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { createAdmin, resetAdminPassword } from '../src/adminAccount.js';
import { hashCount } from '../src/passwords.js';
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
  main = await serve({ ADMIN_ORIGIN, SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000', TRUST_PROXY: undefined, SESSION_COOKIE_INSECURE: undefined });
  trusted = await serve({ ADMIN_ORIGIN, SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000', TRUST_PROXY: 'loopback', SESSION_COOKIE_INSECURE: undefined });
  limited = await serve({ ADMIN_ORIGIN, SIGN_IN_ATTEMPTS_PER_ADDRESS: '3', TRUST_PROXY: undefined, SESSION_COOKIE_INSECURE: undefined });
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
  assert.deepEqual(Object.keys(r.json).sort(), ['email', 'session_ends_at', 'tenant_id']);
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
  assert.deepEqual(auth.map((r) => `${r.method} ${r.path}`).sort(), ['GET /me', 'POST /sign-in', 'POST /sign-out']);
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
  assert.throws(() => signIn.readAuthSettings({ SESSION_IDLE_MINUTES: '0' }), /positive/);
  assert.equal(signIn.readAuthSettings({}).cookieSecure, true, 'Secure by default');
  assert.equal(signIn.readAuthSettings({ SESSION_COOKIE_INSECURE: 'true' }).cookieSecure, false);
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
