#!/usr/bin/env node
/**
 * Time one scrypt hash across candidate cost factors, on THIS machine.
 *
 *   node scripts/measure-scrypt.js                 the table, and the pick
 *   node scripts/measure-scrypt.js --budget-ms 250
 *
 * THE PARAMETERS `src/passwords.js` STATES WERE MEASURED, NOT CHOSEN. The
 * method is the one customer-account uses (`scripts/measure_scrypt.py` there):
 * time a single scrypt over the candidates below and take the LARGEST N whose
 * one hash stays under the budget. The number is produced by this command
 * rather than typed, and the receipt that ships it names the machine, because
 * this project has no reference hardware.
 *
 * r and p are held at 8 and 1, the values scrypt's paper and the OWASP cheat
 * sheet hold them at; N is the axis that moves. `maxmem` is stated because
 * Node's default (32 MiB) refuses N above 2**14 at r=8. The parameters are
 * STORED beside every hash, so raising them later invalidates no row.
 */
import { scryptSync, randomBytes } from 'node:crypto';
import { arch, cpus, platform, release } from 'node:os';

const CANDIDATES = [2 ** 12, 2 ** 13, 2 ** 14, 2 ** 15, 2 ** 16, 2 ** 17];
const R = 8;
const P = 1;
const KEYLEN = 64;

function oneHashMs(n) {
  const salt = randomBytes(16);
  const started = process.hrtime.bigint();
  scryptSync('measure-only, never stored', salt, KEYLEN, { N: n, r: R, p: P, maxmem: 128 * R * n * 2 });
  return Number(process.hrtime.bigint() - started) / 1e6;
}

const at = process.argv.indexOf('--budget-ms');
const budget = at === -1 ? 250 : Number(process.argv[at + 1]);
console.log(`machine: ${arch()} ${platform()} ${release()}, ${cpus()[0]?.model ?? 'unknown cpu'}, node ${process.version}`);
console.log(`budget: one hash under ${budget} ms; r=${R} p=${P} keylen=${KEYLEN}`);
console.log(`${'N'.padStart(8)} ${'log2'.padStart(5)} ${'median ms'.padStart(10)}  (5 runs)`);
let pick = null;
for (const n of CANDIDATES) {
  const runs = Array.from({ length: 5 }, () => oneHashMs(n)).sort((a, b) => a - b);
  const median = runs[2];
  console.log(`${String(n).padStart(8)} ${String(Math.log2(n)).padStart(5)} ${median.toFixed(1).padStart(10)}`);
  if (median < budget) pick = n;
}
if (pick === null) {
  console.log('no candidate met the budget; this machine is slower than every value tried');
  process.exit(1);
}
console.log(`\npick: N=2**${Math.log2(pick)} (${pick}), r=${R}, p=${P}, keylen=${KEYLEN}`);
