/**
 * Passkeys (0047; README, "Passkeys for the admin"), with a software
 * authenticator (test/fakeAuthenticator.js) whose bytes the real verification
 * checks unchanged: the admin's own, added, named, listed and removed behind
 * the session, adding one proved again by the password and told by email; a
 * sign-in with one, held to one answer for every refusal and to a verified
 * person; a copied key turned off; the challenges in the database; a password
 * reset taking every passkey; a linked person's, kept by the module and asked
 * for through its door.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const NEW_PASSWORD = 'a brand new horse battery staple';
const FLOOR_MS = 200;
const ROOT = join(import.meta.dirname, '..');

const door = accountsStandIn();
const servers = [];
let main;
let off;
let quiet;
let proxied;
let su;

// --- the stand-in for the email service: every message kept -------------------------------

const outbox = [];
const service = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    outbox.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"stub-message"}');
  });
});
const keyDir = mkdtempSync(join(tmpdir(), 'openparking-passkeys-email-'));
const KEY_FILE = join(keyDir, 'email_key');
writeFileSync(KEY_FILE, 're_stub_passkeys_test_key\n');
chmodSync(KEY_FILE, 0o600);
let emailEnv;

/** Messages sent to `to`, waited for: a notice is sent after the answer. */
async function mailTo(to, count = 1, within = 5000) {
  const until = Date.now() + within;
  for (;;) {
    const got = outbox.filter((m) => m.to.includes(to));
    if (got.length >= count || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 20));
  }
}

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

