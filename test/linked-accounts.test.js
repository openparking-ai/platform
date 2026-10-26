/**
 * People from a linked accounts module (0035; README, "Linked accounts: people
 * beside the admin"), against the door's stand-in (test/fixtures/accounts-door).
 *
 * Unset is only the admin; set, an email that is not the admin's is the
 * module's to answer, through its door: the password on stdin, could-not-decide
 * never a yes, sign-in's lock and its one refusal, and a session that asks the
 * module again and ends when the answer changes.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool, createTenant, buildWorld, superuserClient } from './helpers.js';
import { createAdmin } from '../src/adminAccount.js';
import * as signIn from '../src/signIn.js';
import { ALL } from '../src/permissions.js';
import { ACCOUNTS_UNDECIDED, LOCK_FAILURES } from '../src/linkedAccounts.js';
import { accountsStandIn } from './accounts-stand-in.js';
import { holdsSecret } from './secrets.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const WRONG = 'not the password at all';

const door = accountsStandIn();
const servers = [];
let main;
let su;

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

async function call(path, { method = 'GET', body, cookie, origin = ADMIN_ORIGIN, headers = {}, base = main.base } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = `${signIn.COOKIE}=${cookie}`;
  if (origin) h.origin = origin;
  const res = await fetch(`${base}${path}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  return { status: res.status, text, json, cookies: res.headers.getSetCookie() };
}

const tokenOf = (r) => {
  const c = r.cookies.find((x) => x.startsWith(`${signIn.COOKIE}=`) && !x.startsWith(`${signIn.COOKIE}=;`));
  return c ? c.split(';')[0].slice(signIn.COOKIE.length + 1) : null;
};

const signInAs = (email, password, extra = {}) => call('/api/v1/auth/sign-in', { method: 'POST', body: { email, password }, ...extra });

async function linkedIn(p) {
  const r = await signInAs(p.email, p.password);
  assert.equal(r.status, 200, r.text);
  return tokenOf(r);
}

/** A tenant with its one admin and a garage, as every other suite makes them. */
async function account(tag) {
  const tenant = await createTenant(tag);
  const world = await buildWorld(tenant);
  const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await createAdmin({ tenantId: tenant, email, password: ADMIN_PASSWORD });
  return { tenant, world, email };
}

/** Make the session's last answer old, so the next request asks the module again. */
const age = (token) => su.query(
  "UPDATE linked_sessions SET checked_at = now() - interval '1 hour' WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')",
  [token],
);

