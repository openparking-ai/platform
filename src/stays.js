/**
 * A stay's life when no exit closes it, and an exit that comes before its
 * entry (0035).
 *
 * ENDED. A stay is ended by the platform, unpriced, with its reason:
 *
 *   superseded  the same car came in again, further apart than one arrival,
 *               while the stay was still open (src/repository.js
 *               `openSession`) -- or the stay is an earlier visit whose open
 *               arrived after a later stay of the car. It had left by then, so
 *               its `exit_at` is that later entry. Nothing is billed for it.
 *   abandoned   an operator ended an open stay nothing closed, from the
 *               command line (scripts/abandon-stays.js), at the moment they
 *               did. That moment is no sign the car left -- it may still be
 *               inside -- so the stay's time inside runs on to the car's next
 *               entry here (src/repository.js `endedStayAt`).
 *
 * Either end takes the stay out of the count of cars inside from its
 * `exit_at` (src/repository.js `insideAt`). Nothing else does but an exit: a
 * stay nothing ends or closes is a car inside, however long ago it came in.
 *
 * Each end is written three times: on the stay (`ended`), as an event beside
 * it, and as a line in the garage's change log, by the platform. A late close
 * whose exit falls inside an ended stay still closes and prices it
 * (src/app.js `stayForExit`), and the event says so: for an abandoned stay,
 * that includes an exit after the moment it was abandoned.
 *
 * PENDING EXITS. A close that finds no stay to close is kept as it was sent
 * and answered 202, never refused: the lane drops a refusal, and the exit
 * would be lost with the record of the fee. An open whose entry comes before
 * it, and before the car's next stay, has it delivered again through the
 * close route, and the stay closes and prices itself from it.
 */
import { withTenant } from './db.js';
import * as repo from './repository.js';
import * as changes from './changes.js';
import { finishRelease } from './validations.js';

/** The event beside a stay the platform ended. */
export const STAY_ENDED_EVENT_KIND = 'stay_ended';
/** The event beside an ended stay a late exit closed after all. */
export const ENDED_STAY_CLOSED_EVENT_KIND = 'ended_stay_closed';
/** The event beside an exit taken at its stay's entry, the two lanes' clocks apart. */
export const EXIT_BEFORE_ENTRY_EVENT_KIND = 'exit_before_entry';

/**
 * The event and the change-log line for a stay just ended, on `client`, in
 * the transaction that ended it. `laneId` is the lane whose read ended it, or
 * null. The line names the stay by its id and no vehicle.
 */
export async function recordEnded(client, tenantId, stay, { laneId = null } = {}) {
  const { reason } = stay.ended;
  await repo.appendEvents(client, tenantId, [
    {
      garageId: stay.garage_id,
      laneId,
      eventId: `stay_ended:${stay.id}`,
      kind: STAY_ENDED_EVENT_KIND,
      occurredAt: stay.exit_at,
      detail: {
        actor: reason === 'superseded' ? 'platform:open' : 'platform:command_line',
        session_id: stay.id,
        reason,
        entry_at: stay.entry_at,
        exit_at: stay.exit_at,
        ...(stay.ended.by_session ? { by_session: stay.ended.by_session } : {}),
      },
    },
  ]);
  await changes.record(client, changes.platformContext(tenantId), {
    garageId: stay.garage_id,
    action: reason === 'superseded' ? 'stay.supersede' : 'stay.abandon',
    subject: { kind: 'stay', id: stay.id, name: null },
    before: { state: 'open', entry_at: stay.entry_at },
    after: { state: reason, exit_at: stay.exit_at },
  });
}

/** A validation claim the end handed to the release, given back now that it committed. */
export async function releaseAfterEnd(tenantId, stays) {
  for (const stay of stays) {
    if (stay.validation?.state !== 'releasing') continue;
    try {
      await finishRelease(tenantId, stay.id);
    } catch (err) {
      console.error(`validation release after ending ${stay.id} failed: ${err.message ?? err}`);
    }
  }
}

/** A kept exit as the lane is told it: what was kept, and nothing of who. */
export function presentPendingExit(p) {
  return {
    close_event_id: p.close_event_id,
    exit_at: p.exit_at,
    exit_confirmation: p.exit_confirmation,
    exit_descriptor: p.exit_descriptor,
    kept_at: p.created_at,
  };
}

/**
 * The open stays of a garage that came in more than `olderThanHours` before
 * `now`: what `abandonStays` would end. Ids and times only.
 */
async function abandonable(client, tenantId, garageId, { olderThanHours, sessionIds, now }) {
  const { rows } = await client.query(
    `SELECT id, garage_id, entry_at FROM sessions
      WHERE tenant_id = $1 AND garage_id = $2 AND exit_at IS NULL
        AND entry_at < $3::timestamptz - make_interval(hours => $4)
        AND ($5::uuid[] IS NULL OR id = ANY($5::uuid[]))
      ORDER BY entry_at, id
      FOR UPDATE`,
    [tenantId, garageId, now, olderThanHours, sessionIds],
  );
  return rows;
}

/**
 * END THE OPEN STAYS NOTHING CLOSED (the operator's command line): every open
 * stay of the garage that came in more than `olderThanHours` before `now`,
 * or only those of `sessionIds` among them. Without `apply`, nothing is
 * changed and the list is what would be. Each ended stay gets its event and
 * its change-log line in the same transaction.
 */
export async function abandonStays(tenantId, garageId, { olderThanHours, sessionIds = null, apply = false, now = new Date() }) {
  if (!Number.isFinite(olderThanHours) || olderThanHours <= 0) {
    throw new Error('olderThanHours must be a positive number of hours');
  }
  const out = await withTenant(tenantId, async (client) => {
    const garage = await repo.getGarage(client, tenantId, garageId);
    if (!garage) throw new Error(`no garage ${garageId} in this account`);
    const found = await abandonable(client, tenantId, garageId, { olderThanHours, sessionIds, now });
    if (!apply) return { found, ended: [] };
    const ended = [];
    for (const row of found) {
      const stay = await repo.endStay(client, tenantId, row.id, { reason: 'abandoned', exitAt: now, record: { by: 'command_line' } });
      if (!stay) continue;
      await recordEnded(client, tenantId, stay);
      ended.push(stay);
    }
    return { found, ended };
  });
  await releaseAfterEnd(tenantId, out.ended);
  return out;
}
