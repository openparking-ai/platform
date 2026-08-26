/**
 * Tenant isolation, run generically against EVERY tenant-owned table.
 *
 * Set ISOLATION_TABLE to run one table only -- scripts/rls-fail-control.js uses
 * that to strip RLS from one table at a time and require this suite to fail.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { TENANT_TABLES } from './tenant-tables.js';

let A;
let B;
let worldA;
let worldB;

before(async () => {
  A = await createTenant('iso-a');
  B = await createTenant('iso-b');
  worldA = await buildWorld(A);
  worldB = await buildWorld(B);
});

after(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Guards. Every assertion below is meaningless if the connection under test can
// bypass row-level security, so these come first.
// ---------------------------------------------------------------------------

test('the connection under test cannot bypass RLS', async () => {
  const { rows } = await pool.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rolsuper, false, 'tests must not connect as a SUPERUSER — it bypasses RLS');
  assert.equal(rows[0].rolbypassrls, false, 'tests must not connect as a BYPASSRLS role');
});

// ---------------------------------------------------------------------------
// The same five assertions, for every table in the registry.
// ---------------------------------------------------------------------------

const only = process.env.ISOLATION_TABLE;
const tables = only ? TENANT_TABLES.filter((t) => t.table === only) : TENANT_TABLES;

if (only && tables.length === 0) {
  throw new Error(`ISOLATION_TABLE=${only} matches no table in the registry`);
}

for (const spec of tables) {
  const { table, insert, appendOnly, singleton } = spec;

  // A singleton table holds one row per tenant by construction (tenant_settings
  // is keyed on tenant_id), so its "second row" is another tenant's, and the
  // row's identity IS the tenant id.
  const key = singleton ? 'tenant_id' : 'id';

  test(`${table}: a tenant reads only its own rows`, async () => {
    const idB = (await withTenant(B, (c) => insert(c, B, worldB))).rows[0].id;

    const rows = await withTenant(A, async (c) => {
      await insert(c, A, worldA);
      // Deliberately unqualified — no WHERE tenant_id. This asks the database
      // alone to do the scoping, which is the thing under test.
      const { rows } = await c.query(`SELECT ${key} AS id, tenant_id FROM ${table}`);
      return rows;
    });

    assert.ok(rows.length > 0, 'tenant A should see its own rows');
    assert.ok(
      rows.every((r) => r.tenant_id === A),
      `${table} leaked a row belonging to another tenant`,
    );
    assert.ok(!rows.some((r) => r.id === idB), `${table} leaked tenant B's specific row to A`);
  });

  test(`${table}: naming another tenant's row id does not reveal it`, async () => {
    const idB = (await withTenant(B, (c) => insert(c, B, worldB))).rows[0].id;
    const rows = await withTenant(A, async (c) => {
      const { rows } = await c.query(`SELECT ${key} AS id FROM ${table} WHERE ${key} = $1`, [idB]);
      return rows;
    });
    assert.equal(rows.length, 0, `${table} revealed a row when its id was known`);
  });

  test(`${table}: a tenant cannot write a row attributed to another tenant`, async () => {
    // The WITH CHECK half. Without it, reads look isolated while writes are
    // wide open — the worst version of the bug, because the reading half of a
    // test suite stays green.
    await assert.rejects(
      () => withTenant(A, (c) => insert(c, B, worldB)),
      /row-level security/i,
      `${table} allowed tenant A to insert a row owned by tenant B`,
    );
  });

  if (!appendOnly) {
    test(`${table}: a tenant cannot update another tenant's row`, async () => {
      const idB = (await withTenant(B, (c) => insert(c, B, worldB))).rows[0].id;
      const count = await withTenant(A, async (c) => {
        const res = await c.query(`UPDATE ${table} SET tenant_id = tenant_id WHERE ${key} = $1`, [idB]);
        return res.rowCount;
      });
      assert.equal(count, 0, `${table} let tenant A update tenant B's row`);
    });

    test(`${table}: a tenant cannot delete another tenant's row`, async () => {
      const idB = (await withTenant(B, (c) => insert(c, B, worldB))).rows[0].id;
      const count = await withTenant(A, async (c) => {
        const res = await c.query(`DELETE FROM ${table} WHERE ${key} = $1`, [idB]);
        return res.rowCount;
      });
      assert.equal(count, 0, `${table} let tenant A delete tenant B's row`);
    });
  }

  test(`${table}: a connection with no tenant context reads nothing`, async () => {
    // current_tenant_id() is NULL when unset, and `tenant_id = NULL` is NULL
    // rather than true. Fail closed.
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`SELECT ${key} FROM ${table}`);
      assert.equal(rows.length, 0, `${table} is readable with no tenant context`);
    } finally {
      client.release();
    }
  });
}
