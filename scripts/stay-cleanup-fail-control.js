#!/usr/bin/env node
/**
 * The control for the garage clean-up (0043).
 *
 * Every property below is broken, one at a time, and `test/stay-cleanup.test.js`
 * with `test/stay-cleanup-passes.test.js` (the real garage-pass) and
 * `test/change-log.test.js` is REQUIRED to go red -- with at least one
 * test still green, so a break that stops the files running is not mistaken
 * for one the tests caught. A pass is the failure.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 * Each anchor must occur exactly once in its file.
 *
 *   garage_age_ignored          the stuck list ignores the garage's own age
 *   age_setting_unchecked       the garage's age takes anything
 *   age_setting_dropped         the garage's age is never saved
 *   walk_list_dropped           the stuck list leaves out the stays the latest walk missed
 *   pictures_missing            a listed stay carries no pictures
 *   pictures_oldest_first       a listed stay's pictures come oldest first
 *   picture_any_stay            a picture is served through any stay of the garage
 *   picture_any_garage          a picture is served through another garage of the account
 *   ended_owes_nothing          a stay that ended owes nothing
 *   abandoned_owes              an abandoned stay is priced too
 *   owed_at_now                 an ended stay is priced to now, not to when the car left
 *   past_owed_missing           the past stays do not say what an ended stay owes
 *   reason_any_characters       a reason may carry line breaks and control characters
 *   line_before_thin            the change-log line does not say what the stay was
 *   line_owed_missing           the change-log line does not say what the stay owes
 *   line_names_plate            the change-log line names the car's plate
 *   event_owed_missing          the stay's event does not say what it owes
 *   pass_never_asked            a pass holder a person ended is priced with no lane to ask the pass at
 *   pass_first_lane_only        the pass is asked at the garage's first exit lane only
 *   pass_unasked_unsaid         a pass not asked for want of an exit lane is not said
 *   pass_unasked_not_answered   the end's answer does not say the pass was not asked
 *   past_pass_unasked_missing   the past stays do not say the pass was not asked
 *   owed_record_dropped         what the modules said is not kept on what an ended stay owes
 *   owed_record_kept_forever    what the modules said outlives the vehicle's retention window
 *   ended_pass_always_covers    a pass asked at the exit lanes covers a car it does not cover
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * statement of 0043 edited, so the property genuinely never existed there.
 *
 *   owed_on_any_stay            a superseded or abandoned stay may owe
 *   owed_other_currency         a stay may owe in another currency
 *   owed_fraction               a stay may owe a fraction of a minor unit
 *   owed_covered_charged        a covered stay may owe money
 *   age_unbounded               a garage's age may be 0 or over 2160 hours
 *   age_default_not_24          a garage that set nothing lists at another age
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
const SCRATCH = process.env.STAY_CLEANUP_SCRATCH_DB || 'openparking_stay_cleanup_control';

const SOURCE_BREAKS = [
  {
    name: 'garage_age_ignored',
    why: "the stuck list ignores the garage's own age",
    file: 'src/app.js',
    from: '        const hours = stuck.olderThanHours(req.query.older_than_hours, garage.stuck_after_hours);',
    to: '        const hours = stuck.olderThanHours(req.query.older_than_hours);',
  },
  {
    name: 'age_setting_unchecked',
    why: "the garage's age takes anything",
    file: 'src/stuckStays.js',
    from: '  if (!hoursInBounds(raw)) {',
    to: '  if (false) {',
  },
  {
    name: 'age_setting_dropped',
    why: "the garage's age is never saved",
    file: 'src/app.js',
    from: '        stuck_after_hours: stuckAfter,\n',
    to: '',
  },
  {
    name: 'walk_list_dropped',
    why: 'the stuck list leaves out the stays the latest walk missed',
    file: 'src/app.js',
    from: '        const all = [...old, ...unseen].sort(',
    to: '        const all = [...old].sort(',
  },
  {
    name: 'pictures_missing',
    why: 'a listed stay carries no pictures',
    file: 'src/stuckStays.js',
    from: '    pictures: pictures.get(r.open_event_id) ?? [],',
    to: '    pictures: [],',
  },
  {
    name: 'pictures_oldest_first',
    why: "a listed stay's pictures come oldest first",
    file: 'src/stuckStays.js',
    from: '      ORDER BY event_id, taken_at DESC, id`,',
    to: '      ORDER BY event_id, taken_at, id`,',
  },
  {
    name: 'picture_any_stay',
    why: 'a picture is served through any stay of the garage',
    file: 'src/stuckStays.js',
    from: '       JOIN entry_pictures p ON p.tenant_id = s.tenant_id AND p.garage_id = s.garage_id AND p.event_id = s.open_event_id',
    to: '       JOIN entry_pictures p ON p.tenant_id = s.tenant_id AND p.garage_id = s.garage_id',
  },
  {
    name: 'picture_any_garage',
    why: 'a picture is served through another garage of the account',
    file: 'src/stuckStays.js',
    from: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.id = $3 AND p.id = $4`,',
    to: '      WHERE s.tenant_id = $1 AND $2::uuid IS NOT NULL AND s.id = $3 AND p.id = $4`,',
    also: [{
      file: 'src/stuckStays.js',
      from: '       JOIN entry_pictures p ON p.tenant_id = s.tenant_id AND p.garage_id = s.garage_id AND p.event_id = s.open_event_id',
      to: '       JOIN entry_pictures p ON p.tenant_id = s.tenant_id AND p.event_id = s.open_event_id',
    }],
  },
  {
    name: 'ended_owes_nothing',
    why: 'a stay that ended owes nothing',
    file: 'src/app.js',
    from: "        const owed = ask.outcome === 'ended' ? await owedForEnded(",
    to: "        const owed = false ? await owedForEnded(",
  },
  {
    name: 'abandoned_owes',
    why: 'an abandoned stay is priced too',
    file: 'src/app.js',
    from: "        const owed = ask.outcome === 'ended' ? await owedForEnded(",
    to: '        const owed = true ? await owedForEnded(',
  },
  {
    name: 'owed_at_now',
    why: 'an ended stay is priced to now, not to when the car left',
    file: 'src/app.js',
    from: '    tenantId, garage, laneId: null, exitLaneIds: rows.map((r) => r.id), session: stay, vehicle, exitAt: leftAt,',
    to: '    tenantId, garage, laneId: null, exitLaneIds: rows.map((r) => r.id), session: stay, vehicle, exitAt: leftAt && new Date(),',
  },
  {
    name: 'past_owed_missing',
    why: 'the past stays do not say what an ended stay owes',
    file: 'src/pastStays.js',
    from: '    owed_minor: row.owed_minor === null || row.owed_minor === undefined ? null : Number(row.owed_minor),',
    to: '    owed_minor: null,',
  },
  {
    name: 'reason_any_characters',
    why: 'a reason may carry line breaks and control characters',
    file: 'src/stuckStays.js',
    from: '  if (CONTROL.test(reason)) {',
    to: '  if (false) {',
  },
  {
    name: 'line_before_thin',
    why: 'the change-log line does not say what the stay was',
    file: 'src/app.js',
    from: '          before: { open: true, entered_at: stay.entry_at, exit_at: null },',
    to: '          before: { open: true },',
  },
  {
    name: 'line_owed_missing',
    why: 'the change-log line does not say what the stay owes',
    file: 'src/app.js',
    from: '            owed_minor: owedMinor, currency: row.currency,',
    to: '            currency: row.currency,',
  },
  {
    name: 'line_names_plate',
    why: "the change-log line names the car's plate",
    file: 'src/app.js',
    from: '          after: {\n            open: false, outcome: ask.outcome,',
    to: '          after: {\n            plate: (await exits.vehicleOf(client, req.tenantId, stay.vehicle_id))?.plate ?? null,\n            open: false, outcome: ask.outcome,',
  },
  {
    name: 'event_owed_missing',
    why: "the stay's event does not say what it owes",
    file: 'src/app.js',
    from: 'exit_at: row.exit_at, owed_minor: owedMinor },',
    to: 'exit_at: row.exit_at },',
  },
  {
    name: 'pass_never_asked',
    why: 'a pass holder a person ended is priced with no lane to ask the pass at',
    file: 'src/app.js',
    from: '    tenantId, garage, laneId: null, exitLaneIds: rows.map((r) => r.id), session: stay,',
    to: '    tenantId, garage, laneId: null, exitLaneIds: [], session: stay,',
  },
  {
    name: 'pass_first_lane_only',
    why: "the pass is asked at the garage's first exit lane only",
    file: 'src/entitlement.js',
    from: '      for (const lane of lanes) {',
    to: '      for (const lane of lanes.slice(0, 1)) {',
  },
  {
    name: 'pass_unasked_unsaid',
    why: 'a pass not asked for want of an exit lane is not said',
    file: 'src/entitlement.js',
    from: "        record[module] = { consulted: false, unasked: true, reason: 'no exit lane to ask at",
    to: "        record[module] = { consulted: false, reason: 'no exit lane to ask at",
  },
  {
    name: 'pass_unasked_not_answered',
    why: "the end's answer does not say the pass was not asked",
    file: 'src/stuckStays.js',
    from: '    pass_unasked: owed ? owed.pass_unasked === true : null,',
    to: '    pass_unasked: owed ? false : null,',
  },
  {
    name: 'past_pass_unasked_missing',
    why: 'the past stays do not say the pass was not asked',
    file: 'src/pastStays.js',
    from: '    pass_unasked: row.pass_unasked ?? null,',
    to: '    pass_unasked: null,',
  },
  {
    name: 'owed_record_dropped',
    why: 'what the modules said is not kept on what an ended stay owes',
    file: 'src/stuckStays.js',
    from: '    entitlement: quote.entitlement ?? null,',
    to: '',
  },
  {
    name: 'ended_pass_always_covers',
    why: 'a pass asked at the exit lanes covers a car it does not cover',
    file: 'src/entitlement.js',
    from: "      if (atLanes.some((a) => a.covered)) coveredBy.push('garage_pass');",
    to: "      coveredBy.push('garage_pass');",
  },
  {
    name: 'owed_record_kept_forever',
    why: "what the modules said outlives the vehicle's retention window",
    file: 'src/retention.js',
    from: "        `UPDATE sessions SET ended = ended #- '{owed,entitlement}'",
    to: '        `UPDATE sessions SET ended = ended',
  },
];

const ADDED_0043 = '0043_stay_cleanup.sql';

const SCHEMA_BREAKS = [
  {
    name: 'owed_on_any_stay',
    why: 'a superseded or abandoned stay may owe',
    edits: [{ file: ADDED_0043, from: "      ended->>'reason' = 'ended'\n      AND jsonb_typeof", to: '      jsonb_typeof' }],
  },
  {
    name: 'owed_other_currency',
    why: 'a stay may owe in another currency',
    edits: [{ file: ADDED_0043, from: "      AND coalesce(ended->'owed'->>'currency', '') = currency\n", to: '' }],
  },
  {
    name: 'owed_fraction',
    why: 'a stay may owe a fraction of a minor unit',
    edits: [{ file: ADDED_0043, from: "              AND (ended->'owed'->>'fee_minor')::numeric = trunc((ended->'owed'->>'fee_minor')::numeric)\n", to: '' }],
  },
  {
    name: 'owed_covered_charged',
    why: 'a covered stay may owe money',
    edits: [{
      file: ADDED_0043,
      from: "              AND (ended->'owed'->>'outcome' <> 'covered' OR (ended->'owed'->>'fee_minor')::numeric = 0)\n",
      to: '',
    }],
  },
  {
    name: 'age_unbounded',
    why: "a garage's age may be 0 or over 2160 hours",
    edits: [{ file: ADDED_0043, from: '    CONSTRAINT garages_stuck_after_hours_check CHECK (stuck_after_hours BETWEEN 1 AND 2160);', to: ';' }],
  },
  {
    name: 'age_default_not_24',
    why: 'a garage that set nothing lists at another age',
    edits: [{ file: ADDED_0043, from: 'ADD COLUMN stuck_after_hours integer NOT NULL DEFAULT 24', to: 'ADD COLUMN stuck_after_hours integer NOT NULL DEFAULT 72' }],
  },
];

const SUITE = ['--test', 'test/stay-cleanup.test.js', 'test/stay-cleanup-passes.test.js', 'test/change-log.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-stay-cleanup-control-'));
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

/** A scratch database built from `migrations/` with one statement of 0043 edited. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-stay-cleanup-migrations-'));
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
  console.error(`\n${failures} control(s) failed. Do not trust the clean-up tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property the clean-up rests on.');
