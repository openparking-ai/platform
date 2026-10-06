/**
 * THE BOARD (U4c, amendment 1): what a lane's screen shows while no ticket or
 * fee is up and the lane is open -- the owner's messages, and the price where
 * the owner switches it on for a lane. Each write runs on the caller's
 * transaction and writes its change-log line there (src/changes.js), so the
 * change and its line commit together or not at all.
 *
 * A MESSAGE is text for the screen (the closed message's rule, src/lanes.js:
 * 1 to 160 characters, every one drawable once upper-cased), the lanes it
 * shows on -- at least one, every one a lane of this garage -- and an
 * optional start and end, written in the GARAGE'S time as `YYYY-MM-DDTHH:MM`
 * and kept as instants turned with the garage's timezone. The lane compares
 * the instants with its own clock, so a message goes up and comes down by
 * itself, with the network or without it.
 *
 * THE PRICE is never typed. The switch says a lane shows it; the lane works
 * it out with the engine and the taxes it charges with. Nothing here holds a
 * figure.
 *
 * At most `MESSAGES_MAX` messages a garage, so every one gets its turn on a
 * screen that shows them one at a time.
 */
import { HttpError } from './errors.js';
import * as changes from './changes.js';
import { screenTextField } from './lanes.js';

export const MESSAGES_MAX = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const bad = (message, code, details) => Object.assign(new HttpError(400, message, code), details ? { details } : {});

function onlyKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad(`the body is JSON: {${keys.join(', ')}}`);
  for (const key of Object.keys(body)) {
    if (!keys.includes(key)) throw bad(`unknown field ${JSON.stringify(key)}; the body is {${keys.join(', ')}}`);
  }
}

/** A garage-time moment, `YYYY-MM-DDTHH:MM`, or null for none. A real date and time, or refused by name. */
function localField(raw, field) {
  if (raw === null) return null;
  const m = typeof raw === 'string' ? LOCAL.exec(raw) : null;
  const [y, mo, d, h, mi] = m ? m.slice(1).map(Number) : [];
  const real = m && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && h <= 23 && mi <= 59;
  if (!real) throw bad(`${field} is a date and time in the garage's own time, as YYYY-MM-DDTHH:MM, or null for none`, 'board_time_refused');
  return raw;
}

/** The lanes a message shows on: one or more ids, no repeats. Which garage they are of is checked against the database. */
function lanesField(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((id) => typeof id !== 'string' || !UUID.test(id)) || new Set(raw).size !== raw.length) {
    throw bad('lanes is the list of lanes the message shows on: one or more lane ids of this garage, each once', 'board_lanes_refused');
  }
  return raw;
}

/** The message's lanes, all of this garage, or refused naming the ones that are not. */
async function checkLanes(client, tenantId, garageId, laneIds) {
  const { rows } = await client.query('SELECT id FROM lanes WHERE tenant_id = $1 AND garage_id = $2 AND id = ANY($3::uuid[])', [tenantId, garageId, laneIds]);
  const found = new Set(rows.map((r) => r.id));
  const unknown = laneIds.filter((id) => !found.has(id));
  if (unknown.length) throw bad('lanes names a lane that is not one of this garage', 'board_lanes_refused', { lanes: unknown });
}

/** A garage-time moment as an instant, with the garage's timezone. */
async function instant(client, local, timezone) {
  if (local === null) return null;
  const { rows } = await client.query('SELECT ($1::timestamp AT TIME ZONE $2) AS at', [local, timezone]);
  return rows[0].at;
}

/** A message as the owner's screens read it: its lanes, and its times both as instants and in the garage's time. */
const SELECT = `
  SELECT m.id, m.text, m.starts_at, m.ends_at, m.created_at,
         to_char(m.starts_at AT TIME ZONE g.timezone, 'YYYY-MM-DD"T"HH24:MI') AS starts,
         to_char(m.ends_at AT TIME ZONE g.timezone, 'YYYY-MM-DD"T"HH24:MI') AS ends,
         COALESCE((SELECT array_agg(ml.lane_id ORDER BY l.created_at, l.id)
                     FROM board_message_lanes ml JOIN lanes l ON l.id = ml.lane_id AND l.tenant_id = ml.tenant_id
                    WHERE ml.tenant_id = m.tenant_id AND ml.message_id = m.id), '{}') AS lanes,
         COALESCE((SELECT array_agg(l.name ORDER BY l.created_at, l.id)
                     FROM board_message_lanes ml JOIN lanes l ON l.id = ml.lane_id AND l.tenant_id = ml.tenant_id
                    WHERE ml.tenant_id = m.tenant_id AND ml.message_id = m.id), '{}') AS lane_names
    FROM board_messages m JOIN garages g ON g.id = m.garage_id AND g.tenant_id = m.tenant_id`;

