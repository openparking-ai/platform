#!/usr/bin/env node
/**
 * The control for the shadow run.
 *
 * The search is called for real exits, its answer recorded, nothing acts on
 * it -- and every property that makes the record MEAN something is broken
 * below, one at a time, and the suite is REQUIRED to go red. A pass is the
 * failure.
 *
 * Every break is applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 *
 *   snapshot_after_close the snapshot moves to AFTER `exit_at` is written. The
 *                        true stay is then never a candidate, every
 *                        plate-matched exit reads as "absent true car", and
 *                        the measurement inverts -- the race the round exists
 *                        to close, put back.
 *   no_snapshot          the close snapshots nothing. Silence: no row, no
 *                        event, no figure, and a report over an empty table.
 *   snapshot_includes_closed
 *                        the snapshot stops filtering on `exit_at IS NULL`, so
 *                        cars that left last week are candidates for this
 *                        exit.
 *   descriptor_in_event  the `shadow_search` event carries the exit descriptor.
 *                        Tens of kilobytes per exit into a table that is
 *                        append-only by grant and outside the retention purge.
 *   unknown_outcome_recorded
 *                        an outcome outside the identity service's closed set
 *                        is written through instead of refused.
 *   tie_is_a_match       a tie that includes the true stay is counted in the
 *                        match rate. A search that names two cars has not
 *                        identified one.
 *   rate_over_all_exits  the rates divide by every exit instead of the rows
 *                        where the true stay was comparable -- a figure with
 *                        no oracle behind part of its denominator, which the
 *                        brief says may not be published.
 *   retention_skips_shadow
 *                        the purge redacts the vehicle and leaves the shadow
 *                        row pointing at its stay. The reassuring direction:
 *                        it still reports rows redacted.
 *   retention_drops_outcome
 *                        the purge nulls the outcome with the references. The
 *                        figure disappears with the identity, and a report
 *                        run after the window shows fewer exits than there
 *                        were.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SNAPSHOT_BLOCK = `        if (exitDescriptor !== null) {
          await enqueueShadowSearch(client, tenantId, {
            garageId,
            sessionId: open.id,
            exitLaneId: laneId,
            closeEventId: String(closeEventId),
          });
        }

        const closed = await repo.closeSession(client, tenantId, open.id, {
          exitAt,
          laneId,
          closeEventId: String(closeEventId),
          exitConfirmation,
          exitDescriptor,
          pricing,
          entitlement: asked.record,
          decidedBy,
          decisionInputs,
        });
`;

const BREAKS = [
  {
    name: 'snapshot_after_close',
    why: 'the snapshot is taken after exit_at is written',
    file: 'src/app.js',
    from: SNAPSHOT_BLOCK,
    to: `        const closed = await repo.closeSession(client, tenantId, open.id, {
          exitAt,
          laneId,
          closeEventId: String(closeEventId),
          exitConfirmation,
          exitDescriptor,
          pricing,
          entitlement: asked.record,
          decidedBy,
          decisionInputs,
        });

        if (exitDescriptor !== null) {
          await enqueueShadowSearch(client, tenantId, {
            garageId,
            sessionId: open.id,
            exitLaneId: laneId,
            closeEventId: String(closeEventId),
          });
        }
`,
  },
  {
    name: 'no_snapshot',
    why: 'the close snapshots nothing',
    file: 'src/app.js',
    from: '        if (exitDescriptor !== null) {\n          await enqueueShadowSearch(',
    to: '        if (false) {\n          await enqueueShadowSearch(',
  },
  {
    name: 'snapshot_includes_closed',
    why: 'stays that have exited are candidates',
    file: 'src/candidates.js',
    from: `      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL
      ORDER BY s.entry_at, s.id\`,
    [tenantId, garageId],
  );
  return {
    ids:`,
    to: `      WHERE s.tenant_id = $1 AND s.garage_id = $2
      ORDER BY s.entry_at, s.id\`,
    [tenantId, garageId],
  );
  return {
    ids:`,
  },
  {
    name: 'descriptor_in_event',
    why: 'the shadow_search event carries the exit descriptor',
    file: 'src/shadow.js',
    from: "        actor: 'platform:shadow',",
    to: "        actor: 'platform:shadow',\n        exit_descriptor: row.exit_descriptor,",
  },
  {
    name: 'unknown_outcome_recorded',
    why: 'an outcome outside the closed set is written through',
    file: 'src/shadow.js',
    from: '    if (!OUTCOMES.has(record.outcome)) {',
    to: '    if (false) {',
  },
  {
    name: 'tie_is_a_match',
    why: 'a tie that includes the true stay counts as a match',
    file: 'src/shadow.js',
    from: `                                 AND outcome = 'match'
                                 AND true_stay_matched)                   AS true_stay_matched,`,
    to: `                                 AND true_stay_matched)                   AS true_stay_matched,`,
  },
  {
    name: 'rate_over_all_exits',
    why: 'the rates divide by every exit instead of the comparable rows',
    file: 'src/shadow.js',
    from: '    const rate = (n) => (r.comparable > 0 ? n / r.comparable : null);',
    to: '    const rate = (n) => (r.exits > 0 ? n / r.exits : null);',
  },
  {
    name: 'retention_skips_shadow',
    why: 'the purge leaves the shadow row pointing at a redacted stay',
    file: 'src/retention.js',
    from: `          WHERE sh.tenant_id = $1 AND sh.redacted_at IS NULL
            AND sh.session_id IN (SELECT s.id FROM sessions s WHERE s.vehicle_id = ANY($2::uuid[]))\`,`,
    to: `          WHERE sh.tenant_id = $1 AND sh.redacted_at IS NULL AND false
            AND sh.session_id IN (SELECT s.id FROM sessions s WHERE s.vehicle_id = ANY($2::uuid[]))\`,`,
  },
  {
    name: 'retention_drops_outcome',
    why: 'the purge nulls the outcome with the references',
    file: 'src/retention.js',
    from: `            SET session_id = NULL, candidate_ids = NULL, matched_ids = NULL,
                redacted_at = COALESCE($3::timestamptz, now())`,
    to: `            SET session_id = NULL, candidate_ids = NULL, matched_ids = NULL,
                outcome = NULL, true_stay_matched = NULL, searched_at = NULL, counts = NULL,
                redacted_at = COALESCE($3::timestamptz, now())`,
  },
];

const SUITE = ['--test', 'test/shadow.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-shadow-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, SUITE, {
    cwd: dir,
    env: process.env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  return `${line('pass')} passed, ${line('fail')} failed`;
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

console.log('\n== control B: each break must make it FAIL ==');
for (const brk of BREAKS) {
  const dir = stage();
  try {
    const path = join(dir, brk.file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(brk.from)) {
      console.error(`  ${brk.name.padEnd(24)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    writeFileSync(path, source.replace(brk.from, brk.to));
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(24)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
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
console.log('\nall controls OK — the suite fails on every property the shadow run rests on.');
