/**
 * An admin by invitation only, and a password reset by email (0032).
 *
 * The invite end to end, against a stand-in for the email service that keeps
 * every message it is sent (never the real service): `invite-admin` run as the
 * command it is, the link read out of the email, and the four doors behind it
 * -- status, accept, forgot and reset -- answered by the real app.
 *
 * Every secret this file handles is kept -- each link's token, each password,
 * each session cookie, the email key -- and at the end none may be in a stored
 * row, a response body or the command's output; `test/account-links-output.test.js`
 * runs this file again with its output captured and holds the same of
 * everything printed. Each finder is shown finding a planted secret first.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, superuserClient } from './helpers.js';
import { createAdmin } from '../src/adminAccount.js';
import { sendEmail } from '../src/email.js';
import * as signIn from '../src/signIn.js';
import * as doors from '../src/accountDoors.js';
import { holdsSecret } from './secrets.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const FOREIGN_ORIGIN = 'https://elsewhere.example.test';
const FROM = 'Open Parking <invites@example.com>';
const NOTICE_TO = 'notices@example.com';
// Invented, and long enough for the length rule.
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new horse battery staple';
const FLOOR_MS = 500;

const secrets = new Set([PASSWORD, NEW_PASSWORD]);
const bodies = [];
const printed = [];
const ROOT = join(import.meta.dirname, '..');
let su; // the superuser, for reading every row and ageing the ones a test needs ended

// --- the stand-in for the email service ------------------------------------------------

const outbox = [];
let serviceAnswers = 200;
const service = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    outbox.push({ authorization: req.headers.authorization, path: req.url, ...JSON.parse(raw) });
    res.writeHead(serviceAnswers, { 'content-type': 'application/json' });
    res.end(JSON.stringify(serviceAnswers === 200 ? { id: 'stub-message' } : { message: 'stub refusal' }));
  });
});
let serviceUrl;

const KEY = `re_stub_${randomBytes(12).toString('hex')}`;
secrets.add(KEY);
const keyDir = mkdtempSync(join(tmpdir(), 'openparking-email-key-'));
const KEY_FILE = join(keyDir, 'resend_api_key');
writeFileSync(KEY_FILE, `${KEY}\n`);
chmodSync(KEY_FILE, 0o600);

/** The settings a deployment that sends email has, pointed at the stand-in. */
const emailEnv = () => ({ ADMIN_ORIGIN, EMAIL_KEY_FILE: KEY_FILE, EMAIL_FROM: FROM, EMAIL_API_URL: serviceUrl, EMAIL_NOTICE_TO: NOTICE_TO });

/** Messages sent to `to`, waited for: a reset and a notice are sent after the answer. */
async function mailTo(to, count = 1, { within = 5000 } = {}) {
  const until = Date.now() + within;
  for (;;) {
    const got = outbox.filter((m) => m.to.includes(to));
    if (got.length >= count || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The token a message's link carries, kept as a secret. */
function tokenIn(message, kind) {
  const m = new RegExp(`${ADMIN_ORIGIN.replace(/[.]/g, '\\.')}/#${kind}=(op[ir]_[A-Za-z0-9_-]{43})`).exec(message.text);
  assert.ok(m, `the ${kind} link is in the email`);
  secrets.add(m[1]);
  return m[1];
}

// --- the app and the command ---------------------------------------------------------------

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

/** fetch, with every body and every cookie value kept for the checks at the end. */
async function call(base, path, { body, raw, headers = {}, cookie, origin = ADMIN_ORIGIN, method = 'POST' } = {}) {
  const h = { ...headers };
  if (body !== undefined || raw !== undefined) h['content-type'] ??= 'application/json';
  if (cookie) h.cookie = `${signIn.COOKIE}=${cookie}`;
  if (origin) h.origin = origin;
  const started = performance.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const ms = performance.now() - started;
  bodies.push(text);
  const cookies = res.headers.getSetCookie();
  for (const c of cookies) {
    const value = c.split(';')[0].split('=').slice(1).join('=');
    if (value) secrets.add(value);
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  return { status: res.status, text, json, headers: res.headers, cookies, ms };
}

const sessionOf = (r) => {
  const c = r.cookies.find((x) => x.startsWith(`${signIn.COOKIE}=`));
  return c ? c.split(';')[0].slice(signIn.COOKIE.length + 1) : null;
};

/** `invite-admin`, run as a command, with the environment a deployment gives it. Never blocks this process. */
function invite(args, env = emailEnv()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/invite-admin.js', ...args], {
      cwd: ROOT,
      env: { ...process.env, ADMIN_ORIGIN: undefined, EMAIL_KEY_FILE: undefined, EMAIL_FROM: undefined, EMAIL_API_URL: undefined, EMAIL_NOTICE_TO: undefined, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => {
      printed.push(stdout, stderr);
      resolve({ status, stdout, stderr });
    });
  });
}
// An undefined in a child's environment is the text "undefined": leave it out instead.
const envOf = (env) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));

