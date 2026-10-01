#!/usr/bin/env node
/**
 * The control for tax on what the driver pays (migration 0023).
 *
 * The order is one order everywhere -- base lines, the validation line, the
 * tax lines -- with the tax the engine's, on the subtotal after the
 * validation, at the stay's exit instant; a lane's decision taxed with a set
 * it did not hold is not written; and the table refuses a row whose subtotal
 * and tax lines do not make its fee. Every property is broken below, one at a
 * time, and `test/tax-on-paid.test.js` is REQUIRED to go red. A pass is the
 * failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 *
 *   claim_on_taxed            the validation is claimed on the lane's TAXED fee.
 *   tax_on_undiscounted       the close takes the hold's tax on the fee BEFORE
 *                             the discount.
 *   tax_for_unrecordable      the close takes the tax for a hold it cannot
 *                             record, so an engine outage stops a lane-decided
 *                             close that needs no engine (gate F1).
 *   lane_tax_kept             with a validation recorded, the lane's ledger --
 *                             tax on the full fee -- is written anyway.
 *   zero_tax_line             a driver paying nothing gets a zero tax line.
 *   reader_held_to_untaxed    what the reader showed is compared with the
 *                             discounted subtotal, untaxed.
 *   reader_told_untaxed       the reader is told the discounted subtotal,
 *                             untaxed.
 *   count_test_dropped        a lane missing a set is consumed when only the
 *                             count would have seen it (a BACKDATED set).
 *   window_test_dropped       a later set in force is consumed when the count
 *                             premise has broken.
 *   instant_is_now            the set is chosen by "now", not the exit.
 *   platform_close_untaxed    a stay the platform prices itself is not taxed.
 *   reconciler_counts_tax     the reconciler compares the quote with the fee
 *                             INCLUDING its tax lines.
 *   old_lane_consumed         a decision with no subtotal is consumed.
 *   subtotal_not_written      the close writes no subtotal.
 *   rules_serve_no_sets       /lane/rules serves no tax sets.
 *   rules_serve_store_fields  /lane/rules serves the store's rows, not what a
 *                             load takes.
 *
 * SCHEMA break: a SCRATCH DATABASE built from a copy of `migrations/` with
 * the statement edited out of 0023, so the property genuinely never existed.
 *
 *   no_sum_check              the table accepts a row whose subtotal and tax
 *                             lines do not add up to its fee.
 *
 * Needs the same environment as the suite, plus the engine
 * (RATE_ENGINE_PYTHON).
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.TAX_ON_PAID_SCRATCH_DB || 'openparking_tax_on_paid_control';

const SOURCE_BREAKS = [
  {
    name: 'claim_on_taxed',
    why: "the validation is claimed on the lane's taxed fee",
    edits: [{
      file: 'src/app.js',
      from: 'garage, sessionId, claimId: pre.attempt, phone, feeMinor: decision.subtotal_minor, currency: decision.currency,',
      to: 'garage, sessionId, claimId: pre.attempt, phone, feeMinor: decision.fee_minor, currency: decision.currency,',
    }],
  },
  {
    name: 'tax_on_undiscounted',
    why: "the close takes the hold's tax on the fee before the discount",
    edits: [{
      file: 'src/app.js',
      from: '{ subtotalMinor: heldAtClose.fee_after_minor, currency: heldAtClose.currency, at: taxAt }',
      to: '{ subtotalMinor: heldAtClose.base_minor, currency: heldAtClose.currency, at: taxAt }',
    }],
  },
  {
    name: 'tax_for_unrecordable',
    why: 'the close takes the tax for a hold it cannot record (released, releasing, not shown)',
    edits: [{
      file: 'src/app.js',
      from: '        const taxOnHeld = validations.recordableHold({ held: heldAtClose, pricing, readerShown })',
      to: '        const taxOnHeld = Number.isInteger(heldAtClose?.fee_after_minor) && validations.isPriced(pricing)',
    }],
  },
  {
    name: 'lane_tax_kept',
    why: "with a validation recorded, the lane's ledger is written anyway",
    edits: [{
      file: 'src/app.js',
      from: '  if (taxLines !== undefined) {\n',
      to: '  if (taxLines !== undefined && asDecided === undefined) {\n',
    }],
  },
  {
    name: 'zero_tax_line',
    why: 'a driver paying nothing gets a zero tax line',
    edits: [{
      file: 'src/app.js',
      from: 'feeMinor: subtotalMinor + taxes.taxDelta(taxLines), breakdown: [...rest.breakdown, ...taxLines] };',
      to: "feeMinor: subtotalMinor + taxes.taxDelta(taxLines), breakdown: [...rest.breakdown, ...(taxLines.length ? taxLines : [{ code: 'tax.applied', rule_id: null, text: 'no tax', delta_minor: 0 }])] };",
    }],
  },
  {
    name: 'reader_held_to_untaxed',
    why: 'what the reader showed is compared with the untaxed discounted subtotal',
    edits: [{
      file: 'src/validations.js',
      from: '  const shownMinor = recordable ? held.fee_after_minor + taxOnHeld.totalMinor : null;',
      to: '  const shownMinor = recordable ? held.fee_after_minor : null;',
    }],
  },
  {
    name: 'reader_told_untaxed',
    why: 'the reader is told the untaxed discounted subtotal',
    edits: [{
      file: 'src/app.js',
      from: "    fee_minor: assertMinor(r.fee_after_minor + out.tax.totalMinor, 'fee_minor'),",
      to: "    fee_minor: assertMinor(r.fee_after_minor, 'fee_minor'),",
    }],
  },
  {
    name: 'count_test_dropped',
    why: 'a lane missing a backdated set is consumed',
    edits: [{ file: 'src/app.js', from: '  if (taxFacts.stated > held.count) {', to: '  if (false) {' }],
  },
  {
    name: 'window_test_dropped',
    why: 'a later set in force is consumed when the count premise has broken',
    edits: [{ file: 'src/app.js', from: '  if (taxFacts.in_window > 0) {', to: '  if (false) {' }],
  },
  {
    name: 'instant_is_now',
    why: 'the tax set is chosen by now, not by the exit',
    edits: [{
      file: 'src/app.js',
      from: "        const taxAt = consumable.consume && localDecision.status === 'priced' ? new Date(localDecision.exit_at) : exitAt;",
      to: '        const taxAt = new Date();',
    }],
  },
  {
    name: 'platform_close_untaxed',
    why: 'a stay the platform prices itself is not taxed',
    edits: [{
      file: 'src/app.js',
      from: '    const { lines } = await taxes.taxOn(client, tenantId, garage, { subtotalMinor, currency, at });',
      to: '    const lines = [];',
    }],
  },
  {
    name: 'reconciler_counts_tax',
    why: 'the reconciler compares the quote with the fee including its tax',
    edits: [{
      file: 'src/reconcile.js',
      from: '  return Number(row.fee_minor) - validationDelta(row.breakdown) - taxDelta(row.breakdown);',
      to: '  return Number(row.fee_minor) - validationDelta(row.breakdown);',
    }],
  },
  {
    name: 'old_lane_consumed',
    why: 'a decision with no pre-tax subtotal is consumed',
    edits: [{
      file: 'src/app.js',
      from: '  if (decision.subtotal_minor === undefined || decision.tax_sets_held === undefined) {',
      to: '  if (false) {',
    }],
  },
  {
    name: 'subtotal_not_written',
    why: 'the close writes no subtotal',
    edits: [{
      file: 'src/repository.js',
      from: '  const subtotal = priced && pricing.subtotalMinor !== undefined ? pricing.subtotalMinor : null;',
      to: '  const subtotal = null;',
    }],
  },
  {
    name: 'rules_serve_no_sets',
    why: '/lane/rules serves no tax sets',
    edits: [{ file: 'src/app.js', from: '        tax_sets: payload.taxSets,', to: '        tax_sets: [],' }],
  },
  {
    name: 'rules_serve_store_fields',
    why: "/lane/rules serves the store's rows, not what a load takes",
    edits: [{
      file: 'src/app.js',
      from: '        const taxSets = taxes.loadable(await taxes.taxSetsForGarage(client, tenantId, garageId));',
      to: '        const taxSets = await taxes.taxSetsForGarage(client, tenantId, garageId);',
    }],
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'no_sum_check',
    why: 'the table accepts a subtotal and tax lines that do not make the fee',
    edits: [{
      file: '0023_stay_subtotal.sql',
      from: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_subtotal_plus_tax_is_the_fee CHECK (
    subtotal_minor IS NULL
    OR (fee_minor IS NOT NULL
        AND breakdown IS NOT NULL
        AND subtotal_minor + ledger_tax_minor(breakdown) = fee_minor)
  );`,
      to: '',
    }],
  },
];

const SUITE = ['--test', 'test/tax-on-paid.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-tax-on-paid-control-'));
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

/** Exactly once: an anchor that matches twice would plant the first and leave the other standing. */
const once = (text, from) => text.split(from).length === 2;