const present = (r) => ({ id: r.id, text: r.text, lanes: r.lanes, starts: r.starts, ends: r.ends, starts_at: r.starts_at, ends_at: r.ends_at, created_at: r.created_at });

/**
 * What a line keeps of a message: what the screen shows, on which lanes --
 * by name, as the owner reads them -- and when, in the garage's own time.
 */
const lineOf = (r) => ({ text: r.text, lanes: r.lane_names, starts: r.starts, ends: r.ends });

async function messageRow(client, tenantId, garageId, messageId, lock = false) {
  if (lock) await client.query('SELECT 1 FROM board_messages WHERE tenant_id = $1 AND garage_id = $2 AND id = $3 FOR UPDATE', [tenantId, garageId, messageId]);
  const { rows } = await client.query(`${SELECT} WHERE m.tenant_id = $1 AND m.garage_id = $2 AND m.id = $3`, [tenantId, garageId, messageId]);
  if (!rows[0]) throw new HttpError(404, 'board message not found', 'board_message_not_found');
  return rows[0];
}

/** The garage's board: its messages, oldest first, and each lane's price switch. A read. */
export async function read(client, tenantId, garage) {
  const { rows } = await client.query(`${SELECT} WHERE m.tenant_id = $1 AND m.garage_id = $2 ORDER BY m.created_at, m.id`, [tenantId, garage.id]);
  const lanes = (await client.query(
    'SELECT id, name, direction, board_prices FROM lanes WHERE tenant_id = $1 AND garage_id = $2 ORDER BY created_at, id', [tenantId, garage.id],
  )).rows.map((l) => ({ id: l.id, name: l.name, direction: l.direction, prices: l.board_prices }));
  return { timezone: garage.timezone, messages_max: MESSAGES_MAX, messages: rows.map(present), lanes };
}

/** The times, in order: an end that is not after the start, or is already past, is refused by name. */
async function checkTimes(client, startsAt, endsAt) {
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) throw bad('ends is after starts', 'board_time_refused');
  if (endsAt !== null) {
    const { rows } = await client.query('SELECT $1::timestamptz <= clock_timestamp() AS past', [endsAt]);
    if (rows[0].past) throw bad('ends has already passed: a message that ended would never be shown', 'board_time_refused');
  }
}

export async function add(client, tenantId, garage, body, ctx) {
  onlyKeys(body, ['text', 'lanes', 'starts', 'ends']);
  const text = screenTextField(body.text, { field: 'text', code: 'board_text_refused' });
  const laneIds = lanesField(body.lanes);
  const starts = localField(body.starts ?? null, 'starts');
  const ends = localField(body.ends ?? null, 'ends');
  // One garage's adds one at a time, so two at once cannot both be the last allowed.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`board-messages|${garage.id}`]);
  const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM board_messages WHERE tenant_id = $1 AND garage_id = $2', [tenantId, garage.id]);
  if (n >= MESSAGES_MAX) {
    throw Object.assign(new HttpError(409, `a garage has at most ${MESSAGES_MAX} board messages: remove one first`, 'board_messages_full'), { details: { max: MESSAGES_MAX } });
  }
  await checkLanes(client, tenantId, garage.id, laneIds);
  const startsAt = await instant(client, starts, garage.timezone);
  const endsAt = await instant(client, ends, garage.timezone);
  await checkTimes(client, startsAt, endsAt);
  const { rows } = await client.query(
    'INSERT INTO board_messages (tenant_id, garage_id, text, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [tenantId, garage.id, text, startsAt, endsAt],
  );
  const id = rows[0].id;
  for (const laneId of laneIds) {
    await client.query('INSERT INTO board_message_lanes (tenant_id, message_id, lane_id) VALUES ($1,$2,$3)', [tenantId, id, laneId]);
  }
  const row = await messageRow(client, tenantId, garage.id, id);
  await changes.record(client, ctx, {
    garageId: garage.id, action: 'board_message.add', subject: { kind: 'board_message', id, name: text },
    before: null, after: lineOf(row),
  });
  return { message: present(row) };
}

