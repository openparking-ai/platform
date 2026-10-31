/**
 * STAYS NOTHING CLOSED (0039): the ones that look stuck, listed, and a
 * person ending each with a reason.
 *
 * A car is inside from its entry until it comes out, and nothing ages a stay
 * out of the count. So a stay whose exit was never seen -- a car the exit
 * could not match and the driver's word settled (0037), an unread car, a
 * lost exit -- would keep counting for ever, and a full garage would stay
 * full. A person ends it here: `ended` (the car left: no more inside from
 * when they say it left) or `abandoned` (written off: no charge expected).
 * Either way the stay is closed unpriced, with who, when and the person's
 * own words on it, an event beside it and a line in the change log. Works
 * by the stay's id, so an unread stay ends like any other.
 *
 * "Not seen on recent walks" is read from the inventory walks (0040): a
 * stay the garage's latest finished walk did not see is listed whatever its
 * age (`why: "not_seen_on_walk"`), and `last_seen_on_walk` is when a
 * finished walk last saw it. Any other stay is listed for its age
 * (`why: "old"`): older than the garage's `stuck_after_hours` (0043, 24
 * unless the garage sets another), or the age the reader asks for.
 *
 * A stay a person ended because the car left OWES what its exit would have
 * charged (0043): priced as the exit prices, at the time the person said
 * it left, and kept on `ended.owed`. Nothing is charged: the stay stays
 * unpriced, and the garage collects what it owes its own way.
 */
import { HttpError } from './errors.js';

export const OUTCOMES = Object.freeze(['ended', 'abandoned']);
export const STAY_ENDED_EVENT_KIND = 'stay_ended';
export const ENDED_STAY_CLOSED_EVENT_KIND = 'ended_stay_closed';
export const EXIT_BEFORE_ENTRY_EVENT_KIND = 'exit_before_entry';

/** How old an open stay is before it is listed, for a garage that set nothing (0043), and the bounds of the setting. */
export const STUCK_DEFAULT_HOURS = 24;
export const STUCK_MIN_HOURS = 1;
export const STUCK_MAX_HOURS = 90 * 24;
/** At most this many stays in one answer, oldest first. */
export const STUCK_LIMIT = 500;
export const REASON_MAX = 500;
/** At most this many entry pictures named for one listed stay, newest first. */
export const PICTURES_PER_STAY = 4;

// Control characters: a reason is shown back to people, in a screen and in
// the change log, as the words they typed and nothing else.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const bad = (message, code) => new HttpError(400, message, code);

const hoursInBounds = (n) => Number.isInteger(n) && n >= STUCK_MIN_HOURS && n <= STUCK_MAX_HOURS;

/** `older_than_hours` from the query: a whole number of hours in bounds, or the garage's own setting. */
export function olderThanHours(raw, garageHours = STUCK_DEFAULT_HOURS) {
  if (raw === undefined) return garageHours;
  const n = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!hoursInBounds(n)) {
    throw bad(`older_than_hours must be a whole number of hours from ${STUCK_MIN_HOURS} to ${STUCK_MAX_HOURS}`, 'older_than_hours_invalid');
  }
  return n;
}

/** The garage's `stuck_after_hours` as an owner sends it (PATCH), checked. Undefined when not sent. */
export function stuckAfterHours(raw) {
  if (raw === undefined) return undefined;
  if (!hoursInBounds(raw)) {
    throw bad(`stuck_after_hours must be a whole number of hours from ${STUCK_MIN_HOURS} to ${STUCK_MAX_HOURS} when given`, 'stuck_after_hours_invalid');
  }
  return raw;
}

/** `{outcome, reason, left_at?}` as a person sends it, checked. `leftAt` is a Date or null. */
export function endRequest(body, parseTime) {
  const outcome = body?.outcome;
  if (!OUTCOMES.includes(outcome)) throw bad(`outcome must be one of ${OUTCOMES.join(', ')}`, 'outcome_invalid');
  const reason = body?.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > REASON_MAX) {
    throw bad(`reason is required: why the stay is ended, at most ${REASON_MAX} characters; no plate -- the reason goes to the change log`, 'reason_required');
  }
  if (CONTROL.test(reason)) {
    throw bad('reason must be words on one line: no line breaks or control characters', 'reason_invalid');
  }
  let leftAt = null;
  if (body?.left_at !== undefined && body?.left_at !== null) {
    if (outcome !== 'ended') throw bad('left_at is for a car that left (outcome "ended") only', 'left_at_not_for_abandoned');
    leftAt = parseTime(body.left_at, 'left_at');
  }
  return { outcome, reason: reason.trim(), leftAt };
}

