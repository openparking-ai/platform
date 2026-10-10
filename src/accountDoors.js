/**
 * The four public doors behind the emailed links (0032), under /api/v1/auth
 * beside sign-in, and held to sign-in's rules:
 *
 *   POST /invite/status  {token}                     -> 200 {status, message[, email, language, expires_at]}
 *   POST /invite/accept  {token, password, language} -> 200 {email, tenant_id, session_ends_at, language} and the cookie
 *   POST /forgot         {email}                     -> 200 {message}, the same whoever it names
 *   POST /reset          {token, password}           -> 200 {email, message}
 *
 * A TOKEN TRAVELS IN A POST BODY ONLY. The emailed link carries it in the URL
 * fragment, which no browser sends; the admin screen reads it there and sends
 * it here. No door has a path parameter or reads the query. A body is never
 * logged and never repeated: one that cannot be read answers its door's one
 * sentence, never the parser's.
 *
 * NO ANSWER SOONER THAN THE FLOOR. Every answer of every door here -- ready
 * or not, known email or not -- waits for sign-in's floor
 * (SIGN_IN_REFUSAL_FLOOR_MS) after the request arrived.
 *
 * FORGOT IS NO ORACLE. A known email and an unknown one get the same answer,
 * byte for byte, after the same database statements (an unknown email's find
 * and write nothing, as sign-in's do) and at the floor. The reset email is
 * sent AFTER the answer, so its round trip is not on the wire either.
 *
 * LIMITS. Each door counts its own attempts per caller address -- the address
 * sign-in counts by -- ACCOUNT_LINK_ATTEMPTS_PER_ADDRESS per
 * ACCOUNT_LINK_ATTEMPTS_WINDOW_MINUTES, then 429. Accept and reset hash a
 * password, so they take a place in sign-in's hash line first.
 *
 * SAME SITE. As sign-in: with no ADMIN_ORIGIN these doors are off (409), a
 * foreign Origin is refused (403), and a body not sent as JSON is not read.
 */
import express from 'express';
import { hashPassword, passwordRuleBroken } from './passwords.js';
import { sendEmail, EmailNotSent } from './email.js';
import { acceptedNotice, resetEmail } from './emailText.js';
import {
  acceptInvite, completeReset, findInvite, findReset, requestReset, resetLink,
} from './invites.js';

//: What the status door says of an invite, and what the screen shows.
export const INVITE_SENTENCES = Object.freeze({
  ready: 'This invite is ready. Choose a password to finish.',
  used: 'This invite was already used. Sign in instead.',
  expired: 'This invite has ended. Ask for a new one.',
  replaced: 'A newer invite was sent. Use the link in the latest email.',
  invalid: 'This link is not an invite. Check that the whole link was used.',
});

//: What the reset door says of a link that is not ready.
export const RESET_SENTENCES = Object.freeze({
  used: 'This reset link was already used. Ask for a new one if you need it.',
  expired: 'This reset link has ended. Ask for a new one.',
  replaced: 'A newer reset link was sent. Use the link in the latest email.',
  invalid: 'This link is not a reset link. Check that the whole link was used.',
});

//: The one answer forgot gives, whoever the email names.
export const FORGOT_SENT = Object.freeze({
  message: 'If that email names an account, a link to choose a new password is on its way. It works once, for one hour.',
});

export const PASSWORD_REFUSED = Object.freeze({ error: 'The password must be 12 to 1024 characters.', code: 'password_refused' });
export const LINK_RATE_LIMITED = Object.freeze({ error: 'Too many attempts from here. Try again later.', code: 'link_rate_limited' });
export const LINK_BUSY = Object.freeze({ error: 'Busy. Try again in a moment.', code: 'link_busy' });
export const INVITE_HAS_ADMIN = Object.freeze({ error: 'This account already has its admin. Sign in instead.', code: 'invite_has_admin' });
export const INVITE_EMAIL_TAKEN = Object.freeze({ error: 'That email already names an admin. Sign in instead.', code: 'invite_email_taken' });
export const RESET_DONE = 'The password is changed, and every session of the account is signed out. Sign in with the new password.';

