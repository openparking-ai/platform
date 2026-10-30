#!/usr/bin/env node
/**
 * The control for paying at the exit (0038).
 *
 * Every property the payment's safety rests on is broken below, one at a
 * time, and `test/exit-payments.test.js` is REQUIRED to go red -- with at
 * least one test still green, so a break that stops the file running is not
 * mistaken for one the tests caught. A pass is the failure.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 *
 *   intent_amount_not_fee       the intent's amount is not the case's fee
 *   not_in_person               the intent is not for a card presented in person
 *   capture_later               the intent waits to be captured
 *   no_idempotency_key          the intent is created with no idempotency key
 *   on_platform_account         the intent is created on the platform, not the garage's account
 *   intent_key_varies           the idempotency key is not one per case
 *   amount_unchecked            Stripe's success is taken whatever its amount
 *   decline_reason_dropped      a decline does not say why
 *   timeout_is_failure          a reader that did not acknowledge in time is a failure
 *   offline_unnamed             a reader offline is not named to the lane
 *   open_payment_settles        a payment started, not paid, opens the gate
 *   other_lane_pays             a case is sent to another lane's reader
 *   reader_never_sent           the intent is never handed to the reader
 *   person_leaves_intent_open   a person's letting out leaves the intent open
 *   poll_never_reads            the lane's poll never asks Stripe
 *   paid_untold                 a payment found paid leaves no event
 *   receipt_twice               a receipt is sent twice
 *   receipt_unpaid              a receipt is sent for an exit not paid
 *   number_kept                 the receipt's number is kept whole
 *   caribbean_texted            a number of another plan member is texted
 *   toll_free_texted            a toll-free number is texted
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * statement of 0038 edited, so the property genuinely never existed there.
 *
 *   amount_changeable           a payment's amount may change after it is written
 *   final_not_final             a payment that succeeded may go back to open
 *   payment_deletable           the application may delete a payment
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.EXIT_PAYMENTS_SCRATCH_DB || 'openparking_exit_payments_control';

const SOURCE_BREAKS = [
  {
    name: 'intent_amount_not_fee',
    why: "the intent's amount is not the case's fee",
    file: 'src/exitPayments.js',
    from: '    amount: amountMinor,',
    to: '    amount: amountMinor + 1,',
  },
  {
    name: 'not_in_person',
    why: 'the intent is not for a card presented in person',
    file: 'src/exitPayments.js',
    from: "    payment_method_types: cur === 'cad' ? ['card_present', 'interac_present'] : ['card_present'],",
    to: "    payment_method_types: ['card'],",
  },
  {
    name: 'capture_later',
    why: 'the intent waits to be captured',
    file: 'src/exitPayments.js',
    from: "    capture_method: 'automatic',",
    to: "    capture_method: 'manual',",
  },
  {
    name: 'no_idempotency_key',
    why: 'the intent is created with no idempotency key',
    file: 'src/exitPayments.js',
    from: 'account: accountId, form: body, idempotencyKey: intentKey(exitId) }',
    to: 'account: accountId, form: body }',
  },
  {
    name: 'on_platform_account',
    why: "the intent is created on the platform, not the garage's account",
    file: 'src/exitPayments.js',
    from: "path: '/v1/payment_intents', account: accountId,",
    to: "path: '/v1/payment_intents',",
  },
  {
    name: 'intent_key_varies',
    why: 'the idempotency key is not one per case',
    file: 'src/exitPayments.js',
    from: ".update(String(exitId)).digest('hex')",
    to: ".update(String(exitId) + Math.random()).digest('hex')",
  },
  {
    name: 'amount_unchecked',
    why: "Stripe's success is taken whatever its amount",
    file: 'src/exitPayments.js',
    from: "  if (state === 'succeeded' && (intent.amount !== row.amount_minor",
    to: '  if (false && (intent.amount !== row.amount_minor',
  },
  {
    name: 'decline_reason_dropped',
    why: 'a decline does not say why',
    file: 'src/exitPayments.js',
    from: '  return [e.code, e.decline_code].filter(Boolean)',
    to: '  return [e.code].filter(Boolean)',
  },
  {
    name: 'timeout_is_failure',
    why: 'a reader that did not acknowledge in time is a failure',
    file: 'src/exitPayments.js',
    from: "      if (err.code === 'terminal_reader_timeout') return { sent: 'unknown' };",
    to: '',
  },
  {
    name: 'offline_unnamed',
    why: 'a reader offline is not named to the lane',
    file: 'src/exitPayments.js',
    from: "      if (err.code === 'terminal_reader_offline') {\n        throw new ConnectRefusal(503, 'reader_offline'",
    to: "      if (false) {\n        throw new ConnectRefusal(503, 'reader_offline'",
  },
  {
    name: 'open_payment_settles',
    why: 'a payment started, not paid, opens the gate',
    file: 'src/exits.js',
    from: "  if (row.payment?.status === 'succeeded') return row.payment;",
    to: '  if (row.payment) return row.payment;',
  },
  {
    name: 'other_lane_pays',
    why: "a case is sent to another lane's reader",
    file: 'src/app.js',
    from: "        if (row.lane_id !== laneId) throw conflict('exit_on_another_lane', 'this exit case is at another lane');\n        reader = ",
    to: '        reader = ',
  },
  {
    name: 'reader_never_sent',
    why: 'the intent is never handed to the reader',
    file: 'src/app.js',
    from: "    if (channel === 'lane_reader' && intent.status === 'requires_payment_method') {",
    to: '    if (false) {',
  },
  {
    name: 'person_leaves_intent_open',
    why: "a person's letting out leaves the intent open",
    file: 'src/app.js',
    from: '      res.json({ exit: exits.presentForPerson(await cancelForPerson(req.tenantId, row.garage_id, row)) });',
    to: '      res.json({ exit: exits.presentForPerson(row) });',
  },
  {
    name: 'poll_never_reads',
    why: "the lane's poll never asks Stripe",
    file: 'src/app.js',
    from: "    if (!p || p.status !== 'open') return row;\n    if (p.read_at",
    to: '    return row;\n    if (p.read_at',
  },
  {
    name: 'paid_untold',
    why: 'a payment found paid leaves no event',
    file: 'src/app.js',
    from: '    if (written.paidNow) await paidEvent(client, tenantId, row, written.row);',
    to: '',
  },
  {
    name: 'receipt_twice',
    why: 'a receipt is sent twice',
    file: 'src/app.js',
    from: "        if (paid.receipt) throw conflict('receipt_sent', 'the receipt for this payment was already sent');",
    to: '',
  },
  {
    name: 'receipt_unpaid',
    why: 'a receipt is sent for an exit not paid',
    file: 'src/app.js',
    from: "        if (!paid) throw conflict('not_paid', 'a receipt is sent for a paid exit');",
    to: '',
  },
  {
    name: 'number_kept',
    why: "the receipt's number is kept whole",
    file: 'src/app.js',
    from: 'to_last2: to.slice(-2)',
    to: 'to_last2: to',
  },
  {
    name: 'caribbean_texted',
    why: 'a number of another plan member is texted',
    file: 'src/textReceipt.js',
    from: '  if (NOT_US_OR_CANADA.has(npa)) return null;',
    to: '',
  },
  {
    name: 'toll_free_texted',
    why: 'a toll-free number is texted',
    file: 'src/textReceipt.js',
    from: " || npa[1] === npa[2]) return null;",
    to: ') return null;',
  },
];

const ADDED_0038 = '0038_exit_payments.sql';

const SCHEMA_BREAKS = [
  {
    name: 'amount_changeable',
    why: "a payment's amount may change after it is written",
    edits: [
      { file: ADDED_0038, from: 'NEW.payment_intent_id, NEW.amount_minor, NEW.currency,', to: 'NEW.payment_intent_id, NEW.currency,' },
      { file: ADDED_0038, from: 'OLD.payment_intent_id, OLD.amount_minor, OLD.currency,', to: 'OLD.payment_intent_id, OLD.currency,' },
    ],
  },
  {
    name: 'final_not_final',
    why: 'a payment that succeeded may go back to open',
    edits: [{ file: ADDED_0038, from: "    IF OLD.status <> 'open' AND NEW.status IS DISTINCT FROM OLD.status THEN", to: '    IF false THEN' }],
  },
  {
    name: 'payment_deletable',
    why: 'the application may delete a payment',
    edits: [{
      file: ADDED_0038,
      from: 'GRANT SELECT, INSERT, UPDATE ON exit_payments TO openparking_app;',
      to: 'GRANT SELECT, INSERT, UPDATE, DELETE ON exit_payments TO openparking_app;',
    }],
  },
];

const SUITE = ['--test', 'test/exit-payments.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-exit-payments-control-'));
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

function counts(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return { pass: line('pass'), fail: line('fail') };
}

/**
 * A break is a control only when the suite RAN and went red: at least one test
 * failed AND at least one passed. All failed is a file that could not run --
 * an anchor that moved, a scratch database that did not build -- and it is
 * reported as not a control, never as "fails as required".
 */
