/**
 * Passkeys (0035; README, "Passkeys for the admin"). A maintained WebAuthn
 * library does the cryptography (@simplewebauthn/server); this file keeps the
 * rows and the rules.
 *
 * ONE RELYING PARTY. PASSKEY_RP_ID is a domain that is, or is above, the host
 * of every origin in PASSKEY_ORIGINS (ADMIN_ORIGIN when unset), refused at
 * start otherwise. One passkey then works on every site of the deployment
 * under that domain. Unset, passkeys are off: `409 passkeys_not_configured`.
 *
 * A CHALLENGE WORKS ONCE, for five minutes, for its own purpose, and adding a
 * passkey is the signed-in admin's own: the challenge names them. Challenges
 * are held in this process.
 *
 * A SIGN-IN finds the passkey by its credential id -- the admin's here, or a
 * linked person's through the accounts door -- checks the signature against
 * the public key kept when it was added, and refuses a counter that did not go
 * up (a copied key) unless the authenticator keeps none. Every refusal is the
 * same answer: nothing tells an unknown passkey from a bad signature or a
 * copied key.
 *
 * The password stays: a passkey is a second way in. A password reset keeps
 * the admin's passkeys; removing the admin removes them (ON DELETE CASCADE).
 * Neither a public key nor a response is ever logged.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as swa from '@simplewebauthn/server';
import { query, withTenant } from './db.js';
import { generateDeviceToken, hashToken } from './auth.js';
import * as changes from './changes.js';
import * as accountsDoor from './accountsDoor.js';

export const MAX_PASSKEYS = 10;
export const CHALLENGE_SECONDS = 300;
const MAX_CHALLENGES = 10_000;
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
// Challenges, once each, in this process.
// ---------------------------------------------------------------------------

const challenges = new Map();

function newChallenge(purpose, challenge, owner = null) {
  if (challenges.size >= MAX_CHALLENGES) {
    const now = Date.now();
    for (const [id, c] of challenges) if (c.expiresAt <= now) challenges.delete(id);
    if (challenges.size >= MAX_CHALLENGES) throw new PasskeyRefused(503, 'passkeys_busy', 'Passkeys are busy. Try again in a moment.');
  }
  const id = randomUUID();
  challenges.set(id, { challenge, purpose, tenantId: owner?.tenantId ?? null, userId: owner?.userId ?? null, expiresAt: Date.now() + CHALLENGE_SECONDS * 1000 });
  return id;
}

/** The challenge `id` names, used up now; null when it is not one, has ended, or is someone else's. */
function useChallenge(id, purpose, owner = null) {
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  const c = challenges.get(id);
  if (!c) return null;
  challenges.delete(id);
  const mine = c.purpose === purpose && c.tenantId === (owner?.tenantId ?? null) && c.userId === (owner?.userId ?? null);
  return mine && c.expiresAt > Date.now() ? c.challenge : null;
}

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

const view = (p) => ({ id: p.id, name: p.name, created_at: p.created_at, last_used_at: p.last_used_at });

export async function registrationOptions(passkeys, admin) {
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
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    timeout: CHALLENGE_SECONDS * 1000,
  });
  return { challenge_id: newChallenge('register', options.challenge, admin), options };
}

export async function addPasskey(passkeys, admin, body, ctx) {
  if (!passkeys) throw off();
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const name = passkeyName(b.name);
  if (!b.response || typeof b.response !== 'object' || Array.isArray(b.response)) {
    throw new PasskeyRefused(400, 'passkey_unreadable', 'The passkey request could not be read.');
  }
  const expectedChallenge = useChallenge(b.challenge_id, 'register', admin);
  if (!expectedChallenge) throw new PasskeyRefused(409, 'passkey_challenge_ended', 'That took too long, or was already used. Start again.');
  let out;
  try {
    out = await swa.verifyRegistrationResponse({
      response: b.response, expectedChallenge, expectedOrigin: passkeys.origins, expectedRPID: passkeys.rpId, requireUserVerification: false,
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
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, created_at, last_used_at`,
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
    (await c.query('SELECT id, name, created_at, last_used_at FROM operator_passkeys WHERE user_id = $1 ORDER BY created_at, id', [admin.userId])).rows.map(view));
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
    const row = (await c.query('UPDATE operator_passkeys SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id, name, created_at, last_used_at', [id, admin.userId, name])).rows[0];
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

export async function signInOptions(passkeys) {
  if (!passkeys) throw off();
  const options = await swa.generateAuthenticationOptions({
    rpID: passkeys.rpId, userVerification: 'preferred', challenge: challengeText(), timeout: CHALLENGE_SECONDS * 1000,
  });
  return { challenge_id: newChallenge('sign_in', options.challenge), options };
}

// On an object so a test can reach in; nothing else replaces them.
export const internals = {
  async verify(passkeys, response, expectedChallenge, credential) {
    try {
      return await swa.verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: passkeys.origins, expectedRPID: passkeys.rpId, requireUserVerification: false, credential,
      });
    } catch {
      return null;
    }
  },
};

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
  const expectedChallenge = useChallenge(b.challenge_id, 'sign_in');
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
    // Two sign-ins with one response at once: only one moves the counter (or
    // both stay at 0 on an authenticator that keeps none).
    const moved = await withTenant(admin.tenant_id, async (c) => (await c.query(
      'UPDATE operator_passkeys SET counter = $2, last_used_at = now() WHERE id = $1 AND (counter < $2 OR (counter = 0 AND $2 = 0)) RETURNING id',
      [admin.passkey_id, next])).rowCount);
    if (!moved) throw refused();
    return { kind: 'admin', userId: admin.user_id, tenantId: admin.tenant_id };
  }
  if (!(await accountsDoor.passkeyUsed(credentialId, next))) throw refused();
  const person = await accountsDoor.who(linked.tenant, linked.person);
  if (!person) throw refused();
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
