#!/usr/bin/env node
/**
 * The control for a validation at the exit (migration 0019).
 *
 * The claim is made at the reader, on the fee the close will write, and held
 * on the open stay; the close records it as one line on the ledger, the fee
 * its running total; a hold no close takes is given back, by the close or by
 * the sweep; the phone reaches the door on stdin and is kept nowhere; the
 * reconciler compares the engine's number with the fee without the line.
 * Every property is broken below, one at a time, and `test/validations.test.js`
 * is REQUIRED to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported
 * as not planted rather than run:
 *   phone_kept_on_record       the phone is written into the hold.
 *   last4_kept                 the door's last four digits are kept.
 *   phone_echoed_on_400        a refused phone echoes its value.
 *   close_ignores_hold         the close does not read the hold.
 *   line_not_on_ledger         the fee is discounted with no line.
 *   fee_not_discounted         the line is written and the fee left as priced.
 *   hold_taken_at_another_fee  a hold is recorded on a fee it was not claimed on.
 *   close_strands_hold         a hold the close cannot take is not given back.
 *   sweep_never_runs           the sweep finds nothing to give back.
 *   sweep_ignores_window       the sweep gives back holds inside the window.
 *   sweep_keeps_record_held    the sweep releases and the stay still says held.
 *   outage_is_no_validation    a door that exits 2 is read as not validated.
 *   already_claimed_final      an already-claimed read is final.
 *   discount_over_fee_held     a discount larger than the fee is held.
 *   base_echo_unchecked        a claim answered for another fee is held.
 *   replay_asks_door           a held claim asked again goes to the door.
 *   claim_after_close          a closed stay can be claimed for.
 *   unconsumable_claimed       a decision the close would not write is claimed on.
 *   unpriced_is_claimed        a covered or zero decision is claimed on.
 *   reconciler_sees_line       the reconciler compares with the fee including the line.
 *   shown_not_checked          a hold is recorded whatever the reader showed (A2.2).
 *   claiming_left_by_close     the close takes no notice of a claim never held (A2.3).
 *   claiming_left_by_sweep     the sweep never gives back a claim never held (A2.3).
 *   releasing_recorded         a stay whose release began records the discount (A2.3).
 *   release_never_finished     the close never asks the door after it commits (A2.3).
 *   unfinished_left            the sweep never finishes a release begun (A2.3).
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0019, so the property genuinely never existed:
 *   hold_on_closed_stay        a closed stay may still hold or claim.
 *   record_shape_unchecked     a record with no state is accepted.
 *   link_shape_unchecked       the link CHECK never created.
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
    why: 'the phone is written into the hold',
    file: 'src/validations.js',
    from: "      consulted: true,\n      state: 'held',",
    to: "      consulted: true,\n      phone,\n      state: 'held',",
  },
  {
    name: 'last4_kept',
    why: "the door's last four digits are kept",
    file: 'src/validations.js',
    from: "  delete rest.phone_last4;\n",
    to: "",
  },
  {
    name: 'phone_echoed_on_400',
    why: 'a refused phone echoes its value',
    file: 'src/app.js',
    from: "    throw bad(`phone must be a string of at most ${PHONE_MAX} characters of digits, spaces and + ( ) . -`);",
    to: "    throw bad(`phone must be a string of at most ${PHONE_MAX} characters of digits, spaces and + ( ) . -, not ${JSON.stringify(value)}`);",
  },
  {
    name: 'close_ignores_hold',
    why: 'the close does not read the hold',
    file: 'src/app.js',
    from: "        const heldAtClose = await repo.lockValidation(client, tenantId, open.id);",
    to: "        const heldAtClose = null;",
  },
  {
    name: 'line_not_on_ledger',
    why: 'the fee is discounted with no line',
    file: 'src/validations.js',
    from: "      pricing: { ...pricing, feeMinor, breakdown: [...pricing.breakdown, held.line] },",
    to: "      pricing: { ...pricing, feeMinor, breakdown: pricing.breakdown },",
  },
  {
    name: 'fee_not_discounted',
    why: 'the line is written and the fee left as priced',
    file: 'src/validations.js',
    from: "      pricing: { ...pricing, feeMinor, breakdown: [...pricing.breakdown, held.line] },",
    to: "      pricing: { ...pricing, breakdown: [...pricing.breakdown, held.line] },",
  },
  {
    name: 'hold_taken_at_another_fee',
    why: 'a hold is recorded on a fee it was not claimed on',
    file: 'src/validations.js',
    from: "  if (held.state === 'held' && priced && pricing.feeMinor === held.base_minor && pricing.feeMinor > 0 && shownDiscounted) {",
    to: "  if (held.state === 'held' && priced && pricing.feeMinor > 0 && shownDiscounted) {",
  },
  {
    name: 'close_strands_hold',
    why: 'a hold the close cannot take is not given back',
    file: 'src/validations.js',
    from: "  return {\n    pricing,\n    record: {\n      ...held, state: 'releasing',",
    to: "  return {\n    pricing,\n    record: {\n      ...held, state: held.state === 'claiming' ? 'released' : 'recorded',",
  },
  {
    name: 'sweep_never_runs',
    why: 'the sweep finds nothing to give back',
    file: 'src/validations.js',
    from: "    stale: await repo.staleValidationHolds(c, tenantId, cutoff),",
    to: "    stale: [],",
  },
  {
    name: 'sweep_ignores_window',
    why: 'the sweep gives back holds inside the window',
    file: 'src/validations.js',
    from: "  const cutoff = new Date(now.getTime() - holdMinutes * 60_000);",
    to: "  const cutoff = new Date(now.getTime() + 60_000);",
  },
  {
    name: 'sweep_keeps_record_held',
    why: 'the sweep releases and the stay still says held',
    file: 'src/validations.js',
    from: "      ...row.validation, state: 'released', released_at: now.toISOString(), release: released,",
    to: "      ...row.validation, state: row.exit_at === null ? 'held' : 'released', released_at: now.toISOString(), release: released,",
  },
  {
    name: 'outage_is_no_validation',
    why: 'a door that exits 2 is read as not validated',
    file: 'src/validations.js',
    from: "  if (read.exit_code !== 0 && read.exit_code !== 1) throw unavailable('validation-in-store', read);",
    to: "  if (read.exit_code !== 0 && read.exit_code !== 1) return { outcome: 'not_validated', record: null, refusal: null, asked };",
  },
  {
    name: 'already_claimed_final',
    why: 'an already-claimed read is final',
    file: 'src/validations.js',
    from: "  if (read.exit_code === 1 && readAnswer.reason !== 'already_claimed') {",
    to: "  if (read.exit_code === 1) {",
  },
  {
    name: 'discount_over_fee_held',
    why: 'a discount larger than the fee is held',
    file: 'src/validations.js',
    from: "  if (claim.discount_minor < 0 || claim.discount_minor > feeMinor) {",
    to: "  if (claim.discount_minor < 0) {",
  },
  {
    name: 'base_echo_unchecked',
    why: 'a claim answered for another fee is held',
    file: 'src/validations.js',
    from: "  if (claim.base_minor !== feeMinor || claim.currency !== currency) {",
    to: "  if (false) {",
  },
  {
    name: 'replay_asks_door',
    why: 'a held claim asked again goes to the door',
    file: 'src/app.js',
    from: "        if (current?.state === 'held' && current.base_minor === decision.fee_minor) {",
    to: "        if (false) {",
  },
  {
    name: 'claim_after_close',
    why: 'a closed stay can be claimed for',
    file: 'src/repository.js',
    from: "      WHERE tenant_id = $1 AND garage_id = $2 AND id = $3 AND exit_at IS NULL\n      FOR UPDATE",
    to: "      WHERE tenant_id = $1 AND garage_id = $2 AND id = $3\n      FOR UPDATE",
  },
  {
    name: 'unconsumable_claimed',
    why: 'a decision the close would not write is claimed on',
    file: 'src/app.js',
    from: "        if (!consumable.consume) throw conflict('decision_not_consumable', consumable.reason);",
    to: "        if (false) throw conflict('decision_not_consumable', consumable.reason);",
  },
  {
    name: 'unpriced_is_claimed',
    why: 'a covered or zero decision is claimed on',
    file: 'src/app.js',
    from: "      if (decision === null || decision.status !== 'priced' || decision.fee_minor === 0) {",
    to: "      if (decision === null) {",
  },
  {
    name: 'reconciler_sees_line',
    why: 'the reconciler compares with the fee including the line',
    file: 'src/reconcile.js',
    from: "  return Number(row.fee_minor) - validationDelta(row.breakdown);",
    to: "  return Number(row.fee_minor) - 0 * validationDelta(row.breakdown);",
  },
  {
    name: 'shown_not_checked',
    why: 'a hold is recorded whatever the reader showed',
    file: 'src/validations.js',
    from: "  const shownDiscounted = readerShown !== null && readerShown !== undefined",
    to: "  const shownDiscounted = true || readerShown !== null && readerShown !== undefined",
  },
  {
    name: 'claiming_left_by_close',
    why: 'the close takes no notice of a claim never held',
    file: 'src/validations.js',
    from: "  if (!held || !UNRESOLVED.has(held.state)) return { pricing, record: held ?? null, releaseAfter: false };",
    to: "  if (!held || !UNRESOLVED.has(held.state) || held.state === 'claiming') return { pricing, record: held ?? null, releaseAfter: false };",
  },
  {
    name: 'claiming_left_by_sweep',
    why: 'the sweep never gives back a claim never held',
    file: 'src/validations.js',
    from: "    claiming: await repo.staleClaimingRecords(c, tenantId, claimingCutoff),",
    to: "    claiming: [],",
  },
  {
    name: 'releasing_recorded',
    why: 'a stay whose release began records the discount',
    file: 'src/validations.js',
    from: "  if (held.state === 'held' && priced && pricing.feeMinor === held.base_minor",
    to: "  if ((held.state === 'held' || held.state === 'releasing') && priced && pricing.feeMinor === held.base_minor",
  },
  {
    name: 'release_never_finished',
    why: 'the close never asks the door after it commits',
    file: 'src/app.js',
    from: "      if (out.releaseAfter) {",
    to: "      if (false) {",
  },
  {
    name: 'unfinished_left',
    why: 'the sweep never finishes a release begun',
    file: 'src/validations.js',
    from: "    unfinished: await repo.releasingRecords(c, tenantId),",
    to: "    unfinished: [],",
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'hold_on_closed_stay',
    why: 'a closed stay may still hold or claim',
    edits: [{ file: '0019_validations.sql', from: "    OR (validation->>'state' IN ('claiming', 'held') AND exit_at IS NULL)", to: "    OR (validation->>'state' IN ('claiming', 'held'))" }],
  },
  {
    name: 'record_shape_unchecked',
    why: 'a record with no state is accepted',
    edits: [{ file: '0019_validations.sql', from: "        AND coalesce(validation->>'state', '') IN ('claiming', 'held', 'recorded', 'releasing', 'released')", to: "        AND true" }],
  },
  {
    name: 'link_shape_unchecked',
    why: 'the link CHECK never created',
    edits: [{ file: '0019_validations.sql', from: "    validations_link IS NULL OR (", to: "    true OR validations_link IS NULL OR (" }],
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