//: Each door's one sentence for a body it cannot read, whatever was wrong with it.
export const UNREADABLE = Object.freeze({
  status: Object.freeze({ error: 'The request could not be read. Send JSON: {"token"}.', code: 'invite_unreadable' }),
  accept: Object.freeze({ error: 'The request could not be read. Send JSON: {"token", "password", "language"}.', code: 'invite_unreadable' }),
  forgot: Object.freeze({ error: 'The request could not be read. Send JSON: {"email"}.', code: 'forgot_unreadable' }),
  reset: Object.freeze({ error: 'The request could not be read. Send JSON: {"token", "password"}.', code: 'reset_unreadable' }),
});

const LANGUAGES = ['en', 'es'];

/** The body, when it has exactly these keys, each a string; or null. */
function exactly(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const has = Object.keys(body);
  if (has.length !== keys.length || !keys.every((k) => has.includes(k) && typeof body[k] === 'string')) return null;
  return body;
}

const SHAPES = {
  status: (b) => exactly(b, ['token']) && b.token.length <= 128 ? b : null,
  accept: (b) => exactly(b, ['token', 'password', 'language']) && b.token.length <= 128 && LANGUAGES.includes(b.language) ? b : null,
  forgot: (b) => {
    if (!exactly(b, ['email'])) return null;
    const email = b.email.trim().toLowerCase();
    return email.length >= 3 && email.length <= 254 ? { email } : null;
  },
  reset: (b) => exactly(b, ['token', 'password']) && b.token.length <= 128 ? b : null,
};

/** A failure in these doors, in words that can hold nothing secret: its class and its code. */
function logFailure(where, err) {
  const kind = err?.constructor?.name ?? 'Error';
  console.error(`[auth] ${where} failed: ${kind}${err?.code ? ` ${err.code}` : ''}`);
}

/** A send after the answer: its failure said by what failed, never the address or the link. */
function sendLater(email, message, what) {
  sendEmail(email, message).catch((err) => {
    if (err instanceof EmailNotSent) console.error(`[email] the ${what} was not sent: ${err.message}`);
    else logFailure(`${what} email`, err);
  });
}

/**
 * Mount the four doors on sign-in's router. `answer` is sign-in's floor-held
 * answer; `line` its hash line; `signIn` the pieces of sign-in they share --
 * the address, the session minted, the cookie -- so there is one of each.
 */
