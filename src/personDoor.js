/**
 * A trusted server asks about the admin (README, "A trusted server's door").
 *
 * Another server of the same deployment lets an admin sign in somewhere else,
 * with the password chosen here, and keeps no copy of it. It asks here, for the
 * person at its own door:
 *
 *   POST /api/v1/auth/trusted/person/check-password  {email, password, clientAddress}
 *        -> 200 the person · 401 sign-in's one refusal, whatever the reason
 *   POST /api/v1/auth/trusted/person/check           {personId, tenantId}
 *        -> 200 the person · 404 {code: 'person_gone'}
 *   POST /api/v1/auth/trusted/person/forgot-password {email, clientAddress}
 *        -> 200 forgot's one sentence, and forgot's email
 *
 * Each is authenticated by `Authorization: Bearer <the key>`, its sha256 in
 * TRUSTED_SERVER_KEY_SHA256 and compared in constant time, before anything else
 * is read. No company key can do this: no company is known before a sign-in.
 * With the setting unset the routes do not exist. With a wrong key they answer
 * what a path that is no route answers. The door is not POST /auth/sign-in, and
 * makes no session and no cookie: it says who, and the asker keeps its own.
 *
 * THE CALLER'S ADDRESS, NEVER THE ASKER'S. Everyone comes through one server,
 * so counting that server's address would let one stranger shut everyone out.
 * `clientAddress` is the person's. It is read as sign-in reads a socket's
 * (IPv4 plain, IPv6 by its /64) and counted against the SAME limit, the SAME
 * hash line and the SAME lock rows as the dashboard's sign-in: going in by this
 * door gets an address no more tries, and ten wrong passwords lock that address
 * out of that account here and there, and no other address anywhere.
 *
 * ONE REFUSAL. An unknown email, a wrong password, a locked address, a right
 * password during a lock, a hash this code cannot read, a password changed
 * while it was checked and a row held by something else all answer sign-in's
 * refusal, byte for byte, after sign-in's statements, at sign-in's floor. A
 * person with no admin account -- anyone a linked accounts module keeps -- is
 * an unknown email here: this door never asks that module.
 *
 * THE ANSWER, the same from both checks:
 *   personId, tenantId, email, language
 *   name         null: this platform keeps no person's name (/auth/me says the same)
 *   companyName  the tenant's name
 *   version      a digest that moves when the password, the email, the person
 *                or the tenant does, and with nothing else. Opaque: the stored
 *                hash goes into a sha256 and never comes out of it, and the
 *                hash's salt is in no answer, so it cannot be guessed against.
 *
 * NOTHING TOUCHES ANYONE ELSE'S ROOM. A door flooded from outside, or a database
 * gone silent, is this door's trouble alone: its connections are its own
 * (src/boundedDatabase.js), it has so many places for each kind of call, a call
 * finding them taken holds nothing, and nothing waits on the database past
 * DEADLINE_MS. Each answer that can be retried says when, in Retry-After.
 *
 * NOTHING SECRET IS WRITTEN OUT. No body, key, password, hash or email is
 * logged: a failure says its class and its code.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import { bearerFrom } from './auth.js';
import { exactly, FORGOT_SENT, LINK_RATE_LIMITED } from './accountDoors.js';
import { boundedDatabase, DatabaseDidNotAnswer, LOCK_BUSY } from './boundedDatabase.js';
import { DATABASE_UNAVAILABLE } from './db.js';
import { requestReset } from './invites.js';
import { dummyHash, MAX_PASSWORD_LENGTH, passwordLength, PasswordHashUnrecognised } from './passwords.js';
import { verifyUtf8 } from './utf8Body.js';

export const PATHS = Object.freeze({
  password: '/trusted/person/check-password',
  check: '/trusted/person/check',
  forgot: '/trusted/person/forgot-password',
});

/**
 * Places, per process. Node gives a hash one of four threads and a hash takes
 * 128 MiB, so the password check keeps two of them at most; and each of its
 * places is held to the floor, so this door hashes at most twice per floor
 * however hard it is asked. Forgot has its own, so a run of them can never shut
 * out a password or a check by id, and the other way about.
 */
export const PLACES = Object.freeze({ password: 2, check: 3, forgot: 2 });

/** The most any call takes on the database, then 503. Whole calls, not each statement. */
export const DEADLINE_MS = Object.freeze({ password: 3000, check: 2000, forgot: 2000 });

//: Room for a password at its longest, every character escaped (src/accountDoors.js).
export const BODY_LIMIT = '16kb';

export const PERSON_GONE = Object.freeze({ error: 'That person is not there.', code: 'person_gone' });
export const BODY_TOO_LARGE = Object.freeze({ error: 'The request body is too large.', code: 'body_too_large' });
const INTERNAL = Object.freeze({ error: 'internal error' });

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A counter of places: answers the function that gives one back, or null when all are taken. Never waits. */
function places(max) {
  let taken = 0;
  return () => {
    if (taken >= max) return null;
    taken += 1;
    let back = false;
    return () => {
      if (back) return;
      back = true;
      taken -= 1;
    };
  };
}

