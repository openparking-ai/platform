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
import * as ratePlans from './ratePlans.js';
import * as repo from './repository.js';

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
 * The closes that could not be priced (migration 0013): the stay is closed --
 * the car is gone -- and carries no fee, only the refusal, by name. A COVERED
 * close (0015) carries no fee either and is NOT one of these: it is keyed on
 * the refusal, not on the absent fee. Listed
 * here because a report is where a human looks, and an unpriced close that
 * only exists as a row and an event is a gap in the money record nobody is
 * shown. No plate, for the reason above; the codes ARE returned, because
 * "no version in force at entry" and "the garage has no plan" are different
 * mornings.
 */
export async function closesUnpriced(client, tenantId, garageId, since) {
  const { rows } = await client.query(
    `SELECT id, entry_at, exit_at, pricing_refusal
     FROM sessions
     WHERE tenant_id = $1 AND garage_id = $2
       AND exit_at IS NOT NULL AND pricing_refusal IS NOT NULL
       AND exit_at >= $3
     ORDER BY exit_at`,
    [tenantId, garageId, since],
  );
  return rows.map((row) => ({
    session_id: row.id,
    entry_at: row.entry_at,
    exit_at: row.exit_at,
    refusal_codes: (row.pricing_refusal ?? []).map((f) => f.code),
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

/**
 * Stays closed on the LANE'S decision (0017), re-derived out of band.
 *
 * The close wrote a fee a device computed; this recomputes it from what the
 * device said it decided from -- `decision_inputs`: the entry and exit
 * instants, the space class, the currency -- and from the plans as this
 * platform stores them, through the same engine call the close would have
 * made. It compares fee and plan version, and it REPORTS. It corrects
 * nothing, changes no row, and does not even suggest the right number is the
 * recomputed one: a divergence is evidence that two computations disagree,
 * and which is wrong is a question for whoever reads this.
 *
 * Three lists, each named for what it is, never folded:
 *   diverged        the engine, from the lane's own inputs, priced a different
 *                   fee or chose a different plan than the row carries.
 *   inputs_disagree the lane's inputs are not this row's: it priced between
 *                   instants other than the stay's own, or in another class.
 *                   The fee may still recompute; the disagreement is reported
 *                   on its own because it is a different fact.
 *   unrecomputable  the engine could not be asked, or refused the inputs.
 *                   NOT a divergence and not an agreement: nothing was
 *                   measured, and the report says so rather than counting it
 *                   either way.
 * ...and `covered_by_lane`: stays the lane let out covered, listed with the
 * pass or agreement it matched. They are NOT re-consulted: the modules answer
 * for an instant against the register as it is NOW, and a pass revoked since
 * the exit would read as a false divergence. Listed so a reader can check
 * them against the modules' own records; not judged here.
 *
 * `quote` is `ratePlans.quoteWithEngine` unless a test hands in another; it
 * is called once per priced row, off the barrier's path, on the operator's
 * reconciliation route.
 */
export async function laneDecidedCloses(client, tenantId, garageId, since, { quote, plans } = {}) {
  const rows = await repo.laneDecidedSessions(client, tenantId, garageId, since);
  const report = {
    since,
    checked: 0,
    agreed: 0,
    diverged: [],
    inputs_disagree: [],
    unrecomputable: [],
    covered_by_lane: [],
  };
  const priceable = rows.filter((r) => r.exit_outcome === 'transient' && r.fee_minor !== null);
  const documents = plans ?? (priceable.length
    ? ratePlans.documents(await ratePlans.ratePlansForGarage(client, tenantId, garageId))
    : []);
  const ask = quote ?? ratePlans.quoteWithEngine;
  for (const row of rows) {
    if (row.exit_outcome === 'covered') {
      report.covered_by_lane.push({
        session_id: row.id,
        exit_at: row.exit_at,
        covered_by: row.entitlement?.covered_by ?? [],
        matched: row.entitlement?.local_decision?.matched ?? [],
      });
      continue;
    }
    if (row.fee_minor === null) continue;
    const inputs = row.decision_inputs ?? {};
    report.checked += 1;
    const rowEntry = new Date(row.entry_at).toISOString();
    const rowExit = new Date(row.exit_at).toISOString();
    const disagreement = [];
    if (inputs.entry_at && new Date(inputs.entry_at).toISOString() !== rowEntry) disagreement.push('entry_at');
    if (inputs.exit_at && new Date(inputs.exit_at).toISOString() !== rowExit) disagreement.push('exit_at');
    if (inputs.space_class && inputs.space_class !== row.space_class) disagreement.push('space_class');
    if (inputs.currency && inputs.currency !== row.currency) disagreement.push('currency');
    if (disagreement.length) {
      report.inputs_disagree.push({
        session_id: row.id, fields: disagreement,
        lane: { entry_at: inputs.entry_at, exit_at: inputs.exit_at, space_class: inputs.space_class, currency: inputs.currency },
        row: { entry_at: rowEntry, exit_at: rowExit, space_class: row.space_class, currency: row.currency },
      });
    }
    let recomputed;
    try {
      recomputed = await ask({
        plans: documents,
        currency: inputs.currency ?? row.currency,
        spaceClass: inputs.space_class ?? row.space_class,
        entryAt: new Date(inputs.entry_at ?? row.entry_at),
        exitAt: new Date(inputs.exit_at ?? row.exit_at),
      });
    } catch (err) {
      report.unrecomputable.push({
        session_id: row.id,
        reason: err instanceof ratePlans.PricingRefused ? 'the engine refused the inputs' : `the engine could not be asked: ${err.message}`,
        findings: err instanceof ratePlans.PricingRefused ? err.findings : undefined,
      });
      continue;
    }
    const laneFee = Number(row.fee_minor);
    if (recomputed.feeMinor !== laneFee || recomputed.planVersion !== row.plan_version) {
      report.diverged.push({
        session_id: row.id,
        exit_at: rowExit,
        lane: { fee_minor: laneFee, plan_version: row.plan_version },
        recomputed: { fee_minor: recomputed.feeMinor, plan_version: recomputed.planVersion },
        synced_at: inputs.synced_at ?? null,
      });
    } else {
      report.agreed += 1;
    }
  }
  return report;
}

export async function reconcile(client, tenantId, garageId, { since, maxHours }) {
  return {
    garage_id: garageId,
    arrivals_versus_sessions: await arrivalsVersusSessions(client, tenantId, garageId, since),
    sessions_open_too_long: {
      max_hours: maxHours,
      sessions: await sessionsOpenTooLong(client, tenantId, garageId, maxHours),
    },
    closes_unpriced: {
      since,
      sessions: await closesUnpriced(client, tenantId, garageId, since),
    },
    lane_decisions: await laneDecidedCloses(client, tenantId, garageId, since),
    vehicles_counted_out: VEHICLES_COUNTED_OUT_UNAVAILABLE,
  };
}
