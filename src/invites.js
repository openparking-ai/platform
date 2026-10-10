/**
 * Invites and password resets (0032): the rows behind the links, and what the
 * `invite-admin` command and the four public doors do with them.
 *
 * A LINK is 32 random bytes, url-safe, prefixed by what it is for (`opi_` an
 * invite, `opr_` a reset) so a leaked one is plain to see. It is shown once,
 * in the email, and never stored: the rows hold its SHA-256 (`hashToken`), so
 * this database holds no link that works. It travels in the URL fragment
 * (`<ADMIN_ORIGIN>/#invite=…`), which no browser sends, and comes back in a
 * POST body. Nothing here writes a link, or a token, anywhere else.
 *
 * AN INVITE lasts seven days and works once. A tenant has at most one live
 * invite and an email at most one (unused and not replaced). A resend stamps
 * the live one `replaced_at` and makes a new one, in one transaction: the old
 * link then says "replaced", not "ready".
 *
 * A RESET lasts one hour and works once; a new one replaces the one before.
 * Using it chooses a new password, ends every session of the admin and clears
 * every sign-in lock on it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { pool, withTenant } from './db.js';
import { hashToken } from './auth.js';
import { AdminCommandRefused, normalEmail } from './adminAccount.js';
import { assertCanSend, EmailNotSent, sendEmail } from './email.js';
import { inviteEmail } from './emailText.js';

export const INVITE_DAYS = 7;
export const RESET_MINUTES = 60;

export const INVITE_TOKEN = /^opi_[A-Za-z0-9_-]{43}$/;
export const RESET_TOKEN = /^opr_[A-Za-z0-9_-]{43}$/;

export const newInviteToken = () => `opi_${randomBytes(32).toString('base64url')}`;
export const newResetToken = () => `opr_${randomBytes(32).toString('base64url')}`;

/** The links, on the admin site, the token in the fragment. */
export const inviteLink = (adminOrigin, token) => `${adminOrigin}/#invite=${token}`;
export const resetLink = (adminOrigin, token) => `${adminOrigin}/#reset=${token}`;

//: What a link can be, as the status door says it.
export const LINK_STATUSES = Object.freeze(['ready', 'used', 'expired', 'replaced', 'invalid']);

/** The status of a row a link named, read now; `invalid` when it named none. */
export function linkStatus(row, now = new Date()) {
  if (!row) return 'invalid';
  if (row.used_at) return 'used';
  if (row.replaced_at) return 'replaced';
  if (new Date(row.expires_at) <= now) return 'expired';
  return 'ready';
}

/** The invite a token names, and its status. A token not of the invite's shape names none. */
export async function findInvite(token) {
  if (typeof token !== 'string' || !INVITE_TOKEN.test(token)) return { status: 'invalid', invite: null };
  const invite = (await pool.query('SELECT * FROM resolve_operator_invite($1)', [hashToken(token)])).rows[0] ?? null;
  return { status: linkStatus(invite), invite };
}

/** The reset a token names, and its status. */
export async function findReset(token) {
  if (typeof token !== 'string' || !RESET_TOKEN.test(token)) return { status: 'invalid', reset: null };
  const reset = (await pool.query('SELECT * FROM resolve_operator_password_reset($1)', [hashToken(token)])).rows[0] ?? null;
  return { status: linkStatus(reset), reset };
}

// ---------------------------------------------------------------------------
// The command: `invite-admin`.
// ---------------------------------------------------------------------------

//: A company's name as the tenant is named: what the invite email says.
export const COMPANY_NAME_MAX = 120;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function companyName(raw) {
  const name = String(raw ?? '').trim();
  if (name === '' || [...name].length > COMPANY_NAME_MAX || CONTROL.test(name)) {
    throw new AdminCommandRefused(`the company name is text of 1 to ${COMPANY_NAME_MAX} characters, with no control characters; nothing was changed`);
  }
  return name;
}

function emailAddress(raw) {
  const email = normalEmail(raw);
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new AdminCommandRefused('that is not an email address; nothing was changed');
  }
  return email;
}

function languageOf(raw, fallback = 'en') {
  if (raw === undefined) return fallback;
  if (raw !== 'en' && raw !== 'es') throw new AdminCommandRefused('the language is en or es; nothing was changed');
  return raw;
}