/** Every edit of a break, or none: a break half-applied measures something else. */
function plant(dir, brk) {
  const planned = [];
  for (const edit of brk.edits) {
    const path = join(dir, edit.file);
    const source = planned.find((p) => p.path === path)?.text ?? readFileSync(path, 'utf8');
    if (!once(source, edit.from)) return { ok: false, where: edit.file };
    planned.push({ path, text: source.replace(edit.from, edit.to) });
  }
  for (const p of planned) writeFileSync(p.path, p.text);
  return { ok: true };
}

/** A scratch database built from `migrations/` with one statement edited out. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
    await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
  });
  const partial = mkdtempSync(join(tmpdir(), 'openparking-tax-on-paid-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  const planted = plant(partial, brk);
  if (!planted.ok) {
    rmSync(partial, { recursive: true, force: true });
    return planted;
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
    const planted = plant(dir, brk);
    if (!planted.ok) {
      // A break whose anchor has moved applies nothing, and the run then
      // reports a passing suite as a failed control for the wrong reason.
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${planted.where} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(`  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
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
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${built.where} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir, scratchEnv);
    if (broken.status === 0) {
      console.error(`  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
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
await withAdmin(maintenance.toString(), (c) => c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`));

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust the tax-on-the-stay tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property tax on what the driver pays rests on.');