const unique = (tag) => `${tag}-${randomBytes(4).toString('hex')}@example.com`;
const LINE = /^invited (\S+) for tenant ([0-9a-f-]{36}); the link ends \d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} UTC\n$/;

/** An invite made by the command, and its token out of the email. */
async function invited(tag, extra = []) {
  const email = unique(tag);
  const r = await invite(['--name', `Garage Co ${tag}`, '--email', email, ...extra], envOf(emailEnv()));
  assert.equal(r.status, 0, r.stderr);
  const [, who, tenant] = LINE.exec(r.stdout) ?? [];
  assert.equal(who, email, r.stdout);
  const [message] = await mailTo(email);
  return { email, tenant, token: tokenIn(message, 'invite'), message, stdout: r.stdout };
}

const tenantsNamed = async (name) => Number((await su.query('SELECT count(*) FROM tenants WHERE name = $1', [name])).rows[0].count);
const invitesOf = async (email) => (await su.query('SELECT * FROM operator_invites WHERE email = $1 ORDER BY created_at', [email])).rows;
const adminOf = async (email) => (await su.query('SELECT * FROM operator_users WHERE email = $1', [email])).rows[0] ?? null;

let main;
let floored;
let limited;
let off;

before(async () => {
  su = superuserClient();
  await su.connect();
  service.listen(0, '127.0.0.1');
  await new Promise((r) => service.once('listening', r));
  serviceUrl = `http://127.0.0.1:${service.address().port}/emails`;
  // The floor at its least, so the many answers here stay quick; the floor's own checks use FLOOR_MS.
  const quick = { SIGN_IN_REFUSAL_FLOOR_MS: '200', SESSION_COOKIE_INSECURE: undefined, TRUST_PROXY: undefined, ACCOUNT_LINK_ATTEMPTS_PER_ADDRESS: '1000' };
  main = await serve({ ...emailEnv(), ...quick });
  floored = await serve({ ...emailEnv(), ...quick, SIGN_IN_REFUSAL_FLOOR_MS: String(FLOOR_MS) });
  limited = await serve({ ...emailEnv(), ...quick, ACCOUNT_LINK_ATTEMPTS_PER_ADDRESS: '2' });
  off = await serve({ ...quick, ADMIN_ORIGIN: undefined, EMAIL_KEY_FILE: undefined, EMAIL_FROM: undefined, EMAIL_NOTICE_TO: undefined, EMAIL_API_URL: undefined });
});

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await new Promise((r) => service.close(r));
  if (process.env.ACCOUNT_LINKS_SECRETS_OUT) writeFileSync(process.env.ACCOUNT_LINKS_SECRETS_OUT, JSON.stringify([...secrets]));
  await su?.end();
  await pool.end();
});

// --- the instruments first -------------------------------------------------------------------

test('CONTROL: the secret finder finds a planted token, plain, JSON-escaped and URL-encoded', () => {
  const token = `opi_${randomBytes(32).toString('base64url')}`;
  for (const planted of [`x ${token} y`, JSON.stringify({ t: token }), `#invite=${encodeURIComponent(token)}`]) {
    assert.equal(holdsSecret(planted, token), true, planted);
  }
  assert.equal(holdsSecret('nothing of the sort', token), false);
});

test('CONTROL: the stand-in keeps what the real sender sends it, the key in the header and nothing else of it', async () => {
  const to = unique('control');
  await sendEmail({ configured: true, keyFile: KEY_FILE, from: FROM, apiUrl: serviceUrl }, { to, subject: 'control', text: 'a control message' });
  const [m] = await mailTo(to);
  assert.deepEqual({ ...m }, { authorization: `Bearer ${KEY}`, path: '/emails', from: FROM, to: [to], subject: 'control', text: 'a control message' });
});

// --- check 1: the invite, end to end ---------------------------------------------------------

