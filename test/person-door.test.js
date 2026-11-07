/**
 * The trusted server's door (src/personDoor.js), against the real app and a
 * real Postgres: who may knock, the three questions, every refusal, the limit
 * and the lock counted by the caller's address, and nothing secret written out.
 * Stalls, places and held rows are in test/person-door-stall.test.js.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, superuserClient } from './helpers.js';
import { createAdmin, resetAdminPassword } from '../src/adminAccount.js';
import { hashCount, hashPassword } from '../src/passwords.js';
import * as signIn from '../src/signIn.js';
import { BODY_TOO_LARGE, PATHS, PERSON_GONE } from '../src/personDoor.js';
import { FORGOT_SENT } from '../src/accountDoors.js';
import { holdsSecret } from './secrets.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const KEY = `tsk_${randomBytes(32).toString('base64url')}`;
const KEY_SHA256 = createHash('sha256').update(KEY).digest('hex');
const PASSWORD = 'correct horse battery staple';
const WRONG = 'incorrect horse battery staple';
const FLOOR_MS = 200;
const AUTH = '/api/v1/auth';

const secrets = new Set([KEY, PASSWORD, WRONG]);
const bodies = [];
const printed = [];
const real = { log: console.log, error: console.error, warn: console.warn };
let su;

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
const keyDir = mkdtempSync(join(tmpdir(), 'openparking-door-'));
const keyFile = join(keyDir, 'email_key');
writeFileSync(keyFile, 're_stub_door\n');
chmodSync(keyFile, 0o600);
let serviceUrl;

const servers = [];
async function serve(env = {}) {
  const all = { ADMIN_ORIGIN, SIGN_IN_REFUSAL_FLOOR_MS: String(FLOOR_MS), TRUSTED_SERVER_KEY_SHA256: KEY_SHA256, ...env };
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

let main;
let wide; // no limit to speak of, for a test that counts wrong passwords
let lastOctet = 0;
/** An address no other test counts against. Documentation ranges only. */
const address = () => {
  lastOctet += 1;
  return `198.51.${Math.floor(lastOctet / 250)}.${(lastOctet % 250) + 1}`;
};
const unique = (tag) => `${tag}-${randomBytes(5).toString('hex')}@example.com`;

async function admin(tag, language) {
  const tenant = await createTenant(tag);
  const email = unique(tag);
  const user = await createAdmin({ tenantId: tenant, email, password: PASSWORD });
  if (language) await withTenant(tenant, (c) => c.query('UPDATE operator_users SET language = $1 WHERE id = $2', [language, user.id]));
  const { rows } = await su.query('SELECT password_hash FROM operator_users WHERE tenant_id = $1', [tenant]);
  secrets.add(rows[0].password_hash);
  return { tenant, email, id: user.id, hash: rows[0].password_hash };
}

async function send(base, path, { body, raw, key = KEY, type = 'application/json', origin } = {}) {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...(type ? { 'content-type': type } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...(origin ? { origin } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  bodies.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json, headers: res.headers, took: performance.now() - started };
}
const check = (base, email, password, clientAddress, options) => send(base, `${AUTH}${PATHS.password}`, { body: { email, password, clientAddress }, ...options });
const who = (base, personId, tenantId, options) => send(base, `${AUTH}${PATHS.check}`, { body: { personId, tenantId }, ...options });
const forgot = (base, email, clientAddress, options) => send(base, `${AUTH}${PATHS.forgot}`, { body: { email, clientAddress }, ...options });
const dashboard = (base, email, password) => fetch(`${base}${AUTH}/sign-in`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN }, body: JSON.stringify({ email, password }),
});

const REFUSED_TEXT = JSON.stringify(signIn.REFUSED);
const UNREADABLE_TEXT = JSON.stringify(signIn.UNREADABLE);
const assertRefused = (r) => {
  assert.equal(r.status, 401, r.text);
  assert.equal(r.text, REFUSED_TEXT);
};
const lockRows = async (tenant) => (await su.query('SELECT address, failed_count, coalesce(locked_until > now(), false) AS locked FROM operator_sign_in_locks WHERE tenant_id = $1 ORDER BY address', [tenant])).rows;