async function call(path, { method = 'GET', body, cookie, origin = ADMIN_ORIGIN, base = main.base, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = `${signIn.COOKIE}=${cookie}`;
  if (origin) h.origin = origin;
  const started = performance.now();
  const res = await fetch(`${base}${path}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  return { status: res.status, text, json, cookies: res.headers.getSetCookie(), ms: performance.now() - started };
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
async function add(who, key, name = 'Laptop', { base = main.base, register = {} } = {}) {
  const o = await call('/api/v1/auth/passkeys/options', { method: 'POST', cookie: who.token, base });
  assert.equal(o.status, 200, o.text);
  return call('/api/v1/auth/passkeys', { method: 'POST', cookie: who.token, base, body: { challenge_id: o.json.challenge_id, name, response: key.register(o.json.options, register) } });
}

/** A passkey sign-in; `as` bends the response (test/fakeAuthenticator.js). */
async function passkeySignIn(key, signOptions = {}, { origin = ADMIN_ORIGIN, base } = {}) {
  const o = await call('/api/v1/auth/passkey/options', { method: 'POST', origin, base });
  assert.equal(o.status, 200, o.text);
  const r = await call('/api/v1/auth/passkey/sign-in', { method: 'POST', origin, base, body: { challenge_id: o.json.challenge_id, response: key.signIn(o.json.options, signOptions) } });
  return { ...r, challenge_id: o.json.challenge_id, options: o.json.options };
}

/** The session's password proof, aged past the five minutes adding a passkey allows. */
const agePassword = (token) => su.query(
  "UPDATE operator_tokens SET password_at = now() - interval '6 minutes' WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [token],
);

before(async () => {
  su = superuserClient();
  await su.connect();
  // Only this file makes challenges; none is left from a run before.
  await su.query('DELETE FROM passkey_challenges');
  service.listen(0, '127.0.0.1');
  await new Promise((r) => service.once('listening', r));
  emailEnv = { EMAIL_KEY_FILE: KEY_FILE, EMAIL_FROM: 'Open Parking <sign-in@example.com>', EMAIL_API_URL: `http://127.0.0.1:${service.address().port}/emails` };
  const common = { ADMIN_ORIGIN, SIGN_IN_REFUSAL_FLOOR_MS: String(FLOOR_MS), ACCOUNTS_SIGN_IN_FLOOR_MS: String(FLOOR_MS), SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000' };
  const on = { PASSKEY_RP_ID: RP_ID, PASSKEY_ORIGINS: `${ADMIN_ORIGIN},${OTHER_SITE}` };
  main = await serve({ ...common, ...on, ...emailEnv });
  off = await serve({ ...common, PASSKEY_RP_ID: undefined });
  quiet = await serve({ ...common, ...on, EMAIL_KEY_FILE: undefined, EMAIL_FROM: undefined, EMAIL_API_URL: undefined });
  proxied = await serve({ ...common, ...on, TRUST_PROXY: '1' });
});

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await new Promise((r) => service.close(r));
  await su.query('DELETE FROM passkey_challenges');
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

test('THE ADMIN ADDS ONE AND SIGNS IN WITH IT: the cookie works, the counter moves, every step is on the change log, and the admin is told by email', async () => {
  const who = await account('pk-add');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  const added = await add(who, key, '  Work laptop  ');
  assert.equal(added.status, 201, added.text);
  assert.deepEqual(Object.keys(added.json.passkey).sort(), ['created_at', 'disabled_at', 'id', 'last_used_at', 'name']);
  assert.equal(added.json.passkey.name, 'Work laptop');
  assert.equal(added.json.passkey.last_used_at, null);
  assert.equal(added.json.passkey.disabled_at, null);

  // The account holder is told, after the answer: the name and when, never the key.
  const [notice] = await mailTo(who.email);
  assert.ok(notice, 'no notice was sent');
  assert.equal(notice.subject, 'A passkey was added to your Open Parking account');
  assert.match(notice.text, /A passkey named "Work laptop" was added/);
  assert.match(notice.text, /reset your password now/);
  assert.equal(notice.text.includes(key.publicKey), false, 'a public key in the email');
  assert.equal(notice.text.includes(key.id), false, 'a credential id in the email');

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

test('NO EMAIL CONFIGURED: a passkey is still added, and the log says the notice was not sent -- never to whom', async () => {
  const signedIn = await call('/api/v1/auth/sign-in', { base: quiet.base, method: 'POST', body: { email: (await account('pk-quiet')).email, password: PASSWORD } });
  const who = { email: signedIn.json.email, token: tokenOf(signedIn) };
  const said = [];
  const log = console.log;
  console.log = (...args) => { said.push(args.join(' ')); };
  try {
    const added = await add(who, fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID }), 'Phone', { base: quiet.base });
    assert.equal(added.status, 201, added.text);
    const until = Date.now() + 3000;
    while (!said.some((l) => l.includes('passkey-added notice')) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  } finally {
    console.log = log;
  }
  const line = said.find((l) => l.includes('passkey-added notice'));
  assert.equal(line, '[email] the passkey-added notice was not sent: no email is configured here');
  assert.equal(outbox.some((m) => m.to.includes(who.email)), false);
});

/** The same authenticator, answering from another origin. */
function fakeAuthenticatorAt(key, origin) {
  return { ...key, signIn: (options, o = {}) => key.signIn(options, { ...o, as: { ...(o.as ?? {}), origin } }) };
}

test('ONE ANSWER FOR EVERY REFUSAL: unknown key, bad signature, wrong origin, wrong relying party, no user verification, a used challenge', async () => {
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
    ['present but not verified', await passkeySignIn(key, { as: { uv: false } })],
  ];
  for (const [what, r] of refusals) {
    assert.equal(r.status, 401, `${what}: ${r.text}`);
    assert.equal(r.text, refusals[0][1].text, what);
    assert.deepEqual(r.cookies, [], what);
    assert.ok(r.ms >= FLOOR_MS - 5, `${what}: answered in ${r.ms} ms, before the floor`);
  }
  assert.deepEqual(refusals[0][1].json, passkeys.REFUSED);
  // None of them turned the key off: each failed before its counter was read.
  const ok = await passkeySignIn(key, { counterTo: before + 10 });
  assert.equal(ok.status, 200, ok.text);
  // A challenge works once.
  const replay = await call('/api/v1/auth/passkey/sign-in', {
    method: 'POST', body: { challenge_id: ok.challenge_id, response: key.signIn(ok.options, { counterTo: before + 11 }) },
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.text, refusals[0][1].text);
  // Nothing moved the counter but the two that were let in.
  const row = (await su.query('SELECT counter, disabled_at FROM operator_passkeys WHERE credential_id = $1', [key.id])).rows[0];
  assert.equal(Number(row.counter), before + 10);
  assert.equal(row.disabled_at, null);
});

test('USER VERIFICATION IS REQUIRED: both steps ask for it, and a key that only sees the person present is neither added nor let in', async () => {
  const who = await account('pk-uv');
  const o = await call('/api/v1/auth/passkeys/options', { method: 'POST', cookie: who.token });
  assert.equal(o.json.options.authenticatorSelection.userVerification, 'required');
  // A key with no PIN: present, not verified. Not added, nothing stored.
  const noPin = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID, uv: false });
  const refused = await call('/api/v1/auth/passkeys', { method: 'POST', cookie: who.token, body: { challenge_id: o.json.challenge_id, name: 'Key', response: noPin.register(o.json.options) } });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.json.code, 'passkey_not_added');
  assert.equal((await su.query('SELECT 1 FROM operator_passkeys WHERE tenant_id = $1', [who.tenant])).rowCount, 0);
  // Verified, it is added; a sign-in asks for verification too.
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  assert.equal((await add(who, key)).status, 201);
  const presentOnly = await passkeySignIn(key, { as: { uv: false } });
  assert.equal(presentOnly.options.userVerification, 'required');
  assert.equal(presentOnly.status, 401);
  assert.deepEqual(presentOnly.json, passkeys.REFUSED);
  assert.equal((await passkeySignIn(key)).status, 200);
});

