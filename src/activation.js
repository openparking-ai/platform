/**
 * The activation gate: a garage is not usable until its rate setup is
 * complete and its transient mode is stated (migration 0014).
 *
 * Two conditions, observed from the schema and never inferred:
 *
 *   rate_setup_complete    at least one plan is stored (0012) and a version
 *                          is in force now. The store already refused a plan
 *                          the engine found fault with, so this is presence
 *                          and coverage, not a second validation.
 *   transient_mode_stated  `transient_available` is true or false -- the
 *                          three-state field garage-pass ships, copied: NULL
 *                          is UNSTATED, not false, and no default fills it.
 *
 * There is deliberately no third condition. The payment-processor onboarding
 * and the tested money collection are a separate requirement with its own
 * place; this gate carries no payment condition at all rather than an
 * unchecked one, because a gate never reports satisfied what it cannot
 * observe. (The test sweeps these sources for the processor's name, so it is
 * not written here even to say it is absent.)
 *
 * `readout()` says which conditions hold and why not, for an operator, and
 * is the ONE place the conditions are written in this module. `activate()`
 * sets `activated_at` and records the act; the database's own trigger checks
 * the same conditions again at that moment, so the route is not the only
 * thing between an unready garage and a live lane.
 */
import * as repo from './repository.js';

export const GARAGE_ACTIVATED_EVENT_KIND = 'garage_activated';
export const GARAGE_INACTIVE_REFUSAL_EVENT_KIND = 'garage_inactive_refusal';

export class NotActivatable extends Error {
  constructor(unmet) {
    super(`the garage cannot be activated: ${unmet.map((c) => `${c.condition} -- ${c.reason}`).join('; ')}`);
    this.unmet = unmet;
  }
}

/** What the gate sees for one garage, right now. */
export async function readout(client, tenantId, garage, { now = null } = {}) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS stored,
            count(*) FILTER (WHERE effective_from <= COALESCE($3::timestamptz, now()))::int AS in_force,
            min(effective_from) AS earliest
       FROM rate_plans
      WHERE tenant_id = $1 AND garage_id = $2`,
    [tenantId, garage.id, now],
  );
  const plans = rows[0];
  const conditions = [
    {
      condition: 'rate_setup_complete',
      met: plans.in_force > 0,
      reason:
        plans.stored === 0
          ? 'no rate plan is stored for this garage'
          : plans.in_force === 0
            ? `${plans.stored} plan(s) stored, none in force yet; the earliest takes effect ${plans.earliest.toISOString()}`
            : `${plans.in_force} of ${plans.stored} stored plan(s) in force`,
    },
    {
      condition: 'transient_mode_stated',
      met: garage.transient_available !== null && garage.transient_available !== undefined,
      reason:
        garage.transient_available === null || garage.transient_available === undefined
          ? 'transient_available is unstated: say whether this garage sells transient parking (true) or is pass and monthly only (false)'
          : `transient_available is ${garage.transient_available}`,
    },
  ];
  return {
    active: garage.activated_at !== null && garage.activated_at !== undefined,
    activated_at: garage.activated_at ?? null,
    conditions,
  };
}

/**
 * Activate, or refuse by name. Idempotent: an already-active garage is
 * returned as it is, with no second event. The trigger
 * `garages_activation_gate` re-checks the conditions as the row is written.
 */
export async function activate(client, tenantId, garage, { actor, now = null }) {
  if (garage.activated_at) return { garage, activated: false };
  const state = await readout(client, tenantId, garage, { now });
  const unmet = state.conditions.filter((c) => !c.met);
  if (unmet.length) throw new NotActivatable(unmet);
  const { rows } = await client.query(
    `UPDATE garages SET activated_at = COALESCE($3::timestamptz, now())
      WHERE tenant_id = $1 AND id = $2 AND activated_at IS NULL
      RETURNING *`,
    [tenantId, garage.id, now],
  );
  const activated = rows[0];
  await repo.appendEvents(client, tenantId, [
    {
      garageId: garage.id,
      laneId: null,
      eventId: `garage_activated:${garage.id}`,
      kind: GARAGE_ACTIVATED_EVENT_KIND,
      occurredAt: activated.activated_at,
      detail: {
        actor,
        garage_id: garage.id,
        transient_available: activated.transient_available,
        conditions: state.conditions,
      },
    },
  ]);
  return { garage: activated, activated: true };
}

/**
 * The record of a lane refused at an inactive garage, written BEFORE the 409
 * is answered. The lane drops a 409 -- counted there, forgotten here -- so
 * this row is the platform's only memory that a car was turned away. Keyed
 * on the lane's own event id, so a replay adds nothing.
 */
export async function recordInactiveRefusal(client, tenantId, { garageId, laneId, laneEventId, action, at }) {
  await repo.appendEvents(client, tenantId, [
    {
      garageId,
      laneId,
      eventId: `inactive:${laneEventId}`,
      kind: GARAGE_INACTIVE_REFUSAL_EVENT_KIND,
      occurredAt: at,
      detail: {
        actor: 'platform:lane',
        action,
        lane_event_id: laneEventId,
      },
    },
  ]);
}

/** `true`, `false`, or a refusal naming the field. NULL is not a value a request may send. */
export function transientAvailableField(raw, { required }) {
  if (raw === undefined) {
    if (required) throw new TypeError('transient_available is required: true (sells transient parking) or false (pass and monthly only)');
    return undefined;
  }
  if (raw !== true && raw !== false) {
    throw new TypeError(`transient_available is true or false, not ${JSON.stringify(raw)}; unstated is the absence of the field, never a value`);
  }
  return raw;
}