test('AN INVITE: the command makes the tenant and one invite, sends ONE email, prints one line and never the link; the link accepts once and signs the admin in', async () => {
  const before = outbox.length;
  const { email, tenant, token, message, stdout } = await invited('one');
  assert.equal(outbox.length, before + 1, 'exactly one email was sent');
  assert.equal(message.from, FROM);
  assert.deepEqual(message.to, [email]);
  assert.equal(message.subject, 'Your Open Parking account');
  assert.match(message.text, /set up the Open Parking account for Garage Co one\./);
  assert.ok(message.text.includes(`${ADMIN_ORIGIN}/#invite=${token}`), 'the token travels in the fragment of a link to the admin site');
  assert.equal(holdsSecret(stdout, token), false, 'the command did not print the link');

  const { rows: [tenantRow] } = await su.query('SELECT name FROM tenants WHERE id = $1', [tenant]);
  assert.equal(tenantRow.name, 'Garage Co one');
  const [row] = await invitesOf(email);
  assert.equal(row.tenant_id, tenant);
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'), 'only its SHA-256 is kept');
  assert.equal(Math.round((row.expires_at - row.created_at) / 3600_000), 7 * 24, 'it lasts seven days');
  assert.equal(await adminOf(email), null, 'no admin until the link is used');

  const status = await call(main.base, '/api/v1/auth/invite/status', { body: { token } });
  assert.equal(status.status, 200);
  assert.deepEqual({ ...status.json, expires_at: undefined }, { status: 'ready', message: doors.INVITE_SENTENCES.ready, email, language: 'en', expires_at: undefined });

  const accepted = await call(main.base, '/api/v1/auth/invite/accept', { body: { token, password: PASSWORD, language: 'es' } });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.email, email);
  assert.equal(accepted.json.tenant_id, tenant);
  assert.equal(accepted.json.language, 'es', "the admin's language is the one chosen at accept");
  const session = sessionOf(accepted);
  assert.ok(session, 'signed in: the cookie is set');
  const me = await call(main.base, '/api/v1/auth/me', { method: 'GET', cookie: session });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, email);

  const admin = await adminOf(email);
  assert.equal(admin.tenant_id, tenant);
  assert.equal(admin.language, 'es');
  secrets.add(admin.password_hash);
  assert.ok((await invitesOf(email))[0].used_at, 'the invite is marked used');
  // Signing in with the chosen password works as any admin's does.
  const again = await call(main.base, '/api/v1/auth/sign-in', { body: { email, password: PASSWORD } });
  assert.equal(again.status, 200);

  // The notice: to the configured address only, naming who and which, never the link.
  const notices = async () => outbox.filter((m) => m.to.includes(NOTICE_TO) && m.text.includes(email));
  for (const until = Date.now() + 5000; (await notices()).length === 0 && Date.now() < until;) await new Promise((r) => setTimeout(r, 20));
  const mine = await notices();
  assert.equal(mine.length, 1, 'one notice for this accept');
  assert.equal(mine[0].subject, 'Invite accepted: Garage Co one');
  assert.match(mine[0].text, new RegExp(`${email.replace(/[.]/g, '\\.')} accepted the invite and is now the admin of Garage Co one \\(tenant ${tenant}\\)`));
  assert.equal(holdsSecret(mine[0].text, token), false);
});

test('A SECOND ACCEPT SAYS USED: no second admin, nothing changed', async () => {
  const { email, token } = await invited('twice');
  assert.equal((await call(main.base, '/api/v1/auth/invite/accept', { body: { token, password: PASSWORD, language: 'en' } })).status, 200);
  const hash = (await adminOf(email)).password_hash;
  secrets.add(hash);
  const second = await call(main.base, '/api/v1/auth/invite/accept', { body: { token, password: NEW_PASSWORD, language: 'es' } });
  assert.equal(second.status, 409);
  assert.deepEqual(second.json, { error: doors.INVITE_SENTENCES.used, code: 'invite_used' });
  assert.deepEqual(second.cookies, []);
  assert.equal((await call(main.base, '/api/v1/auth/invite/status', { body: { token } })).json.status, 'used');
  const admin = await adminOf(email);
  assert.equal(admin.password_hash, hash, 'the password is the first accept\'s');
  assert.equal(admin.language, 'en');
});

test('AN EXPIRED INVITE SAYS EXPIRED, and makes no admin', async () => {
  const { email, token } = await invited('expired');
  await su.query(`UPDATE operator_invites SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE email = $1`, [email]);
  const status = await call(main.base, '/api/v1/auth/invite/status', { body: { token } });
  assert.deepEqual(status.json, { status: 'expired', message: doors.INVITE_SENTENCES.expired });
  const accept = await call(main.base, '/api/v1/auth/invite/accept', { body: { token, password: PASSWORD, language: 'en' } });
  assert.equal(accept.status, 409);
  assert.equal(accept.json.code, 'invite_expired');
  assert.equal(await adminOf(email), null);
});

test('A RESEND: the old link says replaced and accepts nothing; the new one accepts. An expired invite can be sent again too', async () => {
  const { email, tenant, token: old } = await invited('resend', ['--language', 'es']);
  await su.query(`UPDATE operator_invites SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE email = $1`, [email]);
  const r = await invite(['--resend', email], envOf(emailEnv()));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(LINE.exec(r.stdout)?.[1], email, r.stdout);
  assert.equal(LINE.exec(r.stdout)?.[2], tenant, 'the same tenant');
  const sent = await mailTo(email, 2);
  assert.equal(sent.length, 2, 'two emails: the invite and the resend');
  assert.equal(sent[1].subject, 'Su cuenta de Open Parking', 'the resend keeps the invite\'s language');
  const fresh = tokenIn(sent[1], 'invite');
  assert.notEqual(fresh, old);
  assert.equal(holdsSecret(r.stdout, fresh), false, 'the command did not print the new link');

  const rows = await invitesOf(email);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].replaced_at, 'the first is stamped replaced');
  assert.equal(rows[1].replaced_at, null);

  assert.deepEqual((await call(main.base, '/api/v1/auth/invite/status', { body: { token: old } })).json, { status: 'replaced', message: doors.INVITE_SENTENCES.replaced });
  const refused = await call(main.base, '/api/v1/auth/invite/accept', { body: { token: old, password: PASSWORD, language: 'en' } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'invite_replaced');
  assert.equal(await adminOf(email), null, 'the old link made no admin');

  assert.equal((await call(main.base, '/api/v1/auth/invite/status', { body: { token: fresh } })).json.status, 'ready');
  const accepted = await call(main.base, '/api/v1/auth/invite/accept', { body: { token: fresh, password: PASSWORD, language: 'es' } });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.tenant_id, tenant);
});

