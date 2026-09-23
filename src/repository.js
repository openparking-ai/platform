/**
 * Everything that touches the database, in one place.
 *
 * Every function here takes a client already inside withTenant(), so the tenant
 * context is set and the queries still carry their own `WHERE tenant_id = $1`.
 * Two independent controls, as docs/RLS_TEMPLATE.md requires.
 */

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
  { garageId, vehicleId, laneId, entryAt, currency, openEventId, entryConfirmation, entryDescriptor = null },
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
                             open_event_id, entry_confirmation, entry_descriptor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [tenantId, garageId, vehicleId, laneId, entryAt, currency, openEventId, entryConfirmation,
       entryDescriptor],
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

/**
 * Close a stay, freezing its outcome, what priced it -- or what could not --
 * and what the entitlement modules said, onto the row.
 *
 * `pricing` is one of three shapes, and the constraint
 * `sessions_closed_is_covered_priced_or_refused` (0015) holds the row to them:
 *
 *   { outcome: 'covered' }
 *       a pass or a monthly agreement covers the stay: no fee, no plan
 *       pricing, no refusal. Who said so is in `entitlement`.
 *   { outcome: 'transient', feeMinor, planVersion, breakdown, spaceClass }
 *       the engine's quote, verbatim, together or not at all.
 *   { outcome: 'transient', refusal }
 *       the engine's findings and NO fee: closed, unpriced, on the record.
 *
 * `entitlement` is what both modules answered (or that they were not
 * linked), on every shape. Nothing writes the hourly-rate shape any more.
 */
export async function closeSession(
  client,
  tenantId,
  sessionId,
  {
    exitAt, laneId, closeEventId, exitConfirmation, exitDescriptor = null, pricing, entitlement,
    // WHO DECIDED (0017): 'platform' when this close priced or consulted for
    // itself, 'lane' when it consumed the lane's decision -- and then the
    // inputs the lane said it decided from, stored beside the fee so the
    // number can be re-derived out of band (`reconcile.laneDecidedCloses`).
    decidedBy = 'platform', decisionInputs = null,
    // THE VALIDATION RECORD (0019): null when the close carried no phone.
    // It never holds the phone number.
    validation = null,
  },
) {
  const priced = pricing.outcome !== 'covered' && pricing.refusal === undefined;
  const { rows } = await client.query(
    `UPDATE sessions
        SET exit_at = $3, exit_lane_id = $4, close_event_id = $5,
            exit_confirmation = $6, exit_descriptor = $7,
            fee_minor = $8, plan_version = $9, breakdown = $10, space_class = $11,
            pricing_refusal = $12, exit_outcome = $13, entitlement = $14,
            decided_by = $15, decision_inputs = $16, validation = $17
      WHERE tenant_id = $1 AND id = $2 AND exit_at IS NULL
      RETURNING *`,
    [tenantId, sessionId, exitAt, laneId, closeEventId, exitConfirmation, exitDescriptor,
     priced ? pricing.feeMinor : null,
     priced ? pricing.planVersion : null,
     priced && pricing.breakdown !== null && pricing.breakdown !== undefined ? JSON.stringify(pricing.breakdown) : null,
     priced ? pricing.spaceClass : null,
     pricing.refusal === undefined ? null : JSON.stringify(pricing.refusal),
     pricing.outcome,
     entitlement === null || entitlement === undefined ? null : JSON.stringify(entitlement),
     decidedBy,
     decisionInputs === null || decisionInputs === undefined ? null : JSON.stringify(decisionInputs),
     validation === null || validation === undefined ? null : JSON.stringify(validation)],
  );
  return rows[0] ?? null;
}

/**
 * Every stay this garage closed on the lane's decision since `since`, with
 * what the lane decided from -- the reconciler's denominator. The plans are
 * not joined here: the reconciler reads them once, whole, as the close hands
 * them to the engine.
 */
export async function laneDecidedSessions(client, tenantId, garageId, since) {
  const { rows } = await client.query(
    `SELECT id, entry_at, exit_at, currency, fee_minor, plan_version, space_class,
            exit_outcome, decision_inputs, entitlement, breakdown
       FROM sessions
      WHERE tenant_id = $1 AND garage_id = $2 AND decided_by = 'lane' AND exit_at >= $3
      ORDER BY exit_at`,
    [tenantId, garageId, since],
  );
  return rows;
}

