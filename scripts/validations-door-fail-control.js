#!/usr/bin/env node
/**
 * The control for the validations door's setting (`VALIDATIONS_DOOR`): this
 * repository names no validations module, so unset means the deployment has
 * none -- stating a link is refused by name, nothing is ever run, and a garage
 * that already links one takes the could-not-decide path. Set, it is checked
 * before the port opens: a door that could never run refuses to serve.
 *
 * Every property is broken below, one at a time, and
 * `test/validations-door.test.js` with `test/validations-door-start.test.js`
 * are REQUIRED to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported as
 * not planted rather than run:
 *   default_restored        the door has a default again: unset runs a module.
 *   link_not_refused        stating a link with no door named is not refused
 *                           by name; the probe is left to fail on its own.
 *   sentence_reworded       the refusal says something other than its sentence.
 *   bare_unchecked          a value that is not a bare command name is run.
 *   unset_is_no_validation  a deployment with no door answers "not validated"
 *                           instead of could-not-decide.
 *   startup_unchecked       the setting is not checked before the port opens.
 *   dotdot_allowed          a name with `..` in it counts as bare.
 *   existence_unchecked     a bare name is taken as the door without looking
 *                           for its file.
 *   execute_bit_unchecked   a file the process may not execute counts as the door.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SOURCE_BREAKS = [
  {
    name: 'default_restored',
    why: 'the door has a default again',
    file: 'src/validations.js',
    from: "  return env.VALIDATIONS_DOOR !== undefined && env.VALIDATIONS_DOOR !== '';",
    to: '  return true;',
    also: [{
      file: 'src/validations.js',
      from: '  const name = env.VALIDATIONS_DOOR;\n',
      to: "  const name = env.VALIDATIONS_DOOR || 'validations-stand-in';\n",
    }],
  },
  {
    name: 'link_not_refused',
    why: 'a link with no door named is left to the probe',
    file: 'src/validations.js',
    from: '  if (link && !doorConfigured(options.env ?? process.env)) throw new ValidationsNotConfigured();\n',
    to: '',
  },
  {
    name: 'sentence_reworded',
    why: 'the refusal says something other than its one sentence',
    file: 'src/validations.js',
    from: "export const NO_VALIDATIONS_CONFIGURED = 'This deployment has no validations module configured.';",
    to: "export const NO_VALIDATIONS_CONFIGURED = 'not available';",
  },
  {
    name: 'bare_unchecked',
    why: 'a value that is not a bare command name is run',
    file: 'src/validations.js',
    from: "  if (!BARE_COMMAND.test(name) || name.includes('..')) {",
    to: '  if (false) {',
  },
  {
    name: 'unset_is_no_validation',
    why: 'a deployment with no door answers not-validated',
    file: 'src/validations.js',
    from: '    try {\n      command = doorPath(env);\n    } catch (err) {\n      reject(err);\n      return;\n    }',
    to: "    if (!doorConfigured(env)) {\n      resolve({ exit_code: 1, stdout: '{\"outcome\":\"not_validated\",\"reason\":\"none\"}', stderr: '' });\n      return;\n    }\n    try {\n      command = doorPath(env);\n    } catch (err) {\n      reject(err);\n      return;\n    }",
  },
  {
    name: 'startup_unchecked',
    why: 'the setting is not checked before the port opens',
    file: 'src/server.js',
    from: '  assertValidationsDoor();\n',
    to: '',
  },
  {
    name: 'dotdot_allowed',
    why: 'a name with .. in it counts as bare',
    file: 'src/validations.js',
    from: "  if (!BARE_COMMAND.test(name) || name.includes('..')) {",
    to: '  if (!BARE_COMMAND.test(name)) {',
  },
  {
    name: 'existence_unchecked',
    why: 'a bare name is taken as the door without looking for its file',
    file: 'src/validations.js',
    from: '  const path = dirs.map((dir) => join(dir, name)).find(executableFile);',
    to: '  const path = dirs.map((dir) => join(dir, name)).find(() => true);',
  },
  {
    name: 'execute_bit_unchecked',
    why: 'a file the process may not execute counts as the door',
    file: 'src/validations.js',
    from: '    accessSync(path, constants.X_OK);',
    to: '    accessSync(path, constants.F_OK);',
  },
];

const SUITE = ['--test', 'test/validations-door.test.js', 'test/validations-door-start.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-validations-door-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, SUITE, { cwd: dir, env: process.env, stdio: 'pipe', encoding: 'utf8' });
}

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  return `${line('pass')} passed, ${line('fail')} failed`;
}

/** A break and its `also` edits, every one or none: each anchor exactly once. */
function plant(dir, edit) {
  const planned = [];
  for (const e of [edit, ...(edit.also ?? [])]) {
    const path = join(dir, e.file);
    const source = planned.find((p) => p.path === path)?.text ?? readFileSync(path, 'utf8');
    if (source.split(e.from).length !== 2) return false;
    const text = source.replace(e.from, e.to);
    const at = planned.findIndex((p) => p.path === path);
    if (at === -1) planned.push({ path, text });
    else planned[at].text = text;
  }
  for (const p of planned) writeFileSync(p.path, p.text);
  return true;
}

let failures = 0;

const intactDir = stage();
try {
  console.log('== control A: the suite must PASS intact ==');
  const intact = run(intactDir);
  if (intact.status === 0) {
    console.log(`  control A OK — ${summarise(intact)}`);
  } else {
    console.error(`  CONTROL A FAILED — the suite does not pass even intact: ${summarise(intact)}`);
    console.error(intact.stdout);
    console.error(intact.stderr);
    failures += 1;
  }
} finally {
  rmSync(intactDir, { recursive: true, force: true });
}

console.log('\n== control B: each SOURCE break must make it FAIL ==');
for (const brk of SOURCE_BREAKS) {
  const dir = stage();
  try {
    if (!plant(dir, brk)) {
      console.error(`  ${brk.name.padEnd(24)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(`  ${brk.name.padEnd(24)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(24)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property the validations door setting rests on.');
