/**
 * NO TOKEN IS WRITTEN OUT (0032). The invite and reset suite is run again
 * here as a subprocess, with stdout and stderr captured whole: the platform's
 * own log (the app runs in that process) and every `invite-admin` run's
 * output. It writes out every secret it handled -- each link's token, each
 * password, each session cookie, the email key -- and none may occur in what
 * was printed.
 *
 * The finder is shown finding a token planted in the real captured output
 * before its zero is read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdsSecret } from './secrets.js';

test('the invite and reset suite prints no token, password, cookie value or email key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-account-links-output-'));
  const secretsOut = join(dir, 'secrets.json');
  // NODE_TEST_CONTEXT is how the runner tells a child it is a child; left in,
  // the nested run reports to nobody and runs nothing.
  const env = { ...process.env, ACCOUNT_LINKS_SECRETS_OUT: secretsOut };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', 'test/account-links.test.js'], {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const printed = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `the suite must pass for its output to mean anything:\n${printed.slice(-3000)}`);
  const secrets = JSON.parse(readFileSync(secretsOut, 'utf8'));
  const tokens = secrets.filter((s) => /^op[ir]_/.test(s));
  assert.ok(tokens.some((s) => s.startsWith('opi_')), 'invite tokens are among them');
  assert.ok(tokens.some((s) => s.startsWith('opr_')), 'reset tokens are among them');
  assert.ok(secrets.some((s) => s.startsWith('re_stub_')), 'the email key is among them');

  // CONTROL: the same finder, on the same captured output with one token planted.
  const planted = tokens.find((s) => s.startsWith('opi_'));
  assert.equal(holdsSecret(`${printed}\nleaked ${planted}\n`, planted), true);

  const found = secrets.filter((s) => holdsSecret(printed, s)).map((s) => `${s.slice(0, 6)}…`);
  assert.deepEqual(found, []);
});
