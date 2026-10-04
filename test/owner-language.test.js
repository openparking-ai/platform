/**
 * The owner's language, kept on the owner (0025): sign-in and `/auth/me`
 * carry it, and PUT /api/v1/auth/language changes it -- for the signed-in
 * admin only, to `en` or `es` only.
 *
 * The admin and the tenant the route changes are the SESSION's. A body that
 * names another user, another tenant or another email is not read; a value
 * that is not one of the two languages is refused by name and writes nothing;
 * the cookie's rules hold (no cookie, an ended session, no Origin, a foreign
 * Origin). And the migration: on a database that already has admins, every one
 * of them is English, and the database itself refuses any other value.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { pool, createTenant } from './helpers.js';
import { createAdmin } from '../src/adminAccount.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import * as signIn from '../src/signIn.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const FOREIGN_ORIGIN = 'https://elsewhere.example.test';
// Invented, and long enough for the length rule.
const PASSWORD = 'correct horse battery staple';
const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

let admin; // the owner connection, for reading rows as they are
let base;
let server;

before(async () => {
  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const saved = { ADMIN_ORIGIN: process.env.ADMIN_ORIGIN, SIGN_IN_REFUSAL_FLOOR_MS: process.env.SIGN_IN_REFUSAL_FLOOR_MS, SIGN_IN_ATTEMPTS_PER_ADDRESS: process.env.SIGN_IN_ATTEMPTS_PER_ADDRESS };
  Object.assign(process.env, { ADMIN_ORIGIN, SIGN_IN_REFUSAL_FLOOR_MS: '200', SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000' });
  let app;
  try {
    app = createApp();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await admin.end();
  await pool.end();
});

async function call(method, path, { body, raw, cookie, origin, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined || raw !== undefined) h['content-type'] ??= 'application/json';
  if (cookie) h.cookie = `${signIn.COOKIE}=${cookie}`;
  if (origin) h.origin = origin;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  return { status: res.status, text, json, cookies: res.headers.getSetCookie() };
}

/** A tenant and its admin. */
async function owner(tag) {
  const tenant = await createTenant(tag);
  const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await createAdmin({ tenantId: tenant, email, password: PASSWORD });
  const { rows } = await admin.query('SELECT id FROM operator_users WHERE tenant_id = $1', [tenant]);
  return { tenant, email, user: rows[0].id };
}