/** A tenant's slug: its name in plain letters, and a piece of its id so two of one name differ. */
function slugOf(name, id) {
  const words = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${words || 'tenant'}-${id.slice(0, 8)}`;
}

/** Everything a send needs, checked before anything is stored: refused in plain words otherwise. */
function readyToSend({ adminOrigin, email }) {
  if (!adminOrigin) {
    throw new AdminCommandRefused('no admin origin is configured here (ADMIN_ORIGIN), so an invite link would lead nowhere; nothing was changed');
  }
  try {
    assertCanSend(email);
  } catch (err) {
    if (err instanceof EmailNotSent) throw new AdminCommandRefused(`${err.message}; nothing was changed`);
    throw err;
  }
}

async function refuseAnAdmin(email) {
  const { rows } = await pool.query('SELECT 1 FROM resolve_operator_user($1)', [email]);
  if (rows.length) throw new AdminCommandRefused('that email already names an admin; nothing was changed');
}

/** The new invite row, in the transaction `c` holds. Answers its end. */
async function insertInvite(c, { tenantId, email, language, token }) {
  return (await c.query(
    `INSERT INTO operator_invites (tenant_id, email, language, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING expires_at`,
    [tenantId, email, language, hashToken(token), INVITE_DAYS],
  )).rows[0].expires_at;
}

/**
 * Send the invite inside the transaction that stored it: a send that fails
 * throws, and the transaction stores nothing.
 */
async function sendInvite(settings, { email, language, company, token, expiresAt }) {
  try {
    await sendEmail(settings.email, { to: email, ...inviteEmail(language, { company, link: inviteLink(settings.adminOrigin, token), expiresAt }) });
  } catch (err) {
    if (err instanceof EmailNotSent) throw new AdminCommandRefused(`the invite email was not sent: ${err.message}; nothing was changed`);
    throw err;
  }
}

/**
 * A new tenant named `name`, and an invite for `email` to become its admin,
 * emailed. All of it or none: the tenant, the invite and the email are one
 * transaction, and a refusal or a failed send leaves nothing stored.
 */
export async function inviteAdmin({ name, email, language }, settings) {
  const company = companyName(name);
  const address = emailAddress(email);
  const lang = languageOf(language);
  readyToSend(settings);
  await refuseAnAdmin(address);
  const tenantId = randomUUID();
  const token = newInviteToken();
  try {
    const expiresAt = await withTenant(tenantId, async (c) => {
      await c.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [tenantId, slugOf(company, tenantId), company]);
      const ends = await insertInvite(c, { tenantId, email: address, language: lang, token });
      await sendInvite(settings, { email: address, language: lang, company, token, expiresAt: ends });
      return ends;
    });
    return { email: address, tenantId, expiresAt };
  } catch (err) {
    if (err.constraint === 'operator_invites_one_live_per_email') {
      throw new AdminCommandRefused('that email already has an invite waiting: send it again with --resend <email>; nothing was changed');
    }
    throw err;
  }
}

/**
 * The live invite of `email` replaced by a new one, emailed. The old link
 * then says "replaced". All of it or none, as above.
 */
export async function resendInvite({ email, language }, settings) {
  const address = emailAddress(email);
  if (language !== undefined) languageOf(language);
  readyToSend(settings);
  await refuseAnAdmin(address);
  const live = (await pool.query('SELECT * FROM resolve_operator_invite_for_email($1)', [address])).rows[0];
  if (!live) throw new AdminCommandRefused('no invite is waiting for that email; nothing was changed');
  const lang = languageOf(language, live.language);
  const token = newInviteToken();
  const expiresAt = await withTenant(live.tenant_id, async (c) => {
    const replaced = await c.query(
      `UPDATE operator_invites SET replaced_at = now()
        WHERE id = $1 AND tenant_id = $2 AND used_at IS NULL AND replaced_at IS NULL`,
      [live.invite_id, live.tenant_id],
    );
    if (replaced.rowCount !== 1) throw new AdminCommandRefused('that invite changed while it was being replaced; nothing was changed, run it again');
    const company = (await c.query('SELECT name FROM tenants WHERE id = $1', [live.tenant_id])).rows[0].name;
    const ends = await insertInvite(c, { tenantId: live.tenant_id, email: address, language: lang, token });
    await sendInvite(settings, { email: address, language: lang, company, token, expiresAt: ends });
    return ends;
  });
  return { email: address, tenantId: live.tenant_id, expiresAt };
}

// ---------------------------------------------------------------------------
// The doors' work. The HTTP side is src/accountDoors.js.
// ---------------------------------------------------------------------------

/**
 * Accept a ready invite: the admin made with `passwordHash`, the invite marked
 * used, in one transaction that holds the invite. Answers the new admin, or
 * `{ status }` when the invite was no longer ready by then, or `{ refused }`
 * when the account or the email already has its admin.
 */
export async function acceptInvite(invite, { passwordHash, language }) {
  try {
    return await withTenant(invite.tenant_id, async (c) => {
      const held = (await c.query(
        `SELECT id, email, expires_at, used_at, replaced_at FROM operator_invites
          WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [invite.invite_id, invite.tenant_id],
      )).rows[0] ?? null;
      const status = linkStatus(held);
      if (status !== 'ready') return { status };
      const user = (await c.query(
        `INSERT INTO operator_users (tenant_id, email, password_hash, language) VALUES ($1, $2, $3, $4)
         RETURNING id AS user_id, tenant_id, email, password_hash`,
        [invite.tenant_id, held.email, passwordHash, language],
      )).rows[0];
      await c.query('UPDATE operator_invites SET used_at = now() WHERE id = $1', [held.id]);
      const company = (await c.query('SELECT name FROM tenants WHERE id = $1', [invite.tenant_id])).rows[0]?.name ?? '';
      return { user, company };
    });
  } catch (err) {
    if (err.constraint === 'operator_users_tenant_id_key') return { refused: 'has_admin' };
    if (err.constraint === 'operator_users_email_key') return { refused: 'email_taken' };
    throw err;
  }
}

