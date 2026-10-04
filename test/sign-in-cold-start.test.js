/**
 * The FIRST sign-in after a start must not tell an admin's email from an
 * unknown one.
 *
 * An unknown email is checked against a decoy hash, made once per process. If
 * the server accepts connections before the decoy is finished, the first
 * unknown email waits for it and then hashes again: two hashes where a known
 * email does one. The gate measured that at the lowest floor the settings
 * allow (200 ms): unknown 314 ms against known 204 ms, 20 starts of 20 apart.
 * So the decoy is finished before the port opens.
 *
 * This starts the REAL `src/server.js` once per sign-in and sends ONE request
 * the moment it says it is listening: a real admin's email with a wrong
 * password, or an email nobody has. They come in PAIRS, one straight after the
 * other, the order alternating, and at the lowest floor the MEDIAN of the
 * pairs' differences must sit within TOLERANCE_MS of zero. The failure this
 * guards against puts a whole second hash under EVERY unknown sign-in (about
 * 110 ms here at this floor, 170-420 ms on CI's runners under load), so it
 * moves every pair and so the median. The rest of the suite runs beside this
 * file, and its load comes in waves: the two halves of a pair, a second apart,
 * share the wave they ran in, so it cancels in their difference. The
 * receipt's measurement is the finer instrument: this is the tripwire.
 *
 * WHY NOT THE FASTEST OF EACH, as this test first compared: it failed on CI
 * now and then with nothing wrong. Measured on GitHub's runners under the
 * suite's load (2026-10-04): the sign-in's own work differs by about 1 ms
 * between the two emails (the failure write, which counts for a real admin
 * only), yet the fastest of 7 of each missed by up to 160 ms in EITHER
 * direction, and the fastest of 25 still by up to 95 ms: one quiet moment
 * lands on one side. Over 60 runs of THIS test on three runners under the
 * suite's load, the median of 25 pairs stayed within -19..+24 ms (the fastest
 * of each, in the same runs: -70..+96), and with the decoy finished after the
 * port opens it was +255..+396 ms in all 30 runs.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { pool, createTenant } from './helpers.js';
import { createAdmin } from '../src/adminAccount.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADMIN_ORIGIN = 'https://admin.example.test';
const PASSWORD = 'correct horse battery staple';
const WRONG = 'incorrect horse battery staple';
const STARTS_EACH = 25;
const TOLERANCE_MS = 60;

after(() => pool.end());

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

/** Start the entrypoint, send one sign-in the moment it is listening, stop it: how long that sign-in took, in ms. */
async function firstSignIn(email, address) {
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), ADMIN_ORIGIN, TRUST_PROXY: 'loopback', SIGN_IN_REFUSAL_FLOOR_MS: '200',
  };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`not listening within 30 s: ${out}`)), 30_000);
      child.stdout.on('data', (d) => {
        out += d;
        if (out.includes('listening')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on('data', (d) => (out += d));
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${out}`)); });
    });
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN, 'x-forwarded-for': address },
      body: JSON.stringify({ email, password: WRONG }),
    });
    await res.text();
    const ms = performance.now() - t0;
    assert.equal(res.status, 401, `${email}: ${res.status}`);
    return ms;
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}


test('THE FIRST SIGN-IN AFTER A START: a real admin\'s email and an unknown one take the same time at the lowest floor', async () => {
  const tenant = await createTenant('cold-start');
  const known = `cold-start-${tenant.slice(0, 8)}@example.com`;
  await createAdmin({ tenantId: tenant, email: known, password: PASSWORD });
  const pairs = [];
  for (let i = 0; i < STARTS_EACH; i += 1) {
    // A fresh address each time: the wrong passwords never reach the lock.
    const signInKnown = () => firstSignIn(known, `198.51.100.${2 * i + 1}`);
    const signInUnknown = () => firstSignIn(`nobody-${tenant.slice(0, 8)}-${i}@example.com`, `198.51.100.${2 * i + 2}`);
    if (i % 2 === 0) {
      const k = await signInKnown();
      pairs.push({ known: k, unknown: await signInUnknown() });
    } else {
      const u = await signInUnknown();
      pairs.push({ known: await signInKnown(), unknown: u });
    }
  }
  const differences = pairs.map((p) => p.unknown - p.known).sort((x, y) => x - y);
  const mid = differences.length >> 1;
  const median = differences.length % 2 ? differences[mid] : (differences[mid - 1] + differences[mid]) / 2;
  const shown = pairs.map((p) => `${p.known.toFixed(0)}/${p.unknown.toFixed(0)}`).join(' ');
  assert.ok(Math.abs(median) < TOLERANCE_MS, `median of (unknown - known) over ${pairs.length} pairs ${median.toFixed(1)} ms; known/unknown: ${shown}`);
});