async function signInAs(who) {
  const r = await call('POST', '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD }, origin: ADMIN_ORIGIN });
  assert.equal(r.status, 200, r.text);
  const c = r.cookies.find((x) => x.startsWith(`${signIn.COOKIE}=`));
  return { answer: r.json, token: c.split(';')[0].slice(signIn.COOKIE.length + 1) };
}

const languageOf = async (who) => (await admin.query('SELECT language FROM operator_users WHERE id = $1', [who.user])).rows[0].language;
const setLanguage = (token, body, extra = {}) =>
  call('PUT', '/api/v1/auth/language', { body, cookie: token, origin: ADMIN_ORIGIN, ...extra });

// --- what sign-in and /me carry --------------------------------------------------------------

test('a new admin is English: sign-in and /me both say so', async () => {
  const a = await owner('lang-new');
  assert.equal(await languageOf(a), 'en');
  const { answer, token } = await signInAs(a);
  assert.equal(answer.language, 'en');
  const me = await call('GET', '/api/v1/auth/me', { cookie: token });
  assert.equal(me.status, 200);
  assert.equal(me.json.language, 'en');
});

test('Spanish chosen is kept on the admin: /me says it, and the next sign-in answers it', async () => {
  const a = await owner('lang-kept');
  const first = await signInAs(a);
  const r = await setLanguage(first.token, { language: 'es' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { language: 'es' });
  assert.equal(await languageOf(a), 'es');
  assert.equal((await call('GET', '/api/v1/auth/me', { cookie: first.token })).json.language, 'es');
  // A sign-in from anywhere else -- a new session, no browser state at all -- answers Spanish.
  const second = await signInAs(a);
  assert.equal(second.answer.language, 'es');
  assert.equal((await call('GET', '/api/v1/auth/me', { cookie: second.token })).json.language, 'es');
  // And back.
  assert.equal((await setLanguage(second.token, { language: 'en' })).status, 200);
  assert.equal(await languageOf(a), 'en');
  assert.equal((await signInAs(a)).answer.language, 'en');
});

// --- only your own row --------------------------------------------------------------------

test("owner A's change leaves owner B, in another tenant, unchanged", async () => {
  const a = await owner('lang-a');
  const b = await owner('lang-b');
  const { token } = await signInAs(a);
  assert.equal((await setLanguage(token, { language: 'es' })).status, 200);
  assert.equal(await languageOf(a), 'es');
  assert.equal(await languageOf(b), 'en');
});

test('a body naming another user, tenant or email is not read: only the signed-in admin changes', async () => {
  const a = await owner('lang-body-a');
  const b = await owner('lang-body-b');
  const { token } = await signInAs(a);
  const r = await setLanguage(token, { language: 'es', user_id: b.user, tenant_id: b.tenant, id: b.user, email: b.email });
  assert.equal(r.status, 200, r.text);
  assert.equal(await languageOf(b), 'en', "owner B's row was changed by owner A's request");
  assert.equal(await languageOf(a), 'es');
});

test('the query is not read', async () => {
  const a = await owner('lang-query');
  const { token } = await signInAs(a);
  const r = await call('PUT', '/api/v1/auth/language?language=es&user_id=x', { body: { language: 'en' }, cookie: token, origin: ADMIN_ORIGIN });
  assert.equal(r.status, 200, r.text);
  assert.equal(await languageOf(a), 'en');
});

test('a language in the query does not stand in for a body that is not one: refused by name, the row unchanged', async () => {
  const a = await owner('lang-query-only');
  const { token } = await signInAs(a);
  const notALanguage = [
    ['no body', { raw: '' }],
    ['an empty object', { body: {} }],
    ['"fr"', { body: { language: 'fr' } }],
    ['null', { body: { language: null } }],
    ['a body that is not JSON', { raw: 'language=es', headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
  ];
  for (const [what, extra] of notALanguage) {
    const r = await call('PUT', '/api/v1/auth/language?language=es', { cookie: token, origin: ADMIN_ORIGIN, ...extra });
    assert.equal(r.status, 400, `${what}, with ?language=es: ${r.status} ${r.text.slice(0, 200)}`);
    assert.deepEqual(r.json, signIn.LANGUAGE_REFUSED, what);
    assert.equal(await languageOf(a), 'en', `${what}, with ?language=es: the row changed`);
  }
});

// --- only the two values ----------------------------------------------------------------

test('anything but "en" or "es" is refused by name, and the row is unchanged', async () => {
  const a = await owner('lang-values');
  const { token } = await signInAs(a);
  assert.equal((await setLanguage(token, { language: 'es' })).status, 200);
  const refused = [
    ['"fr"', { body: { language: 'fr' } }],
    ['an empty string', { body: { language: '' } }],
    ['a number', { body: { language: 5 } }],
    ['a 10 kB string', { body: { language: 'e'.repeat(10 * 1024) } }],
    ['null', { body: { language: null } }],
    ['a list', { body: { language: ['en'] } }],
    ['an object', { body: { language: { en: true } } }],
    ['upper case', { body: { language: 'EN' } }],
    ['a space before it', { body: { language: ' en' } }],
    ['no language at all', { body: {} }],
    ['a list for a body', { body: ['en'] }],
    ['a bare string for a body', { raw: '"en"' }],
    ['a body that is not JSON', { raw: 'language=en', headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
    ['broken JSON', { raw: '{"language": "en"' }],
    ['no body', { raw: '' }],
  ];
  for (const [what, extra] of refused) {
    const r = await call('PUT', '/api/v1/auth/language', { cookie: token, origin: ADMIN_ORIGIN, ...extra });
    assert.equal(r.status, 400, `${what}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.deepEqual(r.json, signIn.LANGUAGE_REFUSED, what);
    assert.equal(await languageOf(a), 'es', `${what}: the row changed`);
  }
});

// --- the cookie's rules -----------------------------------------------------------------

test('no Origin, or a foreign one, is refused before anything is read; the row is unchanged', async () => {
  const a = await owner('lang-origin');
  const { token } = await signInAs(a);
  const none = await call('PUT', '/api/v1/auth/language', { body: { language: 'es' }, cookie: token });
  assert.equal(none.status, 403);
  assert.deepEqual(none.json, signIn.ORIGIN_REFUSED);
  const foreign = await setLanguage(token, { language: 'es' }, { origin: FOREIGN_ORIGIN });
  assert.equal(foreign.status, 403);
  assert.deepEqual(foreign.json, signIn.ORIGIN_REFUSED);
  assert.equal(await languageOf(a), 'en');
});

test('no session is 401; an ended session is 401; an operator key is not a session', async () => {
  const a = await owner('lang-session');
  const noCookie = await call('PUT', '/api/v1/auth/language', { body: { language: 'es' }, origin: ADMIN_ORIGIN });
  assert.equal(noCookie.status, 401);
  assert.deepEqual(noCookie.json, signIn.SIGN_IN_REQUIRED);

  const { token } = await signInAs(a);
  assert.equal((await call('POST', '/api/v1/auth/sign-out', { cookie: token, origin: ADMIN_ORIGIN })).status, 204);
  const ended = await setLanguage(token, { language: 'es' });
  assert.equal(ended.status, 401);
  assert.deepEqual(ended.json, signIn.SESSION_ENDED);

  const made = generateDeviceToken();
  await admin.query("INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1, 'lang-key', $2)", [a.tenant, hashToken(made)]);
  const key = await call('PUT', '/api/v1/auth/language', { body: { language: 'es' }, origin: ADMIN_ORIGIN, headers: { authorization: `Bearer ${made}` } });
  assert.equal(key.status, 401);
  assert.equal(await languageOf(a), 'en');
});

test('only PUT changes it: any other method on the path is not a route', async () => {
  const a = await owner('lang-methods');
  const { token } = await signInAs(a);
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const r = await call(method, '/api/v1/auth/language', { body: method === 'GET' ? undefined : { language: 'es' }, cookie: token, origin: ADMIN_ORIGIN });
    assert.equal(r.status, 404, `${method}: ${r.status}`);
  }
  assert.equal(await languageOf(a), 'en');
});

// --- the migration ------------------------------------------------------------------------

/** Every statement of `files`, in order, on the owner connection to `url`. */
async function apply(url, files) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    for (const f of files) await c.query(await readFile(join(MIGRATIONS, f), 'utf8'));
  } finally {
    await c.end();
  }
}

test('0025 on a database that already has admins: every one is English, and the database refuses any other value', async () => {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const at = files.findIndex((f) => f.startsWith('0025_'));
  assert.ok(at > 0, 'no 0025 migration on disk');
  const owner = new URL(process.env.DATABASE_URL);
  const maintenance = new URL(owner);
  maintenance.pathname = '/postgres';
  const name = `op_lang_${randomUUID().slice(0, 8)}`;
  const scratch = new URL(owner);
  scratch.pathname = `/${name}`;
  const m = new pg.Client({ connectionString: maintenance.toString() });
  await m.connect();
  await m.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
  try {
    await apply(scratch.toString(), files.slice(0, at));
    const c = new pg.Client({ connectionString: scratch.toString() });
    await c.connect();
    try {
      // Three admins made before 0025, each in its own tenant.
      for (const n of [1, 2, 3]) {
        const tenant = (await c.query('INSERT INTO tenants (slug, name) VALUES ($1, $1) RETURNING id', [`lang-${n}`])).rows[0].id;
        await c.query('INSERT INTO operator_users (tenant_id, email, password_hash) VALUES ($1, $2, $3)', [tenant, `before-${n}@example.com`, 'scrypt$invented']);
      }
      await apply(scratch.toString(), files.slice(at, at + 1));
      const { rows } = await c.query('SELECT language, count(*)::int AS n FROM operator_users GROUP BY language');
      assert.deepEqual(rows, [{ language: 'en', n: 3 }], 'every admin from before 0025 is English');

      for (const value of ['fr', '', 'EN']) {
        await assert.rejects(c.query("UPDATE operator_users SET language = $1 WHERE email = 'before-1@example.com'", [value]),
          (err) => err.code === '23514' && err.constraint === 'operator_users_language_is_known', `"${value}" was taken`);
      }
      const tenant = (await c.query("INSERT INTO tenants (slug, name) VALUES ('lang-4', 'lang-4') RETURNING id")).rows[0].id;
      await assert.rejects(c.query("INSERT INTO operator_users (tenant_id, email, password_hash, language) VALUES ($1, 'fr@example.com', 'scrypt$invented', 'fr')", [tenant]),
        (err) => err.code === '23514' && err.constraint === 'operator_users_language_is_known', 'an admin inserted as "fr" was taken');
      await assert.rejects(c.query("UPDATE operator_users SET language = NULL WHERE email = 'before-1@example.com'"), (err) => err.code === '23502');
      await c.query("UPDATE operator_users SET language = 'es' WHERE email = 'before-2@example.com'");
      assert.equal((await c.query("SELECT language FROM operator_users WHERE email = 'before-2@example.com'")).rows[0].language, 'es');
    } finally {
      await c.end();
    }
  } finally {
    await m.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
    await m.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`);
    await m.end();
  }
});
