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
 * (`why: "old"`).
 */
import { HttpError } from './errors.js';

export const OUTCOMES = Object.freeze(['ended', 'abandoned']);
export const STAY_ENDED_EVENT_KIND = 'stay_ended';
export const ENDED_STAY_CLOSED_EVENT_KIND = 'ended_stay_closed';
export const EXIT_BEFORE_ENTRY_EVENT_KIND = 'exit_before_entry';

/** How old an open stay is before it is listed, by default, and the bounds of the setting. */
export const STUCK_DEFAULT_HOURS = 72;
export const STUCK_MIN_HOURS = 1;
export const STUCK_MAX_HOURS = 90 * 24;
/** At most this many stays in one answer, oldest first. */
export const STUCK_LIMIT = 500;
export const REASON_MAX = 500;

const bad = (message, code) => new HttpError(400, message, code);

/** `older_than_hours` from the query: a whole number of hours in bounds, or the default. */
export function olderThanHours(raw) {
  if (raw === undefined) return STUCK_DEFAULT_HOURS;
  const n = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < STUCK_MIN_HOURS || n > STUCK_MAX_HOURS) {
    throw bad(`older_than_hours must be a whole number of hours from ${STUCK_MIN_HOURS} to ${STUCK_MAX_HOURS}`, 'older_than_hours_invalid');
  }
  return n;
}

/** `{outcome, reason, left_at?}` as a person sends it, checked. `leftAt` is a Date or null. */
export function endRequest(body, parseTime) {
  const outcome = body?.outcome;
  if (!OUTCOMES.includes(outcome)) throw bad(`outcome must be one of ${OUTCOMES.join(', ')}`, 'outcome_invalid');
  const reason = body?.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > REASON_MAX) {
    throw bad(`reason is required: why the stay is ended, at most ${REASON_MAX} characters`, 'reason_required');
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
    `SELECT s.id, s.entry_at, s.entry_plate_pattern, v.plate, v.ticket_ref, v.unread_ref, l.name AS entry_lane,
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
    `SELECT s.id, s.entry_at, s.entry_plate_pattern, v.plate, v.ticket_ref, v.unread_ref, l.name AS entry_lane,
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

/** A listed stay, in the shape the attendant's app reads, with what the walks say of it. */
export function presentStuck(r, walks = { lastSeen: new Map(), notSeenLast: new Set() }) {
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
  };
}

/** An ended stay, as the person who ended it reads it back. */
export function presentEnded(s) {
  return {
    id: s.id,
    entered_at: s.entry_at,
    exit_at: s.exit_at,
    ended: s.ended,
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
