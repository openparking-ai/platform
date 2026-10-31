/**
 * Passkeys (0047; README, "Passkeys for the admin"). A maintained WebAuthn
 * library does the cryptography (@simplewebauthn/server); this file keeps the
 * rows and the rules.
 *
 * ONE RELYING PARTY. PASSKEY_RP_ID is a domain that is, or is above, the host
 * of every origin in PASSKEY_ORIGINS (ADMIN_ORIGIN when unset), refused at
 * start otherwise. One passkey then works on every site of the deployment
 * under that domain. Unset, passkeys are off: `409 passkeys_not_configured`.
 *
 * THE PERSON IS VERIFIED, NOT ONLY PRESENT. Adding a passkey and signing in
 * with one ask the authenticator for user verification (`required`: Face ID, a
 * fingerprint, the device's PIN), and a response without it is refused: a key
 * anyone holding it can press is not an admin's sign-in.
 *
 * A CHALLENGE WORKS ONCE, for five minutes, for its own purpose. It is kept
 * in the database (passkey_challenges), so every process of a deployment and a
 * restart see the same ones, and taken with one DELETE, so two uses at once
 * find it once. Adding a passkey's challenge names the admin and the session
 * that asked (a SHA-256 of them). One caller address holds at most
 * CHALLENGES_PER_ADDRESS at once; ended ones are purged as new ones are made.
 *
 * A SIGN-IN finds the passkey by its credential id -- the admin's here, or a
 * linked person's through the accounts door -- and checks the signature
 * against the public key kept when it was added. Only then is the counter
 * read: one that did not go up (but for an authenticator that keeps none)
 * means a copy of the key is in use, so the sign-in is refused and the
 * admin's passkey is TURNED OFF, in the transaction that read it, and logged.
 * Every refusal is the same answer: nothing tells an unknown passkey from a
 * bad signature or a copied key.
 *
 * The password stays: a passkey is a second way in. A password reset removes
 * the admin's passkeys (src/invites.js, src/adminAccount.js), and a passkey
 * added before the password last changed is not found in any case; removing
 * the admin removes them (ON DELETE CASCADE). Neither a public key nor a
 * response is ever logged.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as swa from '@simplewebauthn/server';
import { query, withTenant } from './db.js';
import { generateDeviceToken, hashToken } from './auth.js';
import * as changes from './changes.js';
import * as accountsDoor from './accountsDoor.js';

export const MAX_PASSKEYS = 10;
export const CHALLENGE_SECONDS = 300;
//: How many live challenges one caller address may hold at once.
export const CHALLENGES_PER_ADDRESS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export class PasskeyRefused extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const NOT_CONFIGURED = Object.freeze({ error: 'This deployment has no passkeys configured. Use your password.', code: 'passkeys_not_configured' });
export const REFUSED = Object.freeze({ error: 'That passkey was not accepted. Try again, or use your password.', code: 'passkey_refused' });
export const ELSEWHERE = Object.freeze({ error: 'Your passkeys are kept where your account is kept.', code: 'passkeys_elsewhere' });

const off = () => new PasskeyRefused(409, NOT_CONFIGURED.code, NOT_CONFIGURED.error);
const refused = () => new PasskeyRefused(401, REFUSED.code, REFUSED.error);
const notFound = () => new PasskeyRefused(404, 'passkey_not_found', 'That passkey is not one of yours.');

// ---------------------------------------------------------------------------
// Settings, read when the app is made; a value not of its form refuses to start.
// ---------------------------------------------------------------------------

export function readPasskeySettings(env, adminOrigin) {
  const rpId = env.PASSKEY_RP_ID;
  if (rpId === undefined || rpId === '') return null;
  if (!DOMAIN.test(rpId)) throw new Error('PASSKEY_RP_ID must be a domain, lower case, with no scheme, port or path');
  const listed = env.PASSKEY_ORIGINS ? env.PASSKEY_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) : adminOrigin ? [adminOrigin] : [];
  if (listed.length === 0) throw new Error('PASSKEY_ORIGINS must name the origins passkeys are used from when ADMIN_ORIGIN is unset');
  const origins = listed.map((o) => {
    let url;
    try {
      url = new URL(o);
    } catch {
      throw new Error('PASSKEY_ORIGINS is a comma-separated list of origins, scheme://host[:port], with no path');
    }
    if (url.origin !== o || !['https:', 'http:'].includes(url.protocol)) {
      throw new Error('PASSKEY_ORIGINS is a comma-separated list of origins, scheme://host[:port], with no path');
    }
    if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
      throw new Error(`PASSKEY_RP_ID must be the host of every origin in PASSKEY_ORIGINS or a domain above it; ${JSON.stringify(o)} is not`);
    }
    return url.origin;
  });
  const rpName = env.PASSKEY_RP_NAME === undefined || env.PASSKEY_RP_NAME === '' ? 'Open Parking' : env.PASSKEY_RP_NAME;
  if ([...rpName].length > 60 || CONTROL.test(rpName)) throw new Error('PASSKEY_RP_NAME is a name of 1 to 60 characters');
  return { rpId, origins, rpName };
}

// ---------------------------------------------------------------------------
// Challenges, once each, in the database.
// ---------------------------------------------------------------------------

/** Who an adding challenge is for: the admin and the session, hashed; null for a sign-in's. */
const ownerOf = (owner) => (owner
  ? createHash('sha256').update(`openparking-passkey-challenge:${owner.tenantId}:${owner.userId}:${owner.sessionId}`, 'utf8').digest('hex')
  : null);

