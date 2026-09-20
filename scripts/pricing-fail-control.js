#!/usr/bin/env node
/**
 * The control for pricing by the engine, and the close that cannot price.
 *
 * The close hands every plan of the garage to the engine and freezes what
 * comes back; a refusal closes the stay UNPRICED, on the record, instead of
 * refusing the close; an unreachable engine is a retry, not a record. Every
 * property that makes that TRUE rather than merely stated is broken below,
 * one at a time, and the suite is REQUIRED to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 *
 *   no_plan_is_a_409         a garage with no plan answers 409 again -- the
 *                            drop path the round exists to close: the lane
 *                            dead-letters it, the car is gone, the stay
 *                            never closes.
 *   refusal_is_a_500         the engine's refusal is not caught: the close
 *                            answers 5xx, the lane retries for ever, the
 *                            stay never closes. The same hole, other door.
 *   engine_down_is_unpriced  an engine that cannot be reached is recorded
 *                            as a refusal. A priceable stay closes unpriced
 *                            on the strength of an outage.
 *   platform_selects_latest  the close hands the engine only the newest
 *                            version. The platform has made the selection,
 *                            silently, by exit time; the entry-time rule
 *                            is gone and nothing says so.
 *   space_class_literal      the stay is priced as 'standard' whatever the
 *                            garage says.
 *   breakdown_not_frozen     the close stores an empty ledger beside the
 *                            fee: a number with no explanation.
 *   unpriced_not_recorded    the unpriced close writes the row and no event.
 *   report_hides_unpriced    the reconciliation report lists no unpriced
 *                            close. The row exists and nobody is shown it.
 *   store_ignores_space_class
 *                            the store accepts a plan that does not declare
 *                            the garage's class; every exit then refuses.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0013, so the property genuinely never existed.
 *
 *   no_priced_or_refused     `sessions_closed_is_priced_or_refused` never
 *                            created: a closed stay may carry half a pricing,
 *                            or a fee and a refusal at once.
 *   closed_still_needs_fee   0002's `sessions_closed_is_complete` is never
 *                            replaced, so a closed stay must still carry a
 *                            fee, and the unpriced close cannot be written.
 *
 * Needs the same environment as the suite, plus the engine
 * (RATE_ENGINE_PYTHON). The suite starts and stops the engine itself.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.PRICING_SCRATCH_DB || 'openparking_pricing_control';

const SOURCE_BREAKS = [
  {
    name: 'no_plan_is_a_409',
    why: 'a garage with no plan refuses the close',
    file: 'src/app.js',
    from: `  if (plans.length === 0) {
    return {
      refusal: [`,
    to: `  if (plans.length === 0) {
    throw conflict('no_rate_configured', 'garage has no rate configured');
    return {
      refusal: [`,
  },
  {
    name: 'refusal_is_a_500',
    why: "the engine's refusal is not caught and the close fails",
    file: 'src/app.js',
    from: '    if (err instanceof ratePlans.PricingRefused) return { refusal: err.findings };',
    to: '    if (false) return { refusal: err.findings };',
  },
  {
    name: 'engine_down_is_unpriced',
    why: 'an unreachable engine is recorded as a refusal',
    file: 'src/app.js',
    from: '    if (err instanceof ratePlans.PricingRefused) return { refusal: err.findings };',
    to: `    if (err instanceof ratePlans.PricingRefused) return { refusal: err.findings };
    if (err instanceof ratePlans.EngineUnavailable) {
      return { refusal: [{ code: 'ENGINE_UNAVAILABLE', kind: 'gap', text: err.message, rule_ids: [] }] };
    }`,
  },
  {
    name: 'platform_selects_latest',
    why: 'the platform hands the engine only the newest version',
    file: 'src/app.js',
    from: '        const pricing = await priceStay({ garage, plans, session: open, exitAt });',
    to: '        const pricing = await priceStay({ garage, plans: plans.slice(-1), session: open, exitAt });',
  },
  {
    name: 'space_class_literal',
    why: "every stay is priced as 'standard' whatever the garage says",
    file: 'src/app.js',
    from: '      spaceClass: garage.space_class,\n      entryAt: session.entry_at,',
    to: "      spaceClass: 'standard',\n      entryAt: session.entry_at,",
  },
  {
    name: 'breakdown_not_frozen',
    why: 'the close stores an empty ledger beside the fee',
    file: 'src/app.js',
    from: '      breakdown: quote.breakdown,\n      spaceClass: garage.space_class,',
    to: '      breakdown: [],\n      spaceClass: garage.space_class,',
  },
  {
    name: 'unpriced_not_recorded',
    why: 'the unpriced close writes the row and no event',
    file: 'src/app.js',
    from: '        if (pricing.refusal) {\n          // The record:',
    to: '        if (false) {\n          // The record:',
  },
  {
    name: 'report_hides_unpriced',
    why: 'the reconciliation report lists no unpriced close',
    file: 'src/reconcile.js',
    from: '       AND exit_at IS NOT NULL AND fee_minor IS NULL\n       AND exit_at >= $3',
    to: '       AND exit_at IS NOT NULL AND fee_minor IS NULL AND false\n       AND exit_at >= $3',
  },
  {
    name: 'store_ignores_space_class',
    why: "the store accepts a plan that does not declare the garage's class",
    file: 'src/ratePlans.js',
    from: '  if (!classes.includes(garage.space_class)) {',
    to: '  if (false) {',
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'no_priced_or_refused',
    why: 'a closed stay may carry half a pricing, or a fee and a refusal at once',
    edits: [
      {
        file: '0013_pricing_by_the_engine.sql',
        from: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_closed_is_priced_or_refused CHECK (`,
        to: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_closed_is_priced_or_refused_disabled CHECK (true OR`,
      },
    ],
  },
  {
    name: 'closed_still_needs_fee',
    why: "0002's closed-needs-a-fee rule is never replaced, so no unpriced close can be written",
    edits: [
      {
        file: '0013_pricing_by_the_engine.sql',
        from: `ALTER TABLE sessions DROP CONSTRAINT sessions_closed_is_complete;
ALTER TABLE sessions DROP CONSTRAINT sessions_plan_pricing_is_complete;

-- The closing facts come together or not at all.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_closed_is_complete CHECK (
    (exit_at IS NULL AND exit_lane_id IS NULL AND close_event_id IS NULL)
    OR
    (exit_at IS NOT NULL AND exit_lane_id IS NOT NULL AND close_event_id IS NOT NULL)
  );`,
        to: 'ALTER TABLE sessions DROP CONSTRAINT sessions_plan_pricing_is_complete;',
      },
    ],
  },
];

const SUITE = ['--test', 'test/pricing.test.js', 'test/rate-plans.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-pricing-control-'));
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

  const partial = mkdtempSync(join(tmpdir(), 'openparking-pricing-migrations-'));
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
console.log('\nall controls OK — the suite fails on every property the engine-priced close rests on.');
