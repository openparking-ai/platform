#!/usr/bin/env node
/**
 * The control for paying at the exit (0038).
 *
 * Every property the payment's safety rests on is broken below, one at a
 * time, and `test/exit-payments.test.js` or `test/exit-payment-sweep.test.js`
 * is REQUIRED to go red -- with at least one test still green, so a break that stops the file running is not
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
 *   sweep_reads_nothing         a payment no lane finished is never asked about
 *   sweep_young_rows            the sweep reads a payment a lane is still at
 *   sweep_writes_stripe         the sweep cancels an intent at Stripe
 *   sweep_no_lock               two sweeps at once both record a payment
 *   sweep_and_lane_twice        a sweep and a lane at once tell it twice
 *   sweep_closes_the_case       the sweep closes what it found paid
 *   closed_not_written_down     a charge on a closed case is written nowhere
 *   found_not_on_exception      a charge found after a let-out is not on its exception
 *   written_down_twice          a charge is written down at every read
 *   refund_taken_as_paid        a charge refunded first is taken as paid
 *   refund_forgotten            the next read marks a refunded charge paid
 *   mismatch_not_written_down   another amount is written nowhere
 *   let_out_before_read         a car that paid is written as let out unpaid
 *   let_out_held_by_stripe      a silent Stripe holds a let-out up
 *   paid_date_is_read_time      the paid date is when it was read
 *   event_date_is_read_time     the event's date is when it was read
 *   found_date_is_read_time     a payment found at a later case keeps the read time
 *   failed_read_keeps_its_place a read that failed spends the run's places again
 *   error_stops_the_run         one read refused ends the run
 *   old_rows_forgotten          an old open payment is not asked about again
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

const SWEEP = 'src/exitPaymentSweep.js';
const CASE_LOCK = {
  from: 'const row = await exits.caseById(client, tenantId, garageId, exitId, { lock: true });',
  to: 'const row = await exits.caseById(client, tenantId, garageId, exitId);',
};

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
    from: '      const settled = await cancelForPerson(req.tenantId, row.garage_id, row);',
    to: '      const settled = row;',
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
    file: 'src/exitPaymentSweep.js',
    from: '  if (written.paidNow) await paidEvent(client, tenantId, row, written.row);',
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
  {
    name: 'sweep_reads_nothing',
    why: 'a payment no lane finished is never asked about',
    file: SWEEP,
    from: '  const due = await withTenant(tenantId, (client) => duePayments(client, tenantId, now, limit));',
    to: '  const due = [];',
  },
  {
    name: 'sweep_young_rows',
    why: 'the sweep reads a payment a lane is still at',
    file: SWEEP,
    from: 'export const MIN_AGE_MS = 2 * 60_000;',
    to: 'export const MIN_AGE_MS = 0;',
  },
  {
    name: 'sweep_writes_stripe',
    why: 'the sweep cancels an intent at Stripe',
    file: SWEEP,
    from: '      let found = null;',
    to: '      await exitPayments.cancelIntent(config, p.account_id, p.payment_intent_id).catch(() => {});\n      let found = null;',
  },
  {
    name: 'sweep_no_lock',
    why: 'two sweeps at once both record a payment',
    file: SWEEP,
    from: CASE_LOCK.from,
    to: CASE_LOCK.to,
  },
  {
    name: 'sweep_and_lane_twice',
    why: 'a sweep and a lane at once tell it twice',
    edits: [
      { file: SWEEP, ...CASE_LOCK },
      { file: SWEEP, from: 'eventId: `${exitPayments.PAID_EVENT_KIND}:${payment.id}`,', to: 'eventId: `${exitPayments.PAID_EVENT_KIND}:${payment.id}:${Math.random()}`,' },
    ],
  },
  {
    name: 'sweep_closes_the_case',
    why: 'the sweep closes what it found paid',
    file: SWEEP,
    from: '  if (!written.paidNow) return { paid: false, unplaced: false };\n',
    to: "  if (!written.paidNow) return { paid: false, unplaced: false };\n  await exits.endCase(client, tenantId, row.id, { why: 'stay_ended', by: 'sweep' });\n",
  },
  {
    name: 'closed_not_written_down',
    why: 'a charge on a closed case is written nowhere',
    file: SWEEP,
    from: "  const why = row.closed_at ? 'case_closed' : (await stayIsOver(client, tenantId, row.session_id)) ? 'stay_ended' : null;",
    to: '  const why = null;',
  },
  {
    name: 'found_not_on_exception',
    why: 'a charge found after a let-out is not on its exception',
    file: SWEEP,
    from: '  if (exception) await exceptions.recordPaymentAfter(client, tenantId, exception, payment);\n',
    to: '',
  },
  {
    name: 'written_down_twice',
    why: 'a charge is written down at every read',
    file: SWEEP,
    from: 'eventId: `${exitPayments.UNPLACED_EVENT_KIND}:${payment.id}`,',
    to: 'eventId: `${exitPayments.UNPLACED_EVENT_KIND}:${payment.id}:${Math.random()}`,',
  },
  {
    name: 'refund_taken_as_paid',
    why: 'a charge refunded first is taken as paid',
    file: 'src/exitPayments.js',
    from: '((intent.latest_charge?.amount_refunded ?? 0) !== 0 || row.last_failure === REFUNDED_FIRST)',
    to: 'row.last_failure === REFUNDED_FIRST',
  },
  {
    name: 'refund_forgotten',
    why: 'the next read marks a refunded charge paid',
    file: 'src/exitPayments.js',
    from: '((intent.latest_charge?.amount_refunded ?? 0) !== 0 || row.last_failure === REFUNDED_FIRST)',
    to: '(intent.latest_charge?.amount_refunded ?? 0) !== 0',
  },
  {
    name: 'mismatch_not_written_down',
    why: 'another amount is written nowhere',
    file: SWEEP,
    from: "    const unplaced = intent.status === 'succeeded' && await writeDown(client, tenantId, row, payment, payment.last_failure);",
    to: '    const unplaced = false;',
  },
  {
    name: 'let_out_before_read',
    why: 'a car that paid is written as let out unpaid',
    file: 'src/app.js',
    from: '      await readBeforeLetOut(req.tenantId, req.params.garageId, req.params.exitId);\n',
    to: '',
  },
  {
    name: 'let_out_held_by_stripe',
    why: 'a silent Stripe holds a let-out up',
    file: 'src/app.js',
    from: '      await recordIntent(tenantId, garageId, exitId, intent);\n    } catch (err) {\n      if (!(err instanceof StripeUnreachable || err instanceof StripeError)) throw err;',
    to: '      await recordIntent(tenantId, garageId, exitId, intent);\n    } catch (err) {\n      throw err;',
  },
  {
    name: 'paid_date_is_read_time',
    why: 'the paid date is when it was read',
    file: 'src/exitPayments.js',
    from: 'COALESCE(succeeded_at, $6::timestamptz, now())',
    to: 'COALESCE(succeeded_at, now(), $6::timestamptz)',
  },
  {
    name: 'event_date_is_read_time',
    why: "the event's date is when it was read",
    file: SWEEP,
    from: '  occurredAt: new Date(payment.succeeded_at),',
    to: '  occurredAt: new Date(),',
  },
  {
    name: 'found_date_is_read_time',
    why: 'a payment found at a later case keeps the read time',
    file: 'src/app.js',
    from: "    if (intent.status === 'succeeded') {\n      intent = await exitPayments.readIntentWithCharge(",
    to: '    if (false) {\n      intent = await exitPayments.readIntentWithCharge(',
  },
  {
    name: 'failed_read_keeps_its_place',
    why: "a read that failed spends the run's places again",
    file: SWEEP,
    from: '      await backOfTheLine(tenantId, p.id).catch(() => {});\n',
    to: '',
  },
  {
    name: 'error_stops_the_run',
    why: 'one read refused ends the run',
    file: SWEEP,
    from: '      summary.failed += 1;\n',
    to: '      throw err;\n',
  },
  {
    name: 'old_rows_forgotten',
    why: 'an old open payment is not asked about again',
    file: SWEEP,
    from: 'export const OLD_EVERY_MS = 15 * 60_000;',
    to: 'export const OLD_EVERY_MS = 1000 * 86_400_000;',
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

const SUITE = ['--test', 'test/exit-payments.test.js', 'test/exit-payment-sweep.test.js'];

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
    let anchored = true;
    for (const edit of brk.edits ?? [brk]) {
      const path = join(dir, edit.file);
      const source = readFileSync(path, 'utf8');
      if (!source.includes(edit.from)) {
        console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND in ${edit.file} ***`);
        failures += 1;
        anchored = false;
        break;
      }
      writeFileSync(path, source.replace(edit.from, edit.to));
    }
    if (anchored && !judge(brk.name, brk.why, run(dir))) failures += 1;
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
