/**
 * A `VALIDATIONS_DOOR` that can never work is refused BEFORE the port opens.
 *
 * Accepted at start-up and refused at every use, such a setting is silent: the
 * platform reports itself healthy while every garage that offers validations
 * charges its drivers the full fee. So the value is checked once, beside the
 * schema check, by the SAME lookup the door makes at run time (`doorPath` in
 * `src/validations.js`): a bare command name, found in ENTITLEMENT_BIN_DIR or,
 * without one, on PATH, as a file this process may execute. Unset is a real
 * state, not an error: the deployment has no validations module.
 *
 * These start the REAL `src/server.js` and read what the process did, as
 * `schema-gate-empty-migrations.test.js` does. Both sides of the deciding value
 * run through the identical harness: every refusal below has a setting beside
 * it that serves.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOOR_DIR = fileURLToPath(new URL('./fixtures/validations-door/', import.meta.url));
const DOOR_NAME = 'validations-stand-in';

const scratch = mkdtempSync(join(tmpdir(), 'openparking-validations-door-start-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const MARK = join(scratch, 'ran');

// A file by the door's name that this process may not execute, and a directory
// by that name (a directory carries the execute bit too).
const NOT_EXECUTABLE_DIR = join(scratch, 'not-executable');
mkdirSync(NOT_EXECUTABLE_DIR);
writeFileSync(join(NOT_EXECUTABLE_DIR, DOOR_NAME), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
const DIRECTORY_DIR = join(scratch, 'directory');
mkdirSync(join(DIRECTORY_DIR, DOOR_NAME), { recursive: true });

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

/** Whether anything accepts a connection on `port` now. */
function listening(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Start the real entrypoint with the door settings given (`undefined` = unset)
 * and read what it did: it served (`/healthz` answered 200) or it exited.
 * Whichever comes first; a process that does neither in 30 s is a red test.
 */
async function start({ door, binDir, path = process.env.PATH }) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), PATH: path };
  delete env.VALIDATIONS_DOOR;
  delete env.ENTITLEMENT_BIN_DIR;
  if (door !== undefined) env.VALIDATIONS_DOOR = door;
  if (binDir !== undefined) env.ENTITLEMENT_BIN_DIR = binDir;
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

/** Refused at start-up: exit 1, the one sentence naming the setting, no port. */
async function assertRefused(settings, sentence) {
  const out = await start(settings);
  const what = JSON.stringify(settings);
  assert.equal(out.served, false, `${what} served`);
  assert.equal(out.code, 1, `${what}: exit ${out.code}\n${out.stdout}${out.stderr}`);
  assert.equal(out.stderr.trim(), `[platform] REFUSING TO SERVE: ${sentence}`, what);
  assert.doesNotMatch(out.stdout, /listening/, what);
  assert.equal(await listening(out.port), false, `${what}: something listens on its port`);
}

const notBare = (value) => `VALIDATIONS_DOOR is not a bare command name (it is set to ${JSON.stringify(value)}).`;
const notFound = (value, where) => `VALIDATIONS_DOOR names no executable file ${where} (it is set to ${JSON.stringify(value)}).`;

test('unset serves: this deployment has no validations module', async () => {
  const out = await start({});
  assert.equal(out.served, true, `${out.stdout}${out.stderr}`);
});

test('the stand-in serves, found in ENTITLEMENT_BIN_DIR', async () => {
  const out = await start({ door: DOOR_NAME, binDir: DOOR_DIR });
  assert.equal(out.served, true, `${out.stdout}${out.stderr}`);
});

test('the stand-in serves, found on PATH', async () => {
  const out = await start({ door: DOOR_NAME, path: `${DOOR_DIR}${delimiter}${process.env.PATH}` });
  assert.equal(out.served, true, `${out.stdout}${out.stderr}`);
});

test('a real command found on PATH serves: it is a bare name and it resolves', async () => {
  // Which command is the door is the deployer's to say. A wrong but real one
  // is not something a start-up check can know; the door's own answers are.
  const out = await start({ door: 'sh' });
  assert.equal(out.served, true, `${out.stdout}${out.stderr}`);
});

test('a value that is not a bare command name refuses to serve, naming the setting and the value', async () => {
  // The values the gate tried at run time, but for `sh` (below) and its
  // stand-in control: every one now refused before the port opens. `a..b` is
  // refused for its `..`.
  const values = [
    '../validations-door/validations-stand-in',
    'validations-door/validations-stand-in',
    '/bin/sh',
    `/usr/bin/touch ${MARK}`,
    '..',
    'a..b',
    '.hidden',
    ' validations-stand-in',
    'validations-stand-in ',
    'door x',
    `x;touch ${MARK}`,
    `$(touch ${MARK})`,
    `\`touch ${MARK}\``,
    '-x',
    '~/x',
    'validations-stand-in\n',
    'C:\\x',
  ];
  for (const door of values) await assertRefused({ door, binDir: DOOR_DIR }, notBare(door));
  assert.equal(existsSync(MARK), false, 'something ran');
});

test('a bare name that is not an executable file where the door looks refuses to serve', async () => {
  // `sh` is on PATH, but ENTITLEMENT_BIN_DIR is where the door looks when it is set.
  await assertRefused({ door: 'sh', binDir: DOOR_DIR }, notFound('sh', 'in ENTITLEMENT_BIN_DIR'));
  await assertRefused({ door: 'no-such-door', binDir: DOOR_DIR }, notFound('no-such-door', 'in ENTITLEMENT_BIN_DIR'));
  await assertRefused({ door: 'no-such-door' }, notFound('no-such-door', 'on PATH'));
  await assertRefused({ door: DOOR_NAME, binDir: NOT_EXECUTABLE_DIR }, notFound(DOOR_NAME, 'in ENTITLEMENT_BIN_DIR'));
  await assertRefused({ door: DOOR_NAME, binDir: DIRECTORY_DIR }, notFound(DOOR_NAME, 'in ENTITLEMENT_BIN_DIR'));
  await assertRefused({ door: DOOR_NAME, path: `${NOT_EXECUTABLE_DIR}${delimiter}${DIRECTORY_DIR}` }, notFound(DOOR_NAME, 'on PATH'));
});
