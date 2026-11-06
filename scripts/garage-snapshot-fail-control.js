#!/usr/bin/env node
/**
 * The control for a garage's own numbers: GET /garages/:garageId/today and
 * /snapshot (src/garageSnapshot.js).
 *
 * Every property is broken below, one at a time, and the suite is REQUIRED
 * to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported as
 * not planted rather than run:
 *   ended_counted_out      a stay ended with no exit gate is counted out.
 *   inside_not_counted     a car still inside is not counted in.
 *   next_day_counted       the first minute of the day after the range is in.
 *   price_is_money         a stay's price is added to the takings.
 *   money_when_started     a payment is put on the day it started, not the day it succeeded.
 *   refund_dropped         a refund is not shown.
 *   refund_netted          takings are less their refunds, not gross.
 *   utc_days               days and hours are UTC's, not the garage's.
 *   day_of_24_hours        the last day of a range is 24 hours from its start.
 *   currencies_added       two currencies are added together.
 *   average_dropped        the average stay is not given.
 *   other_account_read     a garage not found is read anyway, as an empty one.
 *   wrong_permission       the reads ask for less than money:read.
 *   range_over_366         a range of 367 days is read.
 *   range_backwards        a last day before the first is read.
 *   absent_day_is_today    a missing day is taken for today.
 *   stays_any_garage       the cars in are the account's, not the garage's.
 *   payments_any_garage    the takings are the account's, not the garage's.
 *   lanes_any_garage       the lanes are the account's, not the garage's.
 *   open_any_garage        the cars inside are the account's, not the garage's.
 *   plate_shown            the plates ride along with the range.
 *   stay_ids_shown         the stay ids ride along with the range.
 *   intents_shown          the payment ids ride along with today.
 *   stored_answer          the answers may be stored.
 *
 * `p.status = 'succeeded'` has no break of its own: 0038's
 * `exit_payments_state_times` already allows `succeeded_at` on no other state,
 * so nothing else can be in the range. It is there for the index (0050).
 * `tenant_id` in each predicate is the second of two controls, beside the
 * policy; `npm run rls-fail-control` breaks the policies.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SNAP = 'src/garageSnapshot.js';
const APP = 'src/app.js';

const SOURCE_BREAKS = [
  {
    name: 'ended_counted_out',
    why: 'a stay ended with no exit gate is counted out',
    file: SNAP,
    from: 'AND s.garage_id = $2 AND s.exit_lane_id IS NOT NULL\n          AND s.exit_at >= $3',
    to: 'AND s.garage_id = $2\n          AND s.exit_at >= $3',
  },
  {
    name: 'inside_not_counted',
    why: 'a car still inside is not counted in',
    file: SNAP,
    from: 'AND s.entry_at >= $3 AND s.entry_at < $4',
    to: 'AND s.exit_at IS NOT NULL AND s.entry_at >= $3 AND s.entry_at < $4',
  },
  {
    name: 'next_day_counted',
    why: 'the first minute of the day after the range is in',
    file: SNAP,
    from: 'AND s.entry_at < $4',
    to: 'AND s.entry_at <= $4',
  },
  {
    name: 'price_is_money',
    why: "a stay's price is added to the takings",
    file: SNAP,
    from: 'extract(epoch FROM s.exit_at - s.entry_at) / 60, 0, 0, NULL',
    to: 'extract(epoch FROM s.exit_at - s.entry_at) / 60, coalesce(s.fee_minor, 0), 0, NULL',
  },
  {
    name: 'money_when_started',
    why: 'a payment is put on the day it started, not the day it succeeded',
    file: SNAP,
    from: "AND p.status = 'succeeded'\n          AND p.succeeded_at >= $3 AND p.succeeded_at < $4",
    to: "AND p.status = 'succeeded'\n          AND p.created_at >= $3 AND p.created_at < $4",
  },
  {
    name: 'refund_dropped',
    why: 'a refund is not shown',
    file: SNAP,
    from: 'p.amount_minor, p.refunded_minor, upper(p.currency)',
    to: 'p.amount_minor, 0, upper(p.currency)',
  },
  {
    name: 'refund_netted',
    why: 'takings are less their refunds, not gross',
    file: SNAP,
    from: 'p.amount_minor, p.refunded_minor, upper(p.currency)',
    to: 'p.amount_minor - p.refunded_minor, p.refunded_minor, upper(p.currency)',
  },
  {
    name: 'utc_days',
    why: "days and hours are UTC's, not the garage's",
    file: SNAP,
    from: '[tenantId, garage.id, from, to, garage.timezone]',
    to: "[tenantId, garage.id, from, to, 'UTC']",
  },
  {
    name: 'day_of_24_hours',
    why: 'the last day of a range is 24 hours from its start',
    file: APP,
    from: 'const { to } = garageDay(days.last, garage.timezone);',
    to: 'const to = new Date(garageDay(days.last, garage.timezone).from.getTime() + 86_400_000);',
  },
  {
    name: 'currencies_added',
    why: 'two currencies are added together',
    file: APP,
    from: 'if (figures.currencies.some((c) => c !== garage.currency)) {',
    to: 'if (false) {',
  },
  {
    name: 'average_dropped',
    why: 'the average stay is not given',
    file: SNAP,
    from: 'round(sum(minutes) / nullif(sum(cars_out), 0)) AS average_stay_minutes',
    to: 'NULL::numeric AS average_stay_minutes',
  },
  {
    name: 'other_account_read',
    why: 'a garage not found is read anyway, as an empty one',
    file: APP,
    from: "        const garage = await ownGarage(client, req);\n        const days = garageSnapshot.readDays(req.query);",
    to: "        const garage = { id: req.params.garageId, timezone: 'UTC', currency: 'USD' };\n        const days = garageSnapshot.readDays(req.query);",
    also: [{
      file: APP,
      from: "        const garage = await ownGarage(client, req);\n        const { day, from, to } = garageDay(undefined, garage.timezone);",
      to: "        const garage = { id: req.params.garageId, timezone: 'UTC', currency: 'USD' };\n        const { day, from, to } = garageDay(undefined, garage.timezone);",
    }],
  },
  {
    name: 'wrong_permission',
    why: 'the reads ask for less than money:read',
    file: APP,
    from: "operator.get('/garages/:garageId/today', may('money:read'),",
    to: "operator.get('/garages/:garageId/today', may('garages:read'),",
    also: [{
      file: APP,
      from: "operator.get('/garages/:garageId/snapshot', may('money:read'),",
      to: "operator.get('/garages/:garageId/snapshot', may('garages:read'),",
    }],
  },
  {
    name: 'range_over_366',
    why: 'a range of 367 days is read',
    file: SNAP,
    from: 'days >= RANGE_MAX_DAYS',
    to: 'days > RANGE_MAX_DAYS',
  },
  {
    name: 'range_backwards',
    why: 'a last day before the first is read',
    file: SNAP,
    from: 'if (days < 0 || days',
    to: 'if (days',
  },
  {
    name: 'absent_day_is_today',
    why: 'a missing day is taken for today',
    file: SNAP,
    from: "export function readDays({ from, to } = {}) {\n  if (typeof from",
    to: "export function readDays({ from = new Date().toISOString().slice(0, 10), to = from } = {}) {\n  if (typeof from",
  },
  {
    name: 'stays_any_garage',
    why: "the cars in are the account's, not the garage's",
    file: SNAP,
    from: 'WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.entry_at >= $3',
    to: 'WHERE s.tenant_id = $1 AND $2::uuid IS NOT NULL AND s.entry_at >= $3',
  },
  {
    name: 'payments_any_garage',
    why: "the takings are the account's, not the garage's",
    file: SNAP,
    from: 'WHERE p.tenant_id = $1 AND p.garage_id = $2 AND',
    to: 'WHERE p.tenant_id = $1 AND',
  },
  {
    name: 'lanes_any_garage',
    why: "the lanes are the account's, not the garage's",
    file: SNAP,
    from: 'WHERE l.tenant_id = $1 AND l.garage_id = $2) AS lanes',
    to: 'WHERE l.tenant_id = $1) AS lanes',
  },
  {
    name: 'open_any_garage',
    why: "the cars inside are the account's, not the garage's",
    file: SNAP,
    from: 'WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL) AS open_stays',
    to: 'WHERE s.tenant_id = $1 AND s.exit_at IS NULL) AS open_stays',
  },
  {
    name: 'plate_shown',
    why: 'the plates ride along with the range',
    file: SNAP,
    from: 'SELECT (SELECT count(*)::int FROM sessions s',
    to: 'SELECT (SELECT jsonb_agg(v.plate) FROM vehicles v WHERE v.tenant_id = $1) AS plates, (SELECT count(*)::int FROM sessions s',
    also: [{ file: SNAP, from: '    from: first,\n', to: '    plates: figures.plates,\n    from: first,\n' }],
  },
  {
    name: 'stay_ids_shown',
    why: 'the stay ids ride along with the range',
    file: SNAP,
    from: 'SELECT (SELECT count(*)::int FROM sessions s',
    to: 'SELECT (SELECT jsonb_agg(s.id) FROM sessions s WHERE s.tenant_id = $1) AS stays, (SELECT count(*)::int FROM sessions s',
    also: [{ file: SNAP, from: '    from: first,\n', to: '    stays: figures.stays,\n    from: first,\n' }],
  },
  {
    name: 'intents_shown',
    why: 'the payment ids ride along with today',
    file: SNAP,
    from: 'SELECT (SELECT count(*)::int FROM sessions s',
    to: 'SELECT (SELECT jsonb_agg(p.payment_intent_id) FROM exit_payments p WHERE p.tenant_id = $1) AS intents, (SELECT count(*)::int FROM sessions s',
    also: [{ file: SNAP, from: '    date: day,\n', to: '    intents: figures.intents,\n    date: day,\n' }],
  },
  {
    name: 'stored_answer',
    why: 'the answers may be stored',
    file: APP,
    from: '  operator.use(signIn.noStore);\n',
    to: '',
  },
];

const SUITE = ['--test', 'test/garage-snapshot.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-garage-snapshot-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, SUITE, { cwd: dir, env: process.env, stdio: 'pipe', encoding: 'utf8' });
}

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  return `${line('pass')} passed, ${line('fail')} failed`;
}

/** A break and its `also` edits, every one or none: each anchor exactly once. */
function plant(dir, edit) {
  const planned = [];
  for (const e of [edit, ...(edit.also ?? [])]) {
    const path = join(dir, e.file);
    const source = planned.find((p) => p.path === path)?.text ?? readFileSync(path, 'utf8');
    if (source.split(e.from).length !== 2) return false;
    const text = source.replace(e.from, e.to);
    const at = planned.findIndex((p) => p.path === path);
    if (at === -1) planned.push({ path, text });
    else planned[at].text = text;
  }
  for (const p of planned) writeFileSync(p.path, p.text);
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
      console.error(`  ${brk.name.padEnd(24)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(`  ${brk.name.padEnd(24)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(24)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log("\nall controls OK — the suite fails on every property a garage's own numbers rest on.");
