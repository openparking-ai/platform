/**
 * The one input the schema gate could not say no to: a build shipping no
 * migrations at all.
 *
 * `src/schema.js` compares the migrations this build carries against the rows
 * in `schema_migrations`. With ZERO files that subtraction is `[]` for every
 * database that exists, so the gate returned and the service served, having
 * established nothing. A MISSING `migrations/` directory always refused loudly
 * -- `readdir` raises ENOENT -- and the empty case is the same claim with the
 * same evidence behind it, so it refuses in the same place.
 *
 * These start the REAL `src/server.js`, out of a build tree assembled here, and
 * read what the process did. Nothing is stubbed: the whole point is that the
 * shipped entrypoint refuses before the port opens.
 *
 * Both sides of the deciding value are exercised, because a refusal harness
 * that can only refuse proves nothing about the refusal. Zero files must
 * refuse; the build's real four must serve out of the same tree, spawned the
 * same way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A build tree whose `migrations/` holds exactly what it is given.
 *
 * `MIGRATIONS_DIR` in `src/schema.js` is derived from that file's own location
 * and honours no environment variable -- deliberately, so the check cannot be
 * satisfied by pointing it somewhere emptier. The only way to hand the shipped
 * code a different directory is therefore to move the code, which is what this
 * does: `src/` and `package.json` are copied, `migrations/` is created with the
 * requested contents, and `node_modules` is linked so the copy resolves the
 * same dependencies.
 */
function buildTree({ migrations }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'openparking-empty-migrations-'));
  cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  cpSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  mkdirSync(path.join(dir, 'migrations'));
  for (const file of migrations) {
    cpSync(path.join(ROOT, 'migrations', file), path.join(dir, 'migrations', file));
  }
  return dir;
}

/** Every migration this build ships with -- read, never listed. */
const shipped = readdirSync(path.join(ROOT, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

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

test('the build ships migrations, so the control below has a populated case to run', () => {
  // The negative case is "zero files". If the repository had none either, the
  // two halves of this file would be the same measurement.
  assert.ok(shipped.length > 0, 'migrations/ is empty in the repository itself');
});

test('a build shipping NO migrations refuses to serve, naming why', () => {
  const dir = buildTree({ migrations: [] });
  try {
    // PORT=0 so a broken guard cannot collide with anything; it would listen on
    // an ephemeral port and be killed at the timeout. `timeout` is what turns a
    // regression into a red test rather than a hung suite -- a gate that lets
    // this through does not exit at all.
    const result = spawnSync(process.execPath, ['src/server.js'], {
      cwd: dir,
      env: { ...process.env, PORT: '0' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(
      result.status,
      1,
      `expected exit 1; got status=${result.status} signal=${result.signal}. Output:\n${output}`,
    );
    assert.match(output, /REFUSING TO SERVE/, output);
    assert.match(output, /no migrations on disk/, output);
    assert.match(output, /nothing to be behind/, output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same tree with the build's real migrations serves", async () => {
  // The positive control. It lands on the other side of the deciding value --
  // the file count -- through the identical harness, so a refusal above is
  // attributable to the empty directory and not to the copied tree.
  //
  // A concrete port, not PORT=0: `src/server.js` logs the port it was ASKED
  // for, so with 0 the log says `:0` and there is nothing to poll. The port is
  // taken from the kernel and released immediately before the spawn.
  const dir = buildTree({ migrations: shipped });
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    encoding: 'utf8',
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let gone = false;
  exited.then(() => (gone = true));

  try {
    // Whichever happens first: it answers, or it is gone. Polling alone would
    // spend the whole deadline on a process that died in the first 50ms --
    // the shape `scripts/schema-gate-control.js` already uses.
    const deadline = Date.now() + 30_000;
    let payload = null;
    while (!gone && Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) {
          payload = await res.json();
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.deepEqual(
      payload,
      { ok: true },
      `it did not serve with every migration present (exit ${gone ? await exited : 'still running'}). Output:\n${output}`,
    );
  } finally {
    child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