test('A TOKEN NOBODY WAS SENT, or one not of an invite\'s shape, says invalid', async () => {
  for (const token of [`opi_${randomBytes(32).toString('base64url')}`, 'opi_short', `opr_${randomBytes(32).toString('base64url')}`, '']) {
    const r = await call(main.base, '/api/v1/auth/invite/status', { body: { token } });
    assert.equal(r.status, 200, token);
    assert.deepEqual(r.json, { status: 'invalid', message: doors.INVITE_SENTENCES.invalid });
    const a = await call(main.base, '/api/v1/auth/invite/accept', { body: { token, password: PASSWORD, language: 'en' } });
    assert.equal(a.status, 409);
    assert.equal(a.json.code, 'invite_invalid');
  }
});

test('ACCEPT holds the password rule and the language: refused by name, the invite still ready', async () => {
  const { email, token } = await invited('rule');
  const short = await call(main.base, '/api/v1/auth/invite/accept', { body: { token, password: 'elevenchars', language: 'en' } });
  assert.equal(short.status, 400);
  assert.deepEqual(short.json, doors.PASSWORD_REFUSED);
  const long = await call(main.base, '/api/v1/auth/invite/accept', { body: { token, password: 'x'.repeat(1025), language: 'en' } });
  assert.deepEqual(long.json, doors.PASSWORD_REFUSED);
  const french = await call(main.base, '/api/v1/auth/invite/accept', { body: { token, password: PASSWORD, language: 'fr' } });
  assert.equal(french.status, 400);
  assert.deepEqual(french.json, doors.UNREADABLE.accept);
  assert.equal(await adminOf(email), null);
  assert.equal((await call(main.base, '/api/v1/auth/invite/status', { body: { token } })).json.status, 'ready');
  // A 1024-character password, each character as long as UTF-8 makes one, fits the body.
  const longest = '😀'.repeat(1024);
  secrets.add(longest);
  const ok = await call(main.base, '/api/v1/auth/invite/accept', { body: { token, password: longest, language: 'en' } });
  assert.equal(ok.status, 200, ok.text);
});

// --- the command's refusals: plain words, and nothing half-done ---------------------------------

test('THE COMMAND REFUSES IN PLAIN WORDS AND STORES NOTHING: no key, an unreadable key, no admin origin, a send that fails', async () => {
  const cases = [
    { why: 'no email configured', env: { ...emailEnv(), EMAIL_KEY_FILE: undefined, EMAIL_FROM: undefined, EMAIL_NOTICE_TO: undefined },
      says: 'refused: no email is configured here (EMAIL_KEY_FILE and EMAIL_FROM), so no invite can be sent; nothing was changed\n' },
    { why: 'a key file that is not there', env: { ...emailEnv(), EMAIL_KEY_FILE: join(keyDir, 'missing') },
      says: 'refused: the email key file could not be read (ENOENT); nothing was changed\n' },
    { why: 'no admin origin', env: { ...emailEnv(), ADMIN_ORIGIN: undefined },
      says: 'refused: no admin origin is configured here (ADMIN_ORIGIN), so an invite link would lead nowhere; nothing was changed\n' },
    { why: 'the service refuses the message', env: emailEnv(), failing: true,
      says: 'refused: the invite email was not sent: the email service answered 500; nothing was changed\n' },
  ];
  for (const c of cases) {
    const name = `Nothing Stored ${randomBytes(3).toString('hex')}`;
    const email = unique('nothing');
    serviceAnswers = c.failing ? 500 : 200;
    let r;
    try {
      r = await invite(['--name', name, '--email', email], envOf(c.env));
    } finally {
      serviceAnswers = 200;
    }
    assert.equal(r.status, 2, c.why);
    assert.equal(r.stdout, '', c.why);
    assert.equal(r.stderr, c.says, c.why);
    assert.equal(await tenantsNamed(name), 0, `${c.why}: no tenant`);
    assert.deepEqual(await invitesOf(email), [], `${c.why}: no invite`);
  }
});

