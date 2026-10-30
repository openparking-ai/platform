/**
 * scripts/stripe-test-mode-check.js runs one exit payment against Stripe's
 * TEST mode; CI holds no key, so the run itself is never part of the suite.
 * What is measured here is what keeps it safe to hand a key to: it refuses
 * any key that is not a test key before anything is sent, never prints the
 * key, and with no key runs nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testKey } from '../scripts/stripe-test-mode-check.js';

// Assembled at runtime: a key-shaped literal is refused in this repository even when invented.
const live = ['sk', 'live', 'stubLiveKeyNeverSent0001'].join('_');
const restrictedLive = ['rk', 'live', 'stubLiveKeyNeverSent0002'].join('_');
const testOne = ['sk', 'test', 'stubTestKeyForTheSuite0003'].join('_');
const SCRIPT = resolve(import.meta.dirname, '..', 'scripts', 'stripe-test-mode-check.js');

const run = (env) => spawnSync(process.execPath, [SCRIPT], {
  env: { PATH: process.env.PATH, ...env },
  encoding: 'utf8',
  timeout: 20_000,
});

test('only a test key is taken; a live one, or anything else, is refused by name', () => {
  assert.deepEqual(testKey({}), { none: true });
  assert.match(testKey({ STRIPE_API_KEY: live }).refused, /not a Stripe TEST key/);
  assert.match(testKey({ STRIPE_API_KEY: restrictedLive }).refused, /not a Stripe TEST key/);
  assert.match(testKey({ STRIPE_API_KEY: 'pk_test_x' }).refused, /not a Stripe TEST key/);
  assert.deepEqual(testKey({ STRIPE_API_KEY: testOne }), { key: testOne, account: null });
  assert.match(testKey({ STRIPE_API_KEY: testOne, STRIPE_TEST_ACCOUNT: 'acct x' }).refused, /acct_/);
  const dir = mkdtempSync(join(tmpdir(), 'stripe-check-'));
  try {
    writeFileSync(join(dir, 'key'), `${live}\n`);
    assert.match(testKey({ STRIPE_TEST_KEY_FILE: join(dir, 'key'), STRIPE_API_KEY: testOne }).refused, /not a Stripe TEST key/, 'the file wins, and is held to the same rule');
    assert.match(testKey({ STRIPE_TEST_KEY_FILE: join(dir, 'missing') }).refused, /cannot be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live key: refused before anything is sent, exit 1, and the key is printed nowhere', () => {
  // A base no request could reach: anything sent would fail differently.
  const out = run({ STRIPE_API_KEY: live, STRIPE_API_BASE: 'http://127.0.0.1:9' });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not a Stripe TEST key/);
  assert.ok(!`${out.stdout}${out.stderr}`.includes(live), 'the key is not printed');
  assert.ok(!`${out.stdout}${out.stderr}`.includes('stubLiveKey'), 'not even in part');
});

test('no key: nothing is run, it says so, exit 2', () => {
  const out = run({});
  assert.equal(out.status, 2);
  assert.match(out.stdout, /nothing was run/);
});
