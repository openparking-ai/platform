/**
 * The one deliberate deviation from the RLS template, and the reason for it.
 *
 * lane_devices is ENABLE but not FORCE, so that resolve_lane_device() — which
 * is SECURITY DEFINER and therefore runs as the table's owner — can resolve a
 * token to a tenant before any tenant context exists. That is a real widening,
 * so it is fenced in by tests rather than by a comment.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { hashToken, generateDeviceToken } from '../src/auth.js';

let A;
let B;
let worldA;
let tokenA;

before(async () => {
  A = await createTenant('dev-a');
  B = await createTenant('dev-b');
  worldA = await buildWorld(A);
  await buildWorld(B);
  tokenA = generateDeviceToken();
  await withTenant(A, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,'A entry',$3)`, [
      A,
      worldA.entryLane,
      hashToken(tokenA),
    ]),
  );
});

after(async () => {
  await pool.end();
});

test('the app role still cannot read lane_devices without a tenant context', async () => {
  // This is the measurement that made the exception necessary in the first
  // place, kept as a test so the reason stays visible.
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT tenant_id FROM lane_devices WHERE token_hash = $1', [
      hashToken(tokenA),
    ]);
    assert.equal(rows.length, 0, 'not forcing RLS must not mean the app role can read the table freely');
  } finally {
    client.release();
  }
});

test("the app role cannot read another tenant's devices with a context", async () => {
  const rows = await withTenant(B, async (c) => {
    const { rows } = await c.query('SELECT id FROM lane_devices');
    return rows;
  });
  assert.equal(rows.length, 0, "tenant B must not see tenant A's devices");
});

test('resolve_lane_device resolves a valid token to its tenant', async () => {
  const { rows } = await pool.query('SELECT * FROM resolve_lane_device($1)', [hashToken(tokenA)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, A);
  assert.equal(rows[0].lane_id, worldA.entryLane);
  assert.equal(rows[0].direction, 'entry');
});

test('resolve_lane_device returns nothing for an unknown token', async () => {
  const { rows } = await pool.query('SELECT * FROM resolve_lane_device($1)', [hashToken('not-a-token')]);
  assert.equal(rows.length, 0);
});

test('a revoked device stops resolving', async () => {
  const revoked = generateDeviceToken();
  await withTenant(A, (c) =>
    c.query(
      `INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash, revoked_at)
       VALUES ($1,$2,'revoked',$3, now())`,
      [A, worldA.entryLane, hashToken(revoked)],
    ),
  );
  const { rows } = await pool.query('SELECT * FROM resolve_lane_device($1)', [hashToken(revoked)]);
  assert.equal(rows.length, 0, 'a revoked credential must not authenticate');
});

test('the raw token is never stored', async () => {
  const rows = await withTenant(A, async (c) => (await c.query('SELECT token_hash FROM lane_devices')).rows);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.notEqual(row.token_hash, tokenA, 'the token itself must never be in the database');
    assert.match(row.token_hash, /^[0-9a-f]{64}$/, 'stored value should be a sha-256 hex digest');
  }
});
