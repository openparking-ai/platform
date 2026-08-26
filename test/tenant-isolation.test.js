import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant, createTenant, createSite } from './helpers.js';

let tenantA;
let tenantB;
let siteB;

before(async () => {
  tenantA = await createTenant('tenant-a');
  tenantB = await createTenant('tenant-b');
  siteB = await createSite(tenantB, 'B main lot');
  await createSite(tenantA, 'A main lot');
});

after(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Guards. These run first because every assertion below is meaningless if the
// connection under test can bypass row-level security. A superuser sees every
// tenant's rows whether the policies exist or not.
// ---------------------------------------------------------------------------

test('the connection under test cannot bypass RLS', async () => {
  const { rows } = await pool.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  assert.equal(rows.length, 1, 'current_user should resolve to a role');
  assert.equal(rows[0].rolsuper, false, 'tests must not connect as a SUPERUSER — it bypasses RLS');
  assert.equal(rows[0].rolbypassrls, false, 'tests must not connect as a BYPASSRLS role');
});

test('parking_sites has RLS enabled AND forced', async () => {
  const { rows } = await pool.query(
    'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1',
    ['parking_sites'],
  );
  assert.equal(rows[0].relrowsecurity, true, 'ENABLE ROW LEVEL SECURITY is missing');
  assert.equal(rows[0].relforcerowsecurity, true, 'FORCE ROW LEVEL SECURITY is missing');
});

// ---------------------------------------------------------------------------
// Isolation.
// ---------------------------------------------------------------------------

test('a tenant reads only its own rows', async () => {
  const rows = await withTenant(tenantA, async (client) => {
    // Deliberately unqualified: no WHERE tenant_id. This asks the database
    // alone to do the scoping, which is exactly what is under test.
    const { rows } = await client.query('SELECT id, tenant_id, name FROM parking_sites');
    return rows;
  });

  assert.equal(rows.length, 1, 'tenant A should see exactly its own one site');
  assert.equal(rows[0].tenant_id, tenantA);
  assert.ok(
    !rows.some((r) => r.tenant_id === tenantB),
    "tenant A must not see tenant B's rows",
  );
});

test("a tenant cannot read another tenant's row even by id", async () => {
  const rows = await withTenant(tenantA, async (client) => {
    const { rows } = await client.query('SELECT id FROM parking_sites WHERE id = $1', [siteB]);
    return rows;
  });
  assert.equal(rows.length, 0, "naming B's row id must not reveal it to A");
});

test("a tenant cannot update another tenant's row", async () => {
  const count = await withTenant(tenantA, async (client) => {
    const res = await client.query('UPDATE parking_sites SET name = $1 WHERE id = $2', [
      'hijacked',
      siteB,
    ]);
    return res.rowCount;
  });
  assert.equal(count, 0, "A's update must not reach B's row");

  const stillNamed = await withTenant(tenantB, async (client) => {
    const { rows } = await client.query('SELECT name FROM parking_sites WHERE id = $1', [siteB]);
    return rows[0].name;
  });
  assert.equal(stillNamed, 'B main lot', "B's row must be untouched");
});

test("a tenant cannot delete another tenant's row", async () => {
  const count = await withTenant(tenantA, async (client) => {
    const res = await client.query('DELETE FROM parking_sites WHERE id = $1', [siteB]);
    return res.rowCount;
  });
  assert.equal(count, 0, "A's delete must not reach B's row");
});

test('a tenant cannot write a row attributed to another tenant', async () => {
  // This is the WITH CHECK half. Without it, reads look correctly isolated
  // while writes are wide open -- the worst version of the bug, because the
  // reading side of the test suite stays green.
  await assert.rejects(
    () =>
      withTenant(tenantA, (client) =>
        client.query('INSERT INTO parking_sites (tenant_id, name) VALUES ($1, $2)', [
          tenantB,
          'planted by A',
        ]),
      ),
    /row-level security/i,
    'inserting under B while acting as A must be refused',
  );
});

test('no tenant context reads nothing', async () => {
  // current_tenant_id() is NULL when unset, and `tenant_id = NULL` is NULL,
  // not true. A connection that forgets the context sees nothing rather than
  // everything. Fail closed.
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT id FROM parking_sites');
    assert.equal(rows.length, 0, 'a context-less connection must see no rows');
  } finally {
    client.release();
  }
});
