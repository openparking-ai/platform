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
  const { table, insert, appendOnly, noDelete, singleton } = spec;

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

    if (noDelete) {
      // Updatable but never deletable: the app role has no DELETE grant, so
      // there is no policy to measure -- the grant itself is the property.
      test(`${table}: the application role cannot delete at all`, async () => {
        const idB = (await withTenant(B, (c) => insert(c, B, worldB))).rows[0].id;
        await assert.rejects(
          withTenant(B, (c) => c.query(`DELETE FROM ${table} WHERE ${key} = $1`, [idB])),
          /permission denied/i,
          `${table} let the application role delete a row`,
        );
      });
    } else {
      test(`${table}: a tenant cannot delete another tenant's row`, async () => {
        const idB = (await withTenant(B, (c) => insert(c, B, worldB))).rows[0].id;
        const count = await withTenant(A, async (c) => {
          const res = await c.query(`DELETE FROM ${table} WHERE ${key} = $1`, [idB]);
          return res.rowCount;
        });
        assert.equal(count, 0, `${table} let tenant A delete tenant B's row`);
      });
    }
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

// ---------------------------------------------------------------------------
// The owner's reads (U2a): tenant A's SESSION and A's KEY against tenant B's
// garage, on every new read -- 404 or empty, never B's row. Over HTTP as the
// app role, so row-level security and the routes' own predicate both stand.
// Then the PREDICATE ALONE: the same repository reads through a connection
// that bypasses row-level security, so removing a read's tenant predicate has
// nothing else to hide behind and goes red here.
// ---------------------------------------------------------------------------

test('owner reads: a tenant\'s session and its key never see B\'s garages, garage or lanes', async () => {
  const { createApp } = await import('../src/app.js');
  const { generateDeviceToken, hashToken } = await import('../src/auth.js');
  const { createAdmin } = await import('../src/adminAccount.js');
  const origin = 'https://admin.example.test';
  const saved = process.env.ADMIN_ORIGIN;
  process.env.ADMIN_ORIGIN = origin;
  const server = createApp().listen(0, '127.0.0.1');
  if (saved === undefined) delete process.env.ADMIN_ORIGIN;
  else process.env.ADMIN_ORIGIN = saved;
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // A tenant of its own: A's admin row is the registry's, planted above.
    const C = await createTenant('iso-reads');
    const worldC = await buildWorld(C);
    const key = generateDeviceToken();
    await withTenant(C, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'iso',$2)`, [C, hashToken(key)]));
    const email = `iso-reads-${C.slice(0, 8)}@example.com`;
    const password = 'correct horse battery staple';
    await createAdmin({ tenantId: C, email, password });
    const signedIn = await fetch(`${base}/api/v1/auth/sign-in`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email, password }),
    });
    const cookie = signedIn.headers.getSetCookie()[0]?.split(';')[0];
    assert.equal(signedIn.status, 200, 'the premise: the owner signed in');
    for (const auth of [{ cookie }, { authorization: `Bearer ${key}` }]) {
      const as = (path) => fetch(`${base}/api/v1${path}`, { headers: auth }).then(async (r) => ({ status: r.status, text: await r.text() }));
      const list = await as('/garages');
      assert.equal(list.status, 200);
      const ids = JSON.parse(list.text).garages.map((g) => g.id);
      assert.ok(ids.includes(worldC.garage), 'the owner sees its own');
      assert.equal(ids.includes(worldB.garage), false, 'and never B\'s');
      for (const path of [`/garages/${worldB.garage}`, `/garages/${worldB.garage}/lanes`]) {
        const r = await as(path);
        assert.equal(r.status, 404, path);
        assert.equal(r.text.includes(worldB.entryLane) || r.text.includes(worldB.exitLane), false, path);
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('owner reads, the PREDICATE ALONE: with row-level security bypassed, A\'s reads still return none of B\'s rows', async () => {
  const repo = await import('../src/repository.js');
  const pg = (await import('pg')).default;
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();
  try {
    const role = (await owner.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    assert.ok(role.rolsuper || role.rolbypassrls, 'the premise: this connection bypasses RLS, so only the predicate is under test');
    // Plant B's rows where a read without its predicate would find them: a device and a reader on B's lane.
    await owner.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,'b-pi', md5(gen_random_uuid()::text))`, [B, worldB.entryLane]);
    const garages = await repo.garagesForTenant(owner, A);
    assert.ok(garages.length > 0);
    assert.equal(garages.some((g) => g.id === worldB.garage), false, 'garagesForTenant returned B\'s garage');
    assert.equal(await repo.getGarage(owner, A, worldB.garage), null, 'getGarage returned B\'s garage');
    assert.deepEqual(await repo.lanesForGarage(owner, A, worldB.garage), [], 'lanesForGarage returned B\'s lanes');
    // Mixed: A's tenant with B's lane rows in the same garage-shaped query must not cross either.
    const own = await repo.lanesForGarage(owner, A, worldA.garage);
    assert.ok(own.length >= 2);
    assert.equal(own.some((l) => l.devices.some((d) => d.name === 'b-pi')), false);
  } finally {
    await owner.end();
  }
});
