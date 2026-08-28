/**
 * Reconciliation: counts that should agree, reported when they do not.
 *
 * The presence gate reduces bad reads and never proves zero, so these counts
 * exist to make a gate that is being worked -- or one that has quietly started
 * refusing real cars -- visible in the record rather than only in a lane log.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { buildWorld, createTenant, pool, withTenant } from './helpers.js';

let tenant, world, operatorToken, server, base;

async function issueOperatorToken(tenantId) {
  const token = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [
      tenantId,
      hashToken(token),
    ]),
  );
  return token;
}

const asOperator = (token) => ({ headers: { authorization: `Bearer ${token}` } });

/** One lane event, written the way the lane's outbox writes it. */
async function recordEvent(kind, { occurredAt = new Date().toISOString() } = {}) {
  await withTenant(tenant, (c) =>
    c.query(
      `INSERT INTO events (tenant_id, garage_id, lane_id, event_id, kind, occurred_at, detail)
       VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb)`,
      [tenant, world.garage, world.entryLane, randomUUID(), kind, occurredAt],
    ),
  );
}

/**
 * A session on its own vehicle.
 *
 * One vehicle per session deliberately: `sessions_one_open_per_vehicle` is a
 * partial unique index that stops the same car being inside twice, which is
 * correct and is exactly what these tests would otherwise trip over.
 */
async function openSession({ entryAt = new Date().toISOString(), close = false } = {}) {
  return withTenant(tenant, async (c) => {
    const vehicle = (
      await c.query('INSERT INTO vehicles (tenant_id, plate) VALUES ($1,$2) RETURNING id', [
        tenant,
        `PLATE-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    const { rows } = await c.query(
      `INSERT INTO sessions
         (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, open_event_id, currency,
          entry_confirmation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed') RETURNING id`,
      [tenant, world.garage, vehicle, world.entryLane, entryAt, randomUUID(), world.currency],
    );
    if (close) {
      await c.query(
        `UPDATE sessions SET exit_at = now(), exit_lane_id = $2, close_event_id = $3,
                             fee_minor = 0, hourly_minor_applied = 0, rate_id = $4,
                             exit_confirmation = 'confirmed'
         WHERE id = $1`,
        [rows[0].id, world.exitLane, randomUUID(), world.rate],
      );
    }
    return rows[0].id;
  });
}

const report = async (query = '') =>
  (await fetch(`${base}/api/v1/garages/${world.garage}/reconciliation${query}`,
    asOperator(operatorToken))).json();

before(async () => {
  tenant = await createTenant('reconcile');
  world = await buildWorld(tenant);
  operatorToken = await issueOperatorToken(tenant);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await pool.end();
});

test('arrivals that opened no session are counted, and named', async () => {
  await recordEvent('frames_captured');
  await recordEvent('frames_captured');
  await recordEvent('frames_captured');
  await recordEvent('arming_rejected');
  await recordEvent('fallback_needs_human');
  await openSession();

  const body = await report();
  const counts = body.arrivals_versus_sessions;

  assert.equal(counts.arrivals, 3);
  assert.equal(counts.sessions_opened, 1);
  assert.equal(counts.arming_rejected, 1);
  assert.equal(counts.fallbacks, 1);
  // Divergence is normal, not an alarm -- but it has to be VISIBLE, and the
  // four numbers have to be separate. A lane being worked and a gate refusing
  // real cars produce the same single ratio and opposite session counts.
  assert.equal(counts.unaccounted, 2);
});

test('a session open past a plausible maximum stay is reported', async () => {
  const stale = await openSession({
    entryAt: new Date(Date.now() - 100 * 3600 * 1000).toISOString(),
  });

  const body = await report('?max_stay_hours=48');
  const ids = body.sessions_open_too_long.sessions.map((s) => s.session_id);

  assert.ok(ids.includes(stale), 'a session open for 100 hours was not reported');
  const found = body.sessions_open_too_long.sessions.find((s) => s.session_id === stale);
  assert.ok(found.open_hours >= 99, `open_hours was ${found.open_hours}`);
});

test('a session inside the maximum stay is NOT reported', async () => {
  // The control. A check that reports every open session would be safe and
  // useless -- most open sessions are cars currently parked.
  const fresh = await openSession();
  const body = await report('?max_stay_hours=48');
  const ids = body.sessions_open_too_long.sessions.map((s) => s.session_id);
  assert.ok(!ids.includes(fresh));
});

test('a closed session is never reported however old it is', async () => {
  const old = await openSession({
    entryAt: new Date(Date.now() - 500 * 3600 * 1000).toISOString(),
    close: true,
  });
  const body = await report('?max_stay_hours=48');
  const ids = body.sessions_open_too_long.sessions.map((s) => s.session_id);
  assert.ok(!ids.includes(old));
});

test('the report never carries a plate', async () => {
  // An operator needs to know WHICH sessions and for how long, and can look one
  // up deliberately. A reconciliation report is not a place to spray identities.
  const body = await report();
  assert.ok(!JSON.stringify(body).includes('PLATE-'), 'a plate reached the report');
});

test('the check that cannot be built yet says so in the response', async () => {
  // Silently omitting it would let a consumer assume three checks ran. The gap
  // belongs in the output, not only in a receipt.
  const body = await report();
  assert.equal(body.vehicles_counted_out.available, false);
  assert.match(body.vehicles_counted_out.reason, /counting module/);
});

test('the window is clamped rather than trusted', async () => {
  // ?hours=1000000 is a full table scan anyone outside can ask for.
  const body = await report('?hours=99999999');
  const since = new Date(body.arrivals_versus_sessions.since);
  const days = (Date.now() - since.getTime()) / (24 * 3600 * 1000);
  assert.ok(days <= 91, `window was ${days} days`);
});

test('reconciliation needs an operator token', async () => {
  const res = await fetch(`${base}/api/v1/garages/${world.garage}/reconciliation`);
  assert.equal(res.status, 401);
});

test('one tenant cannot reconcile another tenant\'s garage', async () => {
  const other = await createTenant('reconcile-other');
  const otherToken = await issueOperatorToken(other);
  const body = await (
    await fetch(`${base}/api/v1/garages/${world.garage}/reconciliation`, asOperator(otherToken))
  ).json();

  // RLS, not a 404 check: the other tenant simply sees nothing in this garage.
  assert.equal(body.arrivals_versus_sessions.arrivals, 0);
  assert.equal(body.arrivals_versus_sessions.sessions_opened, 0);
  assert.equal(body.sessions_open_too_long.sessions.length, 0);
});
