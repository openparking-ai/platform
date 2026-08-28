#!/usr/bin/env node
// Applies migrations/*.sql in filename order, as the OWNER connection.
// Forward-only: a migration that has been applied is never edited, only followed.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

// MIGRATIONS_DIR exists for scripts/schema-gate-control.js, which has to build
// a database that is genuinely one migration behind and does it by running THIS
// runner against a directory with the newest file left out. src/schema.js
// deliberately does not honour it: the runner can be told where to take files
// from, the service asserts against the migrations it shipped with.
const dir = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

const applied = new Set(
  (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
);

const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
let count = 0;

for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip  ${file} (already applied)`);
    continue;
  }
  const sql = await readFile(path.join(dir, file), 'utf8');
  console.log(`apply ${file}`);
  await client.query(sql);
  await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
  count += 1;
}

// The application role reads this table at startup and refuses to serve a
// database it is ahead of -- see src/schema.js. SELECT only: the bookkeeping is
// written by this script, as the owner, and by nothing else. Granted here
// rather than in a numbered migration because this is where the table is
// created, and it is re-granted on every run so a database that predates the
// check gets it the moment it is migrated. 0001 creates the role, so by this
// point it exists.
await client.query('GRANT SELECT ON schema_migrations TO openparking_app');

console.log(`${count} migration(s) applied, ${files.length} total on disk`);
await client.end();
