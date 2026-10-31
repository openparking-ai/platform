/**
 * People from a linked accounts module (0047; README, "Linked accounts:
 * people beside the admin"): their sessions, and sign-in's lock for them.
 *
 * A SESSION KEEPS THE ANSWER IT WAS MADE FROM -- who, the tenant, the garages,
 * the permissions, the version -- under sign-in's own idle and absolute ends
 * and the same cookie. Only the token's SHA-256 is stored.
 *
 * IT ASKS AGAIN. When the last answer is older than ACCOUNTS_RECHECK_SECONDS,
 * the next request asks the module `who` before it runs:
 *   the same version    the session goes on, and is asked again later;
 *   another version     the session ends: the person's garages, permissions or
 *                       password changed, and they sign in again;
 *   gone, or another    the session ends;
 *   tenant
 *   could not decide    the request is refused (`AccountsUndecided`) and runs
 *                       nothing; the session is asked again on the next one.
 * One question per session at a time: requests that arrive while it is out
 * wait for its answer.
 *
 * UNSET IS ONLY THE ADMIN. With no ACCOUNTS_DOOR named, no session here is
 * ever found, whatever is in the table: nothing a module once said outlives
 * the deployment's saying it has none.
 *
 * THE LOCK is sign-in's, for people this platform does not keep: ten refusals
 * for one email from one address lock that address out of that email for the
 * lock's minutes, and a locked address never reaches the module. Kept by a
 * hash of the email, since nothing says whose it is.
 */
import { createHash } from 'node:crypto';
import { query, withTenant } from './db.js';
import { generateDeviceToken, hashToken } from './auth.js';
import * as door from './accountsDoor.js';

export const LOCK_FAILURES = 10;
export const LOCK_MINUTES = 30;

export const ACCOUNTS_UNDECIDED = Object.freeze({
  error: 'Your account could not be checked just now. Try again in a moment.',
  code: 'accounts_undecided',
});

export const emailHash = (email) => createHash('sha256').update(`openparking-linked-lock:${email}`, 'utf8').digest('hex');

/** What a linked session may do (src/permissions.js). */
export const access = (s) => ({ permissions: s.permissions, garages: s.all_garages ? 'all' : s.garages });

// On an object so a test can reach in; nothing else replaces them.
export const internals = {
  door,

  async lockOf(hash, address) {
    return (await query('SELECT failed_count, locked_until FROM linked_sign_in_locks WHERE email_hash = $1 AND address = $2', [hash, address])).rows[0] ?? null;
  },

  /** A refusal counted: a wrong password, or an attempt during the lock (which re-arms it). */
  async recordFailure(hash, address) {
    await query(
      `INSERT INTO linked_sign_in_locks AS l (email_hash, address, failed_count, locked_until)
       VALUES ($1, $2, 1, CASE WHEN 1 >= $3 THEN now() + make_interval(mins => $4) END)
       ON CONFLICT (email_hash, address) DO UPDATE SET
         failed_count = CASE WHEN l.locked_until <= now() THEN 1 ELSE l.failed_count + 1 END,
         locked_until = CASE
           WHEN (CASE WHEN l.locked_until <= now() THEN 1 ELSE l.failed_count + 1 END) >= $3 THEN now() + make_interval(mins => $4)
           WHEN l.locked_until <= now() THEN NULL
           ELSE l.locked_until END,
         updated_at = now()`,
      [hash, address, LOCK_FAILURES, LOCK_MINUTES],
    );
  },

  async clearLock(hash, address) {
    await query('DELETE FROM linked_sign_in_locks WHERE email_hash = $1 AND address = $2', [hash, address]);
  },
};

export const isLocked = (lock) => Boolean(lock?.locked_until && new Date(lock.locked_until) > new Date());

/**
 * A session for `person` (as the module answered), or throws AccountsUndecided
 * when its tenant is not one this platform has.
 */
export async function mint(person, settings) {
  const token = generateDeviceToken();
  const row = await withTenant(person.tenant, async (c) => {
    if ((await c.query('SELECT 1 FROM tenants WHERE id = $1', [person.tenant])).rowCount !== 1) return null;
    // This person's ended sessions are of no further use to anyone.
    await c.query(
      `DELETE FROM linked_sessions WHERE tenant_id = $1 AND person = $2
         AND (revoked_at IS NOT NULL OR expires_at <= now() OR last_seen_at <= now() - make_interval(secs => $3))`,
      [person.tenant, person.person, settings.idleSeconds],
    );
    return (await c.query(
      `INSERT INTO linked_sessions (tenant_id, token_hash, person, email, name, language, all_garages, garages, permissions, version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11))
       RETURNING id, expires_at, last_seen_at + make_interval(secs => $12) AS idle_ends_at, language`,
      [person.tenant, hashToken(token), person.person, person.email, person.name, person.language,
        person.garages === 'all', person.garages === 'all' ? [] : person.garages, person.permissions, person.version,
        settings.maxSeconds, settings.idleSeconds],
    )).rows[0];
  });
  if (!row) throw new door.AccountsUndecided('a tenant this platform does not have');
  return { token, row };
}

async function revoke(s) {
  await withTenant(s.tenant_id, (c) =>
    c.query('UPDATE linked_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [s.session_id]));
}

const asking = new Map();

/** Whether the session still stands after asking the module again. Throws AccountsUndecided. */
async function recheck(s) {
  const fresh = await internals.door.who(s.tenant_id, s.person);
  if (!fresh || fresh.tenant !== s.tenant_id || fresh.version !== s.version) {
    await revoke(s);
    return false;
  }
  await withTenant(s.tenant_id, (c) => c.query('UPDATE linked_sessions SET checked_at = now() WHERE id = $1', [s.session_id]));
  return true;
}

/**
 * The live linked session a token names, asked again when its answer is old;
 * or null when it has ended, never was, or this deployment names no door.
 * Throws AccountsUndecided when the module must be asked and cannot answer.
 */
export async function resolve(token, settings) {
  if (!token || !door.doorConfigured()) return null;
  const s = (await query('SELECT * FROM resolve_linked_session($1, $2)', [hashToken(token), settings.idleSeconds])).rows[0];
  if (!s) return null;
  if (Date.now() - new Date(s.checked_at).getTime() >= settings.accountsRecheckSeconds * 1000) {
    let pending = asking.get(s.session_id);
    if (!pending) {
      pending = recheck(s).finally(() => asking.delete(s.session_id));
      asking.set(s.session_id, pending);
    }
    if (!(await pending)) return null;
  }
  return s;
}

/** Ends a linked session (sign-out). */
export const signOut = revoke;

/** The language of this one session. */
export async function setLanguage(s, language) {
  return withTenant(s.tenant_id, async (c) =>
    (await c.query('UPDATE linked_sessions SET language = $2 WHERE id = $1', [s.session_id, language])).rowCount);
}