test('A COPIED KEY IS TURNED OFF: a counter that went back or stood still, behind a good signature, is refused as any refusal, turns the passkey off, and is a line', async () => {
  for (const [what, back] of [['went back', 1], ['stood still', 0]]) {
    const who = await account('pk-copied');
    const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
    const id = (await add(who, key)).json.passkey.id;
    assert.equal((await passkeySignIn(key, { counterTo: 7 })).status, 200);
    const copied = await passkeySignIn(key, { counterTo: 7 - back });
    assert.equal(copied.status, 401, what);
    assert.deepEqual(copied.json, passkeys.REFUSED, what);
    const row = (await su.query('SELECT counter, disabled_at FROM operator_passkeys WHERE id = $1', [id])).rows[0];
    assert.ok(row.disabled_at, `${what}: the passkey was not turned off`);
    assert.equal(Number(row.counter), 7, `${what}: the counter moved`);
    // Turned off for good: the real key, its counter well ahead, is refused too.
    assert.equal((await passkeySignIn(key, { counterTo: 50 })).status, 401, what);
    // The admin sees it, and the log has the line, naming nobody and no key.
    const listed = (await call('/api/v1/auth/passkeys', { cookie: who.token })).json.passkeys;
    assert.ok(listed[0].disabled_at, what);
    const lines = (await su.query(
      "SELECT actor_kind, actor_id, garage_id, subject_id, after FROM garage_changes WHERE tenant_id = $1 AND action = 'passkey.turn_off'", [who.tenant],
    )).rows;
    assert.equal(lines.length, 1, what);
    assert.deepEqual(lines[0], { actor_kind: 'nobody', actor_id: null, garage_id: null, subject_id: id, after: { turned_off: true, why: 'counter_not_up' } });
    assert.doesNotMatch(JSON.stringify(lines), new RegExp(key.publicKey));
  }
});