export function mountAccountDoors(router, { settings, email, line, answer, signIn }) {
  const limiters = Object.fromEntries(['status', 'accept', 'forgot', 'reset'].map((door) => [
    door, signIn.addressLimiter({ max: settings.linkAttemptsPerAddress, windowSeconds: settings.linkAttemptsWindowSeconds }),
  ]));
  // Room for a password at its longest, every character escaped.
  const json = express.json({ limit: '16kb', strict: true });

  /** A failure inside a door: logged by what it is, answered at the floor in one sentence. */
  const failed = async (req, res, where, err) => {
    logFailure(where, err);
    if (!res.headersSent) await answer(req, res, 500, { error: 'internal error' });
  };

  /**
   * What every door does first, in sign-in's order: on at all, the Origin,
   * JSON, a body of the door's shape, then the address's count. Answers the
   * body, or null when it has answered.
   */
  const admit = (door) => [
    async (req, res, next) => {
      try {
        if (settings.adminOrigin === null) return await answer(req, res, 409, signIn.NOT_CONFIGURED);
        const origin = req.get('origin');
        if (origin !== undefined && origin !== settings.adminOrigin) return await answer(req, res, 403, signIn.ORIGIN_REFUSED);
        if (!req.is('application/json')) return await answer(req, res, 400, UNREADABLE[door]);
        json(req, res, (err) => (err ? answer(req, res, 400, UNREADABLE[door]).catch(next) : next()));
      } catch (err) {
        next(err);
      }
    },
    async (req, res, next) => {
      try {
        req.door = SHAPES[door](req.body);
        if (!req.door) return await answer(req, res, 400, UNREADABLE[door]);
        req.address = signIn.callerAddress(req, settings);
        if (!limiters[door].take(req.address)) return await answer(req, res, 429, LINK_RATE_LIMITED);
        next();
      } catch (err) {
        next(err);
      }
    },
  ];

  /** A password hashed in a place in sign-in's line; null when the line is full. */
  const hashInLine = async (address, password) => {
    const leave = line.enter(address);
    if (!leave) return null;
    try {
      return await hashPassword(password);
    } finally {
      leave();
    }
  };

  router.post('/invite/status', ...admit('status'), async (req, res) => {
    try {
      const { status, invite } = await findInvite(req.door.token);
      const body = { status, message: INVITE_SENTENCES[status] };
      if (status === 'ready') Object.assign(body, { email: invite.email, language: invite.language, expires_at: new Date(invite.expires_at).toISOString() });
      return await answer(req, res, 200, body);
    } catch (err) {
      return failed(req, res, 'invite status', err);
    }
  });

  router.post('/invite/accept', ...admit('accept'), async (req, res) => {
    try {
      const { token, password, language } = req.door;
      const found = await findInvite(token);
      if (found.status !== 'ready') return await answer(req, res, 409, { error: INVITE_SENTENCES[found.status], code: `invite_${found.status}` });
      if (passwordRuleBroken(password)) return await answer(req, res, 400, PASSWORD_REFUSED);
      const passwordHash = await hashInLine(req.address, password);
      if (!passwordHash) return await answer(req, res, 503, LINK_BUSY);

      const made = await acceptInvite(found.invite, { passwordHash, language });
      if (made.status) return await answer(req, res, 409, { error: INVITE_SENTENCES[made.status], code: `invite_${made.status}` });
      if (made.refused) return await answer(req, res, 409, made.refused === 'has_admin' ? INVITE_HAS_ADMIN : INVITE_EMAIL_TAKEN);

      // Signed in the way sign-in signs in: one session, minted in one place.
      const minted = await signIn.internals.mintSession(made.user, req.address, settings);
      if (minted) signIn.setCookie(res, settings, minted.token);
      if (email.noticeTo) {
        sendLater(email, { to: email.noticeTo, ...acceptedNotice({ email: made.user.email, company: made.company, tenantId: made.user.tenant_id, at: new Date() }) }, 'invite-accepted notice');
      }
      if (!minted) {
        // The password changed between the accept and the session: the admin
        // exists, and signs in with whatever it is now.
        return await answer(req, res, 409, { error: INVITE_SENTENCES.used, code: 'invite_used' });
      }
      return await answer(req, res, 200, {
        email: made.user.email,
        tenant_id: made.user.tenant_id,
        session_ends_at: signIn.endsAt(minted.row).toISOString(),
        language: minted.row.language,
      });
    } catch (err) {
      return failed(req, res, 'invite accept', err);
    }
  });

  router.post('/forgot', ...admit('forgot'), async (req, res) => {
    try {
      const made = await requestReset(req.door.email, signIn.NOBODY);
      await answer(req, res, 200, FORGOT_SENT);
      // After the answer, so the send is not on the wire; and only for an admin.
      if (made && email.configured) {
        sendLater(email, { to: made.email, ...resetEmail(made.language, { link: resetLink(settings.adminOrigin, made.token) }) }, 'reset email');
      }
      return undefined;
    } catch (err) {
      return failed(req, res, 'forgot', err);
    }
  });

  router.post('/reset', ...admit('reset'), async (req, res) => {
    try {
      const { token, password } = req.door;
      const found = await findReset(token);
      if (found.status !== 'ready') return await answer(req, res, 409, { error: RESET_SENTENCES[found.status], code: `reset_${found.status}` });
      if (passwordRuleBroken(password)) return await answer(req, res, 400, PASSWORD_REFUSED);
      const passwordHash = await hashInLine(req.address, password);
      if (!passwordHash) return await answer(req, res, 503, LINK_BUSY);
      const done = await completeReset(found.reset, { passwordHash });
      if (done.status) return await answer(req, res, 409, { error: RESET_SENTENCES[done.status], code: `reset_${done.status}` });
      return await answer(req, res, 200, { email: done.email, message: RESET_DONE });
    } catch (err) {
      return failed(req, res, 'reset', err);
    }
  });
}
