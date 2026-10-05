#!/usr/bin/env node
/**
 * The controls for U4: the setup checklist, lane setup and closing, and the
 * change log. Every property is broken below, one at a time, in a COPY of the
 * tree, and the suite that measures it is REQUIRED to go red -- and to go red
 * in the test that names the property. A pass is the failure; so is a red in
 * some other test.
 *
 * Source breaks:
 *   step_lanes_one_way        the checklist calls one way in OR out enough
 *   step_quiet_ignored        a lane computer counts however long it was unheard
 *   garage_from_body          a lane is added to the garage the body names
 *   stay_check_dropped        a lane with a stay can be removed
 *   last_lane_unchecked       the last open lane of a direction closes without the override
 *   line_outside_transaction  the line is written on its own transaction
 *   line_never_counted        a write may commit without its line
 *   refusal_unrecorded        a refused write writes no line
 *   key_in_line               a lane computer's code is put in its line
 *   guard_off_key_in_line     the guard is switched off and the code put in the line
 *   quiet_minutes_fixed       the quiet setting is a number in the code, not the declared one
 *   drivers_unanswerable      the drivers answer can be taken back to unanswered
 *   unchanged_lines_written   a request that changes nothing writes a line anyway
 *   refused_read_mixed        refused attempts are read with the changes, and can push them off a page
 *   not_found_unnamed         a "not found" refusal does not say what was not found
 *   lanes_locked_target_first a closing locks its own lane before the rest: two closings deadlock
 *   connect_lane_unheld       connecting a computer does not hold its lane against a removal
 *
 * Schema breaks (the copy's migrations edited; a scratch database built from
 * them):
 *   update_granted            the application may UPDATE and DELETE the log
 *   trigger_dropped           nothing stops the owner of the table rewriting it
 *   refusals_unbounded        one source may write any number of refused lines a minute (0028)
 *   unsigned_to_owner_log     a refused attempt with no working sign-in or key lands in the garage's log (0028)
 *   key_unnamed               a key's refused line does not name the key (0028)
 *   own_key_to_security       this account's cancelled key or ended sign-in goes to the security log, not its own log (0028)
 *
 * Needs the same environment as the suite (the rate engine, a Postgres it may
 * make a scratch database on).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = 'openparking_setup_control';

const SETUP = 'test/setup.test.js';
const LANES = 'test/lane-setup.test.js';
const LOG = 'test/change-log.test.js';
const FLOOD = 'test/refusal-flood.test.js';
const RACES = 'test/races.test.js';

const SOURCE_BREAKS = [
  {
    name: 'step_lanes_one_way',
    why: 'the checklist calls one way in or out enough',
    suite: SETUP,
    red: ['lanes: done with a way in and a way out'],
    edits: [{ file: 'src/setup.js', from: 'done: entry.length > 0 && exit.length > 0,', to: 'done: entry.length > 0 || exit.length > 0,' }],
  },
  {
    name: 'step_quiet_ignored',
    why: 'a lane computer counts however long it was unheard',
    suite: SETUP,
    red: ['lane_computers: done when every lane has a computer'],
    edits: [{ file: 'src/setup.js', from: "state: now - latest < quiet * 60_000 ? 'working' : 'quiet',", to: "state: 'working',"}],
  },
  {
    name: 'garage_from_body',
    why: 'a lane is added to the garage the body names',
    suite: LANES,
    red: ['ids come from the session and the path'],
    edits: [
      {
        file: 'src/app.js',
        from: "        if (!(await repo.getGarage(client, req.tenantId, req.params.garageId))) throw new HttpError(404, 'garage not found');\n        const { rows } = await client.query(\n          `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING *`,\n          [req.tenantId, req.params.garageId, name, direction],",
        to: "        if (!(await repo.getGarage(client, req.tenantId, req.params.garageId))) throw new HttpError(404, 'garage not found');\n        const { rows } = await client.query(\n          `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING *`,\n          [req.tenantId, req.body.garage_id ?? req.params.garageId, name, direction],",
      },
    ],
  },
  {
    name: 'stay_check_dropped',
    why: 'a lane with a stay can be removed',
    suite: LANES,
    red: ['remove: a lane that was never used goes'],
    edits: [{ file: 'src/lanes.js', from: '`SELECT (SELECT count(*) FROM sessions WHERE tenant_id = $1 AND (entry_lane_id = $2 OR exit_lane_id = $2))::int AS stays,', to: '`SELECT 0 AS stays,' }],
  },
  {
    name: 'last_lane_unchecked',
    why: 'the last open lane of a direction closes without the override',
    suite: LANES,
    red: ['the last open lane of a direction'],
    edits: [{ file: 'src/lanes.js', from: 'if (lane.closed_reason === null && openOthers.length === 0 && body.override !== true) {', to: 'if (false) {' }],
  },
  {
    name: 'line_outside_transaction',
    why: 'the line is written on its own transaction',
    suite: LOG,
    red: ['A LINE IS PART OF ITS CHANGE'],
    edits: [
      { file: 'src/changes.js', from: '  await internals.insert(client, [\n    ctx.tenantId,', to: '  await withTenant(ctx.tenantId, (own) => internals.insert(own, [\n    ctx.tenantId,' },
      { file: 'src/changes.js', from: '  ]);\n  ctx.count += 1;', to: '  ]));\n  ctx.count += 1;' },
      { file: 'src/changes.js', from: "import { pool } from './db.js';", to: "import { pool, withTenant } from './db.js';" },
    ],
  },
  {
    name: 'line_never_counted',
    why: 'a write may commit without its line',
    suite: LOG,
    red: ['EVERY WRITE'],
    edits: [
      { file: 'src/app.js', from: "        await changes.record(client, req.change, {\n          garageId: rows[0].garage_id, action: 'lane.add',", to: "        if (false) await changes.record(client, req.change, {\n          garageId: rows[0].garage_id, action: 'lane.add'," },
      { file: 'src/app.js', from: '      if (lines !== 1 && !(lines === 0 && req.change.unchanged)) {', to: '      if (false) {' },
    ],
  },
  {
    name: 'refusal_unrecorded',
    why: 'a refused write writes no line',
    suite: LOG,
    red: ['REFUSED ATTEMPTS land in the right log'],
    edits: [{ file: 'src/app.js', from: "    if (!SAFE_METHODS.has(req.method) && status >= 400 && status < 500 && !err?.malformedId) {", to: '    if (false) {' }],
  },
  {
    name: 'key_in_line',
    why: "a lane computer's code is put in its line",
    suite: LOG,
    red: ['EVERY WRITE'],
    edits: [{ file: 'src/app.js', from: 'before: null, after: { name: rows[0].name, lane: lane.rows[0].name },', to: 'before: null, after: { name: rows[0].name, lane: lane.rows[0].name, code: token },' }],
  },
  {
    name: 'guard_off_key_in_line',
    why: 'the guard is switched off and the code put in the line',
    suite: LOG,
    // On a scratch database: the log is append-only, so the code this plant
    // writes into a line would stay in the suite's own database for good.
    scratch: true,
    red: ['NO SECRET IN THE LOG OR THE OUTPUT'],
    edits: [
      { file: 'src/app.js', from: 'before: null, after: { name: rows[0].name, lane: lane.rows[0].name },', to: 'before: null, after: { name: rows[0].name, lane: lane.rows[0].name, code: token },' },
      { file: 'src/changes.js', from: '  assertNoCredential({ action, subject, before, after }, ctx.secrets);', to: '' },
    ],
  },
  {
    name: 'quiet_minutes_fixed',
    why: 'the quiet setting is a number in the code, not the declared setting',
    suite: SETUP,
    red: ['ONE SETTING'],
    edits: [{ file: 'src/setup.js', from: "export const quietMinutes = () => startSetting('LANE_QUIET_MINUTES');", to: 'export const quietMinutes = () => 5;' }],
  },
  {
    name: 'drivers_unanswerable',
    why: 'the drivers answer can be taken back to unanswered',
    suite: LANES,
    red: ['the drivers answer'],
    edits: [{ file: 'src/activation.js', from: '  if (raw !== true && raw !== false) {', to: '  if (raw !== true && raw !== false && raw !== null) {' }],
  },
  {
    name: 'unchanged_lines_written',
    why: 'a request that changes nothing writes a line anyway',
    suite: LOG,
    red: ['NOTHING CHANGED, NO LINE'],
    edits: [{ file: 'src/changes.js', from: 'export const nothingChanged = (before, after) => before !== null && after !== null && canonical(before) === canonical(after);', to: 'export const nothingChanged = () => false;' }],
  },
  {
    name: 'refused_read_mixed',
    why: 'refused attempts are read with the changes',
    suite: LOG,
    red: ['THE READ'],
    edits: [{ file: 'src/changes.js', from: "      WHERE tenant_id = $1 AND (garage_id = $2 OR garage_id IS NULL) AND outcome = $4 ${older}", to: "      WHERE tenant_id = $1 AND (garage_id = $2 OR garage_id IS NULL) AND $4::text IS NOT NULL ${older}" }],
  },
  {
    name: 'not_found_unnamed',
    why: 'a "not found" refusal does not say what was not found',
    suite: LOG,
    red: ['REFUSED ATTEMPTS land in the right log'],
    edits: [{ file: 'src/changes.js', from: '  if (status === 404 && target?.kind) return `${target.kind}_not_found`;', to: '' }],
  },
  {
    name: 'lanes_locked_target_first',
    why: 'a closing locks its own lane before the rest',
    suite: RACES,
    red: ['the last two ways out closed at once'],
    edits: [{ file: 'src/lanes.js', from: "  const { rows: found } = await client.query('SELECT garage_id FROM lanes WHERE tenant_id = $1 AND id = $2', [tenantId, laneId]);", to: "  const { rows: found } = await client.query('SELECT garage_id FROM lanes WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, laneId]);" }],
  },
  {
    name: 'connect_lane_unheld',
    why: 'connecting a computer does not hold its lane against a removal',
    suite: RACES,
    red: ['a lane removed while a computer is connected'],
    edits: [{ file: 'src/app.js', from: "WHERE tenant_id = $1 AND id = $2 FOR KEY SHARE'", to: "WHERE tenant_id = $1 AND id = $2'" }],
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'refusals_unbounded',
    why: 'one source may write any number of refused lines a minute',
    suite: FLOOD,
    red: ['2,000 refused requests from one unsigned sender', "a signed-in caller's refused attempts are bounded"],
    edits: [
      { file: '0028_refusals_by_source.sql', from: "    v_limit  constant integer  := 20;   -- REFUSED_PER_MINUTE\n    v_lines  integer;\n  BEGIN\n    -- One source at a time in this log", to: "    v_limit  constant integer  := 1000000;   -- REFUSED_PER_MINUTE\n    v_lines  integer;\n  BEGIN\n    -- One source at a time in this log" },
      { file: '0028_refusals_by_source.sql', from: "    v_limit  constant integer  := 20;   -- REFUSED_PER_MINUTE\n    v_lines  integer;\n  BEGIN\n    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'refused-security'", to: "    v_limit  constant integer  := 1000000;   -- REFUSED_PER_MINUTE\n    v_lines  integer;\n  BEGIN\n    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'refused-security'" },
    ],
  },
  {
    name: 'unsigned_to_owner_log',
    why: 'a refused attempt with no working sign-in or key lands in the garage it names',
    suite: FLOOD,
    red: ['2,000 refused requests from one unsigned sender'],
    edits: [
      { file: '0028_refusals_by_source.sql', from: '    IF v_caller IS NULL THEN\n      PERFORM write_refused_security', to: '    IF v_caller IS NULL AND p_target_id IS NULL THEN\n      PERFORM write_refused_security' },
      { file: '0028_refusals_by_source.sql', from: '    IF v_caller IS DISTINCT FROM v_t_tenant THEN', to: '    IF v_caller IS NOT NULL AND v_caller IS DISTINCT FROM v_t_tenant THEN' },
      { file: '0028_refusals_by_source.sql', from: "    v_source := md5(concat_ws('|', 'actor', v_caller, v_kind, v_actor));", to: "    v_source := coalesce(p_source_key, md5(concat_ws('|', 'actor', v_caller, v_kind, v_actor)));\n    IF v_caller IS NULL THEN v_kind := 'nobody'; v_actor := NULL; v_name := NULL; END IF;" },
    ],
  },
  {
    name: 'own_key_to_security',
    why: "this account's cancelled key or ended sign-in goes to the security log, not its own log",
    suite: LOG,
    red: ['REFUSED ATTEMPTS land in the right log'],
    edits: [{ file: '0028_refusals_by_source.sql', from: '      IF v_old_tenant IS NOT NULL THEN', to: '      IF false THEN' }],
  },
  {
    name: 'key_unnamed',
    why: "a key's refused line does not name the key",
    suite: LOG,
    red: ['EVERY LINE NAMES WHO'],
    edits: [{ file: '0028_refusals_by_source.sql', from: "    IF v_kind = 'key' AND v_name IS NULL THEN", to: '    IF false THEN' }],
  },
  {
    name: 'update_granted',
    why: 'the application may UPDATE and DELETE the log',
    suite: LOG,
    red: ['THE LOG CANNOT BE CHANGED'],
    edits: [{ file: '0026_lane_closing_and_change_log.sql', from: 'GRANT SELECT, INSERT ON garage_changes TO openparking_app;', to: 'GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON garage_changes TO openparking_app;' }],
  },
  {
    name: 'trigger_dropped',
    why: 'nothing stops the owner of the table rewriting it',
    suite: LOG,
    red: ['THE LOG CANNOT BE CHANGED'],
    edits: [{ file: '0026_lane_closing_and_change_log.sql', from: 'CREATE TRIGGER garage_changes_append_only\n  BEFORE UPDATE OR DELETE ON garage_changes\n  FOR EACH ROW EXECUTE FUNCTION refuse_log_rewrite();', to: '' }],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-setup-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

const run = (dir, suite, extraEnv = {}) =>
  // The spec reporter, named: Node's default without a terminal is TAP on some
  // versions, and the red test's name is read from the spec lines.
  spawnSync(process.execPath, ['--test', '--test-reporter=spec', suite], { cwd: dir, env: { ...process.env, ...extraEnv }, stdio: 'pipe', encoding: 'utf8' });

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
    texts.set(path, source.replace(e.from, e.to));
  }
  for (const [path, text] of texts) writeFileSync(path, text);
  return null;
}

const required = (name) => process.env[name] || (console.error(`${name} is required`), process.exit(1));
const adminUrl = required('DATABASE_URL');
const appPassword = required('APP_DB_PASSWORD');
const scratchAdmin = new URL(adminUrl);
scratchAdmin.pathname = `/${SCRATCH}`;
const scratchApp = new URL(`postgres://openparking_app@${new URL(adminUrl).host}/${SCRATCH}`);
scratchApp.password = appPassword;
const maintenance = new URL(adminUrl);
maintenance.pathname = '/postgres';
const scratchEnv = { DATABASE_URL: scratchAdmin.toString(), APP_DATABASE_URL: scratchApp.toString() };

async function withAdmin(fn) {
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A scratch database from the migrations, with the break's edits made to a copy of them. */
async function buildScratch(dir, edits) {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
    await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
  });
  const partial = mkdtempSync(join(tmpdir(), 'openparking-setup-migrations-'));
  try {
    for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
    const missing = plant(partial, edits);
    if (missing) return missing;
    for (const [script, extra] of [['scripts/migrate.js', { MIGRATIONS_DIR: partial }], ['scripts/ensure-app-role.js', {}]]) {
      const r = spawnSync(process.execPath, [script], { cwd: dir, env: { ...process.env, ...scratchEnv, ...extra }, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${script} failed against the scratch database:\n${r.stdout}${r.stderr}`);
    }
    return null;
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

let failures = 0;

console.log('== control A: each suite must PASS intact ==');
for (const suite of [SETUP, LANES, LOG, FLOOD, RACES]) {
  const dir = stage();
  try {
    const intact = run(dir, suite);
    if (intact.status === 0) console.log(`  ${suite.padEnd(26)} OK — ${summarise(intact)}`);
    else {
      console.error(`  CONTROL A FAILED — ${suite} does not pass intact: ${summarise(intact)}\n${intact.stdout}\n${intact.stderr}`);
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
    console.error(`  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
    failures += 1;
  } else if (!named) {
    console.error(`  ${brk.name.padEnd(26)} *** RED, BUT NOT IN "${brk.red.join('", "')}" — red: ${red.join(' | ')} ***`);
    failures += 1;
  } else {
    console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}; named: ${brk.red.join(', ')}`);
  }
}

console.log('\n== control B: each source break must make its suite FAIL, in the test that names it ==');
for (const brk of SOURCE_BREAKS) {
  const dir = stage();
  try {
    const missing = plant(dir, brk.edits);
    if (missing) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing} ***`);
      failures += 1;
      continue;
    }
    if (brk.scratch) await buildScratch(dir, []);
    judge(brk, run(dir, brk.suite, brk.scratch ? scratchEnv : {}));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== control C: each schema break must make its suite FAIL, in the test that names it ==');
for (const brk of SCHEMA_BREAKS) {
  const dir = stage();
  try {
    const missing = await buildScratch(dir, brk.edits);
    if (missing) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing} ***`);
      failures += 1;
      continue;
    }
    judge(brk, run(dir, brk.suite, scratchEnv));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A database with a property removed is dropped, so nothing later runs against it by accident.
await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`));

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's setup, lane and change-log tests.`);
  process.exit(1);
}
console.log(`\nall controls OK — the suites fail, by name, on every one of the ${SOURCE_BREAKS.length + SCHEMA_BREAKS.length} properties U4 rests on.`);