/**
 * A reset for the admin `email` names, made the same way whether or not it
 * names one: the same statements run, and for nobody they find and write
 * nothing (`nobody` is sign-in's NOBODY). Answers what to send, or null.
 */
export async function requestReset(email, nobody) {
  const found = (await pool.query('SELECT * FROM resolve_operator_user($1)', [email])).rows[0] ?? null;
  const user = found ?? nobody;
  const token = newResetToken();
  const made = await withTenant(user.tenant_id, async (c) => {
    // A day after it was made, a reset is of no further use to anyone.
    await c.query(`DELETE FROM operator_password_resets WHERE user_id = $1 AND created_at < now() - interval '1 day'`, [user.user_id]);
    await c.query(
      'UPDATE operator_password_resets SET replaced_at = now() WHERE user_id = $1 AND used_at IS NULL AND replaced_at IS NULL',
      [user.user_id],
    );
    const inserted = await c.query(
      `INSERT INTO operator_password_resets (tenant_id, user_id, token_hash, expires_at)
       SELECT u.tenant_id, u.id, $3, now() + make_interval(mins => $4)
         FROM operator_users u WHERE u.id = $2 AND u.tenant_id = $1
       RETURNING id`,
      [user.tenant_id, user.user_id, hashToken(token), RESET_MINUTES],
    );
    const language = (await c.query('SELECT language FROM operator_users WHERE id = $1', [user.user_id])).rows[0]?.language ?? null;
    return inserted.rowCount === 1 ? { language } : null;
  });
  return made ? { token, email, language: made.language } : null;
}

/**
 * Use a ready reset: the new hash, every session ended, every lock cleared,
 * the reset marked used -- one transaction holding the reset. Answers
 * `{ email, sessionsRevoked }`, or `{ status }` when it was no longer ready.
 */
export async function completeReset(reset, { passwordHash }) {
  return withTenant(reset.tenant_id, async (c) => {
    const held = (await c.query(
      `SELECT id, user_id, expires_at, used_at, replaced_at FROM operator_password_resets
        WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [reset.reset_id, reset.tenant_id],
    )).rows[0] ?? null;
    const status = linkStatus(held);
    if (status !== 'ready') return { status };
    const email = (await c.query(
      'UPDATE operator_users SET password_hash = $2, password_changed_at = now() WHERE id = $1 RETURNING email',
      [held.user_id, passwordHash],
    )).rows[0].email;
    const revoked = await c.query(
      `UPDATE operator_tokens SET revoked_at = now() WHERE user_id = $1 AND kind = 'session' AND revoked_at IS NULL`,
      [held.user_id],
    );
    await c.query('DELETE FROM operator_sign_in_locks WHERE user_id = $1', [held.user_id]);
    await c.query('UPDATE operator_password_resets SET used_at = now() WHERE id = $1', [held.id]);
    return { email, sessionsRevoked: revoked.rowCount };
  });
}
