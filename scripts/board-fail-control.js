#!/usr/bin/env node
/**
 * The controls for U4c, the platform's half: a closed lane the lane can act
 * on, and the board. Every property is broken below, one at a time, in a
 * COPY of the tree, and the suite that measures it is REQUIRED to go red --
 * and to go red in the test that names the property. A pass is the failure;
 * so is a red in some other test.
 *
 * Source breaks:
 *   full_exit_route_open       the route takes full on a way out                     (check 7)
 *   undrawable_taken           a character the screen lacks is taken                 (check 9)
 *   copy_has_extra             the platform's copy holds a character the font lacks  (check 9)
 *   lane_on_slow_read_only     the fast read carries no lane state                   (check 5)
 *   board_on_slow_read_only    the fast read carries no board                        (check 5)
 *   messages_every_lane        a lane is sent every message of its garage            (check 13)
 *   ended_message_sent         a message past its end is still sent                  (check 13)
 *   prices_switch_ignored      the price switch never reaches the lane               (B3)
 *   lone_message_kept          a lane removed leaves its lone message on no lane     (F1 check 1)
 *   removal_line_silent        the lane's removal line does not name what it removed (F1 check 1)
 *   change_to_no_lanes         a change to no lanes is taken                         (F1 check 2)
 *   entry_stays_uncounted      a lane a stay came in by is removed                   (F1 check 3)
 *   exit_stays_uncounted       a lane a stay went out by is removed                  (F1 check 3)
 *   computers_uncounted        a lane with a lane computer is removed                (F1 check 3)
 *   readers_uncounted          a lane with a card reader is removed                  (F1 check 3)
 *   events_uncounted           a lane with an event (or a plate search) is removed   (F1 check 3)
 *
 * Schema breaks (the copy's migrations edited; a scratch database built from
 * them):
 *   full_exit_stored           the database takes full on a way out                  (check 7)
 *   message_lane_any_garage    the database takes a lane of another garage           (B2)
 *   board_policy_dropped       a garage's messages are readable by every account     (B2)
 *   message_on_no_lane_stored  the database takes a message on no lane              (F1 check 2)
 *   lane_column_unlisted       a new column names a lane, unlisted in the sweep      (F1 check 3)
 *
 * Needs the same environment as the suite (a Postgres it may make a scratch
 * database on).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = 'openparking_board_control';

const BOARD = 'test/board.test.js';
const SETUP = 'test/lane-setup.test.js';
const ISOLATION = 'test/tenant-isolation.test.js';

const SOURCE_BREAKS = [
  {
    name: 'full_exit_route_open',
    why: 'the route takes full on a way out',
    suite: BOARD,
    red: ['FULL IS A WAY IN'],
    edits: [{ file: 'src/lanes.js', from: "  if (body.reason === 'full' && lane.direction !== 'entry') {", to: '  if (false) {' }],
  },
  {
    name: 'undrawable_taken',
    why: 'a character the screen lacks is taken',
    suite: BOARD,
    red: ['ONLY CHARACTERS THE SCREEN CAN DRAW'],
    edits: [{ file: 'src/screenText.js', from: "    if ((upper.length !== 1 || !DRAWABLE.has(upper[0])) && !seen.includes(c)) seen.push(c);", to: '' }],
  },
  {
    name: 'copy_has_extra',
    why: "the platform's copy holds a character the font lacks",
    suite: BOARD,
    red: ['ONLY CHARACTERS THE SCREEN CAN DRAW'],
    edits: [{ file: 'src/screen-characters.json', from: '"characters": " !', to: '"characters": "€ !' }],
  },
  {
    name: 'lane_on_slow_read_only',
    why: 'the fast read carries no lane state',
    suite: BOARD,
    red: ['FAST'],
    edits: [
      { file: 'src/app.js', from: '          return { cursor, open, lane, board: laneBoard };', to: '          return { cursor, open, board: laneBoard };' },
      { file: 'src/app.js', from: '        return { since: String(since), cursor, changes, more, lane, board: laneBoard };', to: '        return { since: String(since), cursor, changes, more, board: laneBoard };' },
    ],
  },
  {
    name: 'board_on_slow_read_only',
    why: 'the fast read carries no board',
    suite: BOARD,
    red: ['A MESSAGE SHOWS ONLY ON ITS LANES'],
    edits: [
      { file: 'src/app.js', from: '          return { cursor, open, lane, board: laneBoard };', to: '          return { cursor, open, lane };' },
      { file: 'src/app.js', from: '        return { since: String(since), cursor, changes, more, lane, board: laneBoard };', to: '        return { since: String(since), cursor, changes, more, lane };' },
    ],
  },
  {
    name: 'messages_every_lane',
    why: 'a lane is sent every message of its garage',
    suite: BOARD,
    red: ['A MESSAGE SHOWS ONLY ON ITS LANES'],
    edits: [{ file: 'src/board.js', from: '      WHERE m.tenant_id = $1 AND ml.lane_id = $2 AND', to: '      WHERE m.tenant_id = $1 AND m.garage_id = (SELECT garage_id FROM lanes WHERE id = $2) AND' }],
  },
  {
    name: 'ended_message_sent',
    why: 'a message past its end is still sent',
    suite: BOARD,
    red: ['A MESSAGE SHOWS ONLY ON ITS LANES'],
    edits: [{ file: 'src/board.js', from: ' AND (m.ends_at IS NULL OR m.ends_at > clock_timestamp())', to: '' }],
  },
  {
    name: 'prices_switch_ignored',
    why: 'the price switch never reaches the lane',
    suite: BOARD,
    red: ['THE PRICE SWITCH'],
    edits: [{ file: 'src/board.js', from: '    prices: lane?.board_prices === true,', to: '    prices: false,' }],
  },
  {
    name: 'lone_message_kept',
    why: 'a lane removed leaves its lone message on no lane',
    suite: BOARD,
    red: ['F1 check 1. A LANE REMOVED TAKES ITS MESSAGES', 'F1 check 3. THE SWEEP'],
    edits: [{ file: 'src/lanes.js', from: "  if (gone.length) await client.query('DELETE FROM board_messages", to: "  if (false) await client.query('DELETE FROM board_messages" }],
  },
  {
    name: 'removal_line_silent',
    why: "the lane's removal line does not name what it removed",
    suite: BOARD,
    red: ['F1 check 1. A LANE REMOVED TAKES ITS MESSAGES'],
    edits: [
      { file: 'src/lanes.js', from: '    ...(kept.length ? { messages_off:', to: '    ...(false ? { messages_off:' },
      { file: 'src/lanes.js', from: '    ...(gone.length ? { messages_removed:', to: '    ...(false ? { messages_removed:' },
    ],
  },
  {
    name: 'change_to_no_lanes',
    why: 'a change to no lanes is taken',
    suite: BOARD,
    red: ['F1 check 2. A MESSAGE IS ALWAYS ON A LANE'],
    edits: [
      { file: 'src/board.js', from: '  if (!Array.isArray(raw) || raw.length === 0 ||', to: '  if (!Array.isArray(raw) ||' },
      { file: 'src/board.js', from: '  if (laneIds.length === 0) throw', to: '  if (false) throw' },
    ],
  },
  ...[
    ['entry_stays_uncounted', 'a lane a stay came in by is removed', '(entry_lane_id = $2 OR exit_lane_id = $2)', 'exit_lane_id = $2'],
    ['exit_stays_uncounted', 'a lane a stay went out by is removed', '(entry_lane_id = $2 OR exit_lane_id = $2)', 'entry_lane_id = $2'],
    ['computers_uncounted', 'a lane with a lane computer is removed', '(SELECT count(*) FROM lane_devices WHERE tenant_id = $1 AND lane_id = $2)', '0'],
    ['readers_uncounted', 'a lane with a card reader is removed', '(SELECT count(*) FROM lane_readers WHERE tenant_id = $1 AND lane_id = $2)', '0'],
    ['events_uncounted', 'a lane with an event (or a plate search) is removed', '(SELECT count(*) FROM events WHERE tenant_id = $1 AND lane_id = $2)', '0'],
  ].map(([name, why, from, to]) => ({ name, why, suite: BOARD, red: ['F1 check 3. THE SWEEP'], edits: [{ file: 'src/lanes.js', from, to }] })),
];

const SCHEMA_BREAKS = [
  {
    name: 'full_exit_stored',
    why: 'the database takes full on a way out',
    suite: BOARD,
    red: ['FULL IS A WAY IN'],
    edits: [{ file: '0030_lane_board.sql', from: ",\n  ADD CONSTRAINT lanes_full_is_a_way_in CHECK (closed_reason IS DISTINCT FROM 'full' OR direction = 'entry');", to: ';' }],
  },
  {
    name: 'message_lane_any_garage',
    why: 'the database takes a lane of another garage',
    suite: BOARD,
    red: ['YOUR GARAGE ONLY'],
    edits: [{ file: '0030_lane_board.sql', from: "      RAISE EXCEPTION 'board_message_lanes_garage: a message shows only on lanes of its own garage'\n        USING ERRCODE = 'foreign_key_violation';", to: '      NULL;' }],
  },
  {
    name: 'board_policy_dropped',
    why: "a garage's messages are readable by every account",
    suite: ISOLATION,
    red: ['board_messages: a tenant reads only its own rows'],
    edits: [{ file: '0030_lane_board.sql', from: 'CREATE POLICY board_messages_tenant_isolation ON board_messages\n  USING      (tenant_id = current_tenant_id())', to: 'CREATE POLICY board_messages_tenant_isolation ON board_messages\n  USING      (true)' }],
  },
  {
    name: 'message_on_no_lane_stored',
    why: 'the database takes a message on no lane',
    suite: BOARD,
    red: ['F1 check 2. A MESSAGE IS ALWAYS ON A LANE'],
    edits: [{ file: '0030_lane_board.sql', from: '       AND NOT EXISTS (SELECT 1 FROM board_message_lanes WHERE message_id = message) THEN', to: '       AND false THEN' }],
  },
  {
    name: 'lane_column_unlisted',
    why: 'a new column names a lane, unlisted in the sweep',
    suite: BOARD,
    red: ['F1 check 3. THE SWEEP'],
    edits: [{ file: '0030_lane_board.sql', from: '  ADD COLUMN board_prices boolean NOT NULL DEFAULT false,', to: '  ADD COLUMN board_prices boolean NOT NULL DEFAULT false,\n  ADD COLUMN paired_lane_id uuid REFERENCES lanes(id) ON DELETE SET NULL,' }],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-board-control-'));
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
const maintenance = new URL(required('SUPERUSER_URL'));
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
  });
  const partial = mkdtempSync(join(tmpdir(), 'openparking-board-migrations-'));
  try {
    for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
    const missing = plant(partial, edits);
    if (missing) return missing;
    for (const [script, extra] of [
    ['scripts/prepare-database.js', { MIGRATIONS_DIR: partial }],
    ['scripts/migrate.js', { MIGRATIONS_DIR: partial }],
  ]) {
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
for (const suite of [BOARD, SETUP]) {
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
  const named = brk.red.every((want) => red.some((t) => t.includes(want))) && (!brk.says || broken.stdout.includes(brk.says));
  if (broken.status === 0) {
    console.error(`  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
    failures += 1;
  } else if (!named) {
    console.error(`  ${brk.name.padEnd(26)} *** RED, BUT NOT IN "${brk.red.join('", "')}"${brk.says ? ` SAYING "${brk.says}"` : ''} — red: ${red.join(' | ')} ***`);
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
  console.error(`\n${failures} control(s) failed. Do not trust this round's board tests.`);
  process.exit(1);
}
console.log(`\nall controls OK — the suites fail, by name, on every one of the ${SOURCE_BREAKS.length + SCHEMA_BREAKS.length} properties U4c rests on, on the platform.`);
