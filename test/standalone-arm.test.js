/**
 * The standalone arm: a deployment with NO Stripe Connect configured.
 *
 * Every module of this project works on its own, and a self-hoster who runs
 * this platform with no Connect at all -- or with no Stripe at all -- must
 * get a platform that starts and behaves exactly as it did before Connect
 * code existed. So this boots the REAL entrypoint, `src/server.js`, as a
 * separate process with every Connect setting removed from its environment,
 * and asks it: the service answers; an ordinary operator route answers as
 * always; each Connect route answers its one sentence.
 *
 * The rest of the suite is the other half: CI runs all of it with no Connect
 * configured (a workflow step asserts the environment before the tests), so
 * "every existing route behaves exactly as today" is measured by every
 * existing test, not claimed here.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { pool, withTenant, createTenant } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { NO_CONNECT_CONFIGURED } from '../src/stripe.js';

const CONNECT_SETTINGS = ['STRIPE_API_KEY', 'STRIPE_API_BASE', 'CONNECT_RETURN_URL', 'CONNECT_REFRESH_URL'];

let child;
let base;
let token;
let output = '';

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  const tenant = await createTenant('standalone');
  token = generateDeviceToken();
  await withTenant(tenant, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(token)]));

  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  for (const k of CONNECT_SETTINGS) delete env[k];
  child = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (output.includes('listening')) return;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the platform did not start with no Connect configured:\n${output}`);
});

after(async () => {
  child?.kill();
  await pool.end();
});

const op = (method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test('the real entrypoint starts and serves with no Connect configured', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('an ordinary operator route behaves as always', async () => {
  const created = await op('POST', '/garages', { name: 'Standalone', timezone: 'UTC', currency: 'USD' });
  assert.equal(created.status, 201);
  const { garage } = await created.json();
  const lane = await op('POST', `/garages/${garage.id}/lanes`, { name: 'Exit', direction: 'exit' });
  assert.equal(lane.status, 201);
  assert.equal((await op('GET', `/garages/${garage.id}/activation`)).status, 200);
});

test('each Connect route answers one sentence: none is configured', async () => {
  const garage = (await (await op('POST', '/garages', { name: 'Standalone 2', timezone: 'UTC', currency: 'USD' })).json()).garage.id;
  const lane = (await (await op('POST', `/garages/${garage}/lanes`, { name: 'Exit', direction: 'exit' })).json()).lane.id;
  for (const [method, path] of [
    ['POST', `/garages/${garage}/stripe-account`],
    ['GET', `/garages/${garage}/stripe-account`],
    ['POST', `/garages/${garage}/stripe-account/onboarding-link`],
    ['POST', `/garages/${garage}/stripe-account/refresh`],
    ['POST', `/garages/${garage}/stripe-account/location`],
    ['GET', `/garages/${garage}/readers`],
    ['POST', `/lanes/${lane}/reader`],
    ['POST', `/lanes/${lane}/reader/unbind`],
  ]) {
    const res = await op(method, path, method === 'GET' ? undefined : {});
    assert.equal(res.status, 409, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: NO_CONNECT_CONFIGURED, code: 'connect_not_configured' }, `${method} ${path}`);
  }
  assert.ok(!/error/i.test(output), `the server logged an error:\n${output}`);
});
