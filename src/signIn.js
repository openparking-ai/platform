/**
 * The owner signs in (0024).
 *
 * One admin per tenant, an email and a password. A sign-in IS a session token
 * minted the way operator tokens are (random 32 bytes, its sha256 stored), so
 * every operator route works unchanged behind it. The session travels in a
 * cookie page script can never read.
 *
 *   POST /api/v1/auth/sign-in    {email, password} -> the cookie, and who and until when
 *   POST /api/v1/auth/sign-out   revokes the session row
 *   GET  /api/v1/auth/me         email, tenant, when the session ends
 *
 * What each rule is for, because each is one of the ways sign-in went wrong on
 * the maintainer's other systems:
 *
 * NO ORACLE. An unknown email, a wrong password and a locked address answer
 * the SAME status and the SAME body, and each runs exactly one hash -- an
 * unknown email is checked against a hash of nothing anyone knows.
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
 * CROSS-SITE. The cookie is `SameSite=Strict`, and a request that CHANGES
 * something and is authenticated by the cookie must carry an `Origin` equal
 * to ADMIN_ORIGIN, or it is refused. A sign-in carrying a foreign Origin is
 * refused too, and one not sent as JSON cannot be read. The admin site is
 * served same-origin as `/api`: there is no CORS here.
 */
import express from 'express';
import { isIPv6 } from 'node:net';
import { pool, withTenant } from './db.js';
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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ---------------------------------------------------------------------------
// Settings, read when the app is made. A value that is not one of the forms
// below is refused at start, never guessed at.
// ---------------------------------------------------------------------------

