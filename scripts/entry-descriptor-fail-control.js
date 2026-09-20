#!/usr/bin/env node
/**
 * The control for the entry descriptor (migration 0009).
 *
 * A session now carries the appearance descriptor its entry read produced, and
 * the exit will search over those. Every property that makes holding one safe
 * rather than merely possible is broken below, one at a time, and the suite is
 * REQUIRED to go red. A pass is the failure.
 *
 * Every break is applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 *
 *   silently_dropped     the route goes back to ignoring the field. This is the
 *                        defect the round exists for: a lane sending a
 *                        descriptor gets 201 and nothing reports the loss. The
 *                        echo is what makes it visible, so the echo is what
 *                        this break must turn red.
 *   not_stored           the route reads and echoes nothing false, but the
 *                        INSERT writes null. The lane is satisfied and the exit
 *                        has nothing to search.
 *   not_echoed           stored, and stripped from the response. To the lane
 *                        that is a platform older than the column, and it
 *                        treats the open as not delivered -- correctly, which
 *                        is why the echo is a contract term.
 *   unbounded            any value is a descriptor: a number, an array, a blank,
 *                        a megabyte. It is stored per stay and compared against
 *                        every open stay at the exit.
 *   retention_keeps_it   the purge redacts the vehicle and leaves the descriptor
 *                        on its sessions. The reassuring direction: it still
 *                        reports rows redacted, and one specific car's
 *                        appearance outlives every other piece of its identity.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const BREAKS = [
  {
    name: 'silently_dropped',
    why: 'the open ignores the descriptor again, as it did before 0009',
    file: 'src/app.js',
    from: '      const entryDescriptor = descriptorField(req.body?.descriptor);',
    to: '      const entryDescriptor = null;',
  },
  {
    name: 'not_stored',
    why: 'the INSERT writes null for the descriptor the route accepted',
    file: 'src/repository.js',
    from: `      [tenantId, garageId, vehicleId, laneId, entryAt, currency, openEventId, entryConfirmation,
       entryDescriptor],`,
    to: `      [tenantId, garageId, vehicleId, laneId, entryAt, currency, openEventId, entryConfirmation,
       null],`,
  },
  {
    name: 'not_echoed',
    why: 'the response strips the descriptor the row carries',
    file: 'src/app.js',
    from: `function presentSession(s) {
  return {
    ...s,`,
    to: `function presentSession(s) {
  return {
    ...s,
    entry_descriptor: undefined,`,
  },
  {
    name: 'unbounded',
    why: 'any value at all is accepted as a descriptor',
    file: 'src/app.js',
    from: "  if (typeof value !== 'string' || value.trim() === '' || value.length > DESCRIPTOR_MAX) {",
    to: '  if (false) {',
  },
  {
    name: 'retention_keeps_it',
    why: 'the purge redacts the vehicle and leaves its sessions\' descriptors',
    file: 'src/retention.js',
    from: '    if (rows.length) {',
    to: '    if (false) {',
  },
];

const SUITE = ['--test', 'test/entry-descriptor.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-e1-descriptor-control-'));
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
      // A break whose anchor has moved applies nothing, and the run then
      // reports a passing suite as a failed control for the wrong reason.
      console.error(`  ${brk.name.padEnd(20)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    writeFileSync(path, source.replace(brk.from, brk.to));
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(20)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(20)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property the entry descriptor rests on.');
