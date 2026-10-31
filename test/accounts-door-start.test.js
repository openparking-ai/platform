/**
 * An `ACCOUNTS_DOOR` that can never work is refused BEFORE the port opens, and
 * so is a passkey setting that is not one of its forms.
 *
 * Accepted at start-up and failing at every use, such a door is silent: the
 * platform reports itself healthy while every person beside the admin is told
 * sign-in could not be checked. So the value is checked once, beside the
 * schema check, by the SAME lookup the door makes at run time (src/accountsDoor.js).
 * Unset is a real state, not an error: only the admin signs in.
 *
 * These start the REAL `src/server.js` and read what the process did. Every
 * refusal below has a setting beside it that serves.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOOR_DIR, DOOR_NAME } from './accounts-stand-in.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), 'openparking-accounts-door-start-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const MARK = join(scratch, 'ran');

const NOT_EXECUTABLE_DIR = join(scratch, 'not-executable');
mkdirSync(NOT_EXECUTABLE_DIR);
writeFileSync(join(NOT_EXECUTABLE_DIR, DOOR_NAME), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
const DIRECTORY_DIR = join(scratch, 'directory');
mkdirSync(join(DIRECTORY_DIR, DOOR_NAME), { recursive: true });

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

function listening(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** Start the real entrypoint and read what it did: served, or exited. */
async function start({ door, binDir, path = process.env.PATH, extra = {} }) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), PATH: path };
  for (const k of ['ACCOUNTS_DOOR', 'ENTITLEMENT_BIN_DIR', 'PASSKEY_RP_ID', 'PASSKEY_ORIGINS', 'PASSKEY_RP_NAME', 'ADMIN_ORIGIN']) delete env[k];
  if (door !== undefined) env.ACCOUNTS_DOOR = door;
  if (binDir !== undefined) env.ENTITLEMENT_BIN_DIR = binDir;
  Object.assign(env, extra);
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
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.status === 200) return { served: true, port, stdout, stderr };
      } catch {
        // not listening yet, or never will be
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (code === null) assert.fail(`neither served nor exited within 30 s:\n${stdout}${stderr}`);
    return { served: false, code, port, stdout, stderr };
  } finally {
    if (code === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

async function assertRefused(settings, sentence) {
  const out = await start(settings);
  const what = JSON.stringify(settings);
  assert.equal(out.served, false, `${what} served`);
  assert.equal(out.code, 1, `${what}: exit ${out.code}\n${out.stdout}${out.stderr}`);
  assert.equal(out.stderr.trim(), `[platform] REFUSING TO SERVE: ${sentence}`, what);
  assert.doesNotMatch(out.stdout, /listening/, what);
  assert.equal(await listening(out.port), false, `${what}: something listens on its port`);
}

const notBare = (value) => `ACCOUNTS_DOOR is not a bare command name (it is set to ${JSON.stringify(value)}).`;
const notFound = (value, where) => `ACCOUNTS_DOOR names no executable file ${where} (it is set to ${JSON.stringify(value)}).`;

test('unset serves, and says only the admin signs in', async () => {
  const out = await start({});
  assert.equal(out.served, true, `${out.stdout}${out.stderr}`);
  assert.match(out.stdout, /only the admin signs in: ACCOUNTS_DOOR is not set/);
  assert.match(out.stdout, /passkeys are off: PASSKEY_RP_ID is not set/);
});

test('the stand-in serves, found in ENTITLEMENT_BIN_DIR or on PATH', async () => {
  const inDir = await start({ door: DOOR_NAME, binDir: DOOR_DIR });
  assert.equal(inDir.served, true, `${inDir.stdout}${inDir.stderr}`);
  assert.doesNotMatch(inDir.stdout, /only the admin signs in/);
  const onPath = await start({ door: DOOR_NAME, path: `${DOOR_DIR}${delimiter}${process.env.PATH}` });
  assert.equal(onPath.served, true, `${onPath.stdout}${onPath.stderr}`);
});

test('a value that is not a bare command name refuses to serve, naming the setting and the value; nothing runs', async () => {
  const values = [
    '../accounts-door/accounts-stand-in',
    'accounts-door/accounts-stand-in',
    '/bin/sh',
    `/usr/bin/touch ${MARK}`,
    '..',
    'a..b',
    '.hidden',
    ' accounts-stand-in',
    'door x',
    `x;touch ${MARK}`,
    `$(touch ${MARK})`,
    '-x',
    '~/x',
  ];
  for (const door of values) await assertRefused({ door, binDir: DOOR_DIR }, notBare(door));
  assert.equal(existsSync(MARK), false, 'something ran');
});

test('a bare name that is not an executable file where the door looks refuses to serve', async () => {
  await assertRefused({ door: 'sh', binDir: DOOR_DIR }, notFound('sh', 'in ENTITLEMENT_BIN_DIR'));
  await assertRefused({ door: 'no-such-door' }, notFound('no-such-door', 'on PATH'));
  await assertRefused({ door: DOOR_NAME, binDir: NOT_EXECUTABLE_DIR }, notFound(DOOR_NAME, 'in ENTITLEMENT_BIN_DIR'));
  await assertRefused({ door: DOOR_NAME, binDir: DIRECTORY_DIR }, notFound(DOOR_NAME, 'in ENTITLEMENT_BIN_DIR'));
});

test('passkeys: a relying party over the origins serves; one that is not refuses to serve, by name', async () => {
  const ok = await start({ extra: { ADMIN_ORIGIN: 'https://admin.example.test', PASSKEY_RP_ID: 'example.test' } });
  assert.equal(ok.served, true, `${ok.stdout}${ok.stderr}`);
  assert.doesNotMatch(ok.stdout, /passkeys are off/);
  await assertRefused(
    { extra: { ADMIN_ORIGIN: 'https://admin.example.test', PASSKEY_RP_ID: 'other.test' } },
    'PASSKEY_RP_ID must be the host of every origin in PASSKEY_ORIGINS or a domain above it; "https://admin.example.test" is not',
  );
  await assertRefused(
    { extra: { ADMIN_ORIGIN: 'https://admin.example.test', PASSKEY_RP_ID: 'https://example.test' } },
    'PASSKEY_RP_ID must be a domain, lower case, with no scheme, port or path',
  );
});