before(async () => {
  su = superuserClient();
  await su.connect();
  main = await serve({ ADMIN_ORIGIN, SIGN_IN_REFUSAL_FLOOR_MS: '200', SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000', ACCOUNTS_RECHECK_SECONDS: '10' });
});

after(async () => {
  door.name(true);
  for (const s of servers) await new Promise((r) => s.close(r));
  await su.end();
  await pool.end();
  door.end();
});

test('UNSET IS ONLY THE ADMIN: an email that is not the admin\'s is refused like any, and no door runs', async () => {
  const a = await account('la-unset');
  const p = door.person(a.tenant);
  door.name(false);
  door.forget();
  try {
    const r = await signInAs(p.email, p.password);
    const wrongAdmin = await signInAs(a.email, WRONG);
    assert.equal(r.status, 401);
    assert.equal(r.text, wrongAdmin.text, 'the same bytes as a wrong admin password');
    assert.deepEqual(r.cookies, []);
    assert.deepEqual(door.calls(), [], 'the door ran');
    // The admin signs in as ever.
    assert.equal((await signInAs(a.email, ADMIN_PASSWORD)).status, 200);
  } finally {
    door.name(true);
  }
});

test('A PERSON SIGNS IN THROUGH THE DOOR: the password on stdin and never argv; /me says who, what and where', async () => {
  const a = await account('la-in');
  const p = door.person(a.tenant, { name: 'Ana Ruiz', language: 'es', garages: [a.world.garage], permissions: ['lanes:change', 'stays:read'] });
  door.forget();
  const r = await signInAs(p.email.toUpperCase(), p.password);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ['email', 'language', 'session_ends_at', 'tenant_id']);
  assert.equal(r.json.email, p.email);
  assert.equal(r.json.tenant_id, a.tenant);
  assert.equal(r.json.language, 'es');
  const token = tokenOf(r);
  assert.ok(token);
  const calls = door.calls();
  assert.deepEqual(calls.map((c) => c.argv), [['sign-in']]);
  assert.ok(calls.every((c) => !c.argv.some((x) => holdsSecret(x, p.password))), 'the password on argv');
  assert.deepEqual(JSON.parse(calls[0].stdin), { email: p.email, password: p.password });
  assert.equal(holdsSecret(r.text, p.password), false);

  const me = await call('/api/v1/auth/me', { cookie: token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, {
    kind: 'linked', email: p.email, name: 'Ana Ruiz', tenant_id: a.tenant, session_ends_at: me.json.session_ends_at,
    language: 'es', permissions: ['lanes:change', 'stays:read'], garages: [a.world.garage],
  });
  // The admin's /me: every permission, every garage.
  const adminMe = await call('/api/v1/auth/me', { cookie: tokenOf(await signInAs(a.email, ADMIN_PASSWORD)) });
  assert.equal(adminMe.json.kind, 'admin');
  assert.deepEqual(adminMe.json.permissions, ALL);
  assert.equal(adminMe.json.garages, 'all');
  // Only the token's hash is kept.
  const { rows } = await su.query('SELECT token_hash FROM linked_sessions WHERE person = $1', [p.person]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
});

test('ONE REFUSAL: a wrong password through the door, an unknown email and a wrong admin password are the same bytes', async () => {
  const a = await account('la-same');
  const p = door.person(a.tenant);
  const answers = [
    await signInAs(p.email, WRONG),
    await signInAs(`nobody-${Date.now()}@example.com`, WRONG),
    await signInAs(a.email, WRONG),
  ];
  for (const r of answers) {
    assert.equal(r.status, 401);
    assert.equal(r.text, answers[0].text);
    assert.deepEqual(r.cookies, []);
  }
  assert.deepEqual(answers[0].json, signIn.REFUSED);
});

test('THE LOCK: ten refusals lock the address out of that email; the right password then is refused and never reaches the door', async () => {
  const a = await account('la-lock');
  const p = door.person(a.tenant);
  for (let i = 0; i < LOCK_FAILURES; i += 1) assert.equal((await signInAs(p.email, WRONG)).status, 401);
  door.forget();
  const r = await signInAs(p.email, p.password);
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, signIn.REFUSED);
  assert.deepEqual(door.calls(), [], 'a locked address reached the door');
  // Another person from the same address is not locked.
  const q = door.person(a.tenant);
  assert.equal((await signInAs(q.email, q.password)).status, 200);
  // After the lock, the right password signs in, and the count starts again.
  await su.query("UPDATE linked_sign_in_locks SET locked_until = now() - interval '1 second'");
  assert.equal((await signInAs(p.email, p.password)).status, 200);
});

test('COULD-NOT-DECIDE IS NEVER A YES: a door that exits 2 or 3, answers no JSON or not a person lets nobody in', async () => {
  const a = await account('la-undecided');
  const p = door.person(a.tenant);
  try {
    for (const mode of ['exit2', 'exit3', 'not_json', 'not_a_person']) {
      door.setMode(mode);
      const r = await signInAs(p.email, p.password);
      assert.equal(r.status, 503, `${mode}: ${r.text}`);
      assert.deepEqual(r.json, signIn.UNDECIDED, mode);
      assert.deepEqual(r.cookies, [], mode);
    }
  } finally {
    door.setMode('normal');
  }
  // A door that cannot be found at all is the same.
  const saved = process.env.ENTITLEMENT_BIN_DIR;
  process.env.ENTITLEMENT_BIN_DIR = '/nonexistent';
  try {
    const r = await signInAs(p.email, p.password);
    assert.equal(r.status, 503);
    assert.deepEqual(r.cookies, []);
  } finally {
    process.env.ENTITLEMENT_BIN_DIR = saved;
  }
  assert.equal((await signInAs(p.email, p.password)).status, 200);
});

test('A TENANT THIS PLATFORM DOES NOT HAVE makes no session', async () => {
  const p = door.person('00000000-0000-4000-8000-00000000abcd');
  const r = await signInAs(p.email, p.password);
  assert.equal(r.status, 503);
  assert.deepEqual(r.cookies, []);
  assert.equal((await su.query('SELECT 1 FROM linked_sessions WHERE person = $1', [p.person])).rowCount, 0);
});

test('IT ASKS AGAIN: the same version goes on; another version, gone, or another tenant ends the session', async () => {
  const a = await account('la-recheck');
  const b = await account('la-recheck-b');
  const cases = [
    ['the same version', () => {}, 200],
    ['another version', (p) => door.change(p.person, { version: 'v2' }), 401],
    ['gone', (p) => door.change(p.person, { gone: true }), 401],
    ['moved to another tenant', (p) => door.change(p.person, { tenant: b.tenant }), 401],
    ['answered with another tenant', (p) => door.change(p.person, { answer_tenant: b.tenant }), 401],
  ];
  for (const [what, change, status] of cases) {
    const p = door.person(a.tenant);
    const token = await linkedIn(p);
    assert.equal((await call('/api/v1/garages', { cookie: token })).status, 200, what);
    change(p);
    // Fresh: not asked yet, so the change is not seen.
    door.forget();
    assert.equal((await call('/api/v1/garages', { cookie: token })).status, 200, what);
    assert.deepEqual(door.calls(), [], `${what}: asked before the answer was old`);
    await age(token);
    const r = await call('/api/v1/garages', { cookie: token });
    assert.equal(r.status, status, `${what}: ${r.text}`);
    assert.deepEqual(door.calls().map((c) => c.argv), [['who', '--tenant', a.tenant, '--person', p.person]], what);
    if (status === 401) {
      assert.deepEqual(r.json, { error: signIn.SESSION_ENDED.error, code: signIn.SESSION_ENDED.code }, what);
      const row = (await su.query('SELECT revoked_at FROM linked_sessions WHERE person = $1', [p.person])).rows[0];
      assert.ok(row.revoked_at, `${what}: the session row was not ended`);
      assert.equal((await call('/api/v1/auth/me', { cookie: token })).status, 401, what);
    } else {
      const row = (await su.query('SELECT checked_at FROM linked_sessions WHERE person = $1', [p.person])).rows[0];
      assert.ok(Date.now() - new Date(row.checked_at).getTime() < 60_000, 'the answer was not renewed');
    }
  }
});

test('A RECHECK THAT CANNOT DECIDE refuses the request and ends nothing; the next one asks again', async () => {
  const a = await account('la-recheck-503');
  const p = door.person(a.tenant);
  const token = await linkedIn(p);
  await age(token);
  door.setMode('exit2', ['who']);
  try {
    const r = await call('/api/v1/garages', { cookie: token });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, ACCOUNTS_UNDECIDED.code);
    const me = await call('/api/v1/auth/me', { cookie: token });
    assert.equal(me.status, 503);
    assert.deepEqual(me.json, ACCOUNTS_UNDECIDED);
  } finally {
    door.setMode('normal');
  }
  const row = (await su.query('SELECT revoked_at FROM linked_sessions WHERE person = $1', [p.person])).rows[0];
  assert.equal(row.revoked_at, null);
  assert.equal((await call('/api/v1/garages', { cookie: token })).status, 200);
});

test('ONE QUESTION AT A TIME: requests that arrive while the module is asked wait for its one answer', async () => {
  const a = await account('la-once');
  const p = door.person(a.tenant);
  const token = await linkedIn(p);
  await age(token);
  door.forget();
  const answers = await Promise.all(Array.from({ length: 6 }, () => call('/api/v1/garages', { cookie: token })));
  assert.ok(answers.every((r) => r.status === 200), answers.map((r) => r.status).join(','));
  assert.equal(door.calls().length, 1);
});

test('A DEPLOYMENT THAT STOPS NAMING THE DOOR ends every linked session at once', async () => {
  const a = await account('la-unnamed');
  const p = door.person(a.tenant);
  const token = await linkedIn(p);
  door.name(false);
  try {
    assert.equal((await call('/api/v1/garages', { cookie: token })).status, 401);
    assert.equal((await call('/api/v1/auth/me', { cookie: token })).status, 401);
  } finally {
    door.name(true);
  }
});

test('SIGN-OUT ends a linked session; the language changes for this session only', async () => {
  const a = await account('la-out');
  const p = door.person(a.tenant);
  const token = await linkedIn(p);
  const lang = await call('/api/v1/auth/language', { method: 'PUT', body: { language: 'es' }, cookie: token });
  assert.equal(lang.status, 200, lang.text);
  assert.equal((await call('/api/v1/auth/me', { cookie: token })).json.language, 'es');
  assert.equal((await su.query("SELECT language FROM operator_users WHERE tenant_id = $1", [a.tenant])).rows[0].language, 'en', 'the admin\'s language moved');
  const out = await call('/api/v1/auth/sign-out', { method: 'POST', cookie: token });
  assert.equal(out.status, 204);
  assert.equal((await call('/api/v1/auth/me', { cookie: token })).status, 401);
  // A second sign-in makes a new session; the ended one is cleared away.
  await linkedIn(p);
  const rows = (await su.query('SELECT revoked_at FROM linked_sessions WHERE person = $1', [p.person])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].revoked_at, null);
});

