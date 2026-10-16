#!/usr/bin/env node
/**
 * The control for a stay's life when no exit closes it, and an exit that
 * comes before its entry (0035).
 *
 * Every property is broken below, one at a time, and test/stay-lifecycle.test.js
 * is REQUIRED to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported as
 * not planted rather than run:
 *   folded_into_old_stay    a returning car is put on its own old open stay again.
 *   one_arrival_unseen      entries minutes apart are two visits, not one arrival.
 *   later_stay_unseen       an earlier visit arriving after the next one closed is left open.
 *   end_never_recorded      a superseded stay has no `stay_ended` event.
 *   late_close_misses_end   a late close for a superseded stay finds nothing to close.
 *   close_refused_not_kept  a close before its open is refused, and lost.
 *   kept_never_delivered    the open never closes from the exit kept for it.
 *   retry_swallowed         a kept exit that cannot be closed now is not retried.
 *   clocks_never_apart      an exit read on a slow clock is not its stay's exit.
 *   kept_exit_never_purged  the purge leaves what a kept exit carries beside a redacted vehicle.
 *   named_404_unnamed       a named stay that is not open is refused with no name.
 *   named_clocks_never_apart  a close NAMING its stay, read on a slow clock, is a stale exit.
 *   named_late_close_misses_end  a close naming a superseded stay finds nothing to close.
 *   abandoned_close_kept    an exit after the abandon moment is kept, never closing the stay.
 *   abandoned_unbounded     an abandoned stay takes exits past the car's next entry.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SOURCE_BREAKS = [
  {
    // OP-NODE-001: the reuse as it was, with no look at the entry times.
    name: 'folded_into_old_stay',
    why: 'a returning car is put on its own old open stay',
    file: 'src/repository.js',
    from: '  if (existing && Math.abs(entryAt - existing.entry_at) <= reapproachMinutes() * 60_000) {',
    to: '  if (existing) {',
  },
  {
    name: 'one_arrival_unseen',
    why: 'entries minutes apart are taken as two visits',
    file: 'src/repository.js',
    from: '<= reapproachMinutes() * 60_000) {',
    to: '<= 0) {',
  },
  {
    name: 'later_stay_unseen',
    why: 'an earlier visit arriving after the next one closed is left open',
    file: 'src/repository.js',
    from: '  const endedBy = await nextStayOf(client, tenantId, garageId, vehicleId, entryAt);',
    to: '  const endedBy = existing && entryAt < existing.entry_at ? existing : null;',
  },
  {
    name: 'end_never_recorded',
    why: 'a superseded stay has no stay_ended event',
    file: 'src/app.js',
    from: '        for (const ended of opened.superseded) await stays.recordEnded(client, tenantId, ended, { laneId });\n',
    to: '',
  },
  {
    name: 'late_close_misses_end',
    why: 'a late close for a superseded stay finds nothing to close',
    file: 'src/app.js',
    from: '    const ended = await repo.endedStayAt(client, tenantId, garageId, { vehicleId: vehicle.id }, exitAt);\n    if (ended) return { open: ended, exitAt };\n',
    to: '',
  },
  {
    // OP-NODE-005: the 404 as it was, which the lane drops for good.
    name: 'close_refused_not_kept',
    why: 'a close before its open is refused and lost',
    file: 'src/app.js',
    from: '  return repo.keepPendingExit(client, tenantId, keep);',
    to: "  throw new HttpError(404, 'no open session for this vehicle');",
  },
  {
    name: 'kept_never_delivered',
    why: 'the open never closes from the exit kept for it',
    file: 'src/app.js',
    from: '      if (result.pendingExit) {\n',
    to: '      if (false) {\n',
  },
  {
    name: 'retry_swallowed',
    why: 'a kept exit that cannot be closed now is not retried with the open',
    file: 'src/app.js',
    from: '        if (delivered.error && (delivered.error.status ?? 500) >= 500) throw delivered.error;\n',
    to: '',
  },
  {
    name: 'clocks_never_apart',
    why: "an exit read on a slow clock is not taken as its stay's exit",
    file: 'src/app.js',
    from: 'const LANE_CLOCKS_APART_MS = 2 * MAX_CLOCK_SKEW_SECONDS * 1000;',
    to: 'const LANE_CLOCKS_APART_MS = 0;',
  },
  {
    name: 'kept_exit_never_purged',
    why: "the purge leaves a kept exit's descriptor and decision beside a redacted vehicle",
    file: 'src/retention.js',
    from: 'UPDATE pending_exits SET exit_descriptor = NULL, local_decision = NULL, reader_shown = NULL',
    to: 'UPDATE pending_exits SET exit_descriptor = exit_descriptor',
  },
  {
    name: 'named_404_unnamed',
    why: 'a named stay that is not open is refused with no name',
    file: 'src/app.js',
    from: "throw new HttpError(404, 'the named session is not open in this garage', 'session_not_open');",
    to: "throw new HttpError(404, 'the named session is not open in this garage');",
  },
  {
    // The named path is the one an online lane takes: it looks the stay up
    // at the barrier and sends its id.
    name: 'named_clocks_never_apart',
    why: 'a close naming its stay, read on a slow clock, is refused as a stale exit',
    file: 'src/app.js',
    from: '      return withinClocks(named);',
    to: '      return { open: named, exitAt };',
  },
  {
    name: 'named_late_close_misses_end',
    why: 'a close naming a superseded stay finds nothing to close',
    file: 'src/app.js',
    from: ')\n        ?? (await repo.endedStayAt(client, tenantId, garageId, { sessionId }, exitAt));',
    to: ');',
  },
  {
    // OP-NODE-002: the abandoned stay's window as it was, ending at the
    // moment the operator ran the command line.
    name: 'abandoned_close_kept',
    why: 'an exit after the abandon moment is kept and never closes the stay',
    file: 'src/repository.js',
    from: "        AND CASE WHEN s.ended->>'reason' = 'abandoned'\n",
    to: '        AND CASE WHEN false\n',
  },
  {
    name: 'abandoned_unbounded',
    why: "an abandoned stay takes exits past the car's next entry",
    file: 'src/repository.js',
    from: 'AND n.entry_at > s.entry_at AND n.entry_at <= $5)',
    to: 'AND false)',
  },
];

const SUITE = ['--test', 'test/stay-lifecycle.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-stay-lifecycle-control-'));
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
      console.error(`  ${brk.name.padEnd(28)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(`  ${brk.name.padEnd(28)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(28)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log("\nall controls OK — the suite fails on every property a stay's life without an exit rests on.");