/**
 * The garage's open stays that came in at least `hours` before `now`,
 * oldest first: each with what identifies it to a person (the whole plate,
 * or the sure characters the entry read, or nothing), and whether a car is
 * at an exit lane on it right now.
 */
export async function stuckStays(client, tenantId, garageId, { hours, now = new Date() }) {
  const { rows } = await client.query(
    `SELECT s.id, s.entry_at, s.open_event_id, s.entry_plate_pattern, v.plate, v.ticket_ref, v.unread_ref, l.name AS entry_lane,
            EXISTS (SELECT 1 FROM exits x
                     WHERE x.tenant_id = s.tenant_id AND x.session_id = s.id AND x.closed_at IS NULL) AS at_exit
       FROM sessions s
       JOIN vehicles v ON v.tenant_id = s.tenant_id AND v.id = s.vehicle_id
       LEFT JOIN lanes l ON l.tenant_id = s.tenant_id AND l.id = s.entry_lane_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL
        AND s.entry_at <= $3::timestamptz - make_interval(hours => $4)
      ORDER BY s.entry_at, s.id
      LIMIT $5`,
    [tenantId, garageId, now, hours, STUCK_LIMIT],
  );
  return rows;
}

/**
 * The garage's open stays among `ids` that the age list did not already
 * hold, oldest first: the ones the latest walk did not see.
 */
export async function openStaysAmong(client, tenantId, garageId, ids, except) {
  const wanted = ids.filter((id) => !except.has(id));
  if (wanted.length === 0) return [];
  const { rows } = await client.query(
    `SELECT s.id, s.entry_at, s.open_event_id, s.entry_plate_pattern, v.plate, v.ticket_ref, v.unread_ref, l.name AS entry_lane,
            EXISTS (SELECT 1 FROM exits x
                     WHERE x.tenant_id = s.tenant_id AND x.session_id = s.id AND x.closed_at IS NULL) AS at_exit
       FROM sessions s
       JOIN vehicles v ON v.tenant_id = s.tenant_id AND v.id = s.vehicle_id
       LEFT JOIN lanes l ON l.tenant_id = s.tenant_id AND l.id = s.entry_lane_id
      WHERE s.tenant_id = $1 AND s.id = ANY($3::uuid[]) AND s.garage_id = $2 AND s.exit_at IS NULL
      ORDER BY s.entry_at, s.id
      LIMIT $4`,
    [tenantId, garageId, wanted, STUCK_LIMIT],
  );
  return rows;
}

/**
 * The entry pictures (0033) of the listed stays' opens, newest first, at
 * most PICTURES_PER_STAY each: a map from the open's event id to
 * `[{id, taken_at}]`. Only this garage's pictures.
 */
export async function entryPictures(client, tenantId, garageId, eventIds) {
  const byEvent = new Map();
  if (eventIds.length === 0) return byEvent;
  const { rows } = await client.query(
    `SELECT id, event_id, taken_at FROM (
       SELECT p.id, p.event_id, p.taken_at,
              row_number() OVER (PARTITION BY p.event_id ORDER BY p.taken_at DESC, p.id) AS n
         FROM entry_pictures p
        WHERE p.tenant_id = $1 AND p.garage_id = $2 AND p.event_id = ANY($3::text[])) ranked
      WHERE n <= $4
      ORDER BY event_id, taken_at DESC, id`,
    [tenantId, garageId, eventIds, PICTURES_PER_STAY],
  );
  for (const r of rows) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
    byEvent.get(r.event_id).push({ id: r.id, taken_at: r.taken_at });
  }
  return byEvent;
}

