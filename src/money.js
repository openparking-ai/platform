/**
 * Money is an integer of minor units (cents). Never numeric, never a float.
 *
 * The reason this file exists rather than being inlined: node-pg returns BOTH
 * `numeric` and `bigint` as JavaScript strings, while `int` comes back as a
 * number. So `row.fee_minor + row.hourly_minor` concatenates two strings and
 * looks like it worked. Every value crossing the database boundary goes
 * through here.
 */

const MAX = Number.MAX_SAFE_INTEGER;

/** Parse a minor-unit value as it arrives from pg (string) or from JSON (number). */
export function toMinor(value, label = 'amount') {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return assertMinor(value, label);
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) throw new TypeError(`${label} is not an integer string: ${value}`);
    return assertMinor(Number(value), label);
  }
  throw new TypeError(`${label} has unusable type ${typeof value}`);
}

export function assertMinor(n, label = 'amount') {
  if (!Number.isInteger(n)) throw new TypeError(`${label} must be a whole number of minor units, got ${n}`);
  if (Math.abs(n) > MAX) throw new RangeError(`${label} exceeds safe integer range`);
  return n;
}

/** For display only. Never feed the result back into arithmetic. */
export function formatMinor(minor, currency) {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')} ${currency}`;
}