const busy = () => new PasskeyRefused(429, 'passkeys_busy', 'Too many passkey requests from here. Try again in a few minutes.');

// On an object so a test can reach in; nothing else replaces them. Each is
// one statement through query(), which tries once more on a lost connection:
// a second insert leaves one unused challenge to end, and a second take finds
// none and refuses -- neither lets anyone in.
export const challenges = {
  /** A new challenge's id; `passkeys_busy` when this address holds its share already. */
  async make(purpose, challenge, address, owner = null) {
    const { rows } = await query(
      `WITH purged AS (
         DELETE FROM passkey_challenges WHERE expires_at <= now()
       ), held AS (
         SELECT count(*)::int AS n FROM passkey_challenges WHERE address = $4 AND expires_at > now()
       )
       INSERT INTO passkey_challenges (purpose, challenge, owner, address, expires_at)
       SELECT $1, $2, $3, $4, now() + make_interval(secs => $5) FROM held WHERE held.n < $6
       RETURNING id`,
      [purpose, challenge, ownerOf(owner), String(address ?? 'unknown').slice(0, 64), CHALLENGE_SECONDS, CHALLENGES_PER_ADDRESS],
    );
    if (!rows[0]) throw busy();
    return rows[0].id;
  },

  /** The challenge `id` names, used up now; null when it is not one, has ended, or is someone else's. */
  async use(id, purpose, owner = null) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const c = (await query(
      'DELETE FROM passkey_challenges WHERE id = $1 RETURNING challenge, purpose, owner, expires_at > now() AS live',
      [id],
    )).rows[0];
    if (!c) return null;
    const mine = c.purpose === purpose && c.owner === ownerOf(owner);
    return mine && c.live ? c.challenge : null;
  },
};

const challengeText = () => randomBytes(32).toString('base64url');

// ---------------------------------------------------------------------------
// The admin's own passkeys.
// ---------------------------------------------------------------------------

function passkeyName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '' || [...name].length > 60 || CONTROL.test(name)) {
    throw new PasskeyRefused(400, 'passkey_name_refused', "A passkey's name is 1 to 60 characters.");
  }
  return name;
}

const view = (p) => ({ id: p.id, name: p.name, created_at: p.created_at, last_used_at: p.last_used_at, disabled_at: p.disabled_at ?? null });

export async function registrationOptions(passkeys, admin, address) {
  if (!passkeys) throw off();
  const existing = await withTenant(admin.tenantId, async (c) =>
    (await c.query('SELECT credential_id, transports FROM operator_passkeys WHERE user_id = $1', [admin.userId])).rows);
  if (existing.length >= MAX_PASSKEYS) throw new PasskeyRefused(409, 'passkeys_full', `You have ${MAX_PASSKEYS} passkeys. Remove one first.`);
  const options = await swa.generateRegistrationOptions({
    rpName: passkeys.rpName,
    rpID: passkeys.rpId,
    userName: admin.email,
    userID: Buffer.from(admin.userId, 'utf8'),
    challenge: challengeText(),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    timeout: CHALLENGE_SECONDS * 1000,
  });
  return { challenge_id: await challenges.make('register', options.challenge, address, admin), options };
}

