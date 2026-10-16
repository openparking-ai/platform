#!/usr/bin/env node
/**
 * The control for the fill rule's figures (0034): the garage's number of
 * spaces, and how full it was when each car came in.
 *
 * Every property is broken below, one at a time, and the suite is REQUIRED
 * to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported as
 * not planted rather than run:
 *   opens_unlocked          two opens at once are not held one behind the other.
 *   closed_counted          a car that has left is still counted inside.
 *   not_clamped             more cars than spaces is more than full.
 *   rounded_up              the figure is rounded up, not down.
 *   lane_sets_figure        a figure the lane sends on the open is stored.
 *   figure_not_sent         the close does not hand the engine the stay's figure.
 *   spaces_unchecked        any value is taken as the number of spaces.
 *   fill_without_spaces     rates with a fill rule are stored for a garage with no spaces.
 *   answers_unchecked       a fill rule missing an answer reaches the engine unnamed.
 *   spaces_cleared_under    the number of spaces is cleared under rates that need it.
 *   feed_without_figure     the lane's copy of the open stays has no figure.
 *   past_without_figure     the past stays have no figure.
 *   try_figure_unchecked    a try hands any figure to the engine.
 *   reconciler_no_figure    the reconciler re-prices without the stay's figure.
 *   rules_without_spaces    the lane's rules carry no number of spaces.
 *   counted_at_receipt      the cars inside are counted when the open arrives (0035).
 *   orphans_never_age       a stay that never closes is counted for ever (0035).
 *   spaces_below_cars_inside  the number of spaces is taken below the cars inside (0035).
 *   lowering_unconfirmed    a lower number under a fill rule needs no word (0035).
 *   clear_asks_newest_only  clearing the number of spaces asks only the newest plan (0035).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SOURCE_BREAKS = [
  {
    name: 'opens_unlocked',
    why: 'two opens at once are not held one behind the other',
    file: 'src/repository.js',
    from: '  await lockGarageOpens(client, garageId);\n',
    to: '',
  },
  {
    name: 'closed_counted',
    why: 'a car that has left is still counted inside',
    file: 'src/repository.js',
    from: '                AND (s.exit_at IS NULL OR s.exit_at > $3)) AS inside',
    to: ') AS inside',
  },
  {
    name: 'not_clamped',
    why: 'more cars than spaces is more than full',
    file: 'src/repository.js',
    from: '  return Math.min(10000, Math.floor((10000 * inside) / spaces));',
    to: '  return Math.floor((10000 * inside) / spaces);',
  },
  {
    name: 'rounded_up',
    why: 'the figure is rounded up, not down',
    file: 'src/repository.js',
    from: '  return Math.min(10000, Math.floor((10000 * inside) / spaces));',
    to: '  return Math.min(10000, Math.ceil((10000 * inside) / spaces));',
  },
  {
    name: 'lane_sets_figure',
    why: 'a figure the lane sends on the open is stored',
    file: 'src/app.js',
    from: '          tailgater,\n        });\n        if (opened.created)',
    to: '          tailgater,\n          laneFigure: req.body?.occupancy_at_entry_bp,\n        });\n        if (opened.created)',
    also: [
      { file: 'src/repository.js', from: 'entryDescriptor = null, tailgater = false },', to: 'entryDescriptor = null, tailgater = false, laneFigure },' },
      { file: 'src/repository.js', from: '    const occupancyAtEntryBp = await occupancyAt(client, tenantId, garageId, entryAt);', to: '    const occupancyAtEntryBp = laneFigure ?? await occupancyAt(client, tenantId, garageId, entryAt);' },
    ],
  },
  {
    name: 'figure_not_sent',
    why: "the close does not hand the engine the stay's figure",
    file: 'src/app.js',
    from: '      occupancyAtEntryBp: session.occupancy_at_entry_bp ?? null,\n',
    to: '',
  },
  {
    name: 'spaces_unchecked',
    why: 'any value is taken as the number of spaces',
    file: 'src/garageFields.js',
    from: '  if (Number.isInteger(raw) && raw >= 1 && raw <= GARAGE_SPACES_MAX) return raw;',
    to: '  if (raw !== undefined) return raw;',
  },
  {
    name: 'fill_without_spaces',
    why: 'rates with a fill rule are stored for a garage with no spaces',
    file: 'src/ratePlans.js',
    from: '  if (hasFillRule(document) && (garage.spaces === null || garage.spaces === undefined)) {',
    to: '  if (false) {',
  },
  {
    name: 'answers_unchecked',
    why: 'a fill rule missing an answer reaches the engine unnamed',
    file: 'src/ratePlans.js',
    from: "    if (rule?.type !== FILL_RULE_TYPE) continue;",
    to: '    continue;',
  },
  {
    name: 'spaces_cleared_under',
    why: 'the number of spaces is cleared under rates that need it',
    file: 'src/app.js',
    from: '          if (spaces === null && guard.fillPlans.length > 0) {',
    to: '          if (false) {',
  },
  {
    // OP-NODE-002 (0035): the figure is taken when the open ARRIVES, as it was.
    name: 'counted_at_receipt',
    why: 'the cars inside are counted when the open arrives, not at the car\'s entry',
    file: 'src/repository.js',
    from: '                AND s.entry_at <= $3 AND s.entry_at > $3::timestamptz - make_interval(hours => $4)\n                AND (s.exit_at IS NULL OR s.exit_at > $3)) AS inside',
    to: '                AND s.exit_at IS NULL AND $3::timestamptz IS NOT NULL AND $4::int IS NOT NULL) AS inside',
  },
  {
    // OP-NODE-002 (0035): a stay nothing closes is counted for ever.
    name: 'orphans_never_age',
    why: 'a stay that never closes is counted inside for ever',
    file: 'src/repository.js',
    from: ' AND s.entry_at > $3::timestamptz - make_interval(hours => $4)\n',
    to: ' AND $4::int IS NOT NULL\n',
  },
  {
    // OP-NODE-003 (0035): any lower number is taken, below the cars inside.
    name: 'spaces_below_cars_inside',
    why: 'the number of spaces is taken below the cars inside now',
    file: 'src/app.js',
    from: '          if (spaces !== null && spaces < guard.inside) {',
    to: '          if (false) {',
  },
  {
    // OP-NODE-003 (0035): a lower number under a fill rule needs no word.
    name: 'lowering_unconfirmed',
    why: 'a lower number of spaces under a fill rule is taken without the owner\'s word',
    file: 'src/app.js',
    from: ' && guard.fillPlans.length > 0 && !spacesConfirmed) {',
    to: ' && false) {',
  },
  {
    // OP-NODE-004 (0035): only the newest plan is asked, as before.
    name: 'clear_asks_newest_only',
    why: 'clearing the number of spaces asks only the newest plan',
    file: 'src/app.js',
    from: '  const plans = ratePlans.plansInForceSince(await ratePlans.ratePlansForGarage(client, tenantId, garageId), since);',
    to: '  const plans = (await ratePlans.ratePlansForGarage(client, tenantId, garageId)).slice(-1);',
  },
  {
    name: 'feed_without_figure',
    why: "the lane's copy of the open stays has no figure",
    file: 'src/repository.js',
    from: '  occupancy_at_entry_bp: r.occupancy_at_entry_bp,\n',
    to: '',
  },
  {
    name: 'past_without_figure',
    why: 'the past stays have no figure',
    file: 'src/pastStays.js',
    from: '    occupancy_at_entry_bp: row.occupancy_at_entry_bp,\n',
    to: '',
  },
  {
    name: 'try_figure_unchecked',
    why: 'a try hands any figure to the engine',
    file: 'src/app.js',
    from: '  if (occupancy !== undefined && occupancy !== null && !(Number.isInteger(occupancy) && occupancy >= 0 && occupancy <= 10000)) {',
    to: '  if (false) {',
  },
  {
    name: 'reconciler_no_figure',
    why: "the reconciler re-prices without the stay's figure",
    file: 'src/reconcile.js',
    from: '        occupancyAtEntryBp: row.occupancy_at_entry_bp ?? null,\n      });\n    } catch (err) {\n      report.unrecomputable',
    to: '      });\n    } catch (err) {\n      report.unrecomputable',
  },
  {
    name: 'rules_without_spaces',
    why: "the lane's rules carry no number of spaces",
    file: 'src/app.js',
    from: '        spaces: payload.garage.spaces ?? null,\n',
    to: '',
  },
];

const SUITE = ['--test', 'test/fill-rule.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-fill-rule-control-'));
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
console.log("\nall controls OK — the suite fails on every property the fill rule's figures rest on.");
