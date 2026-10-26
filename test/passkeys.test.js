/**
 * Passkeys (0035; README, "Passkeys for the admin"), with a software
 * authenticator (test/fakeAuthenticator.js) whose bytes the real verification
 * checks unchanged: the admin's own, added, named, listed and removed behind
 * the session; a sign-in with one, held to one answer for every refusal; a
 * linked person's, kept by the module and asked for through its door.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool, createTenant, buildWorld, superuserClient } from './helpers.js';
import { createAdmin, resetAdminPassword } from '../src/adminAccount.js';
import * as signIn from '../src/signIn.js';
import * as passkeys from '../src/passkeys.js';
import { fakeAuthenticator } from './fakeAuthenticator.js';
import { accountsStandIn } from './accounts-stand-in.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const OTHER_SITE = 'https://garage.example.test';
const RP_ID = 'example.test';
const PASSWORD = 'correct horse battery staple';

const door = accountsStandIn();
const servers = [];
let main;
let off;
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

async function call(path, { method = 'GET', body, cookie, origin = ADMIN_ORIGIN, base = main.base } = {}) {
  const h = {};
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

async function account(tag) {
  const tenant = await createTenant(tag);
  const world = await buildWorld(tenant);
  const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await createAdmin({ tenantId: tenant, email, password: PASSWORD });
  const r = await call('/api/v1/auth/sign-in', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  return { tenant, world, email, token: tokenOf(r) };
}

/** Add a passkey made by `key` for the signed-in admin `who`. */
async function add(who, key, name = 'Laptop') {
  const o = await call('/api/v1/auth/passkeys/options', { method: 'POST', cookie: who.token });
  assert.equal(o.status, 200, o.text);
  return call('/api/v1/auth/passkeys', { method: 'POST', cookie: who.token, body: { challenge_id: o.json.challenge_id, name, response: key.register(o.json.options) } });
}

/** A passkey sign-in; `as` bends the response (test/fakeAuthenticator.js). */
async function passkeySignIn(key, signOptions = {}, { origin = ADMIN_ORIGIN, base } = {}) {
  const o = await call('/api/v1/auth/passkey/options', { method: 'POST', origin, base });
  assert.equal(o.status, 200, o.text);
  const r = await call('/api/v1/auth/passkey/sign-in', { method: 'POST', origin, base, body: { challenge_id: o.json.challenge_id, response: key.signIn(o.json.options, signOptions) } });
  return { ...r, challenge_id: o.json.challenge_id, options: o.json.options };
}

before(async () => {
  su = superuserClient();
  await su.connect();
  const common = { ADMIN_ORIGIN, SIGN_IN_REFUSAL_FLOOR_MS: '200', SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000' };
  main = await serve({ ...common, PASSKEY_RP_ID: RP_ID, PASSKEY_ORIGINS: `${ADMIN_ORIGIN},${OTHER_SITE}` });
  off = await serve({ ...common, PASSKEY_RP_ID: undefined });
});

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await su.end();
  await pool.end();
  door.end();
});

test('SETTINGS: unset is off; the relying party must be the host of every origin or a domain above it', () => {
  assert.equal(passkeys.readPasskeySettings({}, ADMIN_ORIGIN), null);
  assert.deepEqual(passkeys.readPasskeySettings({ PASSKEY_RP_ID: RP_ID }, ADMIN_ORIGIN), { rpId: RP_ID, origins: [ADMIN_ORIGIN], rpName: 'Open Parking' });
  assert.deepEqual(
    passkeys.readPasskeySettings({ PASSKEY_RP_ID: 'admin.example.test', PASSKEY_RP_NAME: 'Garage' }, ADMIN_ORIGIN),
    { rpId: 'admin.example.test', origins: [ADMIN_ORIGIN], rpName: 'Garage' },
  );
  const refused = [
    [{ PASSKEY_RP_ID: 'https://example.test' }, /PASSKEY_RP_ID must be a domain/],
    [{ PASSKEY_RP_ID: 'Example.test' }, /PASSKEY_RP_ID must be a domain/],
    [{ PASSKEY_RP_ID: 'example.test:443' }, /PASSKEY_RP_ID must be a domain/],
    [{ PASSKEY_RP_ID: 'other.test' }, /must be the host of every origin/],
    [{ PASSKEY_RP_ID: 'ample.test' }, /must be the host of every origin/],
    [{ PASSKEY_RP_ID: RP_ID, PASSKEY_ORIGINS: 'https://admin.example.test/path' }, /comma-separated list of origins/],
    [{ PASSKEY_RP_ID: RP_ID, PASSKEY_ORIGINS: 'ftp://admin.example.test' }, /comma-separated list of origins/],
    [{ PASSKEY_RP_ID: RP_ID, PASSKEY_ORIGINS: `${ADMIN_ORIGIN},https://evil.test` }, /must be the host of every origin/],
    [{ PASSKEY_RP_ID: RP_ID, PASSKEY_RP_NAME: 'x'.repeat(61) }, /PASSKEY_RP_NAME/],
  ];
  for (const [env, why] of refused) assert.throws(() => passkeys.readPasskeySettings(env, ADMIN_ORIGIN), why, JSON.stringify(env));
  assert.throws(() => passkeys.readPasskeySettings({ PASSKEY_RP_ID: RP_ID }, null), /PASSKEY_ORIGINS must name/);
});

