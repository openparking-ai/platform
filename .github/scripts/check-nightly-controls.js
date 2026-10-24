#!/usr/bin/env node
// The nightly run (.github/workflows/nightly.yml) runs the fail-controls
// ci.yml runs, as ci.yml runs them: every step of ci.yml whose command names a
// control has the same command in the nightly, and every command of the
// nightly that names a control is one of ci.yml's. A control added to ci.yml
// and not to the nightly is named here, so the night they part the nightly is
// red, instead of that control running nowhere once ci.yml stops running it
// on every push. Each workflow is read with a YAML parser, never line by line.
//
//   node .github/scripts/check-nightly-controls.js              the two files
//   node .github/scripts/check-nightly-controls.js --self-test  proves it can fail

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const WORKFLOWS = join(fileURLToPath(import.meta.url), '..', '..', 'workflows');
/** A command that runs a control: `npm run <...control...>` or `node scripts/<...control...>.js`. */
const NAMES_A_CONTROL = /^(npm run [\w-]*control|node scripts\/[\w-]*control)/i;

/** Every step's command in a workflow, as written, with the job it is in. */
function commands(doc) {
  const out = [];
  for (const [job, body] of Object.entries(doc?.jobs ?? {})) {
    for (const step of body?.steps ?? []) {
      if (typeof step?.run === 'string') out.push({ job, run: step.run.trim() });
    }
  }
  return out;
}

/** What differs, as sentences; none when the nightly runs exactly ci.yml's controls. */
export function compare(ci, nightly) {
  const controls = (doc) => commands(doc).filter((c) => NAMES_A_CONTROL.test(c.run));
  const inNightly = new Set(controls(nightly).map((c) => c.run));
  const inCi = new Set(controls(ci).map((c) => c.run));
  const found = [];
  for (const c of controls(ci)) {
    if (!inNightly.has(c.run)) found.push(`ci.yml runs "${c.run}" (job ${c.job}); the nightly does not`);
  }
  for (const c of controls(nightly)) {
    if (!inCi.has(c.run)) found.push(`the nightly runs "${c.run}" (job ${c.job}); ci.yml does not`);
  }
  if (inCi.size === 0) found.push('ci.yml names no control: nothing was compared');
  return found;
}

const read = (name) => yaml.load(readFileSync(join(WORKFLOWS, name), 'utf8'), { filename: name });

if (process.argv.includes('--self-test')) {
  const ci = read('ci.yml');
  const nightly = read('nightly.yml');
  const [first] = commands(ci).filter((c) => NAMES_A_CONTROL.test(c.run));
  if (!first) {
    console.error('self-test: ci.yml names no control to plant with');
    process.exit(1);
  }
  const without = structuredClone(nightly);
  for (const body of Object.values(without.jobs)) body.steps = (body.steps ?? []).filter((s) => s.run?.trim() !== first.run);
  const extra = structuredClone(nightly);
  Object.values(extra.jobs)[0].steps.push({ run: 'npm run planted-fail-control' });
  const cases = [
    ['a control of ci.yml left out of the nightly', compare(ci, without), `ci.yml runs "${first.run}"`],
    ['a control in the nightly that ci.yml does not run', compare(ci, extra), 'the nightly runs "npm run planted-fail-control"'],
  ];
  let wrong = 0;
  for (const [what, found, want] of cases) {
    if (found.some((f) => f.startsWith(want))) console.log(`  ok   ${what}: named`);
    else {
      console.error(`  FAIL ${what}: not named (found: ${found.join(' | ') || 'nothing'})`);
      wrong += 1;
    }
  }
  if (wrong) process.exit(1);
  console.log('self-test — both plants caught, each named.');
} else {
  const found = compare(read('ci.yml'), read('nightly.yml'));
  if (found.length) {
    for (const f of found) console.error(`  ${f}`);
    console.error(`\n${found.length} difference(s): the nightly does not run the controls ci.yml runs.`);
    process.exit(1);
  }
  const n = commands(read('ci.yml')).filter((c) => NAMES_A_CONTROL.test(c.run)).length;
  console.log(`the nightly runs the ${n} control command(s) ci.yml runs, and no other.`);
}
