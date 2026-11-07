/**
 * What POST /auth/sign-in and POST /auth/forgot answer, written down to the
 * byte: status, body, floor, the headers a caller reads, and the log lines.
 *
 * This file names nothing that came after them, so it runs unchanged on the
 * code from before their statements were shared with another door. It passing
 * on both sides of that change is the proof the change moved code and nothing
 * else (README, "A trusted server's door"). Wording here is held because it is
 * what the public doors say today, not because anyone chose it for this file.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { pool, createTenant, superuserClient } from './helpers.js';
import { createAdmin } from '../src/adminAccount.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const PASSWORD = 'correct horse battery staple';
const WRONG = 'incorrect horse battery staple';
const FLOOR_MS = 500;

const REFUSED = '{"error":"Sign-in refused. Check the email and password.","code":"sign_in_refused"}';
const UNREADABLE = '{"error":"The sign-in request could not be read. Send JSON: {\\"email\\", \\"password\\"}.","code":"sign_in_unreadable"}';
const RATE_LIMITED = '{"error":"Too many sign-in attempts from here. Try again later.","code":"sign_in_rate_limited"}';
const BUSY = '{"error":"Sign-in is busy. Try again in a moment.","code":"sign_in_busy"}';
const ORIGIN_REFUSED = '{"error":"This request did not come from the admin site.","code":"origin_refused"}';
const NOT_CONFIGURED = '{"error":"This deployment has no admin origin configured, so owner sign-in is off.","code":"sign_in_not_configured"}';
const FORGOT_SENT = '{"message":"If that email names an account, a link to choose a new password is on its way. It works once, for one hour."}';
const FORGOT_UNREADABLE = '{"error":"The request could not be read. Send JSON: {\\"email\\"}.","code":"forgot_unreadable"}';
const LINK_RATE_LIMITED = '{"error":"Too many attempts from here. Try again later.","code":"link_rate_limited"}';

let su;
const printed = [];
const real = { log: console.log, error: console.error, warn: console.warn };
const printedSince = (mark) => printed.slice(mark);

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
const keyFile = join(mkdtempSync(join(tmpdir(), 'openparking-held-')), 'email_key');
writeFileSync(keyFile, 're_stub_held\n');
chmodSync(keyFile, 0o600);

const servers = [];
async function serve(env = {}) {
  const all = { ADMIN_ORIGIN, ...env };
  const saved = {};
  for (const [k, v] of Object.entries(all)) {
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
  return `http://127.0.0.1:${server.address().port}`;
}

let serviceUrl;
const unique = (tag) => `${tag}-${randomBytes(5).toString('hex')}@example.com`;

async function admin(tag, password = PASSWORD) {
  const tenant = await createTenant(tag);
  const email = unique(tag);
  await createAdmin({ tenantId: tenant, email, password });
  return { tenant, email };
}

async function post(base, path, body, { origin = ADMIN_ORIGIN, raw, type = 'application/json' } = {}) {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': type, ...(origin ? { origin } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, took: performance.now() - started };
}

const signIn = (base, email, password, options) => post(base, '/api/v1/auth/sign-in', { email, password }, options);
const forgot = (base, email, options) => post(base, '/api/v1/auth/forgot', { email }, options);

function held(r, status, text) {
  assert.equal(r.status, status);
  assert.equal(r.text, text);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.took >= FLOOR_MS - 5, `answered in ${Math.round(r.took)} ms, under the floor of ${FLOOR_MS}`);
}

before(async () => {
  console.log = (...a) => { printed.push(a.join(' ')); };
  console.error = (...a) => { printed.push(a.join(' ')); };
  console.warn = (...a) => { printed.push(a.join(' ')); };
  su = superuserClient();
  await su.connect();
  service.listen(0, '127.0.0.1');
  await new Promise((r) => service.once('listening', r));
  serviceUrl = `http://127.0.0.1:${service.address().port}`;
});

after(async () => {
  Object.assign(console, real);
  for (const s of servers) s.close();
  service.close();
  await su.end();
  await pool.end();
});

test('SIGN-IN: the right password: 200, the body, a cookie, and no line in the log', async () => {
  const base = await serve();
  const who = await admin('held-right');
  const mark = printed.length;
  const r = await signIn(base, who.email.toUpperCase(), PASSWORD);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.deepEqual(Object.keys(body), ['email', 'tenant_id', 'session_ends_at', 'language']);
  assert.equal(body.email, who.email);
  assert.equal(body.tenant_id, who.tenant);
  assert.equal(body.language, 'en');
  const cookie = r.headers.getSetCookie();
  assert.equal(cookie.length, 2);
  assert.match(cookie[0], /^op_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.deepEqual(printedSince(mark), []);
});

test('SIGN-IN: every refusal is the one sentence at the floor, and writes no line', async () => {
  const base = await serve();
  const who = await admin('held-wrong');
  const mark = printed.length;
  held(await signIn(base, who.email, WRONG), 401, REFUSED);
  held(await signIn(base, unique('held-nobody'), PASSWORD), 401, REFUSED);
  assert.deepEqual(printedSince(mark), []);
  const { rows } = await su.query('SELECT address, failed_count, locked_until FROM operator_sign_in_locks WHERE tenant_id = $1', [who.tenant]);
  assert.deepEqual(rows, [{ address: '127.0.0.1', failed_count: 1, locked_until: null }]);
});

test('SIGN-IN: ten wrong lock that address, a right password is then the same refusal, and the row is as it was', async () => {
  const base = await serve({ SIGN_IN_ATTEMPTS_PER_ADDRESS: '100' });
  const who = await admin('held-lock');
  for (let i = 0; i < 10; i += 1) assert.equal((await signIn(base, who.email, WRONG)).status, 401);
  held(await signIn(base, who.email, PASSWORD), 401, REFUSED);
  const { rows } = await su.query('SELECT failed_count, locked_until > now() AS locked FROM operator_sign_in_locks WHERE tenant_id = $1', [who.tenant]);
  assert.deepEqual(rows, [{ failed_count: 10, locked: true }]);
});

test('SIGN-IN: what cannot be read, and what is not from the admin site', async () => {
  const base = await serve();
  held(await post(base, '/api/v1/auth/sign-in', {}, { raw: 'nonsense' }), 400, UNREADABLE);
  held(await post(base, '/api/v1/auth/sign-in', { email: 'a@b.c' }), 400, UNREADABLE);
  held(await post(base, '/api/v1/auth/sign-in', { email: 'a@b.c', password: 'x' }, { type: 'text/plain' }), 400, UNREADABLE);
  held(await signIn(base, 'a@b.c', 'x', { origin: 'https://elsewhere.example.test' }), 403, ORIGIN_REFUSED);
  const off = await serve({ ADMIN_ORIGIN: undefined });
  held(await signIn(off, 'a@b.c', 'x'), 409, NOT_CONFIGURED);
});

test('SIGN-IN: past the limit, the one sentence, with no Retry-After', async () => {
  const base = await serve({ SIGN_IN_ATTEMPTS_PER_ADDRESS: '2' });
  await signIn(base, unique('held-limit'), WRONG);
  await signIn(base, unique('held-limit'), WRONG);
  const r = await signIn(base, unique('held-limit'), WRONG);
  held(r, 429, RATE_LIMITED);
  assert.equal(r.headers.get('retry-after'), null);
});

test('SIGN-IN: a full hash line is 503, Retry-After 2', async () => {
  const base = await serve({ SIGN_IN_HASH_LINE: '1', SIGN_IN_HASH_LINE_PER_ADDRESS: '1' });
  const rs = await Promise.all([signIn(base, unique('held-line'), WRONG), signIn(base, unique('held-line'), WRONG), signIn(base, unique('held-line'), WRONG)]);
  const full = rs.filter((r) => r.status === 503);
  assert.ok(full.length >= 1);
  for (const r of full) {
    held(r, 503, BUSY);
    assert.equal(r.headers.get('retry-after'), '2');
  }
});

test('SIGN-IN: a stored hash this code cannot read is a 500 at the floor, logged by its class', async () => {
  const base = await serve();
  const who = await admin('held-broken');
  await su.query(`UPDATE operator_users SET password_hash = 'scrypt$broken' WHERE tenant_id = $1`, [who.tenant]);
  const mark = printed.length;
  held(await signIn(base, who.email, PASSWORD), 500, '{"error":"internal error"}');
  assert.deepEqual(printedSince(mark), ['[auth] sign-in failed: PasswordHashUnrecognised']);
});

test('FORGOT: the same answer whoever it names, at the floor, and one email for the admin alone', async () => {
  const base = await serve({ EMAIL_KEY_FILE: keyFile, EMAIL_FROM: 'Open Parking <invites@example.com>', EMAIL_API_URL: serviceUrl });
  const who = await admin('held-forgot');
  const nobody = unique('held-forgot-nobody');
  const mark = printed.length;
  held(await forgot(base, who.email), 200, FORGOT_SENT);
  held(await forgot(base, nobody), 200, FORGOT_SENT);
  for (let i = 0; i < 100 && outbox.filter((m) => m.to.includes(who.email)).length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  const sent = outbox.filter((m) => m.to.includes(who.email));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /https:\/\/admin\.example\.test\/#reset=opr_[A-Za-z0-9_-]{43}/);
  assert.equal(outbox.filter((m) => m.to.includes(nobody)).length, 0);
  assert.deepEqual(printedSince(mark), []);
  const { rows } = await su.query('SELECT count(*)::int AS n FROM operator_password_resets WHERE tenant_id = $1', [who.tenant]);
  assert.equal(rows[0].n, 1);
});

test('FORGOT: what cannot be read, and past the limit', async () => {
  const base = await serve({ ACCOUNT_LINK_ATTEMPTS_PER_ADDRESS: '2' });
  held(await post(base, '/api/v1/auth/forgot', {}, { raw: 'nonsense' }), 400, FORGOT_UNREADABLE);
  held(await post(base, '/api/v1/auth/forgot', { email: 'a@b.c', extra: 'x' }), 400, FORGOT_UNREADABLE);
  await forgot(base, unique('held-forgot-limit'));
  await forgot(base, unique('held-forgot-limit'));
  const r = await forgot(base, unique('held-forgot-limit'));
  held(r, 429, LINK_RATE_LIMITED);
  assert.equal(r.headers.get('retry-after'), null);
});
