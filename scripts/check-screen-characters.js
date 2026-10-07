#!/usr/bin/env node
/**
 * THE SCREEN'S CHARACTERS, CHECKED AGAINST THE SCREEN (U4c, rule 7).
 *
 * `src/screen-characters.json` is this platform's copy of what a lane's
 * screen can draw: the keys of `GLYPHS` and `ACCENTED` in gate-agent's
 * `src/gate_agent/font.py`, at the commit the file names. This reads that
 * file at that commit and requires the two to be the same set. A character
 * in the copy and not the font would let an owner write a message the screen
 * shows with a gap; one in the font and not the copy refuses a message the
 * screen could show. Either is red, naming the characters.
 *
 * gate-agent holds the same check the other way round (its own
 * `scripts/check_screen_characters.py`, against this file at a platform
 * commit), so a character added on either side alone goes red on that side.
 *
 *   node scripts/check-screen-characters.js              the check
 *   node scripts/check-screen-characters.js --self-test  plants one character
 *        on each side, in memory, and requires each to be caught, before the
 *        real comparison is trusted
 *   --font <path>   read the font from a file instead of fetching it
 *   --copy <path>   read the copy from a file instead of src/
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

/** The keys of one `NAME: ... = {` table of font.py, each one character in double quotes. */
export function tableKeys(source, name) {
  const start = source.search(new RegExp(`^${name}\\b[^\\n]*=\\s*\\{\\s*$`, 'm'));
  if (start < 0) throw new Error(`font.py has no ${name} table`);
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error(`font.py's ${name} table does not end`);
  const keys = [];
  for (const m of source.slice(start, end).matchAll(/^\s+"((?:\\.|[^"\\])+)":/gm)) {
    const key = JSON.parse(`"${m[1]}"`);
    if ([...key].length !== 1) throw new Error(`font.py's ${name} has a key that is not one character: ${JSON.stringify(key)}`);
    keys.push(key);
  }
  if (keys.length === 0) throw new Error(`font.py's ${name} table has no keys`);
  return keys;
}

/** What the font draws: GLYPHS and ACCENTED together, as `font.DRAWABLE` derives it. */
export const fontCharacters = (source) => new Set([...tableKeys(source, 'GLYPHS'), ...tableKeys(source, 'ACCENTED')]);

/** The differences, both ways: [only in the copy, only in the font]. */
export function drift(copy, font) {
  const c = new Set([...copy]);
  return [[...c].filter((x) => !font.has(x)).sort(), [...font].filter((x) => !c.has(x)).sort()];
}

const say = (list) => list.map((x) => JSON.stringify(x)).join(', ');

async function main() {
  const file = JSON.parse(readFileSync(opt('--copy') ?? resolve(ROOT, 'src/screen-characters.json'), 'utf8'));
  const { repo, commit, path } = file.source;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`the copy names ${JSON.stringify(commit)}: a full commit is required, so the check reads one fixed font`);
  let source;
  if (opt('--font')) source = readFileSync(opt('--font'), 'utf8');
  else {
    const url = `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    source = await res.text();
  }
  const font = fontCharacters(source);

  if (args.includes('--self-test')) {
    const [a0, b0] = drift(file.characters, font);
    if (a0.length || b0.length) throw new Error('self-test: the copy and the font differ before anything was planted; run the check');
    const [extraCopy] = drift(`${file.characters}€`, font);
    const planted = source.replace(/^(GLYPHS\b[^\n]*=\s*\{\s*)$/m, '$1\n    "#": (".....",),');
    const [, extraFont] = drift(file.characters, fontCharacters(planted));
    const caught = extraCopy.join('') === '€' && extraFont.join('') === '#';
    console.log(`self-test: a character only in the copy ${extraCopy.join('') === '€' ? 'caught' : 'MISSED'}; only in the font ${extraFont.join('') === '#' ? 'caught' : 'MISSED'}`);
    if (!caught) process.exit(1);
    return;
  }

  const [onlyCopy, onlyFont] = drift(file.characters, font);
  if (onlyCopy.length || onlyFont.length) {
    if (onlyCopy.length) console.error(`in the platform's copy and not in the screen's font (${repo}@${commit.slice(0, 7)} ${path}): ${say(onlyCopy)}`);
    if (onlyFont.length) console.error(`in the screen's font (${repo}@${commit.slice(0, 7)} ${path}) and not in the platform's copy: ${say(onlyFont)}`);
    process.exit(1);
  }
  console.log(`the platform's copy is the screen's font: ${font.size} characters, ${repo}@${commit.slice(0, 7)} ${path}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
