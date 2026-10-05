/**
 * THE SETUP CHECKLIST: one read, computed here and nowhere else.
 *
 * Every step is worked out from the garage's own data, in order, done or not,
 * with the facts it was decided on. Nothing is ticked by hand and nothing is
 * stored: a step is done because the data says so, and stops being done the
 * moment the data stops saying so. The admin shows these steps and never
 * works one out again.
 *
 * The reads are the ones that already exist: the activation readout (rates,
 * taxes, the drivers answer), the garage's recorded payment account, and its
 * lanes with their computers and card readers.
 *
 *   garage_details  the garage's name, time zone and money
 *   drivers         whether it takes drivers without a pass (stated or not)
 *   lanes           at least one way in and one way out
 *   lane_computers  every lane has a connected computer heard from within
 *                   quietMinutes()
 *   rates           a rate plan in force
 *   taxes           taxes stated (charging none is a statement)
 *   getting_paid    ONLY for a garage that takes any driver: a payment
 *                   account that can take cards
 *   card_readers    ONLY for such a garage: every way out has a card reader
 *   open            open or not, and what is still missing
 */
import * as repo from './repository.js';
import * as activation from './activation.js';
import { recordedFacts } from './stripeAccount.js';
import { startSetting } from './startSettings.js';

/**
 * How long a lane computer may go unheard before its lane counts as not
 * connected: `LANE_QUIET_MINUTES`, a start setting (src/startSettings.js,
 * 5 unless the deployment says otherwise), and set nowhere else. The setup
 * read and the lanes read return the value they used; the admin reads it
 * from them and keeps no copy. Read on each request.
 */
export const quietMinutes = () => startSetting('LANE_QUIET_MINUTES');

/** The steps, in the order the checklist shows them. */
export const STEP_KEYS = Object.freeze([
  'garage_details', 'drivers', 'lanes', 'lane_computers', 'rates', 'taxes', 'getting_paid', 'card_readers', 'open',
]);

/** Which activation condition each step stands for: what the platform needs before a garage can open. */
const GATE = Object.freeze({ rate_setup_complete: 'rates', transient_mode_stated: 'drivers', taxes_stated: 'taxes' });

/** How a lane's computers stand, at `now`. */
function laneComputer(lane, now, quiet) {
  const live = lane.devices.filter((d) => d.revoked_at === null);
  if (lane.devices.length === 0) return { state: 'none', last_heard_at: null };
  if (live.length === 0) return { state: 'cancelled', last_heard_at: null };
  const heard = live.map((d) => d.last_seen_at).filter(Boolean).map((t) => new Date(t).getTime());
  if (heard.length === 0) return { state: 'never_heard', last_heard_at: null };
  const latest = Math.max(...heard);
  return {
    state: now - latest < quiet * 60_000 ? 'working' : 'quiet',
    last_heard_at: new Date(latest).toISOString(),
  };
}

const laneLine = (lane) => ({ lane_id: lane.id, name: lane.name, direction: lane.direction });

/** The checklist for one garage, read on the caller's transaction. */
export async function checklist(client, tenantId, garage) {
  const now = (await client.query('SELECT now() AS now')).rows[0].now.getTime();
  const readout = await activation.readout(client, tenantId, garage);
  const lanes = await repo.lanesForGarage(client, tenantId, garage.id);
  const account = await recordedFacts(client, tenantId, garage.id);
  const met = Object.fromEntries(readout.conditions.map((c) => [c.condition, c.met]));
  const takesAnyDriver = garage.transient_available === true;

  const steps = [];
  steps.push({
    key: 'garage_details',
    done: Boolean(garage.name && garage.timezone && garage.currency),
    facts: { name: garage.name, timezone: garage.timezone, currency: garage.currency },
  });
  steps.push({
    key: 'drivers',
    done: met.transient_mode_stated,
    facts: { transient_available: garage.transient_available ?? null },
  });

  const entry = lanes.filter((l) => l.direction === 'entry');
  const exit = lanes.filter((l) => l.direction === 'exit');
  steps.push({
    key: 'lanes',
    done: entry.length > 0 && exit.length > 0,
    facts: {
      entry_lanes: entry.length,
      exit_lanes: exit.length,
      closed_lanes: lanes.filter((l) => l.closed !== null).map(laneLine),
    },
  });

  const quiet = quietMinutes();
  const computers = lanes.map((l) => ({ ...laneLine(l), ...laneComputer(l, now, quiet) }));
  steps.push({
    key: 'lane_computers',
    done: lanes.length > 0 && computers.every((c) => c.state === 'working'),
    facts: {
      quiet_minutes: quiet,
      lanes: lanes.length,
      working: computers.filter((c) => c.state === 'working').length,
      not_working: computers.filter((c) => c.state !== 'working'),
    },
  });

  steps.push({ key: 'rates', done: met.rate_setup_complete, facts: readout.facts.rate_plans });
  steps.push({ key: 'taxes', done: met.taxes_stated, facts: readout.facts.tax_sets });

  if (takesAnyDriver) {
    const row = account.row;
    steps.push({
      key: 'getting_paid',
      done: Boolean(row?.account_id && row.charges_enabled === true && row.card_payments === 'active'),
      facts: {
        can_be_set_up_here: account.configured,
        account: Boolean(row?.account_id),
        charges_enabled: row?.charges_enabled ?? null,
        card_payments: row?.card_payments ?? null,
        details_submitted: row?.details_submitted ?? null,
        read_at: row?.charges_enabled_read_at ?? null,
      },
    });
    const without = exit.filter((l) => l.reader === null);
    steps.push({
      key: 'card_readers',
      done: exit.length > 0 && without.length === 0,
      facts: { exit_lanes: exit.length, with_reader: exit.length - without.length, without_reader: without.map(laneLine) },
    });
  }

  const notDone = steps.filter((s) => !s.done).map((s) => s.key);
  steps.push({
    key: 'open',
    done: readout.active,
    facts: {
      open: readout.active,
      opened_at: readout.activated_at,
      // What the platform itself requires before the garage can open.
      required_missing: readout.conditions.filter((c) => !c.met).map((c) => GATE[c.condition]),
      // Every step above that is not done yet.
      not_done: notDone,
    },
  });

  return { garage_id: garage.id, open: readout.active, takes_any_driver: garage.transient_available ?? null, steps };
}
