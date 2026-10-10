/**
 * Sending an email (0032): the invite, the reset link, and the notice that an
 * invite was accepted. One `fetch` to the email service's HTTP API -- Resend's
 * by default -- and no dependency.
 *
 * Four settings, read at start and refused by name when they are not one of
 * their forms:
 *
 *   EMAIL_KEY_FILE   the file holding the service's key (a secret mounted
 *                    under /run/secrets). The KEY is never a setting: a value
 *                    in the environment is readable by anything that can read
 *                    the process's environment, a file only by its owner.
 *   EMAIL_FROM       the sender, `Name <address>` or an address.
 *   EMAIL_NOTICE_TO  who is told that an invite was accepted. Optional.
 *   EMAIL_API_URL    where the service takes a message. Optional; Resend's.
 *
 * The first two are set together or not at all. With neither, this deployment
 * sends no email: `invite-admin` refuses, and a reset is asked for in vain.
 * No address of anyone's is written in this repository: each is a setting.
 *
 * NOTHING SECRET IS WRITTEN OUT. The key, and the link a message carries,
 * are in no error and no log line: a failure says what failed -- the key file,
 * the service unreachable, the status it answered -- and never the service's
 * own words, which could quote what was sent.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

//: Resend's API, where a message is sent unless EMAIL_API_URL says otherwise.
export const DEFAULT_API_URL = 'https://api.resend.com/emails';

//: How long the service has to answer before the send counts as failed.
export const SEND_TIMEOUT_MS = 10_000;

/** A message that was not sent, in words that hold nothing secret. */
export class EmailNotSent extends Error {}

const LINE_BREAK = /[\r\n]/;
const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** An address on its own, or `Name <address>`; the address part, or null. */
function addressOf(value) {
  if (LINE_BREAK.test(value)) return null;
  const named = /^[^<>\r\n]*<([^<>]+)>$/.exec(value);
  const address = (named ? named[1] : value).trim();
  return ADDRESS.test(address) ? address : null;
}

/**
 * The email settings, or a refusal naming the setting. Never the value of the
 * key file's contents, which is not read here.
 */
export function readEmailSettings(env = process.env) {
  const set = (name) => env[name] !== undefined && env[name] !== '';
  const keyFile = set('EMAIL_KEY_FILE') ? env.EMAIL_KEY_FILE : null;
  const from = set('EMAIL_FROM') ? env.EMAIL_FROM : null;
  const noticeTo = set('EMAIL_NOTICE_TO') ? env.EMAIL_NOTICE_TO : null;

  if ((keyFile === null) !== (from === null)) {
    throw new Error('EMAIL_KEY_FILE and EMAIL_FROM are set together, or neither is: one without the other sends nothing');
  }
  if (keyFile !== null && !isAbsolute(keyFile)) {
    throw new Error('EMAIL_KEY_FILE must be an absolute path to the file holding the email key');
  }
  if (from !== null && addressOf(from) === null) {
    throw new Error('EMAIL_FROM must be an address, or Name <address>, on one line');
  }
  if (noticeTo !== null && (keyFile === null || !ADDRESS.test(noticeTo))) {
    throw new Error(keyFile === null
      ? 'EMAIL_NOTICE_TO is set but no email is configured (EMAIL_KEY_FILE and EMAIL_FROM)'
      : 'EMAIL_NOTICE_TO must be one address');
  }

  let apiUrl = DEFAULT_API_URL;
  if (set('EMAIL_API_URL')) {
    let url;
    try {
      url = new URL(env.EMAIL_API_URL);
    } catch {
      url = null;
    }
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('EMAIL_API_URL must be an http(s) URL with no credentials in it');
    }
    apiUrl = url.toString();
  }
  return { configured: keyFile !== null, keyFile, from, noticeTo, apiUrl };
}

/** The key, read from its file now, so a rotated key is used without a restart. */
function readKey(settings) {
  let key;
  try {
    key = readFileSync(settings.keyFile, 'utf8').trim();
  } catch (err) {
    throw new EmailNotSent(`the email key file could not be read (${err.code ?? 'error'})`);
  }
  if (!key) throw new EmailNotSent('the email key file is empty');
  return key;
}

/**
 * Whether email can be sent from here: configured, and its key file readable
 * and not empty. Throws a refusal in plain words when it cannot; for
 * `invite-admin` before it stores anything, and for `serve` before the port opens.
 */
export function assertCanSend(settings) {
  if (!settings.configured) {
    throw new EmailNotSent('no email is configured here (EMAIL_KEY_FILE and EMAIL_FROM), so no invite can be sent');
  }
  try {
    if (!statSync(settings.keyFile).isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
  } catch (err) {
    throw new EmailNotSent(`the email key file could not be read (${err.code ?? 'error'})`);
  }
  readKey(settings);
}

/**
 * Send one plain-text message. Resolves when the service has taken it; throws
 * `EmailNotSent` otherwise, saying which of the three failed and nothing else.
 */
export async function sendEmail(settings, { to, subject, text }) {
  if (!settings.configured) throw new EmailNotSent('no email is configured here');
  const key = readKey(settings);
  let res;
  try {
    res = await fetch(settings.apiUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: settings.from, to: [to], subject, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    throw new EmailNotSent(`the email service could not be reached (${err?.name ?? 'Error'})`);
  }
  // The body is read and dropped, never repeated: it is the service's words.
  await res.arrayBuffer().catch(() => {});
  if (!res.ok) throw new EmailNotSent(`the email service answered ${res.status}`);
}
