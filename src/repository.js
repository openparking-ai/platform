/**
 * Everything that touches the database, in one place.
 *
 * Every function here takes a client already inside withTenant(), so the tenant
 * context is set and the queries still carry their own `WHERE tenant_id = $1`.
 * Two independent controls, as docs/RLS_TEMPLATE.md requires.
 */
import { toMinor } from './money.js';

const VEHICLE_COLUMNS = 'id, plate, plate_region, ticket_ref, make, model, color';

/**
 * The vehicle this stay is against, by whichever identity the lane sent.
 *
 * TWO IDENTITIES, ONE ROW SHAPE, AND THE UPSERT KEY IS THE ONE THAT IS SET.
 * `ON CONFLICT` names an index, and the two identities have two indexes —
 * `(tenant_id, plate)` and `(tenant_id, ticket_ref)`. A single statement
 * cannot name both, and one that named only the plate would insert a fresh row
 * for every replay of a ticket stay: the ticket's own unique index would then
 * raise, and a replayed open — the normal case for a lane that was offline —
 * would 500 and be retried forever.
 *
 * So the KEY branches and nothing else does. `migrations/0007` makes exactly
 * one of the two non-null, `src/app.js` refuses a request that sends both or
 * neither, and this function is handed whichever one survived that.
 *
 * The vision attributes are on the plate branch only, and that is not an
 * omission. A plate arrives with a make, a model and a colour because a camera
 * looked at a vehicle; a ticket arrives because a person read a code out. There
 * is nothing measured to carry, and a column filled in from nowhere is the
 * shape this project already refuses everywhere else.
 */