test('OFF: with no PASSKEY_RP_ID every passkey route that needs one answers 409 passkeys_not_configured; the password still works', async () => {
  const who = await account('pk-off');
  const signedIn = await call('/api/v1/auth/sign-in', { base: off.base, method: 'POST', body: { email: who.email, password: PASSWORD } });
  const token = tokenOf(signedIn);
  for (const [method, path, cookie] of [
    ['POST', '/api/v1/auth/passkeys/options', token],
    ['POST', '/api/v1/auth/passkey/options', null],
  ]) {
    const r = await call(path, { base: off.base, method, cookie });
    assert.equal(r.status, 409, `${path}: ${r.text}`);
    assert.equal(r.json.code, 'passkeys_not_configured', path);
  }
  const r = await call('/api/v1/auth/passkey/sign-in', { base: off.base, method: 'POST', body: { challenge_id: 'x', response: {} } });
  assert.equal(r.status, 409);
});

test('THE ADMIN ADDS ONE AND SIGNS IN WITH IT: the cookie works, the counter moves, and every step is on the change log', async () => {
  const who = await account('pk-add');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  const added = await add(who, key, '  Work laptop  ');
  assert.equal(added.status, 201, added.text);
  assert.deepEqual(Object.keys(added.json.passkey).sort(), ['created_at', 'id', 'last_used_at', 'name']);
  assert.equal(added.json.passkey.name, 'Work laptop');
  assert.equal(added.json.passkey.last_used_at, null);

  const r = await passkeySignIn(key);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ['email', 'language', 'session_ends_at', 'tenant_id']);
  assert.equal(r.json.email, who.email);
  const token = tokenOf(r);
  const me = await call('/api/v1/auth/me', { cookie: token });
  assert.equal(me.json.kind, 'admin');
  assert.equal(me.json.email, who.email);
  assert.equal((await call('/api/v1/garages', { cookie: token })).status, 200);

  const row = (await su.query('SELECT counter, last_used_at, credential_id FROM operator_passkeys WHERE id = $1', [added.json.passkey.id])).rows[0];
  assert.equal(Number(row.counter), key.counter);
  assert.ok(row.last_used_at);
  assert.equal(row.credential_id, key.id);

  // From another site under the same relying party: the same passkey.
  const again = await passkeySignIn(fakeAuthenticatorAt(key, OTHER_SITE), {}, { origin: undefined });
  assert.equal(again.status, 200, again.text);

  const list = await call('/api/v1/auth/passkeys', { cookie: who.token });
  assert.deepEqual(list.json.passkeys.map((p) => p.name), ['Work laptop']);
  const renamed = await call('/api/v1/auth/passkeys/rename', { method: 'POST', cookie: who.token, body: { id: added.json.passkey.id, name: 'Old laptop' } });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.json.passkey.name, 'Old laptop');
  const removed = await call('/api/v1/auth/passkeys/remove', { method: 'POST', cookie: who.token, body: { id: added.json.passkey.id } });
  assert.equal(removed.status, 204);
  assert.deepEqual((await call('/api/v1/auth/passkeys', { cookie: who.token })).json.passkeys, []);
  const gone = await passkeySignIn(key);
  assert.equal(gone.status, 401);

  const lines = (await su.query(
    "SELECT action, subject_kind, actor_kind, before, after FROM garage_changes WHERE tenant_id = $1 AND subject_kind = 'passkey' ORDER BY at, id",
    [who.tenant],
  )).rows;
  assert.deepEqual(lines.map((l) => l.action), ['passkey.add', 'passkey.rename', 'passkey.remove']);
  assert.ok(lines.every((l) => l.actor_kind === 'owner'));
  for (const l of lines) assert.doesNotMatch(JSON.stringify(l), new RegExp(key.publicKey), 'a public key in the log');
});

