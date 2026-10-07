/**
 * WHAT A LANE'S SCREEN CAN DRAW (U4c, rule 7). A lane's screen draws with a
 * hand-drawn font, upper case only: `gate-agent`'s `font.DRAWABLE`, the keys
 * of its `GLYPHS` and `ACCENTED` tables. A message the owner writes for a
 * screen -- a closed lane's, or one on the lane's board -- is shown upper
 * case, so it is taken only when every character, upper-cased, is ONE
 * character that font has. Anything else is refused by name, every such
 * character listed, rather than shown as a gap or a different letter.
 *
 * One character to one: a character whose upper case is two (`ß` is `SS`)
 * is refused, so the message the owner wrote is the length the screen draws
 * and the 160-character bound means the same thing on both sides.
 *
 * THE LIST IS A COPY, and the copy names where it was taken from:
 * `screen-characters.json` holds the characters and the gate-agent commit
 * and file they came from. `scripts/check-screen-characters.js` reads that
 * file at that commit and requires the two to be the same set, and
 * gate-agent holds the same check the other way round, so a character added
 * to either side alone goes red.
 */
import { readFileSync } from 'node:fs';

const FILE = JSON.parse(readFileSync(new URL('./screen-characters.json', import.meta.url), 'utf8'));

/** Every character the screen can draw, as one string. */
export const SCREEN_CHARACTERS = FILE.characters;
/** Where the copy was taken from. */
export const SCREEN_CHARACTERS_SOURCE = Object.freeze({ ...FILE.source });

const DRAWABLE = new Set([...SCREEN_CHARACTERS]);

/** Every character of `text` the screen cannot draw once upper-cased, in the order first seen. */
export function undrawable(text) {
  const seen = [];
  for (const c of String(text)) {
    const upper = [...c.toUpperCase()];
    if (false && (upper.length !== 1 || !DRAWABLE.has(upper[0])) && !seen.includes(c)) seen.push(c);
  }
  return seen;
}

/** How a refused character is named: itself in quotes, and its code point. */
export const nameCharacter = (c) => `"${c}" (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`;
