#!/usr/bin/env node
/**
 * The control for the owner's language (0025): sign-in and /auth/me carry it,
 * PUT /api/v1/auth/language changes it for the signed-in admin only, to `en`
 * or `es` only.
 *
 * Every property is broken below, one at a time, and the suite is REQUIRED to
 * go red. A pass is the failure.
 *
 * Breaks are applied to a COPY of the tree; no tracked file is edited. Each
 * anchor must occur exactly once in its file, or the break is reported as not
 * planted rather than run:
 *   user_from_body          the admin and tenant changed are taken from the body.
 *   any_language_taken      any string is taken as a language.
 *   query_read              the language is read from the query too.
 *   query_fallback          the query's language is taken when the body has none
 *                           (spelled `req['query']`, which the static test does not see).
 *   origin_unchecked        the language route takes a change from any Origin.
 *   sign_in_without_language  sign-in's answer carries no language.
 *   me_without_language     /auth/me carries no language.
 *   check_constraint_dropped  0025 makes the column with no check, so the database takes "fr".
 *   default_not_english     0025 makes every admin from before it Spanish.
 *
 * The last two edit the COPY's migrations/0025: the suite builds its scratch
 * database from the migrations beside it, so the property genuinely never
 * existed there. Needs the same environment as the suite.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const BREAKS = [
  {
    name: 'user_from_body',
    why: 'the admin and tenant changed are taken from the body',
    file: 'src/signIn.js',
    from: 'const changed = await internals.setLanguage(req.session, language, req.change);',
    to: 'const changed = await internals.setLanguage({ ...req.session, ...req.body }, language, req.change);',
  },
  {
    name: 'any_language_taken',
    why: 'any string is taken as a language',
    file: 'src/signIn.js',
    from: "return typeof language === 'string' && LANGUAGES.includes(language) ? language : null;",
    to: "return typeof language === 'string' ? language : null;",
  },
  {
    name: 'query_read',
    why: 'the language is read from the query too',
    file: 'src/signIn.js',
    from: 'const language = languageBody(req.body);',
    to: 'const language = languageBody({ ...req.body, ...req.query });',
  },
  {
    name: 'query_fallback',
    why: "the query's language is taken when the body has none",
    file: 'src/signIn.js',
    from: 'const language = languageBody(req.body);',
    to: "const language = languageBody(req.body) ?? languageBody(req['query']);",
  },
  {
    name: 'origin_unchecked',
    why: 'the language route takes a change from any Origin',
    file: 'src/signIn.js',
    from: '      if (!originAllows(req, settings)) {\n        await refusedLanguage(req, 403, ORIGIN_REFUSED);',
    to: "      if (req.path !== '/language' && !originAllows(req, settings)) {\n        await refusedLanguage(req, 403, ORIGIN_REFUSED);",
  },
  {
    name: 'sign_in_without_language',
    why: "sign-in's answer carries no language",
    file: 'src/signIn.js',
    from: '        language: row.language,\n',
    to: '',
  },
  {
    name: 'me_without_language',
    why: '/auth/me carries no language',
    file: 'src/signIn.js',
    from: 'session_ends_at: endsAt(req.session).toISOString(), language });',
    to: 'session_ends_at: endsAt(req.session).toISOString() });',
  },
  {
    name: 'check_constraint_dropped',
    why: '0025 makes the column with no check',
    file: 'migrations/0025_operator_language.sql',
    from: "  ADD COLUMN language text NOT NULL DEFAULT 'en',\n  ADD CONSTRAINT operator_users_language_is_known CHECK (language IN ('en', 'es'));",
    to: "  ADD COLUMN language text NOT NULL DEFAULT 'en';",
  },
  {
    name: 'default_not_english',
    why: '0025 makes every admin from before it Spanish',
    file: 'migrations/0025_operator_language.sql',
    from: "ADD COLUMN language text NOT NULL DEFAULT 'en',",
    to: "ADD COLUMN language text NOT NULL DEFAULT 'es',",
  },
];

const SUITE = ['--test', 'test/owner-language.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-owner-language-control-'));
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
  const red = [...new Set([...result.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))];
  return `${line('pass')} passed, ${line('fail')} failed${red.length ? ` -- red: ${red.join(' | ')}` : ''}`;
}

function plant(dir, edit) {
  const path = join(dir, edit.file);
  const source = readFileSync(path, 'utf8');
  if (source.split(edit.from).length !== 2) return false;
  writeFileSync(path, source.replace(edit.from, edit.to));
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

console.log('\n== control B: each break must make it FAIL ==');
for (const brk of BREAKS) {
  const dir = stage();
  try {
    if (!plant(dir, brk)) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(`  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's language tests.`);
  process.exit(1);
}
console.log(`\nall controls OK — the suite fails on every one of the ${BREAKS.length} properties the owner's language rests on.`);
