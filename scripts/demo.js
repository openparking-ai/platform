#!/usr/bin/env node
/**
 * One command: database, schema, app role, demo garage, running server.
 *
 * Writes .demo-credentials.json (gitignored) so the lane controller in the
 * sibling repository can pick up the device tokens without anyone copying a
 * secret between two terminals.
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { withTenant, pool } from '../src/db.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl || !process.env.APP_DB_PASSWORD || !process.env.APP_DATABASE_URL) {
  console.error('DATABASE_URL, APP_DATABASE_URL and APP_DB_PASSWORD are required (copy .env.example)');
  process.exit(1);
}

const dbName = new URL(adminUrl).pathname.slice(1);
const maintenance = new URL(adminUrl);
maintenance.pathname = '/postgres';

// 1. database
const admin = new pg.Client({ connectionString: maintenance.toString() });
await admin.connect();
const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (rowCount === 0) {
  await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);
  console.log(`created database ${dbName}`);
}
await admin.end();

// 2. schema and role
for (const script of ['scripts/migrate.js', 'scripts/ensure-app-role.js']) {
  const r = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 3. a garage with two lanes, a rate, and a device on each lane
const tenantId = randomUUID();
await withTenant(tenantId, (c) =>
  c.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)', [
    tenantId,
    `demo-${tenantId.slice(0, 8)}`,
    'Demo Operator',
  ]),
);

const entryToken = generateDeviceToken();
const exitToken = generateDeviceToken();

const demo = await withTenant(tenantId, async (c) => {
  const garage = (
    await c.query(
      `INSERT INTO garages (tenant_id, name, timezone, currency)
       VALUES ($1,'Demo Garage','America/New_York','USD') RETURNING id`,
      [tenantId],
    )
  ).rows[0].id;

  const lane = async (name, direction) =>
    (
      await c.query(
        `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`,
        [tenantId, garage, name, direction],
      )
    ).rows[0].id;

  const entryLane = await lane('Entry 1', 'entry');
  const exitLane = await lane('Exit 1', 'exit');

  await c.query(
    `INSERT INTO rates (tenant_id, garage_id, name, hourly_minor) VALUES ($1,$2,'Hourly',250)`,
    [tenantId, garage],
  );

  for (const [laneId, token, name] of [
    [entryLane, entryToken, 'Entry lane controller'],
    [exitLane, exitToken, 'Exit lane controller'],
  ]) {
    await c.query(
      `INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)`,
      [tenantId, laneId, name, hashToken(token)],
    );
  }

  return { garage, entryLane, exitLane };
});

const port = Number(process.env.PORT || 3000);
const credentials = {
  base_url: `http://127.0.0.1:${port}`,
  tenant_id: tenantId,
  garage_id: demo.garage,
  currency: 'USD',
  hourly_minor: 250,
  entry_token: entryToken,
  exit_token: exitToken,
};
writeFileSync('.demo-credentials.json', `${JSON.stringify(credentials, null, 2)}\n`);

createApp().listen(port, () => {
  console.log(`
──────────────────────────────────────────────────────────────
 Open Parking AI — demo platform listening on :${port}

   tenant   ${tenantId}
   garage   ${demo.garage}  (Demo Garage, USD, 2.50/hour)
   lanes    Entry 1, Exit 1

 Device tokens written to .demo-credentials.json
 Run the lane against it from the lane-controller repository:

   python -m lane_controller.demo --credentials ../platform/.demo-credentials.json

 Inside count:
   curl -H "x-tenant-id: ${tenantId}" \\
     http://127.0.0.1:${port}/api/v1/garages/${demo.garage}/sessions/open
──────────────────────────────────────────────────────────────`);
});

process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});
