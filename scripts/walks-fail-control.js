#!/usr/bin/env node
/**
 * The control for the inventory walk (0040).
 *
 * Every property below is broken, one at a time, and `test/walks.test.js`
 * with `test/change-log.test.js` is REQUIRED to go red -- with at least one
 * test still green, so a break that stops the files running is not mistaken
 * for one the tests caught. A pass is the failure.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 * Each anchor must occur exactly once in its file.
 *
 *   too_many_walks              more than WALK_OPEN_MAX walks are open at once
 *   walk_any_garage             a walk is reached through another garage of its tenant
 *   typed_unconfirmed           a typed plate is kept without the person confirming it
 *   typed_unfolded              a typed plate is matched as typed, not folded as the rule folds
 *   picture_not_fresh           a picture goes to the reader with what was written into it
 *   picture_unchecked           a picture that does not open is taken
 *   big_picture_refused         a phone picture over 1 MB is refused before its route
 *   reader_unnamed              a read does not say which reader read it
 *   reader_down_kept            a reader that did not answer is not answered 503
 *   reader_off_unsaid           a picture with no reader set up is not kept for the person to type
 *   read_again_on_resend        a sighting sent again is read again
 *   client_ref_forgotten        a sighting sent again is kept twice
 *   candidates_dropped          a plate that fits several stays shows none to pick from
 *   zero_agreement_candidate    a stay that agrees in no sure character is a candidate
 *   pick_any_stay               a stay that is not a candidate is picked
 *   pick_ignored                the stay a person picked is not what the finish lists
 *   answered_still_listed       a sighting a later one answered stays in the lists
 *   answered_twice              a sighting is answered twice
 *   unreadable_not_listed       a picture with nothing sure is not listed as not readable
 *   seen_twice_loses_one        a car seen twice keeps only its last sighting
 *   late_stay_not_seen          a stay that came in during the walk is "not seen"
 *   left_stay_not_seen          a stay that left during the walk is "not seen"
 *   finished_reworked           a finished walk is worked out again
 *   sighting_on_finished        a finished walk takes sightings
 *   stuck_ignores_walks         the stuck list does not list the stays the latest walk missed
 *   stuck_any_walk              the stuck list reads the first walk, not the latest
 *   last_seen_missing           the stuck list does not say when a walk last saw a stay
 *   walks_kept_forever          a walk past the retention window is kept
 *   open_walk_kept_forever      a walk never finished is kept past the window
 *   walk_line_names_plate       the change-log line about a sighting names its plate
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * statement of 0040 edited, so the property genuinely never existed there.
 *
 *   walk_garage_unchecked       a walk may be at another account's garage
 *   candidates_unchecked        a sighting's candidates may be stays elsewhere
 *   confirms_unchecked          a sighting may answer one of another walk
 *   walk_stays_unchecked        a walk may list a stay elsewhere
 *   walk_subject_refused        the change log does not take a walk as its subject
 *   walk_line_may_name          a line about a walk may carry a name
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
const SCRATCH = process.env.WALKS_SCRATCH_DB || 'openparking_walks_control';

const SOURCE_BREAKS = [
  {
    name: 'too_many_walks',
    why: "more than WALK_OPEN_MAX walks are open at once",
    file: 'src/app.js',
    from: "        if (await walks.openWalks(client, req.tenantId, garage.id) >= walks.WALK_OPEN_MAX) {",
    to: "        if (false) {",
  },
  {
    name: 'walk_any_garage',
    why: "a walk is reached through another garage of its tenant",
    file: 'src/walks.js',
    from: "    `SELECT * FROM walks WHERE tenant_id = $1 AND garage_id = $2 AND id = $3${lock ? ' FOR UPDATE' : ''}`,",
    to: "    `SELECT * FROM walks WHERE tenant_id = $1 AND $2::uuid IS NOT NULL AND id = $3${lock ? ' FOR UPDATE' : ''}`,",
  },
  {
    name: 'typed_unconfirmed',
    why: "a typed plate is kept without the person confirming it",
    file: 'src/walks.js',
    from: "  if (plate !== null && body?.confirmed !== true) {",
    to: "  if (false) {",
  },
  {
    name: 'typed_unfolded',
    why: "a typed plate is matched as typed, not folded as the rule folds",
    file: 'src/walks.js',
    from: "    characters: { state: 'read', rule: exitMatch.PLATE_RULE, pattern: exitMatch.fold(plate) },",
    to: "    characters: { state: 'read', rule: exitMatch.PLATE_RULE, pattern: plate },",
  },
  {
    name: 'picture_not_fresh',
    why: "a picture goes to the reader with what was written into it",
    file: 'src/app.js',
    from: "        image = type ? await bans.freshPicture(bytes, type) : null;",
    to: "        image = type ? bytes : null;",
  },
  {
    name: 'picture_unchecked',
    why: "a picture that does not open is taken",
    file: 'src/app.js',
    from: "        if (!image || image.length > bans.PICTURE_MAX_BYTES) {",
    to: "        if (false) {",
  },
  {
    name: 'big_picture_refused',
    why: "a phone picture over 1 MB is refused before its route",
    file: 'src/app.js',
    from: "  app.use((req, res, next) => (req.path === '/api/v1/lane/pictures' || WALK_SIGHTING.test(req.path) ? next() : json(",
    to: "  app.use((req, res, next) => (req.path === '/api/v1/lane/pictures' ? next() : json(",
  },
  {
    name: 'reader_unnamed',
    why: "a read does not say which reader read it",
    file: 'src/walks.js',
    from: "      readers: [{ reader: READER, plate, confidence }],",
    to: "      readers: [],",
  },
  {
    name: 'reader_down_kept',
    why: "a reader that did not answer is not answered 503",
    file: 'src/app.js',
    from: "          if (!answer.ok) {",
    to: "          if (false) {",
  },
  {
    name: 'reader_off_unsaid',
    why: "a picture with no reader set up is not kept for the person to type",
    file: 'src/app.js',
    from: "          read = walks.READER_OFF;",
    to: "          throw new Error('no reader');",
  },
  {
    name: 'read_again_on_resend',
    why: "a sighting sent again is read again",
    file: 'src/app.js',
    from: "        if (!replay && walk.finished_at) throw walkFinished();\n        return replay;",
    to: "        if (!replay && walk.finished_at) throw walkFinished();\n        return null;",
  },
  {
    name: 'client_ref_forgotten',
    why: "a sighting sent again is kept twice",
    file: 'src/walks.js',
    from: "    `SELECT ${SIGHTING_COLUMNS} FROM walk_sightings WHERE tenant_id = $1 AND walk_id = $2 AND client_ref = $3`,",
    to: "    `SELECT ${SIGHTING_COLUMNS} FROM walk_sightings WHERE tenant_id = $1 AND walk_id = $2 AND client_ref = $3 AND false`,",
  },
  {
    name: 'candidates_dropped',
    why: "a plate that fits several stays shows none to pick from",
    file: 'src/app.js',
    from: "          ...read, clientRef: ask.clientRef, confirms: ask.confirms, takenAt, candidates: found.candidates ?? [],",
    to: "          ...read, clientRef: ask.clientRef, confirms: ask.confirms, takenAt, candidates: [],",
  },
  {
    name: 'zero_agreement_candidate',
    why: "a stay that agrees in no sure character is a candidate",
    file: 'src/walks.js',
    from: "    return !scored.excluded && scored.agree > 0;",
    to: "    return !scored.excluded;",
  },
  {
    name: 'pick_any_stay',
    why: "a stay that is not a candidate is picked",
    file: 'src/app.js',
    from: "        if (typeof stayId !== 'string' || !found.candidates.includes(stayId)) {",
    to: "        if (typeof stayId !== 'string') {",
  },
  {
    name: 'pick_ignored',
    why: "the stay a person picked is not what the finish lists",
    file: 'src/walks.js',
    from: "    if (!stay && found.candidates && s.picked_stay && found.candidates.includes(s.picked_stay)) stay = s.picked_stay;",
    to: "    if (false) stay = s.picked_stay;",
  },
  {
    name: 'answered_still_listed',
    why: "a sighting a later one answered stays in the lists",
    file: 'src/walks.js',
    from: "  const answered = new Set(sightings.filter((s) => s.confirms).map((s) => s.confirms));",
    to: "  const answered = new Set();",
  },
  {
    name: 'answered_twice',
    why: "a sighting is answered twice",
    file: 'src/app.js',
    from: "          if (await walks.answered(client, req.tenantId, earlier.id)) {",
    to: "          if (false) {",
  },
  {
    name: 'unreadable_not_listed',
    why: "a picture with nothing sure is not listed as not readable",
    file: 'src/walks.js',
    from: "    if (s.read === 'none') {\n      notReadable.push",
    to: "    if (false) {\n      notReadable.push",
  },
  {
    name: 'seen_twice_loses_one',
    why: "a car seen twice keeps only its last sighting",
    file: 'src/walks.js',
    from: "      const row = seen.get(stay) ?? { stay,",
    to: "      const row = { stay,",
  },
  {
    name: 'late_stay_not_seen',
    why: "a stay that came in during the walk is \"not seen\"",
    file: 'src/walks.js',
    from: "    .filter((s) => s.exit_at === null && new Date(s.entry_at) <= startedAt && !seen.has(s.id))",
    to: "    .filter((s) => s.exit_at === null && !seen.has(s.id))",
  },
  {
    name: 'left_stay_not_seen',
    why: "a stay that left during the walk is \"not seen\"",
    file: 'src/walks.js',
    from: "    .filter((s) => s.exit_at === null && new Date(s.entry_at) <= startedAt && !seen.has(s.id))",
    to: "    .filter((s) => new Date(s.entry_at) <= startedAt && !seen.has(s.id))",
  },
  {
    name: 'finished_reworked',
    why: "a finished walk is worked out again",
    file: 'src/app.js',
    from: "        if (open.finished_at) {",
    to: "        if (false) {",
  },
  {
    name: 'sighting_on_finished',
    why: "a finished walk takes sightings",
    file: 'src/app.js',
    from: "        if (!replay && walk.finished_at) throw walkFinished();",
    to: "        if (false) throw walkFinished();",
    also: [{ file: "src/app.js", from: "        if (walk.finished_at) throw walkFinished();\n        if (await walks.sightingCount", to: "        if (false) throw walkFinished();\n        if (await walks.sightingCount" }],
  },
  {
    name: 'stuck_ignores_walks',
    why: "the stuck list does not list the stays the latest walk missed",
    file: 'src/app.js',
    from: "        const unseen = await stuck.openStaysAmong(client, req.tenantId, req.params.garageId, [...facts.notSeenLast],",
    to: "        const unseen = await stuck.openStaysAmong(client, req.tenantId, req.params.garageId, [],",
  },
  {
    name: 'stuck_any_walk',
    why: "the stuck list reads the first walk, not the latest",
    file: 'src/walks.js',
    from: "         ORDER BY w.finished_at DESC, w.id LIMIT 1)`,",
    to: "         ORDER BY w.finished_at, w.id LIMIT 1)`,",
  },
  {
    name: 'last_seen_missing',
    why: "the stuck list does not say when a walk last saw a stay",
    file: 'src/stuckStays.js',
    from: "    last_seen_on_walk: walks.lastSeen.get(r.id) ?? null,",
    to: "    last_seen_on_walk: null,",
  },
  {
    name: 'walks_kept_forever',
    why: "a walk past the retention window is kept",
    file: 'src/retention.js',
    from: "      `DELETE FROM walks\n        WHERE tenant_id = $1",
    to: "      `DELETE FROM walks\n        WHERE false AND tenant_id = $1",
  },
  {
    name: 'open_walk_kept_forever',
    why: "a walk never finished is kept past the window",
    file: 'src/retention.js',
    from: "          AND COALESCE(finished_at, started_at) < COALESCE($2::timestamptz, now()) - make_interval(days => $3)`,",
    to: "          AND finished_at < COALESCE($2::timestamptz, now()) - make_interval(days => $3)`,",
  },
  {
    name: 'walk_line_names_plate',
    why: "the change-log line about a sighting names its plate",
    file: 'src/app.js',
    from: "          before: null, after: { sighting: row.id, read: row.read, confirms: row.confirms },",
    to: "          before: null, after: { sighting: row.id, read: row.read, confirms: row.confirms, plate: row.plate },",
  },
];

const ADDED_0040 = '0040_inventory_walks.sql';

const SCHEMA_BREAKS = [
  {
    name: 'walk_garage_unchecked',
    why: "a walk may be at another account's garage",
    edits: [{ file: ADDED_0040, from: "    IF NOT EXISTS (SELECT 1 FROM garages g WHERE g.id = NEW.garage_id AND g.tenant_id = NEW.tenant_id) THEN", to: "    IF false THEN" }],
  },
  {
    name: 'candidates_unchecked',
    why: "a sighting's candidates may be stays elsewhere",
    edits: [{ file: ADDED_0040, from: "       WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = c.id AND s.tenant_id = NEW.tenant_id AND s.garage_id = walk_garage)", to: "       WHERE false" }],
  },
  {
    name: 'confirms_unchecked',
    why: "a sighting may answer one of another walk",
    edits: [{ file: ADDED_0040, from: "    IF NEW.confirms IS NOT NULL AND NOT EXISTS (", to: "    IF false AND NOT EXISTS (" }],
  },
  {
    name: 'walk_stays_unchecked',
    why: "a walk may list a stay elsewhere",
    edits: [{ file: ADDED_0040, from: "    IF NOT EXISTS (\n      SELECT 1 FROM walks w JOIN sessions s", to: "    IF false AND NOT EXISTS (\n      SELECT 1 FROM walks w JOIN sessions s" }],
  },
  {
    name: 'walk_subject_refused',
    why: "the change log does not take a walk as its subject",
    edits: [{ file: ADDED_0040, from: "'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'exit', 'stay', 'walk',", to: "'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'exit', 'stay'," }],
  },
  {
    name: 'walk_line_may_name',
    why: "a line about a walk may carry a name",
    edits: [{ file: ADDED_0040, from: "  CHECK (subject_kind <> 'walk' OR subject_name IS NULL);", to: "  CHECK (true);" }],
  },
];

const SUITE = ['--test', 'test/walks.test.js', 'test/change-log.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-walks-control-'));
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

/** A scratch database built from `migrations/` with one statement of 0040 edited. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-walks-migrations-'));
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
  console.error(`\n${failures} control(s) failed. Do not trust the walk tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property the walk rests on.');
