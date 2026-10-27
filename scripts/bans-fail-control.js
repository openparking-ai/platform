#!/usr/bin/env node
/**
 * The controls for U7f (0033): pictures kept with an entry, tailgaters as
 * stays, and the banned list. Every property is broken below, one at a time,
 * in a COPY of the tree, and test/bans.test.js is REQUIRED to go red -- and
 * to go red in the test that names the property. A pass is the failure; so
 * is a red in some other test.
 *
 *   never_removed         the 30-day rule removes nothing
 *   removed_while_inside  a stay still open loses its pictures with the 30 days
 *   tailgater_unmarked    a tailgater stay is stored as an ordinary one
 *   listed_switch_off     a tailgater is listed with "ban tailgaters" off
 *   reach_ignored         a ban reaches every garage of the account whatever the reach
 *   removal_ignored       taking a car off the list leaves it on
 *   listed_aged_out       a listed car's pictures go with the 30 days
 *   listed_redacted       a listed car's vehicle is redacted by the retention window
 *   added_by_hand         a route that puts a car on the list
 *   listed_unread         a tailgater with no identity read is listed (gate F5)
 *   thirty_one_days       the 30 days are 31 (re-gate G2)
 *   twenty_nine_days      the 30 days are 29 (re-gate G2)
 *
 * The arming loop's pictures have no control here: none is stored anywhere,
 * so there is no picture for the 30-day rule to take by mistake.
 *
 * Needs the same environment as the suite (the rate engine, the database).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SUITE = 'test/bans.test.js';

const BREAKS = [
  {
    name: 'never_removed',
    why: 'the 30-day rule removes nothing',
    red: ['30 DAYS AFTER THE CAR LEFT'],
    edits: [{ file: 'src/bans.js', from: '    `DELETE FROM entry_pictures p\n      WHERE p.tenant_id = $1\n', to: '    `DELETE FROM entry_pictures p\n      WHERE p.tenant_id = $1 AND false\n' }],
  },
  {
    name: 'removed_while_inside',
    why: 'a stay still open loses its pictures with the 30 days',
    red: ['30 DAYS AFTER THE CAR LEFT'],
    edits: [{ file: 'src/bans.js', from: '                              AND s.exit_at IS NOT NULL\n                              AND s.exit_at < ', to: '                              AND COALESCE(s.exit_at, s.entry_at) < ' }],
  },
  {
    name: 'tailgater_unmarked',
    why: 'a tailgater stay is stored as an ordinary one',
    red: ['A TAILGATER THE LANE IDENTIFIED IS A STAY'],
    edits: [{ file: 'src/app.js', from: '          entryDescriptor,\n          tailgater,\n', to: '          entryDescriptor,\n          tailgater: false,\n' }],
  },
  {
    name: 'listed_switch_off',
    why: 'a tailgater is listed with "ban tailgaters" off',
    red: ['THE SWITCH'],
    edits: [{ file: 'src/bans.js', from: 'if (!session.tailgater || !garage.ban_tailgaters || !session.entry_descriptor) return false;', to: 'if (!session.tailgater || !session.entry_descriptor) return false;' }],
  },
  {
    name: 'reach_ignored',
    why: 'a ban reaches every garage of the account whatever the reach',
    red: ['THE REACH'],
    edits: [{ file: 'src/bans.js', from: " WHERE b.tenant_id = $1\n   AND (b.garage_id = $2 OR g.ban_reach = 'all')`;", to: " WHERE b.tenant_id = $1\n   AND (b.garage_id = $2 OR true)`;" }],
  },
  {
    name: 'removal_ignored',
    why: 'taking a car off the list leaves it on',
    red: ['A LISTED CAR IS KEPT WHOLE'],
    edits: [{ file: 'src/bans.js', from: "const { rowCount } = await client.query('DELETE FROM banned_vehicles WHERE tenant_id = $1 AND id = $2', [tenantId, banId]);\n  return rowCount === 1;", to: 'return true;' }],
  },
  {
    name: 'listed_aged_out',
    why: "a listed car's pictures go with the 30 days",
    red: ['A LISTED CAR IS KEPT WHOLE'],
    edits: [{ file: 'src/bans.js', from: '        AND NOT EXISTS (\n              SELECT 1 FROM banned_vehicles b JOIN sessions s ON s.id = b.session_id\n               WHERE s.tenant_id = p.tenant_id AND s.open_event_id = p.event_id)\n', to: '' }],
  },
  {
    name: 'listed_redacted',
    why: "a listed car's vehicle is redacted by the retention window",
    red: ['A LISTED CAR IS KEPT WHOLE'],
    edits: [{ file: 'src/retention.js', from: '        AND NOT EXISTS (\n              SELECT 1 FROM banned_vehicles b JOIN sessions s ON s.id = b.session_id\n               WHERE s.vehicle_id = v.id)\n', to: '' }],
  },
  {
    name: 'added_by_hand',
    why: 'a route that puts a car on the list',
    red: ['NO CAR IS LISTED BY HAND'],
    edits: [{ file: 'src/app.js', from: "  ['POST', '/garages/:garageId/banned/:banId/remove', 'garage.banned_car_remove'],\n", to: "  ['POST', '/garages/:garageId/banned/:banId/remove', 'garage.banned_car_remove'],\n  ['POST', '/garages/:garageId/banned', 'garage.banned_car_add'],\n" }],
  },  {
    name: 'listed_unread',
    why: 'a tailgater with no identity read is listed',
    red: ['THE SWITCH'],
    edits: [{ file: 'src/bans.js', from: 'if (!session.tailgater || !garage.ban_tailgaters || !session.entry_descriptor) return false;', to: 'if (!session.tailgater || !garage.ban_tailgaters) return false;' }],
  },
  {
    name: 'thirty_one_days',
    why: 'the 30 days are 31',
    red: ['30 DAYS AFTER THE CAR LEFT'],
    edits: [{ file: 'src/bans.js', from: 'export const PICTURE_DAYS = 30;', to: 'export const PICTURE_DAYS = 31;' }],
  },
  {
    name: 'twenty_nine_days',
    why: 'the 30 days are 29',
    red: ['30 DAYS AFTER THE CAR LEFT'],
    edits: [{ file: 'src/bans.js', from: 'export const PICTURE_DAYS = 30;', to: 'export const PICTURE_DAYS = 29;' }],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-bans-control-'));
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

let failures = 0;

console.log('== control A: the suite must PASS intact ==');
{
  const dir = stage();
  try {
    const intact = run(dir, SUITE);
    if (intact.status === 0) console.log(`  ${SUITE.padEnd(26)} OK — ${summarise(intact)}`);
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
    console.error(`  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
    failures += 1;
  } else if (!named) {
    console.error(`  ${brk.name.padEnd(26)} *** RED, BUT NOT IN "${brk.red.join('", "')}" — red: ${red.join(' | ')} ***`);
    failures += 1;
  } else {
    console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}; named: ${brk.red.join(', ')}`);
  }
}

console.log('\n== control B: each break must make the suite FAIL, in the test that names it ==');
for (const brk of BREAKS) {
  const dir = stage();
  try {
    const missing = plant(dir, brk.edits);
    if (missing) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing} ***`);
      failures += 1;
      continue;
    }
    judge(brk, run(dir, SUITE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust the U7f tests.`);
  process.exit(1);
}
console.log(`\nall controls OK — the suite fails, by name, on every one of the ${BREAKS.length} properties U7f rests on.`);
