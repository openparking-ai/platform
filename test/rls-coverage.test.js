/**
 * The schema-wide guard.
 *
 * The per-table isolation suite only covers tables somebody remembered to add
 * to the registry. This walks the SCHEMA instead, so a new table that forgets
 * row-level security is caught even though — by definition — nobody wrote a
 * test for it.
 *
 * Measured before this existed: a table with a tenant_id and no RLS was added
 * to a scratch database and the whole suite stayed green, 8 of 8.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { NOT_FORCED_BY_DESIGN, TABLES_WITHOUT_TENANT_ID } from './tenant-tables.js';

after(async () => {
  await pool.end();
});

/** Every ordinary table in public, whether or not it carries a tenant_id. */
async function allTables() {
  const { rows } = await pool.query(`
    SELECT c.relname AS table,
           EXISTS (
             SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
           ) AS has_tenant_id
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`);
  return rows;
}

/** Every ordinary table in public that carries a tenant_id column. */
async function tenantOwnedTables() {
  const { rows } = await pool.query(`
    SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY c.relname`);
  return rows;
}

test('the guard actually finds tables (a control on the query itself)', async () => {
  const tables = await tenantOwnedTables();
  assert.ok(tables.length >= 6, `expected the core tenant tables, found ${tables.length}`);
});

test('EVERY table is either tenant-owned or on the explicit allow list', async () => {
  // The guard that catches the table nobody thought about. A table with no
  // tenant_id is not automatically fine -- it is either deliberately global,
  // and named in TABLES_WITHOUT_TENANT_ID with a reason, or it is a tenant
  // table that forgot its column and is readable by everyone.
  const unaccounted = (await allTables())
    .filter((t) => !t.has_tenant_id && !(t.table in TABLES_WITHOUT_TENANT_ID))
    .map((t) => t.table);

  assert.deepEqual(
    unaccounted,
    [],
    `these tables have no tenant_id and no entry in TABLES_WITHOUT_TENANT_ID: ${unaccounted.join(', ')}. ` +
      'Either add the tenant column and its policy, or record why the table is global.',
  );
});

test('the allow list has no stale entries', async () => {
  // A list that keeps naming tables which no longer exist stops being read.
  const present = new Set((await allTables()).map((t) => t.table));
  const stale = Object.keys(TABLES_WITHOUT_TENANT_ID).filter((t) => !present.has(t));
  assert.deepEqual(stale, [], `allow list names tables that do not exist: ${stale.join(', ')}`);
});

test('every tenant-owned table has row-level security ENABLED', async () => {
  const missing = (await tenantOwnedTables()).filter((t) => !t.enabled).map((t) => t.table);
  assert.deepEqual(
    missing,
    [],
    `these tables carry a tenant_id but have no row-level security: ${missing.join(', ')}`,
  );
});

test('every tenant-owned table has at least one policy', async () => {
  const bare = (await tenantOwnedTables()).filter((t) => Number(t.policies) === 0).map((t) => t.table);
  assert.deepEqual(bare, [], `RLS enabled but no policy — reads nothing, writes nothing: ${bare.join(', ')}`);
});

test('FORCE is on everywhere except the documented exceptions, and the exception list is exact', async () => {
  const notForced = (await tenantOwnedTables()).filter((t) => !t.forced).map((t) => t.table).sort();
  assert.deepEqual(
    notForced,
    [...NOT_FORCED_BY_DESIGN].sort(),
    'a table is missing FORCE ROW LEVEL SECURITY, or an exception was added without documenting it in tenant-tables.js',
  );
});

test('tenants itself is protected', async () => {
  const { rows } = await pool.query(
    `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE relname = 'tenants'`,
  );
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].forced, true);
});

test('events is append-only: an UPDATE as the app role actually fails', async () => {
  // Performed, not inferred from a privilege table. A catalogue lookup tells
  // you what the catalogue says; running the statement tells you what the
  // database does.
  await assert.rejects(
    () => pool.query("UPDATE events SET kind = 'tampered'"),
    /permission denied/i,
    'the app role must not be able to rewrite the event log',
  );
});

test('events is append-only: a DELETE as the app role actually fails', async () => {
  await assert.rejects(
    () => pool.query('DELETE FROM events'),
    /permission denied/i,
    'the app role must not be able to erase the event log',
  );
});

test('events remains readable and appendable as the app role', async () => {
  // The control on the two above: if the app role could do nothing at all with
  // events, those rejections would pass for the wrong reason.
  await pool.query('SELECT id FROM events LIMIT 1');
  const { rows } = await pool.query(`
    SELECT has_table_privilege('openparking_app', 'events', 'SELECT') AS can_select,
           has_table_privilege('openparking_app', 'events', 'INSERT') AS can_insert`);
  assert.equal(rows[0].can_select, true);
  assert.equal(rows[0].can_insert, true);
});

test('the application role has no structural privileges', async () => {
  const { rows } = await pool.query(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname = 'openparking_app'`,
  );
  assert.deepEqual(rows[0], {
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
  });
});