export async function addPasskey(passkeys, admin, body, ctx) {
  if (!passkeys) throw off();
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const name = passkeyName(b.name);
  if (!b.response || typeof b.response !== 'object' || Array.isArray(b.response)) {
    throw new PasskeyRefused(400, 'passkey_unreadable', 'The passkey request could not be read.');
  }
  const expectedChallenge = await challenges.use(b.challenge_id, 'register', admin);
  if (!expectedChallenge) throw new PasskeyRefused(409, 'passkey_challenge_ended', 'That took too long, or was already used. Start again.');
  let out;
  try {
    out = await swa.verifyRegistrationResponse({
      response: b.response, expectedChallenge, expectedOrigin: passkeys.origins, expectedRPID: passkeys.rpId, requireUserVerification: true,
    });
  } catch {
    out = null;
  }
  if (!out?.verified) throw new PasskeyRefused(400, 'passkey_not_added', 'That passkey could not be added. Try again.');
  const { credential } = out.registrationInfo;
  return withTenant(admin.tenantId, async (c) => {
    await c.query('SELECT 1 FROM operator_users WHERE id = $1 FOR UPDATE', [admin.userId]);
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM operator_passkeys WHERE user_id = $1', [admin.userId]);
    if (n >= MAX_PASSKEYS) throw new PasskeyRefused(409, 'passkeys_full', `You have ${MAX_PASSKEYS} passkeys. Remove one first.`);
    let row;
    try {
      row = (await c.query(
        `INSERT INTO operator_passkeys (tenant_id, user_id, credential_id, public_key, counter, transports, name)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, created_at, last_used_at, disabled_at`,
        [admin.tenantId, admin.userId, credential.id, Buffer.from(credential.publicKey), credential.counter ?? 0,
          (credential.transports ?? []).filter((t) => typeof t === 'string' && /^[a-z-]{1,20}$/.test(t)).slice(0, 8), name],
      )).rows[0];
    } catch (err) {
      if (err.constraint === 'operator_passkeys_credential_id_key') {
        throw new PasskeyRefused(409, 'passkey_known', 'That passkey is already kept here.');
      }
      throw err;
    }
    await changes.record(c, ctx, {
      garageId: null, action: 'passkey.add', subject: { kind: 'passkey', id: row.id, name: row.name }, before: null, after: { name: row.name },
    });
    return view(row);
  });
}

export async function listPasskeys(admin) {
  return withTenant(admin.tenantId, async (c) =>
    (await c.query('SELECT id, name, created_at, last_used_at, disabled_at FROM operator_passkeys WHERE user_id = $1 ORDER BY created_at, id', [admin.userId])).rows.map(view));
}

export async function renamePasskey(admin, body, ctx) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (Object.keys(b).some((k) => k !== 'id' && k !== 'name')) throw new PasskeyRefused(400, 'passkey_name_refused', "A passkey's name is 1 to 60 characters.");
  const id = b.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
  const name = passkeyName(b.name);
  return withTenant(admin.tenantId, async (c) => {
    const was = (await c.query('SELECT name FROM operator_passkeys WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, admin.userId])).rows[0];
    if (!was) throw notFound();
    const row = (await c.query('UPDATE operator_passkeys SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id, name, created_at, last_used_at, disabled_at', [id, admin.userId, name])).rows[0];
    await changes.record(c, ctx, {
      garageId: null, action: 'passkey.rename', subject: { kind: 'passkey', id, name }, before: { name: was.name }, after: { name },
    });
    return view(row);
  });
}

export async function removePasskey(admin, body, ctx) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const id = Object.keys(b).length === 1 ? b.id : undefined;
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
  return withTenant(admin.tenantId, async (c) => {
    const gone = (await c.query('DELETE FROM operator_passkeys WHERE id = $1 AND user_id = $2 RETURNING name', [id, admin.userId])).rows[0];
    if (!gone) throw notFound();
    await changes.record(c, ctx, {
      garageId: null, action: 'passkey.remove', subject: { kind: 'passkey', id, name: gone.name }, before: { name: gone.name }, after: null,
    });
  });
}

// ---------------------------------------------------------------------------
// Signing in with one.
// ---------------------------------------------------------------------------

export async function signInOptions(passkeys, address) {
  if (!passkeys) throw off();
  const options = await swa.generateAuthenticationOptions({
    rpID: passkeys.rpId, userVerification: 'required', challenge: challengeText(), timeout: CHALLENGE_SECONDS * 1000,
  });
  return { challenge_id: await challenges.make('sign_in', options.challenge, address), options };
}

// On an object so a test can reach in; nothing else replaces them.
export const internals = {
  /**
   * The signature, the origin, the relying party, the challenge and user
   * verification -- not the counter: the library is handed 0, so it never
   * refuses one before the signature is known to hold. The counter is this
   * file's to judge, after (checkSignIn).
   */
  async verify(passkeys, response, expectedChallenge, credential) {
    try {
      return await swa.verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: passkeys.origins, expectedRPID: passkeys.rpId, requireUserVerification: true,
        credential: { ...credential, counter: 0 },
      });
    } catch {
      return null;
    }
  },

  /**
   * The admin's passkey used with counter `next`, in one transaction holding
   * its row: moved on when it went up (or both are 0: an authenticator that
   * keeps none), or else TURNED OFF, with its line in the change log. Two
   * sign-ins at once with one counter: one moves it, the other finds it moved
   * and turns the passkey off. Answers 'used', 'turned_off', or 'gone' when
   * there is no live passkey to judge.
   */
  async useAdminPasskey(tenantId, passkeyId, next) {
    return withTenant(tenantId, async (c) => {
      // Held from this read to the commit: a second sign-in at the same moment
      // reads the counter this one leaves.
      const row = (await c.query(
        'SELECT id, name, (counter < $2 OR (counter = 0 AND $2 = 0)) AS went_up FROM operator_passkeys WHERE id = $1 AND disabled_at IS NULL FOR UPDATE',
        [passkeyId, next],
      )).rows[0];
      if (!row) return 'gone';
      if (row.went_up) {
        await c.query('UPDATE operator_passkeys SET counter = $2, last_used_at = now() WHERE id = $1', [passkeyId, next]);
        return 'used';
      }
      await c.query('UPDATE operator_passkeys SET disabled_at = now() WHERE id = $1', [passkeyId]);
      // Its line, in the same transaction: the platform turned it off, nobody signed in.
      await changes.record(c, { tenantId, actor: { kind: 'nobody', id: null }, count: 0, unchanged: false, secrets: [], private: [] }, {
        garageId: null, action: 'passkey.turn_off', subject: { kind: 'passkey', id: row.id, name: row.name },
        before: { turned_off: false }, after: { turned_off: true, why: 'counter_not_up' },
      });
      return 'turned_off';
    });
  },
};

