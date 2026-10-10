/**
 * The database is owned by an ORDINARY role, and everything still works (0031).
 *
 * Until 0031, three SECURITY DEFINER functions read a FORCED table with no
 * tenant context: resolve_lane_device (lanes), list_tenant_ids_for_maintenance
 * (tenants) and record_refused_change (garages, lanes). FORCE binds the owner,
 * so for an owner that is NOSUPERUSER and NOBYPASSRLS each found nothing, and
 * every lane token was refused. CI migrated as `postgres`, a superuser, who
 * bypasses every policy, so the suite could not see it. Now CI migrates the
 * way production does -- `npm run prepare-database` as the superuser, then
 * every other migration as an ordinary owner -- and this file holds that:
 *
 *   - the owner is ordinary, and owns everything in the schema;
 *   - every definer is accounted for: it opens the cross-account lookup, or it
 *     reads no forced table -- and a planted one is found by the same walk;
 *   - a lane computer signs in, the maintenance list lists, a refused attempt
 *     on another account's lane reaches that account's log;
 *   - and nothing is widened: the application role reads what it read before
 *     whatever it sets, the owner's own connection is still bound by FORCE,
 *     and the setting is put back after each call.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';

// Every SECURITY DEFINER function there is, by what it needs from the owner.
// A new one is refused by the walk below until it is put in one of these.
const OPENS_THE_LOOKUP = [
  'list_tenant_ids_for_maintenance', 'record_refused_change', 'resolve_lane_device',
  // 0032: a link is presented, and its tenant is what is being found out.
  'resolve_operator_invite', 'resolve_operator_invite_for_email', 'resolve_operator_password_reset',
];
// The FORCED tables a definer reads across accounts, each with 0031's policy.
const LOOKUP_TABLES = ['tenants', 'garages', 'lanes', 'operator_invites', 'operator_password_resets'];
const READS_NO_FORCED_TABLE = [
  'resolve_operator_session', // operator_tokens, operator_users
  'resolve_operator_token', // operator_tokens
  'resolve_operator_user', // operator_users
  'touch_lane_device', // lane_devices
  'touch_operator_token', // operator_tokens
];

let owner;
let server;
let base;
let A;
let B;
let worldA;
let worldB;
let token;

before(async () => {
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();
  A = await createTenant('owner-a');
  B = await createTenant('owner-b');
  worldA = await buildWorld(A);
  worldB = await buildWorld(B);
  token = generateDeviceToken();
  await withTenant(A, (c) =>
    c.query(`INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,'A entry',$3)`, [
      A,
      worldA.entryLane,
      hashToken(token),
    ]),
  );
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Guarded: a `before` that threw leaves these unset.
  if (server) await new Promise((r) => server.close(r));
  await owner?.end();
  await pool.end();
});

const definerNames = async (c) =>
  (await c.query(`
    SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef ORDER BY p.proname`)).rows.map((r) => r.name);

test('the owner that migrated this database is NOSUPERUSER and NOBYPASSRLS', async () => {
  const { rows } = await owner.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false });
});

test('the owner owns every table and function in the schema, 0001 included', async () => {
  const { rows } = await owner.query(`
    SELECT c.relname AS name FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
    UNION ALL
    SELECT p.oid::regprocedure::text FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)`);
  assert.deepEqual(rows, [], 'owned by someone other than the owner');
});

test('the application role is not a member of the owner', async () => {
  const { rows } = await owner.query("SELECT pg_has_role('openparking_app', current_user, 'MEMBER') AS is");
  assert.equal(rows[0].is, false);
});

test('every SECURITY DEFINER function is accounted for, and a planted one is found', async () => {
  const known = [...OPENS_THE_LOOKUP, ...READS_NO_FORCED_TABLE].sort();
  assert.deepEqual(await definerNames(owner), known);

  // The control, in the same run: the walk finds a definer nobody listed.
  await owner.query('BEGIN');
  try {
    await owner.query(`CREATE FUNCTION planted_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
    const found = await definerNames(owner);
    assert.deepEqual(found.filter((n) => !known.includes(n)), ['planted_definer']);
  } finally {
    await owner.query('ROLLBACK');
  }
});

test('the ones that open the lookup are the only ones that do', async () => {
  const { rows } = await owner.query(`
    SELECT p.proname AS name FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
       AND p.prosrc LIKE '%openparking.definer_lookup%'
     ORDER BY p.proname`);
  assert.deepEqual(rows.map((r) => r.name), OPENS_THE_LOOKUP);
});

test('a lane computer signs in; a made-up token does not', async () => {
  const ok = await fetch(`${base}/api/v1/lane/stays`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200, 'the lane token of a garage is accepted');
  const made = await fetch(`${base}/api/v1/lane/stays`, { headers: { authorization: `Bearer ${generateDeviceToken()}` } });
  assert.equal(made.status, 401);
});

test('resolve_lane_device finds the lane, its garage and its direction', async () => {
  const { rows } = await pool.query('SELECT * FROM resolve_lane_device($1)', [hashToken(token)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, A);
  assert.equal(rows[0].lane_id, worldA.entryLane);
  assert.equal(rows[0].garage_id, worldA.garage);
  assert.equal(rows[0].direction, 'entry');
});

test('list_tenant_ids_for_maintenance lists every account', async () => {
  const ids = (await pool.query('SELECT tenant_id FROM list_tenant_ids_for_maintenance()')).rows.map((r) => r.tenant_id);
  assert.ok(ids.includes(A) && ids.includes(B), 'both accounts of this file are listed');
});

test("a refused attempt on another account's lane reaches that account's log", async () => {
  const keyId = randomUUID();
  await withTenant(A, (c) =>
    c.query(`INSERT INTO operator_tokens (id, tenant_id, name, token_hash) VALUES ($1,$2,'ops',$3)`, [
      keyId,
      A,
      hashToken(generateDeviceToken()),
    ]),
  );
  const { rows } = await pool.query(
    'SELECT record_refused_change($1, NULL, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11) AS went',
    [A, 'key', 'key', keyId, 'lane', worldB.entryLane, 'lane.close', 'not_found', 'POST /lanes/x/close', 'f'.repeat(32), 1800],
  );
  assert.equal(rows[0].went, 'both', "the line goes to the lane's account and to the caller's");
  const inB = await withTenant(B, (c) =>
    c.query(`SELECT actor_kind, subject_kind, subject_id FROM garage_changes WHERE outcome = 'refused' AND subject_id = $1`, [
      worldB.entryLane,
    ]),
  );
  assert.deepEqual(inB.rows, [{ actor_kind: 'outside', subject_kind: 'lane', subject_id: worldB.entryLane }]);
});

test('the application role reads nothing more, whatever it sets', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('openparking.definer_lookup', 'on', true)");
    for (const table of LOOKUP_TABLES) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(rows[0].n, 0, `${table}: nothing with no account`);
    }
    await client.query("SELECT set_config('openparking.tenant_id', $1, true)", [A]);
    const { rows } = await client.query('SELECT DISTINCT tenant_id FROM lanes');
    assert.deepEqual(rows.map((r) => r.tenant_id), [A], 'its own account only');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('the bodies are the owner\'s alone: the application role cannot call one', async () => {
  for (const call of [
    "SELECT * FROM resolve_lane_device_body('x')",
    'SELECT * FROM list_tenant_ids_for_maintenance_body()',
  ]) {
    await assert.rejects(() => pool.query(call), /permission denied for function/);
  }
});

test("the owner's own connection is still bound by FORCE", async () => {
  for (const table of LOOKUP_TABLES) {
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(rows[0].n, 0, `${table}: the owner sees nothing outside the functions that open the lookup`);
  }
});

test('the setting is put back as it was after each call', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('openparking.definer_lookup', 'as-it-was', true)");
    await client.query('SELECT * FROM resolve_lane_device($1)', [hashToken(token)]);
    await client.query('SELECT * FROM list_tenant_ids_for_maintenance()');
    for (const fn of ['resolve_operator_invite', 'resolve_operator_invite_for_email', 'resolve_operator_password_reset']) {
      await client.query(`SELECT * FROM ${fn}($1)`, ['0'.repeat(64)]);
    }
    const { rows } = await client.query("SELECT current_setting('openparking.definer_lookup') AS v");
    assert.equal(rows[0].v, 'as-it-was');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
