/**
 * THE CHANGE LOG (0026): who changed what, from what to what, and when.
 *
 * Every operator write route -- the owner's screens and the operator keys
 * alike -- writes exactly one line per request:
 *
 *   a change      `record(client, req.change, line)`, inside the SAME
 *                 transaction as the change, so a change whose line cannot be
 *                 written rolls back with it. Never after the commit.
 *   nothing new   a request that changed nothing (asked again) writes its line
 *                 on its own, saying so; there is no change to roll back.
 *   refused       `refused(req, err)`, after the refusal, through
 *                 record_refused_change() (0026), which puts the line in the
 *                 log of the account the path names, of the caller's account,
 *                 or -- naming nothing and coming with nothing -- in the
 *                 platform's own security log.
 *
 * WHAT A LINE NEVER HOLDS: a password, a key, a lane computer's connection
 * code, a cookie or a session value. A line is built from named fields only,
 * never from a request body, and `record` refuses -- by throwing, so the
 * change rolls back -- any value shaped like one of this platform's
 * credentials.
 *
 * The log is append-only: the application role may SELECT and INSERT, and a
 * trigger refuses UPDATE, DELETE and TRUNCATE for every role.
 */
import { pool } from './db.js';
import { hashToken } from './auth.js';

/** The subjects a line can be about, as the table allows them. */
export const SUBJECTS = Object.freeze([
  'garage', 'lane', 'computer', 'reader', 'payment_account', 'rate_plan', 'tax_set', 'key', 'language', 'unknown',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINES_PAGE = 50;
const LINES_MAX_PAGE = 200;

/**
 * A credential this platform hands out, wherever it sits in a string. Every
 * one -- a lane computer's code, an operator key, a session -- is `opl_` and
 * 43 url-safe characters (src/auth.js); and the session cookie's name with a
 * value, and a stored password. The request's own credentials are checked
 * by value as well (`context`).
 */
const CREDENTIAL_SHAPES = [/opl_[A-Za-z0-9_-]{20,}/, /op_session=/i, /scrypt\$/];

export class SecretInLine extends Error {
  constructor(where) {
    super(`a change line would have held something shaped like a credential (${where}); nothing was written`);
  }
}

/** Every string in a value, with where it sits. */
function* strings(value, where) {
  if (typeof value === 'string') yield [value, where];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${where}[${i}]`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    yield [k, `${where}.${k} (key)`];
    yield* strings(v, `${where}.${k}`);
  }
}

/** Throws SecretInLine when any string of the line is, or holds, a credential. Exported for the tests. */
export function assertNoCredential(line, secrets = []) {
  for (const [text, where] of strings(line, 'line')) {
    if (CREDENTIAL_SHAPES.some((shape) => shape.test(text))) throw new SecretInLine(where);
    if (secrets.some((secret) => secret && text.includes(secret))) throw new SecretInLine(where);
  }
}

/**
 * Who is asking, as the operator middleware found them. An owner is named by
 * the email they signed in with; a key by the name it was issued under, read
 * when the first line is written.
 */
export function context(req, secrets = []) {
  return { tenantId: req.tenantId, actor: req.actor, count: 0, secrets: secrets.filter(Boolean) };
}

/** Who the line names, the key's name read once on `client` when it is a key. */
export async function who(client, ctx) {
  const actor = ctx.actor;
  if (actor.kind === 'key' && actor.name === undefined) {
    const { rows } = await client.query('SELECT name FROM operator_tokens WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, actor.id]);
    actor.name = rows[0]?.name ?? null;
  }
  return actor;
}

// On an object so a test can make the write fail; nothing else replaces it.
export const internals = {
  async insert(client, row) {
    await client.query(
      `INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name,
                                   action, subject_kind, subject_id, subject_name, before, after)
       VALUES ($1, $2, 'done', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      row,
    );
  },
};

/**
 * Write one line, on `client`, inside the caller's transaction.
 *
 *   garageId     the garage it is about, or null for the whole account
 *   action       what was done, dotted: `lane.close`, `garage.update`
 *   subject      { kind, id, name }: the thing changed, in plain terms
 *   before/after what changed, as plain values; null where there was nothing
 */
export async function record(client, ctx, { garageId = null, action, subject, before = null, after = null }) {
  if (!ctx) throw new Error('a change was made with no change context');
  if (!SUBJECTS.includes(subject?.kind)) throw new Error(`a change line names an unknown subject ${JSON.stringify(subject?.kind)}`);
  assertNoCredential({ action, subject, before, after }, ctx.secrets);
  const actor = await who(client, ctx);
  await internals.insert(client, [
    ctx.tenantId,
    garageId,
    actor.kind,
    actor.id,
    actor.name ?? null,
    action,
    subject.kind,
    subject.id ?? null,
    subject.name === null || subject.name === undefined ? null : String(subject.name).slice(0, 300),
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
  ]);
  ctx.count += 1;
}