function positive(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, not ${JSON.stringify(raw)}`);
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
  const idleMinutes = positive(env, 'SESSION_IDLE_MINUTES', 30);
  const maxHours = positive(env, 'SESSION_MAX_HOURS', 12);
  if (idleMinutes * 60 > maxHours * 3600) throw new Error('SESSION_IDLE_MINUTES cannot be longer than SESSION_MAX_HOURS');
  let trustProxy = null;
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== '') {
    trustProxy = /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY;
  }
  return {
    adminOrigin,
    cookieSecure: insecure !== 'true',
    idleSeconds: Math.round(idleMinutes * 60),
    maxSeconds: Math.round(maxHours * 3600),
    trustProxy,
    attemptsPerAddress: Math.round(positive(env, 'SIGN_IN_ATTEMPTS_PER_ADDRESS', 30)),
    attemptsWindowSeconds: Math.round(positive(env, 'SIGN_IN_ATTEMPTS_WINDOW_MINUTES', 15) * 60),
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

  async lockOf(user, address) {
    return withTenant(user.tenant_id, async (c) =>
      (await c.query('SELECT failed_count, locked_until FROM operator_sign_in_locks WHERE user_id = $1 AND address = $2', [user.user_id, address])).rows[0] ?? null);
  },

  async recordFailure(user, address) {
    await withTenant(user.tenant_id, (c) =>
      c.query(
        `INSERT INTO operator_sign_in_locks AS l (tenant_id, user_id, address, failed_count, locked_until)
         VALUES ($1, $2, $3, 1, CASE WHEN 1 >= $4 THEN now() + make_interval(mins => $5) END)
         ON CONFLICT (user_id, address) DO UPDATE SET
           failed_count = l.failed_count + 1,
           locked_until = CASE WHEN l.failed_count + 1 >= $4 THEN now() + make_interval(mins => $5) ELSE l.locked_until END,
           updated_at = now()`,
        [user.tenant_id, user.user_id, address, MAX_FAILED, LOCK_MINUTES],
      ));
  },

  async mintSession(user, address, settings) {
    const token = generateDeviceToken();
    const row = await withTenant(user.tenant_id, async (c) => {
      await c.query('DELETE FROM operator_sign_in_locks WHERE user_id = $1 AND address = $2', [user.user_id, address]);
      // This user's ended sessions are of no further use to anyone.
      await c.query(
        `DELETE FROM operator_tokens WHERE user_id = $1 AND kind = 'session'
           AND (revoked_at IS NOT NULL OR expires_at <= now() OR last_seen_at <= now() - make_interval(secs => $2))`,
        [user.user_id, settings.idleSeconds],
      );
      return (await c.query(
        `INSERT INTO operator_tokens (tenant_id, name, token_hash, kind, user_id, expires_at, last_seen_at)
         VALUES ($1, 'sign-in', $2, 'session', $3, now() + make_interval(secs => $4), now())
         RETURNING id, expires_at, last_seen_at + make_interval(secs => $5) AS idle_ends_at`,
        [user.tenant_id, hashToken(token), user.user_id, settings.maxSeconds, settings.idleSeconds],
      )).rows[0];
    });
    return { token, row };
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

export function createAuthRouter(settings) {
  const router = express.Router();
  const limiter = addressLimiter({ max: settings.attemptsPerAddress, windowSeconds: settings.attemptsWindowSeconds });
  // Made before the first request, so an unknown email's one hash is the
  // check, not the making of the hash it is checked against.
  dummyHash().catch(() => {});

  router.use(noStore);
  router.use(express.json({ limit: '4kb' }));

  router.post('/sign-in', async (req, res, next) => {
    try {
      if (settings.adminOrigin === null) return res.status(409).json(NOT_CONFIGURED);
      const origin = req.get('origin');
      if (origin !== undefined && origin !== settings.adminOrigin) return res.status(403).json(ORIGIN_REFUSED);
      if (!req.is('application/json')) return res.status(400).json(UNREADABLE);
      const body = signInBody(req.body);
      if (!body) return res.status(400).json(UNREADABLE);
      const address = callerAddress(req, settings);
      if (!limiter.take(address)) return res.status(429).json(RATE_LIMITED);

      const user = (await pool.query('SELECT * FROM resolve_operator_user($1)', [body.email])).rows[0] ?? null;
      const lock = user ? await internals.lockOf(user, address) : null;
      const locked = Boolean(lock?.locked_until && new Date(lock.locked_until) > new Date());
      const matches = await internals.verifyPassword(body.password, user ? user.password_hash : await dummyHash());

      if (!user) return res.status(401).json(REFUSED);
      if (!matches) {
        await internals.recordFailure(user, address);
        return res.status(401).json(REFUSED);
      }
      if (locked) return res.status(401).json(REFUSED);

      const { token, row } = await internals.mintSession(user, address, settings);
      setCookie(res, settings, token);
      return res.status(200).json({
        email: body.email,
        tenant_id: user.tenant_id,
        session_ends_at: endsAt({ expires_at: row.expires_at, idle_ends_at: row.idle_ends_at }).toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  /** The session the cookie names, or a 401 that says which: never signed in, or ended. */
  const session = async (req, res, next) => {
    try {
      const token = sessionToken(req);
      if (token === null) return res.status(401).json(SIGN_IN_REQUIRED);
      if (!originAllows(req, settings)) return res.status(403).json(ORIGIN_REFUSED);
      const found = await resolveSession(token, settings);
      if (!found) {
        clearCookie(res, settings);
        return res.status(401).json(SESSION_ENDED);
      }
      req.session = found;
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

  router.get('/me', session, (req, res) => {
    res.json({ email: req.session.email, tenant_id: req.session.tenant_id, session_ends_at: endsAt(req.session).toISOString() });
  });

  // Anything else under /auth is not a route.
  router.use((_req, res) => res.status(404).json({ error: 'not found' }));

  // A body the parser could not read answers the one sentence -- never the
  // parser's own text, which quotes what was sent. Anything else is logged by
  // what it is, never by what it says.
  router.use((err, req, res, _next) => {
    if (err?.type?.startsWith?.('entity.') || err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported'
      || err?.type === 'request.aborted' || err?.type === 'request.size.invalid' || err?.type === 'stream.encoding.set') {
      return res.status(400).json(UNREADABLE);
    }
    // A stored hash this code does not know is named here, PasswordHashUnrecognised.
    logFailure(req.path.replace(/^\//, ''), err);
    return res.status(500).json({ error: 'internal error' });
  });

  return router;
}