test('A LINKED PERSON\'S CHANGE NAMES THEM in the change log, by the email they signed in with', async () => {
  const a = await account('la-log');
  const p = door.person(a.tenant, { permissions: ['lanes:change', 'log:read'] });
  const token = await linkedIn(p);
  const r = await call(`/api/v1/lanes/${a.world.entryLane}`, { method: 'PATCH', body: { name: 'Renamed by a person' }, cookie: token });
  assert.equal(r.status, 200, r.text);
  const log = await call(`/api/v1/garages/${a.world.garage}/changes`, { cookie: token });
  assert.equal(log.status, 200, log.text);
  const line = log.json.changes.find((c) => c.action === 'lane.rename');
  assert.deepEqual(line.who, { kind: 'linked', name: p.email });
  assert.equal(line.done_by, null);
});

test('ANOTHER TENANT\'S PERSON never reaches this tenant: its garage is not found', async () => {
  const a = await account('la-iso-a');
  const b = await account('la-iso-b');
  const p = door.person(b.tenant, { permissions: ['garages:change'] });
  const token = await linkedIn(p);
  assert.equal((await call(`/api/v1/garages/${a.world.garage}`, { cookie: token })).status, 404);
  const list = await call('/api/v1/garages', { cookie: token });
  assert.deepEqual(list.json.garages.map((g) => g.id), [b.world.garage]);
});
