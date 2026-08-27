/**
 * Reconciliation. Counts that should agree, reported when they do not.
 *
 * The presence gate reduces bad reads. It never proves zero, and neither does
 * any detector anyone could put in front of it -- so the counts that would
 * reveal a gate being worked, or quietly failing, are worth having regardless.
 *
 * NOTHING HERE CORRECTS ANYTHING. It reports divergence and stops. An
 * auto-correcting reconciler on a money record is a way to lose the evidence of
 * the thing you were trying to detect.
 *
 * One of the three checks the brief asked for cannot be built yet, and this
 * module says so in its own output rather than only in a receipt -- see
 * `vehicles_counted_out` below.
 */

/**
 * Arrivals against sessions, over a window.
 *
 * Divergence here is NORMAL, not an alarm: every fallback, every denial and
 * every refused arming is an arrival that opened no session. The signal is the
 * SHAPE over time. A lane being worked by somebody tripping the loop shows as
 * rejections climbing while arrivals and sessions hold steady; a gate that has
 * started refusing real cars shows as rejections climbing while sessions FALL.
 * Those two look identical in a single number, which is why all four are
 * returned rather than one ratio.
 */
export async function arrivalsVersusSessions(client, tenantId, garageId, since) {
  const events = await client.query(
    `SELECT
       count(*) FILTER (WHERE kind = 'frames_captured') AS arrivals,
       count(*) FILTER (WHERE kind = 'arming_rejected') AS rejected,
       count(*) FILTER (WHERE kind = 'fallback_needs_human') AS fallbacks
     FROM events
     WHERE tenant_id = $1 AND garage_id = $2 AND occurred_at >= $3`,
    [tenantId, garageId, since],
  );
  const sessions = await client.query(
    `SELECT count(*) AS opened
     FROM sessions
     WHERE tenant_id = $1 AND garage_id = $2 AND entry_at >= $3`,
    [tenantId, garageId, since],
  );

  const arrivals = Number(events.rows[0].arrivals);
  const opened = Number(sessions.rows[0].opened);
  return {
    since,
    arrivals,
    sessions_opened: opened,
    arming_rejected: Number(events.rows[0].rejected),
    fallbacks: Number(events.rows[0].fallbacks),
    unaccounted: arrivals - opened,
  };
}

/**
 * Sessions still open past a plausible maximum stay.
 *
 * A session that never closes is a car the garage believes is still inside
 * forever. It corrupts the inside-count, and on a monthly it is money nobody
 * ever collects. The plate is NOT returned -- an operator needs to know which
 * sessions and for how long, and can look one up deliberately; a reconciliation
 * report is not a place to spray identities.
 */
export async function sessionsOpenTooLong(client, tenantId, garageId, maxHours) {
  const { rows } = await client.query(
    `SELECT id, entry_at,
            extract(epoch FROM (now() - entry_at)) / 3600 AS open_hours
     FROM sessions
     WHERE tenant_id = $1 AND garage_id = $2
       AND exit_at IS NULL
       AND entry_at < now() - make_interval(hours => $3::int)
     ORDER BY entry_at`,
    [tenantId, garageId, maxHours],
  );
  return rows.map((row) => ({
    session_id: row.id,
    entry_at: row.entry_at,
    open_hours: Math.round(Number(row.open_hours) * 10) / 10,
  }));
}

/**
 * The third check the brief asked for, and why it is not here.
 *
 * "Sessions opened versus vehicles counted OUT" needs a count of vehicles
 * leaving that does not come from the sessions themselves -- otherwise it is
 * the same number twice and agrees by construction, which is worse than not
 * checking. That independent count is the counting module, and it does not
 * exist: there is no counting or occupancy table in this schema.
 *
 * Reported as unavailable in the response rather than silently omitted, so a
 * consumer sees a gap instead of assuming three checks ran.
 */
export const VEHICLES_COUNTED_OUT_UNAVAILABLE = {
  available: false,
  reason:
    'needs an independent count of vehicles leaving, which is the counting module. ' +
    'No counting or occupancy table exists yet; deriving it from sessions would ' +
    'compare a number with itself and agree by construction.',
};

export async function reconcile(client, tenantId, garageId, { since, maxHours }) {
  return {
    garage_id: garageId,
    arrivals_versus_sessions: await arrivalsVersusSessions(client, tenantId, garageId, since),
    sessions_open_too_long: {
      max_hours: maxHours,
      sessions: await sessionsOpenTooLong(client, tenantId, garageId, maxHours),
    },
    vehicles_counted_out: VEHICLES_COUNTED_OUT_UNAVAILABLE,
  };
}
