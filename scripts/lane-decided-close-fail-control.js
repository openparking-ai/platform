#!/usr/bin/env node
/**
 * The control for the lane-decided close and the reconciler (0017).
 *
 * The close consumes the lane's decision instead of pricing again, stores
 * what the lane decided from beside the fee, takes no decision about another
 * stay or other money, asks no door for a covered decision; the reconciler
 * recomputes out of band, names the lane that wrote fee + 1, and corrects
 * nothing. Every property is broken below, one at a time, and the suite is
 * REQUIRED to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 *
 *   close_reprices         the close ignores the decision and prices for
 *                          itself: two computations, the screen and the row
 *                          can disagree.
 *   inputs_not_stored      the cache's synced_at is not kept beside the fee.
 *   mismatch_consumed      a decision about a DIFFERENT stay is written as
 *                          this stay's fee.
 *   covered_asks_doors     a covered decision still consults both modules.
 *   reconciler_blind       the reconciler never reports a divergence.
 *   reconciler_corrects    the reconciler writes the recomputed fee onto the
 *                          row -- the auto-correcting reconciler that loses
 *                          the evidence.
 *   ignored_not_kept       a decision the close did not take is dropped
 *                          instead of kept on the record with its reason.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0017, so the property genuinely never existed.
 *
 *   attribution_unchecked  the constraint holding decided_by and
 *                          decision_inputs together never created.
 *
 * Needs the same environment as the suite: the engine, the two modules'
 * scripts, and checkouts of both modules for their migrations.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.CLOSE_SCRATCH_DB || 'openparking_close_control';

const SOURCE_BREAKS = [
  {
    name: 'close_reprices',
    why: 'the close ignores the decision and prices for itself',
    file: 'src/app.js',
    from: "  if (decision === null) return { consume: false, reason: 'no local decision on the close' };\n  if (decision.status === 'covered') return { consume: true };",
    to: "  if (decision === null) return { consume: false, reason: 'no local decision on the close' };\n  return { consume: false, reason: 'PLANTED' };\n  if (decision.status === 'covered') return { consume: true };",
  },
  {
    name: 'inputs_not_stored',
    why: "the cache's synced_at is not kept beside the fee",
    file: 'src/app.js',
    from: '            synced_at: localDecision.computed_from,',
    to: '            synced_at: {},',
  },
  {
    name: 'mismatch_consumed',
    why: 'a decision about a different stay is written as this stay\'s fee',
    file: 'src/app.js',
    from: "  if (decision.session_id !== open.id) {\n    return { consume: false, reason: 'the decision names a different session than the one being closed' };\n  }",
    to: '',
  },
  {
    name: 'covered_asks_doors',
    why: 'a covered decision still consults both modules',
    file: 'src/app.js',
    from: "  if (decision.status === 'covered') return { consume: true };",
    to: "  if (decision.status === 'covered') return { consume: false, reason: 'PLANTED: ask anyway' };",
  },
  {
    name: 'reconciler_blind',
    why: 'the reconciler never reports a divergence',
    file: 'src/reconcile.js',
    from: '    if (recomputed.feeMinor !== laneFee || recomputed.planVersion !== row.plan_version) {',
    to: '    if (false) {',
  },
  {
    name: 'reconciler_corrects',
    why: 'the reconciler writes the recomputed fee onto the row',
    file: 'src/reconcile.js',
    from: '      report.diverged.push({\n        session_id: row.id,',
    to: "      await client.query('UPDATE sessions SET fee_minor = $2 WHERE id = $1', [row.id, recomputed.feeMinor]);\n      report.diverged.push({\n        session_id: row.id,",
  },
  {
    name: 'ignored_not_kept',
    why: 'a decision the close did not take is dropped from the record',
    file: 'src/app.js',
    from: '            asked.record.local_decision_ignored = { reason: consumable.reason, local_decision: localDecision };',
    to: '            void consumable;',
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'attribution_unchecked',
    why: 'the constraint holding decided_by and decision_inputs together never created',
    edits: [
      {
        file: '0017_lane_decided_closes.sql',
        from: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_decision_is_attributed CHECK (`,
        to: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_decision_is_attributed_disabled CHECK (true OR`,
      },
    ],
  },
];

const SUITE = ['--test', '--test-timeout=120000', 'test/lane-decided-close.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-close-control-'));
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

  const partial = mkdtempSync(join(tmpdir(), 'openparking-close-migrations-'));
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
console.log('\nall controls OK — the suite fails on every property the lane-decided close rests on.');