/** Sign-in's normal form, refused before anyone is looked at: a control character, or over 254. */
function emailOf(raw) {
  if (CONTROL.test(raw)) return null;
  const email = raw.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 ? email : null;
}

/** A person's address, as it is counted, or null. No zone: a person's address has none. */
function addressOf(raw, countedAddress) {
  return raw.length <= 45 && !raw.includes('%') && isIP(raw) !== 0 ? countedAddress(raw) : null;
}

/** The rule's own measure: a password of 1024 characters is one, whatever they are. */
const passwordFits = (password) => password.length > 0 && passwordLength(password) <= MAX_PASSWORD_LENGTH;

/** The opaque version of a person: see the head of this file. */
export function versionOf(row) {
  return createHash('sha256').update(JSON.stringify(['person-v1', row.id, row.tenant_id, row.email, row.password_hash])).digest('hex');
}

const presented = (row) => ({
  personId: row.id,
  tenantId: row.tenant_id,
  name: null,
  companyName: row.tenant_name,
  email: row.email,
  language: row.language,
  version: versionOf(row),
});

/** The person's row in their tenant, on a connection inside it. */
async function personRow(c, personId, tenantId) {
  return (await c.query(
    `SELECT u.id, u.tenant_id, u.email, u.language, u.password_hash, t.name AS tenant_name
       FROM operator_users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1 AND u.tenant_id = $2`,
    [personId, tenantId],
  )).rows[0] ?? null;
}

/**
 * Mount the door on sign-in's router. `answer` is sign-in's floor-held answer;
 * `line` and `limiter` its hash line and its count; `links` forgot's count and
 * email; `signIn` the rest of what they share, so there is one of each.
 */
