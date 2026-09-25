#!/usr/bin/env node
/**
 * No commercial value of any one deployment may appear in this repository.
 *
 * This platform can take card payments into ONE processor account (whoever runs
 * it), optionally as a charge on an account it onboarded, with an optional
 * platform fee. The FIELDS that make that work are public vocabulary and are
 * written in the code: `application_fee_amount`, `Stripe-Account`, a connected
 * account id column. The VALUES are one deployment's configuration and never
 * belong here: a platform account id, a Connect client id, an onboarding
 * return or refresh URL, a fee figure, any key.
 *
 * Its subject is commercial values. Personal data is check-no-real-data.js's,
 * and the two are kept apart on purpose: a guard's name is not its predicate,
 * and one guard stretched over two subjects ends up proving neither.
 *
 * Usage:
 *   check-no-commercial-values.js               scan every tracked file, and
 *                                               every commit message
 *   check-no-commercial-values.js BASE..HEAD    ... in that range only
 *   check-no-commercial-values.js --self-test   prove the scan can fail
 *
 * ---------------------------------------------------------------------------
 * TWO RULES, BECAUSE ONE CANNOT COVER BOTH KINDS OF VALUE
 * ---------------------------------------------------------------------------
 * 1. SHAPE. A processor object id or key has a recognisable shape -- a prefix
 *    and a run of letters and digits. Any such value is refused unless it is
 *    OBVIOUSLY INVENTED: the part after the prefix starts with one of the
 *    words in INVENTED. This needs no list of what is real, so it catches an
 *    account id nobody thought to write down, including a connected account's.
 * 2. DIGEST. A URL has no such shape: every URL in a README is URL-shaped. The
 *    specific values of a deployment are therefore held as sha256, exactly as
 *    check-no-real-data.js holds the addresses it protects, and every URL and
 *    id-shaped token is digested and compared. The report prints the digest
 *    and never the value.
 *
 * WHAT THE SELF-TEST PROVES, AND WHAT IT DOES NOT. It proves the MECHANISM:
 * that a value whose digest is on the list is found, in a real file, and
 * rejected; that a real-looking id is rejected by shape; and that the field
 * names are NOT. It cannot prove that any particular digest is the digest of
 * the right value -- nothing inside this repository can, because that would
 * require the value. Those digests were derived from the private source and
 * their count is recorded there and asserted below. Stated rather than glossed,
 * because a control that proves less than it appears to is the failure this
 * project catalogues.
 *
 * A REPORT NEVER PRINTS A VALUE. CI logs of a public repository are public; a
 * guard that echoed the account id it caught would publish it one step later.
 * A shape hit prints its prefix and length, a digest hit its digest.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * sha256 of each forbidden value, trimmed and lowercased.
 *
 * GENERATED, NOT HAND-KEPT, from the maintainer's private source, and checked
 * against it there. See the header for what the self-test does and does not
 * establish about them.
 */
const FORBIDDEN_DIGESTS = new Map([
  ['4a71880669cd527ecd1b15b99a8eac3e34d07d0d70cc0a9c43bd58d85e27602a', 'the platform account id of a deployment'],
]);

//: The number of values the private source held when this block was
//: generated. A digest deleted by hand -- the one edit nothing else here could
//: notice, because every digest is opaque -- is caught by this.
const EXPECTED_DIGEST_COUNT = 1;

/** Processor object ids and keys, by shape. Prefix, then the value. */
const SHAPES = [
  { re: /\b(acct)_([A-Za-z0-9]{12,})\b/g, what: 'a processor account id' },
  { re: /\b(ca)_([A-Za-z0-9]{20,})\b/g, what: 'a Connect client id' },
  { re: /\b((?:sk|rk|pk)_(?:live|test))_([A-Za-z0-9]{8,})\b/g, what: 'a processor key' },
  { re: /\b(whsec)_([A-Za-z0-9]{8,})\b/g, what: 'a webhook signing secret' },
];

/**
 * The part after the prefix STARTS with one of these, case-insensitively, and
 * the value is plainly made up. Starting with, not containing: a random
 * 24-character id contains a four-letter word often enough to matter; it
 * begins with one about one time in a million, and a value built to look
 * invented is a choice somebody made, not an accident.
 */
const INVENTED = ['example', 'stub', 'invented', 'fake'];

const URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]{}\\]+/g;

const digestOf = (value) => createHash('sha256').update(value.trim().toLowerCase()).digest('hex');

//: This file holds digests, never values, so it scans itself like any other.
//: LICENSE and a lockfile stay out: neither is ours to edit.
const SKIP = /^(LICENSE|package-lock\.json)$/;

/** Every value in `text` a deployment could have leaked: URLs and id-shaped tokens. */
function candidates(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) out.push(m[0].replace(/[.,;:!?]+$/, ''));
  for (const { re } of SHAPES) for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

/** Report every forbidden value in `text`. Never prints the value. */
function scan(where, text, digests = FORBIDDEN_DIGESTS) {
  const failures = [];
  const seen = new Set();
  for (const value of candidates(text)) {
    const digest = digestOf(value);
    if (digests.has(digest) && !seen.has(digest)) {
      seen.add(digest);
      failures.push(`${where}: ${digests.get(digest)} (sha256 ${digest.slice(0, 16)}...)`);
    }
  }
  for (const { re, what } of SHAPES) {
    for (const m of text.matchAll(re)) {
      const rest = m[2].toLowerCase();
      if (INVENTED.some((word) => rest.startsWith(word))) continue;
      failures.push(`${where}: ${what} that is not obviously invented (${m[1]}_..., ${m[0].length} chars)`);
    }
  }
  return failures;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !SKIP.test(f));
}

