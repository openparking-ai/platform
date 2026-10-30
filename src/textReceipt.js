/**
 * A TEXT RECEIPT for a paid exit, to a United States or Canadian number only.
 * Any other number gets no text: it is refused before anything is sent.
 *
 * The number is used for the one send and kept nowhere: the payment keeps
 * the last two digits, the time and the provider's reference for the message.
 *
 * THE PROVIDER IS THE DEPLOYMENT'S, read at each send, never at import:
 *
 *   TEXT_PROVIDER      the provider's API shape. `twilio` is the one built.
 *   TEXT_ACCOUNT       the provider account the message is sent under.
 *   TEXT_KEY_FILE      absolute path of the file holding the provider's key;
 *                      re-read on every send, so a rotated key needs no restart.
 *   TEXT_FROM          the sending number (E.164) or messaging service id.
 *   TEXT_API_BASE      optional; the API's origin. Only tests set it.
 *
 * With any of the first four unset, receipts are off and the route says so.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const PROVIDERS = ['twilio'];

/**
 * Area codes inside the North American numbering plan that are not the
 * fifty states, the District of Columbia or Canada: the Caribbean members,
 * Bermuda, and the US territories (Puerto Rico, the US Virgin Islands, Guam,
 * the Northern Mariana Islands, American Samoa), whose texts are priced and
 * carried as international. Plus the non-geographic US codes that are not a
 * phone (521-532 personal communications, 710 the federal government).
 * Toll-free, premium and the N00 / N11 / NXX-repeated service codes are
 * refused by shape (`usOrCanada`).
 */
export const NOT_US_OR_CANADA = new Set([
  '242', '246', '264', '268', '284', '340', '345', '441', '473', '649', '658', '664', '670', '671',
  '684', '721', '758', '767', '784', '787', '809', '829', '849', '868', '869', '876', '939',
  '521', '522', '523', '524', '525', '526', '527', '528', '529', '530', '531', '532', '710',
]);

/**
 * The number as E.164 when it is a US or Canadian phone, else null.
 * Accepts `+1 (212) 555-0123`, `1-212-555-0123`, `2125550123`; a leading `+`
 * with any other country code is not US or Canada.
 */
export function usOrCanada(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const trimmed = raw.trim();
  if (!/^\+?[0-9 ().-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/[^0-9]/g, '');
  if (trimmed.startsWith('+') && !digits.startsWith('1')) return null;
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  const npa = digits.slice(0, 3);
  const nxx = digits.slice(3, 6);
  if (!/^[2-9][0-8][0-9]$/.test(npa) || npa[1] === npa[2]) return null;
  if (NOT_US_OR_CANADA.has(npa)) return null;
  if (!/^[2-9][0-9][0-9]$/.test(nxx) || nxx.slice(1) === '11') return null;
  return `+1${digits}`;
}

export function readTextSettings(env = process.env) {
  const set = (k) => typeof env[k] === 'string' && env[k] !== '';
  if (!['TEXT_PROVIDER', 'TEXT_ACCOUNT', 'TEXT_KEY_FILE', 'TEXT_FROM'].every(set)) return { on: false };
  if (!PROVIDERS.includes(env.TEXT_PROVIDER)) throw new Error(`TEXT_PROVIDER must be one of ${PROVIDERS.join(', ')}`);
  if (!isAbsolute(env.TEXT_KEY_FILE)) throw new Error('TEXT_KEY_FILE must be an absolute path to the file holding the key');
  if (!/^[A-Za-z0-9]{1,64}$/.test(env.TEXT_ACCOUNT)) throw new Error('TEXT_ACCOUNT must be the provider account id');
  return {
    on: true,
    provider: env.TEXT_PROVIDER,
    account: env.TEXT_ACCOUNT,
    keyFile: env.TEXT_KEY_FILE,
    from: env.TEXT_FROM,
    base: set('TEXT_API_BASE') ? env.TEXT_API_BASE : 'https://api.twilio.com',
  };
}

/** The receipt's words: who was paid, how much, when, and the payment's reference. */
export function receiptText({ garageName, amountMinor, currency, paidAt, timezone, reference }) {
  const digits = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits;
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amountMinor / 10 ** digits);
  const when = new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(paidAt));
  return `${garageName}: paid ${amount} for parking, ${when}. Ref ${reference.slice(-8)}. Thank you.`;
}

/** Send one message. Answers the provider's reference for it. */
export async function sendText(settings, { to, body }) {
  const key = (await readFile(settings.keyFile, 'utf8')).trim();
  if (!key) throw new Error('the text provider key file is empty');
  const form = new URLSearchParams({ To: to, Body: body });
  if (/^MG[0-9a-f]{32}$/.test(settings.from)) form.set('MessagingServiceSid', settings.from);
  else form.set('From', settings.from);
  let res;
  try {
    res = await fetch(`${settings.base}/2010-04-01/Accounts/${encodeURIComponent(settings.account)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${settings.account}:${key}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new TextNotSent(`the text provider could not be reached: ${err.message}`);
  }
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    // An answer that is not JSON is a failure below, whatever its status.
  }
  if (!res.ok || typeof parsed?.sid !== 'string') {
    throw new TextNotSent(`the text provider answered ${res.status}${parsed?.code ? ` (${parsed.code})` : ''}`);
  }
  return parsed.sid;
}

export class TextNotSent extends Error {}