/** What a write route is about, from its path: the thing a refusal names. */
export function targetOf(req) {
  const p = req.params ?? {};
  const named = [['garageId', 'garage'], ['laneId', 'lane'], ['deviceId', 'computer'], ['tokenId', 'key']].find(([k]) => p[k]);
  if (!named || !UUID.test(p[named[0]])) return { kind: null, id: null };
  return { kind: named[1], id: p[named[0]] };
}

/** The path's ids, when the route was not reached: read from the path itself. */
const PATH_TARGETS = [
  [/^\/garages\/([^/]+)/, 'garage'],
  [/^\/lanes\/([^/]+)/, 'lane'],
  [/^\/devices\/([^/]+)/, 'computer'],
  [/^\/operator-tokens\/([^/]+)/, 'key'],
];

function targetFromPath(path) {
  for (const [re, kind] of PATH_TARGETS) {
    const m = re.exec(path);
    if (m) return UUID.test(m[1]) ? { kind, id: m[1] } : { kind: null, id: null };
  }
  return { kind: null, id: null };
}

/** The refusal's name: the code it was answered with, or a name for its status. */
function refusalName(err) {
  if (typeof err?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(err.code)) return err.code;
  const status = err?.status ?? 500;
  return { 400: 'bad_request', 401: 'not_signed_in', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 410: 'retired' }[status]
    ?? `status_${status}`;
}

/**
 * Record a refused write. Never throws: a refusal is answered whether or not
 * its line could be written, and a failure here is logged by what it is.
 *
 * `credential` is what came with the request -- 'none', 'session' or 'key' --
 * and `credentialToken` the value, which never leaves this function: only its
 * hash goes to the database, the hash the sign-in already computes.
 */
export async function refused(req, err, { action, credential, credentialToken }) {
  try {
    const fromRoute = targetOf(req);
    const target = fromRoute.kind ? fromRoute : targetFromPath(req.path);
    const actor = req.actor ?? null;
    const request = `${req.method} ${(req.baseUrl ?? '') + (req.path ?? '')}`.slice(0, 300);
    await pool.query('SELECT record_refused_change($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [
      req.tenantId ?? null,
      req.tenantId ? null : credentialToken ? hashToken(credentialToken) : null,
      credential,
      actor ? actor.kind : 'nobody',
      actor ? actor.id : null,
      actor && actor.kind === 'owner' ? actor.name : null,
      target.kind,
      target.id,
      action,
      refusalName(err),
      request,
    ]);
  } catch (failure) {
    console.error(`[changes] a refused attempt could not be recorded: ${failure?.code ?? failure?.name ?? 'error'}`);
  }
}

/**
 * The garage's lines, newest first: its own and the account's (garage_id
 * NULL). Paged by (at, id), `before` being the last line of the page before.
 */
export async function linesForGarage(client, tenantId, garageId, { before = null, limit = LINES_PAGE } = {}) {
  const size = Math.min(Math.max(Number.isInteger(limit) ? limit : LINES_PAGE, 1), LINES_MAX_PAGE);
  const values = [tenantId, garageId, size + 1];
  let after = '';
  if (before) {
    values.push(before.at, before.id);
    after = 'AND (at, id) < ($4::timestamptz, $5::uuid)';
  }
  const { rows } = await client.query(
    `SELECT id, garage_id, at, outcome, actor_kind, actor_name, action, subject_kind, subject_id, subject_name,
            before, after, refusal
       FROM garage_changes
      WHERE tenant_id = $1 AND (garage_id = $2 OR garage_id IS NULL) ${after}
      ORDER BY at DESC, id DESC
      LIMIT $3`,
    values,
  );
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return { lines: page, next: rows.length > size && last ? cursorOf(last) : null };
}

/** A page cursor: the last line's instant and id, as one opaque string. */
export function cursorOf(line) {
  return Buffer.from(JSON.stringify([new Date(line.at).toISOString(), line.id]), 'utf8').toString('base64url');
}

/** A cursor back to (at, id), or null when it is not one this route handed out. */
export function readCursor(raw) {
  if (raw === undefined) return { ok: true, value: null };
  try {
    const [at, id] = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || typeof id !== 'string' || !UUID.test(id)) return { ok: false };
    return { ok: true, value: { at, id } };
  } catch {
    return { ok: false };
  }
}