test('THE COUNTER GUARD IS THE DATABASE\'S: two good signatures with one counter at once let one in and turn the key off; the guard itself, value by value', async () => {
  const who = await account('pk-race');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  const id = (await add(who, key)).json.passkey.id;
  assert.equal((await passkeySignIn(key, { counterTo: 3 })).status, 200);
  const [o1, o2] = await Promise.all([1, 2].map(() => call('/api/v1/auth/passkey/options', { method: 'POST' })));
  const r1 = key.signIn(o1.json.options, { counterTo: 4 });
  const r2 = key.signIn(o2.json.options, { counterTo: 4 });
  const answers = await Promise.all([[o1, r1], [o2, r2]].map(([o, response]) =>
    call('/api/v1/auth/passkey/sign-in', { method: 'POST', body: { challenge_id: o.json.challenge_id, response } })));
  assert.deepEqual(answers.map((a) => a.status).sort(), [200, 401]);
  const row = (await su.query('SELECT counter, disabled_at FROM operator_passkeys WHERE id = $1', [id])).rows[0];
  assert.equal(Number(row.counter), 4);
  assert.ok(row.disabled_at, 'the second use of one counter did not turn the key off');

  // The guard on its own: up is used, equal or back turns off, 0 and 0 is used.
  const fresh = async (counter) => {
    const k = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
    const pid = (await add(who, k, `Key ${counter}`)).json.passkey.id;
    await su.query('UPDATE operator_passkeys SET counter = $2 WHERE id = $1', [pid, counter]);
    return pid;
  };
  for (const [stored, next, expected] of [[5, 6, 'used'], [5, 5, 'turned_off'], [5, 4, 'turned_off'], [0, 0, 'used'], [0, 1, 'used'], [5, 0, 'turned_off']]) {
    const pid = await fresh(stored);
    assert.equal(await passkeys.internals.useAdminPasskey(who.tenant, pid, next), expected, `${stored} -> ${next}`);
    const after = (await su.query('SELECT counter, disabled_at IS NOT NULL AS off FROM operator_passkeys WHERE id = $1', [pid])).rows[0];
    assert.deepEqual([Number(after.counter), after.off], expected === 'used' ? [next, false] : [stored, true], `${stored} -> ${next}`);
    // Turned off is final: the next use finds nothing to judge.
    if (expected === 'turned_off') assert.equal(await passkeys.internals.useAdminPasskey(who.tenant, pid, stored + 100), 'gone');
  }
});

test('AN AUTHENTICATOR THAT KEEPS NO COUNTER signs in each time at 0', async () => {
  const who = await account('pk-zero');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID, step: 0 });
  assert.equal((await add(who, key)).status, 201);
  assert.equal((await passkeySignIn(key)).status, 200);
  assert.equal((await passkeySignIn(key)).status, 200);
});

