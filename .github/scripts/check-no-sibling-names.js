#!/usr/bin/env node
/**
 * No name from the maintainer's other, private software may appear in this
 * repository. Not in code, a comment, a document, a test, a fixture, a commit
 * message or a pull request body.
 *
 * Usage:
 *   check-no-sibling-names.js              scan every tracked file, and every
 *                                          tracked file's PATH
 *   check-no-sibling-names.js --self-test  prove the scan can fail
 *   check-no-sibling-names.js --worktree   scan the working tree too: tracked
 *                                          files, files git is not tracking
 *                                          yet, and a built dist/ if there is
 *                                          one -- contents and paths -- with a
 *                                          control planted and caught in the
 *                                          same run first
 *
 * PATHS ARE TEXT TOO. A file's name is in the repository as surely as its
 * contents are, and a guard that read contents only let a private product's
 * name sit in a tracked path of this repository unnoticed. So every path is
 * tokenised and digested exactly as a line is.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FORBIDDEN WORDS ARE NOT WRITTEN DOWN HERE
 * ---------------------------------------------------------------------------
 * A guard that spells out the words it forbids breaks the rule it enforces: the
 * words would then appear in this public repository, in this file. So they are
 * held as sha256 of the lowercased word, exactly as check-no-real-data.js holds
 * the addresses it protects. The report prints the digest and never the word.
 *
 * WHAT THE SELF-TEST PROVES, AND WHAT IT DOES NOT. It proves the MECHANISM:
 * that a token whose digest is on the list is found, in a real file, and
 * rejected. It cannot prove that any particular digest is the digest of the
 * right word -- nothing inside this repository can, because that would require
 * the word. Those digests were derived from the private source and their count
 * is recorded there. Stated rather than glossed, because a control that proves
 * less than it appears to is the failure this project catalogues.
 *
 * ---------------------------------------------------------------------------
 * WHY TOKENS, NOT A REGULAR EXPRESSION
 * ---------------------------------------------------------------------------
 * A substring search is wrong in both directions and both were measured on the
 * sibling repositories before this was written:
 *
 *   - FALSE POSITIVES. One forbidden word is a substring of an ordinary English
 *     word this project uses constantly. A plain search fires on four files
 *     across two sibling repositories, every hit innocent.
 *   - AND A WORD-BOUNDARY REGEX IS NOT THE FIX. BSD `grep -E` -- which is what
 *     `grep` is on the maintainer's machine -- silently matches NOTHING when
 *     three or more `\b`-anchored alternatives are combined. An absence check
 *     built on it reports clean because it cannot match, which is this
 *     project's one disease: evidence that cannot produce a negative result.
 *
 * So the text is TOKENISED instead, and each token is digested whole. Runs of
 * letters are the tokens; digits, punctuation and case transitions all end one,
 * so `oneWordTwo`, `one_word_two` and `one-word-2` all yield the same three.
 * There is no regular expression engine in the decision and nothing to get
 * wrong per-platform.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * sha256 of each forbidden word, lowercased, with no surrounding whitespace.
 *
 * **GENERATED, NOT HAND-KEPT.** The name set lives in the private repository at
 * `ops/openparking-forbidden-names.txt`, and this block is emitted by
 * `ops/gen-forbidden-digests.js` there. It used to be a hand-derived list and it
 * had DRIFTED: it protected six names while the rule named more, and nothing
 * inside this repository could tell -- the digests are opaque by design, so a
 * missing one is invisible from here. That is why the count below is asserted
 * and why the source is named: a reviewer with the private repo can run
 * `--check` against this file, and a reviewer without it can at least see that a
 * digest has gone missing.
 *
 * See the header for what the self-test does and does not establish about them.
 */
const FORBIDDEN_DIGESTS = new Map([
  ['d3e394e67f9131b18092127e96f33a3382d564e6a1659be338fd5f17dfd13594', 'a sibling product name'],
  ['a1b55013d3ee4966ad46cf62d662dad1aacc2d10d49323b74ec635d578dec158', 'a sibling product name'],
  ['8bca6dada231e0fd80bf5ff9ff16aa79de1fb8e7b11cd282c0ea251d78376e9d', 'a sibling product name'],
  ['9261ceef0b969e70ac20f1510f07a1e0d8db05f20c75161a2ef43b4eba27a7aa', 'a sibling product name'],
  ['b1a0d3ef78d71ce5530307f5784a737ef3a8dcf6f36d233f30196ebf955efeae', 'a sibling hostname'],
  ['5ecd2797e0882c8cfdc5fb97c02d66e15a465de46bf5b01fb5e4c3691571108e', 'a sibling hostname'],
  ['fff7f86bf30fe38006e16fec2f446580ee329300a4deb735b02c8d55e95667b0', 'a sibling product name'],
  ['30288cbad7837b2e6d5178df8a944fb2296352c680b2d62c50abc35da91b7b15', 'a sibling product name'],
  ['5e0176c9d2070a5a2a22bf74b4abed303654690d58d64221ccbd022af827abc4', 'a sibling product name'],
  ['f6f6ead0bd85c3127bd5004115a60942d61204561649d9e713bf4f74058de4d1', 'a sibling product name'],
  ['74953c9d406bceeacf22dd9a93605e0a5962858b8cfdbcb7562d429af8b2ae21', 'a sibling hostname'],
]);

