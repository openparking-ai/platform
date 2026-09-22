#!/usr/bin/env node
/**
 * The control for the unprompted reconciler sweep (0018).
 *
 * The sweep looks WITHOUT BEING ASKED, at every lane-decided close nothing has
 * checked yet, WITH NO WINDOW over it, records what it found on the row and in
 * an append-only event -- and CORRECTS NOTHING. Every property is broken
 * below, one at a time, and the suite is REQUIRED to go red. A pass is the
 * failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 *
 *   sweep_has_a_window     the sweep takes only closes inside the route's
 *                          24-hour window -- the gap 0018 exists to close,
 *                          put back.
 *   sweep_corrects         the sweep writes the recomputed fee onto the row:
 *                          the auto-correcting reconciler, unattended, which
 *                          destroys the evidence with nobody watching.
 *   never_marked           a checked row is not marked, so the sweep does the
 *                          same rows for ever and never reaches the rest.
 *   marked_unchecked       rows are marked without being checked: a backlog
 *                          that empties and a protection that ran on nothing.
 *   divergence_unevented   a divergence goes on the row and not into
 *                          `events`, so it can be edited away by anything
 *                          that can write `sessions`.
 *   covered_priced        a covered close is sent to the engine to be priced.
 *   unchecked_uncounted    the operator's route stops saying how many closes
 *                          nothing has checked -- the backlog goes invisible.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0018, so the property genuinely never existed.
 *
 *   verdict_unattached     the constraint holding `decision_checked_at` and
 *                          `decision_check` together never created.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.SWEEP_SCRATCH_DB || 'openparking_sweep_control';

const SOURCE_BREAKS = [
  {
    name: 'sweep_has_a_window',
    why: "the sweep only looks inside the route's window",
    file: 'src/repository.js',
    from: `      WHERE tenant_id = $1 AND decided_by = 'lane' AND decision_checked_at IS NULL
      ORDER BY exit_at`,
    to: `      WHERE tenant_id = $1 AND decided_by = 'lane' AND decision_checked_at IS NULL
        AND exit_at >= now() - interval '24 hours'
      ORDER BY exit_at`,
  },
  {
    name: 'sweep_corrects',
    why: 'the sweep writes the recomputed fee onto the row',
    file: 'src/reconcile.js',
    from: '  await repo.recordDecisionCheck(client, tenantId, row.id, { at, check });',
    to: "  await repo.recordDecisionCheck(client, tenantId, row.id, { at, check });\n"
      + "  if (check.recomputed) {\n"
      + "    await client.query('UPDATE sessions SET fee_minor = $2 WHERE id = $1',"
      + " [row.id, check.recomputed.fee_minor]);\n  }",
  },
  {
    name: 'never_marked',
    why: 'a checked row is never marked, so the sweep repeats it for ever',
    file: 'src/reconcile.js',
    from: '  await repo.recordDecisionCheck(client, tenantId, row.id, { at, check });',
    to: '  void repo;',
  },
  {
    name: 'marked_unchecked',
    why: 'rows are marked without being checked',
    file: 'src/reconcile.js',
    from: '  const laneSaidCovered = row.exit_outcome === \'covered\';',
    to: "  const laneSaidCovered = row.exit_outcome === 'covered';\n"
      + "  { const planted = { verdict: 'agreed', at };\n"
      + "    await repo.recordDecisionCheck(client, tenantId, row.id, { at, check: planted });\n"
      + '    return planted; }',
  },
  {
    name: 'divergence_unevented',
    why: 'a divergence never reaches the append-only events table',
    file: 'src/reconcile.js',
    from: "  if (check.verdict !== 'agreed' && check.verdict !== 'covered') {",
    to: '  if (false) {',
  },
  {
    name: 'covered_priced',
    why: 'a covered close is sent to the engine to be priced',
    file: 'src/reconcile.js',
    from: "  const laneSaidCovered = row.exit_outcome === 'covered';",
    to: '  const laneSaidCovered = false;',
  },
  {
    name: 'unchecked_uncounted',
    why: 'the route stops saying how many closes nothing has checked',
    file: 'src/reconcile.js',
    from: '    lane_decisions_unchecked: await repo.uncheckedLaneDecisionCount(client, tenantId, garageId),',
    to: '    lane_decisions_unchecked: 0,',
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'verdict_unattached',
    why: 'the constraint holding the check and its verdict together never created',
    edits: [
      {
        file: '0018_lane_decision_checks.sql',
        from: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_decision_check_is_attributed CHECK (`,
        to: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_decision_check_is_attributed_disabled CHECK (true OR`,
      },
    ],
  },
];

const SUITE = ['--test', '--test-timeout=120000', 'test/lane-decision-sweep.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-sweep-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir, extraEnv = {}) {
  return spawnSync(process.execPath, SUITE, {
    cwd: dir,
    env: { ...process.env, ...extraEnv },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  return `${line('pass')} passed, ${line('fail')} failed`;
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
const maintenance = new URL(adminUrl);
maintenance.pathname = '/postgres';

const scratchEnv = {
  DATABASE_URL: scratchAdmin.toString(),
  APP_DATABASE_URL: scratchApp.toString(),
};

async function withAdmin(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A scratch database built from `migrations/` with one statement edited out. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
    await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-sweep-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  for (const edit of brk.edits) {
    const path = join(partial, edit.file);
    const sql = readFileSync(path, 'utf8');
    if (!sql.includes(edit.from)) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, where: edit.file };
    }
    writeFileSync(path, sql.replace(edit.from, edit.to));
  }

  for (const [script, extra] of [
    ['scripts/migrate.js', { MIGRATIONS_DIR: partial }],
    ['scripts/ensure-app-role.js', {}],
  ]) {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, ...scratchEnv, ...extra },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(result.stdout, result.stderr);
      throw new Error(`${script} failed against the scratch database`);
    }
  }
  rmSync(partial, { recursive: true, force: true });
  return { ok: true };
}

function plant(dir, edit) {
  const path = join(dir, edit.file);
  const source = readFileSync(path, 'utf8');
  if (!source.includes(edit.from)) return false;
  writeFileSync(path, source.replace(edit.from, edit.to));
  return true;
}

let failures = 0;

const intactDir = stage();
try {
  console.log('== control A: the suite must PASS intact ==');
  const intact = run(intactDir);
  if (intact.status === 0) {
    console.log(`  control A OK — ${summarise(intact)}`);
  } else {
    console.error(`  CONTROL A FAILED — the suite does not pass even intact: ${summarise(intact)}`);
    console.error(intact.stdout);
    console.error(intact.stderr);
    failures += 1;
  }
} finally {
  rmSync(intactDir, { recursive: true, force: true });
}

console.log('\n== control B: each SOURCE break must make it FAIL ==');
for (const brk of SOURCE_BREAKS) {
  const dir = stage();
  try {
    if (!plant(dir, brk) || (brk.also && !plant(dir, brk.also))) {
      // A break whose anchor has moved applies nothing, and the run then
      // reports a passing suite as a failed control for the wrong reason.
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== control C: each SCHEMA break must make it FAIL ==');
for (const brk of SCHEMA_BREAKS) {
  const dir = stage();
  try {
    const built = await buildScratch(dir, brk);
    if (!built.ok) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND in ${built.where} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir, scratchEnv);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The scratch database is a database with a property removed. Dropped, so
// nothing can later be run against it by accident and report a pass it did
// not earn.
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property the unprompted sweep rests on.');
