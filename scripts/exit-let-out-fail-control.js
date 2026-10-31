#!/usr/bin/env node
/**
 * The control for canceling an exit's payment and for a car a person let
 * out (0042).
 *
 * Every property below is broken, one at a time, and
 * `test/exit-let-out.test.js` with `test/stripe-test-mode-check.test.js` is
 * REQUIRED to go red -- with at least one test
 * still green, so a break that stops the file running is not mistaken for one
 * the tests caught. A pass is the failure.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 *
 *   cancel_leaves_intent_open    the lane's cancel leaves the intent open at Stripe
 *   cancel_without_key           the cancel is sent with no idempotency key
 *   cancel_without_status_check  a paid intent is asked to cancel too
 *   paid_cancel_not_told         a cancel that found the card paid answers canceled
 *   authorising_card_cut_off     a card being authorised is canceled under it
 *   reader_cleared_blind         the reader is cleared whatever intent it shows
 *   canceled_paid_again          a canceled payment is taken again
 *   close_cancels_nothing        a close writes the stay with its payment still open
 *   payment_on_closed_case       a payment started as the case closed is recorded and sent
 *   let_out_at_quoted_fee        a car let out unpaid is written at the fee it was quoted
 *   let_out_unlogged             a person's opening leaves no line in the change log
 *   let_out_by_unnamed           the stay does not name the lane computer that let it out
 *   flagged_opening_refused      a person's close that opened and flagged is refused
 *   flag_dropped_from_line       the change log does not say the opening was flagged
 *   attendant_line_doubled       an attendant's let-out gets a second line at the close
 *   past_stay_hides_let_out      the past stays do not say a stay was let out unpaid
 *   offset_less_time_taken       a driver's entry time without an offset is taken
 *   cancel_any_garage_or_lane    the cancel finds another garage's or lane's case
 *   word_any_garage              the driver's word lands on another garage's case
 *   close_any_garage             a close names another garage's case
 *   second_case_not_superseding  a second case for the same stay leaves the open one open
 *   superseded_payment_left_open a superseded case's open payment is not canceled at Stripe first
 *   stay_payment_not_counted     a payment the stay made at a superseded case does not settle the new one
 *   paid_fee_not_carried         a case superseding a paid one is priced afresh, not on the fee paid
 *   superseding_unlogged         a superseding leaves no line in the change log
 *   end_payment_left_open        a person's end leaves the stay's open payment uncanceled
 *   end_owed_ignores_paid        a stay that paid at an exit is answered owing the whole price
 *   end_owed_below_zero          a stay that paid more than it owes is answered owing a negative figure
 *   paid_currency_case           Stripe's small-letter currency keeps what was paid from being taken off
 *   end_line_owed_ignores_paid   the event and change-log line of such a stay say the whole price
 *   past_owed_ignores_paid       the past stays show such a stay owing the whole price
 *   other_car_intent_left        the reader holding another case's intent refuses this case's
 *   reader_frees_blind           another case's intent on the reader is canceled without reading Stripe
 *   own_intent_busy              this case's own intent waiting on the reader is a refusal
 *   stub_replaces_action         the stand-in replaces an action in progress (not what Stripe does)
 *   word_any_lane                the driver's word lands on another lane's case
 *   receipt_any_lane             a receipt goes for another lane's case
 *   poll_any_lane                the poll reads another lane's case
 *   live_key_taken               the test-mode check takes a live key
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * statement of 0042 edited, so the property genuinely never existed there.
 *
 *   let_out_with_fee             a let-out stay may carry a fee
 *   let_out_says_paid            a let-out record may say it was paid
 *   let_out_names_nobody         a let-out record may name nobody
 *   case_closed_unexplained      a case may be closed with no close event and no why (0045)
 *   ended_any_why                a case the platform closed may give any why (0045)
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
const SCRATCH = process.env.EXIT_LET_OUT_SCRATCH_DB || 'openparking_exit_let_out_control';

const OWN_GARAGE = "(await client.query('SELECT garage_id FROM exits WHERE id = $1', [req.params.exitId])).rows[0]?.garage_id ?? garageId";

const SOURCE_BREAKS = [
  {
    name: 'cancel_leaves_intent_open',
    why: "the lane's cancel leaves the intent open at Stripe",
    edits: [{
      file: 'src/app.js',
      from: '    if (exitPayments.CANCELABLE.has(intent.status)) {\n      try {',
      to: '    if (false) {\n      try {',
    }],
  },
  {
    name: 'cancel_without_key',
    why: 'the cancel is sent with no idempotency key',
    edits: [{
      file: 'src/app.js',
      from: 'exitPayments.cancelIntent(config, p.account_id, p.payment_intent_id, exitPayments.cancelKey(intent));',
      to: 'exitPayments.cancelIntent(config, p.account_id, p.payment_intent_id);',
    }],
  },
  {
    name: 'cancel_without_status_check',
    why: 'a paid intent is asked to cancel too',
    edits: [{
      file: 'src/app.js',
      from: '    if (exitPayments.CANCELABLE.has(intent.status)) {\n      try {',
      to: '    if (true) {\n      try {',
    }],
  },
  {
    name: 'paid_cancel_not_told',
    why: 'a cancel that found the card paid answers canceled',
    edits: [{
      file: 'src/app.js',
      from: "    if (out.outcome === 'paid') {\n      throw conflict('exit_paid',",
      to: "    if (false) {\n      throw conflict('exit_paid',",
    }],
  },
  {
    name: 'authorising_card_cut_off',
    why: 'a card being authorised is canceled under it',
    edits: [{
      file: 'src/app.js',
      from: "          if (err instanceof stripeAccount.ConnectRefusal && err.code === 'reader_busy') {",
      to: '          if (false) {',
    }],
  },
  {
    name: 'reader_cleared_blind',
    why: 'the reader is cleared whatever intent it shows',
    edits: [{ file: 'src/app.js', from: '      if (onReader === p.payment_intent_id) {', to: '      if (true) {' }],
  },
  {
    name: 'canceled_paid_again',
    why: 'a canceled payment is taken again',
    edits: [{ file: 'src/app.js', from: "      if (existing?.status === 'canceled') {", to: '      if (false) {' }],
  },
  {
    name: 'close_cancels_nothing',
    why: 'a close writes the stay with its payment still open',
    edits: [
      { file: 'src/app.js', from: '      if (exitId) await settleBeforeClose(tenantId, garageId, exitId);', to: '' },
      { file: 'src/app.js', from: "          if (exitCase.payment?.status === 'open') throw paymentUnsettled();", to: '' },
    ],
  },
  {
    name: 'payment_on_closed_case',
    why: 'a payment started as the case closed is recorded and sent',
    edits: [{ file: 'src/app.js', from: '        if (fresh.closed_at) return { closedMeanwhile: true };', to: '' }],
  },
  {
    name: 'let_out_at_quoted_fee',
    why: 'a car let out unpaid is written at the fee it was quoted',
    edits: [{
      file: 'src/app.js',
      from: '          letOut = exits.letOutOf(exitCase, {',
      to: '          letOut = null && exits.letOutOf(exitCase, {',
    }],
  },
  {
    name: 'let_out_unlogged',
    why: "a person's opening leaves no line in the change log",
    edits: [{
      file: 'src/app.js',
      from: '          await recordLetOutAtLane(client, { tenantId, garageId, deviceId, exitCase, letOut, letOutBy });',
      to: '',
    }],
  },
  {
    name: 'let_out_by_unnamed',
    why: 'the stay does not name the lane computer that let it out',
    edits: [{ file: 'src/app.js', from: 'by: `lane_device:${deviceId}`', to: "by: 'lane'" }],
  },
  {
    name: 'flagged_opening_refused',
    why: "a person's close that opened and flagged is refused",
    edits: [{
      file: 'src/exits.js',
      from: "['display_code_confirmed', 'human_open_now', 'human_open_and_flag']",
      to: "['display_code_confirmed', 'human_open_now']",
    }],
  },
  {
    name: 'flag_dropped_from_line',
    why: 'the change log does not say the opening was flagged',
    edits: [{ file: 'src/app.js', from: '        flagged: letOutBy === exits.FLAGGED_AUTHORITY,', to: '        flagged: false,' }],
  },
  {
    name: 'attendant_line_doubled',
    why: "an attendant's let-out gets a second line at the close",
    edits: [{
      file: 'src/app.js',
      from: '    if (exitCase.person || (!letOutBy && !letOut)) return;',
      to: '    if (!letOutBy && !letOut) return;',
    }],
  },
  {
    name: 'past_stay_hides_let_out',
    why: 'the past stays do not say a stay was let out unpaid',
    edits: [{ file: 'src/pastStays.js', from: '    let_out_unpaid: row.let_out_unpaid,', to: '    let_out_unpaid: false,' }],
  },
  {
    name: 'offset_less_time_taken',
    why: "a driver's entry time without an offset is taken",
    edits: [{
      file: 'src/app.js',
      from: "      const claimed = driverTime(req.body?.entry_at, 'entry_at');",
      to: "      const claimed = parseTime(req.body?.entry_at, 'entry_at');",
    }],
  },
  {
    name: 'cancel_any_garage_or_lane',
    why: "the cancel finds another garage's or lane's case",
    edits: [{
      file: 'src/app.js',
      from: "    const row = await withTenant(tenantId, (client) => exits.caseById(client, tenantId, garageId, req.params.exitId));\n"
        + "    if (!row) throw new HttpError(404, 'exit case not found', 'exit_not_found');\n"
        + "    if (row.lane_id !== laneId) throw conflict('exit_on_another_lane', 'this exit case is at another lane');\n"
        + '    if (!row.payment) throw',
      to: `    const row = await withTenant(tenantId, async (client) => exits.caseById(client, tenantId, ${OWN_GARAGE}, req.params.exitId));\n`
        + "    if (!row) throw new HttpError(404, 'exit case not found', 'exit_not_found');\n"
        + '    if (!row.payment) throw',
    }],
  },
  {
    name: 'word_any_garage',
    why: "the driver's word lands on another garage's case",
    edits: [{
      file: 'src/app.js',
      from: '        const row = await exits.caseById(client, tenantId, garageId, req.params.exitId, { lock: true });',
      to: `        const row = await exits.caseById(client, tenantId, ${OWN_GARAGE}, req.params.exitId, { lock: true });`,
    }],
  },
  {
    name: 'close_any_garage',
    why: "a close names another garage's case",
    edits: [{
      file: 'src/app.js',
      from: '          exitCase = await exits.caseById(client, tenantId, garageId, exitId, { lock: true });',
      to: "          exitCase = await exits.caseById(client, tenantId, (await client.query('SELECT garage_id FROM exits WHERE id = $1', [exitId])).rows[0]?.garage_id ?? garageId, exitId, { lock: true });",
    }],
  },
];

SOURCE_BREAKS.push(
  {
    name: 'second_case_not_superseding',
    why: 'a second case for the same stay leaves the open one open',
    edits: [{ file: 'src/app.js', from: "          await exits.endCase(client, tenantId, prior.id, { why: 'superseded', by_exit: caseId });\n", to: '' }],
  },
  {
    name: 'superseded_payment_left_open',
    why: "a superseded case's open payment is not canceled at Stripe first",
    edits: [{ file: 'src/app.js', from: '        if (sessionId) await settlePriorCase({ tenantId, garageId, sessionId, eventId });\n', to: '' }],
  },
  {
    name: 'stay_payment_not_counted',
    why: 'a payment the stay made at a superseded case does not settle the new one',
    edits: [{ file: 'src/exits.js', from: "  if (row.stay_payment?.status === 'succeeded') return row.stay_payment;\n", to: '' }],
  },
  {
    name: 'paid_fee_not_carried',
    why: 'a case superseding a paid one is priced afresh, not on the fee paid',
    edits: [{ file: 'src/app.js', from: '            if (paid) {\n              // PAID AT THE CASE IT SUPERSEDES', to: '            if (false) {\n              // PAID AT THE CASE IT SUPERSEDES' }],
  },
  {
    name: 'superseding_unlogged',
    why: 'a superseding leaves no line in the change log',
    edits: [{ file: 'src/app.js', from: "    await changes.record(client, ctx, {\n      garageId,\n      action: 'exit.superseded',", to: "    await (async () => {})(client, ctx, {\n      garageId,\n      action: 'exit.superseded'," }],
  },
  {
    name: 'end_payment_left_open',
    why: "a person's end leaves the stay's open payment uncanceled",
    edits: [{ file: 'src/app.js', from: '      await settleCasesBeforeEnd(req);\n', to: '' }],
  },
  {
    name: 'end_owed_ignores_paid',
    why: 'a stay that paid at an exit is answered owing the whole price',
    edits: [{ file: 'src/stuckStays.js', from: '  return Math.max(0, owed - Number(paid.amount_minor));', to: '  return owed;' }],
  },
  {
    name: 'end_owed_below_zero',
    why: 'a stay that paid more than it owes is answered owing a negative figure',
    edits: [{ file: 'src/stuckStays.js', from: '  return Math.max(0, owed - Number(paid.amount_minor));', to: '  return owed - Number(paid.amount_minor);' }],
  },
  {
    name: 'paid_currency_case',
    why: "Stripe's small-letter currency keeps what was paid from being taken off",
    edits: [{
      file: 'src/stuckStays.js',
      from: '  if (!paid || String(paid.currency).toUpperCase() !== String(currency).toUpperCase()) return owed;',
      to: '  if (!paid || paid.currency !== currency) return owed;',
    }],
  },
  {
    name: 'end_line_owed_ignores_paid',
    why: 'the event and change-log line of such a stay say the whole price',
    edits: [{ file: 'src/app.js', from: 'stuck.owedAfterPaid(owed.fee_minor, paid, row.currency)', to: 'stuck.owedAfterPaid(owed.fee_minor, null, row.currency)' }],
  },
  {
    name: 'past_owed_ignores_paid',
    why: 'the past stays show such a stay owing the whole price',
    edits: [{ file: 'src/pastStays.js', from: 'owedAfterPaid(row.owed_minor, row.paid, row.currency)', to: 'owedAfterPaid(row.owed_minor, null, row.currency)' }],
  },
  {
    name: 'other_car_intent_left',
    why: "the reader holding another case's intent refuses this case's",
    edits: [{ file: 'src/app.js', from: '    if (!held) throw busy(', to: '    if (true) throw busy(' }],
  },
  {
    name: 'reader_frees_blind',
    why: "another case's intent on the reader is canceled without reading Stripe",
    edits: [{
      file: 'src/app.js',
      from: "        await cancelPayment(tenantId, garageId, held, { why: 'reader_needed' });",
      to: "        await exitPayments.clearReader(config, payment.account_id, readerId).catch(() => {});\n        await exitPayments.cancelIntent(config, payment.account_id, held.payment.payment_intent_id).catch(() => {});",
    }],
  },
  {
    name: 'own_intent_busy',
    why: "this case's own intent waiting on the reader is a refusal",
    edits: [{ file: 'src/app.js', from: '    if (action.intent === payment.payment_intent_id) return true;\n', to: '' }],
  },
  {
    name: 'stub_replaces_action',
    why: 'the stand-in replaces an action in progress (not what Stripe does)',
    edits: [{ file: 'test/stripe-stub.js', from: "          if (reader.action?.status === 'in_progress') {", to: '          if (false) {' }],
  },
  {
    name: 'word_any_lane',
    why: "the driver's word lands on another lane's case",
    edits: [{
      file: 'src/app.js',
      from: "        // The case's own lane only: a driver's word is said where the car is.\n        if (row.lane_id !== laneId) throw conflict(",
      to: "        // The case's own lane only: a driver's word is said where the car is.\n        if (false) throw conflict(",
    }],
  },
  {
    name: 'receipt_any_lane',
    why: "a receipt goes for another lane's case",
    edits: [{
      file: 'src/app.js',
      from: '        // The case\'s own lane only: the driver types the number where the car is.\n        if (row.lane_id !== laneId) throw conflict(',
      to: '        // The case\'s own lane only: the driver types the number where the car is.\n        if (false) throw conflict(',
    }],
  },
  {
    name: 'live_key_taken',
    why: 'the test-mode check takes a live key',
    edits: [{ file: 'scripts/stripe-test-mode-check.js', from: '  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) {', to: '  if (!/^(sk|rk)_[a-z]+_[A-Za-z0-9]+$/.test(key)) {' }],
  },
  {
    name: 'poll_any_lane',
    why: "the poll reads another lane's case",
    edits: [{
      file: 'src/app.js',
      from: "      if (!row) throw new HttpError(404, 'exit case not found', 'exit_not_found');\n      if (row.lane_id !== laneId) throw conflict('exit_on_another_lane', 'this exit case is at another lane');\n      res.json({ exit: exits.present(await refreshPayment(",
      to: "      if (!row) throw new HttpError(404, 'exit case not found', 'exit_not_found');\n      res.json({ exit: exits.present(await refreshPayment(",
    }],
  },
);

const ADDED_0042 = '0042_let_out_by_a_person.sql';

const SCHEMA_BREAKS = [
  {
    name: 'let_out_with_fee',
    why: 'a let-out stay may carry a fee',
    edits: [{
      file: ADDED_0042,
      from: '    let_out IS NULL OR (\n      exit_at IS NOT NULL AND ended IS NULL',
      to: '    true OR (\n      exit_at IS NOT NULL AND ended IS NULL',
    }],
  },
  {
    name: 'let_out_says_paid',
    why: 'a let-out record may say it was paid',
    edits: [{ file: ADDED_0042, from: "        AND let_out->>'paid' = 'false'\n", to: '' }],
  },
  {
    name: 'let_out_names_nobody',
    why: 'a let-out record may name nobody',
    edits: [{ file: ADDED_0042, from: "        AND coalesce(jsonb_typeof(let_out->'by'), '') = 'string'\n        AND length(let_out->>'by') BETWEEN 1 AND 300\n", to: '' }],
  },
];

const ADDED_0045 = '0045_exit_case_ended.sql';
SCHEMA_BREAKS.push(
  {
    name: 'case_closed_unexplained',
    why: 'a case may be closed with no close event and no why',
    edits: [{
      file: ADDED_0045,
      from: '  OR (closed_at IS NOT NULL AND close_event_id IS NULL AND ended IS NOT NULL)',
      to: '  OR (closed_at IS NOT NULL AND close_event_id IS NULL)',
    }],
  },
  {
    name: 'ended_any_why',
    why: 'a case the platform closed may give any why',
    edits: [{ file: ADDED_0045, from: "        AND coalesce(ended->>'why', '') IN ('superseded', 'stay_ended')\n", to: '' }],
  },
);

const SUITE = ['--test', 'test/exit-let-out.test.js', 'test/stripe-test-mode-check.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-exit-let-out-control-'));
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

/** Every edit applied to the staged copy, or the file whose anchor moved. */
function applyEdits(dir, edits, base = '') {
  for (const edit of edits) {
    const path = join(dir, base, edit.file);
    const text = readFileSync(path, 'utf8');
    if (!text.includes(edit.from)) return { ok: false, where: edit.file };
    writeFileSync(path, text.replace(edit.from, edit.to));
  }
  return { ok: true };
}

/** A scratch database built from `migrations/` with one statement of 0042 edited. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-exit-let-out-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  const edited = applyEdits(partial, brk.edits);
  if (!edited.ok) {
    rmSync(partial, { recursive: true, force: true });
    return edited;
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
    const edited = applyEdits(dir, brk.edits);
    if (!edited.ok) {
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND in ${edited.where} ***`);
      failures += 1;
      continue;
    }
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
  console.error(`\n${failures} control(s) failed. Do not trust the exit let-out tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property canceling and letting out rest on.');
