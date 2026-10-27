import { HttpError } from './errors.js';
import { presentPayment } from './exitPayments.js';

/**
 * THE EXIT CASE (0037): one car at an exit lane, from the moment the lane
 * asks which stay it is to the moment the close names it.
 *
 * Which stay, and how it was decided (`method`):
 *   lane         the lane matched the stay from its own copy and named it;
 *   single       one open stay agreed with the car's ID (src/exitMatch.js);
 *   picker       a few agreed and the picker chose one by pictures
 *                (src/exitPicker.js);
 *   none         no stay was found, and the driver has not said yet;
 *   driver_word  no stay was found, and the driver's stated entry time was
 *                priced.
 *
 * SETTLED is the one thing the lane opens on: covered, a fee of zero, paid
 * (0038, src/exitPayments.js), or a person's decision. Anything else keeps
 * the barrier down and says what is missing.
 */

export const UNMATCHED_EVENT_KIND = 'exit_unmatched';
export const DRIVER_WORD_EVENT_KIND = 'exit_driver_word';
export const PERSON_EVENT_KIND = 'exit_let_out_by_person';

/** The longest stay a driver's stated entry may claim: the engine's own limit. */
export const WORD_MAX_DAYS = 90;

const bad = (message) => new HttpError(400, message);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The car's ID as a lane sends it, entry or exit: `plate_characters`
 * (vehicle-id's `{state, rule, pattern}`), `color_code`, `size`. Each is
 * optional; what is sent is checked to the shape the table stores, and
 * nothing beyond it (the characters' confidences and the reads stay on the
 * lane).
 */
export function idFields(body) {
  const pc = body?.plate_characters ?? null;
  let plate = null;
  if (pc !== null) {
    if (typeof pc !== 'object' || Array.isArray(pc)) throw bad('plate_characters must be an object: {state, rule, pattern}');
    const { state, rule = null, pattern = null } = pc;
    if (!['read', 'unreadable', 'not_seen'].includes(state)) {
      throw bad('plate_characters.state must be read, unreadable or not_seen');
    }
    if (rule !== null && (typeof rule !== 'string' || !/^[a-z0-9-]{1,40}\/[0-9]{1,4}$/.test(rule))) {
      throw bad('plate_characters.rule must name a rule and its version, such as opvid-plate-chars/1');
    }
    if (state === 'read') {
      if (rule === null) throw bad('plate_characters.rule is required for a read plate: IDs under different rules do not compare');
      if (typeof pattern !== 'string' || !/^[0-9A-Z?]{1,16}$/.test(pattern) || !/[0-9A-Z]/.test(pattern)) {
        throw bad("plate_characters.pattern must be the folded characters with '?' where a position is not sure, at least one sure");
      }
    } else if (pattern !== null) {
      throw bad(`an ${state} plate has no pattern`);
    }
    plate = { state, rule, pattern: state === 'read' ? pattern : null };
  }
  const colour = body?.color_code ?? null;
  if (colour !== null && (typeof colour !== 'string' || !/^opvid-colour\/[0-9]{1,4}:[mf]:[0-9a-f]{16}$/.test(colour))) {
    throw bad('color_code must be an opvid-colour code');
  }
  const size = body?.size ?? null;
  if (size !== null && (typeof size !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(size))) {
    throw bad('size must be a short code: lower-case letters, digits, - and _');
  }
  return { plate, colour_code: colour, size };
}

export function uuidField(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw bad(`${label} must be an id`);
  return value;
}

/** The garage's open stays that came in at or before `exitAt`, with what the matcher compares. */
export async function openStaysForMatch(client, tenantId, garageId, exitAt) {
  const { rows } = await client.query(
    `SELECT s.id, s.entry_at, s.open_event_id, s.entry_plate_state, s.entry_plate_rule, s.entry_plate_pattern,
            s.entry_colour_code, s.entry_size, v.plate,
            CASE WHEN v.ticket_ref IS NOT NULL THEN 'ticket' WHEN v.unread_ref IS NOT NULL THEN 'unread' ELSE 'plate' END AS identity_kind
       FROM sessions s
       JOIN vehicles v ON v.id = s.vehicle_id AND v.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL AND s.entry_at <= $3
      ORDER BY s.entry_at DESC, s.id`,
    [tenantId, garageId, exitAt],
  );
  return rows;
}

/** Up to `limit` pictures kept under one lane event id, oldest first. */
export async function picturesOf(client, tenantId, eventId, limit) {
  const { rows } = await client.query(
    `SELECT id, content_type, image FROM entry_pictures
      WHERE tenant_id = $1 AND event_id = $2
      ORDER BY taken_at, id LIMIT $3`,
    [tenantId, eventId, limit],
  );
  return rows;
}

export async function vehicleOf(client, tenantId, vehicleId) {
  const { rows } = await client.query(
    'SELECT id, plate, ticket_ref, unread_ref FROM vehicles WHERE tenant_id = $1 AND id = $2',
    [tenantId, vehicleId],
  );
  return rows[0] ?? null;
}

/** A case with its payment (0038) beside it, as `payment`, or null. */
const WITH_PAYMENT = `SELECT e.*, to_jsonb(p) AS payment
                        FROM exits e
                        LEFT JOIN exit_payments p ON p.tenant_id = e.tenant_id AND p.exit_id = e.id`;

/** A row written with RETURNING, given its payment as a read would. */
export async function withPayment(client, tenantId, row) {
  if (!row) return row;
  const { rows } = await client.query('SELECT to_jsonb(p) AS payment FROM exit_payments p WHERE tenant_id = $1 AND exit_id = $2', [tenantId, row.id]);
  return { ...row, payment: rows[0]?.payment ?? null };
}

export async function caseByEvent(client, tenantId, eventId) {
  const { rows } = await client.query(`${WITH_PAYMENT} WHERE e.tenant_id = $1 AND e.event_id = $2`, [tenantId, eventId]);
  return rows[0] ?? null;
}

export async function caseById(client, tenantId, garageId, exitId, { lock = false } = {}) {
  const { rows } = await client.query(
    `${WITH_PAYMENT} WHERE e.tenant_id = $1 AND e.garage_id = $2 AND e.id = $3${lock ? ' FOR UPDATE OF e' : ''}`,
    [tenantId, garageId, exitId],
  );
  return rows[0] ?? null;
}

/** A new case; a resend of the same lane event id returns the case already written. */
export async function insertCase(client, tenantId, c) {
  const { rows } = await client.query(
    `INSERT INTO exits (tenant_id, garage_id, lane_id, event_id, exit_at, plate_state, plate_rule, plate_pattern,
                        colour_code, size, method, session_id, candidates, picker, quote)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (tenant_id, event_id) DO NOTHING
     RETURNING *`,
    [
      tenantId, c.garageId, c.laneId, c.eventId, c.exitAt, c.id.plate?.state ?? null, c.id.plate?.rule ?? null,
      c.id.plate?.pattern ?? null, c.id.colour_code, c.id.size, c.method, c.sessionId ?? null,
      JSON.stringify(c.candidates ?? []), c.picker ? JSON.stringify(c.picker) : null, c.quote ? JSON.stringify(c.quote) : null,
    ],
  );
  return { row: rows[0] ?? (await caseByEvent(client, tenantId, c.eventId)), created: rows.length === 1 };
}

export async function recordWord(client, tenantId, exitId, { claimedEntryAt, quote }) {
  const { rows } = await client.query(
    `UPDATE exits SET method = 'driver_word', claimed_entry_at = $3, quote = $4
      WHERE tenant_id = $1 AND id = $2 AND method = 'none' AND closed_at IS NULL
      RETURNING *`,
    [tenantId, exitId, claimedEntryAt, JSON.stringify(quote)],
  );
  return withPayment(client, tenantId, rows[0] ?? null);
}

export async function recordPerson(client, tenantId, exitId, person) {
  const { rows } = await client.query(
    `UPDATE exits SET person = $3 WHERE tenant_id = $1 AND id = $2 AND closed_at IS NULL AND person IS NULL RETURNING *`,
    [tenantId, exitId, JSON.stringify(person)],
  );
  return withPayment(client, tenantId, rows[0] ?? null);
}

export async function markClosed(client, tenantId, exitId, { closeEventId, closedAt }) {
  const { rows } = await client.query(
    `UPDATE exits SET close_event_id = $3, closed_at = $4
      WHERE tenant_id = $1 AND id = $2 AND closed_at IS NULL RETURNING *`,
    [tenantId, exitId, closeEventId, closedAt],
  );
  return withPayment(client, tenantId, rows[0] ?? null);
}

export async function caseByCloseEvent(client, tenantId, closeEventId) {
  const { rows } = await client.query(`${WITH_PAYMENT} WHERE e.tenant_id = $1 AND e.close_event_id = $2`, [tenantId, closeEventId]);
  return rows[0] ?? null;
}

/** The cases still at a lane of this garage, newest first: what an attendant works from. */
export async function openCases(client, tenantId, garageId, limit = 100) {
  const { rows } = await client.query(
    `${WITH_PAYMENT} WHERE e.tenant_id = $1 AND e.garage_id = $2 AND e.closed_at IS NULL
      ORDER BY e.created_at DESC, e.id LIMIT $3`,
    [tenantId, garageId, limit],
  );
  return rows;
}

/**
 * Whether the barrier may open for this case, and if not, what is missing:
 * `driver_word` (no stay found, the driver has not said), `person` (the fee
 * could not be priced), `payment` (a fee above zero, not yet paid).
 */
export function settledOf(row) {
  if (row.person) return { settled: true, why: 'person' };
  if (row.payment?.status === 'succeeded') return { settled: true, why: 'paid' };
  const q = row.quote;
  if (q?.outcome === 'covered') return { settled: true, why: 'covered' };
  if (q && !q.refusal && q.fee_minor === 0) return { settled: true, why: 'zero_fee' };
  if (row.method === 'none') return { settled: false, needs: 'driver_word' };
  if (!q || q.refusal) return { settled: false, needs: 'person' };
  return { settled: false, needs: 'payment' };
}

/** The fee as shown, without the pricing internals the close keeps. */
function presentFee(q) {
  if (!q) return null;
  return {
    outcome: q.outcome,
    covered_by: q.covered_by,
    fee_minor: q.fee_minor,
    subtotal_minor: q.subtotal_minor,
    currency: q.currency,
    breakdown: q.breakdown,
    refused: Boolean(q.refusal),
  };
}

/** A case as the lane reads it. */
export function present(row) {
  return {
    id: row.id,
    event_id: row.event_id,
    exit_at: row.exit_at,
    method: row.method,
    session_id: row.session_id,
    entry_at: row.quote?.entry_at ?? row.claimed_entry_at ?? null,
    claimed_entry_at: row.claimed_entry_at,
    fee: presentFee(row.quote),
    payment: presentPayment(row.payment ?? null),
    ...settledOf(row),
    closed: row.closed_at !== null,
  };
}

/** A case as an attendant reads it: the lane's view, the stays considered and what the picker said. */
export function presentForPerson(row) {
  return {
    ...present(row),
    lane_id: row.lane_id,
    candidates: row.candidates,
    picker: row.picker,
    person: row.person,
    created_at: row.created_at,
  };
}