/** The same authenticator, answering from another origin. */
function fakeAuthenticatorAt(key, origin) {
  return { ...key, signIn: (options, o = {}) => key.signIn(options, { ...o, as: { ...(o.as ?? {}), origin } }) };
}

test('ONE ANSWER FOR EVERY REFUSAL: unknown key, bad signature, wrong origin, wrong relying party, a counter that went back, a used challenge', async () => {
  const who = await account('pk-refuse');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  assert.equal((await add(who, key)).status, 201);
  assert.equal((await passkeySignIn(key)).status, 200);
  const stranger = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  const before = key.counter;
  const refusals = [
    ['an unknown passkey', await passkeySignIn(stranger)],
    ['a signature over something else', await passkeySignIn(key, { as: { tamper: true } })],
    ['another origin', await passkeySignIn(key, { as: { origin: 'https://evil.test' } })],
    ['another relying party', await passkeySignIn(key, { as: { rpId: 'evil.test' } })],
    ['a creation, not a sign-in', await passkeySignIn(key, { as: { type: 'webauthn.create' } })],
    ['another challenge', await passkeySignIn(key, { as: { challenge: 'b3RoZXItY2hhbGxlbmdl' } })],
    ['a copied key: the counter went back', await passkeySignIn(key, { counterTo: before - 1 })],
    ['a copied key: the counter stood still', await passkeySignIn(key, { counterTo: before })],
  ];
  for (const [what, r] of refusals) {
    assert.equal(r.status, 401, `${what}: ${r.text}`);
    assert.equal(r.text, refusals[0][1].text, what);
    assert.deepEqual(r.cookies, [], what);
  }
  assert.deepEqual(refusals[0][1].json, passkeys.REFUSED);
  // A challenge works once.
  const ok = await passkeySignIn(key, { counterTo: before + 10 });
  assert.equal(ok.status, 200);
  const replay = await call('/api/v1/auth/passkey/sign-in', {
    method: 'POST', body: { challenge_id: ok.challenge_id, response: key.signIn(ok.options, { counterTo: before + 11 }) },
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.text, refusals[0][1].text);
  // Nothing moved the counter but the two that were let in.
  const row = (await su.query('SELECT counter FROM operator_passkeys WHERE credential_id = $1', [key.id])).rows[0];
  assert.equal(Number(row.counter), before + 10);
});

test('AN AUTHENTICATOR THAT KEEPS NO COUNTER signs in each time at 0', async () => {
  const who = await account('pk-zero');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID, step: 0 });
  assert.equal((await add(who, key)).status, 201);
  assert.equal((await passkeySignIn(key)).status, 200);
  assert.equal((await passkeySignIn(key)).status, 200);
});

test('ADDING IS THE ADMIN\'S OWN: a challenge works once and only for whoever asked; a refused response adds nothing', async () => {
  const a = await account('pk-own-a');
  const b = await account('pk-own-b');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  const o = await call('/api/v1/auth/passkeys/options', { method: 'POST', cookie: a.token });
  // B cannot use A's challenge.
  const stolen = await call('/api/v1/auth/passkeys', { method: 'POST', cookie: b.token, body: { challenge_id: o.json.challenge_id, name: 'X', response: key.register(o.json.options) } });
  assert.equal(stolen.status, 409);
  assert.equal(stolen.json.code, 'passkey_challenge_ended');
  // And the try used it up for A too.
  const late = await call('/api/v1/auth/passkeys', { method: 'POST', cookie: a.token, body: { challenge_id: o.json.challenge_id, name: 'X', response: key.register(o.json.options) } });
  assert.equal(late.status, 409);
  // A response for another origin or relying party is not added.
  for (const as of [{ origin: 'https://evil.test' }, { rpId: 'evil.test' }, { type: 'webauthn.get' }]) {
    const o2 = await call('/api/v1/auth/passkeys/options', { method: 'POST', cookie: a.token });
    const r = await call('/api/v1/auth/passkeys', { method: 'POST', cookie: a.token, body: { challenge_id: o2.json.challenge_id, name: 'X', response: key.register(o2.json.options, { as }) } });
    assert.equal(r.status, 400, JSON.stringify(as));
    assert.equal(r.json.code, 'passkey_not_added');
  }
  // A name is 1 to 60 characters with no control character.
  for (const name of ['', '   ', 'x'.repeat(61), 'tab\there', 42]) {
    const r = await add(a, key, name);
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal(r.json.code, 'passkey_name_refused');
  }
  assert.equal((await su.query('SELECT 1 FROM operator_passkeys WHERE tenant_id = $1', [a.tenant])).rowCount, 0);
  // Added once; the same key again is refused.
  assert.equal((await add(a, key)).status, 201);
  const twice = await add(a, key);
  assert.equal(twice.status, 409);
});