export async function upsertVehicle(
  client,
  tenantId,
  {
    plate = null,
    ticketRef = null,
    plateRegion = null,
    seenAt,
    make = null,
    model = null,
    color = null,
    attributes = null,
  },
) {
  if (ticketRef) {
    const { rows } = await client.query(
      `INSERT INTO vehicles (tenant_id, ticket_ref, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (tenant_id, ticket_ref) DO UPDATE
         SET last_seen_at = GREATEST(vehicles.last_seen_at, EXCLUDED.last_seen_at)
       RETURNING ${VEHICLE_COLUMNS}`,
      [tenantId, ticketRef, seenAt],
    );
    return rows[0];
  }
  const { rows } = await client.query(
    `INSERT INTO vehicles (tenant_id, plate, plate_region, make, model, color, attributes,
                           first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb), $8, $8)
     ON CONFLICT (tenant_id, plate) DO UPDATE
       SET last_seen_at  = GREATEST(vehicles.last_seen_at, EXCLUDED.last_seen_at),
           plate_region  = COALESCE(EXCLUDED.plate_region, vehicles.plate_region),
           -- A later, better read fills in what an earlier one could not. It
           -- never blanks what is already known.
           make          = COALESCE(EXCLUDED.make,  vehicles.make),
           model         = COALESCE(EXCLUDED.model, vehicles.model),
           color         = COALESCE(EXCLUDED.color, vehicles.color),
           attributes    = vehicles.attributes || EXCLUDED.attributes
     RETURNING ${VEHICLE_COLUMNS}`,
    [tenantId, plate, plateRegion, make, model, color, attributes ? JSON.stringify(attributes) : null, seenAt],
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
  { garageId, vehicleId, laneId, entryAt, currency, openEventId, entryConfirmation },
) {
  // Keyed on the event, so a replay is recognised whether the session it
  // created is still open, already closed, or closed and long forgotten.
  const alreadyOpened = await findSessionByOpenEvent(client, tenantId, openEventId);
  if (alreadyOpened) {
    if (alreadyOpened.vehicle_id !== vehicleId) {
      // The same id presented for a DIFFERENT vehicle. Silently handing back
      // the first vehicle's session would leave this car with no session at
      // all: it would exit to a 404, the close would be dead-lettered, and it
      // would park free with nothing in the record to say so. A lane fault
      // that is loud is worth far more than a silent free park.
      const conflict = new Error('event_id already used for a different vehicle');
      conflict.code = 'EVENT_ID_VEHICLE_CONFLICT';
      throw conflict;
    }
    return { session: alreadyOpened, created: false };
  }

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
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency,
                             open_event_id, entry_confirmation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tenantId, garageId, vehicleId, laneId, entryAt, currency, openEventId, entryConfirmation],
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
  { exitAt, laneId, rateId, hourlyMinor, feeMinor, closeEventId, exitConfirmation },
) {
  const { rows } = await client.query(
    `UPDATE sessions
        SET exit_at = $3, exit_lane_id = $4, rate_id = $5,
            hourly_minor_applied = $6, fee_minor = $7, close_event_id = $8,
            exit_confirmation = $9
      WHERE tenant_id = $1 AND id = $2 AND exit_at IS NULL
      RETURNING *`,
    [tenantId, sessionId, exitAt, laneId, rateId, hourlyMinor, feeMinor, closeEventId,
     exitConfirmation],
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

export async function findOpenSessionById(client, tenantId, garageId, sessionId) {
  const { rows } = await client.query(
    `SELECT * FROM sessions
      WHERE tenant_id = $1 AND garage_id = $2 AND id = $3 AND exit_at IS NULL`,
    [tenantId, garageId, sessionId],
  );
  return rows[0] ?? null;
}

/**
 * The stay currently open for one identity, whichever kind it is.
 *
 * The column compared is chosen by which identity was supplied, and the value
 * is still bound — never interpolated. `v.plate = $3 OR v.ticket_ref = $3`
 * would look tidier and would be wrong: it would match a ticket whose text
 * happens to equal a plate across the two columns, which is two different
 * vehicles answering to one lookup at the moment a lane is deciding whose stay
 * to close.
 */
export async function findOpenSessionByIdentity(client, tenantId, garageId, { plate, ticketRef }) {
  const column = ticketRef ? 'ticket_ref' : 'plate';
  const { rows } = await client.query(
    `SELECT s.* FROM sessions s
       JOIN vehicles v ON v.id = s.vehicle_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND v.${column} = $3 AND s.exit_at IS NULL`,
    [tenantId, garageId, ticketRef ?? plate],
  );
  return rows[0] ?? null;
}

export async function retentionDays(client, tenantId) {
  const { rows } = await client.query(
    'SELECT vehicle_retention_days FROM tenant_settings WHERE tenant_id = $1',
    [tenantId],
  );
  // No row means the tenant has never changed it. 30 is the default, and it is
  // the default in one place only -- the column -- so this mirrors it rather
  // than inventing a second source of truth.
  return rows[0] ? Number(rows[0].vehicle_retention_days) : 30;
}

export async function openSessionsForGarage(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT s.id, s.entry_at, s.currency, s.entry_confirmation,
            v.plate, v.plate_region, v.ticket_ref, l.name AS entry_lane
       FROM sessions s
       JOIN vehicles v ON v.id = s.vehicle_id
       JOIN lanes    l ON l.id = s.entry_lane_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL
      ORDER BY s.entry_at`,
    [tenantId, garageId],
  );
  return rows;
}

/**
 * Every device on this garage's lanes, with when it was last heard from.
 *
 * The join is what scopes it to a garage: a device belongs to a LANE, and the
 * lane is what belongs to a garage. `WHERE d.tenant_id = $1` is carried anyway,
 * beside the tenant policy, exactly as every other function in this file does
 * -- two independent controls, per docs/RLS_TEMPLATE.md.
 *
 * `token_hash` is not selected. Listing devices is not an occasion to hand a
 * credential's hash to whoever is looking at the list.
 */
export async function devicesForGarage(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT d.id, d.lane_id, d.name, d.created_at, d.last_seen_at, d.revoked_at
       FROM lane_devices d
       JOIN lanes l ON l.id = d.lane_id
      WHERE d.tenant_id = $1 AND l.garage_id = $2
      ORDER BY d.created_at`,
    [tenantId, garageId],
  );
  return rows;
}
