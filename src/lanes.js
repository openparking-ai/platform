/**
 * LANE SETUP (U4): rename a lane, remove one that was never used, close one
 * and open it again. Each runs on the caller's transaction and writes its
 * change-log line there (src/changes.js), so the change and its line commit
 * together or not at all.
 *
 * CLOSING (0026). A lane is closed by hand, with a reason -- `full` (pass and
 * monthly holders still get in) or `everyone` -- and the owner's own message
 * for the lane to show. Closing the last open lane of a direction would leave
 * no way in, or no way out: it is refused by name unless the request says it
 * is a deliberate override. The lane itself does not act on a closing yet;
 * `/lane/rules` carries it for the lane's own round.
 *
 * REMOVING. Only a lane that never had a stay, a computer, a card reader or a
 * recorded event can be removed: anything else is history, and the refusal
 * says which.
 */
import { HttpError } from './errors.js';
import * as changes from './changes.js';

export const CLOSE_REASONS = Object.freeze(['full', 'everyone']);
export const NAME_MAX = 80;
export const MESSAGE_MAX = 160;

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const bad = (message, code) => new HttpError(400, message, code);
const conflict = (code, message, details) => Object.assign(new HttpError(409, message, code), details ? { details } : {});

/** A lane's name, or a refusal saying what a name must be. */
export function nameField(raw) {
  if (typeof raw !== 'string') throw bad(`name must be text of 1 to ${NAME_MAX} characters`, 'lane_name_refused');
  const name = raw.trim();
  if (name === '' || name.length > NAME_MAX || CONTROL.test(name)) {
    throw bad(`name must be text of 1 to ${NAME_MAX} characters, with no control or invisible formatting characters`, 'lane_name_refused');
  }
  return name;
}

function messageField(raw) {
  if (typeof raw !== 'string') throw bad(`message must be text of 1 to ${MESSAGE_MAX} characters`, 'lane_message_refused');
  const message = raw.trim();
  if (message === '' || message.length > MESSAGE_MAX || CONTROL.test(message)) {
    throw bad(`message must be text of 1 to ${MESSAGE_MAX} characters, with no control or invisible formatting characters`, 'lane_message_refused');
  }
  return message;
}

function onlyKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad(`the body is JSON: {${keys.join(', ')}}`);
  for (const key of Object.keys(body)) {
    if (!keys.includes(key)) throw bad(`unknown field ${JSON.stringify(key)}; the body is {${keys.join(', ')}}`);
  }
}

/** The lane, locked, or a 404. Another account's lane is not found: row-level security makes it so. */
async function lockedLane(client, tenantId, laneId) {
  const { rows } = await client.query(
    `SELECT id, garage_id, name, direction, closed_reason, closed_message, closed_at
       FROM lanes WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, laneId],
  );
  if (!rows[0]) throw new HttpError(404, 'lane not found', 'lane_not_found');
  return rows[0];
}

const subjectOf = (lane, name = lane.name) => ({ kind: 'lane', id: lane.id, name });
const stateOf = (lane) =>
  lane.closed_reason === null ? { state: 'open' } : { state: 'closed', reason: lane.closed_reason, message: lane.closed_message };

/** Who did it, as the lane keeps it: `owner:<email>` or `key:<name>`. */
async function whoLabel(client, ctx) {
  const actor = await changes.who(client, ctx);
  return `${actor.kind}:${actor.name ?? ''}`.slice(0, 300);
}

export async function rename(client, tenantId, laneId, body, ctx) {
  onlyKeys(body, ['name']);
  const name = nameField(body.name);
  const lane = await lockedLane(client, tenantId, laneId);
  await client.query('UPDATE lanes SET name = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, laneId, name]);
  await changes.record(client, ctx, {
    garageId: lane.garage_id, action: 'lane.rename', subject: subjectOf(lane, name),
    before: { name: lane.name }, after: { name },
  });
  return { ...lane, name };
}

/** What a lane has had: anything here is history, and the lane stays. */
async function historyOf(client, tenantId, laneId) {
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM sessions WHERE tenant_id = $1 AND (entry_lane_id = $2 OR exit_lane_id = $2))::int AS stays,
            (SELECT count(*) FROM lane_devices WHERE tenant_id = $1 AND lane_id = $2)::int AS computers,
            (SELECT count(*) FROM lane_readers WHERE tenant_id = $1 AND lane_id = $2)::int AS card_readers,
            (SELECT count(*) FROM events WHERE tenant_id = $1 AND lane_id = $2)::int AS events`,
    [tenantId, laneId],
  );
  return rows[0];
}

