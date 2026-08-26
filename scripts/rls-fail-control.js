#!/usr/bin/env node
/**
 * The control for the isolation suite.
 *
 * A test that has never been observed failing is not known to be measuring
 * anything. This builds a scratch database and then, one table at a time,
 * removes the protection and REQUIRES the suite to fail. A pass is the failure.
 *
 * It covers every table in the registry rather than one representative, because
 * "the isolation tests pass" is a claim about all of them.
 *
 * Finally it adds a table that forgets row-level security entirely, and
 * requires the schema-wide coverage guard to catch it -- the case the per-table
 * suite structurally cannot see, since nobody wrote a test for a table nobody
 * remembered.
 */
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { TENANT_TABLES } from '../test/tenant-tables.js';

const SCRATCH = process.env.SCRATCH_DB || 'openparking_rls_control';

const adminUrl = required('DATABASE_URL');
const appPassword = required('APP_DB_PASSWORD');

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const base = new URL(adminUrl);
const scratchAdmin = new URL(adminUrl);
scratchAdmin.pathname = `/${SCRATCH}`;
const scratchApp = new URL(`postgres://openparking_app@${base.host}/${SCRATCH}`);
scratchApp.password = appPassword;

const env = {
  ...process.env,
  DATABASE_URL: scratchAdmin.toString(),
  APP_DATABASE_URL: scratchApp.toString(),
};

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, args, { env: { ...env, ...extraEnv }, stdio: 'pipe', encoding: 'utf8' });
}

function summarise(result) {
  const line = (label) => (result.stdout.match(new RegExp(`^ℹ ${label} (\\d+)$`, 'm')) || [])[1] ?? '?';
  return `${line('pass')} passed, ${line('fail')} failed`;
}

async function withAdmin(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const maintenance = new URL(adminUrl);
maintenance.pathname = '/postgres';

console.log(`== rebuilding scratch database '${SCRATCH}' ==`);
await withAdmin(maintenance.toString(), async (c) => {
  await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
});

console.log('== migrating ==');
for (const script of ['scripts/migrate.js', 'scripts/ensure-app-role.js']) {
  const r = run([script]);
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    process.exit(1);
  }
}

let failures = 0;

// --- control A ------------------------------------------------------------
console.log('\n== control A: the whole suite must PASS with RLS intact ==');
const controlA = run(['--test', 'test/tenant-isolation.test.js', 'test/rls-coverage.test.js']);
if (controlA.status === 0) {
  console.log(`control A OK — ${summarise(controlA)} with protection in place`);
} else {
  console.error(`CONTROL A FAILED — the suite does not pass even with RLS intact (${summarise(controlA)})`);
  console.error(controlA.stdout);
  failures += 1;
}

// --- control B, once per table -------------------------------------------
console.log('\n== control B: each table in turn must FAIL once its protection is removed ==');
for (const { table } of TENANT_TABLES) {
  await withAdmin(scratchAdmin.toString(), (c) =>
    c.query(
      `ALTER TABLE ${pg.escapeIdentifier(table)} NO FORCE ROW LEVEL SECURITY;
       ALTER TABLE ${pg.escapeIdentifier(table)} DISABLE ROW LEVEL SECURITY;`,
    ),
  );

  const stripped = run(['--test', 'test/tenant-isolation.test.js'], { ISOLATION_TABLE: table });

  if (stripped.status === 0) {
    console.error(`  ${table.padEnd(14)} *** PASSED WITH RLS REMOVED — the test is not measuring isolation ***`);
    failures += 1;
  } else {
    console.log(`  ${table.padEnd(14)} fails as required (${summarise(stripped)})`);
  }

  await withAdmin(scratchAdmin.toString(), (c) =>
    c.query(
      `ALTER TABLE ${pg.escapeIdentifier(table)} ENABLE ROW LEVEL SECURITY;
       ${table === 'lane_devices' ? '' : `ALTER TABLE ${pg.escapeIdentifier(table)} FORCE ROW LEVEL SECURITY;`}`,
    ),
  );
}

// --- control C ------------------------------------------------------------
console.log('\n== control C: a table that forgets RLS must be caught by the schema guard ==');
await withAdmin(scratchAdmin.toString(), (c) =>
  c.query(`CREATE TABLE forgot_rls (
             id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
             tenant_id uuid NOT NULL REFERENCES tenants(id),
             secret text NOT NULL)`),
);

const perTable = run(['--test', 'test/tenant-isolation.test.js']);
const guard = run(['--test', 'test/rls-coverage.test.js']);

if (perTable.status === 0) {
  console.log('  the per-table suite does not notice, as expected — nobody wrote a test for it');
} else {
  console.log('  note: the per-table suite failed here for an unrelated reason');
}
if (guard.status !== 0) {
  console.log(`  the schema guard catches it (${summarise(guard)}) — control C OK`);
} else {
  console.error('  *** THE SCHEMA GUARD MISSED AN UNPROTECTED TABLE ***');
  failures += 1;
}

await withAdmin(scratchAdmin.toString(), (c) => c.query('DROP TABLE forgot_rls'));

// --- teardown -------------------------------------------------------------
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);
console.log('\nscratch database dropped.');

if (failures > 0) {
  console.error(`\n${failures} control(s) failed. Do not trust the isolation suite.`);
  process.exit(1);
}
console.log('all controls OK — the isolation suite fails when protection is removed, as it must.');
