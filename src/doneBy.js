/**
 * "Done by" (README, "Done by"): an operator key may say who, in plain words,
 * is acting through it. The name is kept beside the change-log line of what
 * the request changes, and it is trusted for NOTHING else: the key's
 * permissions are the key's, whatever name is given. On a session the header
 * is not read at all: the line names the person signed in.
 *
 * The header is `X-Done-By`, the name percent-encoded as UTF-8 (a header is
 * bytes, and a name is not always ASCII), 1 to 80 characters once decoded and
 * trimmed, with no control or format character.
 */
import { HttpError } from './errors.js';

export const HEADER = 'x-done-by';
export const MAX = 80;
export const DONE_BY_REFUSED = Object.freeze({
  error: `X-Done-By is a person's name, percent-encoded as UTF-8, 1 to ${MAX} characters.`,
  code: 'done_by_refused',
});

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** The name a key's request gives, or null when it gives none. Throws `400 done_by_refused` on anything else. */
export function readDoneBy(req) {
  const raw = req.get(HEADER);
  if (raw === undefined) return null;
  let name;
  try {
    name = decodeURIComponent(raw).trim();
  } catch {
    throw new HttpError(400, DONE_BY_REFUSED.error, DONE_BY_REFUSED.code);
  }
  if (name === '' || [...name].length > MAX || CONTROL.test(name)) {
    throw new HttpError(400, DONE_BY_REFUSED.error, DONE_BY_REFUSED.code);
  }
  return name;
}
