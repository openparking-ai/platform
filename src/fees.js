/**
 * Fee calculation. Calculation only -- no payment is taken anywhere in this
 * codebase, and no card number reaches it.
 */
import { assertMinor } from './money.js';

/**
 * Billable hours for a stay, rounded up.
 *
 * Any part-hour is charged as a full hour, which is the ordinary convention for
 * an hourly garage rate. A stay of zero elapsed time is zero hours and so free;
 * there is no minimum charge, because a minimum charge is a pricing decision
 * nobody has made and inventing one here would hide it.
 */
export function billableHours(entryAt, exitAt) {
  const ms = exitAt.getTime() - entryAt.getTime();
  if (ms < 0) throw new RangeError('exit_at is before entry_at');
  const minutes = Math.ceil(ms / 60_000);
  return Math.ceil(minutes / 60);
}

/**
 * @returns {{ hours: number, feeMinor: number }}
 */
export function computeFee({ entryAt, exitAt, hourlyMinor }) {
  assertMinor(hourlyMinor, 'hourly_minor');
  const hours = billableHours(entryAt, exitAt);
  return { hours, feeMinor: assertMinor(hours * hourlyMinor, 'fee_minor') };
}
