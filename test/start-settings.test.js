/**
 * The three settings older than sign-in -- PORT, PG_POOL_MAX and
 * MAX_CLOCK_SKEW_SECONDS -- are checked before the port opens, the way
 * VALIDATIONS_DOOR is: a plain decimal whole number inside its range, or the
 * server stops with one line naming the setting and no stack trace.
 *
 * What each did before: `PORT=0x10` served on port 16 and `PORT=" 7"` on port
 * 7; `PG_POOL_MAX=-5` hung and died with a warning about an unsettled await;
 * `MAX_CLOCK_SKEW_SECONDS=1e12` was taken, which switches the future-time
 * check off; a word in either of the last two was a stack trace.
 *
 * These start the REAL `src/server.js`, as `validations-door-start.test.js`
 * does. Every refusal has a good value beside it, through the same harness,
 * that serves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A port the kernel says is free, released before it is handed on. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start the real entrypoint with `settings` laid over the environment and a
 * free PORT (unless PORT is one of them), and read what it did: it served
 * (`/healthz` answered 200 on the free port) or it exited.
 */
async function start(settings) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  delete env.PG_POOL_MAX;
  delete env.MAX_CLOCK_SKEW_SECONDS;
  Object.assign(env, settings);
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  let code = null;
  const exited = new Promise((resolve) => child.on('exit', (c) => { code = c; resolve(); }));
  try {
    const deadline = Date.now() + 30_000;
    while (code === null && Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${env.PORT === String(port) ? port : env.PORT}/healthz`);
        if (res.status === 200) return { served: true, stdout, stderr };
      } catch {
        // not listening yet, or never will be
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (code === null) return { served: false, code: 'neither served nor exited within 30 s', stdout, stderr };
    return { served: false, code, stdout, stderr };
  } finally {
    if (code === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

const RANGES = {
  PORT: [1, 65535],
  PG_POOL_MAX: [1, 100],
  MAX_CLOCK_SKEW_SECONDS: [0, 3600],
};

const BAD = {
  PORT: ['0x10', '0', ' 7', 'abc', '-5', '0.5', '1e3', '65536', '999999999999'],
  PG_POOL_MAX: ['-5', '0', 'abc', '0.5', '1e12', ' 7', '0x10', '101'],
  // 1e12 and 999999999999 are the values that switched the check off.
  MAX_CLOCK_SKEW_SECONDS: ['1e12', '999999999999', '3601', 'abc', '-5', '0.5', '0x10', ' 7'],
};

for (const [name, values] of Object.entries(BAD)) {
  const [min, max] = RANGES[name];
  test(`${name}: every bad value stops the server with one line naming it, and no stack trace`, async () => {
    for (const value of values) {
      const out = await start({ [name]: value });
      assert.equal(out.served, false, `${name}=${JSON.stringify(value)} served`);
      assert.equal(out.code, 1, `${name}=${JSON.stringify(value)}: exit ${out.code}\n${out.stdout}${out.stderr}`);
      assert.equal(
        out.stderr.trim(),
        `[platform] REFUSING TO SERVE: ${name} must be a whole number from ${min} to ${max}, not ${JSON.stringify(value)}`,
        `${name}=${JSON.stringify(value)}`,
      );
      assert.doesNotMatch(out.stdout, /listening/, `${name}=${JSON.stringify(value)}`);
    }
  });
}

test('CONTROL: a good value of each, and each end of its range, serves through the same harness', async () => {
  for (const settings of [
    {},
    { PG_POOL_MAX: '5', MAX_CLOCK_SKEW_SECONDS: '60' },
    { PG_POOL_MAX: '1', MAX_CLOCK_SKEW_SECONDS: '0' },
    { PG_POOL_MAX: '100', MAX_CLOCK_SKEW_SECONDS: '3600' },
  ]) {
    const out = await start(settings);
    assert.equal(out.served, true, `${JSON.stringify(settings)}: ${out.code}\n${out.stdout}${out.stderr}`);
  }
});
