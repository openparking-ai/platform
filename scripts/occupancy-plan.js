#!/usr/bin/env node
/**
 * THE OCCUPANCY COUNT'S PLAN, before and after 0044.
 *
 * Every open counts the cars inside behind the garage's lock
 * (`repo.insideAt`, src/repository.js). This builds a scratch database with
 * every migration but 0044, puts STAYS stays in one garage (default
 * 300,000: a year of history, a few hundred cars still inside), and prints
 * the count's plan and its time as the application runs it -- as the app
 * role, under the tenant's row-level security, inside the garage's lock --
 * then applies 0044 and prints them again. The scratch database is dropped.
 *
 * The SQL is the one `insideAt` sends: captured from the function itself,
 * not copied here.
 *
 *   SUPERUSER_URL, DATABASE_URL, APP_DB_PASSWORD   as for the tests
 *   STAYS        how many stays (default 300000)
 *   PLAN_RUNS    how many timed runs each side (default 50)
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { insideAt, lockGarageOpens } from '../src/repository.js';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.OCCUPANCY_SCRATCH_DB || 'openparking_occupancy_plan';
const INDEX_FILE = '0044_occupancy_index.sql';
const STAYS = Number(process.env.STAYS ?? 300_000);
const RUNS = Number(process.env.PLAN_RUNS ?? 50);

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const owner = new URL(required('DATABASE_URL'));
owner.pathname = `/${SCRATCH}`;
const superuser = new URL(required('SUPERUSER_URL'));
const maintenance = new URL(superuser);
maintenance.pathname = '/postgres';
superuser.pathname = `/${SCRATCH}`;
const app = new URL(`postgres://openparking_app@${owner.host}/${SCRATCH}`);
app.password = required('APP_DB_PASSWORD');
const env = { ...process.env, DATABASE_URL: owner.toString(), APP_DATABASE_URL: app.toString() };

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function migrate(dir) {
  for (const script of ['scripts/prepare-database.js', 'scripts/migrate.js']) {
    const result = spawnSync(process.execPath, [script], { cwd: ROOT, env: { ...env, MIGRATIONS_DIR: dir }, encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(result.stdout, result.stderr);
      throw new Error(`${script} failed against the scratch database`);
    }
  }
}

/** One garage with STAYS stays: closed ones over the last year, the newest few hundred still inside. */
async function seed() {
  return withClient(superuser, async (c) => {
    await c.query('BEGIN');
    // The rows are put in place as no role of a deployment can: the
    // triggers that check a row's own account are not what is measured.
    await c.query('SET LOCAL session_replication_role = replica');
    const tenant = (await c.query("INSERT INTO tenants (slug, name) VALUES ('plan', 'plan') RETURNING id")).rows[0].id;
    const garage = (await c.query(
      `INSERT INTO garages (tenant_id, name, timezone, currency, spaces, activated_at)
       VALUES ($1, 'Plan', 'UTC', 'USD', 900, now() - interval '400 days') RETURNING id`, [tenant])).rows[0].id;
    const lane = async (name, direction) => (await c.query(
      'INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1, $2, $3, $4) RETURNING id',
      [tenant, garage, name, direction])).rows[0].id;
    const entry = await lane('In', 'entry');
    const exit = await lane('Out', 'exit');
    await c.query(
      `INSERT INTO vehicles (tenant_id, plate)
       SELECT $1, 'PLN' || lpad(i::text, 7, '0') FROM generate_series(1, $2) i`, [tenant, STAYS]);
    // One stay a vehicle, entries evenly over 365 days, stays of 1 to 9
    // hours; the newest 400 have no exit yet.
    await c.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency, open_event_id,
                             entry_confirmation, exit_at, exit_lane_id, close_event_id, exit_confirmation,
                             exit_outcome, decided_by, entitlement)
       SELECT $1, $2, v.id, $3, e.entry_at, 'USD', 'open-' || v.n, 'confirmed',
              CASE WHEN v.n > $5 - 400 THEN NULL ELSE e.entry_at + make_interval(mins => (60 + (v.n * 37) % 480)::int) END,
              CASE WHEN v.n > $5 - 400 THEN NULL ELSE $4::uuid END,
              CASE WHEN v.n > $5 - 400 THEN NULL ELSE 'close-' || v.n END,
              CASE WHEN v.n > $5 - 400 THEN NULL ELSE 'confirmed' END,
              CASE WHEN v.n > $5 - 400 THEN NULL ELSE 'covered' END,
              CASE WHEN v.n > $5 - 400 THEN NULL ELSE 'platform' END,
              CASE WHEN v.n > $5 - 400 THEN NULL ELSE '{}'::jsonb END
         FROM (SELECT id, row_number() OVER (ORDER BY plate) AS n FROM vehicles WHERE tenant_id = $1) v
        CROSS JOIN LATERAL (SELECT now() - interval '365 days' + (v.n::float / $5) * interval '365 days' - interval '2 hours' AS entry_at) e`,
      [tenant, garage, entry, exit, STAYS]);
    await c.query('COMMIT');
    await c.query('ANALYZE sessions');
    await c.query('ANALYZE garages');
    return { tenant, garage };
  });
}

/** The SQL and the values `insideAt` sends, taken from the function itself. */
async function capturedCount(tenant, garage, at) {
  let sent;
  await insideAt({ query: async (text, values) => { sent = { text, values }; return { rows: [] }; } }, tenant, garage, at);
  return sent;
}

/** The count's plan and its median time, as the app role in the tenant, behind the garage's lock. */
async function measure(label, tenant, garage) {
  return withClient(app, async (c) => {
    const { text, values } = await capturedCount(tenant, garage, new Date());
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['openparking.tenant_id', tenant]);
    await lockGarageOpens(c, garage);
    const plan = (await c.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING ON) ${text}`, values)).rows.map((r) => r['QUERY PLAN']);
    const times = [];
    let inside;
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = process.hrtime.bigint();
      inside = (await c.query(text, values)).rows[0].inside;
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    await c.query('COMMIT');
    times.sort((a, b) => a - b);
    console.log(`\n== ${label} ==`);
    console.log(`cars inside: ${inside}; median ${times[Math.floor(times.length / 2)].toFixed(2)} ms over ${RUNS} runs (min ${times[0].toFixed(2)}, max ${times[times.length - 1].toFixed(2)})`);
    console.log(plan.join('\n'));
    return plan.join('\n');
  });
}

await withClient(maintenance, (c) => c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`));
const without = mkdtempSync(join(tmpdir(), 'openparking-occupancy-migrations-'));
try {
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql') && f !== INDEX_FILE)) {
    copyFileSync(join(ROOT, 'migrations', file), join(without, file));
  }
  migrate(without);
  const { tenant, garage } = await seed();
  console.log(`${STAYS} stays in one garage, ${new Date().toISOString()}`);
  console.log(`query (src/repository.js insideAt):\n${(await capturedCount(tenant, garage, new Date())).text}`);
  await measure(`before ${INDEX_FILE}`, tenant, garage);
  migrate(join(ROOT, 'migrations'));
  await withClient(superuser, (c) => c.query('ANALYZE sessions'));
  const afterPlan = await measure(`after ${INDEX_FILE}`, tenant, garage);
  if (!afterPlan.includes('sessions_garage_exit_idx')) {
    console.error(`\nthe count does not use sessions_garage_exit_idx after ${INDEX_FILE}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(without, { recursive: true, force: true });
  await withClient(maintenance, (c) => c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`));
}