before(async () => {
  console.log = (...a) => { printed.push(a.join(' ')); };
  console.error = (...a) => { printed.push(a.join(' ')); };
  console.warn = (...a) => { printed.push(a.join(' ')); };
  su = superuserClient();
  await su.connect();
  service.listen(0, '127.0.0.1');
  await new Promise((r) => service.once('listening', r));
  serviceUrl = `http://127.0.0.1:${service.address().port}`;
  main = await serve();
  wide = await serve({ SIGN_IN_ATTEMPTS_PER_ADDRESS: '1000' });
});

after(async () => {
  Object.assign(console, real);
  for (const s of servers) s.close();
  service.close();
  await su.end();
  await pool.end();
});

// --- who may knock ---------------------------------------------------------------------------

test('OFF UNLESS NAMED: with no key set the door is no route, even carrying the right key', async () => {
  const off = await serve({ TRUSTED_SERVER_KEY_SHA256: undefined });
  const who1 = await admin('door-off');
  for (const r of [await check(off, who1.email, PASSWORD, address()), await who(off, who1.id, who1.tenant), await forgot(off, who1.email, address())]) {
    assert.equal(r.status, 404);
    assert.equal(r.text, '{"error":"not found"}');
  }
});

test('OFF WITH SIGN-IN: a deployment with no admin site has no sign-in, so no door either', async () => {
  const off = await serve({ ADMIN_ORIGIN: undefined });
  const r = await who(off, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
  assert.equal(r.status, 404);
  assert.equal(r.text, '{"error":"not found"}', 'no route, and not "that person is gone"');
});

test('THE SETTING IS A DIGEST OR NOTHING: anything else stops the start, naming the setting and not the value', () => {
  for (const bad of ['short', KEY, KEY_SHA256.toUpperCase(), `${KEY_SHA256}0`]) {
    assert.throws(() => signIn.readTrustedServerKey(bad), (err) => /TRUSTED_SERVER_KEY_SHA256/.test(err.message) && !err.message.includes(bad));
  }
  assert.equal(signIn.readTrustedServerKey(undefined), null);
  assert.equal(signIn.readTrustedServerKey(''), null);
  assert.equal(signIn.readTrustedServerKey(KEY_SHA256).length, 32);
});

test('THE WRONG KEY, OR NONE: the answer of a path that is no route, and nothing is read or counted', async () => {
  const who1 = await admin('door-key');
  const notARoute = await fetch(`${main}${AUTH}/nothing-here`, { method: 'POST' });
  const expected = await notARoute.text();
  const hashes = hashCount();
  for (const key of [null, 'wrong', `${KEY}x`, KEY_SHA256]) {
    for (const r of [await check(main, who1.email, PASSWORD, '203.0.113.200', { key }), await who(main, who1.id, who1.tenant, { key }), await forgot(main, who1.email, '203.0.113.200', { key })]) {
      assert.equal(r.status, 404, `key ${key}`);
      assert.equal(r.text, expected);
    }
  }
  // Nor is a long body read before the key is known.
  const big = await send(main, `${AUTH}${PATHS.password}`, { raw: 'x'.repeat(40_000), key: 'wrong' });
  assert.equal(big.status, 404);
  assert.equal(hashCount(), hashes);
  assert.deepEqual(await lockRows(who1.tenant), []);
});

test('A BEARER TOKEN OF ANOTHER KIND OPENS NOTHING: an operator key is not the door key', async () => {
  const who1 = await admin('door-operator-key');
  const r = await who(main, who1.id, who1.tenant, { key: `opk_${randomBytes(32).toString('base64url')}` });
  assert.equal(r.status, 404);
});

test('THE DOOR MAKES NO SESSION: a right password sets no cookie and writes no token', async () => {
  const who1 = await admin('door-nosession');
  const res = await fetch(`${main}${AUTH}${PATHS.password}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ email: who1.email, password: PASSWORD, clientAddress: address() }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers.getSetCookie(), []);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { rows } = await su.query(`SELECT count(*)::int AS n FROM operator_tokens WHERE tenant_id = $1`, [who1.tenant]);
  assert.equal(rows[0].n, 0);
});

// --- the answer ------------------------------------------------------------------------------

test('WHO IT IS: the fields, with the email folded as sign-in folds it, and no hash', async () => {
  const tenantName = 'door-right';
  const who1 = await admin(tenantName, 'es');
  const r = await check(main, `  ${who1.email.toUpperCase()} `, PASSWORD, address());
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json), ['personId', 'tenantId', 'name', 'companyName', 'email', 'language', 'version']);
  assert.equal(r.json.personId, who1.id);
  assert.equal(r.json.tenantId, who1.tenant);
  assert.equal(r.json.name, null);
  assert.equal(r.json.companyName, tenantName);
  assert.equal(r.json.email, who1.email);
  assert.equal(r.json.language, 'es');
  assert.match(r.json.version, /^[0-9a-f]{64}$/);
  assert.equal(r.text.includes('scrypt'), false);
  assert.equal(r.text.includes(who1.hash.split('$')[3]), false);
});

test('THE CHECK BY ID says the same, or gone', async () => {
  const a = await admin('door-who');
  const b = await admin('door-who-other');
  const byPassword = await check(main, a.email, PASSWORD, address());
  const byId = await who(main, a.id, a.tenant);
  assert.equal(byId.status, 200);
  assert.deepEqual(byId.json, byPassword.json);
  const gone = JSON.stringify(PERSON_GONE);
  const answers = [
    await who(main, a.id, b.tenant), // a person of another tenant
    await who(main, b.id, a.tenant),
    await who(main, '00000000-0000-4000-8000-000000000001', a.tenant),
    await who(main, 'not-an-id', a.tenant),
    await who(main, a.id, "'; DROP TABLE tenants; --"),
    await send(main, `${AUTH}${PATHS.check}`, { body: { personId: a.id } }),
    await send(main, `${AUTH}${PATHS.check}`, { body: { personId: a.id, tenantId: a.tenant, email: a.email } }),
  ];
  for (const r of answers) {
    assert.equal(r.status, 404, r.text);
    assert.equal(r.text, gone);
  }
});

test('A PERSON REMOVED: the tenant deleted, the check says gone and the password is the one refusal', async () => {
  const a = await admin('door-gone');
  assert.equal((await who(main, a.id, a.tenant)).status, 200);
  await su.query('DELETE FROM tenants WHERE id = $1', [a.tenant]);
  assert.equal((await who(main, a.id, a.tenant)).status, 404);
  assertRefused(await check(main, a.email, PASSWORD, address()));
});

test('THE VERSION moves with the password, the email and the person, and with nothing else', async () => {
  const a = await admin('door-version');
  const version = async (x = a) => (await who(main, x.id, x.tenant)).json.version;
  const first = await version();
  assert.equal(await version(), first, 'asked twice');

  await withTenant(a.tenant, (c) => c.query(`UPDATE operator_users SET language = 'es' WHERE id = $1`, [a.id]));
  await su.query('UPDATE tenants SET name = $1 WHERE id = $2', ['renamed', a.tenant]);
  assert.equal(await version(), first, 'the language and the company name are not who it is');

  await resetAdminPassword({ email: a.email, password: `${PASSWORD} two` });
  const afterPassword = await version();
  assert.notEqual(afterPassword, first);

  await su.query('UPDATE operator_users SET email = $1 WHERE id = $2', [unique('door-version-new'), a.id]);
  assert.notEqual(await version(), afterPassword);

  const other = await admin('door-version-other');
  await su.query('UPDATE operator_users SET password_hash = $1 WHERE id = $2', [a.hash, other.id]);
  assert.notEqual(await version(other), first, 'the same hash on another person is another version');
});

test('A CHANGE OF PASSWORD: dashboard sessions end there, the door moves the version, the old password is refused', async () => {
  const a = await admin('door-reset');
  const signedIn = await dashboard(main, a.email, PASSWORD);
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.getSetCookie()[0].split(';')[0];
  const me = () => fetch(`${main}${AUTH}/me`, { headers: { cookie } });
  assert.equal((await me()).status, 200);
  const before1 = (await who(main, a.id, a.tenant)).json.version;

  const NEW = `${PASSWORD} again`;
  await resetAdminPassword({ email: a.email, password: NEW });

  assert.equal((await me()).status, 401, 'the dashboard session ended');
  assert.notEqual((await who(main, a.id, a.tenant)).json.version, before1);
  assertRefused(await check(main, a.email, PASSWORD, address()));
  assert.equal((await check(main, a.email, NEW, address())).status, 200);
});

// --- one refusal -----------------------------------------------------------------------------

test('ONE REFUSAL, ONE SHAPE: unknown, wrong, locked, right while locked, broken hash: the same bytes at the floor', async () => {
  const a = await admin('door-refusals');
  const locked = await admin('door-refusals-locked');
  const broken = await admin('door-refusals-broken');
  await su.query(`UPDATE operator_users SET password_hash = 'scrypt$broken' WHERE id = $1`, [broken.id]);
  const lockedAt = address();
  for (let i = 0; i < 10; i += 1) await check(wide, locked.email, WRONG, lockedAt);

  const answers = [
    await check(wide, unique('door-nobody'), PASSWORD, address()),
    await check(wide, a.email, WRONG, address()),
    await check(wide, locked.email, WRONG, lockedAt),
    await check(wide, locked.email, PASSWORD, lockedAt),
    await check(wide, broken.email, PASSWORD, address()),
  ];
  for (const r of answers) {
    assertRefused(r);
    assert.ok(r.took >= FLOOR_MS - 5, `answered in ${Math.round(r.took)} ms`);
    assert.equal(r.headers.get('retry-after'), null);
  }
  assert.deepEqual(await lockRows(broken.tenant), [], 'a hash that cannot be read is nobody\'s wrong password');
});

test('ONE HASH EACH: unknown, wrong and known all run one; a shape refused runs none', async () => {
  const a = await admin('door-hash');
  for (const [r, n] of [
    [() => check(main, unique('door-hash-nobody'), PASSWORD, address()), 1],
    [() => check(main, a.email, WRONG, address()), 1],
    [() => check(main, a.email, PASSWORD, address()), 1],
    [() => check(main, a.email, PASSWORD, 'not an address'), 0],
  ]) {
    const before1 = hashCount();
    await r();
    assert.equal(hashCount() - before1, n);
  }
});

test('A RIGHT ANSWER LEAVES AT THE FLOOR TOO, and so does each shape refused', async () => {
  const a = await admin('door-floor');
  for (const r of [await check(main, a.email, PASSWORD, address()), await check(main, a.email, PASSWORD, 'nowhere'), await forgot(main, unique('door-floor-f'), address())]) {
    assert.ok(r.took >= FLOOR_MS - 5, `answered in ${Math.round(r.took)} ms`);
  }
});

test('A BODY IT WILL NOT READ: the shape comes first, the one sentence, nobody looked at', async () => {
  const a = await admin('door-shape');
  const path = `${AUTH}${PATHS.password}`;
  const clientAddress = address();
  const hashes = hashCount();
  const answers = [
    await send(main, path, { body: { email: `${a.email}\u0000`, password: PASSWORD, clientAddress } }),
    await send(main, path, { body: { email: `${a.email}\n`, password: PASSWORD, clientAddress } }),
    await send(main, path, { body: { email: `a\u0085b${a.email}`, password: PASSWORD, clientAddress } }),
    await send(main, path, { body: { email: `${'a'.repeat(250)}@example.com`, password: PASSWORD, clientAddress } }),
    await send(main, path, { body: { email: 'a', password: PASSWORD, clientAddress } }),
    await send(main, path, { body: { email: a.email, password: 'p'.repeat(1025), clientAddress } }),
    await send(main, path, { body: { email: a.email, password: '😀'.repeat(1025), clientAddress } }),
    await send(main, path, { body: { email: a.email, password: '', clientAddress } }),
    await send(main, path, { body: { email: a.email, password: PASSWORD } }),
    await send(main, path, { body: { email: a.email, password: PASSWORD, clientAddress: 42 } }),
    await send(main, path, { body: { email: a.email, password: PASSWORD, clientAddress: '' } }),
    await send(main, path, { body: { email: a.email, password: PASSWORD, clientAddress: 'unknown' } }),
    await send(main, path, { body: { email: a.email, password: PASSWORD, clientAddress: '999.1.1.1' } }),
    await send(main, path, { body: { email: a.email, password: PASSWORD, clientAddress: 'fe80::1%eth0' } }),
    await send(main, path, { body: { email: a.email, password: PASSWORD, clientAddress, extra: 'x' } }),
    await send(main, path, { body: [a.email, PASSWORD] }),
    await send(main, path, { raw: 'nonsense' }),
    await send(main, path, { raw: '{"email":' }),
    await send(main, path, { body: { email: a.email, password: PASSWORD, clientAddress }, type: 'text/plain' }),
    await send(main, path, { raw: Buffer.from([0x7b, 0xff, 0x7d]) }),
  ];
  for (const r of answers) {
    assert.equal(r.status, 400, r.text);
    assert.equal(r.text, UNREADABLE_TEXT);
  }
  assert.equal(hashCount(), hashes);
  assert.deepEqual(await lockRows(a.tenant), []);
});

test('A PASSWORD OF THE RULE\'S LONGEST PASSES, counted as the rule counts: characters, not code units', async () => {
  const tenant = await createTenant('door-long');
  const email = unique('door-long');
  const long = '😀'.repeat(1024);
  secrets.add(long);
  await createAdmin({ tenantId: tenant, email, password: long });
  assert.equal((await check(main, email, long, address())).status, 200);
});

test('THE BODY CAP is this door\'s: past it 413 and a fixed sentence, whatever was sent', async () => {
  const a = await admin('door-cap');
  const r = await send(main, `${AUTH}${PATHS.password}`, { body: { email: a.email, password: 'p'.repeat(17_000), clientAddress: address() } });
  assert.equal(r.status, 413);
  assert.equal(r.text, JSON.stringify(BODY_TOO_LARGE));
  assert.equal(r.text.includes('ppp'), false);
  // Room for the longest password there is, every character sent as \\uXXXX escapes.
  const tenant = await createTenant('door-cap-long');
  const email = unique('door-cap-long');
  const long = '😀'.repeat(1024);
  await createAdmin({ tenantId: tenant, email, password: long });
  const escaped = long.split('').map((unit) => `\\u${unit.charCodeAt(0).toString(16)}`).join('');
  const raw = `{"email":"${email}","clientAddress":"${address()}","password":"${escaped}"}`;
  assert.equal((await send(main, `${AUTH}${PATHS.password}`, { raw })).status, 200);
});

// --- by the caller's address ------------------------------------------------------------------

test('THE LOCK IS THE CALLER\'S: ten wrong from one address lock that address, not the door and not the account', async () => {
  const a = await admin('door-lock');
  const stranger = address();
  const owner = address();
  for (let i = 0; i < 10; i += 1) assertRefused(await check(wide, a.email, WRONG, stranger));
  assertRefused(await check(wide, a.email, PASSWORD, stranger));
  assert.deepEqual(await lockRows(a.tenant), [{ address: stranger, failed_count: 10, locked: true }]);

  // Every call here came from one socket, the asker's: it is not what is counted.
  assert.equal((await check(wide, a.email, PASSWORD, owner)).status, 200, 'the owner, from their own address, is let in');
  assert.equal((await dashboard(wide, a.email, PASSWORD)).status, 200, 'the dashboard, from its address, too');
});

test('THE LOCK IS SIGN-IN\'S: the same row, read by both doors, and a right password clears only its own address', async () => {
  const a = await admin('door-shared-lock');
  // 127.0.0.1 is the socket this test signs in from, at the dashboard.
  for (let i = 0; i < 9; i += 1) await check(wide, a.email, WRONG, '127.0.0.1');
  assert.equal((await dashboard(wide, a.email, WRONG)).status, 401);
  assert.deepEqual(await lockRows(a.tenant), [{ address: '127.0.0.1', failed_count: 10, locked: true }]);
  assert.equal((await dashboard(wide, a.email, PASSWORD)).status, 401, 'nine here and one there locked it there');

  const b = await admin('door-shared-clear');
  const one = address();
  const two = address();
  await check(wide, b.email, WRONG, one);
  await check(wide, b.email, WRONG, two);
  assert.equal((await check(wide, b.email, PASSWORD, one)).status, 200);
  assert.deepEqual(await lockRows(b.tenant), [{ address: two, failed_count: 1, locked: false }]);
});

test('A LOCK THAT HAS ENDED IS OVER, and a wrong password during one re-arms it, as at sign-in', async () => {
  const a = await admin('door-lock-ended');
  const at = address();
  for (let i = 0; i < 10; i += 1) await check(wide, a.email, WRONG, at);
  await su.query(`UPDATE operator_sign_in_locks SET locked_until = now() + interval '1 minute' WHERE tenant_id = $1`, [a.tenant]);
  await check(wide, a.email, WRONG, at);
  const { rows } = await su.query(`SELECT locked_until > now() + interval '20 minutes' AS rearmed FROM operator_sign_in_locks WHERE tenant_id = $1`, [a.tenant]);
  assert.equal(rows[0].rearmed, true);
  await su.query(`UPDATE operator_sign_in_locks SET locked_until = now() - interval '1 minute' WHERE tenant_id = $1`, [a.tenant]);
  assert.equal((await check(wide, a.email, PASSWORD, at)).status, 200);
});

test('AN ADDRESS IS READ AS SIGN-IN READS ONE: IPv6 by its /64, a mapped IPv4 as itself', async () => {
  const a = await admin('door-address');
  await check(wide, a.email, WRONG, '2001:db8:7:1::1');
  await check(wide, a.email, WRONG, '2001:DB8:7:1:ffff::2');
  await check(wide, a.email, WRONG, '::ffff:203.0.113.77');
  assert.deepEqual(await lockRows(a.tenant), [
    { address: '2001:db8:7:1::/64', failed_count: 2, locked: false },
    { address: '203.0.113.77', failed_count: 1, locked: false },
  ]);
});

test('THE LIMIT IS THE CALLER\'S AND SIGN-IN\'S: past it 429 and when to come back; another address goes on', async () => {
  const limited = await serve({ SIGN_IN_ATTEMPTS_PER_ADDRESS: '3', SIGN_IN_ATTEMPTS_WINDOW_MINUTES: '15' });
  const a = await admin('door-limit');
  const stranger = address();
  for (let i = 0; i < 3; i += 1) assertRefused(await check(limited, a.email, WRONG, stranger));
  const r = await check(limited, a.email, PASSWORD, stranger);
  assert.equal(r.status, 429);
  assert.equal(r.text, JSON.stringify(signIn.RATE_LIMITED));
  const after1 = Number(r.headers.get('retry-after'));
  assert.ok(after1 >= 1 && after1 <= 900, `Retry-After ${after1}`);
  assert.equal((await check(limited, a.email, PASSWORD, address())).status, 200, 'another address goes on');

  // One count with the dashboard's: the socket here is 127.0.0.1.
  const shared = await serve({ SIGN_IN_ATTEMPTS_PER_ADDRESS: '2' });
  await check(shared, a.email, WRONG, '127.0.0.1');
  await dashboard(shared, a.email, WRONG);
  assert.equal((await dashboard(shared, a.email, PASSWORD)).status, 429);
});

// --- forgot ----------------------------------------------------------------------------------

test('FORGOT: the same answer whoever it names, and forgot\'s email to the admin alone', async () => {
  const base = await serve({ EMAIL_KEY_FILE: keyFile, EMAIL_FROM: 'Open Parking <invites@example.com>', EMAIL_API_URL: serviceUrl });
  const a = await admin('door-forgot', 'es');
  const nobody = unique('door-forgot-nobody');
  const known = await forgot(base, a.email.toUpperCase(), address());
  const unknown = await forgot(base, nobody, address());
  assert.equal(known.status, 200);
  assert.equal(known.text, JSON.stringify(FORGOT_SENT));
  assert.equal(unknown.text, known.text);
  for (let i = 0; i < 100 && outbox.filter((m) => m.to.includes(a.email)).length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  const sent = outbox.filter((m) => m.to.includes(a.email));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /https:\/\/admin\.example\.test\/#reset=opr_[A-Za-z0-9_-]{43}/);
  assert.equal(outbox.filter((m) => m.to.includes(nobody)).length, 0);

  // And it is the dashboard's own: the same email in the same words.
  outbox.length = 0;
  await fetch(`${base}${AUTH}/forgot`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN }, body: JSON.stringify({ email: a.email }) });
  for (let i = 0; i < 100 && outbox.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(outbox[0].subject, sent[0].subject);
  assert.equal(outbox[0].text.replace(/opr_[A-Za-z0-9_-]{43}/, ''), sent[0].text.replace(/opr_[A-Za-z0-9_-]{43}/, ''));
});

test('FORGOT: its shape first, and forgot\'s count, by the caller\'s address', async () => {
  const limited = await serve({ ACCOUNT_LINK_ATTEMPTS_PER_ADDRESS: '2' });
  const path = `${AUTH}${PATHS.forgot}`;
  for (const body of [
    { email: 'a@b.c' }, { email: 'a@b.c', clientAddress: 'x' }, { email: `a\u0001@b.c`, clientAddress: '198.51.100.1' },
    { email: `${'a'.repeat(251)}@b.c`, clientAddress: '198.51.100.1' }, { email: 'a@b.c', clientAddress: '198.51.100.1', password: 'x' },
  ]) {
    const r = await send(limited, path, { body });
    assert.equal(r.status, 400);
    assert.equal(r.text, UNREADABLE_TEXT);
  }
  const stranger = address();
  await forgot(limited, unique('door-forgot-limit'), stranger);
  await forgot(limited, unique('door-forgot-limit'), stranger);
  const r = await forgot(limited, unique('door-forgot-limit'), stranger);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await forgot(limited, unique('door-forgot-limit'), address())).status, 200, 'another address goes on');
});

// --- a person who is not the admin --------------------------------------------------------------

test('A LINKED PERSON IS AN UNKNOWN EMAIL HERE: the door never asks the accounts module; sign-in, beside it, does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-door-bin-'));
  const mark = join(dir, 'asked');
  writeFileSync(join(dir, 'accounts-marker'), `#!/bin/sh\ntouch ${mark}\nexit 1\n`);
  chmodSync(join(dir, 'accounts-marker'), 0o755);
  const saved = { ACCOUNTS_DOOR: process.env.ACCOUNTS_DOOR, ENTITLEMENT_BIN_DIR: process.env.ENTITLEMENT_BIN_DIR };
  process.env.ACCOUNTS_DOOR = 'accounts-marker';
  process.env.ENTITLEMENT_BIN_DIR = dir;
  try {
    const email = unique('door-linked');
    assertRefused(await check(main, email, PASSWORD, address()));
    await forgot(main, email, address());
    assert.equal(existsSync(mark), false, 'the door ran the module');
    await dashboard(main, email, PASSWORD);
    assert.equal(existsSync(mark), true, 'the control: sign-in does ask it');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('THE PASSWORD RULE IS NOT THIS DOOR\'S: an old short password that signs in at the dashboard passes here', async () => {
  const a = await admin('door-short');
  const short = 'short';
  secrets.add(short);
  await su.query('UPDATE operator_users SET password_hash = $1 WHERE id = $2', [await hashPassword(short), a.id]);
  assert.equal((await dashboard(main, a.email, short)).status, 200);
  assert.equal((await check(main, a.email, short, address())).status, 200);
});

// --- nothing secret ----------------------------------------------------------------------------

test('LAST: no body and no log line held a password, a key or a stored hash; no log line an email', async () => {
  assert.ok(holdsSecret(`x${PASSWORD}y`, PASSWORD), 'the finder finds a planted secret');
  const everything = [...bodies, ...printed];
  for (const secret of secrets) {
    if (secret === 'short') continue; // short enough to be part of other words; held by its own test
    for (const text of everything) assert.equal(holdsSecret(text, secret), false, 'a secret was written out');
  }
  for (const line of printed) assert.equal(/@example\.com/.test(line), false, 'an email was logged');
});
