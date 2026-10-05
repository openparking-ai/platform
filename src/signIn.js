/**
 * The owner signs in (0024).
 *
 * One admin per tenant, an email and a password. A sign-in IS a session token
 * minted the way operator tokens are (random 32 bytes, its sha256 stored), so
 * every operator route works unchanged behind it. The session travels in a
 * cookie page script can never read.
 *
 *   POST /api/v1/auth/sign-in    {email, password} -> the cookie, and who, until when, and their language
 *   POST /api/v1/auth/sign-out   revokes the session row
 *   GET  /api/v1/auth/me         email, tenant, when the session ends, language
 *   PUT  /api/v1/auth/language   {language} -> the signed-in admin's own language (0025)
 *
 * What each rule is for, because each is one of the ways sign-in went wrong on
 * the maintainer's other systems:
 *
 * NO ORACLE. An unknown email, a wrong password and a locked address answer
 * the SAME status and the SAME body, and each runs exactly one hash -- an
 * unknown email is checked against a hash of nothing anyone knows. Each also
 * runs the SAME database statements: the lock lookup and the failure write,
 * which for an unknown email name no user and so find and write nothing. And
 * no refusal is answered sooner than a fixed floor after the request arrived
 * (SIGN_IN_REFUSAL_FLOOR_MS), set above a refusal's own work, so what is left
 * of the difference in work is not on the wire.
 *
 * WAITING. Hashes are slow by design, and only a few run at once. The line
 * for them is capped (SIGN_IN_HASH_LINE), and one address holds only a few
 * places in it (SIGN_IN_HASH_LINE_PER_ADDRESS): an attempt that finds it full
 * is answered `503 sign_in_busy` -- before the email is looked at, so it is
 * the same for every email -- instead of waiting behind everyone else's.
 *
 * GUESSING. Ten wrong passwords from one caller address lock THAT address out
 * of THAT account for thirty minutes; wrong passwords during the lock still
 * count and re-arm it. Other addresses are unaffected:
 * knowing the one admin's email is not enough to keep the admin out. Behind a
 * proxy with no TRUST_PROXY, every caller is the proxy, so the lock is in
 * effect account-wide. Separately, sign-in attempts per address are limited
 * in this process. The address is the SOCKET's; `X-Forwarded-For` is read only
 * when TRUST_PROXY is declared. An IPv6 address counts by its /64.
 *
 * NOTHING SECRET IS WRITTEN OUT. The password, the token, the cookie and the
 * stored hash go into no log line and no response body. A body that cannot be
 * read is answered with one fixed sentence, never the parser's text (which
 * quotes what was sent), and a failure inside sign-in is logged by its class
 * and code, never its message.
 *
 * NO CREDENTIAL IN A URL. No route here has a path parameter or reads the
 * query.
 *
 * ONLY YOUR OWN ROW. The language route changes the admin the SESSION names,
 * in that session's tenant, and nobody else: a user or tenant named in the
 * body is never read. It writes one column of one row, and only `en` or `es`.
 *
 * CROSS-SITE. The cookie is `SameSite=Strict`, and a request that CHANGES
 * something and is authenticated by the cookie must carry an `Origin` equal
 * to ADMIN_ORIGIN, or it is refused. A sign-in carrying a foreign Origin is
 * refused too, and one not sent as JSON cannot be read. The admin site is
 * served same-origin as `/api`: there is no CORS here.
 */
import express from 'express';
import { isIP, isIPv6 } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool, withTenant } from './db.js';
import * as changes from './changes.js';
import { generateDeviceToken, hashToken } from './auth.js';
import { dummyHash, MAX_PASSWORD_LENGTH, verifyPassword } from './passwords.js';

export const COOKIE = 'op_session';
export const MAX_FAILED = 10;
export const LOCK_MINUTES = 30;