test('THE COMMAND REFUSES BY NAME: a waiting invite, an admin\'s email, a resend of nothing, a bad language, mixed forms, and create-admin\'s argument rules', async () => {
  const waiting = await invited('waiting');
  const taken = unique('taken');
  await createAdmin({ tenantId: await createTenant('taken'), email: taken, password: PASSWORD });
  secrets.add((await adminOf(taken)).password_hash);
  const cases = [
    [['--name', 'Second Co', '--email', waiting.email], 'refused: that email already has an invite waiting: send it again with --resend <email>; nothing was changed\n'],
    [['--name', 'Taken Co', '--email', taken], 'refused: that email already names an admin; nothing was changed\n'],
    [['--resend', taken], 'refused: that email already names an admin; nothing was changed\n'],
    [['--resend', unique('nobody')], 'refused: no invite is waiting for that email; nothing was changed\n'],
    [['--name', 'Lang Co', '--email', unique('lang'), '--language', 'fr'], 'refused: the language is en or es; nothing was changed\n'],
    [['--name', 'Shape Co', '--email', 'not-an-email'], 'refused: that is not an email address; nothing was changed\n'],
    [['--name', ' ', '--email', unique('blank')], 'refused: the company name is text of 1 to 120 characters, with no control characters; nothing was changed\n'],
    [['--resend', waiting.email, '--name', 'X'], 'refused: --resend <email> takes no --name or --email: it sends the waiting invite of that email again\n'],
    [['--email', unique('half')], 'refused: --name and --email are required, or --resend <email>\n'],
    [['--name', 'P Co', '--email', unique('p'), '--password', PASSWORD], 'refused: a password on the command line is refused: it is visible in the process list. Leave it out to be prompted, or pass --password-file <path>.\n'],
    [['--name', 'U Co', '--email', unique('u'), `-p${PASSWORD}`], 'refused: an unknown option (not repeated here: it may hold a password); this command takes --name, --email, --language, --resend\n'],
    [['--name', 'B Co', '--email', unique('b'), 'stray'], 'refused: a bare value is not taken (a password is never an argument); this command takes --name, --email, --language, --resend\n'],
  ];
  const before = outbox.length;
  for (const [args, says] of cases) {
    const r = await invite(args, envOf(emailEnv()));
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.equal(r.stderr, says, args.join(' '));
  }
  assert.equal(outbox.length, before, 'no refusal sent an email');
  assert.equal((await invitesOf(waiting.email)).length, 1, 'the waiting invite is as it was');
  assert.equal(await tenantsNamed('Second Co'), 0);
});

// --- check 3: forgot ----------------------------------------------------------------------------

/** An admin made through an invite, signed in. */
async function admitted(tag, language = 'en') {
  const who = await invited(tag);
  const r = await call(main.base, '/api/v1/auth/invite/accept', { body: { token: who.token, password: PASSWORD, language } });
  assert.equal(r.status, 200, r.text);
  secrets.add((await adminOf(who.email)).password_hash);
  return { ...who, session: sessionOf(r) };
}

/** Every statement the app's database clients run while `fn` runs. */
async function statementsDuring(fn) {
  const seen = [];
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function query(config, ...rest) {
    seen.push(typeof config === 'string' ? config : config?.text);
    return original.call(this, config, ...rest);
  };
  try {
    await fn();
  } finally {
    pg.Client.prototype.query = original;
  }
  return seen.map((s) => String(s).replace(/\s+/g, ' ').trim());
}

test('FORGOT IS NO ORACLE: a known and an unknown email get the same answer, byte for byte, after the same statements, at the floor', async () => {
  const known = await admitted('forgot-known');
  const unknown = unique('forgot-unknown');
  const answers = { known: [], unknown: [] };
  for (let i = 0; i < 4; i += 1) {
    for (const [kind, email] of [['known', known.email], ['unknown', unknown]]) {
      let r;
      const statements = await statementsDuring(async () => {
        r = await call(floored.base, '/api/v1/auth/forgot', { body: { email } });
      });
      answers[kind].push({ status: r.status, text: r.text, ms: r.ms, statements });
    }
  }
  for (const a of [...answers.known, ...answers.unknown]) {
    assert.equal(a.status, 200);
    assert.equal(a.text, JSON.stringify(doors.FORGOT_SENT));
    assert.ok(a.ms >= FLOOR_MS - 5, `answered after ${a.ms.toFixed(0)} ms, before the ${FLOOR_MS} ms floor`);
    assert.ok(a.ms < FLOOR_MS + 250, `answered after ${a.ms.toFixed(0)} ms: the floor is not covering the work`);
  }
  // The same statements, in the same order, for a known email and an unknown one.
  assert.deepEqual(answers.unknown[0].statements, answers.known[0].statements);
  assert.ok(answers.known[0].statements.some((s) => s.includes('INSERT INTO operator_password_resets')), 'the measure saw the work');
  const median = (xs) => xs.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  assert.ok(Math.abs(median(answers.known) - median(answers.unknown)) < 60,
    `known ${median(answers.known).toFixed(0)} ms, unknown ${median(answers.unknown).toFixed(0)} ms`);
  // The reset emails went to the admin, after the answers; the unknown email got none.
  const sent = await mailTo(known.email, 1 + 4);
  assert.equal(sent.filter((m) => m.subject === 'Reset your Open Parking password').length, 4);
  assert.deepEqual(await mailTo(unknown, 1, { within: 300 }), []);
  // Each request replaced the one before: one live reset.
  const live = await su.query('SELECT count(*) FROM operator_password_resets r JOIN operator_users u ON u.id = r.user_id WHERE u.email = $1 AND r.used_at IS NULL AND r.replaced_at IS NULL', [known.email]);
  assert.equal(live.rows[0].count, '1');
});

