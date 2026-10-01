/**
 * `npm run create-admin` and `npm run reset-admin-password`, run as the
 * operator runs them: the real scripts, as subprocesses.
 *
 * Held here: the password never arrives on the command line -- a password
 * argument, in any spelling, is refused by name and changes nothing; it comes
 * from a file (or a no-echo prompt at a terminal, which a test cannot be); the
 * length rule holds; one admin per tenant and one email per deployment; and a
 * reset revokes every session and clears every lock.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { pool, createTenant } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';

const scratch = mkdtempSync(join(tmpdir(), 'openparking-admin-cli-'));
const PASSWORD = 'correct horse battery staple';
const secrets = new Set([PASSWORD]);
let admin;

function file(name, text) {
  const path = join(scratch, name);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}
function run(script, args) {
  const r = spawnSync(process.execPath, [`scripts/${script}.js`, ...args], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const users = async (tenant) => (await admin.query('SELECT email FROM operator_users WHERE tenant_id = $1', [tenant])).rows;

before(async () => {
  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
});
after(async () => {
  if (process.env.OWNER_SIGN_IN_SECRETS_OUT_CLI) {
    writeFileSync(process.env.OWNER_SIGN_IN_SECRETS_OUT_CLI, JSON.stringify([...secrets]));
  }
  await admin.end();
  await pool.end();
});

test('a password argument is refused by name, in every spelling, and nothing is created', async () => {
  const tenant = await createTenant('cli-arg');
  const email = `cli-arg-${tenant.slice(0, 8)}@example.com`;
  for (const args of [
    ['--password', PASSWORD], [`--password=${PASSWORD}`], ['-p', PASSWORD], ['--pass', PASSWORD], ['--passwd', PASSWORD], ['--pw', PASSWORD], [PASSWORD],
  ]) {
    const r = run('create-admin', ['--tenant', tenant, '--email', email, ...args]);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.err, args[0] === PASSWORD ? /a bare value is not taken \(a password is never an argument\)/ : /a password on the command line is refused: it is visible in the process list/, args.join(' '));
    assert.equal(r.err.includes(PASSWORD), false, 'the refusal does not repeat it');
    assert.equal(r.out.includes(PASSWORD), false);
  }
  assert.deepEqual(await users(tenant), []);
  const reset = run('reset-admin-password', ['--email', email, '--password', PASSWORD]);
  assert.equal(reset.status, 2);
  assert.match(reset.err, /a password on the command line is refused/);
});

test('with no terminal and no file, there is no password to take: refused', async () => {
  const tenant = await createTenant('cli-notty');
  const r = run('create-admin', ['--tenant', tenant, '--email', `notty-${tenant.slice(0, 8)}@example.com`]);
  assert.equal(r.status, 2);
  assert.match(r.err, /no terminal to prompt at/);
  assert.deepEqual(await users(tenant), []);
});

test('from a file: the admin is created, the email lower-cased; a second admin, a taken email and a short password are refused by name', async () => {
  const tenant = await createTenant('cli-file');
  const email = `Cli-File-${tenant.slice(0, 8)}@Example.com`;
  const r = run('create-admin', ['--tenant', tenant, '--email', email, '--password-file', file('pw', `${PASSWORD}\n`)]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /admin created/);
  assert.deepEqual(await users(tenant), [{ email: email.toLowerCase() }]);
  const hash = (await admin.query('SELECT password_hash FROM operator_users WHERE tenant_id = $1', [tenant])).rows[0].password_hash;
  secrets.add(hash);
  assert.match(hash, /^scrypt\$N=131072,r=8,p=1,keylen=64\$/);
  assert.equal(r.out.includes(hash) || r.err.includes(hash), false);

  const second = run('create-admin', ['--tenant', tenant, '--email', `other-${tenant.slice(0, 8)}@example.com`, '--password-file', file('pw2', PASSWORD)]);
  assert.equal(second.status, 2);
  assert.match(second.err, /this tenant already has its admin/);

  const other = await createTenant('cli-file-2');
  const taken = run('create-admin', ['--tenant', other, '--email', email, '--password-file', file('pw3', PASSWORD)]);
  assert.equal(taken.status, 2);
  assert.match(taken.err, /that email already names an admin/);

  const short = run('create-admin', ['--tenant', other, '--email', `short-${other.slice(0, 8)}@example.com`, '--password-file', file('short', 'elevenchars')]);
  assert.equal(short.status, 2);
  assert.match(short.err, /a password is at least 12 characters/);
  assert.deepEqual(await users(other), []);
});

test('a reset gives a new password, revokes every session and clears every lock -- and needs the length rule too', async () => {
  const tenant = await createTenant('cli-reset');
  const email = `cli-reset-${tenant.slice(0, 8)}@example.com`;
  assert.equal(run('create-admin', ['--tenant', tenant, '--email', email, '--password-file', file('r1', PASSWORD)]).status, 0);
  const user = (await admin.query('SELECT id FROM operator_users WHERE tenant_id = $1', [tenant])).rows[0].id;
  for (let i = 0; i < 2; i += 1) {
    const t = generateDeviceToken();
    secrets.add(t);
    await admin.query(
      `INSERT INTO operator_tokens (tenant_id, name, token_hash, kind, user_id, expires_at, last_seen_at)
       VALUES ($1, 'sign-in', $2, 'session', $3, now() + interval '1 hour', now())`, [tenant, hashToken(t), user]);
  }
  await admin.query(`INSERT INTO operator_sign_in_locks (tenant_id, user_id, address, failed_count, locked_until) VALUES ($1, $2, '203.0.113.5', 10, now() + interval '30 minutes')`, [tenant, user]);

  const short = run('reset-admin-password', ['--email', email, '--password-file', file('r-short', 'too short')]);
  assert.equal(short.status, 2);
  assert.match(short.err, /at least 12 characters/);

  const NEW = 'another long passphrase';
  secrets.add(NEW);
  const r = run('reset-admin-password', ['--email', email.toUpperCase(), '--password-file', file('r2', NEW)]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /2 session\(s\) revoked, 1 lock\(s\) cleared/);
  const live = (await admin.query(`SELECT count(*) FROM operator_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [user])).rows[0].count;
  assert.equal(live, '0');
  assert.equal((await admin.query('SELECT count(*) FROM operator_sign_in_locks WHERE user_id = $1', [user])).rows[0].count, '0');
  secrets.add((await admin.query('SELECT password_hash FROM operator_users WHERE id = $1', [user])).rows[0].password_hash);

  const nobody = run('reset-admin-password', ['--email', 'nobody-here@example.com', '--password-file', file('r3', NEW)]);
  assert.equal(nobody.status, 2);
  assert.match(nobody.err, /no admin has that email/);
});
