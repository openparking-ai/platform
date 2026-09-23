#!/usr/bin/env node
/**
 * The control for a validation at the exit (migration 0019).
 *
 * The phone reaches the door on stdin and is kept nowhere; a claimed discount
 * is one line on the ledger and the fee is its running total; a module that
 * could not decide is not no-validation; a refusal does not refuse the close;
 * the reconciler compares the engine's number with the fee without the line.
 * Every property is broken below, one at a time, and `test/validations.test.js`
 * is REQUIRED to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported
 * as not planted rather than run.
 *
 *   phone_kept_on_record     the phone is written into the validation record.
 *   last4_kept               the door's phone_last4 is kept with its answer.
 *   phone_echoed_on_400      a refused phone field echoes the value.
 *   line_not_on_ledger       the fee is discounted and no line says so: the
 *                            fee stops being the running total of its ledger.
 *   fee_not_discounted       the line is written and the fee left as priced.
 *   outage_is_no_validation  a door that exits 2 is read as "not validated"
 *                            and the stay closes at full price.
 *   refusal_refuses_close    a door that refused the request fails the close.
 *   already_claimed_final    an already-claimed read is taken as final, so a
 *                            retried close never gets its own claim back.
 *   base_echo_unchecked      a claim the module answered for a different fee
 *                            than it was asked about is applied.
 *   covered_is_asked         a covered stay asks the door and spends the
 *                            driver's validation for nothing.
 *   zero_fee_is_asked        a zero fee asks the door, the same.
 *   reconciler_sees_line     the reconciler compares the engine's number with
 *                            the fee INCLUDING the validation line, and every
 *                            validated lane close reads as diverged.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0019, so the property genuinely never existed.
 *
 *   discount_over_fee_taken  a discount larger than the fee is applied, with
 *                            0002's fee_minor >= 0 CHECK also never created.
 *   record_on_open_stay      sessions_validation_only_when_closed never created.
 *   link_shape_unchecked     the validations link CHECK never created.
 *
 * Needs the same environment as the suite: the engine.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.VALIDATIONS_SCRATCH_DB || 'openparking_validations_control';

const SOURCE_BREAKS = [
  {
    name: 'phone_kept_on_record',
    why: 'the phone is written into the record',
    file: 'src/validations.js',
    from: "  const record = { consulted: true, module: 'validations', link, asked };",
    to: "  const record = { consulted: true, module: 'validations', link, asked, phone };",
  },
  {
    name: 'last4_kept',
    why: "the door's last four digits are kept",
    file: 'src/validations.js',
    from: '  delete rest.phone_last4;\n',
    to: '',
  },
  {
    name: 'phone_echoed_on_400',
    why: 'a refused phone echoes its value',
    file: 'src/app.js',
    from: "    throw bad(`phone must be a string of at most ${PHONE_MAX} characters of digits, spaces and + ( ) . -`);",
    to: "    throw bad(`phone must be a string of at most ${PHONE_MAX} characters of digits, spaces and + ( ) . -, not ${JSON.stringify(value)}`);",
  },
  {
    name: 'line_not_on_ledger',
    why: 'the fee is discounted with no line',
    file: 'src/validations.js',
    from: '    pricing: { ...pricing, feeMinor, breakdown: [...pricing.breakdown, line] },',
    to: '    pricing: { ...pricing, feeMinor, breakdown: pricing.breakdown },',
  },
  {
    name: 'fee_not_discounted',
    why: 'the line is written and the fee left as priced',
    file: 'src/validations.js',
    from: '    pricing: { ...pricing, feeMinor, breakdown: [...pricing.breakdown, line] },',
    to: '    pricing: { ...pricing, breakdown: [...pricing.breakdown, line] },',
  },
  {
    name: 'outage_is_no_validation',
    why: 'a door that exits 2 is read as not validated',
    file: 'src/validations.js',
    from: "  if (read.exit_code !== 0 && read.exit_code !== 1) throw unavailable('validation-in-store', read);",
    to: "  if (read.exit_code !== 0 && read.exit_code !== 1) return { pricing, record: { ...record, applied: false }, refusal: null };",
  },
  {
    name: 'refusal_refuses_close',
    why: 'a refused claim fails the close',
    file: 'src/validations.js',
    from: "  if (claimed.exit_code === 3) {\n",
    to: "  if (claimed.exit_code === 3) {\n    throw unavailable('claim-in-store', claimed);\n",
  },
  {
    name: 'already_claimed_final',
    why: 'an already-claimed read is final',
    file: 'src/validations.js',
    from: "  if (read.exit_code === 1 && readAnswer.reason !== 'already_claimed') {",
    to: '  if (read.exit_code === 1) {',
  },
  {
    name: 'base_echo_unchecked',
    why: 'a claim answered for another fee is applied',
    file: 'src/validations.js',
    from: '  if (claim.base_minor !== feeMinor || claim.currency !== currency) {',
    to: '  if (false) {',
  },
  {
    name: 'covered_is_asked',
    why: 'a covered stay asks the door',
    file: 'src/validations.js',
    from: "  if (pricing.outcome !== 'transient' || pricing.refusal !== undefined || !Number.isInteger(pricing.feeMinor)) {",
    to: "  if (pricing.outcome === 'transient' && (pricing.refusal !== undefined || !Number.isInteger(pricing.feeMinor))) {",
  },
  {
    name: 'zero_fee_is_asked',
    why: 'a zero fee asks the door',
    file: 'src/validations.js',
    from: '  if (pricing.feeMinor === 0) {',
    to: '  if (pricing.feeMinor === -1) {',
  },
  {
    name: 'reconciler_sees_line',
    why: 'the reconciler compares with the fee including the line',
    file: 'src/reconcile.js',
    from: '  return Number(row.fee_minor) - validationDelta(row.breakdown);',
    to: '  return Number(row.fee_minor) - 0 * validationDelta(row.breakdown);',
  },
];

const SCHEMA_BREAKS = [
  {
    // Two guards stand here -- this check, and 0002's CHECK (fee_minor >= 0),
    // which refuses the negative fee an over-large discount makes -- so both
    // are removed, or the break measures the one that is left.
    name: 'discount_over_fee_taken',
    why: 'a discount larger than the fee is applied',
    edits: [
      {
        file: '0002_core_schema.sql',
        from: '  fee_minor            bigint      CHECK (fee_minor >= 0),',
        to: '  fee_minor            bigint,',
      },
    ],
    source: {
      file: 'src/validations.js',
      from: '  if (claim.discount_minor < 0 || claim.discount_minor > feeMinor) {',
      to: '  if (claim.discount_minor < 0) {',
    },
  },
  {
    name: 'record_on_open_stay',
    why: 'the only-when-closed CHECK never created',
    edits: [
      {
        file: '0019_validations.sql',
        from: '  ADD CONSTRAINT sessions_validation_only_when_closed CHECK (\n    validation IS NULL OR exit_at IS NOT NULL',
        to: '  ADD CONSTRAINT sessions_validation_only_when_closed CHECK (\n    true OR validation IS NULL OR exit_at IS NOT NULL',
      },
    ],
  },
  {
    name: 'link_shape_unchecked',
    why: 'the link CHECK never created',
    edits: [
      {
        file: '0019_validations.sql',
        from: '    validations_link IS NULL OR (',
        to: '    true OR validations_link IS NULL OR (',
      },
    ],
  },
];

const SUITE = ['--test', 'test/validations.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-validations-control-'));
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

  const partial = mkdtempSync(join(tmpdir(), 'openparking-validations-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  for (const edit of brk.edits) {
    const path = join(partial, edit.file);
    const sql = readFileSync(path, 'utf8');
    if (sql.split(edit.from).length !== 2) {
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

/**
 * Plant one break. The anchor must occur EXACTLY ONCE: `replace` edits the
 * first occurrence, and a break whose anchor also matches a line elsewhere in
 * the file lands on that line and measures nothing.
 */
function plant(dir, edit) {
  const path = join(dir, edit.file);
  const source = readFileSync(path, 'utf8');
  if (source.split(edit.from).length !== 2) return false;
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
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${brk.file} ***`);
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
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${built.where} ***`);
      failures += 1;
      continue;
    }
    if (brk.source && !plant(dir, brk.source)) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${brk.source.file} ***`);
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
console.log('\nall controls OK — the suite fails on every property a validation at the exit rests on.');