/** One entry picture of an open or closed stay of this garage, as the image itself, or null. */
export async function stayPicture(client, tenantId, garageId, stayId, pictureId) {
  const { rows } = await client.query(
    `SELECT p.content_type, p.image
       FROM sessions s
       JOIN entry_pictures p ON p.tenant_id = s.tenant_id AND p.garage_id = s.garage_id AND p.event_id = s.open_event_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.id = $3 AND p.id = $4`,
    [tenantId, garageId, stayId, pictureId],
  );
  return rows[0] ?? null;
}

/** A listed stay, in the shape the attendant's app reads, with what the walks say of it. */
export function presentStuck(r, walks = { lastSeen: new Map(), notSeenLast: new Set() }, pictures = new Map()) {
  return {
    id: r.id,
    plate: r.plate ?? r.entry_plate_pattern ?? null,
    plate_whole: r.plate !== null,
    ticket: r.ticket_ref !== null,
    unread: r.unread_ref !== null,
    entered_at: r.entry_at,
    entry_lane: r.entry_lane ?? null,
    at_exit: r.at_exit,
    last_seen_on_walk: walks.lastSeen.get(r.id) ?? null,
    why: walks.notSeenLast.has(r.id) ? 'not_seen_on_walk' : 'old',
    pictures: pictures.get(r.open_event_id) ?? [],
  };
}

/**
 * What a stay a person ended because the car left owes (0043), from the
 * exit's own quote: the modules asked, then the rates, then the tax.
 * `fee_minor` 0 when covered, null when the rates refused to price it.
 */
export function owedOf(quote) {
  const covered = quote.outcome === 'covered';
  return {
    outcome: covered ? 'covered' : 'transient',
    fee_minor: covered ? 0 : quote.fee_minor,
    subtotal_minor: covered ? 0 : quote.subtotal_minor,
    currency: quote.currency,
    breakdown: covered ? [] : quote.breakdown,
    plan_version: quote.plan_version ?? null,
    covered_by: quote.covered_by,
    refused: !covered && quote.refusal !== null,
    // A pass the garage links was not asked: the garage has no exit lane to
    // ask it at. The admin shows it beside what is owed.
    pass_unasked: quote.entitlement?.garage_pass?.unasked === true,
    // What each module was asked and said, kept as the close keeps it on a
    // stay an exit closed (0015). It names the car: the retention purge
    // takes it out with the vehicle (src/retention.js).
    entitlement: quote.entitlement ?? null,
  };
}

/**
 * WHAT A STAY STILL OWES, AS SHOWN: what it owes (`ended.owed.fee_minor`, or
 * a let-out's `owed_minor`) less what was paid on the stay at an exit (0045,
 * `ended.paid`), never below 0. Null stays null: a price the rates refused is
 * not a price of nothing. Stripe writes a currency in small letters and the
 * stay in capitals; a payment in another currency is not taken off (an exit
 * charges the stay's own). The stay keeps both figures, whole, as recorded.
 */
export function owedAfterPaid(owedMinor, paid, currency) {
  if (owedMinor === null || owedMinor === undefined) return null;
  const owed = Number(owedMinor);
  if (!paid || String(paid.currency).toUpperCase() !== String(currency).toUpperCase()) return owed;
  return Math.max(0, owed - Number(paid.amount_minor));
}

/** An ended stay, as the person who ended it reads it back: what it owes, when the car left. */
export function presentEnded(s) {
  const owed = s.ended?.owed ?? null;
  return {
    id: s.id,
    entered_at: s.entry_at,
    exit_at: s.exit_at,
    ended: s.ended,
    owed_minor: owed ? owedAfterPaid(owed.fee_minor, s.ended.paid, s.currency) : null,
    // True when the garage links a pass and had no exit lane to ask it at:
    // what is owed was priced without it. Null on a stay that owes nothing.
    pass_unasked: owed ? owed.pass_unasked === true : null,
    currency: s.currency,
  };
}

/** Whether a car is at an exit lane on this stay now: its open exit case (0037). */
export async function atAnExit(client, tenantId, sessionId) {
  const { rows } = await client.query(
    'SELECT id FROM exits WHERE tenant_id = $1 AND session_id = $2 AND closed_at IS NULL',
    [tenantId, sessionId],
  );
  return rows[0]?.id ?? null;
}
