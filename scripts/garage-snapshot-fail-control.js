#!/usr/bin/env node
/**
 * The control for a garage's own numbers (src/garageSnapshot.js) and the refund
 * ledger and its webhook (src/exitRefunds.js, 0051).
 *
 * Every property is broken below, one at a time, and the two suites are
 * REQUIRED to go red. A pass is the failure. Each break's `why` says what it
 * does.
 *
 * SOURCE breaks are applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported as
 * not planted rather than run.
 *
 * SCHEMA breaks change a SCRATCH COPY of the test database (needs SUPERUSER_URL)
 * and run the suites on it. Nothing else may hold the test database meanwhile.
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
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SNAP = 'src/garageSnapshot.js';
const APP = 'src/app.js';
const REFUNDS = 'src/exitRefunds.js';

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
    from: 'NULL, 0, 0, NULL, 0, r.amount_minor, upper(r.currency)',
    to: 'NULL, 0, 0, NULL, 0, 0, upper(r.currency)',
  },
  {
    name: 'refund_on_payment_day',
    why: "a refund lands on its payment's day",
    file: SNAP,
    from: 'SELECT r.refunded_at AT TIME ZONE $5,',
    to: 'SELECT (SELECT p.succeeded_at FROM exit_payments p WHERE p.id = r.exit_payment_id) AT TIME ZONE $5,',
  },
  {
    name: 'refund_sum_is_max',
    why: "an hour's refunds are the largest, not the sum",
    file: SNAP,
    from: 'sum(takings) AS takings, sum(refunds) AS refunds\n',
    to: 'sum(takings) AS takings, max(refunds) AS refunds\n',
  },
  {
    name: 'refund_edge_end',
    why: "a refund at the next day's first instant is in",
    file: SNAP,
    from: 'AND r.refunded_at < $4',
    to: 'AND r.refunded_at <= $4',
  },
  {
    name: 'refund_edge_start',
    why: "a refund at the day's first instant is out",
    file: SNAP,
    from: 'AND r.refunded_at >= $3',
    to: 'AND r.refunded_at > $3',
  },
  {
    name: 'exit_edge_end',
    why: "a car out at the next day's first instant is in",
    file: SNAP,
    from: 'AND s.exit_at < $4',
    to: 'AND s.exit_at <= $4',
  },
  {
    name: 'exit_edge_start',
    why: "a car out at the day's first instant is out",
    file: SNAP,
    from: 'AND s.exit_at >= $3',
    to: 'AND s.exit_at > $3',
  },
  {
    name: 'payment_edge_end',
    why: "a payment at the next day's first instant is in",
    file: SNAP,
    from: 'AND p.succeeded_at < $4',
    to: 'AND p.succeeded_at <= $4',
  },
  {
    name: 'payment_edge_start',
    why: "a payment at the day's first instant is out",
    file: SNAP,
    from: 'AND p.succeeded_at >= $3',
    to: 'AND p.succeeded_at > $3',
  },
  {
    name: 'today_gross',
    why: "today's takings are gross",
    file: SNAP,
    from: 'takings_minor: d.takings_minor - d.refunds_minor,',
    to: 'takings_minor: d.takings_minor,',
  },
  {
    name: 'today_no_refunds',
    why: "today does not say its refunds",
    file: SNAP,
    from: '    refunds_minor: d.refunds_minor,\n    currency,',
    to: '    currency,',
  },
  {
    name: 'today_utc_day',
    why: "today is UTC's day",
    file: APP,
    from: 'garageDay(undefined, garage.timezone);',
    to: 'garageDay(new Date().toISOString().slice(0, 10), garage.timezone);',
  },
  {
    name: 'today_of_24_hours',
    why: 'today is 24 hours from its start',
    file: APP,
    from: "const { day, from, to } = garageDay(undefined, garage.timezone);",
    to: "const { day, from } = garageDay(undefined, garage.timezone);\n        const to = new Date(from.getTime() + 86_400_000);",
  },
  {
    name: 'open_limited_to_range',
    why: 'the cars inside are only those that came in in the range',
    file: SNAP,
    from: 'WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL) AS open_stays',
    to: 'WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL AND s.entry_at >= $3) AS open_stays',
  },
  {
    name: 'open_is_cars_in',
    why: "today's cars inside are its cars in",
    file: SNAP,
    from: '    open_stays: figures.open_stays,\n    takings_minor: d.takings_minor',
    to: '    open_stays: d.cars_in,\n    takings_minor: d.takings_minor',
  },
  {
    name: 'average_floored',
    why: 'the average stay is rounded down',
    file: SNAP,
    from: 'round(sum(minutes) / nullif(sum(cars_out), 0))',
    to: 'floor(sum(minutes) / nullif(sum(cars_out), 0))',
  },
  {
    name: 'hour_no_refunds',
    why: 'the hours do not say their refunds',
    file: SNAP,
    from: "refunds_minor: toMinor(hour(h)?.refunds_minor ?? 0, 'refunds_minor'),",
    to: 'refunds_minor: 0,',
  },
  {
    name: 'minute_unlimited',
    why: 'one key may read without limit',
    file: APP,
    from: 'if (!limit.allowed || going >= garageSnapshot.READS_AT_ONCE) {',
    to: 'if (going >= garageSnapshot.READS_AT_ONCE) {',
  },
  {
    name: 'at_once_unlimited',
    why: 'one key may hold any number of reads at once',
    file: APP,
    from: 'if (!limit.allowed || going >= garageSnapshot.READS_AT_ONCE) {',
    to: 'if (!limit.allowed) {',
  },
  {
    name: 'turn_kept',
    why: 'a finished read keeps its turn',
    file: APP,
    from: 'const left = snapshotsGoing.get(who) - 1;',
    to: 'const left = snapshotsGoing.get(who);',
  },
  {
    name: 'no_retry_after',
    why: 'a refused read does not say when to come back',
    file: APP,
    from: 'refusal.retryAfter = limit.allowed ? 1 : limit.retryAfterSeconds;\n',
    to: '',
  },
  {
    name: 'no_timeout',
    why: 'a read may run as long as it likes',
    file: APP,
    from: "        await client.query(\"SELECT set_config('statement_timeout', $1, true)\", [String(startSetting('SNAPSHOT_TIMEOUT_MS'))]);\n",
    to: '',
  },
  {
    name: 'timeout_on_the_pool',
    why: 'the timeout stays on the connection for whoever borrows it next',
    file: APP,
    from: "SELECT set_config('statement_timeout', $1, true)",
    to: "SELECT set_config('statement_timeout', $1, false)",
  },
  {
    name: 'timeout_unworded',
    why: 'a read cut off is a bare 500',
    file: APP,
    from: 'if (err?.code !== QUERY_CANCELED) throw err;',
    to: 'if (err) throw err;',
  },
  {
    name: 'year_9999',
    why: 'the last year of the calendar reaches the zone arithmetic',
    file: APP,
    from: " || Number(day.slice(0, 4)) > 9998\n",
    to: '\n',
  },
  {
    name: 'door_always_on',
    why: 'the webhook is on with no secret',
    file: APP,
    from: "    if (!exitRefunds.webhookSecret()) return next('route');\n",
    to: '',
  },
  {
    name: 'signature_unchecked',
    why: 'a webhook is taken with no signature checked',
    file: APP,
    from: "if (!exitRefunds.signedByStripe(req.body, req.get('stripe-signature'), exitRefunds.webhookSecret(), Math.floor(Date.now() / 1000))) {",
    to: 'if (false) {',
  },
  {
    name: 'any_age',
    why: 'a signed delivery may be replayed at any time',
    file: REFUNDS,
    from: ' || Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS',
    to: '',
  },
  {
    name: 'future_signature',
    why: 'a signed time ahead of now is taken',
    file: REFUNDS,
    from: 'Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS',
    to: 'nowSeconds - Number(t) > TOLERANCE_SECONDS',
  },
  {
    name: 'any_v1',
    why: 'the signature scheme is not named',
    file: REFUNDS,
    from: "parts.some(([k, v]) => k === 'v1' && ",
    to: 'parts.some(([, v]) => ',
  },
  {
    name: 'any_event_type',
    why: 'any event with a PaymentIntent is taken',
    file: REFUNDS,
    from: " || !REFUND_EVENTS.includes(event.type)",
    to: '',
  },
  {
    name: 'dated_when_heard',
    why: 'a refund is dated when it was heard, not when Stripe reported it',
    file: REFUNDS,
    from: 'payment.currency, eventId, at],',
    to: 'payment.currency, eventId, new Date()],',
  },
  {
    name: 'repeat_not_handled',
    why: 'an event delivered again is an error',
    file: REFUNDS,
    from: '     ON CONFLICT (stripe_event_id) DO NOTHING`,',
    to: '     `,',
  },
  {
    name: 'payment_total_dropped',
    why: "the payment's refunded total does not follow",
    file: REFUNDS,
    from: 'SET refunded_minor = $3, refunds_read_at = now()',
    to: 'SET refunded_minor = refunded_minor + 0 * $3::int, refunds_read_at = now()',
  },
  {
    name: 'held_from_the_payment',
    why: 'the difference is taken from the payment and not the ledger',
    file: REFUNDS,
    from: 'const held = Number(rows[0].held);',
    to: 'const held = payment.refunded_minor;',
  },
  {
    name: 'reversal_dropped',
    why: 'a failed refund is not a reversal',
    file: REFUNDS,
    from: "if (total === held) return 'unchanged';",
    to: "if (total <= held) return 'unchanged';",
  },
  {
    name: 'over_the_payment',
    why: 'more may be refunded than the payment took',
    file: REFUNDS,
    from: 'total = Math.min(await refundedOf(config, account, intent), payment.amount_minor);',
    to: 'total = await refundedOf(config, account, intent);',
  },
  {
    name: 'any_garage_account',
    why: "an event reaches another garage's payment",
    file: REFUNDS,
    from: 'AND account_id = $2 AND payment_intent_id = $3',
    to: 'AND $2::text IS NOT NULL AND payment_intent_id = $3',
  },
  {
    name: 'no_lock',
    why: 'two events of one payment do not take turns',
    file: REFUNDS,
    from: "  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`exit_refund:${payment.id}`]);\n",
    to: '',
  },
  {
    name: 'open_payment_dropped',
    why: 'a refund of a payment still open here is lost',
    file: REFUNDS,
    from: "if (payment.status !== 'succeeded') throw new TryAgainLater('a refund of a payment still open here');",
    to: "if (payment.status !== 'succeeded') return 'ignored';",
  },
  {
    name: 'canceled_payment_read',
    why: 'a canceled payment is asked about',
    file: REFUNDS,
    from: "if (!payment || payment.status === 'canceled') return 'ignored';",
    to: "if (!payment) return 'ignored';",
  },
  {
    name: 'stripe_down_dropped',
    why: 'Stripe not answering loses the event',
    file: REFUNDS,
    from: "throw new TryAgainLater('Stripe could not be read');",
    to: "return 'unchanged';",
  },
  {
    name: 'stranger_retried',
    why: 'an account no garage holds is sent again for ever',
    file: REFUNDS,
    from: "if (rows.length === 0) return 'ignored';",
    to: "if (rows.length === 0) throw new TryAgainLater('whose');",
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

const SCHEMA_BREAKS = [
  { name: 'amounts_any_sign', why: 'a refund may be of any sign', sql: 'ALTER TABLE exit_refunds DROP CONSTRAINT exit_refunds_amount_by_kind' },
  { name: 'event_twice', why: 'an event may be two rows', sql: 'ALTER TABLE exit_refunds DROP CONSTRAINT exit_refunds_one_per_event' },
  { name: 'any_payment', why: "a refund may be of another account's payment", sql: 'DROP TRIGGER exit_refunds_on_own_payment ON exit_refunds' },
  { name: 'ledger_editable', why: 'the ledger may be changed and deleted', sql: 'GRANT UPDATE, DELETE ON exit_refunds TO openparking_app' },
  { name: 'lookup_for_all', why: 'the account lookup opens for the application role', sql: "CREATE POLICY open_for_all ON garage_stripe_accounts FOR SELECT TO openparking_app USING (current_setting('openparking.definer_lookup', true) = 'on')" },
];

const SUITE = ['--test', 'test/garage-snapshot.test.js', 'test/exit-refunds.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-garage-snapshot-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir, env = process.env) {
  return spawnSync(process.execPath, SUITE, { cwd: dir, env, stdio: 'pipe', encoding: 'utf8' });
}

/** A client on `database` as the superuser; ended after `fn`. */
async function asSuperuser(database, fn) {
  const url = new URL(process.env.SUPERUSER_URL);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The environment with its database URLs moved to `database`. */
function onDatabase(database) {
  const moved = (raw) => {
    const url = new URL(raw);
    url.pathname = `/${database}`;
    return url.toString();
  };
  return { ...process.env, DATABASE_URL: moved(process.env.DATABASE_URL), APP_DATABASE_URL: moved(process.env.APP_DATABASE_URL) };
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

console.log('\n== control C: each SCHEMA break must make it FAIL ==');
const BASE = new URL(process.env.APP_DATABASE_URL).pathname.slice(1);
const SCRATCH = `${BASE}_snapshot_control`;
const dir = stage();
try {
  for (const brk of SCHEMA_BREAKS) {
    await asSuperuser('postgres', (c) => c.query(`CREATE DATABASE ${SCRATCH} TEMPLATE ${BASE}`));
    try {
      await asSuperuser(SCRATCH, (c) => c.query(brk.sql));
      const broken = run(dir, onDatabase(SCRATCH));
      if (broken.status === 0) {
        console.error(`  ${brk.name.padEnd(24)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
        failures += 1;
      } else {
        console.log(`  ${brk.name.padEnd(24)} fails as required when ${brk.why} — ${summarise(broken)}`);
      }
    } finally {
      await asSuperuser('postgres', (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log("\nall controls OK — the suites fail on every property a garage's own numbers and the refund ledger rest on.");
