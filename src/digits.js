/**
 * DIGITS OF ANY SCRIPT (U4b fix round): what "a number" is, wherever a
 * person's phone number must not get through.
 *
 * A phone number can be written in many ways: with commas or slashes between
 * its digits, with letters between them, in full-width digits, in
 * Arabic-Indic or Devanagari digits. Every check that looks for one reads the
 * text the same way:
 *
 *   1  Unicode compatibility normalisation (NFKC): full-width, circled,
 *      superscript and mathematical digits become plain ones, and a
 *      full-width or small `@` becomes `@`;
 *   2  every decimal digit of any script is read as its value, 0 to 9;
 *   3  everything else is dropped -- whatever stands between the digits.
 *
 * THE DIGITS are this table, not the running engine's idea of them: the
 * database's rule (0029) is built from the same table, so the route and the
 * database refuse exactly the same names whatever Unicode version each runs.
 * Each entry is a script's zero; its nine follow it. The table holds every
 * decimal digit of Unicode 17 (test/alerts.test.js checks that the running
 * engine knows of none it lacks).
 */

export const DIGIT_ZEROS = Object.freeze([
  0x30, 0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6, 0xD66, 0xDE6, 0xE50, 0xED0,
  0xF20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90, 0x1B50, 0x1BB0, 0x1C40, 0x1C50, 0xA620,
  0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0, 0xFF10, 0x104A0, 0x10D30, 0x10D40, 0x11066, 0x110F0, 0x11136,
  0x111D0, 0x112F0, 0x11450, 0x114D0, 0x11650, 0x116C0, 0x116D0, 0x116DA, 0x11730, 0x118E0, 0x11950, 0x11BF0,
  0x11C50, 0x11D50, 0x11DA0, 0x11DE0, 0x11F50, 0x16130, 0x16A60, 0x16AC0, 0x16B50, 0x16D70, 0x1CCF0, 0x1D7CE,
  0x1D7D8, 0x1D7E2, 0x1D7EC, 0x1D7F6, 0x1E140, 0x1E2F0, 0x1E4F0, 0x1E5F1, 0x1E950, 0x1FBF0,
]);

/** A digit's value, 0 to 9, or -1 when the code point is not a digit. */
export function digitValue(cp) {
  for (const zero of DIGIT_ZEROS) if (cp >= zero && cp <= zero + 9) return cp - zero;
  return -1;
}

/** The text's digits, of any script, as plain 0-9, in order: everything between them dropped. */
export function digitsOf(text) {
  let out = '';
  for (const ch of String(text).normalize('NFKC')) {
    const v = digitValue(ch.codePointAt(0));
    if (v >= 0) out += v;
  }
  return out;
}

/** The most digits a person's name may hold: 7 or more could be a phone number. */
export const NAME_DIGITS_MAX = 6;

/** Whether the text could hold a phone number or an email address, however it is written. */
export function holdsContactShape(text) {
  return String(text).normalize('NFKC').includes('@') || digitsOf(text).length > NAME_DIGITS_MAX;
}

/** The same digits as a Postgres regular-expression bracket's contents: 0029 is built from it. */
export function sqlDigitClass() {
  const esc = (cp) => (cp > 0xFFFF ? `\\U${cp.toString(16).toUpperCase().padStart(8, '0')}` : `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`);
  return DIGIT_ZEROS.map((z) => `${esc(z)}-${esc(z + 9)}`).join('');
}