export async function change(client, tenantId, garage, messageId, body, ctx) {
  onlyKeys(body, ['text', 'lanes', 'starts', 'ends']);
  if (Object.keys(body).length === 0) throw bad('send at least one of text, lanes, starts, ends', 'board_message_refused');
  const row = await messageRow(client, tenantId, garage.id, messageId, true);
  const text = body.text === undefined ? row.text : screenTextField(body.text, { field: 'text', code: 'board_text_refused' });
  const laneIds = body.lanes === undefined ? row.lanes : lanesField(body.lanes);
  const starts = body.starts === undefined ? row.starts : localField(body.starts, 'starts');
  const ends = body.ends === undefined ? row.ends : localField(body.ends, 'ends');
  if (body.lanes !== undefined) await checkLanes(client, tenantId, garage.id, laneIds);
  const startsAt = body.starts === undefined ? row.starts_at : await instant(client, starts, garage.timezone);
  const endsAt = body.ends === undefined ? row.ends_at : await instant(client, ends, garage.timezone);
  if (body.starts !== undefined || body.ends !== undefined) await checkTimes(client, startsAt, endsAt);
  await client.query('UPDATE board_messages SET text = $3, starts_at = $4, ends_at = $5 WHERE tenant_id = $1 AND id = $2', [tenantId, messageId, text, startsAt, endsAt]);
  if (body.lanes !== undefined) {
    await client.query('DELETE FROM board_message_lanes WHERE tenant_id = $1 AND message_id = $2 AND NOT (lane_id = ANY($3::uuid[]))', [tenantId, messageId, laneIds]);
    for (const laneId of laneIds) {
      await client.query(
        'INSERT INTO board_message_lanes (tenant_id, message_id, lane_id) VALUES ($1,$2,$3) ON CONFLICT (message_id, lane_id) DO NOTHING',
        [tenantId, messageId, laneId],
      );
    }
  }
  const now = await messageRow(client, tenantId, garage.id, messageId);
  await changes.record(client, ctx, {
    garageId: garage.id, action: 'board_message.change', subject: { kind: 'board_message', id: messageId, name: now.text },
    before: lineOf(row), after: lineOf(now),
  });
  return { message: present(now) };
}

export async function remove(client, tenantId, garage, messageId, ctx) {
  const row = await messageRow(client, tenantId, garage.id, messageId, true);
  await client.query('DELETE FROM board_messages WHERE tenant_id = $1 AND id = $2', [tenantId, messageId]);
  await changes.record(client, ctx, {
    garageId: garage.id, action: 'board_message.remove', subject: { kind: 'board_message', id: messageId, name: row.text },
    before: lineOf(row), after: null,
  });
}

/** The owner's switch: this lane shows the price, or does not. Body: {show: true | false}. */
export async function setPrices(client, tenantId, laneId, body, ctx) {
  onlyKeys(body, ['show']);
  if (typeof body.show !== 'boolean') throw bad('show is true (this lane shows the price) or false', 'board_prices_refused');
  const { rows } = await client.query('SELECT id, garage_id, name, board_prices FROM lanes WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, laneId]);
  const lane = rows[0];
  if (!lane) throw new HttpError(404, 'lane not found', 'lane_not_found');
  await client.query('UPDATE lanes SET board_prices = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, laneId, body.show]);
  await changes.record(client, ctx, {
    garageId: lane.garage_id, action: 'lane.board_prices', subject: { kind: 'lane', id: lane.id, name: lane.name },
    before: { prices: lane.board_prices }, after: { prices: body.show },
  });
  return { lane: { id: lane.id, prices: body.show } };
}

/**
 * What a lane's payload carries about its board, on the slow read and the
 * fast one alike: its price switch, and the messages FOR THIS LANE that have
 * not ended, oldest first, with their instants. The lane decides what is in
 * force now by its own clock, so a message that has not started yet is sent
 * ahead and goes up on time with the network down.
 */
export async function forLane(client, tenantId, laneId) {
  const lane = (await client.query('SELECT board_prices FROM lanes WHERE tenant_id = $1 AND id = $2', [tenantId, laneId])).rows[0];
  const { rows } = await client.query(
    `SELECT m.id, m.text, m.starts_at, m.ends_at
       FROM board_messages m JOIN board_message_lanes ml ON ml.message_id = m.id AND ml.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1 AND ml.lane_id = $2 AND (m.ends_at IS NULL OR m.ends_at > clock_timestamp())
      ORDER BY m.created_at, m.id`,
    [tenantId, laneId],
  );
  return {
    prices: lane?.board_prices === true,
    messages: rows.map((m) => ({
      id: m.id, text: m.text,
      starts_at: m.starts_at === null ? null : m.starts_at.toISOString(),
      ends_at: m.ends_at === null ? null : m.ends_at.toISOString(),
    })),
  };
}
