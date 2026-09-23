/**
 * A STAND-IN for a validations module's door, for this repository's tests.
 *
 * The real module is not in this repository and never will be (0019: the
 * public repository gets the ability to ask, never the module), so the suite
 * here cannot install it the way it installs garage-pass and monthly-billing.
 * This speaks the door's CONTRACT -- the verbs, the argv, the phone on stdin,
 * the exit codes, the JSON -- and nothing else. It does NOT compute a
 * discount: each validation in its state carries the `discount_minor` it
 * answers, because what this suite tests is what the platform does with an
 * answer, not whether the module's arithmetic is right. That is the module's
 * own suite's question, and the equality of the two systems' money was
 * established against the real module, outside this repository.
 *
 * State is a JSON file named by VALIDATIONS_STANDIN_STATE:
 *   { "mode": "normal" | "exit2" | "refuse_claims" | "bad_money" | "wrong_base",
 *     "garages": { "<tenant>/<garage>": [ { "phone": "2025550143",
 *        "validator_name": "...", "discount_type": "flat",
 *        "discount_value": 5, "discount_minor": 500, "claimed_ref": null } ] } }
 * `release-in-store` gives a claim back (claimed_ref to null), or answers
 * none / superseded as the real door does.
 * Every call is appended to VALIDATIONS_STANDIN_LOG as one JSON line
 * {argv, stdin}, so a test can see what arrived where.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.VALIDATIONS_STANDIN_STATE;
const logPath = process.env.VALIDATIONS_STANDIN_LOG;
const print = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const argv = process.argv.slice(2);
if (logPath) appendFileSync(logPath, `${JSON.stringify({ argv, stdin })}\n`);

if (!statePath) {
  process.stderr.write('VALIDATIONS_STANDIN_STATE is not set.\n');
  process.exit(2);
}
const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (state.mode === 'exit2') {
  process.stderr.write('the database refused: SQLSTATE 57P01: terminating connection\n');
  process.exit(2);
}

const [verb, ...rest] = argv;
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i]] = rest[i + 1];
if ('--phone' in args) {
  print({ refused: 'phone_on_argv', field: '--phone', detail: 'the phone number is read from stdin, never from the command line' });
  process.exit(3);
}
const list = state.garages[`${args['--tenant']}/${args['--garage']}`];
if (!list) {
  print({ refused: 'unknown_garage', field: '--garage', detail: `garage ${args['--garage']} is not a garage of tenant ${args['--tenant']}` });
  process.exit(3);
}
if (verb === 'release-in-store') {
  // No phone: the reference names the claim.
  const held = list.find((v) => v.claimed_ref === args['--ref']);
  if (!held) {
    print({ outcome: 'not_released', reason: 'none' });
    process.exit(1);
  }
  if (list.some((v) => v !== held && v.phone === held.phone && v.claimed_ref === null)) {
    print({ outcome: 'not_released', reason: 'superseded' });
    process.exit(1);
  }
  held.claimed_ref = null;
  writeFileSync(statePath, JSON.stringify(state));
  print({ outcome: 'released', validation_id: 1, live_again: true });
  process.exit(0);
}
const digits = stdin.split('\n')[0].replace(/\D/g, '');
const phone = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
const last4 = phone.length === 10 ? phone.slice(-4) : null;
if (phone.length !== 10) {
  print({ outcome: 'not_validated', reason: 'phone_unreadable', phone_last4: null });
  process.exit(1);
}
const mine = list.filter((v) => v.phone === phone);
const live = mine.find((v) => v.claimed_ref === null);

if (verb === 'validation-in-store') {
  if (!live) {
    print({ outcome: 'not_validated', reason: mine.length ? 'already_claimed' : 'none', phone_last4: last4 });
    process.exit(1);
  }
  print({ outcome: 'validated', validation: { validator_name: live.validator_name, discount_type: live.discount_type, discount_value: live.discount_value }, phone_last4: last4 });
  process.exit(0);
}

if (verb === 'claim-in-store') {
  if (state.mode === 'refuse_claims' || args['--currency'] !== 'USD') {
    print({ refused: 'currency_unsupported', field: '--currency', detail: `"${args['--currency']}" is refused, not converted` });
    process.exit(3);
  }
  const base = Number(args['--base-minor']);
  const answer = (v, replay) => ({
    outcome: 'claimed',
    replay,
    claim: {
      validator_name: v.validator_name, discount_type: v.discount_type, discount_value: v.discount_value,
      base_minor: state.mode === 'wrong_base' ? base + 100 : base,
      discount_minor: state.mode === 'bad_money' ? base + 1 : v.discount_minor,
      discounted_minor: base - v.discount_minor,
      currency: 'USD',
    },
    phone_last4: last4,
  });
  const replayed = mine.find((v) => v.claimed_ref === args['--ref']);
  if (replayed) {
    print(answer(replayed, true));
    process.exit(0);
  }
  if (!live) {
    print({ outcome: 'not_validated', reason: mine.length ? 'already_claimed' : 'none', phone_last4: last4 });
    process.exit(1);
  }
  live.claimed_ref = args['--ref'];
  writeFileSync(statePath, JSON.stringify(state));
  print(answer(live, false));
  process.exit(0);
}

print({ refused: 'unknown_verb', field: null, detail: `unknown verb ${verb}` });
process.exit(3);
