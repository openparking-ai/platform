#!/usr/bin/env node
/**
 * The sweep's exit code is the only way anyone hears of a charge written down,
 * so it is measured: the script run twice, its code required to match what it
 * printed. The first run reports what is waiting (`--expect-charges`: there must
 * be some) and exits 1 for it; the second has nothing left and exits 0. Always 0
 * fails the first, always 1 the second (`scripts/exit-payments-fail-control.js`).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, 'sweep-exit-payments.js');
const LINE = /^exit payments: \d+ tenant\(s\); (\d+) read, \d+ recorded paid, (\d+) written down, (\d+) left for the next run\.( .*)?$/m;

function refuse(why, r) {
  console.error(`sweep exit check: ${why}\n${r?.stdout ?? ''}${r?.stderr ?? ''}`);
  process.exit(1);
}

function run() {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  const m = r.stdout.match(LINE);
  if (!m) refuse('no line of counts', r);
  const [written, left] = [Number(m[2]), Number(m[3])];
  if (left !== 0) refuse(`${left} left for the next run`, r);
  if (r.status !== (written > 0 ? 1 : 0)) refuse(`exit ${r.status} with ${written} written down`, r);
  console.log(`${m[0]} (exit ${r.status})`);
  return { written, r };
}

const first = run();
if (process.argv.includes('--expect-charges') && first.written === 0) refuse('there were charges waiting, and none was reported', first.r);
const second = run();
if (second.written !== 0) refuse('a charge was reported twice', second.r);
