#!/usr/bin/env node
/**
 * The control for the exit case (0037): the car at an exit, found by its ID.
 *
 * Every property the exit's safety rests on is broken below, one at a time,
 * and `test/exit-match.test.js` with `test/exits.test.js` are REQUIRED to go
 * red -- with at least one test still green, so a break that stops the files
 * running is not mistaken for one the tests caught. A pass is the failure.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 *
 *   mismatch_ignored         a sure character that differs no longer excludes a stay
 *   not_folded               look-alikes are not folded: B at the entry, 8 at the exit
 *   unreadable_matches_read  an unreadable plate is taken for any read one
 *   colour_ignored           a different colour no longer excludes a stay
 *   size_ignored             a different size no longer excludes a stay
 *   close_second_wins        a winner need not be clearly ahead of the next stay
 *   two_chars_alone          two sure characters pick a stay with nothing beside them
 *   too_many_shown           more than MAX_CANDIDATES are sent to the picker
 *   picker_sent_ids          the picker is sent the stays' ids beside their pictures
 *   answer_any_text          any number in the answer's words is taken as the answer
 *   picker_no_timeout        the picker is waited on without a limit
 *   picker_asked_twice       a resend of one car asks the picker again
 *   picker_hidden_candidate  the picker is asked with a candidate it cannot see
 *   unmatched_not_told       an exit with no stay found leaves no event for the attendants
 *   word_after_exit_taken    a driver's entry time after the exit is priced
 *   word_too_old_taken       a driver's entry time beyond 90 days is priced
 *   word_twice               the driver's word is taken twice
 *   fee_settles              a fee above zero opens the gate
 *   person_unnamed           a person's letting out does not say who
 *   close_prices_again       the close prices the stay again instead of writing the case's fee
 *   case_needs_plate         a close naming its case still needs a plate
 *   entry_id_dropped         the open does not keep the entry's ID
 *   entry_id_not_purged      the purge leaves a stay's ID behind
 *   case_id_not_purged       the purge leaves the ID on the cases that found the stay
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * statement of 0037 edited, so the property genuinely never existed there.
 *
 *   read_plate_with_nothing_sure   a stay's read plate may have no sure character
 *   word_any_age                   a driver's word may claim any entry time
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
const SCRATCH = process.env.EXITS_SCRATCH_DB || 'openparking_exits_control';

const SOURCE_BREAKS = [
  {
    name: 'mismatch_ignored',
    why: 'a differing sure character no longer excludes a stay',
    file: 'src/exitMatch.js',
    from: "    if (a !== b) return { excluded: true, why: `sure character ${i} differs` };",
    to: '    if (a !== b) continue;',
  },
  {
    name: 'not_folded',
    why: 'look-alikes are not folded',
    file: 'src/exitMatch.js',
    from: '.map((c) => FOLD[c] ?? c).join',
    to: '.map((c) => c).join',
  },
  {
    name: 'unreadable_matches_read',
    why: 'an unreadable plate is taken for any read one',
    file: 'src/exitMatch.js',
    from: "    return { excluded: true, why: 'plate read at one end and unreadable at the other' };",
    to: '    return { excluded: false, agree: 0 };',
  },
  {
    name: 'colour_ignored',
    why: 'a different colour no longer excludes a stay',
    file: 'src/exitMatch.js',
    from: 'if (distance !== null && distance > SAME_COLOUR_DISTANCE)',
    to: 'if (false)',
  },
  {
    name: 'size_ignored',
    why: 'a different size no longer excludes a stay',
    file: 'src/exitMatch.js',
    from: 'if (exitId.size && stay.entry_size && exitId.size !== stay.entry_size)',
    to: 'if (false)',
  },
  {
    name: 'close_second_wins',
    why: 'a winner need not be clearly ahead',
    file: 'src/exitMatch.js',
    from: '(!next || next.agree <= top.agree - CLEAR_BY)',
    to: 'true',
  },
  {
    name: 'two_chars_alone',
    why: 'two sure characters pick a stay alone',
    file: 'src/exitMatch.js',
    from: '  if (s.agree >= SURE_ALONE) return true;',
    to: '  if (s.agree >= SURE_WITH_LOOK) return true;',
  },
  {
    name: 'too_many_shown',
    why: 'more than MAX_CANDIDATES go to the picker',
    file: 'src/exitMatch.js',
    from: '  if (few.length > MAX_CANDIDATES) {',
    to: '  if (false) {',
  },
  {
    name: 'picker_sent_ids',
    why: "the picker is sent the stays' ids",
    file: 'src/exitPicker.js',
    from: "text: `Candidate ${i + 1}:` }",
    to: "text: `Candidate ${i + 1} (${c.session_id}):` }",
  },
  {
    name: 'answer_any_text',
    why: "any number in the answer's words is the answer",
    file: 'src/exitPicker.js',
    from: "  if (!/^\\d{1,2}$/.test(text)) return null;\n  const n = Number(text);",
    to: "  const n = Number((text.match(/\\d+/) ?? ['x'])[0]);",
  },
  {
    name: 'picker_no_timeout',
    why: 'the picker is waited on without a limit',
    file: 'src/exitPicker.js',
    from: '      signal: AbortSignal.timeout(settings.timeoutMs),\n',
    to: '',
  },
  {
    name: 'picker_asked_twice',
    why: 'a resend asks the picker again',
    file: 'src/app.js',
    from: '        if (already) return { already };',
    to: '        if (already && false) return { already };',
  },
  {
    name: 'picker_hidden_candidate',
    why: 'the picker is asked with a candidate it cannot see',
    file: 'src/app.js',
    from: '} else if (exitPictures.length === 0 || shown.some((c) => c.pictures.length === 0)) {',
    to: '} else if (exitPictures.length === 0) {',
  },
  {
    name: 'unmatched_not_told',
    why: 'no event is left for the attendants',
    file: 'src/app.js',
    from: "        if (written.created && method === 'none') {",
    to: '        if (false) {',
  },
  {
    name: 'word_after_exit_taken',
    why: "a driver's entry time after the exit is priced",
    file: 'src/app.js',
    from: "        if (claimed > exitAt) throw conflict('word_after_exit'",
    to: "        if (false) throw conflict('word_after_exit'",
  },
  {
    name: 'word_too_old_taken',
    why: "a driver's entry time beyond 90 days is priced",
    file: 'src/app.js',
    from: '        if (exitAt - claimed > exits.WORD_MAX_DAYS * 86_400_000) {',
    to: '        if (false) {',
  },
  {
    name: 'word_twice',
    why: "the driver's word is taken twice",
    file: 'src/app.js',
    from: "        if (row.method !== 'none' || row.closed_at) {",
    to: '        if (row.closed_at) {',
  },
  {
    name: 'fee_settles',
    why: 'a fee above zero opens the gate',
    file: 'src/exits.js',
    from: "  return { settled: false, needs: 'payment' };",
    to: "  return { settled: true, why: 'priced' };",
  },
  {
    name: 'person_unnamed',
    why: "a person's letting out does not say who",
    file: 'src/app.js',
    from: "by: `${actor.kind}:${actor.name ?? actor.id ?? ''}`.slice(0, 300)",
    to: "by: 'someone'",
  },
  {
    name: 'close_prices_again',
    why: "the close prices the stay again instead of writing the case's fee",
    file: 'src/app.js',
    from: '        if (exitCase) {\n          // The case\'s figures (0037)',
    to: '        if (false) {\n          // The case\'s figures (0037)',
  },
  {
    name: 'case_needs_plate',
    why: 'a close naming its case still needs a plate',
    file: 'src/app.js',
    from: '      const { plate, ticketRef } = exitId ? { plate: null, ticketRef: null } : laneIdentity(req.body);',
    to: '      const { plate, ticketRef } = laneIdentity(req.body);',
  },
  {
    name: 'entry_id_dropped',
    why: "the open does not keep the entry's ID",
    file: 'src/app.js',
    from: '          entryUnsurePlateConfidence: unsure.confidence,\n          entryId,\n',
    to: '          entryUnsurePlateConfidence: unsure.confidence,\n',
  },
  {
    name: 'entry_id_not_purged',
    why: "the purge leaves a stay's ID behind",
    file: 'src/retention.js',
    from: '            AND (entry_plate_state IS NOT NULL OR entry_colour_code IS NOT NULL OR entry_size IS NOT NULL)`,',
    to: '            AND false`,',
  },
  {
    name: 'case_id_not_purged',
    why: 'the purge leaves the ID on the cases that found the stay',
    file: 'src/retention.js',
    from: '            AND session_id IN (SELECT s.id FROM sessions s WHERE s.tenant_id = $1 AND s.vehicle_id = ANY($2::uuid[]))`,',
    to: '            AND false`,',
  },
];

const ADDED_0037 = '0037_exit_cases.sql';

const SCHEMA_BREAKS = [
  {
    name: 'read_plate_with_nothing_sure',
    why: "a stay's read plate may have no sure character",
    edits: [{
      file: ADDED_0037,
      from: "  OR (entry_plate_state = 'read' AND entry_plate_rule IS NOT NULL AND entry_plate_pattern ~ '[0-9A-Z]')",
      to: "  OR (entry_plate_state = 'read' AND entry_plate_rule IS NOT NULL AND entry_plate_pattern IS NOT NULL)",
    }],
  },
  {
    name: 'word_any_age',
    why: "a driver's word may claim any entry time",
    edits: [{
      file: ADDED_0037,
      from: " AND claimed_entry_at >= exit_at - interval '90 days'",
      to: '',
    }],
  },
];

const SUITE = ['--test', 'test/exit-match.test.js', 'test/exits.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-exits-control-'));
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

/** A scratch database built from `migrations/` with one statement of 0037 edited. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-exits-migrations-'));
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
    const path = join(dir, brk.file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(brk.from)) {
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    writeFileSync(path, source.replace(brk.from, brk.to));
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
  console.error(`\n${failures} control(s) failed. Do not trust the exit case tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property the exit case rests on.');
