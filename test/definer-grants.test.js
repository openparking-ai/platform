/**
 * WHO MAY RUN A DEFINER (0024).
 *
 * A SECURITY DEFINER function runs as its owner, and a function is executable
 * by PUBLIC when it is made. Before 0024 took that away, any role on the
 * database -- one with no grant of any kind -- could call
 * `resolve_operator_user(email)` and read that admin's password hash.
 *
 * Held here for EVERY definer in the schema, found by walking pg_proc, not for
 * a list: none is executable by PUBLIC; a role with no grants is refused each
 * one by name; and the application role, which is every caller there is, still
 * runs each one the way the code calls it.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pool, superuserClient } from './helpers.js';

// A superuser on this database: the test makes a role with no grants and
// becomes it, which the owner -- NOCREATEROLE -- may not.
let owner;
before(async () => {
  owner = superuserClient();
  await owner.connect();
});
after(async () => {
  await owner.end();
  await pool.end();
});

const definers = async () =>
  (await owner.query(`
    SELECT p.oid, p.proname AS name, oidvectortypes(p.proargtypes) AS types,
           has_function_privilege('public', p.oid, 'EXECUTE') AS public_can,
           has_function_privilege('openparking_app', p.oid, 'EXECUTE') AS app_can
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
     ORDER BY p.proname`)).rows;

/** A call of `fn` with every argument NULL of its own type. */
const nullCall = (d) => `SELECT * FROM ${pg.escapeIdentifier(d.name)}(${d.types ? d.types.split(', ').map((t) => `NULL::${t}`).join(', ') : ''})`;

test('every SECURITY DEFINER function in the schema is closed to PUBLIC and open to the application role', async () => {
  const found = await definers();
  // The seven there are today. A new one is held by the same walk.
  for (const name of ['list_tenant_ids_for_maintenance', 'resolve_lane_device', 'resolve_operator_session', 'resolve_operator_token',
    'resolve_operator_user', 'touch_lane_device', 'touch_operator_token']) {
    assert.ok(found.some((d) => d.name === name), `the walk finds ${name}`);
  }
  assert.deepEqual(found.filter((d) => d.public_can).map((d) => d.name), [], 'executable by PUBLIC');
  assert.deepEqual(found.filter((d) => !d.app_can).map((d) => d.name), [], 'not executable by the application role');
});

test('a role with no grants is refused each definer by name: permission denied', async () => {
  const role = `no_grants_${randomUUID().slice(0, 8)}`;
  await owner.query(`CREATE ROLE ${pg.escapeIdentifier(role)} NOLOGIN`);
  try {
    const found = await definers();
    assert.ok(found.length >= 7);
    const answered = [];
    for (const d of found) {
      await owner.query('BEGIN');
      try {
        await owner.query(`SET LOCAL ROLE ${pg.escapeIdentifier(role)}`);
        await owner.query(nullCall(d));
        answered.push(`${d.name}: ran`);
      } catch (err) {
        if (!(err.code === '42501' && err.message === `permission denied for function ${d.name}`)) answered.push(`${d.name}: ${err.code} ${err.message}`);
      } finally {
        await owner.query('ROLLBACK');
      }
    }
    assert.deepEqual(answered, [], 'each one must be refused by name');
  } finally {
    await owner.query(`DROP ROLE ${pg.escapeIdentifier(role)}`);
  }
});

test('every caller still works: the application role runs each definer the way the code calls it', async () => {
  // As the application role (APP_DATABASE_URL): the operator key, the session,
  // the sign-in lookup, the lane device, and the maintenance sweep.
  assert.deepEqual((await pool.query('SELECT * FROM resolve_operator_token($1)', ['0'.repeat(64)])).rows, []);
  await pool.query('SELECT touch_operator_token($1)', [randomUUID()]);
  assert.deepEqual((await pool.query('SELECT * FROM resolve_operator_session($1, $2)', ['0'.repeat(64), 1800])).rows, []);
  assert.deepEqual((await pool.query('SELECT * FROM resolve_operator_user($1)', ['nobody-definer@example.com'])).rows, []);
  assert.deepEqual((await pool.query('SELECT * FROM resolve_lane_device($1)', ['0'.repeat(64)])).rows, []);
  await pool.query('SELECT touch_lane_device($1)', [randomUUID()]);
  assert.ok(Array.isArray((await pool.query('SELECT tenant_id FROM list_tenant_ids_for_maintenance()')).rows));
  // The whole paths are the suite's: an operator key (api), a lane device
  // (lane-devices), a session (owner-sign-in) and the purge (retention).
});
