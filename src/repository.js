/**
 * Everything that touches the database, in one place.
 *
 * Every function here takes a client already inside withTenant(), so the tenant
 * context is set and the queries still carry their own `WHERE tenant_id = $1`.
 * Two independent controls, as docs/RLS_TEMPLATE.md requires.
 */
import { toMinor } from './money.js';

export async function upsertVehicle(client, tenantId, { plate, plateRegion = null, seenAt }) {
  const { rows } = await client.query(
    `INSERT INTO vehicles (tenant_id, plate, plate_region, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (tenant_id, plate) DO UPDATE
       SET last_seen_at = GREATEST(vehicles.last_seen_at, EXCLUDED.last_seen_at),
           plate_region = COALESCE(EXCLUDED.plate_region, vehicles.plate_region)
     RETURNING id, plate, plate_region`,
    [tenantId, plate, plateRegion, seenAt],
  );
  return rows[0];
}

/** Idempotency lookups. The key is the lane's event id, never the session's state. */
export async function findSessionByOpenEvent(client, tenantId, openEventId) {
  const { rows } = await client.query(
    'SELECT * FROM sessions WHERE tenant_id = $1 AND open_event_id = $2',
    [tenantId, openEventId],
  );
  return rows[0] ?? null;
}

export async function findSessionByCloseEvent(client, tenantId, closeEventId) {
  const { rows } = await client.query(
    'SELECT * FROM sessions WHERE tenant_id = $1 AND close_event_id = $2',
    [tenantId, closeEventId],
  );
  return rows[0] ?? null;
}

export async function findOpenSession(client, tenantId, garageId, vehicleId) {
  const { rows } = await client.query(
    `SELECT * FROM sessions
      WHERE tenant_id = $1 AND garage_id = $2 AND vehicle_id = $3 AND exit_at IS NULL`,
    [tenantId, garageId, vehicleId],
  );
  return rows[0] ?? null;
}

export async function openSession(
  client,
  tenantId,
  { garageId, vehicleId, laneId, entryAt, currency, openEventId },
) {
  // Keyed on the event, so a replay is recognised whether the session it
  // created is still open, already closed, or closed and long forgotten.
  const alreadyOpened = await findSessionByOpenEvent(client, tenantId, openEventId);
  if (alreadyOpened) return { session: alreadyOpened, created: false };

  const existing = await findOpenSession(client, tenantId, garageId, vehicleId);
  if (existing) return { session: existing, created: false };

  // The check above handles the ordinary replay. This savepoint handles the
  // race: two lanes, or a retry arriving while the first request is still in
  // flight. Without it, the unique violation aborts the whole transaction and
  // the recovery SELECT fails with 25P02 instead of returning the session --
  // a replayed entry then 500s and the lane retries it forever.
  await client.query('SAVEPOINT open_session');
  try {
    const { rows } = await client.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency, open_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [tenantId, garageId, vehicleId, laneId, entryAt, currency, openEventId],
    );
    await client.query('RELEASE SAVEPOINT open_session');
    return { session: rows[0], created: true };
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT open_session');
    // 23505: somebody else got there between our check and our insert -- either
    // the same event arriving twice concurrently, or the other lane opening for
    // this vehicle. Both are the indexes doing their job, not errors.
    if (err.code !== '23505') throw err;
    const raced =
      (await findSessionByOpenEvent(client, tenantId, openEventId)) ??
      (await findOpenSession(client, tenantId, garageId, vehicleId));
    if (!raced) throw err;
    return { session: raced, created: false };
  }
}

export async function closeSession(
  client,
  tenantId,
  sessionId,
  { exitAt, laneId, rateId, hourlyMinor, feeMinor, closeEventId },
) {
  const { rows } = await client.query(
    `UPDATE sessions
        SET exit_at = $3, exit_lane_id = $4, rate_id = $5,
            hourly_minor_applied = $6, fee_minor = $7, close_event_id = $8
      WHERE tenant_id = $1 AND id = $2 AND exit_at IS NULL
      RETURNING *`,
    [tenantId, sessionId, exitAt, laneId, rateId, hourlyMinor, feeMinor, closeEventId],
  );
  return rows[0] ?? null;
}

export async function getSession(client, tenantId, sessionId) {
  const { rows } = await client.query('SELECT * FROM sessions WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    sessionId,
  ]);
  return rows[0] ?? null;
}

export async function currentRate(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT id, name, hourly_minor FROM rates
      WHERE tenant_id = $1 AND garage_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, garageId],
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, name: rows[0].name, hourlyMinor: toMinor(rows[0].hourly_minor, 'hourly_minor') };
}

export async function getGarage(client, tenantId, garageId) {
  const { rows } = await client.query('SELECT * FROM garages WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    garageId,
  ]);
  return rows[0] ?? null;
}

/**
 * Append events, ignoring any this tenant has already recorded.
 *
 * ON CONFLICT DO NOTHING against the (tenant_id, event_id) unique constraint is
 * what makes a lane's reconnect-and-reflush safe: the queue re-sends whatever
 * it could not confirm, and the duplicates land nowhere.
 */
export async function appendEvents(client, tenantId, events) {
  if (events.length === 0) return { accepted: 0, duplicates: 0 };
  const values = [];
  const params = [];
  events.forEach((e, i) => {
    const b = i * 7;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`);
    params.push(tenantId, e.garageId, e.laneId, e.eventId, e.kind, e.occurredAt, e.detail ?? {});
  });
  const { rowCount } = await client.query(
    `INSERT INTO events (tenant_id, garage_id, lane_id, event_id, kind, occurred_at, detail)
     VALUES ${values.join(', ')}
     ON CONFLICT (tenant_id, event_id) DO NOTHING`,
    params,
  );
  return { accepted: rowCount, duplicates: events.length - rowCount };
}

export async function openSessionsForGarage(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT s.id, s.entry_at, s.currency, v.plate, v.plate_region, l.name AS entry_lane
       FROM sessions s
       JOIN vehicles v ON v.id = s.vehicle_id
       JOIN lanes    l ON l.id = s.entry_lane_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL
      ORDER BY s.entry_at`,
    [tenantId, garageId],
  );
  return rows;
}