// --- check 4: reset ----------------------------------------------------------------------------

test('RESET IS SINGLE-USE AND SIGNS OUT EVERY SESSION: a new password, every session ended, every lock cleared; a second use says used', async () => {
  const who = await admitted('reset', 'es');
  const second = await call(main.base, '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD } });
  const sessions = [who.session, sessionOf(second)];
  for (const s of sessions) assert.equal((await call(main.base, '/api/v1/auth/me', { method: 'GET', cookie: s })).status, 200);
  await su.query(`INSERT INTO operator_sign_in_locks (tenant_id, user_id, address, failed_count, locked_until)
                  SELECT tenant_id, id, '203.0.113.9', 10, now() + interval '30 minutes' FROM operator_users WHERE email = $1`, [who.email]);

  assert.equal((await call(main.base, '/api/v1/auth/forgot', { body: { email: who.email.toUpperCase() } })).status, 200);
  const [message] = (await mailTo(who.email, 2)).filter((m) => m.subject.startsWith('Restablezca'));
  assert.ok(message, 'the reset email is in the admin\'s language');
  const token = tokenIn(message, 'reset');
  assert.ok(message.text.includes(`${ADMIN_ORIGIN}/#reset=${token}`));

  const short = await call(main.base, '/api/v1/auth/reset', { body: { token, password: 'too short' } });
  assert.deepEqual(short.json, doors.PASSWORD_REFUSED);

  const done = await call(main.base, '/api/v1/auth/reset', { body: { token, password: NEW_PASSWORD } });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.json, { email: who.email, message: doors.RESET_DONE });
  assert.deepEqual(done.cookies, [], 'a reset signs nobody in');
  for (const s of sessions) {
    const me = await call(main.base, '/api/v1/auth/me', { method: 'GET', cookie: s });
    assert.equal(me.status, 401, 'every session from before the reset has ended');
    assert.equal(me.json.code, 'session_ended');
  }
  const locks = await su.query('SELECT count(*) FROM operator_sign_in_locks l JOIN operator_users u ON u.id = l.user_id WHERE u.email = $1', [who.email]);
  assert.equal(locks.rows[0].count, '0', 'every lock is cleared');
  secrets.add((await adminOf(who.email)).password_hash);
  assert.equal((await call(main.base, '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD } })).status, 401, 'the old password no longer signs in');
  assert.equal((await call(main.base, '/api/v1/auth/sign-in', { body: { email: who.email, password: NEW_PASSWORD } })).status, 200, 'the new one does');

  const again = await call(main.base, '/api/v1/auth/reset', { body: { token, password: PASSWORD } });
  assert.equal(again.status, 409);
  assert.deepEqual(again.json, { error: doors.RESET_SENTENCES.used, code: 'reset_used' });
  assert.equal((await call(main.base, '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD } })).status, 401, 'the second use changed nothing');
});

test('A RESET LINK ENDS: after an hour it says expired; a newer one replaces it; one nobody was sent says invalid', async () => {
  const who = await admitted('reset-ends');
  await call(main.base, '/api/v1/auth/forgot', { body: { email: who.email } });
  const first = tokenIn((await mailTo(who.email, 2)).at(-1), 'reset');
  await call(main.base, '/api/v1/auth/forgot', { body: { email: who.email } });
  const second = tokenIn((await mailTo(who.email, 3)).at(-1), 'reset');
  const replaced = await call(main.base, '/api/v1/auth/reset', { body: { token: first, password: NEW_PASSWORD } });
  assert.equal(replaced.json.code, 'reset_replaced');
  await su.query(`UPDATE operator_password_resets r SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
                    FROM operator_users u WHERE u.id = r.user_id AND u.email = $1 AND r.replaced_at IS NULL`, [who.email]);
  const expired = await call(main.base, '/api/v1/auth/reset', { body: { token: second, password: NEW_PASSWORD } });
  assert.equal(expired.json.code, 'reset_expired');
  const invalid = await call(main.base, '/api/v1/auth/reset', { body: { token: `opr_${randomBytes(32).toString('base64url')}`, password: NEW_PASSWORD } });
  assert.deepEqual(invalid.json, { error: doors.RESET_SENTENCES.invalid, code: 'reset_invalid' });
  const inviteToken = await call(main.base, '/api/v1/auth/reset', { body: { token: who.token, password: NEW_PASSWORD } });
  assert.equal(inviteToken.json.code, 'reset_invalid', 'an invite\'s token is not a reset\'s');
  assert.equal((await call(main.base, '/api/v1/auth/sign-in', { body: { email: who.email, password: PASSWORD } })).status, 200, 'nothing changed the password');
});

// --- check 6: one live invite per tenant, and each tenant's own ---------------------------------

test('ONE LIVE INVITE PER TENANT AND PER EMAIL, held by the database itself', async () => {
  const { tenant, email } = await invited('one-live');
  const row = (n) => `${createHash('sha256').update(`row-${n}-${randomBytes(4).toString('hex')}`).digest('hex')}`;
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`INSERT INTO operator_invites (tenant_id, email, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`, [tenant, unique('second'), row(1)])),
    (err) => err.constraint === 'operator_invites_one_live_per_tenant',
  );
  const other = await createTenant('one-live-other');
  await assert.rejects(
    withTenant(other, (c) => c.query(`INSERT INTO operator_invites (tenant_id, email, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`, [other, email, row(2)])),
    (err) => err.constraint === 'operator_invites_one_live_per_email',
  );
  // A token stored plain is refused by the table itself.
  await assert.rejects(
    withTenant(other, (c) => c.query(`INSERT INTO operator_invites (tenant_id, email, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`, [other, unique('plain'), `opi_${randomBytes(32).toString('base64url')}`])),
    (err) => err.constraint === 'operator_invites_token_is_a_hash',
  );
});

test("NO OTHER TENANT'S INVITE OR RESET IS READABLE, as the application role: with a context, only its own; with none, nothing", async () => {
  const a = await admitted('iso-a');
  const b = await invited('iso-b');
  await call(main.base, '/api/v1/auth/forgot', { body: { email: a.email } });
  await mailTo(a.email, 2);
  const { rows: [{ rolsuper, rolbypassrls }] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual([rolsuper, rolbypassrls], [false, false], 'the application role cannot bypass row-level security');

  for (const table of ['operator_invites', 'operator_password_resets']) {
    const seenByA = await withTenant(a.tenant, (c) => c.query(`SELECT tenant_id FROM ${table}`));
    assert.ok(seenByA.rows.length > 0, `${table}: A sees its own`);
    assert.ok(seenByA.rows.every((r) => r.tenant_id === a.tenant), `${table}: A sees only its own`);
    const none = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(none.rows[0].n, 0, `${table}: nothing with no tenant context`);
  }
  const bInvite = (await invitesOf(b.email))[0].id;
  const asA = await withTenant(a.tenant, (c) => c.query('SELECT id FROM operator_invites WHERE id = $1', [bInvite]));
  assert.equal(asA.rows.length, 0, "B's invite, named by id, is not readable by A");
  const changed = await withTenant(a.tenant, (c) => c.query('UPDATE operator_invites SET used_at = now() WHERE id = $1', [bInvite]));
  assert.equal(changed.rowCount, 0, "B's invite cannot be used up by A");
  // The lookup finds exactly what a token names, and puts its setting back.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT tenant_id FROM resolve_operator_invite($1)', [createHash('sha256').update(b.token).digest('hex')]);
    assert.deepEqual(found.rows, [{ tenant_id: b.tenant }]);
    const setting = await client.query("SELECT coalesce(current_setting('openparking.definer_lookup', true), '') AS v");
    assert.equal(setting.rows[0].v, '');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

// --- the doors keep sign-in's rules -------------------------------------------------------------

const DOOR_BODIES = (token) => ({
  '/api/v1/auth/invite/status': { token },
  '/api/v1/auth/invite/accept': { token, password: PASSWORD, language: 'en' },
  '/api/v1/auth/forgot': { email: unique('door') },
  '/api/v1/auth/reset': { token: `opr_${token.slice(4)}`, password: PASSWORD },
});

test('THE DOORS ARE OFF with no admin origin (409), refuse a foreign Origin (403), and read only JSON of their shape -- never repeating it', async () => {
  const token = `opi_${randomBytes(32).toString('base64url')}`;
  secrets.add(token);
  for (const [path, body] of Object.entries(DOOR_BODIES(token))) {
    const r = await call(off.base, path, { body });
    assert.equal(r.status, 409, path);
    assert.deepEqual(r.json, signIn.NOT_CONFIGURED, path);
    const foreign = await call(main.base, path, { body, origin: FOREIGN_ORIGIN });
    assert.equal(foreign.status, 403, path);
    assert.deepEqual(foreign.json, signIn.ORIGIN_REFUSED, path);
    const door = path.split('/').at(-1);
    for (const raw of [JSON.stringify(body).slice(0, -3), JSON.stringify({ ...body, extra: 1 }), '[]', `"${token}"`, JSON.stringify(body).replace(/"(token|email)":"/, '"$1":7,"x":"')]) {
      const garbled = await call(main.base, path, { raw });
      assert.equal(garbled.status, 400, `${path} ${raw.slice(0, 30)}`);
      assert.deepEqual(garbled.json, doors.UNREADABLE[door], path);
      assert.equal(holdsSecret(garbled.text, token), false, `${path} repeated the token`);
    }
    const notJson = await call(main.base, path, { raw: JSON.stringify(body), headers: { 'content-type': 'text/plain' } });
    assert.equal(notJson.status, 400, path);
    assert.equal(notJson.headers.get('cache-control'), 'no-store', path);
    assert.equal(notJson.headers.get('x-content-type-options'), 'nosniff', path);
  }
});

test('EACH DOOR COUNTS ITS OWN ATTEMPTS PER ADDRESS: past the limit, 429; another door still answers', async () => {
  const token = `opi_${randomBytes(32).toString('base64url')}`;
  for (let i = 0; i < 2; i += 1) assert.equal((await call(limited.base, '/api/v1/auth/invite/status', { body: { token } })).status, 200);
  const third = await call(limited.base, '/api/v1/auth/invite/status', { body: { token } });
  assert.equal(third.status, 429);
  assert.deepEqual(third.json, doors.LINK_RATE_LIMITED);
  assert.equal((await call(limited.base, '/api/v1/auth/forgot', { body: { email: unique('limit') } })).status, 200, 'forgot has its own count');
});

test('NO ANSWER OF ANY DOOR COMES SOONER THAN THE FLOOR: ready or not, refused or not', async () => {
  const { token } = await invited('floor');
  const cases = [
    ['/api/v1/auth/invite/status', { token }],
    ['/api/v1/auth/invite/status', { token: 'opi_nothing' }],
    ['/api/v1/auth/invite/accept', { token: 'opi_nothing', password: PASSWORD, language: 'en' }],
    ['/api/v1/auth/reset', { token: 'opr_nothing', password: PASSWORD }],
    ['/api/v1/auth/forgot', { email: unique('floor') }],
    ['/api/v1/auth/invite/accept', { token, password: PASSWORD, language: 'en' }],
  ];
  for (const [path, body] of cases) {
    const r = await call(floored.base, path, { body });
    assert.ok(r.ms >= FLOOR_MS - 5, `${path} answered ${r.status} after ${r.ms.toFixed(0)} ms`);
  }
});

test('NO CREDENTIAL IN A URL: the doors have no path parameter, and their code reads no query', async () => {
  const routes = [];
  for (const layer of main.app._router.stack) {
    if (layer.name !== 'router' || !layer.regexp.source.includes('auth')) continue;
    for (const l of layer.handle.stack) if (l.route) routes.push(...Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));
  }
  for (const door of ['POST /invite/status', 'POST /invite/accept', 'POST /forgot', 'POST /reset']) assert.ok(routes.includes(door), door);
  assert.equal(routes.some((r) => r.includes(':')), false);
  for (const file of ['../src/accountDoors.js', '../src/invites.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(/req\.(query|params)\b/.test(source), false, `${file} reads req.query or req.params`);
  }
  // And behaviourally: a token in the query is not read.
  const { token } = await invited('query');
  const r = await call(main.base, `/api/v1/auth/invite/status?token=${token}`, { body: {} });
  assert.equal(r.status, 400);
  assert.equal(holdsSecret(r.text, token), false);
});

// --- check 2: the token is nowhere it could be read back --------------------------------------------

/** Every row of every table in the schema, as text, read by the superuser. */
async function everyRow(client) {
  const tables = (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`)).rows.map((r) => r.relname);
  const out = [];
  for (const t of tables) {
    const { rows } = await client.query(`SELECT row_to_json(x)::text AS row FROM ${pg.escapeIdentifier(t)} x`);
    out.push(...rows.map((r) => `${t} ${r.row}`));
  }
  return out.join('\n');
}

test('NO TOKEN IN ANY STORED ROW, ANY RESPONSE BODY OR THE COMMAND\'S OUTPUT; the finder shown finding one planted in a row first', async () => {
  const tokens = [...secrets].filter((s) => /^op[ir]_/.test(s));
  assert.ok(tokens.filter((t) => t.startsWith('opi_')).length >= 8, `invite tokens handled: ${tokens.length}`);
  assert.ok(tokens.some((t) => t.startsWith('opr_')), 'reset tokens are among them');

  // CONTROL: a token planted in a row, inside a transaction undone after, is found by the same scan.
  await su.query('BEGIN');
  try {
    await su.query('INSERT INTO tenants (slug, name) VALUES ($1, $2)', [`planted-${randomBytes(4).toString('hex')}`, `planted ${tokens[0]}`]);
    assert.equal(holdsSecret(await everyRow(su), tokens[0]), true, 'the scan finds a planted token');
  } finally {
    await su.query('ROLLBACK');
  }
  const rows = await everyRow(su);
  assert.deepEqual(tokens.filter((t) => holdsSecret(rows, t)).map((t) => `${t.slice(0, 6)}…`), [], 'a token in a stored row');
  // Not the key either: only the file holds it.
  assert.equal(holdsSecret(rows, KEY), false);

  const answered = bodies.join('\n');
  const leaked = [...secrets].filter((s) => holdsSecret(answered, s) && s !== PASSWORD && s !== NEW_PASSWORD);
  assert.deepEqual(leaked.map((s) => `${s.slice(0, 6)}…`), [], 'a secret in a response body');
  assert.equal(holdsSecret(answered, PASSWORD), false, 'a password in a response body');

  const out = printed.join('\n');
  assert.equal(holdsSecret(`${out}\n${tokens[0]}`, tokens[0]), true, 'CONTROL: the finder finds a token planted in the output');
  assert.deepEqual([...secrets].filter((s) => holdsSecret(out, s)).map((s) => `${s.slice(0, 6)}…`), [], "a secret in the command's output");
});
