import test from 'node:test';
import assert from 'node:assert/strict';
import { billableHours, computeFee } from '../src/fees.js';
import { toMinor, assertMinor, formatMinor } from '../src/money.js';

const at = (iso) => new Date(iso);

test('a part hour is charged as a full hour', () => {
  assert.equal(billableHours(at('2026-08-26T10:00:00Z'), at('2026-08-26T10:01:00Z')), 1);
  assert.equal(billableHours(at('2026-08-26T10:00:00Z'), at('2026-08-26T11:00:00Z')), 1);
  assert.equal(billableHours(at('2026-08-26T10:00:00Z'), at('2026-08-26T11:00:01Z')), 2);
});

test('a zero-length stay is free, with no invented minimum charge', () => {
  assert.equal(billableHours(at('2026-08-26T10:00:00Z'), at('2026-08-26T10:00:00Z')), 0);
  assert.equal(computeFee({ entryAt: at('2026-08-26T10:00:00Z'), exitAt: at('2026-08-26T10:00:00Z'), hourlyMinor: 250 }).feeMinor, 0);
});

test('exiting before entering is refused rather than producing a negative fee', () => {
  assert.throws(() => billableHours(at('2026-08-26T11:00:00Z'), at('2026-08-26T10:00:00Z')), RangeError);
});

test('a fee is hours times the hourly rate, in minor units', () => {
  const { hours, feeMinor } = computeFee({
    entryAt: at('2026-08-26T09:00:00Z'),
    exitAt: at('2026-08-26T12:30:00Z'),
    hourlyMinor: 250,
  });
  assert.equal(hours, 4);
  assert.equal(feeMinor, 1000);
});

test('elapsed time is unaffected by the garage crossing a DST boundary', () => {
  // 2026-11-01 is the US fall-back. Stored UTC, so the elapsed time is simply
  // elapsed time; the local clock going backwards is a display concern.
  const { hours } = computeFee({
    entryAt: at('2026-11-01T05:00:00Z'),
    exitAt: at('2026-11-01T08:00:00Z'),
    hourlyMinor: 100,
  });
  assert.equal(hours, 3);
});

test('money arriving from pg as a string is parsed, never concatenated', () => {
  // node-pg returns bigint AND numeric as strings. This is the trap money.js exists for.
  assert.equal(toMinor('1234'), 1234);
  assert.equal(toMinor(1234), 1234);
  assert.equal(toMinor(null), null);
  assert.equal(toMinor('250') + toMinor('250'), 500, 'string money would have produced "250250"');
});

test('a non-integer amount is refused', () => {
  assert.throws(() => assertMinor(12.5), TypeError);
  assert.throws(() => toMinor('12.50'), TypeError);
  assert.throws(() => toMinor({}), TypeError);
});

test('formatting is for display only', () => {
  assert.equal(formatMinor(1000, 'USD'), '10.00 USD');
  assert.equal(formatMinor(5, 'USD'), '0.05 USD');
});
