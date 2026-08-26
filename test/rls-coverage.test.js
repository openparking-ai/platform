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
import { NOT_FORCED_BY_DESIGN } from './tenant-tables.js';

after(async () => {
  await pool.end();
});

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

test('events is append-only in the grants, not merely in its name', async () => {
  const { rows } = await pool.query(`
    SELECT has_table_privilege('openparking_app', 'events', 'SELECT') AS can_select,
           has_table_privilege('openparking_app', 'events', 'INSERT') AS can_insert,
           has_table_privilege('openparking_app', 'events', 'UPDATE') AS can_update,
           has_table_privilege('openparking_app', 'events', 'DELETE') AS can_delete`);
  assert.equal(rows[0].can_select, true, 'the app must be able to read events');
  assert.equal(rows[0].can_insert, true, 'the app must be able to append events');
  assert.equal(rows[0].can_update, false, 'append-only means no UPDATE grant');
  assert.equal(rows[0].can_delete, false, 'append-only means no DELETE grant');
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
