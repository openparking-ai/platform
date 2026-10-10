#!/usr/bin/env node
/**
 * The control for the invites and the password reset (0032): the invite end
 * to end, the token kept out of every log, output and row, forgot giving the
 * same answer, work and time whoever it names, and a reset that works once.
 *
 * Every property is broken below, one at a time, and its suite is REQUIRED to
 * go red. A pass is the failure.
 *
 * Breaks are applied to a COPY of the tree; no tracked file is edited. Each
 * anchor must occur exactly once in its file, or the break is reported as not
 * planted rather than run. The schema breaks build a scratch database from a
 * copy of `migrations/` with the statement edited out -- a rule held only by
 * the code is a rule one direct INSERT goes around -- and the suite runs
 * against it. Needs the same environment as the suite.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.SCRATCH_DB || 'openparking_links_control';

const LINKS = ['test/account-links.test.js'];
const OUTPUT = ['test/account-links-output.test.js'];
const COVERAGE = ['test/rls-coverage.test.js'];
const MIGRATION = '0032_operator_invites_and_password_resets.sql';

const BREAKS = [
  // --- check 1: the invite, end to end
  {
    name: 'old_link_accepts_after_resend',
    why: 'a replaced invite still reads as ready, so the old link accepts after a resend',
    suite: LINKS,
    edits: [{ file: 'src/invites.js', from: "  if (row.replaced_at) return 'replaced';\n", to: '' }],
  },
  {
    name: 'used_link_accepts_again',
    why: 'a used invite still reads as ready',
    suite: LINKS,
    edits: [{ file: 'src/invites.js', from: "  if (row.used_at) return 'used';\n", to: '' }],
  },
  {
    name: 'expired_link_accepts',
    why: 'an invite past its end still reads as ready',
    suite: LINKS,
    edits: [{ file: 'src/invites.js', from: "  if (new Date(row.expires_at) <= now) return 'expired';\n", to: '' }],
  },
  {
    name: 'send_failure_ignored',
    why: 'a send that failed is taken as sent, and the tenant and invite are stored',
    suite: LINKS,
    edits: [{
      file: 'src/invites.js',
      from: '      await sendInvite(settings, { email: address, language: lang, company, token, expiresAt: ends });\n',
      to: '      await sendInvite(settings, { email: address, language: lang, company, token, expiresAt: ends }).catch(() => {});\n',
    }],
  },
  {
    name: 'no_key_not_said',
    why: 'the command does not check for a key before it starts, and says something else',
    suite: LINKS,
    edits: [{ file: 'src/invites.js', from: '    assertCanSend(email);\n', to: '' }],
  },
  // --- check 2: the token is in no log, no output and no row
  {
    name: 'token_stored_plain',
    why: 'the token is stored as it is, and the table takes it',
    suite: LINKS,
    edits: [
      { file: 'src/invites.js', from: '[tenantId, email, language, hashToken(token), INVITE_DAYS]', to: '[tenantId, email, language, token, INVITE_DAYS]' },
      { file: 'src/invites.js', from: "'SELECT * FROM resolve_operator_invite($1)', [hashToken(token)]", to: "'SELECT * FROM resolve_operator_invite($1)', [token]" },
    ],
    schema: [{
      file: MIGRATION,
      from: "  -- A SHA-256, in hex: never a token.\n  CONSTRAINT operator_invites_token_is_a_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),\n",
      to: '',
    }],
  },
  {
    name: 'body_logged',
    why: "a door logs the request's body",
    suite: OUTPUT,
    edits: [{
      file: 'src/accountDoors.js',
      from: '        req.door = SHAPES[door](req.body);\n',
      to: "        req.door = SHAPES[door](req.body);\n        console.log('[auth] body', JSON.stringify(req.body));\n",
    }],
  },
  {
    name: 'link_printed',
    why: 'the command prints the link',
    suite: LINKS,
    edits: [{
      file: 'src/invites.js',
      from: '    await sendEmail(settings.email, { to: email, ...inviteEmail(',
      to: '    console.log(inviteLink(settings.adminOrigin, token));\n    await sendEmail(settings.email, { to: email, ...inviteEmail(',
    }],
  },
  {
    name: 'query_read',
    why: 'a door reads the query as well as the body',
    suite: LINKS,
    edits: [{ file: 'src/accountDoors.js', from: '        req.door = SHAPES[door](req.body);\n', to: '        req.door = SHAPES[door]({ ...req.body, ...req.query });\n' }],
  },
  // --- check 3: forgot is no oracle
  {
    name: 'forgot_early_for_unknown',
    why: 'forgot answers an unknown email at once, before the floor',
    suite: LINKS,
    edits: [{
      file: 'src/accountDoors.js',
      from: '      const made = await requestReset(req.door.email, signIn.NOBODY);\n',
      to: '      const made = await requestReset(req.door.email, signIn.NOBODY);\n      if (!made) return res.status(200).json(FORGOT_SENT);\n',
    }],
  },
  {
    name: 'forgot_less_work_for_unknown',
    why: 'forgot skips the statements for an unknown email',
    suite: LINKS,
    edits: [{ file: 'src/invites.js', from: '  const user = found ?? nobody;\n', to: '  const user = found ?? nobody;\n  if (!found) return null;\n' }],
  },
  {
    name: 'doors_unfloored',
    why: 'the doors answer without waiting for the floor',
    suite: LINKS,
    edits: [{ file: 'src/signIn.js', from: '    settings, email, line, answer: refuse,\n', to: '    settings, email, line, answer: async (req, res, status, body) => res.status(status).json(body),\n' }],
  },
  // --- check 4: a reset works once and ends every session
  {
    name: 'reset_second_use',
    why: 'a used reset is not marked used, so a second use is accepted',
    suite: LINKS,
    edits: [{ file: 'src/invites.js', from: "    await c.query('UPDATE operator_password_resets SET used_at = now() WHERE id = $1', [held.id]);\n", to: '' }],
  },
  {
    name: 'reset_keeps_locks',
    why: 'a reset leaves the sign-in locks on the admin',
    suite: LINKS,
    edits: [{ file: 'src/invites.js', from: "    await c.query('DELETE FROM operator_sign_in_locks WHERE user_id = $1', [held.user_id]);\n", to: '' }],
  },
  // --- the doors keep sign-in's rules
  {
    name: 'foreign_origin_taken',
    why: 'a door takes a request from a foreign Origin',
    suite: LINKS,
    edits: [{ file: 'src/accountDoors.js', from: '        if (origin !== undefined && origin !== settings.adminOrigin) return await answer(req, res, 403, signIn.ORIGIN_REFUSED);\n', to: '' }],
  },
  {
    name: 'no_address_limit',
    why: "a door does not count an address's attempts",
    suite: LINKS,
    edits: [{ file: 'src/accountDoors.js', from: 'if (!limiters[door].take(req.address))', to: 'if (!limiters[door].take(req.address) && false)' }],
  },
  // --- check 6: one live invite per tenant, and each tenant's own
  {
    name: 'two_live_invites_per_tenant',
    why: 'the database takes a second live invite for a tenant',
    suite: LINKS,
    schema: [{
      file: MIGRATION,
      from: 'CREATE UNIQUE INDEX operator_invites_one_live_per_tenant ON operator_invites (tenant_id)\n  WHERE used_at IS NULL AND replaced_at IS NULL;\n',
      to: '',
    }],
  },
  {
    name: 'invites_not_forced',
    why: 'operator_invites is not FORCED, so its owner reads it past the policy',
    suite: COVERAGE,
    schema: [{ file: MIGRATION, from: 'ALTER TABLE operator_invites FORCE  ROW LEVEL SECURITY;\n', to: '' }],
  },
  {
    name: 'resets_not_forced',
    why: 'operator_password_resets is not FORCED',
    suite: COVERAGE,
    schema: [{ file: MIGRATION, from: 'ALTER TABLE operator_password_resets FORCE  ROW LEVEL SECURITY;\n', to: '' }],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-links-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir, suite, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', ...suite], { cwd: dir, env, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  const red = [...new Set([...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].slice(0, 70)))];
  return `${line('pass')} passed, ${line('fail')} failed${red.length ? ` -- red: ${red.join(' | ')}` : ''}`;
}

/** Every edit of a break, in the files under `dir`, or none: each anchor exactly once. */
function plant(dir, edits) {
  const planned = new Map();
  for (const e of edits) {
    const path = join(dir, e.file);
    const source = planned.get(path) ?? readFileSync(path, 'utf8');
    if (source.split(e.from).length !== 2) return e.file;
    planned.set(path, source.replace(e.from, () => e.to));
  }
  for (const [path, text] of planned) writeFileSync(path, text);
  return null;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const adminUrl = required('DATABASE_URL');
const appPassword = required('APP_DB_PASSWORD');
const host = new URL(adminUrl).host;
const scratchAdmin = new URL(adminUrl);
scratchAdmin.pathname = `/${SCRATCH}`;
const scratchApp = new URL(`postgres://openparking_app@${host}/${SCRATCH}`);
scratchApp.password = appPassword;
const maintenance = new URL(required('SUPERUSER_URL'));
maintenance.pathname = '/postgres';
const scratchEnv = { DATABASE_URL: scratchAdmin.toString(), APP_DATABASE_URL: scratchApp.toString() };

async function dropScratch() {
  const c = new pg.Client({ connectionString: maintenance.toString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  } finally {
    await c.end();
  }
}

/** A scratch database built from `migrations/` with the break's statements edited. Null, or the file an anchor was not in. */
async function buildScratch(dir, edits) {
  await dropScratch();
  const partial = mkdtempSync(join(tmpdir(), 'openparking-links-migrations-'));
  try {
    for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
      copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
    }
    const missing = plant(partial, edits);
    if (missing) return missing;
    for (const script of ['scripts/prepare-database.js', 'scripts/migrate.js']) {
      const result = spawnSync(process.execPath, [script], { cwd: dir, env: { ...process.env, ...scratchEnv, MIGRATIONS_DIR: partial }, encoding: 'utf8' });
      if (result.status !== 0) {
        console.error(result.stdout, result.stderr);
        throw new Error(`${script} failed against the scratch database`);
      }
    }
    return null;
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

let failures = 0;

const intactDir = stage();
try {
  console.log('== control A: the suites must PASS intact ==');
  for (const suite of [LINKS, OUTPUT, COVERAGE]) {
    const intact = run(intactDir, suite);
    if (intact.status === 0) {
      console.log(`  control A OK — ${suite.join(' ')}: ${summarise(intact)}`);
    } else {
      console.error(`  CONTROL A FAILED — ${suite.join(' ')} does not pass even intact: ${summarise(intact)}`);
      console.error(intact.stdout.slice(-4000));
      console.error(intact.stderr.slice(-4000));
      failures += 1;
    }
  }
} finally {
  rmSync(intactDir, { recursive: true, force: true });
}

console.log('\n== control B: each break must make its suite FAIL ==');
for (const brk of BREAKS) {
  const dir = stage();
  try {
    const missing = plant(dir, brk.edits ?? []) ?? (brk.schema ? await buildScratch(dir, brk.schema) : null);
    if (missing) {
      console.error(`  ${brk.name.padEnd(30)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir, brk.suite, brk.schema ? scratchEnv : {});
    if (broken.status === 0) {
      console.error(`  ${brk.name.padEnd(30)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(30)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (BREAKS.some((b) => b.schema)) await dropScratch();

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's invite and reset tests.`);
  process.exit(1);
}
console.log(`\nall controls OK — the suites fail on every one of the ${BREAKS.length} properties the invites and the reset rest on.`);
