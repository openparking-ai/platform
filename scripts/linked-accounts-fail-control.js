#!/usr/bin/env node
/**
 * The control for linked accounts, passkeys, permissions and "done by"
 * (migration 0035; README, "Passkeys for the admin", "Linked accounts: people
 * beside the admin", "Permissions: one on every operator route", "Done by").
 *
 * Every property is broken below, one at a time, and the suites --
 * test/linked-accounts.test.js, test/passkeys.test.js,
 * test/permissions.test.js and test/accounts-door-start.test.js -- are
 * REQUIRED to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported as
 * not planted rather than run.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SOURCE_BREAKS = [
  // --- the door -----------------------------------------------------------------------
  {
    name: 'door_default',
    why: 'the door has a default: unset runs a module',
    file: 'src/accountsDoor.js',
    from: "  return env.ACCOUNTS_DOOR !== undefined && env.ACCOUNTS_DOOR !== '';",
    to: '  return true;',
    also: [{ file: 'src/accountsDoor.js', from: '  const name = env.ACCOUNTS_DOOR;\n', to: "  const name = env.ACCOUNTS_DOOR || 'accounts-stand-in';\n" }],
  },
  {
    name: 'password_on_argv',
    why: 'the password is put on the command line',
    file: 'src/accountsDoor.js',
    from: "await run(['sign-in'], `${JSON.stringify({ email, password })}\\n`, options)",
    to: "await run(['sign-in', '--password', password], `${JSON.stringify({ email, password })}\\n`, options)",
  },
  {
    name: 'undecided_is_refusal',
    why: 'a door that could not decide is taken as an answer',
    file: 'src/accountsDoor.js',
    from: '  if (out.exitCode !== 0) throw new AccountsUndecided(`${step} exit ${out.exitCode}`);',
    to: '  if (out.exitCode !== 0) return null;',
  },
  {
    name: 'shape_unchecked',
    why: 'an answer that is not a person is taken as one',
    file: 'src/accountsDoor.js',
    from: "  if (!ok) throw new AccountsUndecided('an answer that is not a person');",
    to: '',
  },
  {
    name: 'startup_unchecked',
    why: 'the door is not checked before the port opens',
    file: 'src/server.js',
    from: '  assertAccountsDoor();\n',
    to: '',
  },
  {
    name: 'bare_unchecked',
    why: 'a value that is not a bare command name is looked for',
    file: 'src/accountsDoor.js',
    from: "  if (!BARE_COMMAND.test(name) || name.includes('..')) return { why: 'ACCOUNTS_DOOR is not a bare command name' };",
    to: '',
  },
  // --- sign-in and sessions ----------------------------------------------------------
  {
    name: 'lock_skipped',
    why: 'a locked address still reaches the door',
    file: 'src/signIn.js',
    from: '        if (!locked) person = await linkedAccounts.internals.door.signIn(body.email, body.password);',
    to: '        person = await linkedAccounts.internals.door.signIn(body.email, body.password);',
  },
  {
    name: 'lock_not_counted',
    why: 'a refusal through the door is not counted',
    file: 'src/signIn.js',
    from: '        await linkedAccounts.internals.recordFailure(hash, address);\n',
    to: '',
  },
  {
    name: 'tenant_unchecked_at_mint',
    why: 'a session is made for a tenant this platform does not have',
    file: 'src/linkedAccounts.js',
    from: "    if ((await c.query('SELECT 1 FROM tenants WHERE id = $1', [person.tenant])).rowCount !== 1) return null;\n",
    to: '',
  },
  {
    name: 'never_asked_again',
    why: 'a session never asks the module again',
    file: 'src/linkedAccounts.js',
    from: '  if (Date.now() - new Date(s.checked_at).getTime() >= settings.accountsRecheckSeconds * 1000) {',
    to: '  if (false) {',
  },
  {
    name: 'version_ignored',
    why: 'a changed version does not end the session',
    file: 'src/linkedAccounts.js',
    from: '  if (!fresh || fresh.tenant !== s.tenant_id || fresh.version !== s.version) {',
    to: '  if (!fresh || fresh.tenant !== s.tenant_id) {',
  },
  {
    name: 'tenant_ignored',
    why: 'an answer naming another tenant keeps the session',
    file: 'src/linkedAccounts.js',
    from: '  if (!fresh || fresh.tenant !== s.tenant_id || fresh.version !== s.version) {',
    to: '  if (!fresh || fresh.version !== s.version) {',
  },
  {
    name: 'asked_many_times',
    why: 'requests at once each ask the module',
    file: 'src/linkedAccounts.js',
    from: '    let pending = asking.get(s.session_id);',
    to: '    let pending;',
  },
  {
    name: 'unset_still_resolves',
    why: 'a linked session outlives the deployment naming no door',
    file: 'src/linkedAccounts.js',
    from: '  if (!token || !door.doorConfigured()) return null;',
    to: '  if (!token) return null;',
  },
  // --- passkeys -----------------------------------------------------------------------
  {
    name: 'challenge_reusable',
    why: 'a challenge works more than once',
    file: 'src/passkeys.js',
    from: '  challenges.delete(id);\n  const mine',
    to: '  const mine',
  },
  {
    name: 'challenge_not_owned',
    why: 'a challenge works for anyone and any purpose',
    file: 'src/passkeys.js',
    from: '  const mine = c.purpose === purpose && c.tenantId === (owner?.tenantId ?? null) && c.userId === (owner?.userId ?? null);',
    to: '  const mine = true;',
  },
  {
    name: 'refusals_differ',
    why: 'an unknown passkey is told apart from a bad one',
    file: 'src/passkeys.js',
    from: '  if (!admin && !linked) throw refused();',
    to: "  if (!admin && !linked) throw new PasskeyRefused(404, 'passkey_unknown', 'No such passkey.');",
  },
  {
    name: 'rp_unchecked',
    why: 'an origin outside the relying party is taken',
    file: 'src/passkeys.js',
    from: '    if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {',
    to: '    if (false) {',
  },
  {
    name: 'door_asked_when_unset',
    why: 'a passkey sign-in asks a door the deployment does not name',
    file: 'src/passkeys.js',
    from: '  const linked = admin ? null : accountsDoor.doorConfigured() ? await accountsDoor.passkey(credentialId) : null;',
    to: '  const linked = admin ? null : await accountsDoor.passkey(credentialId);',
  },
  {
    name: 'linked_gone_signs_in',
    why: 'a person the module no longer has signs in with a good key',
    file: 'src/passkeys.js',
    from: '  if (!person) throw refused();\n  return { kind: \'linked\', person };',
    to: "  return { kind: 'linked', person };",
  },
  {
    name: 'admin_routes_for_linked',
    why: "a linked person reaches the admin's passkey routes",
    file: 'src/signIn.js',
    from: '  const adminOnly = (req, res, next) => (req.linked ? res.status(409).json(passkeys.ELSEWHERE) : next());',
    to: '  const adminOnly = (req, res, next) => next();',
  },
  // --- permissions --------------------------------------------------------------------
  {
    name: 'permission_unchecked',
    why: 'a permission not held is let through',
    file: 'src/permissions.js',
    from: '      if (!access || !holds(access.permissions, permission)) {',
    to: '      if (!access) {',
  },
  {
    name: 'garage_scope_unchecked',
    why: 'a garage outside the list is reached',
    file: 'src/permissions.js',
    from: '        if (garage !== undefined && (garage === null || !reaches(access, garage))) {',
    to: '        if (garage === null) {',
  },
  {
    name: 'every_garage_ignored',
    why: 'a person at some garages uses a route for the whole account',
    file: 'src/permissions.js',
    from: '        if (everyGarage) throw new HttpError(403, PERMISSION_REFUSED.error, PERMISSION_REFUSED.code);\n',
    to: '',
  },
  {
    name: 'list_uncut',
    why: 'the garage list shows garages outside the session',
    file: 'src/app.js',
    from: '      res.json({ garages: rows.filter((g) => reaches(req.access, g.id)).map(repo.presentGarage) });',
    to: '      res.json({ garages: rows.map(repo.presentGarage) });',
  },
  {
    name: 'route_without_permission',
    why: 'a route names no permission',
    file: 'src/app.js',
    from: "  operator.get('/garages/:garageId/lanes', may('lanes:read'), async (req, res, next) => {",
    to: "  operator.get('/garages/:garageId/lanes', async (req, res, next) => {",
  },
  {
    name: 'change_covers_nothing',
    why: 'a change does not cover its read',
    file: 'src/permissions.js',
    from: "  return wanted.endsWith(':read') && permissions.includes(`${wanted.slice(0, -':read'.length)}:change`);",
    to: '  return false;',
  },
  // --- done by ------------------------------------------------------------------------
  {
    name: 'done_by_unchecked',
    why: 'a name of any length or character is kept',
    file: 'src/doneBy.js',
    from: '  if (name === \'\' || [...name].length > MAX || CONTROL.test(name)) {',
    to: "  if (name === '') {",
  },
  {
    name: 'done_by_dropped',
    why: "a key's name is not kept beside the line",
    file: 'src/changes.js',
    from: "    actor.kind === 'key' ? ctx.doneBy ?? null : null,",
    to: '    null,',
  },
];

const SUITE = ['--test', 'test/linked-accounts.test.js', 'test/passkeys.test.js', 'test/permissions.test.js', 'test/accounts-door-start.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-linked-accounts-control-'));
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
    const text = source.replace(e.from, () => e.to);
    const at = planned.findIndex((p) => p.path === path);
    if (at === -1) planned.push({ path, text });
    else planned[at].text = text;
  }
  for (const p of planned) writeFileSync(p.path, p.text);
  return true;
}

const only = process.argv.slice(2);
let failures = 0;

if (only.length === 0) {
  const intactDir = stage();
  try {
    console.log('== control A: the suites must PASS intact ==');
    const intact = run(intactDir);
    if (intact.status === 0) {
      console.log(`  control A OK — ${summarise(intact)}`);
    } else {
      console.error(`  CONTROL A FAILED — the suites do not pass even intact: ${summarise(intact)}`);
      console.error(intact.stdout);
      console.error(intact.stderr);
      failures += 1;
    }
  } finally {
    rmSync(intactDir, { recursive: true, force: true });
  }
}

console.log('\n== control B: each SOURCE break must make them FAIL ==');
for (const brk of SOURCE_BREAKS.filter((b) => only.length === 0 || only.includes(b.name))) {
  const dir = stage();
  try {
    if (!plant(dir, brk)) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(`  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suites are not measuring this ***`);
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suites fail on every property linked accounts, passkeys, permissions and "done by" rest on.');
