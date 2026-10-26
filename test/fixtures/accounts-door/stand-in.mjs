/**
 * A STAND-IN for a linked accounts module's door, for this repository's tests.
 *
 * The real module is not in this repository and never will be: the public
 * repository gets the ability to ask, never the module. This speaks the door's
 * CONTRACT (src/accountsDoor.js) -- the verbs, the argv, the password on
 * stdin, the exit codes, the JSON -- and nothing else.
 *
 * State is a JSON file named by ACCOUNTS_STANDIN_STATE:
 *   { "mode": "normal" | "exit2" | "not_json" | "not_a_person" | "exit3",
 *     "people": [ { "person", "tenant", "email", "password", "name", "language",
 *                   "garages", "permissions", "version", "gone", "answer_tenant" } ],
 *     "passkeys": { "<credential id>": { "person", "tenant", "public_key",
 *                   "counter", "transports" } } }
 * `mode` holds for every verb, or only for those listed in `only` when that is
 * given. `answer_tenant` makes the door answer with another tenant than the
 * one it was asked about, as a module gone wrong would. Every call is appended
 * to ACCOUNTS_STANDIN_LOG as one JSON line {argv, stdin}, so a test can see
 * what arrived where.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { writeStandInState } from '../validations-door/state.js';

const statePath = process.env.ACCOUNTS_STANDIN_STATE;
const logPath = process.env.ACCOUNTS_STANDIN_LOG;
const print = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const argv = process.argv.slice(2);
if (logPath) appendFileSync(logPath, `${JSON.stringify({ argv, stdin })}\n`);

if (!statePath) {
  process.stderr.write('ACCOUNTS_STANDIN_STATE is not set.\n');
  process.exit(2);
}
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const [verb, ...rest] = argv;
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i]] = rest[i + 1];

const mode = !state.only || state.only.includes(verb) ? state.mode ?? 'normal' : 'normal';
if (mode === 'exit2') {
  process.stderr.write('the database refused: SQLSTATE 57P01: terminating connection\n');
  process.exit(2);
}
if (mode === 'exit3') process.exit(3);
if (mode === 'not_json') {
  process.stdout.write('ok\n');
  process.exit(0);
}

const people = state.people ?? [];
const answer = (p) => {
  if (mode === 'not_a_person') return { person: p.person, tenant: p.tenant, email: p.email };
  return {
    person: p.person, tenant: p.answer_tenant ?? p.tenant, email: p.email, name: p.name ?? null, language: p.language ?? 'en',
    garages: p.garages, permissions: p.permissions, version: p.version,
  };
};

switch (verb) {
  case 'sign-in': {
    let asked;
    try {
      asked = JSON.parse(stdin);
    } catch {
      process.exit(2);
    }
    const email = String(asked.email ?? '').trim().toLowerCase();
    const p = people.find((x) => !x.gone && x.email === email && x.password === asked.password);
    if (!p) process.exit(1);
    print(answer(p));
    process.exit(0);
    break;
  }
  case 'who': {
    const p = people.find((x) => !x.gone && x.person === args['--person'] && x.tenant === args['--tenant']);
    if (!p) process.exit(1);
    print(answer(p));
    process.exit(0);
    break;
  }
  case 'passkey': {
    const k = state.passkeys?.[args['--credential']];
    if (!k) process.exit(1);
    print(mode === 'not_a_person' ? { person: k.person } : k);
    process.exit(0);
    break;
  }
  case 'passkey-used': {
    const k = state.passkeys?.[args['--credential']];
    const n = Number(args['--counter']);
    if (!k || !Number.isSafeInteger(n)) process.exit(1);
    if (!(n > k.counter || (n === 0 && k.counter === 0))) process.exit(1);
    k.counter = n;
    writeStandInState(statePath, state);
    print({ recorded: true });
    process.exit(0);
    break;
  }
  default:
    process.stderr.write(`unknown verb ${verb}\n`);
    process.exit(2);
}
