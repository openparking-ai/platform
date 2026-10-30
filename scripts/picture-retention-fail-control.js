#!/usr/bin/env node
/**
 * The controls for picture retention (src/pictureRetention.js, 0041): every
 * property is broken below, one at a time, in a COPY of the tree, and
 * test/picture-retention.test.js is REQUIRED to go red -- in the test that
 * names the property. A pass is the failure; so is a red in some other test.
 *
 *   days_29                     the 30 days are 29, for lane and walk pictures alike
 *   days_31                     the 30 days are 31, for lane and walk pictures alike
 *   lane_day_30_kept            a lane picture is kept when exactly 30 days old
 *   walk_day_30_kept            a walk picture is kept when exactly 30 days old
 *   lane_calendar_days          a lane picture's days are calendar days in the database's zone
 *   walk_calendar_days          a walk picture's days are calendar days in the database's zone
 *   lane_open_stay_released     a stay still open loses its lane pictures with their 30 days
 *   walk_open_stay_released     a stay still open loses the walk pictures that saw it
 *   lane_left_car_released      a stay that left loses its lane pictures at once, not 30 days after
 *   walk_left_car_released      a stay that left loses its walk pictures at once, not 30 days after
 *   lane_exit_day_30_kept       a stay's lane pictures are kept on the 30th day after it left
 *   walk_exit_day_30_kept       a stay's walk pictures are kept on the 30th day after it left
 *   answered_picture_released   a picture a typed plate answered is not the stay's
 *   walk_held_by_any_stay       a walk picture is kept by a stay it did not see
 *   lane_paid_ignored           paid storage does not keep a stay's lane pictures
 *   walk_paid_ignored           paid storage does not keep a stay's walk pictures
 *   lane_paid_forever           a stay's lane pictures are kept after its paid time is over
 *   walk_paid_forever           a stay's walk pictures are kept after its paid time is over
 *   job_first_tenant_only       the job goes through the first tenant it is given only
 *   job_line_names_tenants      the job's line names the tenants
 *   walk_deleted_with_picture   the retention window deletes a walk whose picture a stay still keeps
 *   other_sightings_keep_plates a walk kept for one picture keeps the plates of sightings whose picture is gone
 *   list_plates_kept            a walk kept for one picture keeps every plate in its lists
 *   kept_stay_plate_blanked     the stay whose picture keeps the walk loses its plate in the lists
 *   young_sightings_blanked     a walk inside the window has its sightings' plates blanked
 *   young_lists_blanked         a walk inside the window has the plates in its lists blanked
 *
 * ONE TENANT AT A TIME has no source break: each pass runs under the
 * tenant's row security as the app role (NOBYPASSRLS), so no edit to the
 * job's SQL can reach another tenant's rows. The test holds it all the same.
 *
 * Needs the same environment as the suite (the rate engine, the database).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SUITE = 'test/picture-retention.test.js';

const DAYS = 'DAY 29, 30 AND 31';
const CLOCK = 'A DAY IS 24 HOURS';
const OPEN = 'AN OPEN STAY KEEPS ITS PICTURES';
const PAID = 'PAID STORAGE KEEPS THEM';
const TENANTS = 'TWO TENANTS';
const WAITS = 'A WALK WAITS FOR ITS PICTURES';
const PLATES = "A 400-DAY WALK KEPT FOR ONE CAR'S PICTURE";
const YOUNG = 'A WALK INSIDE THE WINDOW';
const BLANK_WHERE = "          AND (ws.plate IS NOT NULL OR ws.plate_pattern IS NOT NULL OR ws.readers <> walk_readers_blanked(ws.readers))\n";
const SIGHTING_WINDOW = '          AND COALESCE(w.finished_at, w.abandoned_at, w.started_at) < COALESCE($2::timestamptz, now()) - make_interval(days => $3)`,\n      [tenantId, now, days],\n    );\n    const { rowCount: listsBlanked }';
const LIST_WINDOW = "          WHERE w.tenant_id = $1 AND jsonb_typeof(w.lists) = 'object'\n            AND COALESCE(w.finished_at, w.abandoned_at, w.started_at) < COALESCE($2::timestamptz, now()) - make_interval(days => $3)\n";

const LANE_TAKEN = '        AND p.taken_at <= COALESCE($2::timestamptz, now()) - make_interval(hours => 24 * $3)\n';
const WALK_TAKEN = '        AND ws.taken_at <= COALESCE($2::timestamptz, now()) - make_interval(hours => 24 * $3)\n';
const OPEN_CLAUSE = '                 AND (s.exit_at IS NULL\n';
const EXIT_CLAUSE = '                      OR s.exit_at > COALESCE($2::timestamptz, now()) - make_interval(hours => 24 * $3)\n';
const PAID_CLAUSE = '                      OR s.pictures_paid_until > COALESCE($2::timestamptz, now())))`,';

const BREAKS = [
  {
    name: 'days_29',
    why: 'the 30 days are 29',
    red: [DAYS],
    edits: [{ file: 'src/bans.js', from: 'export const PICTURE_DAYS = 30;', to: 'export const PICTURE_DAYS = 29;' }],
  },
  {
    name: 'days_31',
    why: 'the 30 days are 31',
    red: [DAYS],
    edits: [{ file: 'src/bans.js', from: 'export const PICTURE_DAYS = 30;', to: 'export const PICTURE_DAYS = 31;' }],
  },
  {
    name: 'lane_day_30_kept',
    why: 'a lane picture is kept when exactly 30 days old',
    red: [DAYS],
    edits: [{ file: 'src/bans.js', from: LANE_TAKEN, to: LANE_TAKEN.replace('<=', '<') }],
  },
  {
    name: 'walk_day_30_kept',
    why: 'a walk picture is kept when exactly 30 days old',
    red: [DAYS],
    edits: [{ file: 'src/walks.js', from: WALK_TAKEN, to: WALK_TAKEN.replace('<=', '<') }],
  },
  {
    name: 'lane_calendar_days',
    why: "a lane picture's days are calendar days in the database's zone",
    red: [CLOCK],
    edits: [{ file: 'src/bans.js', from: LANE_TAKEN, to: LANE_TAKEN.replace('make_interval(hours => 24 * $3)', 'make_interval(days => $3)') }],
  },
  {
    name: 'walk_calendar_days',
    why: "a walk picture's days are calendar days in the database's zone",
    red: [CLOCK],
    edits: [{ file: 'src/walks.js', from: WALK_TAKEN, to: WALK_TAKEN.replace('make_interval(hours => 24 * $3)', 'make_interval(days => $3)') }],
  },
  {
    name: 'lane_open_stay_released',
    why: 'a stay still open loses its lane pictures with their 30 days',
    red: [OPEN],
    edits: [{ file: 'src/bans.js', from: OPEN_CLAUSE, to: '                 AND (false\n' }],
  },
  {
    name: 'walk_open_stay_released',
    why: 'a stay still open loses the walk pictures that saw it',
    red: [OPEN],
    edits: [{ file: 'src/walks.js', from: OPEN_CLAUSE, to: '                 AND (false\n' }],
  },
  {
    name: 'lane_left_car_released',
    why: 'a stay that left loses its lane pictures at once, not 30 days after',
    red: [OPEN],
    edits: [{ file: 'src/bans.js', from: EXIT_CLAUSE, to: '' }],
  },
  {
    name: 'walk_left_car_released',
    why: 'a stay that left loses its walk pictures at once, not 30 days after',
    red: [OPEN],
    edits: [{ file: 'src/walks.js', from: EXIT_CLAUSE, to: '' }],
  },
  {
    name: 'lane_exit_day_30_kept',
    why: "a stay's lane pictures are kept on the 30th day after it left",
    red: [OPEN],
    edits: [{ file: 'src/bans.js', from: EXIT_CLAUSE, to: EXIT_CLAUSE.replace('s.exit_at >', 's.exit_at >=') }],
  },
  {
    name: 'walk_exit_day_30_kept',
    why: "a stay's walk pictures are kept on the 30th day after it left",
    red: [OPEN],
    edits: [{ file: 'src/walks.js', from: EXIT_CLAUSE, to: EXIT_CLAUSE.replace('s.exit_at >', 's.exit_at >=') }],
  },
  {
    name: 'answered_picture_released',
    why: 'a picture a typed plate answered is not the stay\'s',
    red: [OPEN],
    edits: [{
      file: 'src/walks.js',
      from: "                      OR EXISTS (SELECT 1 FROM walk_sightings a\n                                  WHERE a.tenant_id = ws.tenant_id AND a.walk_id = ws.walk_id AND a.confirms = ws.id\n                                    AND e.row->'sightings' ? a.id::text))\n",
      to: '                      OR false)\n',
    }],
  },
  {
    name: 'walk_held_by_any_stay',
    why: 'a walk picture is kept by a stay it did not see',
    red: [OPEN],
    edits: [{ file: 'src/walks.js', from: "                 AND (e.row->'sightings' ? ws.id::text\n", to: "                 AND (true\n" }],
  },
  {
    name: 'lane_paid_ignored',
    why: "paid storage does not keep a stay's lane pictures",
    red: [PAID],
    edits: [{ file: 'src/bans.js', from: EXIT_CLAUSE + PAID_CLAUSE, to: EXIT_CLAUSE.trimEnd() + '))`,' }],
  },
  {
    name: 'walk_paid_ignored',
    why: "paid storage does not keep a stay's walk pictures",
    red: [PAID],
    edits: [{ file: 'src/walks.js', from: EXIT_CLAUSE + PAID_CLAUSE, to: EXIT_CLAUSE.trimEnd() + '))`,' }],
  },
  {
    name: 'lane_paid_forever',
    why: "a stay's lane pictures are kept after its paid time is over",
    red: [PAID],
    edits: [{ file: 'src/bans.js', from: PAID_CLAUSE, to: '                      OR s.pictures_paid_until IS NOT NULL))`,' }],
  },
  {
    name: 'walk_paid_forever',
    why: "a stay's walk pictures are kept after its paid time is over",
    red: [PAID],
    edits: [{ file: 'src/walks.js', from: PAID_CLAUSE, to: '                      OR s.pictures_paid_until IS NOT NULL))`,' }],
  },
  {
    name: 'job_first_tenant_only',
    why: 'the job goes through the first tenant it is given only',
    red: [TENANTS],
    edits: [{ file: 'src/pictureRetention.js', from: '  for (const tenantId of tenantIds) {', to: '  for (const tenantId of tenantIds.slice(0, 1)) {' }],
  },
  {
    name: 'job_line_names_tenants',
    why: "the job's line names the tenants",
    red: [TENANTS],
    edits: [
      { file: 'src/pictureRetention.js', from: '  const total = { tenants: 0, lane: 0, walk: 0 };', to: '  const total = { tenants: 0, lane: 0, walk: 0, ids: tenantIds.map((t) => t.slice(0, 8)) };' },
      { file: 'src/pictureRetention.js', from: 'walk picture(s).`;', to: 'walk picture(s) ${total.ids}.`;' },
    ],
  },
  {
    name: 'walk_deleted_with_picture',
    why: 'the retention window deletes a walk whose picture a stay still keeps',
    red: [WAITS],
    edits: [{
      file: 'src/retention.js',
      from: '          AND NOT EXISTS (\n                SELECT 1 FROM walk_sightings ws\n                 WHERE ws.tenant_id = w.tenant_id AND ws.walk_id = w.id AND ws.picture IS NOT NULL)`,',
      to: '`,',
    }],
  },
  {
    name: 'other_sightings_keep_plates',
    why: 'a walk kept for one picture keeps the plates of sightings whose picture is gone',
    red: [PLATES],
    edits: [{ file: 'src/retention.js', from: '          AND ws.picture IS NULL AND ws.plate_blanked_at IS NULL\n', to: '          AND false\n' }],
  },
  {
    name: 'list_plates_kept',
    why: 'a walk kept for one picture keeps every plate in its lists',
    red: [PLATES],
    edits: [{
      file: 'src/retention.js',
      from: '        WHERE w.tenant_id = $1 AND w.id = d.id AND w.lists IS DISTINCT FROM walk_lists_blanked(d.lists, d.keep)`,',
      to: '        WHERE false`,',
    }],
  },
  {
    name: 'kept_stay_plate_blanked',
    why: 'the stay whose picture keeps the walk loses its plate in the lists',
    red: [PLATES],
    edits: [{
      file: 'src/retention.js',
      from: '       UPDATE walks w SET lists = walk_lists_blanked(d.lists, d.keep)',
      to: "       UPDATE walks w SET lists = walk_lists_blanked(d.lists, '{}'::uuid[])",
    }],
  },
  {
    name: 'young_sightings_blanked',
    why: 'a walk inside the window has its sightings\' plates blanked',
    red: [YOUNG],
    edits: [{ file: 'src/retention.js', from: BLANK_WHERE + SIGHTING_WINDOW, to: BLANK_WHERE.trimEnd() + '`,\n      [tenantId, now, days],\n    );\n    const { rowCount: listsBlanked }' }],
  },
  {
    name: 'young_lists_blanked',
    why: 'a walk inside the window has the plates in its lists blanked',
    red: [YOUNG],
    edits: [{ file: 'src/retention.js', from: LIST_WINDOW, to: "          WHERE w.tenant_id = $1 AND jsonb_typeof(w.lists) = 'object'\n" }],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-pictures-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

const run = (dir, suite) =>
  // The spec reporter, named: Node's default without a terminal is TAP on some
  // versions, and the red test's name is read from the spec lines.
  spawnSync(process.execPath, ['--test', '--test-reporter=spec', suite], { cwd: dir, env: process.env, stdio: 'pipe', encoding: 'utf8' });

const redTests = (result) => [...new Set([...result.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))];

function summarise(result) {
  const line = (label) => result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'))?.[1] ?? '?';
  return `${line('pass')} passed, ${line('fail')} failed`;
}

/** Every edit's anchor exactly once, or nothing is planted. */
function plant(base, edits) {
  const texts = new Map();
  for (const e of edits) {
    const path = join(base, e.file);
    const source = texts.get(path) ?? readFileSync(path, 'utf8');
    if (source.split(e.from).length !== 2) return e.file;
    texts.set(path, source.replace(e.from, () => e.to));
  }
  for (const [path, text] of texts) writeFileSync(path, text);
  return null;
}