/**
 * The lane-decided closes NOTHING HAS CHECKED YET, oldest first, across every
 * garage of the tenant -- the unprompted sweep's queue (0018).
 *
 * NO WINDOW. The reconciliation route bounds what it reports by `hours`
 * because an operator asked a question about a period; the sweep is not
 * answering a question, it is making sure every device-written fee is
 * re-derived once, and a fee nobody asked about inside a day is exactly the
 * one that needs it. `decision_checked_at IS NULL` is the queue and the index
 * `sessions_lane_unchecked_idx` is its shape. `id` breaks the tie on `exit_at`:
 * two closes at the same instant are a tie the database may order either way,
 * and a queue whose order under a LIMIT is arbitrary is one nothing can assert
 * about -- including a test, which is how this was found.
 */
export async function uncheckedLaneDecisions(client, tenantId, limit) {
  const { rows } = await client.query(
    `SELECT id, garage_id, exit_lane_id, entry_at, exit_at, currency, fee_minor, plan_version,
            space_class, exit_outcome, decision_inputs, entitlement, close_event_id, breakdown
       FROM sessions
      WHERE tenant_id = $1 AND decided_by = 'lane' AND decision_checked_at IS NULL
      ORDER BY exit_at, id
      LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

/** How many lane-decided closes nothing has checked yet. The sweep's backlog. */
export async function uncheckedLaneDecisionCount(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM sessions
      WHERE tenant_id = $1 AND garage_id = $2 AND decided_by = 'lane'
        AND decision_checked_at IS NULL`,
    [tenantId, garageId],
  );
  return rows[0].n;
}

/**
 * Write what the check found, and NOTHING ELSE.
 *
 * The two columns 0018 added, by name, and no other: the sweep may not touch
 * `fee_minor`, `plan_version`, `exit_outcome` or `decision_inputs`, and this
 * is the only statement it has for saying anything at all. A reconciler that
 * corrects a money record unattended loses the evidence of the thing it was
 * built to detect.
 */
export async function recordDecisionCheck(client, tenantId, sessionId, { at, check }) {
  const { rowCount } = await client.query(
    `UPDATE sessions SET decision_checked_at = $3, decision_check = $4
      WHERE tenant_id = $1 AND id = $2 AND decided_by = 'lane'`,
    [tenantId, sessionId, at, check],
  );
  return rowCount;
}

export async function getSession(client, tenantId, sessionId) {
  const { rows } = await client.query('SELECT * FROM sessions WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    sessionId,
  ]);
  return rows[0] ?? null;
}

/** The garage's cursor: the highest `change_seq` any of its sessions carries, open or closed. */
export async function stayCursor(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT coalesce(max(change_seq), 0)::text AS cursor FROM sessions
      WHERE tenant_id = $1 AND garage_id = $2`,
    [tenantId, garageId],
  );
  return rows[0].cursor;
}

/**
 * One stay as the lane's feed carries it: the identity as the row holds it
 * (a plate, or the ticket a plate-less stay was opened on), the entry, the
 * entry lane, and the cursor value of the row. `open` says whether it is
 * still inside; a delta carries closed rows so a reader can drop them.
 */
// Spelled in its own order on purpose: the operator listing's column list
// below is a fail-control anchor, and a second copy of it would catch the
// plant meant for the listing.
const STAY_COLUMNS = `s.id, s.entry_at, s.exit_at, s.change_seq::text AS change_seq,
            l.name AS entry_lane, v.plate, v.ticket_ref, v.plate_region`;
const stayRow = (r) => ({
  session_id: r.id,
  open: r.exit_at === null,
  plate: r.plate,
  plate_region: r.plate_region,
  ticket_ref: r.ticket_ref,
  entry_at: r.entry_at,
  entry_lane: r.entry_lane,
  change_seq: r.change_seq,
});

/** Every open stay of the garage, in cursor order: the full set a reader starts from. */
export async function openStaysForLane(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT ${STAY_COLUMNS}
       FROM sessions s
       JOIN vehicles v ON v.id = s.vehicle_id
       JOIN lanes    l ON l.id = s.entry_lane_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL
      ORDER BY s.change_seq`,
    [tenantId, garageId],
  );
  return rows.map(stayRow);
}

/**
 * Every stay whose `change_seq` is past `since`, open or closed, in cursor
 * order, at most `limit` of them. A page that fills says `more`, and its
 * cursor is the last row's, so the next call continues where it stopped.
 */
export async function stayChangesSince(client, tenantId, garageId, since, limit) {
  const { rows } = await client.query(
    `SELECT ${STAY_COLUMNS}
       FROM sessions s
       JOIN vehicles v ON v.id = s.vehicle_id
       JOIN lanes    l ON l.id = s.entry_lane_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.change_seq > $3
      ORDER BY s.change_seq
      LIMIT $4`,
    [tenantId, garageId, since, limit + 1],
  );
  const more = rows.length > limit;
  return { changes: rows.slice(0, limit).map(stayRow), more };
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
