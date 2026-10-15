#!/usr/bin/env node
/**
 * The control for test/db-restart.test.js: each part of surviving a lost
 * database connection, taken out of a COPY of the tree, must turn that file
 * red. A test that stays green with the part gone does not measure it.
 *
 * THE POSITIVE CONTROL comes first: the copy with nothing planted must be
 * green, or a red below could be the copy, not the plant.
 *
 * The first plant -- the listener on every client removed, the 2026-10-15
 * crash -- is run RUNS times (5 by default) and must be red every time: a
 * crash that depends on timing is not caught by one lucky run.
 *
 * Needs the same environment as the suite.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const RUNS = Number(process.env.DB_RESTART_RUNS || 5);
const LIMIT_MS = Number(process.env.DB_RESTART_LIMIT_MS || 180_000);

const PLANTS = [
  {
    name: 'the listener on every client removed (a connection lost while a request holds it)',
    file: 'src/db.js',
    from: "pool.on('connect', (client) => {\n  client.on('error'",
    to: "pool.on('connect', (client) => {\n  if (client) return;\n  client.on('error'",
    runs: RUNS,
  },
  {
    name: "the pool's own listener removed (an idle connection lost)",
    file: 'src/db.js',
    from: "pool.on('error', (err) => {",
    to: "(() => {}) || pool.on('error', (err) => {",
  },
  {
    name: 'no second try on a fresh connection',
    file: 'src/db.js',
    from: 'if (err.saving || !retry || attempt === 2) {',
    to: 'if (err.saving || !retry || attempt === 1) {',
  },
  {
    name: 'a loss during the COMMIT tried again',
    file: 'src/db.js',
    from: 'if (err.saving || !retry || attempt === 2) {',
    to: 'if (!retry || attempt === 2) {',
  },
  {
    name: 'retry: false ignored',
    file: 'src/db.js',
    from: 'return twice(async () => {\n    const client = await connect();\n    let committing',
    to: 'retry = true;\n  return twice(async () => {\n    const client = await connect();\n    let committing',
  },
  {
    name: 'the 503 answer removed (a loss answered as an internal error)',
    file: 'src/app.js',
    from: '    if (err instanceof DatabaseUnavailable) {\n      res.set(',
    to: '    if (false && err instanceof DatabaseUnavailable) {\n      res.set(',
  },
  {
    name: 'a read lost at its COMMIT told "saving"',
    file: 'src/db.js',
    from: "(err.saving && !['GET', 'HEAD', 'OPTIONS'].includes(method) ?",
    to: '(err.saving ?',
  },
  {
    name: '/healthz no longer asks the database',
    file: 'src/app.js',
    from: '    if (await databaseAnswers()) return',
    to: '    if (true) return',
  },
  {
    name: 'the lookups before a tenant is known not tried again (pool.query)',
    file: 'src/app.js',
    from: "const { rows } = await query('SELECT * FROM resolve_lane_device($1)'",
    to: "const { rows } = await pool.query('SELECT * FROM resolve_lane_device($1)'",
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-db-restart-'));
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

/** Run the file on its own, in its own process group; the whole group is killed at the limit. */
function runFile(dir) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--test', 'test/db-restart.test.js'], {
      cwd: dir, env: process.env, stdio: 'ignore', detached: true,
    });
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, LIMIT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* none left */ }
      done({ code, hung });
    });
  });
}

let failed = 0;

const control = stage();
try {
  const { code, hung } = await runFile(control);
  if (code !== 0 || hung) {
    console.error(`POSITIVE CONTROL: the unplanted copy is not green (exit ${code}${hung ? ', hung' : ''}); nothing below can be read`);
    process.exit(1);
  }
  console.log('control: the unplanted copy is green');
} finally {
  rmSync(control, { recursive: true, force: true });
}

for (const p of PLANTS) {
  const runs = p.runs ?? 1;
  let red = 0;
  for (let i = 0; i < runs; i += 1) {
    const dir = stage();
    try {
      if (!plant(join(dir, p.file), p.from, p.to)) {
        console.error(`NOT PLANTED: ${p.name} -- its text is not in ${p.file} exactly once`);
        failed += 1;
        break;
      }
      const { code, hung } = await runFile(dir);
      if (code !== 0 && !hung) red += 1;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const caught = red === runs;
  console.log(`${caught ? 'caught' : 'MISSED'}: ${p.name} -- red ${red} of ${runs}`);
  if (!caught) failed += 1;
}

if (failed) {
  console.error(`${failed} of ${PLANTS.length} plants not caught`);
  process.exit(1);
}
console.log(`all ${PLANTS.length} plants caught`);