//: The one refusal: unknown email, wrong password, locked address.
export const REFUSED = Object.freeze({ error: 'Sign-in refused. Check the email and password.', code: 'sign_in_refused' });
//: A body that cannot be read, whatever was wrong with it.
export const UNREADABLE = Object.freeze({ error: 'The sign-in request could not be read. Send JSON: {"email", "password"}.', code: 'sign_in_unreadable' });
export const RATE_LIMITED = Object.freeze({ error: 'Too many sign-in attempts from here. Try again later.', code: 'sign_in_rate_limited' });
export const ORIGIN_REFUSED = Object.freeze({ error: 'This request did not come from the admin site.', code: 'origin_refused' });
export const NOT_CONFIGURED = Object.freeze({ error: 'This deployment has no admin origin configured, so owner sign-in is off.', code: 'sign_in_not_configured' });
export const SESSION_ENDED = Object.freeze({ error: 'The session has ended. Sign in again.', code: 'session_ended' });
export const SIGN_IN_REQUIRED = Object.freeze({ error: 'Sign in first.', code: 'sign_in_required' });
//: The hash line is full. Decided before the email is read, so the same for every email.
export const BUSY = Object.freeze({ error: 'Sign-in is busy. Try again in a moment.', code: 'sign_in_busy' });
//: Anything but {"language": "en" | "es"}, sent as JSON: one refusal, whatever was wrong with it.
export const LANGUAGE_REFUSED = Object.freeze({ error: 'The language must be "en" or "es", sent as JSON: {"language"}.', code: 'language_refused' });

//: The languages the admin screens have words for (0025's check holds the same two).
export const LANGUAGES = Object.freeze(['en', 'es']);

//: Who an unknown email is: no user and no tenant, so the lock lookup and the
//: failure write run as they do for a known email and find and write nothing.
export const NOBODY = Object.freeze({ user_id: '00000000-0000-0000-0000-000000000000', tenant_id: '00000000-0000-0000-0000-000000000000' });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ---------------------------------------------------------------------------
// Settings, read when the app is made. A value that is not one of the forms
// below is refused at start, never guessed at.
// ---------------------------------------------------------------------------

/**
 * Every number setting sign-in reads: a whole number inside its bounds, and
 * its default. The defaults of the floor and the line are measured (README,
 * "The owner signs in"): one hash at N=2^17 is about 151 ms, four run at once.
 */
export const NUMBER_SETTINGS = Object.freeze({
  SESSION_IDLE_MINUTES: { min: 1, max: 1440, fallback: 30 },
  SESSION_MAX_HOURS: { min: 1, max: 168, fallback: 12 },
  SIGN_IN_ATTEMPTS_PER_ADDRESS: { min: 1, max: 1000, fallback: 30 },
  SIGN_IN_ATTEMPTS_WINDOW_MINUTES: { min: 1, max: 1440, fallback: 15 },
  SIGN_IN_REFUSAL_FLOOR_MS: { min: 200, max: 5000, fallback: 500 },
  SIGN_IN_HASH_LINE: { min: 1, max: 1000, fallback: 48 },
  SIGN_IN_HASH_LINE_PER_ADDRESS: { min: 1, max: 16, fallback: 2 },
});

//: The most proxy hops TRUST_PROXY may name.
export const MAX_PROXY_HOPS = 5;

