#!/usr/bin/env node
/**
 * The control for the rules payload (migration 0016).
 *
 * The payload carries the plans whole, the space class, each linked module's
 * register verbatim, an outage said and not filled in, the open stays with a
 * cursor, a delta that carries closed rows, a cursor that never runs ahead of
 * what was delivered, a trigger that moves the cursor for every writer, and
 * no hourly figure; the rates route refuses by name. Every property is broken
 * below, one at a time, and the suite is REQUIRED to go red. A pass is the
 * failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 *
 *   hourly_back                the hourly figure returns to the payload (from
 *                              the table nothing prices with): two prices on
 *                              one channel.
 *   plans_latest_only          only the newest plan travels: the platform
 *                              selects, silently, and by exit time.
 *   space_class_dropped        the class every quote takes is not served.
 *   register_not_verbatim      the module's register is paraphrased: one key
 *                              of this platform's added inside it.
 *   monthly_not_read           only garage-pass's register is read.
 *   outage_is_empty            a door that could not answer is served as an
 *                              empty register, complete: an outage read as
 *                              "no pass holders".
 *   closed_in_snapshot         the open set carries closed stays.
 *   delta_drops_closed         the delta omits closed rows: a reader never
 *                              drops a car that left.
 *   delta_ignores_since        the delta answers everything, every time.
 *   cursor_runs_ahead          the delta's cursor is the table's maximum,
 *                              read after the rows: a row committing between
 *                              the two reads is in no delta (seen through
 *                              paging, the page planted to 3).
 *   page_never_more            a page that fills does not say so (the page
 *                              size planted to 3 beside it).
 *   rates_accepts_again        the retired route answers 201.
 *   since_unchecked            any `since` is passed to the query.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0016, so the property genuinely never existed.
 *
 *   trigger_never_created      the close does not move the cursor: a delta
 *                              never shows the car that left.
 *
 * Needs the same environment as the suite: the engine, the two modules'
 * scripts, and checkouts of both modules for their migrations.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.RULES_SCRATCH_DB || 'openparking_rules_control';

const SOURCE_BREAKS = [
  {
    name: 'hourly_back',
    why: 'the hourly figure is back on the payload',
    file: 'src/app.js',
    from: '        rate_plans: payload.plans,\n        entitlements,',
    to: '        rate_plans: payload.plans,\n        hourly_minor: 250,\n        entitlements,',
  },
  {
    name: 'plans_latest_only',
    why: 'only the newest plan travels',
    file: 'src/app.js',
    from: '        const plans = ratePlans.documents(await ratePlans.ratePlansForGarage(client, tenantId, garageId));',
    to: '        const plans = ratePlans.documents(await ratePlans.ratePlansForGarage(client, tenantId, garageId)).slice(-1);',
  },
  {
    name: 'space_class_dropped',
    why: 'the space class is not served',
    file: 'src/app.js',
    from: '        space_class: payload.garage.space_class,\n',
    to: '',
  },
  {
    name: 'register_not_verbatim',
    why: "the module's register is paraphrased",
    file: 'src/entitlement.js',
    from: '    facts[module] = { ...record, register };',
    to: '    facts[module] = { ...record, register: { ...register, read_by: \'platform\' } };',
  },
  {
    name: 'monthly_not_read',
    why: "only garage-pass's register is read",
    file: 'src/entitlement.js',
    from: '  const facts = { read_at: new Date().toISOString(), complete: true };\n  for (const module of Object.keys(MODULES)) {',
    to: "  const facts = { read_at: new Date().toISOString(), complete: true };\n  for (const module of ['garage_pass']) {",
  },
  {
    name: 'outage_is_empty',
    why: 'a door that could not answer is served as an empty register',
    file: 'src/entitlement.js',
    from: `    if (!register || !Array.isArray(register.registrations)) {
      facts[module] = {
        ...record,
        unavailable: \`exit \${out.exit_code}: \${(out.stderr || out.stdout).trim().slice(0, 300)}\`,
      };
      facts.complete = false;
      continue;
    }`,
    to: `    if (!register || !Array.isArray(register.registrations)) {
      facts[module] = { ...record, register: { garage: link.garage_id, registrations: [] } };
      continue;
    }`,
  },
  {
    name: 'closed_in_snapshot',
    why: 'the open set carries closed stays',
    file: 'src/repository.js',
    from: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL\n      ORDER BY s.change_seq`,',
    to: '      WHERE s.tenant_id = $1 AND s.garage_id = $2\n      ORDER BY s.change_seq`,',
  },
  {
    name: 'delta_drops_closed',
    why: 'the delta omits closed rows',
    file: 'src/repository.js',
    from: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.change_seq > $3\n',
    to: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.change_seq > $3 AND s.exit_at IS NULL\n',
  },
  {
    name: 'delta_ignores_since',
    why: 'the delta answers everything every time',
    file: 'src/repository.js',
    from: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.change_seq > $3\n',
    to: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND $3::bigint IS NOT NULL\n',
  },
  {
    name: 'cursor_runs_ahead',
    why: "the delta's cursor is the table's maximum, read after the rows",
    file: 'src/app.js',
    from: '        const cursor = changes.length ? changes[changes.length - 1].change_seq : String(since);',
    to: '        const cursor = await repo.stayCursor(client, tenantId, garageId);',
    // Seen through paging: with the page planted to 3, the first page's cursor
    // jumps to the table's maximum and the other four rows are in no delta.
    also: { file: 'src/app.js', from: 'const STAY_PAGE = 500;', to: 'const STAY_PAGE = 3;' },
  },
  {
    name: 'page_never_more',
    why: 'a page that fills does not say so',
    file: 'src/repository.js',
    from: '  const more = rows.length > limit;',
    to: '  const more = false;',
    // The page size planted down beside it, so seven rows are three pages.
    also: { file: 'src/app.js', from: 'const STAY_PAGE = 500;', to: 'const STAY_PAGE = 3;' },
  },
  {
    name: 'rates_accepts_again',
    why: 'the retired route answers 201',
    file: 'src/app.js',
    from: "  operator.post('/garages/:garageId/rates', (_req, _res, next) => {\n    next(",
    to: "  operator.post('/garages/:garageId/rates', (_req, res, next) => {\n    if (res) return res.status(201).json({ rate: {} });\n    next(",
  },
  {
    name: 'since_unchecked',
    why: 'any since is passed to the query',
    file: 'src/app.js',
    from: "      if (since !== undefined && !/^\\d{1,18}$/.test(String(since))) {",
    to: '      if (false) {',
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'trigger_never_created',
    why: 'the close does not move the cursor',
    edits: [
      {
        file: '0016_lane_rules_payload.sql',
        from: `CREATE TRIGGER sessions_bump_change_seq
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_bump_change_seq();`,
        to: '-- PLANTED: no trigger moves the cursor on update',
      },
    ],
  },
];

const SUITE = ['--test', '--test-timeout=120000', 'test/rules-payload.test.js', 'test/api.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-rules-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir, extraEnv = {}) {
  return spawnSync(process.execPath, SUITE, {
    cwd: dir,
    env: { ...process.env, ...extraEnv },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  return `${line('pass')} passed, ${line('fail')} failed`;
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
const maintenance = new URL(adminUrl);
maintenance.pathname = '/postgres';

const scratchEnv = {
  DATABASE_URL: scratchAdmin.toString(),
  APP_DATABASE_URL: scratchApp.toString(),
};

async function withAdmin(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A scratch database built from `migrations/` with one statement edited out. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
    await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-rules-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  for (const edit of brk.edits) {
    const path = join(partial, edit.file);
    const sql = readFileSync(path, 'utf8');
    if (!sql.includes(edit.from)) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, where: edit.file };
    }
    writeFileSync(path, sql.replace(edit.from, edit.to));
  }

  for (const [script, extra] of [
    ['scripts/migrate.js', { MIGRATIONS_DIR: partial }],
    ['scripts/ensure-app-role.js', {}],
  ]) {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, ...scratchEnv, ...extra },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(result.stdout, result.stderr);
      throw new Error(`${script} failed against the scratch database`);
    }
  }
  rmSync(partial, { recursive: true, force: true });
  return { ok: true };
}

function plant(dir, edit) {
  const path = join(dir, edit.file);
  const source = readFileSync(path, 'utf8');
  if (!source.includes(edit.from)) return false;
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

console.log('\n== control B: each SOURCE break must make it FAIL ==');
for (const brk of SOURCE_BREAKS) {
  const dir = stage();
  try {
    if (!plant(dir, brk) || (brk.also && !plant(dir, brk.also))) {
      // A break whose anchor has moved applies nothing, and the run then
      // reports a passing suite as a failed control for the wrong reason.
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== control C: each SCHEMA break must make it FAIL ==');
for (const brk of SCHEMA_BREAKS) {
  const dir = stage();
  try {
    const built = await buildScratch(dir, brk);
    if (!built.ok) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND in ${built.where} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir, scratchEnv);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The scratch database is a database with a property removed. Dropped, so
// nothing can later be run against it by accident and report a pass it did
// not earn.
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property the rules payload rests on.');