test('ADDING IS THE ADMIN\'S OWN: a challenge works once and only for the session that asked; a refused response adds nothing', async () => {
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
  // Nor can A's other session: the challenge is the session's that asked.
  const second = tokenOf(await call('/api/v1/auth/sign-in', { method: 'POST', body: { email: a.email, password: PASSWORD } }));
  const o3 = await call('/api/v1/auth/passkeys/options', { method: 'POST', cookie: a.token });
  const otherSession = await call('/api/v1/auth/passkeys', { method: 'POST', cookie: second, body: { challenge_id: o3.json.challenge_id, name: 'X', response: key.register(o3.json.options) } });
  assert.equal(otherSession.status, 409);
  assert.equal(otherSession.json.code, 'passkey_challenge_ended');
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

test('ADDING IS PROVED AGAIN: past five minutes from the password, or on a passkey\'s session, the password is asked for; a wrong one is counted and refused as a locked address is', async () => {
  const who = await account('pk-again');
  const options = (body, cookie = who.token) => call('/api/v1/auth/passkeys/options', { method: 'POST', cookie, body });
  // Just signed in with the password: no password needed.
  assert.equal((await options()).status, 200);
  // Five minutes on, the cookie alone adds nothing.
  await agePassword(who.token);
  const asked = await options();
  assert.equal(asked.status, 403, asked.text);
  assert.deepEqual(asked.json, signIn.PASSWORD_REQUIRED);
  // A wrong password: refused at the floor, and counted toward this address's lock.
  const wrong = await options({ password: 'not the password at all' });
  assert.equal(wrong.status, 403);
  assert.deepEqual(wrong.json, signIn.PASSWORD_NOT_ACCEPTED);
  assert.ok(wrong.ms >= FLOOR_MS - 5, `answered in ${wrong.ms} ms, before the floor`);
  const lock = async () => (await su.query('SELECT failed_count, locked_until > now() AS locked FROM operator_sign_in_locks WHERE tenant_id = $1', [who.tenant])).rows[0];
  assert.equal((await lock()).failed_count, 1);
  // Anything but {password} is not read.
  for (const body of [{ password: 'x', extra: 1 }, { pass: PASSWORD }, [PASSWORD]]) {
    const r = await options(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, 'passkey_unreadable');
  }
  // The right one: proved now, so the next ask needs none.
  const right = await options({ password: PASSWORD });
  assert.equal(right.status, 200, right.text);
  assert.equal((await options()).status, 200);
  // Ten wrong ones lock the address; then even the right one is refused, as a wrong one is.
  await agePassword(who.token);
  for (let i = 0; i < signIn.MAX_FAILED; i += 1) assert.equal((await options({ password: `wrong password number ${i}` })).status, 403);
  assert.equal((await lock()).locked, true);
  const lockedRight = await options({ password: PASSWORD });
  assert.equal(lockedRight.status, 403);
  assert.equal(lockedRight.text, wrong.text, 'a locked address is told apart from a wrong password');
  // The lock is sign-in's own: the password does not sign in from here either.
  assert.equal((await call('/api/v1/auth/sign-in', { method: 'POST', body: { email: who.email, password: PASSWORD } })).status, 401);
  await su.query('DELETE FROM operator_sign_in_locks WHERE tenant_id = $1', [who.tenant]);

  // A session signed in with a passkey has proved no password.
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  const fresh = tokenOf(await call('/api/v1/auth/sign-in', { method: 'POST', body: { email: who.email, password: PASSWORD } }));
  assert.equal((await add({ token: fresh }, key)).status, 201);
  const byPasskey = tokenOf(await passkeySignIn(key));
  const viaPasskey = await options(undefined, byPasskey);
  assert.equal(viaPasskey.status, 403);
  assert.deepEqual(viaPasskey.json, signIn.PASSWORD_REQUIRED);
  assert.equal((await options({ password: PASSWORD }, byPasskey)).status, 200);
  await su.query('DELETE FROM passkey_challenges');
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

test('A PASSWORD RESET TAKES EVERY PASSKEY: by the emailed link and by the command, each removes them and tells the admin; the password signs in', async () => {
  // By the emailed link.
  const a = await account('pk-reset-link');
  const keys = [fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID }), fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID })];
  for (const [i, k] of keys.entries()) assert.equal((await add(a, k, `Key ${i}`)).status, 201);
  const sentBefore = (await mailTo(a.email, 2)).length;
  assert.equal((await call('/api/v1/auth/forgot', { method: 'POST', body: { email: a.email } })).status, 200);
  const resetMail = (await mailTo(a.email, sentBefore + 1)).at(-1);
  assert.match(resetMail.text, /signs out every session of the account and removes its passkeys/);
  const token = /#reset=(opr_[A-Za-z0-9_-]{43})/.exec(resetMail.text)[1];
  const done = await call('/api/v1/auth/reset', { method: 'POST', body: { token, password: NEW_PASSWORD } });
  assert.equal(done.status, 200, done.text);
  assert.equal((await su.query('SELECT 1 FROM operator_passkeys WHERE tenant_id = $1', [a.tenant])).rowCount, 0, 'a passkey outlived the reset');
  const told = (await mailTo(a.email, sentBefore + 2)).at(-1);
  assert.equal(told.subject, 'Your Open Parking passkeys were removed');
  assert.match(told.text, /Its 2 passkeys were removed with it/);
  for (const k of keys) assert.equal((await passkeySignIn(k)).status, 401);
  assert.equal((await call('/api/v1/auth/sign-in', { method: 'POST', body: { email: a.email, password: NEW_PASSWORD } })).status, 200);

  // By the command, as the function and as the script with email configured.
  const b = await account('pk-reset-cli');
  const kb = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  assert.equal((await add(b, kb)).status, 201);
  const out = await resetAdminPassword({ email: b.email, password: NEW_PASSWORD });
  assert.equal(out.passkeys_removed, 1);
  assert.equal((await passkeySignIn(kb)).status, 401);
  const c = await account('pk-reset-cmd');
  assert.equal((await add(c, fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID }))).status, 201);
  const file = join(keyDir, 'new-password');
  writeFileSync(file, NEW_PASSWORD, { mode: 0o600 });
  chmodSync(file, 0o600);
  // Not spawnSync: the command sends its notice to the stand-in, which answers from this process.
  const run = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/reset-admin-password.js', '--email', c.email, '--password-file', file], {
      cwd: ROOT, env: { ...process.env, ...emailEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1 passkey\(s\) removed/);
  assert.match(run.stdout, /the admin was told by email that their passkeys were removed/);
  assert.equal((await su.query('SELECT 1 FROM operator_passkeys WHERE tenant_id = $1', [c.tenant])).rowCount, 0);
  assert.match((await mailTo(c.email, 2)).at(-1).text, /Its passkey was removed with it/);
});

