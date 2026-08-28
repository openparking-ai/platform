#!/usr/bin/env node
/**
 * The control for the schema gate.
 *
 * `src/schema.js` refuses to start the service on a database its own migrations
 * have not reached. A check that has never been observed refusing is not known
 * to refuse anything, so this builds the exact state the gate exists for -- the
 * code on a host the migration has not got to yet -- and REQUIRES the service
 * to fail to start. A successful start is the failure.
 *
 * The behind-state is real, not simulated. It runs the repository's own
 * `scripts/migrate.js` against a copy of `migrations/` with the newest file
 * left out, so the scratch database is a database that genuinely never had that
 * migration: no column, no row in `schema_migrations`. Deleting a bookkeeping
 * row would have proved only that the gate can read a table.
 *
 * Control B is the other half and it is not decoration. A gate that refuses
 * everything refuses correctly for the wrong reason, and a deployment blocked
 * by a check that can never pass gets the check removed. So the same migration
 * is then applied and the same command must serve.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = process.env.SCRATCH_DB || 'openparking_schema_gate_control';
const PORT = Number(process.env.SCHEMA_GATE_PORT || 3999);

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

const base = new URL(adminUrl);
const scratchAdmin = new URL(adminUrl);
scratchAdmin.pathname = `/${SCRATCH}`;
const scratchApp = new URL(`postgres://openparking_app@${base.host}/${SCRATCH}`);
scratchApp.password = appPassword;
const maintenance = new URL(adminUrl);
maintenance.pathname = '/postgres';

const env = {
  ...process.env,
  DATABASE_URL: scratchAdmin.toString(),
  APP_DATABASE_URL: scratchApp.toString(),
  PORT: String(PORT),
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

function run(script, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error(`${script} failed`);
  }
  return result;
}

/** Start src/server.js and report how it went, whichever way it went. */
function startService() {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, encoding: 'utf8' });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const serving = (async () => {
    // Whichever happens first: it answers, or it is gone. Polling alone would
    // spend the whole deadline on a process that died in the first 50ms.
    const deadline = Date.now() + 10_000;
    let done = false;
    exited.then(() => (done = true));
    while (!done && Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        if (res.ok) return await res.json();
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  })();

  return { child, exited, serving, output: () => stdout + stderr };
}

// --- build the scratch database, one migration behind ----------------------

const migrations = readdirSync(path.join(ROOT, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();
const withheld = migrations[migrations.length - 1];
if (!withheld) throw new Error('no migrations on disk — there is nothing to be behind');

console.log(`== rebuilding scratch database '${SCRATCH}', withholding ${withheld} ==`);
await withAdmin(maintenance.toString(), async (c) => {
  await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
});

const partial = mkdtempSync(path.join(tmpdir(), 'openparking-migrations-'));
for (const file of migrations.filter((f) => f !== withheld)) {
  copyFileSync(path.join(ROOT, 'migrations', file), path.join(partial, file));
}

run('scripts/migrate.js', { MIGRATIONS_DIR: partial });
run('scripts/ensure-app-role.js');

let failures = 0;

// --- control A: it must refuse ---------------------------------------------

console.log('\n== control A: the service must REFUSE to start while the database is behind ==');
{
  const service = startService();
  // NOT `Promise.all([exited, serving])`. That was the first version of this
  // line and it HUNG when the gate was removed to test it: the service came
  // up, so `exited` never resolved, and a control that hangs instead of
  // failing is the very thing it exists to catch. `serving` resolves either
  // way -- with a payload, or with null once the process is gone.
  const payload = await service.serving;
  const code = payload === null ? await service.exited : null;
  const output = service.output();

  if (payload) {
    console.error(`  *** IT SERVED — /healthz answered ${JSON.stringify(payload)} on a database`);
    console.error(`  *** that never had ${withheld}. The gate is not a gate.`);
    failures += 1;
  } else if (code === 0) {
    console.error('  *** it exited 0 on a database it is ahead of ***');
    failures += 1;
  } else if (!output.includes('REFUSING TO SERVE') || !output.includes(withheld)) {
    // Anything can exit non-zero. It has to exit non-zero FOR THIS REASON, or
    // the control would pass on a typo in the connection string.
    console.error(`  *** it exited ${code}, but not with a refusal naming ${withheld}:`);
    console.error(output.trim());
    failures += 1;
  } else {
    console.log(`  refuses as required (exit ${code})`);
    console.log(`  ${output.trim().split('\n').pop()}`);
  }
  service.child.kill();
  await service.exited;
}

// --- control B: and it must serve once the migration is applied ------------

console.log('\n== control B: the same command must SERVE once the migration is applied ==');
run('scripts/migrate.js');
{
  const service = startService();
  const payload = await service.serving;
  if (payload) {
    console.log(`  serves as required — /healthz ${JSON.stringify(payload)}`);
  } else {
    const code = await service.exited;
    console.error(`  *** it did not serve a fully migrated database (exit ${code}) ***`);
    console.error(service.output().trim());
    failures += 1;
  }
  service.child.kill();
  await service.exited;
}

// --- teardown ---------------------------------------------------------------

rmSync(partial, { recursive: true, force: true });
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);
console.log('\nscratch database dropped.');

if (failures > 0) {
  console.error(`\n${failures} control(s) failed. The deploy-ordering constraint is not enforced.`);
  process.exit(1);
}
console.log('both controls OK — the service refuses a database it is ahead of, and serves one it is not.');
