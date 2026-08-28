/**
 * The service does not serve on a database its own migrations have not reached.
 *
 * `/lane/rules` serves columns. `repo.getGarage` is `SELECT *`, so a column the
 * code expects and the database does not have is not an error and not a null --
 * `JSON.stringify` drops the key and the route answers 200 with a payload one
 * key SHORTER. The lane reads the missing key as unmeasured and an unknown
 * plate that would have been admitted is refused instead. No error, no symptom,
 * a shorter payload; measured on `default_action` when 0004 was written.
 *
 * That is an ordering constraint -- migrate first, then deploy -- and an
 * ordering constraint is a CHECK, never a memory. A line in a README is a
 * memory: it is read once, by whoever set the deployment up, and never again by
 * whoever rolls the next image out at speed.
 *
 * So the constraint is encoded where it cannot be satisfied by remembering: the
 * process refuses to start. There is nothing to remember, nothing to opt into
 * and no flag that turns it off.
 *
 * It uses the mechanism this platform already has for knowing its own schema
 * state -- `schema_migrations`, the table `scripts/migrate.js` creates and
 * writes a row into for every file it applies. Asking the catalogue which
 * columns exist would be a SECOND mechanism describing the same fact, and two
 * of those drift.
 *
 * Both sides are derived, neither is typed. The expected set is read from the
 * migrations directory that shipped with this code; the applied set is read
 * from the table. A migration added to the directory is covered the moment it
 * is added, which a hand-maintained list of filenames would not be.
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './db.js';

/**
 * The migrations this build ships with.
 *
 * Deliberately NOT `process.env.MIGRATIONS_DIR`, which `scripts/migrate.js`
 * honours so the fail-control can build a database that is genuinely one
 * migration behind. The runner can be told where to take files from; the
 * service asserts against what it shipped with, or the check could be
 * satisfied by pointing it somewhere emptier.
 */
export const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/**
 * Every migration filename this build carries.
 *
 * ZERO of them is a refusal, in the same place and for the same reason a
 * MISSING directory already is one -- `readdir` raises ENOENT here and the
 * process never opens the port. An empty directory would otherwise be the one
 * input this gate cannot say no to: `pendingMigrations` subtracts the applied
 * set from an empty set, gets `[]` for every database in the universe, and the
 * service serves having established nothing at all. A build that ships no
 * migrations cannot assert its schema, and an assertion it cannot make is a
 * refusal, exactly like being behind.
 *
 * `scripts/schema-gate-control.js` already carries this guard -- it refuses to
 * run vacuously when it has no file to withhold. The gate it controls holds
 * itself to the same rule.
 *
 * @returns {Promise<string[]>}
 */
export async function migrationsOnDisk() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new Error(
      `no migrations on disk -- there is nothing to be behind. ${MIGRATIONS_DIR} carries no ` +
        '.sql file, so nothing here establishes that this database has had anything applied.',
    );
  }
  return files;
}

/**
 * Migration files this build carries that the database has no row for.
 *
 * A database with no `schema_migrations` table at all has had NOTHING applied,
 * which is every migration pending rather than an unrelated failure -- so that
 * one Postgres code is translated and every other error is left to raise. An
 * error must never read as "up to date": not being able to find out is a
 * refusal, exactly like being behind.
 *
 * `permission denied` gets its own message rather than the raw one, because it
 * is the state a database migrated BEFORE this check existed is in -- the
 * SELECT grant is made by scripts/migrate.js -- and an operator whose database
 * is in fact current needs to be told the one command that fixes it.
 *
 * @param {import('pg').Pool | import('pg').PoolClient | import('pg').Client} client
 * @returns {Promise<string[]>}
 */
export async function pendingMigrations(client = pool) {
  const files = await migrationsOnDisk();
  let applied;
  try {
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    applied = new Set(rows.map((row) => row.filename));
  } catch (err) {
    if (err.code === '42501') {
      // insufficient_privilege
      throw new Error(
        'the application role cannot read schema_migrations, so whether this database has had ' +
          `this build's migrations cannot be established. Run \`npm run migrate\` against it: ` +
          'it applies anything outstanding and grants the SELECT this check needs.',
      );
    }
    if (err.code !== '42P01') throw err; // undefined_table
    applied = new Set();
  }
  return files.filter((file) => !applied.has(file));
}

/**
 * Throws unless every migration this build carries has been applied.
 *
 * @param {import('pg').Pool | import('pg').PoolClient | import('pg').Client} client
 */
export async function assertSchemaCurrent(client = pool) {
  const pending = await pendingMigrations(client);
  if (pending.length === 0) return;
  throw new Error(
    `the database is behind this build by ${pending.length} migration(s): ${pending.join(', ')}. ` +
      'Serving anyway would answer with columns this database does not have, which is not an ' +
      'error downstream -- it is a shorter payload and a changed lane decision. ' +
      'Run `npm run migrate` against this database, then start the service.',
  );
}