test('ANOTHER ADMIN\'S PASSKEY is not one of yours: not listed, not renamed, not removed', async () => {
  const a = await account('pk-iso-a');
  const b = await account('pk-iso-b');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  const id = (await add(a, key)).json.passkey.id;
  assert.deepEqual((await call('/api/v1/auth/passkeys', { cookie: b.token })).json.passkeys, []);
  for (const [path, body] of [['/api/v1/auth/passkeys/rename', { id, name: 'Mine now' }], ['/api/v1/auth/passkeys/remove', { id }]]) {
    const r = await call(path, { method: 'POST', cookie: b.token, body });
    assert.equal(r.status, 404, path);
    assert.equal(r.json.code, 'passkey_not_found');
  }
  for (const body of [{}, { id: 'not-an-id' }, { id, extra: 1 }]) {
    assert.equal((await call('/api/v1/auth/passkeys/remove', { method: 'POST', cookie: a.token, body })).status, 404, JSON.stringify(body));
  }
  const row = (await su.query('SELECT name FROM operator_passkeys WHERE id = $1', [id])).rows[0];
  assert.equal(row.name, 'Laptop');
});

test('THE ADMIN\'S PASSKEY ROUTES need the session: none is 401, a foreign Origin 403, a linked person 409', async () => {
  const a = await account('pk-session');
  assert.equal((await call('/api/v1/auth/passkeys')).status, 401);
  assert.equal((await call('/api/v1/auth/passkeys/options', { method: 'POST', cookie: a.token, origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('/api/v1/auth/passkey/options', { method: 'POST', origin: 'https://evil.test' })).status, 403);
  const p = door.person(a.tenant);
  const linked = tokenOf(await call('/api/v1/auth/sign-in', { method: 'POST', body: { email: p.email, password: p.password } }));
  const r = await call('/api/v1/auth/passkeys', { cookie: linked });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, passkeys.ELSEWHERE);
});

test('THE PASSWORD STAYS: a reset keeps the passkeys, and both still sign in', async () => {
  const a = await account('pk-reset');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  assert.equal((await add(a, key)).status, 201);
  await resetAdminPassword({ email: a.email, password: 'a brand new password here' });
  assert.equal((await su.query('SELECT 1 FROM operator_passkeys WHERE tenant_id = $1', [a.tenant])).rowCount, 1);
  assert.equal((await passkeySignIn(key)).status, 200);
  const pw = await call('/api/v1/auth/sign-in', { method: 'POST', body: { email: a.email, password: 'a brand new password here' } });
  assert.equal(pw.status, 200);
});

test('A LINKED PERSON\'S PASSKEY is the module\'s: found through the door, its counter recorded there, a replay refused', async () => {
  const a = await account('pk-linked');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  const p = door.person(a.tenant, { garages: [a.world.garage], permissions: ['stays:read'] });
  door.edit((s) => {
    s.passkeys[key.id] = { person: p.person, tenant: a.tenant, public_key: key.publicKey, counter: 0, transports: ['internal'] };
  });
  door.forget();
  const r = await passkeySignIn(key);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.email, p.email);
  assert.deepEqual(door.calls().map((c) => c.argv[0]), ['passkey', 'passkey-used', 'who']);
  assert.equal(door.read().passkeys[key.id].counter, key.counter);
  const me = await call('/api/v1/auth/me', { cookie: tokenOf(r) });
  assert.equal(me.json.kind, 'linked');
  assert.deepEqual(me.json.permissions, ['stays:read']);

  // A counter the module says did not go up is refused, as every refusal is.
  const copied = await passkeySignIn(key, { counterTo: key.counter });
  assert.equal(copied.status, 401);
  assert.deepEqual(copied.json, passkeys.REFUSED);
  // A person the module no longer has is refused, though the key is good.
  door.change(p.person, { gone: true });
  const gone = await passkeySignIn(key);
  assert.equal(gone.status, 401);
  // A module that cannot decide lets nobody in.
  door.change(p.person, { gone: false });
  door.setMode('exit2', ['passkey']);
  try {
    const undecided = await passkeySignIn(key);
    assert.equal(undecided.status, 503);
    assert.deepEqual(undecided.cookies, []);
  } finally {
    door.setMode('normal');
  }
  // With no door named, a linked passkey is just unknown.
  door.name(false);
  try {
    assert.equal((await passkeySignIn(key)).status, 401);
  } finally {
    door.name(true);
  }
});