let failures = 0;

console.log('== control A: the suite must PASS intact ==');
{
  const dir = stage();
  try {
    const intact = run(dir, SUITE);
    if (intact.status === 0) console.log(`  ${SUITE.padEnd(32)} OK — ${summarise(intact)}`);
    else {
      console.error(`  CONTROL A FAILED — ${SUITE} does not pass intact: ${summarise(intact)}\n${intact.stdout}\n${intact.stderr}`);
      failures += 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function judge(brk, broken) {
  const red = redTests(broken);
  const named = brk.red.every((want) => red.some((t) => t.includes(want)));
  if (broken.status === 0) {
    console.error(`  ${brk.name.padEnd(28)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
    failures += 1;
  } else if (!named) {
    console.error(`  ${brk.name.padEnd(28)} *** RED, BUT NOT IN "${brk.red.join('", "')}" — red: ${red.join(' | ')} ***`);
    failures += 1;
  } else {
    console.log(`  ${brk.name.padEnd(28)} fails as required when ${brk.why} — ${summarise(broken)}; named: ${brk.red.join(', ')}`);
  }
}

console.log('\n== control B: each break must make the suite FAIL, in the test that names it ==');
for (const brk of BREAKS) {
  const dir = stage();
  try {
    const missing = plant(dir, brk.edits);
    if (missing) {
      console.error(`  ${brk.name.padEnd(28)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing} ***`);
      failures += 1;
      continue;
    }
    judge(brk, run(dir, SUITE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust the picture-retention tests.`);
  process.exit(1);
}
console.log(`\nall controls OK — the suite fails, by name, on every one of the ${BREAKS.length} properties picture retention rests on.`);
