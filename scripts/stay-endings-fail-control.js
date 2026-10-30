#!/usr/bin/env node
/**
 * The control for a stay no exit closed (0039).
 *
 * Every property below is broken, one at a time, and
 * `test/stay-endings.test.js` with `test/fill-rule.test.js` is REQUIRED to go
 * red -- with at least one test still green, so a break that stops the files
 * running is not mistaken for one the tests caught. A pass is the failure.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 * Each anchor must occur exactly once in its file.
 *
 *   folded_into_old_stay        a car in again a day later is folded into its old stay
 *   one_arrival_unseen          two entries minutes apart are two stays
 *   later_stay_unseen           an earlier visit arriving late is not stored ended
 *   superseded_untold           a stay a later entry ended leaves no event
 *   counted_at_receipt          the cars inside are counted when the open arrives, not at entry
 *   ended_still_inside          a stay no exit closed still counts inside after it ended
 *   late_close_misses_end       a late close for an ended stay finds nothing
 *   late_close_untold           a late close for an ended stay leaves no event
 *   person_end_shuts_window     a stay a person ended takes no exit after when they said
 *   clocks_never_apart          an exit seconds before its entry is a stale exit
 *   clocks_untold               an exit closed at its entry keeps no record of the time sent
 *   named_404_unnamed           a 404 at the close carries no code
 *   stuck_lists_young           the stuck list lists stays of any age
 *   stuck_lists_closed          the stuck list lists stays already closed
 *   stuck_any_hours             any older_than_hours is taken
 *   end_without_reason          a stay is ended with no reason
 *   end_twice                   an ended stay is ended again
 *   end_refused_at_an_exit      a stay whose exit case was left open cannot be ended
 *   end_leaves_case_open        a stay is ended and its exit case left open
 *   end_other_garage            a stay of another garage is ended
 *   abandoned_takes_left_at     an abandoned stay takes a time the car left
 *   left_before_entry           a car is said to have left before it came in
 *   end_event_dropped           a stay a person ended leaves no event
 *   end_line_names_car          the change-log line about a stay names something
 *   validation_left_held        a held validation stays held on an ended stay
 *   past_stays_unnamed          the past stays do not say how a stay ended
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * statement of 0039 edited, so the property genuinely never existed there.
 *
 *   reason_unchecked            an ended stay may carry any reason
 *   who_unchecked               a stay a person ended may say nothing of who or why
 *   ended_with_exit_lane        an ended stay may carry an exit lane and close event
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
const SCRATCH = process.env.STAY_ENDINGS_SCRATCH_DB || 'openparking_stay_endings_control';

const SOURCE_BREAKS = [
  {
    name: 'folded_into_old_stay',
    why: 'a car in again a day later is folded into its old stay',
    file: 'src/repository.js',
    from: '  if (existing && Math.abs(entryAt - existing.entry_at) <= reapproachMinutes() * 60_000) {',
    to: '  if (existing) {',
  },
  {
    name: 'one_arrival_unseen',
    why: 'two entries minutes apart are two stays',
    file: 'src/repository.js',
    from: '<= reapproachMinutes() * 60_000) {',
    to: '<= 0) {',
  },
  {
    name: 'later_stay_unseen',
    why: 'an earlier visit arriving late is not stored ended',
    file: 'src/repository.js',
    from: '  const endedBy = await nextStayOf(client, tenantId, garageId, vehicleId, entryAt);',
    to: '  const endedBy = null;',
  },
  {
    name: 'superseded_untold',
    why: 'a stay a later entry ended leaves no event',
    file: 'src/app.js',
    from: '        if (endedNow.length) {',
    to: '        if (false) {',
  },
  {
    name: 'counted_at_receipt',
    why: 'the cars inside are counted when the open arrives, not at entry',
    file: 'src/repository.js',
    from: ' AND s.entry_at <= $3\n                AND (s.exit_at IS NULL OR s.exit_at > $3)) AS inside',
    to: '\n                AND (s.exit_at IS NULL AND $3::timestamptz IS NOT NULL)) AS inside',
  },
  {
    name: 'ended_still_inside',
    why: 'a stay no exit closed still counts inside after it ended',
    file: 'src/repository.js',
    from: '                AND (s.exit_at IS NULL OR s.exit_at > $3)) AS inside',
    to: '                AND (s.exit_at IS NULL OR s.ended IS NOT NULL OR s.exit_at > $3)) AS inside',
  },
  {
    name: 'late_close_misses_end',
    why: 'a late close for an ended stay finds nothing',
    file: 'src/app.js',
    from: '        if (!exitCase && (!open || exitAt < open.entry_at)) {',
    to: '        if (false) {',
  },
  {
    name: 'late_close_untold',
    why: 'a late close for an ended stay leaves no event',
    file: 'src/app.js',
    from: '            ...(wasEnded ? [{',
    to: '            ...(false ? [{',
  },
  {
    name: 'person_end_shuts_window',
    why: 'a stay a person ended takes no exit after when they said',
    file: 'src/repository.js',
    from: "        AND CASE WHEN s.ended->>'reason' <> 'superseded'",
    to: '        AND CASE WHEN false',
  },
  {
    name: 'clocks_never_apart',
    why: 'an exit seconds before its entry is a stale exit',
    file: 'src/app.js',
    from: 'const LANE_CLOCKS_APART_MS = 2 * MAX_CLOCK_SKEW_SECONDS * 1000;',
    to: 'const LANE_CLOCKS_APART_MS = 0;',
  },
  {
    name: 'clocks_untold',
    why: 'an exit closed at its entry keeps no record of the time sent',
    file: 'src/app.js',
    from: '            ...(clocksApart ? [{',
    to: '            ...(false ? [{',
  },
  {
    name: 'named_404_unnamed',
    why: 'a 404 at the close carries no code',
    file: 'src/app.js',
    from: "            named ? 'session_not_open' : 'no_open_stay',",
    to: '            undefined,',
  },
  {
    name: 'stuck_lists_young',
    why: 'the stuck list lists stays of any age',
    file: 'src/stuckStays.js',
    from: '        AND s.entry_at <= $3::timestamptz - make_interval(hours => $4)',
    to: '        AND $3::timestamptz IS NOT NULL AND $4::int >= 0',
  },
  {
    name: 'stuck_lists_closed',
    why: 'the stuck list lists stays already closed',
    file: 'src/stuckStays.js',
    from: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL',
    to: '      WHERE s.tenant_id = $1 AND s.garage_id = $2',
  },
  {
    name: 'stuck_any_hours',
    why: 'any older_than_hours is taken',
    file: 'src/stuckStays.js',
    from: '  if (!hoursInBounds(n)) {',
    to: '  if (false) {',
  },
  {
    name: 'end_without_reason',
    why: 'a stay is ended with no reason',
    file: 'src/stuckStays.js',
    from: "  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > REASON_MAX) {",
    to: "  if (reason !== undefined && typeof reason !== 'string') {",
  },
  {
    name: 'end_twice',
    why: 'an ended stay is ended again',
    file: 'src/app.js',
    from: "        if (stay.exit_at) throw conflict('stay_not_open', 'this stay is not open: it has already been closed or ended');\n",
    to: '',
    also: [{
      file: 'src/repository.js',
      from: "                              ELSE validation END\n      WHERE tenant_id = $1 AND id = $2 AND exit_at IS NULL",
      to: "                              ELSE validation END\n      WHERE tenant_id = $1 AND id = $2",
    }],
  },
  {
    name: 'end_refused_at_an_exit',
    why: 'a stay whose exit case was left open cannot be ended',
    file: 'src/app.js',
    from: '        const leftAt = ask.leftAt ? refuseFuture(ask.leftAt, \'left_at\', now) : now;',
    to: '        if (atExit.length) throw conflict(\'stay_at_an_exit\', \'a car is at an exit lane on this stay\');\n        const leftAt = ask.leftAt ? refuseFuture(ask.leftAt, \'left_at\', now) : now;',
  },
  {
    name: 'end_leaves_case_open',
    why: 'a stay is ended and its exit case left open',
    file: 'src/app.js',
    from: "          await exits.endCase(client, req.tenantId, c.id, { why: 'stay_ended', by });",
    to: '',
  },
  {
    name: 'end_other_garage',
    why: 'a stay of another garage is ended',
    file: 'src/app.js',
    from: '        if (!stay || stay.garage_id !== garage.id)',
    to: '        if (!stay)',
  },
  {
    name: 'abandoned_takes_left_at',
    why: 'an abandoned stay takes a time the car left',
    file: 'src/stuckStays.js',
    from: "    if (outcome !== 'ended') throw bad(",
    to: '    if (false) throw bad(',
  },
  {
    name: 'left_before_entry',
    why: 'a car is said to have left before it came in',
    file: 'src/app.js',
    from: '        if (leftAt < stay.entry_at) throw',
    to: '        if (false) throw',
  },
  {
    name: 'end_event_dropped',
    why: 'a stay a person ended leaves no event',
    file: 'src/app.js',
    from: '          kind: stuck.STAY_ENDED_EVENT_KIND,\n          occurredAt: now,',
    to: "          kind: 'stay_end_unnamed',\n          occurredAt: now,",
  },
  {
    name: 'end_line_names_car',
    why: 'the change-log line about a stay names something',
    file: 'src/app.js',
    from: "          subject: { kind: 'stay', id: row.id, name: null },",
    to: "          subject: { kind: 'stay', id: row.id, name: stay.id.slice(0, 8) },",
  },
  {
    name: 'validation_left_held',
    why: 'a held validation stays held on an ended stay',
    file: 'src/repository.js',
    from: "            validation = CASE WHEN validation->>'state' IN ('claiming', 'held')\n                              THEN validation || jsonb_build_object('state', 'releasing', 'releasing_at', $5::text,\n                                                                    'released_by', 'ended'",
    to: "            validation = CASE WHEN false\n                              THEN validation || jsonb_build_object('state', 'releasing', 'releasing_at', $5::text,\n                                                                    'released_by', 'ended'",
  },
  {
    name: 'past_stays_unnamed',
    why: 'the past stays do not say how a stay ended',
    file: 'src/pastStays.js',
    from: '    ended: row.ended,',
    to: '    ended: null,',
  },
];

const ADDED_0039 = '0039_stay_endings.sql';

const SCHEMA_BREAKS = [
  {
    name: 'reason_unchecked',
    why: 'an ended stay may carry any reason',
    edits: [{ file: ADDED_0039, from: "        AND coalesce(ended->>'reason', '') IN ('superseded', 'ended', 'abandoned')", to: '        AND true' }],
  },
  {
    name: 'who_unchecked',
    why: 'a stay a person ended may say nothing of who or why',
    edits: [{ file: ADDED_0039, from: "        AND (ended->>'reason' = 'superseded' OR (", to: '        AND (true OR (' }],
  },
  {
    name: 'ended_with_exit_lane',
    why: 'an ended stay may carry an exit lane and close event',
    edits: [{
      file: ADDED_0039,
      from: '    (exit_at IS NOT NULL AND ended IS NOT NULL AND exit_lane_id IS NULL AND close_event_id IS NULL)',
      to: '    (exit_at IS NOT NULL AND ended IS NOT NULL)',
    }],
  },
];

const SUITE = ['--test', 'test/stay-endings.test.js', 'test/fill-rule.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-stay-endings-control-'));
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

/** Apply one edit to a staged file; false when its anchor is not there exactly once. */
function apply(dir, { file, from, to }) {
  const path = join(dir, file);
  const source = readFileSync(path, 'utf8');
  if (source.split(from).length !== 2) return false;
  writeFileSync(path, source.replace(from, to));
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

/** A scratch database built from `migrations/` with one statement of 0039 edited. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-stay-endings-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  for (const edit of brk.edits) {
    if (!apply(partial, edit)) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, where: edit.file };
    }
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
    const edits = [{ file: brk.file, from: brk.from, to: brk.to }, ...(brk.also ?? [])];
    const missing = edits.find((e) => !apply(dir, e));
    if (missing) {
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing.file} ***`);
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
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${built.where} ***`);
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
  console.error(`\n${failures} control(s) failed. Do not trust the stay-ending tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property ending a stay rests on.');
