#!/usr/bin/env node
/**
 * The control for a new garage's checks (POST /garages; src/garageFields.js):
 * a time zone the database does not know, a currency outside the list or not
 * in capitals, and a name that is not text or is longer than the column
 * allows, each refused in a plain sentence and never stored -- and the
 * column's own bound (0032).
 *
 * Every property is broken below, one at a time, and the suite is REQUIRED to
 * go red. A pass is the failure.
 *
 * Breaks are applied to a COPY of the tree; no tracked file is edited. Each
 * anchor must occur exactly once in its file, or the break is reported as not
 * planted rather than run. The schema break builds a scratch database from a
 * copy of `migrations/` with the statement edited out. Needs the same
 * environment as the suite.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.SCRATCH_DB || 'openparking_garages_control';

const GARAGES = ['test/garage-checks.test.js'];
const MIGRATION = '0032_operator_invites_and_password_resets.sql';

const BREAKS = [
  {
    name: 'usd_reaches_database',
    why: '"usd" is let through to the database',
    suite: GARAGES,
    edits: [{ file: 'src/garageFields.js', from: '  if (isCurrency(raw)) return raw;\n', to: '  if (isCurrency(String(raw).toUpperCase())) return raw;\n' }],
  },
  {
    name: 'any_currency_taken',
    why: 'any currency is taken, "XYZ" too',
    suite: GARAGES,
    edits: [{ file: 'src/garageFields.js', from: 'export function garageCurrency(raw) {\n', to: 'export function garageCurrency(raw) {\n  return raw;\n' }],
  },
  {
    name: 'any_timezone_taken',
    why: 'any time zone is taken, "Mars/Olympus" too',
    suite: GARAGES,
    edits: [{ file: 'src/garageFields.js', from: 'export async function garageTimezone(db, raw) {\n', to: 'export async function garageTimezone(db, raw) {\n  return raw;\n' }],
  },
  {
    name: 'timezone_any_case',
    why: 'a time zone is matched in any letter case',
    suite: GARAGES,
    edits: [{ file: 'src/garageFields.js', from: "'SELECT 1 FROM pg_timezone_names WHERE name = $1'", to: "'SELECT 1 FROM pg_timezone_names WHERE lower(name) = lower($1)'" }],
  },
  {
    name: 'any_name_taken',
    why: 'any name is taken: a number, an object, 101 characters',
    suite: GARAGES,
    edits: [{ file: 'src/garageFields.js', from: 'export function garageName(raw) {\n', to: 'export function garageName(raw) {\n  return raw;\n' }],
  },
  {
    name: 'name_counted_in_code_units',
    why: "a name's length is counted in UTF-16 code units, not as a person counts",
    suite: GARAGES,
    edits: [{ file: 'src/garageFields.js', from: '[...raw].length > GARAGE_NAME_MAX', to: 'raw.length > GARAGE_NAME_MAX' }],
  },
  {
    name: 'currency_check_unwired',
    why: 'the route stores the currency unchecked',
    suite: GARAGES,
    edits: [{ file: 'src/app.js', from: '      const currency = garageCurrency(raw.currency);\n', to: '      const currency = raw.currency;\n' }],
  },
  {
    name: 'column_unbounded',
    why: 'the column takes a name of any length',
    suite: GARAGES,
    schema: [{
      file: MIGRATION,
      from: 'ALTER TABLE garages\n  ADD CONSTRAINT garages_name_is_bounded CHECK (char_length(name) <= 100) NOT VALID;\n',
      to: '',
    }],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-garages-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir, suite, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', ...suite], { cwd: dir, env, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  const red = [...new Set([...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].slice(0, 70)))];
  return `${line('pass')} passed, ${line('fail')} failed${red.length ? ` -- red: ${red.join(' | ')}` : ''}`;
}

/** Every edit of a break, in the files under `dir`, or none: each anchor exactly once. */
function plant(dir, edits) {
  const planned = new Map();
  for (const e of edits) {
    const path = join(dir, e.file);
    const source = planned.get(path) ?? readFileSync(path, 'utf8');
    if (source.split(e.from).length !== 2) return e.file;
    planned.set(path, source.replace(e.from, () => e.to));
  }
  for (const [path, text] of planned) writeFileSync(path, text);
  return null;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const adminUrl = required('DATABASE_URL');
const appPassword = required('APP_DB_PASSWORD');
const host = new URL(adminUrl).host;
const scratchAdmin = new URL(adminUrl);
scratchAdmin.pathname = `/${SCRATCH}`;
const scratchApp = new URL(`postgres://openparking_app@${host}/${SCRATCH}`);
scratchApp.password = appPassword;
const maintenance = new URL(required('SUPERUSER_URL'));
maintenance.pathname = '/postgres';
const scratchEnv = { DATABASE_URL: scratchAdmin.toString(), APP_DATABASE_URL: scratchApp.toString() };

async function dropScratch() {
  const c = new pg.Client({ connectionString: maintenance.toString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  } finally {
    await c.end();
  }
}

/** A scratch database built from `migrations/` with the break's statements edited. Null, or the file an anchor was not in. */
async function buildScratch(dir, edits) {
  await dropScratch();
  const partial = mkdtempSync(join(tmpdir(), 'openparking-garages-migrations-'));
  try {
    for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
      copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
    }
    const missing = plant(partial, edits);
    if (missing) return missing;
    for (const script of ['scripts/prepare-database.js', 'scripts/migrate.js']) {
      const result = spawnSync(process.execPath, [script], { cwd: dir, env: { ...process.env, ...scratchEnv, MIGRATIONS_DIR: partial }, encoding: 'utf8' });
      if (result.status !== 0) {
        console.error(result.stdout, result.stderr);
        throw new Error(`${script} failed against the scratch database`);
      }
    }
    return null;
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

let failures = 0;

const intactDir = stage();
try {
  console.log('== control A: the suites must PASS intact ==');
  for (const suite of [GARAGES]) {
    const intact = run(intactDir, suite);
    if (intact.status === 0) {
      console.log(`  control A OK — ${suite.join(' ')}: ${summarise(intact)}`);
    } else {
      console.error(`  CONTROL A FAILED — ${suite.join(' ')} does not pass even intact: ${summarise(intact)}`);
      console.error(intact.stdout.slice(-4000));
      console.error(intact.stderr.slice(-4000));
      failures += 1;
    }
  }
} finally {
  rmSync(intactDir, { recursive: true, force: true });
}

console.log('\n== control B: each break must make its suite FAIL ==');
for (const brk of BREAKS) {
  const dir = stage();
  try {
    const missing = plant(dir, brk.edits ?? []) ?? (brk.schema ? await buildScratch(dir, brk.schema) : null);
    if (missing) {
      console.error(`  ${brk.name.padEnd(30)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir, brk.suite, brk.schema ? scratchEnv : {});
    if (broken.status === 0) {
      console.error(`  ${brk.name.padEnd(30)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(30)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (BREAKS.some((b) => b.schema)) await dropScratch();

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's garage checks.`);
  process.exit(1);
}
console.log(`\nall controls OK — the suite fails on every one of the ${BREAKS.length} properties a new garage's checks rest on.`);