export function mountPersonDoor(router, { settings, line, limiter, links, answer, signIn }) {
  const {
    countedAddress, internals, lockHolds, logFailure, statements, BUSY, NOBODY, RATE_LIMITED, REFUSED, UNREADABLE,
  } = signIn;
  const takePlace = { password: places(PLACES.password), check: places(PLACES.check), forgot: places(PLACES.forgot) };
  const database = boundedDatabase({ connections: PLACES.password + PLACES.check + PLACES.forgot });
  const json = express.json({ limit: BODY_LIMIT, strict: true, verify: verifyUtf8 });

  /** Not the key: on to what follows, as a path that is no route. Hashed first, so both sides are 32 bytes. */
  const trusted = (req, _res, next) => {
    const key = bearerFrom(req.get('authorization'));
    const digest = createHash('sha256').update(key ?? '').digest();
    return timingSafeEqual(digest, settings.trustedServerKey) && key !== null ? next() : next('route');
  };

  /** The door's one body cap, and the only reading of the body: any failure to read it is a fixed sentence. */
  const readBody = (req, res, next) => {
    if (!req.is('application/json')) return answer(req, res, 400, UNREADABLE).catch(next);
    return json(req, res, (err) => {
      if (!err) return next();
      return answer(req, res, err.status === 413 ? 413 : 400, err.status === 413 ? BODY_TOO_LARGE : UNREADABLE).catch(next);
    });
  };

  const busy = (req, res) => answer(req, res, 503, BUSY);

  /** A handler's failure goes to sign-in's last word on errors, never to an unhandled rejection. */
  const guarded = (handler) => (req, res, next) => handler(req, res).catch(next);

  /** The address's count, or the 429 that says how long is left. */
  const countOf = async (counter, address, req, res, refusal) => {
    const seen = counter.attempt(address);
    if (seen.allowed) return true;
    res.set('Retry-After', String(seen.retryAfterSeconds));
    await answer(req, res, 429, refusal);
    return false;
  };

  /** What could not be answered: a stall is 503 and says when, anything else is 500. Neither says why. */
  const failed = async (req, res, where, err) => {
    if (err instanceof DatabaseDidNotAnswer) {
      console.error(`[auth] ${where}: the database did not answer (${err.code}); answered 503`);
      return answer(req, res, 503, DATABASE_UNAVAILABLE);
    }
    logFailure(where, err);
    return answer(req, res, 500, INTERNAL);
  };

  /**
   * The password check, in sign-in's order and on sign-in's statements. Answers
   * the person's row, or null for the one refusal. `hashStarted` is told of the
   * hash, because one that outlives the deadline keeps its place until it ends.
   */
  const checked = async ({ email, password, address }, db, hashStarted) => {
    const found = (await db.query('SELECT * FROM resolve_operator_user($1)', [email])).rows[0] ?? null;
    const user = found ?? NOBODY;
    const lock = await db.inTenant(user.tenant_id, (c) => statements.lockRow(c, user, address));
    const locked = lockHolds(lock);
    const stored = found ? found.password_hash : await dummyHash();
    let matches = false;
    let unreadable = false;
    const hash = internals.verifyPassword(password, stored);
    hashStarted(hash);
    try {
      matches = await db.within(hash);
    } catch (err) {
      if (!(err instanceof PasswordHashUnrecognised)) throw err;
      // Not a wrong password, so it counts toward nothing; but no way in.
      logFailure('person check', err);
      unreadable = true;
    }

    if (!found || !matches || locked) {
      await db.inTenant(user.tenant_id, (c) => statements.writeFailure(c, user, address, Boolean(found) && !matches && !unreadable));
      return null;
    }
    const row = await db.inTenant(user.tenant_id, async (c) => {
      const still = await statements.holdProvedRow(c, user);
      if (still.rowCount !== 1) return null;
      await statements.clearLock(c, user, address);
      return personRow(c, user.user_id, user.tenant_id);
    });
    // The password changed while this one was being checked: as sign-in, refused and uncounted.
    if (!row) await db.inTenant(user.tenant_id, (c) => statements.writeFailure(c, user, address, false));
    return row;
  };

  router.post(PATHS.password, trusted, readBody, guarded(async (req, res) => {
    const body = exactly(req.body, ['email', 'password', 'clientAddress']);
    const email = body && emailOf(body.email);
    const address = body && addressOf(body.clientAddress, countedAddress);
    if (!email || !address || !passwordFits(body.password)) return answer(req, res, 400, UNREADABLE);
    if (!(await countOf(limiter, address, req, res, RATE_LIMITED))) return undefined;

    const giveBack = takePlace.password();
    if (!giveBack) return busy(req, res);
    const leave = line.enter(address);
    if (!leave) {
      giveBack();
      return busy(req, res);
    }
    // The line's place is for the hash, as at sign-in. The door's is held to the
    // floor and for as long as the hash runs, even one that outlives the deadline.
    let hashing = null;
    const floor = sleep(Math.max(0, req.arrivedAt + settings.refusalFloorMs - performance.now()));
    try {
      const row = await checked({ email, password: body.password, address }, database.forRequest(DEADLINE_MS.password), (hash) => {
        hashing = hash.catch(() => {}).finally(leave);
      });
      return row ? await answer(req, res, 200, presented(row)) : await answer(req, res, 401, REFUSED);
    } catch (err) {
      if (err?.code === LOCK_BUSY) {
        // Only an address with an account can meet a held row, so it must not say so.
        console.error('[auth] person check: a row was held; answered as a refusal');
        return answer(req, res, 401, REFUSED);
      }
      return failed(req, res, 'person check', err);
    } finally {
      if (hashing === null) leave();
      Promise.all([hashing, floor]).finally(giveBack);
    }
  }));

  router.post(PATHS.check, trusted, readBody, guarded(async (req, res) => {
    const body = exactly(req.body, ['personId', 'tenantId']);
    if (!body || !UUID.test(body.personId) || !UUID.test(body.tenantId)) return res.status(404).json(PERSON_GONE);
    const giveBack = takePlace.check();
    if (!giveBack) return res.status(503).set('Retry-After', '2').json(BUSY);
    try {
      const db = database.forRequest(DEADLINE_MS.check);
      const row = await db.inTenant(body.tenantId, (c) => personRow(c, body.personId, body.tenantId));
      return row ? res.json(presented(row)) : res.status(404).json(PERSON_GONE);
    } catch (err) {
      // A check by id has no floor, and says nothing a floor would hide.
      if (err instanceof DatabaseDidNotAnswer) {
        console.error(`[auth] person check by id: the database did not answer (${err.code}); answered 503`);
        return res.status(503).set('Retry-After', '2').json(DATABASE_UNAVAILABLE);
      }
      logFailure('person check by id', err);
      return res.status(500).json(INTERNAL);
    } finally {
      giveBack();
    }
  }));

  router.post(PATHS.forgot, trusted, readBody, guarded(async (req, res) => {
    const body = exactly(req.body, ['email', 'clientAddress']);
    const email = body && emailOf(body.email);
    const address = body && addressOf(body.clientAddress, countedAddress);
    if (!email || !address) return answer(req, res, 400, UNREADABLE);
    if (!(await countOf(links.forgotLimiter, address, req, res, LINK_RATE_LIMITED))) return undefined;

    const giveBack = takePlace.forgot();
    if (!giveBack) return busy(req, res);
    const floor = sleep(Math.max(0, req.arrivedAt + settings.refusalFloorMs - performance.now()));
    try {
      const made = await requestReset(email, NOBODY, database.forRequest(DEADLINE_MS.forgot));
      await answer(req, res, 200, FORGOT_SENT);
      links.sendReset(made);
      return undefined;
    } catch (err) {
      if (err?.code === LOCK_BUSY) {
        // Only an address with an account can meet a held row: the one sentence, and no link.
        console.error('[auth] person forgot: a row was held; answered as usual and no link was made');
        return answer(req, res, 200, FORGOT_SENT);
      }
      return failed(req, res, 'person forgot', err);
    } finally {
      floor.finally(giveBack);
    }
  }));
}
