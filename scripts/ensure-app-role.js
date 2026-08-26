#!/usr/bin/env node
// Gives the application role a login and a password, and re-asserts the two
// attributes the whole isolation story rests on.
//
// Separate from the migration because a password belongs in the environment,
// not in a file that lives in a public repo forever.
import pg from 'pg';

const password = process.env.APP_DB_PASSWORD;
if (!password) {
  console.error('APP_DB_PASSWORD is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// Role names cannot be bind parameters; the name is a constant here, not input.
await client.query(
  `ALTER ROLE openparking_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${client.escapeLiteral(password)}`,
);

const { rows } = await client.query(
  'SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1',
  ['openparking_app'],
);

if (rows.length === 0) throw new Error('openparking_app does not exist — run npm run migrate first');
const role = rows[0];
if (role.rolsuper || role.rolbypassrls) {
  throw new Error(`openparking_app must not be SUPERUSER or BYPASSRLS: ${JSON.stringify(role)}`);
}

console.log('openparking_app ready:', role);
await client.end();
