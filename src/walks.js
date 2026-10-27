import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import * as exitMatch from './exitMatch.js';

/**
 * THE INVENTORY WALK (0040): a person photographs the cars parked in a garage,
 * or types their plates, and the walk finishes into four lists, frozen.
 *
 * A picture is read by the deployment's vehicle-id (`POST /v1/reads`), whose
 * one plate reader is fast-alpr, and is not kept: the walk keeps what was read.
 * The plate's positioned characters (`opvid-plate-chars/1`) are what a
 * sighting is matched on, by the exit's own matching (src/exitMatch.js),
 * against the garage's stays open at some point during the walk. A phone's
 * picture is not the lane's camera, so its colour and size never exclude a
 * stay and its "unreadable" is never matched against a lane's.
 *
 * Settings, read at each picture, so a deployment can set them without a
 * restart:
 *   VEHICLE_ID_URL         the vehicle-id service, http(s), no credentials in it;
 *                          unset: a picture is kept as `none`, `reader_off`.
 *   VEHICLE_ID_TOKEN_FILE  absolute path of the file holding its bearer token;
 *                          unset: no token is sent (vehicle-id on loopback).
 *   VEHICLE_ID_TIMEOUT_MS  how long a read may take, 1000 to 30000 (8000).
 */

export const READS = Object.freeze(['agreed', 'unsure', 'none', 'typed']);
export const LISTS = Object.freeze(['seen_with_stay', 'seen_without_stay', 'stay_not_seen', 'not_readable']);
/** Open walks a garage may have at once. */
export const WALK_OPEN_MAX = 10;
/** The most sightings one walk takes. */
export const SIGHTINGS_MAX = 5000;
export const CLIENT_REF_MAX = 100;
/** A plate as a person gives it: letters and digits, once spaces and dashes are out. */
export const PLATE_MAX = 10;
export const DEFAULT_READ_TIMEOUT_MS = 8000;
export const READER = 'fast-alpr';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message, code) => new HttpError(400, message, code);

/** The deployment's vehicle-id, or `{on: false}`. Throws on a setting that is set wrong. */
export function readerSettings(env = process.env) {
  const set = (name) => typeof env[name] === 'string' && env[name].trim() !== '';
  if (!set('VEHICLE_ID_URL')) return { on: false };
  let url;
  try {
    url = new URL(env.VEHICLE_ID_URL);
  } catch {
    url = null;
  }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('VEHICLE_ID_URL must be an http(s) URL with no credentials in it');
  }
  let tokenFile = null;
  if (set('VEHICLE_ID_TOKEN_FILE')) {
    if (!isAbsolute(env.VEHICLE_ID_TOKEN_FILE)) {
      throw new Error('VEHICLE_ID_TOKEN_FILE must be an absolute path to the file holding the token');
    }
    tokenFile = env.VEHICLE_ID_TOKEN_FILE;
  }
  let timeoutMs = DEFAULT_READ_TIMEOUT_MS;
  if (set('VEHICLE_ID_TIMEOUT_MS')) {
    timeoutMs = Number(env.VEHICLE_ID_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
      throw new Error('VEHICLE_ID_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 30000');
    }
  }
  return { on: true, url: new URL('v1/reads', url.href.endsWith('/') ? url.href : `${url.href}/`).href, tokenFile, timeoutMs };
}

/** A plate a person gave: letters and digits, upper case, 1 to PLATE_MAX. */
export function cleanPlate(raw) {
  if (typeof raw !== 'string') throw bad('plate must be text', 'plate_invalid');
  const plate = raw.toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[0-9A-Z]+$/.test(plate) || plate.length > PLATE_MAX) {
    throw bad(`plate must be letters and digits, 1 to ${PLATE_MAX} once spaces and dashes are out`, 'plate_invalid');
  }
  return plate;
}

/** The sighting's body as the phone sends it, checked. `picture` is still base64. */
export function sightingRequest(body) {
  const picture = body?.picture ?? null;
  const rawPlate = body?.plate ?? null;
  if (picture === null && rawPlate === null) throw bad('a sighting needs a picture or a plate', 'sighting_empty');
  if (picture !== null && (typeof picture !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(picture))) {
    throw bad('picture must be base64', 'picture_invalid');
  }
  const plate = rawPlate === null ? null : cleanPlate(rawPlate);
  if (plate !== null && body?.confirmed !== true) {
    throw bad('a plate is one the person typed or confirmed: send it with confirmed: true', 'plate_not_confirmed');
  }
  const clientRef = body?.client_ref ?? null;
  if (clientRef !== null && (typeof clientRef !== 'string' || clientRef.length === 0 || clientRef.length > CLIENT_REF_MAX)) {
    throw bad(`client_ref must be text of at most ${CLIENT_REF_MAX} characters`, 'client_ref_invalid');
  }
  const confirms = body?.confirms ?? null;
  if (confirms !== null && (typeof confirms !== 'string' || !UUID.test(confirms))) {
    throw bad('confirms must be the id of a sighting', 'confirms_invalid');
  }
  return { picture, plate, clientRef, confirms, takenAt: body?.taken_at ?? null };
}

