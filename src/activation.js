/**
 * The activation gate: a garage is not usable until its whole setup is done
 * (U7g) -- every step of the setup checklist except alerts, worked out by
 * `openingSteps` in src/setup.js and nowhere else. The checklist shows the
 * same list as the open step's `not_done`, so what the screen calls ready is
 * what this gate opens.
 *
 * The readout below still carries the three conditions the DATABASE can see
 * and its trigger re-checks as the row is written (migrations 0014, 0022) --
 * the second layer, not the whole gate:
 *
 *   rate_setup_complete    at least one plan is stored (0012) and a version
 *                          is in force now. The store already refused a plan
 *                          the engine found fault with, so this is presence
 *                          and coverage, not a second validation.
 *   transient_mode_stated  `transient_available` is true or false -- the
 *                          three-state field garage-pass ships, copied: NULL
 *                          is UNSTATED, not false, and no default fills it.
 *   taxes_stated           a tax set (0022) is in force now: with rules, or
 *                          stating none (`rule_count` 0). The same three
 *                          states -- with rules, none, UNSTATED -- and the same
 *                          rule: no set in force is unstated, never "none".
 *
 * The payment condition is the setup's own getting-paid step, for a garage
 * that takes any driver: the payment account it RECORDED can take cards. This
 * module holds none of it and names no processor (the test still sweeps it).
 * What the owner also asked for -- money collection TESTED -- is not a
 * condition yet, because nothing in the system tests a payment yet; a gate
 * never reports satisfied what it cannot observe.
 *
 * `readout()` says which conditions hold and why not, for an operator, and
 * is the ONE place the conditions are written in this module. `activate()`
 * sets `activated_at` and records the act; the database's own trigger checks
 * the same conditions again at that moment, so the route is not the only
 * thing between an unready garage and a live lane.
 */
import * as repo from './repository.js';
import { taxPosition } from './taxes.js';
import { ratePlansForGarage } from './ratePlans.js';
// A cycle (setup.js reads `readout` from here), used only inside functions,
// so neither module needs the other while it loads.
import { openingSteps } from './setup.js';

export const GARAGE_ACTIVATED_EVENT_KIND = 'garage_activated';
export const GARAGE_INACTIVE_REFUSAL_EVENT_KIND = 'garage_inactive_refusal';

/**
 * The garage cannot open yet. `unmet` is the setup steps not done, by key, in
 * the checklist's order -- the setup read's `not_done`, exactly.
 */
export class NotActivatable extends Error {
  constructor(unmet) {
    super(`the garage cannot open yet; these setup steps are not done: ${unmet.join(', ')}`);
    this.unmet = unmet;
  }
}

/** What the gate sees for one garage, right now. */
export async function readout(client, tenantId, garage, { now = null } = {}) {
  // The plans that price, through the one function that selects them
  // (src/ratePlans.js): a plan withdrawn before it started is not counted.
  const priced = await ratePlansForGarage(client, tenantId, garage.id);
  const at = now ? new Date(now).getTime() : Date.now();
  const plans = {
    stored: priced.length,
    in_force: priced.filter((p) => new Date(p.effective_from).getTime() <= at).length,
    earliest: priced.length ? priced[0].effective_from : null,
  };
  const taxes = await taxPosition(client, tenantId, garage.id, { now });
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
    {
      condition: 'taxes_stated',
      met: taxes.in_force > 0,
      reason:
        taxes.stated === 0
          ? 'taxes are unstated: state the taxes this garage charges, or state that it charges none (a tax set with no rules)'
          : taxes.in_force === 0
            ? `${taxes.stated} tax set(s) stated, none in force yet; the earliest takes effect ${taxes.earliest.toISOString()}`
            : taxes.current.rule_count === 0
              ? `stated: this garage charges no tax, from ${new Date(taxes.current.effective_from).toISOString()}`
              : `stated: ${taxes.current.rule_count} tax rule(s) in force, from ${new Date(taxes.current.effective_from).toISOString()}`,
    },
  ];
  return {
    active: garage.activated_at !== null && garage.activated_at !== undefined,
    activated_at: garage.activated_at ?? null,
    conditions,
    // The counts behind the first and third conditions, for a reader that
    // shows them (the setup checklist, src/setup.js) rather than re-reading.
    facts: {
      rate_plans: { stored: plans.stored, in_force: plans.in_force, earliest: plans.earliest ?? null },
      tax_sets: {
        stated: taxes.stated,
        in_force: taxes.in_force,
        earliest: taxes.earliest ?? null,
        rules_in_force: taxes.current ? taxes.current.rule_count : null,
      },
    },
  };
}

/**
 * Activate, or refuse naming every setup step not done. Idempotent: an
 * already-active garage is returned as it is, with no second event. The
 * trigger `garages_activation_gate` re-checks the three conditions the
 * database can see as the row is written.
 */
export async function activate(client, tenantId, garage, { actor, now = null }) {
  if (garage.activated_at) return { garage, activated: false };
  const { notDone } = await openingSteps(client, tenantId, garage);
  if (notDone.length) throw new NotActivatable(notDone);
  const state = await readout(client, tenantId, garage, { now });
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
