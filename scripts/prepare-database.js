#!/usr/bin/env node
// The one step that needs a superuser. Everything after it -- every other
// migration, and the application -- runs without one.
//
//   SUPERUSER_URL   a superuser on the cluster. In a deployment, only this
//                   step uses it.
//   DATABASE_URL    the owner: its role, its password and its database.
//   APP_DB_PASSWORD the application role's password.
//   MIGRATIONS_DIR  optional, as for scripts/migrate.js: where 0001 is read.
//
// It does four things, each only if it is not done yet, and refuses rather
// than guess:
//
//   1. The owner role exists, NOSUPERUSER and NOBYPASSRLS. Made if missing
//      (LOGIN, with DATABASE_URL's password). An existing owner is never
//      altered: one that is a superuser or bypasses row-level security is
//      refused by name, because every policy here would be inert for it.
//   2. The database exists, and the owner may create in its public schema.
//      Made if missing, owned by the owner.
//   3. Migration 0001, on a database that has not got it. Its first statement
//      gives the application role NOSUPERUSER and NOBYPASSRLS, and Postgres
//      lets only a superuser change SUPERUSER -- even to say "no" -- so an
//      ordinary owner cannot run it once the role exists on the cluster. It
//      runs here, as it is (it is applied everywhere and is never edited), and
//      the three things it makes -- tenants, parking_sites, current_tenant_id()
//      -- are handed to the owner and recorded in schema_migrations, so the
//      owner owns everything and `npm run migrate` starts at 0002.
//   4. The application role: LOGIN, the password, NOSUPERUSER NOBYPASSRLS
//      NOCREATEDB NOCREATEROLE, and not a member of the owner.
//
// The password belongs in the environment, not in a file that lives in a
// public repo forever, which is why none of this is a numbered migration.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const FIRST = '0001_tenants_and_rls.sql';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function refuse(message) {
  console.error(`prepare-database: ${message}`);
  process.exit(1);
}

const superuserUrl = required('SUPERUSER_URL');
const ownerUrl = new URL(required('DATABASE_URL'));
const appPassword = required('APP_DB_PASSWORD');

const owner = decodeURIComponent(ownerUrl.username);
const ownerPassword = decodeURIComponent(ownerUrl.password);
const database = decodeURIComponent(ownerUrl.pathname.slice(1));
if (!owner || !database) refuse('DATABASE_URL must name the owner role and the database');

const cluster = new URL(superuserUrl);
cluster.pathname = '/postgres';
const onDatabase = new URL(superuserUrl);
onDatabase.pathname = `/${encodeURIComponent(database)}`;

async function connect(url) {
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

const roleOf = async (c, name) =>
  (await c.query('SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = $1', [name]))
    .rows[0];

// --- 1 and 2: the owner and the database ----------------------------------
const c = await connect(cluster);
try {
  if (!(await c.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper) {
    refuse('SUPERUSER_URL is not a superuser; this is the one step that needs one');
  }

  const ownerRole = await roleOf(c, owner);
  if (!ownerRole) {
    if (!ownerPassword) refuse(`the owner ${owner} does not exist, and DATABASE_URL has no password to make it with`);
    await c.query(
      `CREATE ROLE ${pg.escapeIdentifier(owner)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${c.escapeLiteral(ownerPassword)}`,
    );
    console.log(`owner ${owner}: made, NOSUPERUSER NOBYPASSRLS`);
  } else if (ownerRole.rolsuper || ownerRole.rolbypassrls) {
    refuse(
      `the owner ${owner} is ${ownerRole.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'}; it must be neither -- ` +
        'every policy is inert for such a role, and nothing that depends on one would ever be measured',
    );
  } else {
    console.log(`owner ${owner}: present, NOSUPERUSER NOBYPASSRLS`);
  }

  const exists = (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount > 0;
  if (!exists) {
    await c.query(`CREATE DATABASE ${pg.escapeIdentifier(database)} OWNER ${pg.escapeIdentifier(owner)}`);
    console.log(`database ${database}: made, owned by ${owner}`);
  } else {
    console.log(`database ${database}: present`);
  }
} finally {
  await c.end();
}

// --- 3: migration 0001 ------------------------------------------------------
const d = await connect(onDatabase);
try {
  if (!(await d.query("SELECT has_schema_privilege($1, 'public', 'CREATE') AS can", [owner])).rows[0].can) {
    refuse(`the owner ${owner} cannot create in ${database}'s public schema`);
  }

  const recorded =
    (await d.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS has")).rows[0].has &&
    (await d.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [FIRST])).rowCount > 0;

  if (recorded) {
    console.log(`${FIRST}: already applied`);
  } else {
    // A run that stopped between applying 0001 and recording it finishes the
    // handing over; it does not apply 0001 twice.
    if ((await d.query("SELECT to_regclass('public.tenants') IS NULL AS fresh")).rows[0].fresh) {
      // From where scripts/migrate.js takes the rest, so a control's copy of
      // migrations/ is built whole.
      const dir = process.env.MIGRATIONS_DIR
        ? path.resolve(process.env.MIGRATIONS_DIR)
        : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
      const file = path.join(dir, FIRST);
      console.log(`apply ${FIRST} (as the superuser: its role statement needs one)`);
      await d.query(await readFile(file, 'utf8'));
    }

    const o = pg.escapeIdentifier(owner);
    await d.query('BEGIN');
    await d.query(`ALTER TABLE tenants OWNER TO ${o}`);
    await d.query(`ALTER TABLE parking_sites OWNER TO ${o}`);
    await d.query(`ALTER FUNCTION current_tenant_id() OWNER TO ${o}`);
    // The bookkeeping table is the owner's, made as the owner, exactly as
    // scripts/migrate.js makes it.
    await d.query(`SET LOCAL ROLE ${o}`);
    await d.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    await d.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FIRST]);
    await d.query('COMMIT');
    console.log(`${FIRST}: applied; tenants, parking_sites and current_tenant_id() handed to ${owner}`);
  }

  // Nothing this step made is left with the superuser.
  const strays = (
    await d.query(
      `SELECT c.relname AS name FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
           AND pg_get_userbyid(c.relowner) <> $1
       UNION ALL
       SELECT p.oid::regprocedure::text FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND pg_get_userbyid(p.proowner) <> $1
       ORDER BY 1`,
      [owner],
    )
  ).rows.map((r) => r.name);
  if (strays.length) refuse(`not owned by ${owner}: ${strays.join(', ')}`);
} finally {
  await d.end();
}

// --- 4: the application role ------------------------------------------------
const a = await connect(cluster);
try {
  // Role names cannot be bind parameters; the name is a constant here, not input.
  await a.query(
    `ALTER ROLE openparking_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${a.escapeLiteral(appPassword)}`,
  );
  const role = await roleOf(a, 'openparking_app');
  if (role.rolsuper || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole) {
    refuse(`openparking_app has a structural attribute: ${JSON.stringify(role)}`);
  }
  // The definers' cross-account lookups (0031) are written for the owner; a
  // member of the owner would be the owner for them.
  if ((await a.query("SELECT pg_has_role('openparking_app', $1, 'MEMBER') AS is", [owner])).rows[0].is) {
    refuse(`openparking_app is a member of the owner ${owner}`);
  }
  console.log('openparking_app ready:', role);
} finally {
  await a.end();
}