//: The number of names the private source held when this block was generated.
//: A digest deleted by hand -- the one edit nothing else here could notice -- is
//: caught by this and nothing else, because every digest is opaque.
//:
//: 12 -> 11: one entry left the private source because it was never within
//: the rule's scope, which names the estate's products and hostnames and
//: nothing about the maintainer personally.
const EXPECTED_DIGEST_COUNT = 11;

if (FORBIDDEN_DIGESTS.size !== EXPECTED_DIGEST_COUNT) {
  console.error(
    `this guard holds ${FORBIDDEN_DIGESTS.size} digests and declares ` +
      `${EXPECTED_DIGEST_COUNT}. A name has been added or removed without the ` +
      `count moving with it. Regenerate from the private source rather than ` +
      `editing either by hand.`,
  );
  process.exit(1);
}

/** The one sanctioned mention of the maintainer, which is an instruction. */
const ATTRIBUTION = 'Built by 72 Knots Method by 72Knots.ai';

//: This file holds digests, never words, so it scans itself like any other.
//: LICENSE and a lockfile stay out: neither is ours to edit.
const SKIP = /^(LICENSE|package-lock\.json)$/;

const digestOf = (value) => createHash('sha256').update(value.trim().toLowerCase()).digest('hex');

/**
 * Every run of letters in `text`, lowercased, with a case transition ending a
 * token as surely as a space does.
 */
export function tokens(text) {
  const out = [];
  let current = '';
  let previousWasLower = false;

  for (const ch of text) {
    const isLetter = /\p{L}/u.test(ch);
    if (!isLetter) {
      if (current) out.push(current.toLowerCase());
      current = '';
      previousWasLower = false;
      continue;
    }
    const isUpper = ch === ch.toUpperCase() && ch !== ch.toLowerCase();
    if (isUpper && previousWasLower && current) {
      out.push(current.toLowerCase());
      current = '';
    }
    current += ch;
    previousWasLower = !isUpper;
  }
  if (current) out.push(current.toLowerCase());
  return out;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !SKIP.test(f));
}

/** Every commit message in `range`, so a name cannot arrive through git metadata. */
function commitMessages(range) {
  const args = ['log', '--format=%H%x1f%B%x1e'];
  if (range) args.push(range);

  let out;
  try {
    out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    //: An unborn branch has no messages to scan, and that is the only failure
    //: swallowed here. Everything else is rethrown, LOUDLY: a `git log` that
    //: fails for any other reason and is treated as "no commits" is a check
    //: that cannot produce a negative result, which is the thing this whole
    //: project exists to keep out.
    const stderr = String(error.stderr ?? '');
    if (stderr.includes('does not have any commits yet')) return [];
    throw error;
  }

  return out
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, body] = chunk.split('\x1f');
      return { where: `commit ${sha.slice(0, 12)}`, text: body ?? '' };
    });
}

/** Report every forbidden token in `text`, by digest. Never prints the token. */
function scan(where, text, digests) {
  const failures = [];
  const seen = new Set();
  for (const token of tokens(text)) {
    const digest = digestOf(token);
    if (!digests.has(digest) || seen.has(digest)) continue;
    seen.add(digest);
    failures.push(`${where}: ${digests.get(digest)} (sha256 ${digest.slice(0, 16)}...)`);
  }
  return failures;
}

/** Report every forbidden token in each PATH, by digest. */
function scanPaths(files, digests) {
  return files.flatMap((file) => scan(`path ${file}`, file, digests));
}

function selfTest() {
  //: A word this repository will never contain, so the control cannot pass by
  //: accident, and no forbidden word is needed to prove the mechanism fires.
  const control = 'zzqxcontrolword';
  const digests = new Map([[digestOf(control), 'the self-test control word']]);
  const path = `.self-test-${process.pid}.tmp`;

  let planted;
  let clean;
  let camel;
  let innocent;
  try {
    writeFileSync(path, `a line that mentions ${control} once\n`);
    planted = scan(path, readFileSync(path, 'utf8'), digests);

    //: The case-transition split is load-bearing: a name hidden inside an
    //: identifier must be found, or the guard is one rename away from blind.
    writeFileSync(path, `const someName = { prefix${control[0].toUpperCase()}${control.slice(1)}Suffix: 1 };\n`);
    camel = scan(path, readFileSync(path, 'utf8'), digests);

    writeFileSync(path, 'a line that mentions nothing of the sort\n');
    clean = scan(path, readFileSync(path, 'utf8'), digests);

    //: And the negative control for the whole tokenising design: a longer word
    //: that CONTAINS the forbidden one must pass. A substring search fails here.
    writeFileSync(path, `a line containing xx${control}yy as one word\n`);
    innocent = scan(path, readFileSync(path, 'utf8'), digests);
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }

  //: The path scan, on the same terms: a directory or file NAMED with the word
  //: is found; a path holding a longer word that contains it is not.
  const namedPath = scanPaths([`test/fixtures/${control}/a.txt`, `docs/x-${control}.md`], digests);
  const innocentPath = scanPaths([`test/fixtures/xx${control}yy/a.txt`], digests);

  const ok =
    planted.length === 1 && camel.length === 1 && clean.length === 0 && innocent.length === 0 &&
    namedPath.length === 2 && innocentPath.length === 0;
  if (!ok) {
    console.error('self-test FAILED — this guard cannot be trusted.');
    console.error(`  planted:  ${planted.length} (want 1)`);
    console.error(`  camel:    ${camel.length} (want 1)`);
    console.error(`  clean:    ${clean.length} (want 0)`);
    console.error(`  innocent: ${innocent.length} (want 0)`);
    console.error(`  path:     ${namedPath.length} (want 2)`);
    console.error(`  innocent path: ${innocentPath.length} (want 0)`);
    return false;
  }
  console.log('self-test OK — a planted name fails, inside an identifier too, and in a path;');
  console.log('               a clean line passes, and so does a longer word containing it.');
  return true;
}