export async function remove(client, tenantId, laneId, ctx) {
  const lane = await lockedLane(client, tenantId, laneId);
  const had = await historyOf(client, tenantId, laneId);
  const kept = Object.entries(had).filter(([, n]) => n > 0);
  if (kept.length > 0) {
    throw conflict(
      'lane_has_history',
      `this lane cannot be removed: it has ${kept.map(([what, n]) => `${n} ${what.replace('_', ' ')}`).join(', ')} on record, ` +
        'and removing it would lose that history. Rename it or close it instead.',
      had,
    );
  }
  await client.query('DELETE FROM lanes WHERE tenant_id = $1 AND id = $2', [tenantId, laneId]);
  await changes.record(client, ctx, {
    garageId: lane.garage_id, action: 'lane.remove', subject: subjectOf(lane),
    before: { name: lane.name, direction: lane.direction }, after: null,
  });
  return lane;
}

export async function close(client, tenantId, laneId, body, ctx) {
  onlyKeys(body, ['reason', 'message', 'override']);
  if (!CLOSE_REASONS.includes(body.reason)) {
    throw bad(`reason must be one of ${CLOSE_REASONS.join(', ')}: full lets pass and monthly holders in; everyone closes it to all`, 'lane_reason_refused');
  }
  const message = messageField(body.message);
  if (body.override !== undefined && body.override !== true) throw bad('override, when sent, is true', 'lane_override_refused');
  const lane = await lockedLane(client, tenantId, laneId);
  // Every lane of the garage, locked in one order, so two closings at once
  // cannot each see the other lane still open.
  const { rows: lanes } = await client.query(
    `SELECT id, direction, closed_reason FROM lanes WHERE tenant_id = $1 AND garage_id = $2 ORDER BY id FOR UPDATE`,
    [tenantId, lane.garage_id],
  );
  const openOthers = lanes.filter((l) => l.id !== lane.id && l.direction === lane.direction && l.closed_reason === null);
  if (lane.closed_reason === null && openOthers.length === 0 && body.override !== true) {
    throw conflict(
      'last_open_lane',
      `this is the last open ${lane.direction === 'entry' ? 'way in' : 'way out'} of the garage: closing it leaves ` +
        `no ${lane.direction === 'entry' ? 'way in' : 'way out'} open. Send override: true to close it anyway.`,
      { direction: lane.direction },
    );
  }
  const by = await whoLabel(client, ctx);
  const { rows } = await client.query(
    `UPDATE lanes SET closed_reason = $3, closed_message = $4, closed_by = $5, closed_at = clock_timestamp()
      WHERE tenant_id = $1 AND id = $2
      RETURNING closed_reason, closed_message, closed_at`,
    [tenantId, laneId, body.reason, message, by],
  );
  await changes.record(client, ctx, {
    garageId: lane.garage_id,
    action: lane.closed_reason === null ? 'lane.close' : 'lane.close_again',
    subject: subjectOf(lane),
    before: stateOf(lane),
    after: { state: 'closed', reason: body.reason, message, ...(body.override === true ? { last_open_overridden: true } : {}) },
  });
  return rows[0];
}

export async function reopen(client, tenantId, laneId, body, ctx) {
  onlyKeys(body ?? {}, []);
  const lane = await lockedLane(client, tenantId, laneId);
  if (lane.closed_reason === null) throw conflict('lane_already_open', 'this lane is already open');
  const by = await whoLabel(client, ctx);
  const { rows } = await client.query(
    `UPDATE lanes SET closed_reason = NULL, closed_message = NULL, closed_by = NULL, closed_at = NULL,
                      reopened_by = $3, reopened_at = clock_timestamp()
      WHERE tenant_id = $1 AND id = $2
      RETURNING reopened_at`,
    [tenantId, laneId, by],
  );
  await changes.record(client, ctx, {
    garageId: lane.garage_id, action: 'lane.reopen', subject: subjectOf(lane),
    before: stateOf(lane), after: { state: 'open' },
  });
  return rows[0];
}

/** What `/lane/rules` carries about the asking lane: open, or closed with its reason and message. */
export async function laneState(client, tenantId, laneId) {
  const { rows } = await client.query(
    'SELECT closed_reason, closed_message, closed_at FROM lanes WHERE tenant_id = $1 AND id = $2',
    [tenantId, laneId],
  );
  const l = rows[0];
  if (!l || l.closed_reason === null) return { state: 'open', reason: null, message: null, closed_at: null };
  return { state: 'closed', reason: l.closed_reason, message: l.closed_message, closed_at: l.closed_at };
}