/** Every commit message in `range`, so a value cannot arrive through git metadata. */
function commitMessages(range) {
  const args = ['log', '--format=%H%x1f%B%x1e'];
  if (range) args.push(range);
  let out;
  try {
    out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    //: An unborn branch has no messages, and that is the only failure
    //: swallowed. Anything else treated as "no commits" would be a check that
    //: cannot produce a negative result.
    if (String(error.stderr ?? '').includes('does not have any commits yet')) return [];
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

//: The planted values are ASSEMBLED AT RUNTIME, never written out: this file
//: is inside the scanned set, and a real-looking literal here would make the
//: guard refuse its own source.
const PLANTED_URL = ['https:/', 'onboarding.a-deployment.example-not', 'connect', 'return'].join('/');
const PLANTED_ACCOUNT = ['acct', '1Qz8RealLooking42x'].join('_');
const PLANTED_KEY = ['rk', 'test', '51Hx9RealLookingKeyMaterial0'].join('_');
const INVENTED_ACCOUNT = ['acct', 'stub0000000000001'].join('_');

function selfTest() {
  const digests = new Map([
    [digestOf(PLANTED_URL), 'the self-test planted URL'],
    [digestOf(PLANTED_ACCOUNT), 'the self-test planted account id'],
  ]);
  const path = `.self-test-${process.pid}.tmp`;
  const run = (text) => {
    writeFileSync(path, text);
    return scan(path, readFileSync(path, 'utf8'), digests);
  };

  let url;
  let urlInProse;
  let account;
  let key;
  let fieldNames;
  let invented;
  let otherUrl;
  try {
    // A VALUE, planted. Never a field name: a guard that fires on a field name
    // proves the wrong thing and forbids the code it exists to allow.
    url = run(`return_url: '${PLANTED_URL}'\n`);
    //: Sentence punctuation after a URL must not hide it.
    urlInProse = run(`Onboarding comes back to ${PLANTED_URL}.\n`);
    //: Caught twice over: by digest, and by shape.
    account = run(`const platform = '${PLANTED_ACCOUNT}';\n`);
    //: A key nobody listed is caught by shape alone.
    key = run(`STRIPE_KEY=${PLANTED_KEY}\n`);
    // The FIELDS are public vocabulary and must pass.
    fieldNames = run(
      "body.application_fee_amount = fee; headers['Stripe-Account'] = row.connected_account_id;\n" +
        'refresh_url and return_url come from CONNECT_REFRESH_URL and CONNECT_RETURN_URL.\n',
    );
    // An obviously invented id passes; so does a URL nobody listed.
    invented = run(`account: '${INVENTED_ACCOUNT}'\n`);
    otherUrl = run('See https://docs.stripe.com/terminal/features/connect for the constraints.\n');
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }

  const want = [
    ['planted URL', url.length, 1],
    ['planted URL ending a sentence', urlInProse.length, 1],
    ['planted account id (digest + shape)', account.length, 2],
    ['unlisted key, by shape', key.length, 1],
    ['field names', fieldNames.length, 0],
    ['invented account id', invented.length, 0],
    ['unlisted URL', otherUrl.length, 0],
  ];
  const bad = want.filter(([, got, expected]) => got !== expected);
  if (bad.length) {
    console.error('self-test FAILED — this guard cannot be trusted.');
    for (const [name, got, expected] of want) console.error(`  ${name}: ${got} (want ${expected})`);
    return false;
  }
  console.log('self-test OK — a planted URL, account id and key fail; the field names,');
  console.log('               an invented id and an unlisted URL pass.');
  return true;
}

function main() {
  if (FORBIDDEN_DIGESTS.size !== EXPECTED_DIGEST_COUNT) {
    console.error(
      `this guard holds ${FORBIDDEN_DIGESTS.size} digests and declares ${EXPECTED_DIGEST_COUNT}. ` +
        'A value has been added or removed without the count moving with it. Regenerate from ' +
        'the private source rather than editing either by hand.',
    );
    process.exit(1);
  }
  if (process.argv[2] === '--self-test') process.exit(selfTest() ? 0 : 1);

  const range = process.argv[2];
  const failures = [];
  for (const file of trackedFiles()) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // not text
    }
    failures.push(...scan(file, text));
  }
  for (const { where, text } of commitMessages(range)) failures.push(...scan(where, text));

  if (failures.length) {
    console.error('A commercial value of a deployment appears in this repository:\n');
    for (const line of failures) console.error(`  ${line}`);
    console.error('\nThe fields are public; their values are deployment configuration. Use an');
    console.error(`invented value (${INVENTED.map((w) => `acct_${w}...`).join(', ')}) in code, tests and docs.`);
    process.exit(1);
  }
  console.log(
    `clean — ${trackedFiles().length} tracked files and the commit messages carry no commercial value ` +
      `(${FORBIDDEN_DIGESTS.size} digests, ${SHAPES.length} shapes).`,
  );
}

main();