/** Files git is not tracking and not ignoring: what `git add -A` would add. */
function untrackedFiles() {
  return execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !SKIP.test(f));
}

/** A built site, if this repository has one. Ignored by git, and exactly what would be served. */
function builtFiles(dir = 'dist') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? builtFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function scanFiles(files, digests) {
  const failures = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    failures.push(...scan(file, text, digests));
  }
  return failures;
}

/**
 * The working tree, with its positive controls in the same run: one file
 * holding the control word, one file NAMED with it, written into the tree; the
 * same walk must find each where it is and nothing else, and only then is the
 * real walk's result read.
 */
function worktree() {
  //: Assembled at runtime: this file is inside the walk, and the whole word
  //: written here would be caught here, as well as in the planted files.
  const control = ['zzqx', 'inrun', 'control'].join('');
  const planted = `.names-control-${process.pid}.tmp`;
  const named = `.names-${control}-${process.pid}.tmp`;
  const walk = () => [...new Set([...trackedFiles(), ...untrackedFiles(), ...builtFiles()])];
  let caught;
  try {
    writeFileSync(planted, `a line that mentions ${control} once\n`);
    writeFileSync(named, 'a line that mentions nothing of the sort\n');
    const digests = new Map([[digestOf(control), 'the in-run control word']]);
    const files = walk();
    caught = [...scanFiles(files, digests), ...scanPaths(files, digests)];
  } finally {
    for (const f of [planted, named]) {
      try { unlinkSync(f); } catch { /* already gone */ }
    }
  }
  const inContents = caught.filter((l) => l.startsWith(`${planted}:`));
  const inPath = caught.filter((l) => l.startsWith(`path ${named}:`));
  if (caught.length !== 2 || inContents.length !== 1 || inPath.length !== 1) {
    console.error('in-run control FAILED — the working-tree walk cannot be trusted.');
    for (const line of caught) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`in-run control OK — the planted word was caught in ${planted} and in the path ${named}, and nowhere else.`);

  const tracked = trackedFiles();
  const untracked = untrackedFiles();
  const built = builtFiles();
  const files = walk();
  const failures = [...scanFiles(files, FORBIDDEN_DIGESTS), ...scanPaths(files, FORBIDDEN_DIGESTS)];
  for (const { where, text } of commitMessages()) failures.push(...scan(where, text, FORBIDDEN_DIGESTS));
  if (failures.length) {
    console.error('A name from the private estate appears in the working tree:\n');
    for (const line of failures) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(
    `clean — ${tracked.length} tracked, ${untracked.length} untracked and ${built.length} built files, ` +
      'their paths, and every commit message, carry no such name.',
  );
}

function main() {
  if (process.argv[2] === '--self-test') process.exit(selfTest() ? 0 : 1);
  if (process.argv[2] === '--worktree') return worktree();

  const range = process.argv[2];
  const failures = [];

  failures.push(...scanPaths(trackedFiles(), FORBIDDEN_DIGESTS));

  for (const file of trackedFiles()) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // not text; nothing to read a name out of
    }
    failures.push(...scan(file, text, FORBIDDEN_DIGESTS));
  }

  for (const { where, text } of commitMessages(range)) {
    failures.push(...scan(where, text, FORBIDDEN_DIGESTS));
  }

  //: The attribution is an instruction and is checked for PRESENCE, not
  //: absence -- the one sanctioned mention, spelled exactly, no period between
  //: the two halves. It is asserted here rather than in a document so that
  //: deleting it from README.md turns a check red instead of going unnoticed.
  const readme = readFileSync('README.md', 'utf8');
  if (!readme.includes(ATTRIBUTION)) {
    failures.push(`README.md: the attribution line is missing or reworded: "${ATTRIBUTION}"`);
  }

  if (failures.length) {
    console.error('A name from the private estate appears in this repository:\n');
    for (const line of failures) console.error(`  ${line}`);
    console.error('\nNothing outside this project may be named here. See CONTRIBUTING.md.');
    process.exit(1);
  }
  console.log(`clean — ${trackedFiles().length} tracked files, their paths and the commit range carry no such name.`);
}

main();
