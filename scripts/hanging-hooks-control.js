#!/usr/bin/env node
/**
 * The control for a test file whose `before` throws: the run must END, RED --
 * never hang.
 *
 * An `after` hook that closed `server` unguarded threw a TypeError when
 * `before` had failed before assigning it, and everything after that line in
 * the hook -- stopping the rate engine's child, ending the pool -- never ran.
 * The file then hung until something killed it: in CI, the job's timeout,
 * hours later, instead of a red step in seconds.
 *
 * For each file below a COPY of the tree is made with one line planted in its
 * `before`, just before `server` is assigned -- after the engine, where there
 * is one, has started -- that throws. The file is run on its own and must
 * exit non-zero inside the time limit.
 *
 * THE POSITIVE CONTROL comes first: one file with its `after` put back the way
 * it was (the close unguarded) and the same throw planted. It must HANG -- be
 * killed at the limit -- or this script cannot see the failure it exists for.
 *
 * Needs the same environment as the suite.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** Every file whose `after` closed `server` unguarded before this was fixed. */
const FILES = [
  'activation', 'api', 'entry-confirmation', 'entry-descriptor', 'exit-descriptor', 'lane-reader',
  'pricing', 'rate-plans', 'shadow', 'stripe-account', 'ticket-identity',
];

const LIMIT_MS = Number(process.env.HANG_LIMIT_MS || 60_000);
const POSITIVE_LIMIT_MS = Number(process.env.HANG_POSITIVE_LIMIT_MS || 20_000);

const ANCHOR = '  server = createApp().listen(0);\n';
const THROW = "  throw new Error('PLANTED: this before failed after starting what it started');\n";

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-hanging-hooks-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Exactly once, or the plant measures nothing. */
function plant(path, from, to) {
  const text = readFileSync(path, 'utf8');
  if (text.split(from).length !== 2) return false;
  writeFileSync(path, text.replace(from, to));
  return true;
}

/**
 * Run one file on its own, in its own process group, and kill the whole group
 * at the limit -- the engine's Python child included, so a hang leaves nothing
 * running. Resolves `{ code, hung }`.
 */
function runFile(dir, file, limitMs) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--test', `test/${file}.test.js`], {
      cwd: dir, env: process.env, stdio: 'ignore', detached: true,
    });
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, limitMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Whatever the file left behind in its group goes with it.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* none left */ }
      done({ code, hung });
    });
  });
}

let failures = 0;

console.log('== positive control: an UNGUARDED close with a throwing before must HANG ==');
{
  const dir = stage();
  try {
    const path = join(dir, 'test', 'activation.test.js');
    const unguarded = plant(path, '  if (server) await new Promise((r) => server.close(r));\n', '  await new Promise((r) => server.close(r));\n');
    if (!unguarded || !plant(path, ANCHOR, THROW + ANCHOR)) {
      console.error('  *** ANCHOR NOT FOUND EXACTLY ONCE in test/activation.test.js ***');
      failures += 1;
    } else {
      const result = await runFile(dir, 'activation', POSITIVE_LIMIT_MS);
      if (result.hung) {
        console.log(`  hangs as required: killed at ${POSITIVE_LIMIT_MS} ms`);
      } else {
        console.error(`  *** IT ENDED (exit ${result.code}) — this script cannot see a hang, and its other results mean nothing ***`);
        failures += 1;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== each file, its before made to throw, must END RED inside the limit ==');
for (const file of FILES) {
  const dir = stage();
  try {
    if (!plant(join(dir, 'test', `${file}.test.js`), ANCHOR, THROW + ANCHOR)) {
      console.error(`  ${file.padEnd(20)} *** ANCHOR NOT FOUND EXACTLY ONCE ***`);
      failures += 1;
      continue;
    }
    const started = Date.now();
    const result = await runFile(dir, file, LIMIT_MS);
    const took = Date.now() - started;
    if (result.hung) {
      console.error(`  ${file.padEnd(20)} *** HUNG — killed at ${LIMIT_MS} ms ***`);
      failures += 1;
    } else if (result.code === 0) {
      console.error(`  ${file.padEnd(20)} *** PASSED with a before that threw ***`);
      failures += 1;
    } else {
      console.log(`  ${file.padEnd(20)} ended red (exit ${result.code}) in ${took} ms`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed.`);
  process.exit(1);
}
console.log(`\nall ${FILES.length} files end red when their before throws, and the check can see a hang.`);
