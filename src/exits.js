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
 *
 * ONE OPEN CASE PER STAY (0037), and a new one SUPERSEDES it (0045): a lane
 * drops its case when the car leaves the loop unsettled, and the car comes
 * back -- to this lane or the other. The old case's open payment is
 * canceled at Stripe first. A person ending the stay closes its open case
 * the same way. Either is `ended` on the case, closed with no close event.
 *
 * PAID AND LEFT (the owner's rule, 2026-10-30; 0048): a stay is finished
 * when the car crosses the closing loop after the gate. A car that paid and
 * backed out before it is the same stay, with no time limit: its next case
 * prices the WHOLE stay again, CREDITS what the stay already paid at its
 * other cases, and asks only the difference -- nothing when the price is not
 * higher (`withCredit`). The quote keeps the whole stay's figures, which the
 * close writes; `due_minor` is what this exit asks for and what is paid.
 */

export const UNMATCHED_EVENT_KIND = 'exit_unmatched';
export const DRIVER_WORD_EVENT_KIND = 'exit_driver_word';
export const PERSON_EVENT_KIND = 'exit_let_out_by_person';
export const SUPERSEDED_EVENT_KIND = 'exit_superseded';
/** A case closed because the car came in again: its stay is over (0048). */
export const REENTERED_EVENT_KIND = 'exit_stay_reentered';
/** The lane's reader refused a case's payment (0048): what an exception reads as the reader's errors. */
export const READER_REFUSED_EVENT_KIND = 'exit_reader_refused';
export const READER_REFUSALS = Object.freeze(['reader_offline', 'reader_busy', 'no_reader_bound']);

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

/** The authorities a person at the lane opens the barrier on, as the lane's vend names them. */
export const LET_OUT_AUTHORITIES = Object.freeze(['display_code_confirmed', 'human_open_now', 'human_open_and_flag']);

/** The authority on which the person opened and flagged the exit for review. */
export const FLAGGED_AUTHORITY = 'human_open_and_flag';

/** The close's `let_out_by`: one of LET_OUT_AUTHORITIES, on a close that names its case; or null. */
export function letOutByField(value, exitId) {
  if (value === undefined || value === null) return null;
  if (!LET_OUT_AUTHORITIES.includes(value)) throw bad(`let_out_by must be one of ${LET_OUT_AUTHORITIES.join(', ')}`);
  if (!exitId) throw bad('let_out_by is sent with the exit_id of the case the person opened for');
  return value;
}

/**
 * A CAR LET OUT OWING, WITH NOTHING PAID (0042): the record its stay closes
 * with, or null when nothing was owed or the card paid. `by` is the
 * attendant who decided the case, or else the lane computer a person
 * opened from (`by`), with the authority the lane named.
 */
export function letOutOf(row, { by, authority, at }) {
  if (!owesAtExit(row)) return null;
  const q = row.quote;
  return {
    paid: false,
    by: row.person?.by ?? by,
    reason: row.person?.reason ?? authority ?? null,
    exit_id: row.id,
    // What it still owed: the whole stay less what the stay paid at its
    // earlier cases (`due_minor`); null when it could not be priced.
    owed_minor: dueOf(q),
    // What the stay had paid at those cases, kept beside it: a car let out
    // owing the difference had paid the rest.
    paid_minor: creditOf(q),
    currency: q?.currency ?? null,
    payment: row.payment?.status ?? null,
    at: at.toISOString(),
  };
}

/**
 * Whether the car at this case still owed when it was let out: not paid,
 * not covered, not a fee of zero. A person letting such a car out is a car
 * let out unpaid (0042, 0048).
 */
export function owesAtExit(row) {
  if (paidFor(row)) return false;
  const q = row.quote;
  if (q?.outcome === 'covered') return false;
  if (q && !q.refusal && dueOf(q) === 0) return false;
  return true;
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

/**
 * The latest succeeded payment of the case's STAY taken at another of its
 * cases, or null: the car paid at a case that was then superseded (0045) --
 * the gate faulted, the car backed off and came back, or went to the other
 * exit lane. It settles this case only when the stay's credit covers the
 * whole stay priced again (`paidFor`): never on its own.
 */
const STAY_PAYMENT = `(SELECT to_jsonb(sp) FROM exit_payments sp
                         WHERE sp.tenant_id = e.tenant_id AND sp.session_id = e.session_id
                           AND sp.exit_id <> e.id AND sp.status = 'succeeded'
                         ORDER BY sp.succeeded_at DESC, sp.id DESC
                         LIMIT 1)`;

/** A case with its payment (0038) beside it, as `payment`, and its stay's paid one, as `stay_payment`. */
const WITH_PAYMENT = `SELECT e.*, to_jsonb(p) AS payment, ${STAY_PAYMENT} AS stay_payment
                        FROM exits e
                        LEFT JOIN exit_payments p ON p.tenant_id = e.tenant_id AND p.exit_id = e.id`;

/** A row written with RETURNING, given its payments as a read would. */
export async function withPayment(client, tenantId, row) {
  if (!row) return row;
  const { rows } = await client.query(
    `SELECT to_jsonb(p) AS payment, ${STAY_PAYMENT} AS stay_payment
       FROM exits e LEFT JOIN exit_payments p ON p.tenant_id = e.tenant_id AND p.exit_id = e.id
      WHERE e.tenant_id = $1 AND e.id = $2`,
    [tenantId, row.id],
  );
  return { ...row, payment: rows[0]?.payment ?? null, stay_payment: rows[0]?.stay_payment ?? null };
}

/**
 * The payment that paid this case, or null: its own, succeeded; or, when what
 * the stay paid at its earlier cases covers the whole stay priced again
 * (`creditCovers`), the latest of those. "I paid, the gate didn't open": the
 * paid stay opens -- at the price it paid, and no further.
 */
export function paidFor(row) {
  if (row.payment?.status === 'succeeded') return row.payment;
  if (creditCovers(row.quote) && row.stay_payment?.status === 'succeeded') return row.stay_payment;
  return null;
}

/** What the stay paid at its other cases, credited on this case's quote (0048); 0 with none. */
export function creditOf(q) {
  return q?.credit?.paid_minor ?? 0;
}

/**
 * WHAT THIS EXIT ASKS FOR: the whole stay less what it already paid
 * (`due_minor`), or the fee on a case with no credit; 0 when covered; null
 * when it could not be priced. A case written before 0048 that carried a
 * paid fee over (`paid_at_exit`) asks nothing.
 */
export function dueOf(q) {
  if (!q) return null;
  if (q.outcome === 'covered') return 0;
  if (q.refusal) return null;
  if (q.due_minor !== undefined && q.due_minor !== null) return q.due_minor;
  if (q.paid_at_exit && q.credit === undefined) return 0;
  return q.fee_minor;
}

/** The stay paid at its earlier cases at least the whole stay priced again: nothing more is asked. */
export function creditCovers(q) {
  if (!q || q.refusal) return false;
  if (q.paid_at_exit && q.credit === undefined) return true;
  return creditOf(q) > 0 && dueOf(q) === 0;
}

/**
 * Every succeeded payment of the stay taken at a case other than `exitId`,
 * oldest first, with the quote of the case it paid: what a new case
 * credits. Read under the stay's lock, after the old case's open payment was
 * settled at Stripe, so none of them can still move.
 */
export async function stayPayments(client, tenantId, sessionId, exitId = null) {
  const { rows } = await client.query(
    `SELECT p.id, p.exit_id, p.amount_minor, p.currency, p.succeeded_at, e.quote
       FROM exit_payments p
       JOIN exits e ON e.tenant_id = p.tenant_id AND e.id = p.exit_id
      WHERE p.tenant_id = $1 AND p.session_id = $2 AND p.status = 'succeeded'
        AND ($3::uuid IS NULL OR p.exit_id <> $3)
      ORDER BY p.succeeded_at, p.id`,
    [tenantId, sessionId, exitId],
  );
  return rows;
}

/**
 * THE CREDIT (the owner's rule, 2026-10-30): a new case's quote, given what
 * the stay already paid at its other cases.
 *
 *   nothing paid        the quote as priced; it asks its fee.
 *   priced higher       the whole stay as priced, the credit beside it, and
 *                       `due_minor` the difference: what is paid now.
 *   not higher          (or covered now) nothing more is asked: the stay
 *                       keeps the figures of the case whose payment paid it
 *                       last -- what the stay paid in all, since each case's
 *                       payment was its whole fee less its own credit -- and
 *                       the new price is kept beside them (`repriced`).
 *   not priced          the refusal, the credit beside it: a person decides.
 *
 * Never a negative figure, and never a payment the stay already made: the
 * credit is every succeeded payment of the stay.
 */
export function withCredit(priced, payments) {
  if (!payments.length) return priced;
  const currency = String(priced.currency).toLowerCase();
  if (payments.some((p) => String(p.currency).toLowerCase() !== currency)) {
    throw new Error("a stay's payments are in another currency than its price");
  }
  const paidMinor = payments.reduce((sum, p) => sum + Number(p.amount_minor), 0);
  const credit = {
    paid_minor: paidMinor,
    payments: payments.map((p) => ({ id: p.id, exit_id: p.exit_id, amount_minor: Number(p.amount_minor) })),
  };
  if (priced.refusal) return { ...priced, credit, due_minor: null };
  if (priced.outcome !== 'covered' && priced.fee_minor > paidMinor) {
    return { ...priced, credit, due_minor: priced.fee_minor - paidMinor };
  }
  const last = payments[payments.length - 1].quote;
  return {
    ...last,
    credit,
    due_minor: 0,
    repriced: { outcome: priced.outcome, fee_minor: priced.fee_minor, exit_at: priced.exit_at, covered_by: priced.covered_by },
  };
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

/**
 * A new case; a resend of the same lane event id returns the case already
 * written. `c.caseId`, when given, is the new case's id: a case it
 * supersedes names it before it is written.
 */
export async function insertCase(client, tenantId, c) {
  const { rows } = await client.query(
    `INSERT INTO exits (id, tenant_id, garage_id, lane_id, event_id, exit_at, plate_state, plate_rule, plate_pattern,
                        colour_code, size, method, session_id, candidates, picker, quote)
     VALUES (COALESCE($16::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (tenant_id, event_id) DO NOTHING
     RETURNING *`,
    [
      tenantId, c.garageId, c.laneId, c.eventId, c.exitAt, c.id.plate?.state ?? null, c.id.plate?.rule ?? null,
      c.id.plate?.pattern ?? null, c.id.colour_code, c.id.size, c.method, c.sessionId ?? null,
      JSON.stringify(c.candidates ?? []), c.picker ? JSON.stringify(c.picker) : null, c.quote ? JSON.stringify(c.quote) : null,
      c.caseId ?? null,
    ],
  );
  const row = rows[0] ? await withPayment(client, tenantId, rows[0]) : await caseByEvent(client, tenantId, c.eventId);
  return { row, created: rows.length === 1 };
}

/**
 * The stay's open cases (0037 holds at most one), oldest first. `lock`
 * takes each FOR UPDATE: a case is locked before its stay, everywhere (the
 * close takes the case, then the stay), so two writers never wait on each
 * other in opposite orders.
 */
export async function openCasesOfStay(client, tenantId, sessionId, { lock = false } = {}) {
  const { rows } = await client.query(
    `${WITH_PAYMENT} WHERE e.tenant_id = $1 AND e.session_id = $2 AND e.closed_at IS NULL
      ORDER BY e.created_at, e.id${lock ? ' FOR UPDATE OF e' : ''}`,
    [tenantId, sessionId],
  );
  return rows;
}

/**
 * CLOSED BY THE PLATFORM (0045), not by a lane's close: `{why: "superseded",
 * by_exit}` -- a new case for the same stay takes its place -- or `{why:
 * "stay_ended", by}` -- a person ended the stay. Null when the case is not
 * open. Its payment is settled at Stripe BEFORE this (canceled, or found
 * paid): never closed with a card that can still be taken.
 */
export async function endCase(client, tenantId, exitId, ended) {
  const { rows } = await client.query(
    `UPDATE exits SET closed_at = now(), ended = $3
      WHERE tenant_id = $1 AND id = $2 AND closed_at IS NULL RETURNING *`,
    [tenantId, exitId, JSON.stringify({ ...ended, at: new Date().toISOString() })],
  );
  return withPayment(client, tenantId, rows[0] ?? null);
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
  if (paidFor(row) || creditCovers(row.quote)) return { settled: true, why: 'paid' };
  const q = row.quote;
  if (q?.outcome === 'covered') return { settled: true, why: 'covered' };
  if (q && !q.refusal && dueOf(q) === 0) return { settled: true, why: 'zero_fee' };
  if (row.method === 'none') return { settled: false, needs: 'driver_word' };
  if (!q || q.refusal) return { settled: false, needs: 'person' };
  return { settled: false, needs: 'payment' };
}

/**
 * The fee as shown, without the pricing internals the close keeps.
 * `fee_minor` is what this exit asks for -- the whole stay less what it
 * already paid at its earlier cases (0048) -- so a screen that shows it shows
 * what the card is charged. `stay_fee_minor` is the whole stay, which the
 * breakdown and the subtotal describe; `credit_minor` what it had paid.
 */
function presentFee(q) {
  if (!q) return null;
  return {
    outcome: q.outcome,
    covered_by: q.covered_by,
    fee_minor: dueOf(q),
    stay_fee_minor: q.refusal ? null : q.fee_minor,
    credit_minor: creditOf(q),
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
    // Its own payment; or, with none, the one that paid its stay at a case
    // it superseded when the credit covers the whole stay (`paid_at_exit`
    // names that case).
    payment: presentPayment(row.payment ?? paidFor(row)),
    paid_at_exit: !row.payment && paidFor(row) ? paidFor(row).exit_id : null,
    ...settledOf(row),
    closed: row.closed_at !== null,
    // Closed by the platform, not by a close (0045): why, and the case that
    // took its place when it was superseded.
    ended: row.ended ? { why: row.ended.why, superseded_by: row.ended.by_exit ?? null } : null,
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
    ended: row.ended ?? null,
    created_at: row.created_at,
  };
}
