#!/usr/bin/env node
/**
 * The controls for U7i fix 1 (0034): a later version that has not started may
 * be withdrawn and replaced, in one transaction, and a withdrawn plan never
 * prices. Every property is broken below, one at a time, in a COPY of the
 * tree, and its suite is REQUIRED to go red -- in the test that names the
 * property. A pass is the failure; so is a red in some other test.
 *
 *   started_withdrawn      a plan that has started is withdrawn: the route's
 *                          check AND the database's trigger both removed (a
 *                          scratch database built from the edited migration;
 *                          either alone is caught by the other)
 *   withdrawn_priced       the plans that price keep withdrawn ones in
 *   direct_reader          `/lane/rules` reads rate_plans itself instead of
 *                          through `ratePlansForGarage`
 *   gate_counts_withdrawn  the database's opening gate counts withdrawn plans
 *   readout_counts_withdrawn
 *                          the opening readout counts plans by its own read
 *   try_carry_ignored      the try prices the stored plans as they are, not as
 *                          the save's carry would leave them
 *   partial_carry          a carry entry that is refused is skipped and the
 *                          rest of the save commits: a partial carry left
 *                          behind
 *
 * Needs the same environment as the suite (the rate engine, the database),
 * plus SUPERUSER_URL and APP_DB_PASSWORD for the scratch database.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const CARRY = 'test/rate-plans-carry.test.js';
const READERS = 'test/rate-plan-readers.test.js';
const SUITES = [CARRY, READERS];
const MIGRATION = 'migrations/0034_rate_plans_withdrawn_before_they_start.sql';
const SCRATCH = process.env.CARRY_SCRATCH_DB || 'openparking_carry_control';

const BREAKS = [
  {
    name: 'started_withdrawn',
    why: 'a plan that has started is withdrawn',
    suite: CARRY,
    red: ['A STARTED PLAN IS NEVER WITHDRAWN', 'the database refuses withdrawing a started plan'],
    schema: true,
    edits: [
      { file: 'src/ratePlans.js', from: '  if (plan.started) {\n', to: '  if (false) {\n' },
      { file: MIGRATION, from: '  IF OLD.effective_from <= clock_timestamp() THEN\n', to: '  IF false THEN\n' },
    ],
  },
  {
    name: 'withdrawn_priced',
    why: 'the plans that price keep withdrawn ones in',
    suite: CARRY,
    red: ['A WITHDRAWN PLAN NEVER PRICES'],
    edits: [{
      file: 'src/ratePlans.js',
      from: '      WHERE tenant_id = $1 AND garage_id = $2 AND withdrawn_at IS NULL\n      ORDER BY effective_from, plan_version`,',
      to: '      WHERE tenant_id = $1 AND garage_id = $2\n      ORDER BY effective_from, plan_version`,',
    }],
  },
  {
    name: 'direct_reader',
    why: '/lane/rules reads rate_plans itself',
    suite: READERS,
    red: ['every statement on rate_plans in the application is inside src/ratePlans.js'],
    edits: [{
      file: 'src/app.js',
      from: '        if (!garage) return { garage };\n        const plans = ratePlans.documents(await ratePlans.ratePlansForGarage(client, tenantId, garageId));\n',
      to: "        if (!garage) return { garage };\n        const plans = (await client.query('SELECT document FROM rate_plans WHERE tenant_id = $1 AND garage_id = $2 AND withdrawn_at IS NULL ORDER BY effective_from', [tenantId, garageId])).rows.map((r) => r.document);\n",
    }],
  },
  {
    name: 'gate_counts_withdrawn',
    why: "the database's opening gate counts withdrawn plans",
    suite: READERS,
    red: ['in the database, the latest definition of every function reading rate_plans'],
    edits: [{
      file: MIGRATION,
      from: '     WHERE garage_id = NEW.id AND tenant_id = NEW.tenant_id AND withdrawn_at IS NULL;',
      to: '     WHERE garage_id = NEW.id AND tenant_id = NEW.tenant_id;',
    }],
  },
  {
    name: 'readout_counts_withdrawn',
    why: 'the opening readout counts plans by its own read',
    suite: CARRY,
    red: ['A WITHDRAWN PLAN NEVER PRICES'],
    edits: [{
      file: 'src/activation.js',
      from: '  const priced = await ratePlansForGarage(client, tenantId, garage.id);\n',
      to: "  const priced = (await client.query('SELECT effective_from FROM rate_plans WHERE tenant_id = $1 AND garage_id = $2 ORDER BY effective_from', [tenantId, garage.id])).rows;\n",
    }],
  },
  {
    name: 'try_carry_ignored',
    why: 'the try prices the stored plans and ignores the carry',
    suite: CARRY,
    red: ['THE TRY TAKES THE SAME CARRY'],
    edits: [{
      file: 'src/ratePlans.js',
      from: '  const gone = new Set(carry.map((c) => c.withdraw));\n  for (const c of carry) {',
      to: '  const gone = new Set();\n  carry = carry.filter(() => false);\n  for (const c of carry) {',
    }],
  },
  {
    name: 'partial_carry',
    why: 'a refused carry entry is skipped and the rest commits',
    suite: CARRY,
    red: ['ALL OR NOTHING'],
    edits: [
      {
        file: 'src/app.js',
        from: '          const old = await ratePlans.withdrawRatePlan(client, req.tenantId, {\n            garage, planId: c.withdraw, actor: `${req.actor.kind}:${req.actor.id}`,\n          });\n',
        to: '          await client.query(\'SAVEPOINT carry\');\n          const old = await ratePlans.withdrawRatePlan(client, req.tenantId, {\n            garage, planId: c.withdraw, actor: `${req.actor.kind}:${req.actor.id}`,\n          }).catch(async () => { await client.query(\'ROLLBACK TO SAVEPOINT carry\'); return null; });\n          if (!old) { withdrawn.push(null); continue; }\n',
      },
      {
        file: 'src/app.js',
        from: '          const old = withdrawn[i];\n',
        to: '          const old = withdrawn[i];\n          if (!old) continue;\n',
      },
    ],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-carry-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

const run = (dir, suite, extraEnv = {}) =>
  spawnSync(process.execPath, ['--test', '--test-reporter=spec', suite], { cwd: dir, env: { ...process.env, ...extraEnv }, stdio: 'pipe', encoding: 'utf8' });

const redTests = (result) => [...new Set([...result.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))];

function summarise(result) {
  const line = (label) => result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'))?.[1] ?? '?';
  return `${line('pass')} passed, ${line('fail')} failed`;
}

/** Every edit's anchor exactly once, or nothing is planted. */
function plant(base, edits) {
  const texts = new Map();
  for (const e of edits) {
    const path = join(base, e.file);
    const source = texts.get(path) ?? readFileSync(path, 'utf8');
    if (source.split(e.from).length !== 2) return e.file;
    texts.set(path, source.replace(e.from, e.to));
  }
  for (const [path, text] of texts) writeFileSync(path, text);
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

/** A scratch database built from the staged copy's migrations (one edited). */
async function buildScratch(dir) {
  const adminUrl = new URL(required('DATABASE_URL'));
  const maintenance = new URL(required('SUPERUSER_URL'));
  maintenance.pathname = '/postgres';
  const scratchAdmin = new URL(adminUrl);
  scratchAdmin.pathname = `/${SCRATCH}`;
  const scratchApp = new URL(`postgres://openparking_app@${adminUrl.host}/${SCRATCH}`);
  scratchApp.password = required('APP_DB_PASSWORD');
  const env = { DATABASE_URL: scratchAdmin.toString(), APP_DATABASE_URL: scratchApp.toString() };
  const c = new pg.Client({ connectionString: maintenance.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  await c.end();
  const partial = mkdtempSync(join(tmpdir(), 'openparking-carry-migrations-'));
  for (const f of readdirSync(join(dir, 'migrations')).filter((n) => n.endsWith('.sql'))) copyFileSync(join(dir, 'migrations', f), join(partial, f));
  for (const script of ['scripts/prepare-database.js', 'scripts/migrate.js']) {
    const r = spawnSync(process.execPath, [script], { cwd: dir, env: { ...process.env, ...env, MIGRATIONS_DIR: partial }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${script} failed against the scratch database:\n${r.stdout}\n${r.stderr}`);
  }
  rmSync(partial, { recursive: true, force: true });
  return { env, maintenance };
}

let failures = 0;

console.log('== control A: the suites must PASS intact ==');
{
  const dir = stage();
  try {
    for (const suite of SUITES) {
      const intact = run(dir, suite);
      if (intact.status === 0) console.log(`  ${suite.padEnd(34)} OK — ${summarise(intact)}`);
      else {
        console.error(`  CONTROL A FAILED — ${suite} does not pass intact: ${summarise(intact)}\n${intact.stdout}\n${intact.stderr}`);
        failures += 1;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function judge(brk, broken) {
  const red = redTests(broken);
  const named = brk.red.every((want) => red.some((t) => t.includes(want)));
  if (broken.status === 0) {
    console.error(`  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
    failures += 1;
  } else if (!named) {
    console.error(`  ${brk.name.padEnd(26)} *** RED, BUT NOT IN "${brk.red.join('", "')}" — red: ${red.join(' | ')} ***`);
    failures += 1;
  } else {
    console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}; named: ${brk.red.join(', ')}`);
  }
}

console.log('\n== control B: each break must make the suite FAIL, in the test that names it ==');
let scratchUsed = null;
for (const brk of BREAKS) {
  const dir = stage();
  try {
    const missing = plant(dir, brk.edits);
    if (missing) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing} ***`);
      failures += 1;
      continue;
    }
    if (brk.schema) {
      const built = await buildScratch(dir);
      scratchUsed = built.maintenance;
      judge(brk, run(dir, brk.suite, built.env));
    } else {
      judge(brk, run(dir, brk.suite));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The scratch database is a database with a property removed: dropped, so
// nothing can later run against it by accident and report a pass.
if (scratchUsed) {
  const c = new pg.Client({ connectionString: scratchUsed.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  await c.end();
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust the U7i fix 1 tests.`);
  process.exit(1);
}
console.log(`\nall controls OK — the suites fail, by name, on every one of the ${BREAKS.length} properties U7i fix 1 rests on.`);
