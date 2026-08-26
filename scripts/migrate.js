#!/usr/bin/env node
// Applies migrations/*.sql in filename order, as the OWNER connection.
// Forward-only: a migration that has been applied is never edited, only followed.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

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

console.log(`${count} migration(s) applied, ${files.length} total on disk`);
await client.end();
