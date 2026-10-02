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
 * password, or an email nobody has, alternately. At the lowest floor the two
 * medians must sit within TOLERANCE_MS of each other; the failure this guards
 * against is a whole hash apart (about 150 ms here, more on a slower machine).
 * The receipt's measurement is the finer instrument: this is the tripwire.
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
const STARTS_EACH = 7;
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

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

test('THE FIRST SIGN-IN AFTER A START: a real admin\'s email and an unknown one take the same time at the lowest floor', async () => {
  const tenant = await createTenant('cold-start');
  const known = `cold-start-${tenant.slice(0, 8)}@example.com`;
  await createAdmin({ tenantId: tenant, email: known, password: PASSWORD });
  const times = { known: [], unknown: [] };
  for (let i = 0; i < STARTS_EACH; i += 1) {
    // A fresh address each time: the wrong passwords never reach the lock.
    times.known.push(await firstSignIn(known, `198.51.100.${2 * i + 1}`));
    times.unknown.push(await firstSignIn(`nobody-${tenant.slice(0, 8)}-${i}@example.com`, `198.51.100.${2 * i + 2}`));
  }
  const gap = median(times.unknown) - median(times.known);
  const shown = `known ${times.known.map((t) => t.toFixed(0)).join(',')} | unknown ${times.unknown.map((t) => t.toFixed(0)).join(',')}`;
  assert.ok(Math.abs(gap) < TOLERANCE_MS, `median gap ${gap.toFixed(1)} ms: ${shown}`);
});