function whole(env, name) {
  const { min, max, fallback } = NUMBER_SETTINGS[name];
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,6}$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, not ${JSON.stringify(String(raw).slice(0, 40))}`);
  }
  return Number(raw);
}

const TRUST_PROXY_FORMS =
  `TRUST_PROXY must be a number of proxy hops from 1 to ${MAX_PROXY_HOPS}, "loopback", or a comma-separated list of ` +
  'proxy addresses or subnets (CIDR); "true" and any other form are refused, because they trust whatever the caller says';

/** One proxy address or subnet, as written; or null when it is not one. */
function proxyEntry(entry) {
  const [address, prefix, extra] = entry.split('/');
  const family = isIP(address);
  if (!family || extra !== undefined) return null;
  if (prefix === undefined) return address;
  if (!/^[0-9]{1,3}$/.test(prefix)) return null;
  const bits = Number(prefix);
  // A /0 is every address there is: the caller's say-so again.
  return bits >= 1 && bits <= (family === 4 ? 32 : 128) ? `${address}/${bits}` : null;
}

/** TRUST_PROXY as Express is to be told it, or null when unset. Anything else is refused by name. */
export function readTrustProxy(raw) {
  if (raw === undefined || raw === '') return null;
  let value;
  if (/^[0-9]{1,6}$/.test(raw)) {
    value = Number(raw);
    if (value < 1 || value > MAX_PROXY_HOPS) throw new Error(`${TRUST_PROXY_FORMS}; not ${JSON.stringify(raw)}`);
  } else if (raw === 'loopback') {
    value = 'loopback';
  } else {
    const entries = raw.split(',').map((e) => proxyEntry(e.trim()));
    if (entries.some((e) => e === null)) throw new Error(`${TRUST_PROXY_FORMS}; not ${JSON.stringify(String(raw).slice(0, 80))}`);
    value = entries;
  }
  // Express is asked to compile it here, at start-up, so a form it would
  // refuse later is refused now and by name -- never a stack trace.
  try {
    express().set('trust proxy', value);
  } catch {
    throw new Error(`${TRUST_PROXY_FORMS}; not ${JSON.stringify(String(raw).slice(0, 80))}`);
  }
  return value;
}

export function readAuthSettings(env = process.env) {
  let adminOrigin = null;
  if (env.ADMIN_ORIGIN !== undefined && env.ADMIN_ORIGIN !== '') {
    let url;
    try {
      url = new URL(env.ADMIN_ORIGIN);
    } catch {
      throw new Error('ADMIN_ORIGIN must be an origin, scheme://host[:port], with no path');
    }
    if (url.origin !== env.ADMIN_ORIGIN || !['https:', 'http:'].includes(url.protocol)) {
      throw new Error('ADMIN_ORIGIN must be an origin, scheme://host[:port], with no path');
    }
    adminOrigin = url.origin;
  }
  const insecure = env.SESSION_COOKIE_INSECURE;
  if (insecure !== undefined && insecure !== '' && insecure !== 'true') {
    throw new Error('SESSION_COOKIE_INSECURE is unset, or exactly "true" for plain-http local development');
  }
  const idleMinutes = whole(env, 'SESSION_IDLE_MINUTES');
  const maxHours = whole(env, 'SESSION_MAX_HOURS');
  if (idleMinutes * 60 > maxHours * 3600) throw new Error('SESSION_IDLE_MINUTES cannot be longer than SESSION_MAX_HOURS');
  const hashLine = whole(env, 'SIGN_IN_HASH_LINE');
  const hashLinePerAddress = whole(env, 'SIGN_IN_HASH_LINE_PER_ADDRESS');
  if (hashLinePerAddress > hashLine) throw new Error('SIGN_IN_HASH_LINE_PER_ADDRESS cannot be more than SIGN_IN_HASH_LINE');
  return {
    adminOrigin,
    cookieSecure: insecure !== 'true',
    idleSeconds: idleMinutes * 60,
    maxSeconds: maxHours * 3600,
    trustProxy: readTrustProxy(env.TRUST_PROXY),
    attemptsPerAddress: whole(env, 'SIGN_IN_ATTEMPTS_PER_ADDRESS'),
    attemptsWindowSeconds: whole(env, 'SIGN_IN_ATTEMPTS_WINDOW_MINUTES') * 60,
    refusalFloorMs: whole(env, 'SIGN_IN_REFUSAL_FLOOR_MS'),
    hashLine,
    hashLinePerAddress,
  };
}

// ---------------------------------------------------------------------------
// The caller's address.
// ---------------------------------------------------------------------------

/** Every hextet of an IPv6 address, for the /64 it is counted by. */
function hextets(address) {
  const [head, tail = null] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === null ? [] : tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((h) => h.toLowerCase().replace(/^0+(?=.)/, ''));
}

/**
 * The address a sign-in is counted against: the socket's, unless TRUST_PROXY
 * is declared, and then Express's reading of `X-Forwarded-For` under it.
 */
export function callerAddress(req, settings) {
  let address = (settings.trustProxy === null ? req.socket.remoteAddress : req.ip) ?? 'unknown';
  address = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (isIPv6(address)) address = `${hextets(address.split('%')[0]).slice(0, 4).join(':')}::/64`;
  return address.slice(0, 64);
}

/** Attempts per address in a fixed window, held in this process. */
export function addressLimiter({ max, windowSeconds, now = () => Date.now() }) {
  const seen = new Map();
  return {
    take(address) {
      const at = now();
      if (seen.size > 10_000) {
        for (const [key, entry] of seen) if (entry.resetAt <= at) seen.delete(key);
      }
      let entry = seen.get(address);
      if (!entry || entry.resetAt <= at) {
        entry = { count: 0, resetAt: at + windowSeconds * 1000 };
        seen.set(address, entry);
      }
      entry.count += 1;
      return entry.count <= max;
    },
  };
}

/**
 * The line for hashes: at most `max` sign-ins between admission and answer,
 * at most `perAddress` of them from one address. `enter` answers a function
 * that gives the place back, or null when there is none.
 */
export function hashLine({ max, perAddress }) {
  let held = 0;
  const byAddress = new Map();
  return {
    get held() {
      return held;
    },
    enter(address) {
      const mine = byAddress.get(address) ?? 0;
      if (held >= max || mine >= perAddress) return null;
      held += 1;
      byAddress.set(address, mine + 1);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        held -= 1;
        const rest = byAddress.get(address) - 1;
        if (rest > 0) byAddress.set(address, rest);
        else byAddress.delete(address);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The cookie.
// ---------------------------------------------------------------------------

function cookieAttributes(settings, maxAge) {
  return `Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${settings.cookieSecure ? '; Secure' : ''}`;
}
export const setCookie = (res, settings, token) =>
  res.append('Set-Cookie', `${COOKIE}=${token}; ${cookieAttributes(settings, settings.maxSeconds)}`);
export const clearCookie = (res, settings) =>
  res.append('Set-Cookie', `${COOKIE}=; ${cookieAttributes(settings, 0)}`);

/**
 * The session token in the request's cookie, or null. A request carrying the
 * cookie more than once is answered as carrying none it can use: which of two
 * values is meant is not a guess this code makes.
 */
export function sessionToken(req) {
  const header = req.get('cookie');
  if (!header) return null;
  const values = header.split(';').map((p) => p.trim()).filter((p) => p.startsWith(`${COOKIE}=`)).map((p) => p.slice(COOKIE.length + 1));
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(values[0])) return values.length ? '' : null;
  return values[0];
}

/** The live session a token names, its use recorded; or null when it has ended or never was. */
export async function resolveSession(token, settings) {
  if (!token) return null;
  const { rows } = await pool.query('SELECT * FROM resolve_operator_session($1, $2)', [hashToken(token), settings.idleSeconds]);
  return rows[0] ?? null;
}

const endsAt = (session) => new Date(Math.min(new Date(session.expires_at).getTime(), new Date(session.idle_ends_at).getTime()));

/**
 * Whether a cookie-authenticated request may change something: a safe method,
 * or an Origin that IS the admin site. With no admin origin declared, nothing.
 */
export function originAllows(req, settings) {
  if (SAFE_METHODS.has(req.method)) return true;
  return settings.adminOrigin !== null && req.get('origin') === settings.adminOrigin;
}

/** Every operator and auth response: never stored, never sniffed. */
export function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
}

// ---------------------------------------------------------------------------
// What a sign-in does. On an object so a test can reach in and make one part
// fail; nothing else replaces them.
// ---------------------------------------------------------------------------

export const internals = {
  verifyPassword,

  /** The lock row of this user at this address. For NOBODY: the same statement, finding nothing. */
  async lockOf(user, address) {
    return withTenant(user.tenant_id, async (c) =>
      (await c.query('SELECT failed_count, locked_until FROM operator_sign_in_locks WHERE user_id = $1 AND address = $2', [user.user_id, address])).rows[0] ?? null);
  },

  /**
   * The failure write, run on EVERY refusal so each runs the same statements.
   * It counts only when `counted` (a wrong password) AND the user exists in
   * this tenant -- so NOBODY, and a right password during a lock, write
   * nothing, and an unknown email never makes a lock row.
   *
   * A lock that has ended is over: the count starts again at 1, and it takes
   * the full number again to lock. During a lock a wrong password still
   * counts and re-arms it.
   */
  async recordFailure(user, address, counted) {
    await withTenant(user.tenant_id, (c) =>
      c.query(
        `INSERT INTO operator_sign_in_locks AS l (tenant_id, user_id, address, failed_count, locked_until)
         SELECT $1, $2, $3, 1, CASE WHEN 1 >= $4 THEN now() + make_interval(mins => $5) END
          WHERE $6::boolean AND EXISTS (SELECT 1 FROM operator_users u WHERE u.id = $2 AND u.tenant_id = $1)
         ON CONFLICT (user_id, address) DO UPDATE SET
           failed_count = CASE WHEN l.locked_until <= now() THEN 1 ELSE l.failed_count + 1 END,
           locked_until = CASE
             WHEN (CASE WHEN l.locked_until <= now() THEN 1 ELSE l.failed_count + 1 END) >= $4 THEN now() + make_interval(mins => $5)
             WHEN l.locked_until <= now() THEN NULL
             ELSE l.locked_until END,
           updated_at = now()`,
        [user.tenant_id, user.user_id, address, MAX_FAILED, LOCK_MINUTES, counted],
      ));
  },

  /**
   * A session for `user`, whose `password_hash` is the hash the password was
   * checked against -- or null when that is no longer the admin's: the
   * password changed while it was being checked. The row is held from that
   * reading until the session is written, so a change cannot land between
   * them; a change that waits for it is later than the session, and ends it.
   */
  async mintSession(user, address, settings) {
    const token = generateDeviceToken();
    const row = await withTenant(user.tenant_id, async (c) => {
      const still = await c.query('SELECT language FROM operator_users WHERE id = $1 AND password_hash = $2 FOR SHARE', [user.user_id, user.password_hash]);
      if (still.rowCount !== 1) return null;
      await c.query('DELETE FROM operator_sign_in_locks WHERE user_id = $1 AND address = $2', [user.user_id, address]);
      // This user's ended sessions are of no further use to anyone.
      await c.query(
        `DELETE FROM operator_tokens WHERE user_id = $1 AND kind = 'session'
           AND (revoked_at IS NOT NULL OR expires_at <= now() OR last_seen_at <= now() - make_interval(secs => $2))`,
        [user.user_id, settings.idleSeconds],
      );
      const session = (await c.query(
        `INSERT INTO operator_tokens (tenant_id, name, token_hash, kind, user_id, expires_at, last_seen_at)
         VALUES ($1, 'sign-in', $2, 'session', $3, now() + make_interval(secs => $4), now())
         RETURNING id, expires_at, last_seen_at + make_interval(secs => $5) AS idle_ends_at`,
        [user.tenant_id, hashToken(token), user.user_id, settings.maxSeconds, settings.idleSeconds],
      )).rows[0];
      return { ...session, language: still.rows[0].language };
    });
    return row ? { token, row } : null;
  },

  /** The language of the admin a session names, read in that session's tenant. */
  async languageOf(session) {
    return withTenant(session.tenant_id, async (c) =>
      (await c.query('SELECT language FROM operator_users WHERE id = $1', [session.user_id])).rows[0]?.language ?? null);
  },

  /**
   * The language of the admin a session names: the user and the tenant are the
   * SESSION's, never the request's. One column of one row.
   */
  async setLanguage(session, language, ctx) {
    return withTenant(session.tenant_id, async (c) => {
      const was = (await c.query('SELECT language FROM operator_users WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [session.user_id, session.tenant_id])).rows[0];
      const { rowCount } = await c.query('UPDATE operator_users SET language = $1 WHERE id = $2 AND tenant_id = $3', [language, session.user_id, session.tenant_id]);
      // Its line in the change log, in the same transaction (src/changes.js).
      if (rowCount === 1) {
        await changes.record(c, ctx, {
          garageId: null, action: 'language.change',
          subject: { kind: 'language', id: null, name: null },
          before: { language: was?.language ?? null }, after: { language },
        });
      }
      return rowCount;
    });
  },
};

/** The body, as `{email, password}`, or null: nothing else is a sign-in. */
function signInBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('email') || !keys.includes('password')) return null;
  const { email, password } = body;
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  const normal = email.trim().toLowerCase();
  if (normal.length < 3 || normal.length > 254 || password.length === 0 || password.length > MAX_PASSWORD_LENGTH * 4) return null;
  return { email: normal, password };
}

/** A failure inside the auth routes, in words that can hold nothing secret: its class and its code. */
function logFailure(where, err) {
  const kind = err?.constructor?.name ?? 'Error';
  console.error(`[auth] ${where} failed: ${kind}${err?.code ? ` ${err.code}` : ''}`);
}

/** Sign-in's body, read on that route only: any failure to read it is the one unreadable sentence. */
const jsonBody = express.json({ limit: '4kb' });
function readSignInBody(req, res, next) {
  jsonBody(req, res, (err) => next(err ? Object.assign(new Error('the sign-in body could not be read', { cause: err }), { unreadable: true }) : undefined));
}

/**
 * The language route's body, read after the session is known: any failure to
 * read it -- not JSON, too long, broken -- is the one language refusal. Nothing
 * longer than a language and its key is ever a language, so the limit is small.
 */
const languageJson = express.json({ limit: '256b', strict: true });
function readLanguageBody(req, res, next) {
  languageJson(req, res, (err) => next(err ? Object.assign(new Error('the language body could not be read', { cause: err }), { languageRefused: true }) : undefined));
}

/** The language in the body, or null. Only `language` is read: nothing else in the body names anyone. */
function languageBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { language } = body;
  return typeof language === 'string' && LANGUAGES.includes(language) ? language : null;
}

export function createAuthRouter(settings) {
  const router = express.Router();
  const limiter = addressLimiter({ max: settings.attemptsPerAddress, windowSeconds: settings.attemptsWindowSeconds });
  const line = hashLine({ max: settings.hashLine, perAddress: settings.hashLinePerAddress });
  // Made before the first request, so an unknown email's one hash is the
  // check, not the making of the hash it is checked against.
  dummyHash().catch(() => {});

  /** Every sign-in answer but a sign-in: never sooner than the floor after the request arrived. */
  const refuse = async (req, res, status, body) => {
    const wait = settings.refusalFloorMs - (performance.now() - req.arrivedAt);
    if (wait > 0) await sleep(wait);
    if (status === 503) res.set('Retry-After', '2');
    return res.status(status).json(body);
  };

  router.use((req, _res, next) => {
    req.arrivedAt = performance.now();
    next();
  });
  router.use(noStore);

  router.post('/sign-in', readSignInBody, async (req, res, next) => {
    let leave = null;
    try {
      if (settings.adminOrigin === null) return await refuse(req, res, 409, NOT_CONFIGURED);
      const origin = req.get('origin');
      if (origin !== undefined && origin !== settings.adminOrigin) return await refuse(req, res, 403, ORIGIN_REFUSED);
      if (!req.is('application/json')) return await refuse(req, res, 400, UNREADABLE);
      const body = signInBody(req.body);
      if (!body) return await refuse(req, res, 400, UNREADABLE);
      const address = callerAddress(req, settings);
      if (!limiter.take(address)) return await refuse(req, res, 429, RATE_LIMITED);
      leave = line.enter(address);
      if (!leave) return await refuse(req, res, 503, BUSY);

      const found = (await pool.query('SELECT * FROM resolve_operator_user($1)', [body.email])).rows[0] ?? null;
      const user = found ?? NOBODY;
      const lock = await internals.lockOf(user, address);
      const locked = Boolean(lock?.locked_until && new Date(lock.locked_until) > new Date());
      const matches = await internals.verifyPassword(body.password, found ? found.password_hash : await dummyHash());
      // The place is for the hash, not for the floor: given back the moment it is done.
      leave();

      if (!found || !matches || locked) {
        // The same write for every refusal; it counts only a wrong password of a real user.
        await internals.recordFailure(user, address, Boolean(found) && !matches);
        return await refuse(req, res, 401, REFUSED);
      }

      const minted = await internals.mintSession(found, address, settings);
      if (!minted) {
        // The password changed while this one was being checked: refused like
        // any refusal, through the same failure write, which counts nothing.
        await internals.recordFailure(user, address, false);
        return await refuse(req, res, 401, REFUSED);
      }
      const { token, row } = minted;
      setCookie(res, settings, token);
      return res.status(200).json({
        email: body.email,
        tenant_id: found.tenant_id,
        session_ends_at: endsAt({ expires_at: row.expires_at, idle_ends_at: row.idle_ends_at }).toISOString(),
        language: row.language,
      });
    } catch (err) {
      return next(err);
    } finally {
      leave?.();
    }
  });

  /**
   * A refused change of the owner's language is a line in the change log
   * (src/changes.js), as every refused change is. Sign-in, sign-out and the
   * reads change nothing an owner set up, and are not.
   */
  const refusedLanguage = async (req, status, body) => {
    if (req.method !== 'PUT' || req.path !== '/language') return;
    const token = sessionToken(req);
    await changes.refused(req, { status, code: body.code }, {
      action: 'language.change',
      credential: token ? 'session' : 'none',
      credentialToken: token || null,
      address: callerAddress(req, settings),
      idleSeconds: settings.idleSeconds,
    });
  };

  /** The session the cookie names, or a 401 that says which: never signed in, or ended. */
  const session = async (req, res, next) => {
    try {
      const token = sessionToken(req);
      if (token === null) {
        await refusedLanguage(req, 401, SIGN_IN_REQUIRED);
        return res.status(401).json(SIGN_IN_REQUIRED);
      }
      if (!originAllows(req, settings)) {
        await refusedLanguage(req, 403, ORIGIN_REFUSED);
        return res.status(403).json(ORIGIN_REFUSED);
      }
      const found = await resolveSession(token, settings);
      if (!found) {
        await refusedLanguage(req, 401, SESSION_ENDED);
        clearCookie(res, settings);
        return res.status(401).json(SESSION_ENDED);
      }
      req.session = found;
      req.tenantId = found.tenant_id;
      req.actor = { kind: 'owner', id: found.user_id, name: found.email };
      req.change = changes.context(req, [token]);
      next();
    } catch (err) {
      next(err);
    }
  };

  router.post('/sign-out', session, async (req, res, next) => {
    try {
      await withTenant(req.session.tenant_id, (c) =>
        c.query('UPDATE operator_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [req.session.token_id]));
      clearCookie(res, settings);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', session, async (req, res, next) => {
    try {
      const language = await internals.languageOf(req.session);
      res.json({ email: req.session.email, tenant_id: req.session.tenant_id, session_ends_at: endsAt(req.session).toISOString(), language });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The signed-in admin's own language. The session -- cookie, Origin, live --
   * is settled before the body is read; the admin and the tenant are the
   * session's. Anything but `en` or `es` is refused and writes nothing.
   */
  router.put('/language', session, async (req, res, next) => {
    if (!req.is('application/json')) {
      await refusedLanguage(req, 400, LANGUAGE_REFUSED);
      return res.status(400).json(LANGUAGE_REFUSED);
    }
    next();
  }, readLanguageBody, async (req, res, next) => {
    try {
      const language = languageBody(req.body);
      if (!language) {
        await refusedLanguage(req, 400, LANGUAGE_REFUSED);
        return res.status(400).json(LANGUAGE_REFUSED);
      }
      const changed = await internals.setLanguage(req.session, language, req.change);
      if (changed !== 1) throw new Error('the signed-in admin has no row to change');
      return res.status(200).json({ language });
    } catch (err) {
      return next(err);
    }
  });

  // Anything else under /auth is not a route.
  router.use((_req, res) => res.status(404).json({ error: 'not found' }));

  // A body sign-in could not read answers the one sentence -- never the
  // parser's own text, which quotes what was sent. Anything else is logged by
  // what it is, never by what it says. On sign-in, neither comes before the floor.
  router.use(async (err, req, res, _next) => {
    const onSignIn = req.method === 'POST' && req.path === '/sign-in';
    if (err?.languageRefused) {
      await refusedLanguage(req, 400, LANGUAGE_REFUSED);
      return res.status(400).json(LANGUAGE_REFUSED);
    }
    if (err?.unreadable) return refuse(req, res, 400, UNREADABLE);
    // A stored hash this code does not know is named here, PasswordHashUnrecognised.
    logFailure(req.path.replace(/^\//, ''), err);
    if (onSignIn) return refuse(req, res, 500, { error: 'internal error' });
    return res.status(500).json({ error: 'internal error' });
  });

  return router;
}