/**
 * Ask vehicle-id to read one picture. `{ok: true, identity, confidence}`,
 * `{ok: false, refused: true}` when it says the picture is not one it can
 * open (4xx), or `{ok: false}` when it did not answer.
 */
export async function readPicture(settings, image, takenAt) {
  const headers = { 'content-type': 'application/json' };
  if (settings.tokenFile) {
    let token;
    try {
      token = readFileSync(settings.tokenFile, 'utf8').trim();
    } catch {
      return { ok: false };
    }
    if (!token) return { ok: false };
    headers.authorization = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(settings.url, {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify({
        request_id: randomUUID().replaceAll('-', ''),
        camera_id: 'inventory-walk',
        captures: [{ image_b64: image.toString('base64'), captured_at: takenAt.toISOString() }],
      }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch {
    return { ok: false };
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429) {
    return { ok: false, refused: true };
  }
  if (!res.ok) return { ok: false };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false };
  }
  const read = body?.read;
  if (!read || typeof read !== 'object' || !read.identity || typeof read.identity !== 'object') return { ok: false };
  return { ok: true, identity: read.identity, confidence: typeof read.confidence === 'number' ? read.confidence : null };
}

const PATTERN = /^[0-9A-Z?]{1,32}$/;

/**
 * What a picture's read becomes, in the app's shape: every character sure is
 * the whole plate (`agreed`), some sure is the pattern to confirm (`unsure`),
 * nothing sure or nothing read is `none`. A read whose characters are not in
 * the rule's shape says nothing sure.
 */
export function fromRead({ identity, confidence }) {
  const chars = identity.plate_characters;
  const shaped = chars && typeof chars === 'object' && typeof chars.rule === 'string' && chars.rule.length <= 64;
  if (shaped && chars.state === 'read' && typeof chars.pattern === 'string' && PATTERN.test(chars.pattern)
      && /[0-9A-Z]/.test(chars.pattern)) {
    const whole = !chars.pattern.includes('?');
    const plate = whole && typeof identity.plate === 'string' && identity.plate.length <= 32 ? identity.plate : chars.pattern;
    return {
      read: whole ? 'agreed' : 'unsure',
      why: null,
      plate,
      characters: { state: 'read', rule: chars.rule, pattern: chars.pattern },
      readers: [{ reader: READER, plate, confidence }],
    };
  }
  const state = shaped && chars.state === 'not_seen' ? 'not_seen' : 'unreadable';
  return {
    read: 'none',
    why: state,
    plate: null,
    characters: { state, rule: shaped ? chars.rule : null, pattern: null },
    readers: [{ reader: READER, plate: null, confidence }],
  };
}

/** A plate the person gave: every position sure, folded as the rule folds. */
export function fromTyped(plate) {
  return {
    read: 'typed',
    why: null,
    plate,
    characters: { state: 'read', rule: exitMatch.PLATE_RULE, pattern: exitMatch.fold(plate) },
    readers: [],
  };
}

/** The sighting's plate ID as the exit's matching takes it, or null: only a plate with sure characters is matched. */
export function sightingPlateId(s) {
  if (s.plate_state !== 'read' || !s.plate_pattern) return null;
  return { plate: { state: 'read', rule: s.plate_rule, pattern: s.plate_pattern }, colour_code: null, size: null };
}

/** What one sighting fits among `stays`: `{stay}` alone, `{candidates}` several, or `{}` none. */
export function fit(sighting, stays) {
  const id = sightingPlateId(sighting);
  if (!id) return {};
  // Only the plate decides on a walk: a stay is in the running when at least
  // one sure character agrees in its position, never for saying nothing.
  const agreeing = stays.filter((stay) => {
    const scored = exitMatch.score(id, stay);
    return !scored.excluded && scored.agree > 0;
  });
  const answer = exitMatch.match(id, agreeing);
  if (answer.kind === 'single') return { stay: answer.stay };
  if (answer.kind === 'few') return { candidates: answer.candidates };
  return {};
}

/** A stay as a person reads it in a list: its plate, or the sure characters its entry read, or nothing. */
function stayPlate(stay) {
  return stay.plate ?? stay.entry_plate_pattern ?? null;
}

/**
 * THE FOUR LISTS, worked out once, at the finish. `sightings` in the order
 * they were added; `stays` the garage's stays open at some point during the
 * walk, each with `exit_at`. Pure: the caller stores what it answers.
 */
export function lists(walk, sightings, stays) {
  const answered = new Set(sightings.filter((s) => s.confirms).map((s) => s.confirms));
  const standing = sightings.filter((s) => !answered.has(s.id));
  const byId = new Map(stays.map((s) => [s.id, s]));
  const seen = new Map();
  const without = [];
  const notReadable = [];
  for (const s of standing) {
    if (s.read === 'none') {
      notReadable.push({ sighting: s.id, plate: null, why: s.why });
      continue;
    }
    const found = fit(s, stays);
    let stay = found.stay ?? null;
    if (!stay && found.candidates && s.picked_stay && found.candidates.includes(s.picked_stay)) stay = s.picked_stay;
    if (stay) {
      const row = seen.get(stay) ?? { stay, plate: stayPlate(byId.get(stay)), entered_at: byId.get(stay).entry_at, sightings: [] };
      row.sightings.push(s.id);
      seen.set(stay, row);
    } else {
      without.push({ sighting: s.id, plate: s.plate, candidates: found.candidates ?? [] });
    }
  }
  const startedAt = new Date(walk.started_at);
  const notSeen = stays
    .filter((s) => s.exit_at === null && new Date(s.entry_at) <= startedAt && !seen.has(s.id))
    .sort((a, b) => new Date(a.entry_at) - new Date(b.entry_at))
    .map((s) => ({ stay: s.id, plate: stayPlate(s), entered_at: s.entry_at }));
  return {
    seen_with_stay: [...seen.values()],
    seen_without_stay: without,
    stay_not_seen: notSeen,
    not_readable: notReadable,
  };
}

/** The garage's stays open at some point since `since`: still open, or closed after it. */
export async function staysDuring(client, tenantId, garageId, since) {
  const { rows } = await client.query(
    `SELECT s.id, s.entry_at, s.exit_at, s.entry_plate_state, s.entry_plate_rule, s.entry_plate_pattern, v.plate,
            CASE WHEN v.ticket_ref IS NOT NULL THEN 'ticket' WHEN v.unread_ref IS NOT NULL THEN 'unread' ELSE 'plate' END AS identity_kind
       FROM sessions s
       JOIN vehicles v ON v.id = s.vehicle_id AND v.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND (s.exit_at IS NULL OR s.exit_at >= $3)
      ORDER BY s.entry_at DESC, s.id`,
    [tenantId, garageId, since],
  );
  return rows;
}

const SIGHTING_COLUMNS = `id, walk_id, client_ref, read, why, plate, plate_state, plate_rule, plate_pattern, readers,
  candidates, picked_stay, confirms, taken_at, added_at, added_by`;

export async function getWalk(client, tenantId, garageId, walkId, { lock = false } = {}) {
  if (!UUID.test(walkId)) return null;
  const { rows } = await client.query(
    `SELECT * FROM walks WHERE tenant_id = $1 AND garage_id = $2 AND id = $3${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, garageId, walkId],
  );
  return rows[0] ?? null;
}

export async function openWalks(client, tenantId, garageId) {
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM walks WHERE tenant_id = $1 AND garage_id = $2 AND finished_at IS NULL',
    [tenantId, garageId],
  );
  return rows[0].n;
}

export async function startWalk(client, tenantId, garageId, by) {
  const { rows } = await client.query(
    'INSERT INTO walks (tenant_id, garage_id, started_by) VALUES ($1, $2, $3) RETURNING *',
    [tenantId, garageId, by],
  );
  return rows[0];
}

export async function sightingsOf(client, tenantId, walkId) {
  const { rows } = await client.query(
    `SELECT ${SIGHTING_COLUMNS} FROM walk_sightings WHERE tenant_id = $1 AND walk_id = $2 ORDER BY added_at, id`,
    [tenantId, walkId],
  );
  return rows;
}

export async function sightingCount(client, tenantId, walkId) {
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM walk_sightings WHERE tenant_id = $1 AND walk_id = $2',
    [tenantId, walkId],
  );
  return rows[0].n;
}

export async function sightingByRef(client, tenantId, walkId, clientRef) {
  const { rows } = await client.query(
    `SELECT ${SIGHTING_COLUMNS} FROM walk_sightings WHERE tenant_id = $1 AND walk_id = $2 AND client_ref = $3`,
    [tenantId, walkId, clientRef],
  );
  return rows[0] ?? null;
}

export async function getSighting(client, tenantId, walkId, sightingId) {
  if (!UUID.test(sightingId)) return null;
  const { rows } = await client.query(
    `SELECT ${SIGHTING_COLUMNS} FROM walk_sightings WHERE tenant_id = $1 AND walk_id = $2 AND id = $3`,
    [tenantId, walkId, sightingId],
  );
  return rows[0] ?? null;
}

/** Whether a later sighting already answers `sightingId`. */
export async function answered(client, tenantId, sightingId) {
  const { rows } = await client.query(
    'SELECT 1 FROM walk_sightings WHERE tenant_id = $1 AND confirms = $2',
    [tenantId, sightingId],
  );
  return rows.length > 0;
}

/** A picture with no reader set up: kept for the person to type. */
export const READER_OFF = Object.freeze({
  read: 'none', why: 'reader_off', plate: null, characters: null, readers: [],
});

export async function addSighting(client, tenantId, walkId, s) {
  const { rows } = await client.query(
    `INSERT INTO walk_sightings (tenant_id, walk_id, client_ref, read, why, plate, plate_state, plate_rule, plate_pattern,
                                 readers, candidates, confirms, taken_at, added_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${SIGHTING_COLUMNS}`,
    [tenantId, walkId, s.clientRef, s.read, s.why, s.plate, s.characters?.state ?? null, s.characters?.rule ?? null,
      s.characters?.pattern ?? null, JSON.stringify(s.readers), s.candidates ?? [], s.confirms, s.takenAt, s.by],
  );
  return rows[0];
}

export async function pickStay(client, tenantId, sightingId, stayId) {
  const { rows } = await client.query(
    `UPDATE walk_sightings SET picked_stay = $3 WHERE tenant_id = $1 AND id = $2 RETURNING ${SIGHTING_COLUMNS}`,
    [tenantId, sightingId, stayId],
  );
  return rows[0];
}

/** Store the finish: the lists on the walk, and the stays it listed for the stuck list. */
export async function finishWalk(client, tenantId, walkId, by, found) {
  const { rows } = await client.query(
    `UPDATE walks SET finished_at = greatest(now(), started_at), finished_by = $3, lists = $4
      WHERE tenant_id = $1 AND id = $2 AND finished_at IS NULL RETURNING *`,
    [tenantId, walkId, by, JSON.stringify(found)],
  );
  const seen = found.seen_with_stay.map((r) => r.stay);
  const notSeen = found.stay_not_seen.map((r) => r.stay);
  if (seen.length + notSeen.length > 0) {
    await client.query(
      `INSERT INTO walk_stays (tenant_id, walk_id, session_id, list)
       SELECT $1, $2, id, list FROM unnest($3::uuid[], $4::text[]) AS t(id, list)`,
      [tenantId, walkId, [...seen, ...notSeen], [...seen.map(() => 'seen'), ...notSeen.map(() => 'not_seen')]],
    );
  }
  return rows[0];
}

/** A sighting in the app's shape. `candidates` are the stays it fits, with what a person picks by. */
export function presentSighting(s, stays = []) {
  const byId = new Map(stays.map((x) => [x.id, x]));
  return {
    id: s.id,
    plate: s.plate,
    read: s.read,
    why: s.why,
    readers: s.readers,
    needs_confirmation: s.read === 'unsure' || s.read === 'none',
    plate_characters: s.plate_state ? { state: s.plate_state, rule: s.plate_rule, pattern: s.plate_pattern } : null,
    candidates: (s.candidates ?? []).map((id) => {
      const stay = byId.get(id);
      return { stay: id, plate: stay ? stayPlate(stay) : null, entered_at: stay ? stay.entry_at : null };
    }),
    picked_stay: s.picked_stay,
    confirms: s.confirms,
    taken_at: s.taken_at,
    added_by: s.added_by,
  };
}

export function presentWalk(w, sightings = null, stays = []) {
  return {
    id: w.id,
    started_at: w.started_at,
    started_by: w.started_by,
    finished_at: w.finished_at,
    finished_by: w.finished_by,
    lists: w.lists,
    ...(sightings ? { sightings: sightings.map((s) => presentSighting(s, stays)) } : {}),
  };
}

/** For the stuck list: when finished walks last saw each stay, and the stays the latest walk did not see. */
export async function walkFacts(client, tenantId, garageId) {
  const { rows: seen } = await client.query(
    `SELECT ws.session_id, max(w.finished_at) AS at
       FROM walk_stays ws JOIN walks w ON w.id = ws.walk_id AND w.tenant_id = ws.tenant_id
      WHERE ws.tenant_id = $1 AND w.garage_id = $2 AND ws.list = 'seen'
      GROUP BY ws.session_id`,
    [tenantId, garageId],
  );
  const { rows: notSeen } = await client.query(
    `SELECT ws.session_id
       FROM walk_stays ws
      WHERE ws.tenant_id = $1 AND ws.list = 'not_seen' AND ws.walk_id = (
        SELECT w.id FROM walks w WHERE w.tenant_id = $1 AND w.garage_id = $2 AND w.finished_at IS NOT NULL
         ORDER BY w.finished_at DESC, w.id LIMIT 1)`,
    [tenantId, garageId],
  );
  return {
    lastSeen: new Map(seen.map((r) => [r.session_id, r.at])),
    notSeenLast: new Set(notSeen.map((r) => r.session_id)),
  };
}
