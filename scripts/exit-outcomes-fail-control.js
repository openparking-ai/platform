#!/usr/bin/env node
/**
 * The control for the exit's three outcomes and the two modules consulted.
 *
 * A covered stay leaves with no fee, a transient one is priced, the third
 * outcome is declared and produced nowhere, both modules are asked through
 * their own doors and their answers kept, a module that cannot decide is not
 * a not-covered, links are stated and probed, and the purge reaches the
 * record. Every property is broken below, one at a time, and the suite is
 * REQUIRED to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 *
 *   covered_still_priced       the close ignores a covered answer and prices
 *                              the stay: a pass holder billed.
 *   not_covered_is_covered     a not-covered answer counts as covered: every
 *                              car leaves free.
 *   monthly_not_consulted      only garage-pass is asked; a monthly vehicle
 *                              is billed as transient.
 *   garage_pass_not_consulted  only monthly-billing is asked.
 *   cannot_decide_is_transient a module that could not answer is recorded as
 *                              not covered and the stay is priced -- the
 *                              outage-bills-a-pass-holder defect.
 *   link_unprobed              a stated link is stored without the module
 *                              answering for it.
 *   covered_not_recorded       a covered exit writes the row and no event.
 *   answer_not_kept            the modules' answers are dropped from the
 *                              record; only the verdict survives.
 *   card_on_file_produced      a transient close is written as the third
 *                              outcome, which nothing can produce yet.
 *   purge_keeps_entitlement    the purge redacts the vehicle and leaves the
 *                              record naming it.
 *   identity_guessed           the platform consults with the plate even for
 *                              a ticket stay (the ticket text replaced by an
 *                              empty identity).
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0015, so the property genuinely never existed.
 *
 *   covered_may_carry_a_fee    the four-shape constraint never created.
 *   link_shape_unchecked       the link CHECKs never created.
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
const SCRATCH = process.env.OUTCOMES_SCRATCH_DB || 'openparking_outcomes_control';

const SOURCE_BREAKS = [
  {
    name: 'covered_still_priced',
    why: 'a covered answer is ignored and the stay is priced',
    file: 'src/app.js',
    from: '        if (asked.outcome === entitlement.EXIT_OUTCOMES.COVERED) {\n          pricing = { outcome: entitlement.EXIT_OUTCOMES.COVERED };',
    to: '        if (false) {\n          pricing = { outcome: entitlement.EXIT_OUTCOMES.COVERED };',
  },
  {
    name: 'not_covered_is_covered',
    why: 'a not-covered answer counts as covered',
    file: 'src/entitlement.js',
    from: '    if (answer.covered) coveredBy.push(module);',
    to: '    coveredBy.push(module);',
  },
  {
    name: 'monthly_not_consulted',
    why: 'only garage-pass is asked',
    file: 'src/entitlement.js',
    from: "  for (const module of Object.keys(MODULES)) {\n    const link = garage[MODULES[module].linkColumn];",
    to: "  for (const module of ['garage_pass']) {\n    const link = garage[MODULES[module].linkColumn];",
  },
  {
    name: 'garage_pass_not_consulted',
    why: 'only monthly-billing is asked',
    file: 'src/entitlement.js',
    from: "  for (const module of Object.keys(MODULES)) {\n    const link = garage[MODULES[module].linkColumn];",
    to: "  for (const module of ['monthly_billing']) {\n    const link = garage[MODULES[module].linkColumn];",
  },
  {
    name: 'cannot_decide_is_transient',
    why: 'a module that could not answer is recorded as not covered',
    file: 'src/entitlement.js',
    from: '    const answer = await ask(module, link, { identity, laneId, entryAt, exitAt }, options);\n    record[module] = answer;',
    to: `    let answer;
    try {
      answer = await ask(module, link, { identity, laneId, entryAt, exitAt }, options);
    } catch (err) {
      answer = { consulted: true, module, link, covered: false, error: String(err.message) };
    }
    record[module] = answer;`,
  },
  {
    name: 'link_unprobed',
    why: 'a stated link is stored without the module answering for it',
    file: 'src/entitlement.js',
    from: '    if (links[module]) probes[module] = await probeLink(module, links[module], options);',
    to: '    if (links[module]) probes[module] = { answered: true, exit_code: 1 };',
  },
  {
    name: 'covered_not_recorded',
    why: 'a covered exit writes the row and no event',
    file: 'src/app.js',
    from: '        if (pricing.outcome === entitlement.EXIT_OUTCOMES.COVERED) {\n          // The record: a stay that leaves',
    to: '        if (false) {\n          // The record: a stay that leaves',
  },
  {
    name: 'answer_not_kept',
    why: "the modules' answers are dropped from the record",
    file: 'src/entitlement.js',
    from: '      return { ...record, covered: answer.outcome === \'covered\', answer };',
    to: '      return { ...record, covered: answer.outcome === \'covered\' };',
  },
  {
    name: 'card_on_file_produced',
    why: 'a transient close is written as the third outcome',
    file: 'src/app.js',
    from: '          pricing = { outcome: entitlement.EXIT_OUTCOMES.TRANSIENT, ...(await priceStay({ garage, plans, session: open, exitAt })) };',
    to: '          pricing = { outcome: entitlement.EXIT_OUTCOMES.TRANSIENT_CARD_ON_FILE, ...(await priceStay({ garage, plans, session: open, exitAt })) };',
  },
  {
    name: 'purge_keeps_entitlement',
    why: 'the purge leaves the record naming the redacted identity',
    file: 'src/retention.js',
    from: '          WHERE tenant_id = $1 AND entitlement IS NOT NULL AND vehicle_id = ANY($2::uuid[])`,',
    to: '          WHERE tenant_id = $1 AND entitlement IS NOT NULL AND false AND vehicle_id = ANY($2::uuid[])`,',
  },
  {
    name: 'identity_guessed',
    why: 'a ticket stay is consulted without its ticket',
    file: 'src/app.js',
    from: '          identity: vehicle.plate ?? vehicle.ticket_ref,',
    to: "          identity: vehicle.plate ?? 'unknown',",
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'covered_may_carry_a_fee',
    why: 'the four-shape constraint never created',
    edits: [
      {
        file: '0015_exit_outcomes.sql',
        from: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_closed_is_covered_priced_or_refused CHECK (`,
        to: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_closed_is_covered_priced_or_refused_disabled CHECK (true OR`,
      },
    ],
  },
  {
    name: 'link_shape_unchecked',
    why: 'the link CHECKs never created',
    edits: [
      {
        file: '0015_exit_outcomes.sql',
        from: `  ADD CONSTRAINT garages_garage_pass_link_is_a_link CHECK (
    garage_pass_link IS NULL OR (`,
        to: `  ADD CONSTRAINT garages_garage_pass_link_is_a_link CHECK (
    true OR garage_pass_link IS NULL OR (`,
      },
    ],
  },
];

const SUITE = ['--test', 'test/exit-outcomes.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-outcomes-control-'));
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

  const partial = mkdtempSync(join(tmpdir(), 'openparking-outcomes-migrations-'));
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
    if (!plant(dir, brk)) {
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
    if (brk.source && !plant(dir, brk.source)) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND in ${brk.source.file} ***`);
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
console.log('\nall controls OK — the suite fails on every property the three outcomes rest on.');