test('A PASSKEY ADDED BEFORE THE PASSWORD LAST CHANGED is not found, by whatever path the hash changed', async () => {
  const a = await account('pk-changed');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  assert.equal((await add(a, key)).status, 201);
  assert.equal((await passkeySignIn(key)).status, 200);
  // The hash changed by hand, no reset: the row is still there, and is not found.
  await su.query("UPDATE operator_users SET password_hash = 'scrypt$changed-by-hand' WHERE tenant_id = $1", [a.tenant]);
  assert.equal((await su.query('SELECT 1 FROM operator_passkeys WHERE tenant_id = $1', [a.tenant])).rowCount, 1);
  const r = await passkeySignIn(key);
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, passkeys.REFUSED);
});

test('CHALLENGES ARE THE DATABASE\'S: kept there for five minutes with the owner hashed, made in one process and used in another, taken once when two arrive at once', async () => {
  const a = await account('pk-challenges');
  const signInOptions = await call('/api/v1/auth/passkey/options', { method: 'POST' });
  const row = (await su.query(
    'SELECT purpose, owner, address, extract(epoch FROM expires_at - created_at)::int AS seconds FROM passkey_challenges WHERE id = $1', [signInOptions.json.challenge_id],
  )).rows[0];
  assert.deepEqual(row, { purpose: 'sign_in', owner: null, address: '127.0.0.1', seconds: passkeys.CHALLENGE_SECONDS });
  const registerOptions = await call('/api/v1/auth/passkeys/options', { method: 'POST', cookie: a.token });
  const reg = (await su.query('SELECT purpose, owner FROM passkey_challenges WHERE id = $1', [registerOptions.json.challenge_id])).rows[0];
  assert.equal(reg.purpose, 'register');
  assert.match(reg.owner, /^[0-9a-f]{64}$/);
  assert.equal(reg.owner.includes(a.tenant.replace(/-/g, '')), false);
  await su.query('DELETE FROM passkey_challenges WHERE id = ANY($1)', [[signInOptions.json.challenge_id, registerOptions.json.challenge_id]]);

  // Made by another process (a second instance, or this one before a restart), used here.
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  assert.equal((await add(a, key)).status, 201);
  const made = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const passkeys = await import(${JSON.stringify(new URL('../src/passkeys.js', import.meta.url).href)});
    const { pool } = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)});
    const out = await passkeys.signInOptions({ rpId: ${JSON.stringify(RP_ID)}, origins: [${JSON.stringify(ADMIN_ORIGIN)}], rpName: 'Open Parking' }, 'another-process');
    process.stdout.write(JSON.stringify(out));
    await pool.end();
  `], { cwd: ROOT, encoding: 'utf8', env: process.env });
  assert.equal(made.status, 0, made.stderr);
  const elsewhere = JSON.parse(made.stdout);
  const there = await call('/api/v1/auth/passkey/sign-in', { method: 'POST', body: { challenge_id: elsewhere.challenge_id, response: key.signIn(elsewhere.options) } });
  assert.equal(there.status, 200, there.text);

  // Two sign-ins with one challenge at once: one finds it.
  const o = await call('/api/v1/auth/passkey/options', { method: 'POST' });
  const first = key.signIn(o.json.options);
  const second = key.signIn(o.json.options);
  const both = await Promise.all([first, second].map((response) =>
    call('/api/v1/auth/passkey/sign-in', { method: 'POST', body: { challenge_id: o.json.challenge_id, response } })));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 401]);
});

test('A CHALLENGE ENDS: five minutes on, a sign-in\'s and an adding\'s are refused; ended ones are purged as new ones are made', async () => {
  const a = await account('pk-ended');
  const key = fakeAuthenticator({ origin: ADMIN_ORIGIN, rpId: RP_ID });
  const age = (id) => su.query(
    "UPDATE passkey_challenges SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' WHERE id = $1", [id],
  );
  const reg = await call('/api/v1/auth/passkeys/options', { method: 'POST', cookie: a.token });
  await age(reg.json.challenge_id);
  const late = await call('/api/v1/auth/passkeys', { method: 'POST', cookie: a.token, body: { challenge_id: reg.json.challenge_id, name: 'Late', response: key.register(reg.json.options) } });
  assert.equal(late.status, 409, late.text);
  assert.equal(late.json.code, 'passkey_challenge_ended');
  assert.equal((await add(a, key)).status, 201);
  const o = await call('/api/v1/auth/passkey/options', { method: 'POST' });
  await age(o.json.challenge_id);
  const lateSignIn = await call('/api/v1/auth/passkey/sign-in', { method: 'POST', body: { challenge_id: o.json.challenge_id, response: key.signIn(o.json.options) } });
  assert.equal(lateSignIn.status, 401);
  assert.deepEqual(lateSignIn.json, passkeys.REFUSED);
  // An ended one left behind is gone once a new one is made.
  const left = (await su.query(
    "INSERT INTO passkey_challenges (purpose, challenge, address, created_at, expires_at) VALUES ('sign_in', repeat('a', 43), 'left-behind', now() - interval '6 minutes', now() - interval '1 minute') RETURNING id",
  )).rows[0].id;
  const next = await call('/api/v1/auth/passkey/options', { method: 'POST' });
  assert.equal(next.status, 200);
  assert.equal((await su.query('SELECT 1 FROM passkey_challenges WHERE id = $1', [left])).rowCount, 0, 'an ended challenge was not purged');
  await su.query('DELETE FROM passkey_challenges WHERE id = $1', [next.json.challenge_id]);
});

test('ONE ADDRESS HOLDS A FEW CHALLENGES AT ONCE: past the cap it is 429 passkeys_busy and nothing is kept; another address still gets one', async () => {
  const from = (address) => call('/api/v1/auth/passkey/options', { method: 'POST', base: proxied.base, headers: { 'x-forwarded-for': address } });
  const address = '203.0.113.77';
  for (let i = 0; i < passkeys.CHALLENGES_PER_ADDRESS; i += 1) assert.equal((await from(address)).status, 200, `challenge ${i + 1}`);
  const over = await from(address);
  assert.equal(over.status, 429, over.text);
  assert.equal(over.json.code, 'passkeys_busy');
  assert.equal((await su.query('SELECT count(*)::int AS n FROM passkey_challenges WHERE address = $1', [address])).rows[0].n, passkeys.CHALLENGES_PER_ADDRESS);
  assert.equal((await from('203.0.113.78')).status, 200);
  await su.query("DELETE FROM passkey_challenges WHERE address IN ('203.0.113.77', '203.0.113.78')");
});

test('A LINKED PERSON\'S PASSKEY is the module\'s: found through the door, its counter recorded there, a replay refused, its answer the same person', async () => {
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

  // A counter that did not go up is refused, as every refusal is, before the module is told.
  door.forget();
  const copied = await passkeySignIn(key, { counterTo: key.counter });
  assert.equal(copied.status, 401);
  assert.deepEqual(copied.json, passkeys.REFUSED);
  assert.deepEqual(door.calls().map((c) => c.argv[0]), ['passkey']);
  // Present but not verified is refused for a linked person too.
  assert.equal((await passkeySignIn(key, { as: { uv: false } })).status, 401);
  // The module's answer must be the person the passkey named, in its tenant.
  const other = await createTenant('pk-linked-other');
  for (const over of [{ answer_person: '00000000-0000-4000-8000-000000000001' }, { answer_tenant: other }]) {
    door.change(p.person, over);
    const wrong = await passkeySignIn(key);
    assert.equal(wrong.status, 401, JSON.stringify(over));
    assert.deepEqual(wrong.cookies, []);
    door.change(p.person, { answer_person: undefined, answer_tenant: undefined });
  }
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
  assert.equal((await passkeySignIn(key)).status, 200);
});