/** A copied key, said in a log line: which passkey, never its key, counter or response. */
const logCopied = (where, ids) => console.error(`[auth] passkey sign-in refused: the counter did not go up (a copy of the key?); ${where} ${ids}`);

/**
 * Who a sign-in response proves: `{kind: 'admin', userId, tenantId}` or
 * `{kind: 'linked', person}` (the accounts door's answer). Throws REFUSED, the
 * same for every reason, or AccountsUndecided when the door cannot answer.
 */
export async function checkSignIn(passkeys, body) {
  if (!passkeys) throw off();
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const response = b.response && typeof b.response === 'object' && !Array.isArray(b.response) ? b.response : null;
  const credentialId = response && typeof response.id === 'string' && accountsDoor.CREDENTIAL.test(response.id) ? response.id : null;
  const expectedChallenge = await challenges.use(b.challenge_id, 'sign_in');
  if (!expectedChallenge || !credentialId) throw refused();

  const admin = (await query('SELECT * FROM resolve_operator_passkey($1)', [credentialId])).rows[0] ?? null;
  const linked = admin ? null : accountsDoor.doorConfigured() ? await accountsDoor.passkey(credentialId) : null;
  if (!admin && !linked) throw refused();
  const stored = admin ? Number(admin.counter) : linked.counter;
  const out = await internals.verify(passkeys, response, expectedChallenge, {
    id: credentialId,
    publicKey: new Uint8Array(admin ? admin.public_key : linked.publicKey),
    counter: stored,
    transports: admin ? admin.transports : linked.transports,
  });
  if (!out?.verified) throw refused();
  const next = out.authenticationInfo.newCounter;

  if (admin) {
    const used = await internals.useAdminPasskey(admin.tenant_id, admin.passkey_id, next);
    if (used === 'turned_off') logCopied('the admin\'s passkey is turned off:', `passkey ${admin.passkey_id}, tenant ${admin.tenant_id}`);
    if (used !== 'used') throw refused();
    return { kind: 'admin', userId: admin.user_id, tenantId: admin.tenant_id };
  }
  // A linked person's passkey is the module's to turn off; it is told the
  // counter, and refuses one that did not go up. Refused here first, too.
  if ((next > 0 || stored > 0) && next <= stored) {
    logCopied('a linked person\'s passkey, for the module to judge:', `person ${linked.person}, tenant ${linked.tenant}`);
    throw refused();
  }
  if (!(await accountsDoor.passkeyUsed(credentialId, next))) throw refused();
  const person = await accountsDoor.who(linked.tenant, linked.person);
  // The module's answer must be the person the passkey named, in that tenant.
  if (!person || person.tenant !== linked.tenant || person.person !== linked.person) throw refused();
  return { kind: 'linked', person };
}

/** A session for the admin a passkey proved; null when the admin is no longer there. */
export async function mintAdminSession(proved, settings) {
  const token = generateDeviceToken();
  const row = await withTenant(proved.tenantId, async (c) => {
    const admin = (await c.query('SELECT email, language FROM operator_users WHERE id = $1 FOR SHARE', [proved.userId])).rows[0];
    if (!admin) return null;
    const session = (await c.query(
      `INSERT INTO operator_tokens (tenant_id, name, token_hash, kind, user_id, expires_at, last_seen_at)
       VALUES ($1, 'sign-in', $2, 'session', $3, now() + make_interval(secs => $4), now())
       RETURNING id, expires_at, last_seen_at + make_interval(secs => $5) AS idle_ends_at`,
      [proved.tenantId, hashToken(token), proved.userId, settings.maxSeconds, settings.idleSeconds],
    )).rows[0];
    return { ...session, email: admin.email, language: admin.language };
  });
  return row ? { token, row } : null;
}