function judge(name, why, result) {
  const { pass, fail } = counts(result);
  const label = name.padEnd(36);
  if (result.status === 0 || !fail) {
    console.error(`  ${label} *** PASSED WHEN ${why.toUpperCase()} — the suite is not measuring this ***`);
    return false;
  }
  if (!pass) {
    console.error(`  ${label} *** NOT A CONTROL — ${pass} passed, ${fail} failed: the break fails everything ***`);
    return false;
  }
  console.log(`  ${label} fails as required when ${why} — ${pass} passed, ${fail} failed`);
  return true;
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

/** A scratch database built from `migrations/` with one statement of 0038 edited. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-exit-payments-migrations-'));
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

  for (const script of ['scripts/prepare-database.js', 'scripts/migrate.js']) {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, ...scratchEnv, MIGRATIONS_DIR: partial },
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
  const { pass, fail } = counts(intact);
  if (intact.status === 0 && pass > 0 && fail === 0) {
    console.log(`  control A OK — ${pass} passed`);
  } else {
    console.error(`  CONTROL A FAILED — the suite does not pass even intact: ${pass} passed, ${fail} failed`);
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
    const path = join(dir, brk.file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(brk.from)) {
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    writeFileSync(path, source.replace(brk.from, brk.to));
    if (!judge(brk.name, brk.why, run(dir))) failures += 1;
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
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND in ${built.where} ***`);
      failures += 1;
      continue;
    }
    if (!judge(brk.name, brk.why, run(dir, scratchEnv))) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The scratch database is a database with a property removed: dropped, so
// nothing is later run against it by accident.
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust the exit payment tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property paying at the exit rests on.');
