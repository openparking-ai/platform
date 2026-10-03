/**
 * NOTHING SECRET IS WRITTEN OUT. The sign-in suite and the admin commands'
 * suite are run again here as subprocesses, with stdout and stderr captured
 * whole; each writes out every secret it handled -- the passwords, the session
 * tokens and cookie values, the stored hashes -- and none may occur in what was
 * printed. That includes the forced 500 inside sign-in, whose error message is
 * planted with the password and a token.
 *
 * The finder is shown finding a secret planted in the real captured output
 * before its zero is read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdsSecret } from './secrets.js';

test('the sign-in and admin-command suites print no password, token, cookie value or stored hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-sign-in-output-'));
  const secretsOut = join(dir, 'secrets.json');
  const cliSecretsOut = join(dir, 'cli-secrets.json');
  // NODE_TEST_CONTEXT is how the runner tells a child it is a child; left in,
  // the nested run reports to nobody and runs nothing.
  const env = { ...process.env, OWNER_SIGN_IN_SECRETS_OUT: secretsOut, OWNER_SIGN_IN_SECRETS_OUT_CLI: cliSecretsOut };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', 'test/owner-sign-in.test.js', 'test/admin-cli.test.js'], {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const printed = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `the suites must pass for their output to mean anything:\n${printed.slice(-3000)}`);
  const secrets = [...JSON.parse(readFileSync(secretsOut, 'utf8')), ...JSON.parse(readFileSync(cliSecretsOut, 'utf8'))];
  assert.ok(secrets.length > 25, `secrets handled: ${secrets.length}`);
  assert.ok(secrets.some((s) => s.startsWith('opl_')), 'session tokens are among them');
  assert.ok(secrets.some((s) => s.startsWith('scrypt$')), 'stored hashes are among them');

  // CONTROL: the same finder, on the same captured output with one secret planted.
  const planted = secrets.find((s) => s.startsWith('opl_'));
  assert.equal(holdsSecret(`${printed}\nleaked ${planted}\n`, planted), true);

  const found = secrets.filter((s) => holdsSecret(printed, s)).map((s) => `${s.slice(0, 6)}…`);
  assert.deepEqual(found, []);
});
