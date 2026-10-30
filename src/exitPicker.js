import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * THE PICKER: when the exit's ID leaves a few open stays, Claude is shown the
 * car at the exit and each candidate's entry pictures, numbered 1 to N, and
 * asked one thing: which of them is the same car, or none. PICTURES ONLY: no
 * plate, colour, time or anything else is sent, and nothing in the answer is
 * kept but the number.
 *
 * Off unless the deployment names a key file. A time limit, because a car is
 * waiting at the barrier: no answer in time, an answer that is not a number
 * in range, "none", or no network are all `none`, and the exit goes to the
 * driver's word.
 *
 * Settings:
 *   EXIT_PICKER_KEY_FILE    absolute path of the file holding the API key;
 *                           re-read on every ask, so a rotated key needs no
 *                           restart. Unset: the picker is off.
 *   EXIT_PICKER_MODEL       the model asked (DEFAULT_MODEL when unset).
 *   EXIT_PICKER_TIMEOUT_MS  the limit, 1000 to 30000 (DEFAULT_TIMEOUT_MS).
 *   EXIT_PICKER_URL         the Messages endpoint (tests point it at a stand-in).
 */

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
/** Pictures per car: the exit's and each candidate's. */
export const PICTURES_PER_CAR = 2;

export const QUESTION =
  'The first pictures show one car leaving a garage. Each numbered candidate after them shows a car when it came in. ' +
  'Which numbered candidate is the same car as the one leaving? Reply with the candidate number only, or 0 if none of them is the same car.';

export function readPickerSettings(env = process.env) {
  const set = (name) => env[name] !== undefined && env[name] !== '';
  if (!set('EXIT_PICKER_KEY_FILE')) return { on: false };
  if (!isAbsolute(env.EXIT_PICKER_KEY_FILE)) {
    throw new Error('EXIT_PICKER_KEY_FILE must be an absolute path to the file holding the API key');
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (set('EXIT_PICKER_TIMEOUT_MS')) {
    timeoutMs = Number(env.EXIT_PICKER_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
      throw new Error('EXIT_PICKER_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 30000');
    }
  }
  let url = DEFAULT_URL;
  if (set('EXIT_PICKER_URL')) {
    let parsed;
    try {
      parsed = new URL(env.EXIT_PICKER_URL);
    } catch {
      parsed = null;
    }
    if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('EXIT_PICKER_URL must be an http(s) URL with no credentials in it');
    }
    url = parsed.toString();
  }
  const model = set('EXIT_PICKER_MODEL') ? env.EXIT_PICKER_MODEL : DEFAULT_MODEL;
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(model)) throw new Error('EXIT_PICKER_MODEL must be a model id');
  return { on: true, keyFile: env.EXIT_PICKER_KEY_FILE, model, timeoutMs, url };
}

function imageBlock(picture) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: picture.content_type, data: Buffer.from(picture.image).toString('base64') },
  };
}

/** The request body: the exit car's pictures, then each candidate's under its number, then the question. */
export function requestBody(model, exitPictures, candidates) {
  const content = [{ type: 'text', text: 'The car leaving:' }, ...exitPictures.map(imageBlock)];
  candidates.forEach((c, i) => {
    content.push({ type: 'text', text: `Candidate ${i + 1}:` }, ...c.pictures.map(imageBlock));
  });
  content.push({ type: 'text', text: QUESTION });
  return { model, max_tokens: 1024, messages: [{ role: 'user', content }] };
}

/** The number in the answer, 0 for none, or null when the answer is not one number in range. */
export function answerOf(body, count) {
  const text = (body?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('').trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  const n = Number(text);
  return n >= 0 && n <= count ? n : null;
}

/**
 * Ask. `candidates` are `{ session_id, pictures }` in the matcher's order.
 * Resolves `{ outcome, answer, chosen, elapsed_ms, model }`; never throws for
 * anything the network or the service did. `outcome` is `picked`, `none`,
 * `unclear` (not a number in range), `timeout` or `unreachable`.
 */
export async function pick(settings, { exitPictures, candidates }, { now = () => Date.now() } = {}) {
  const started = now();
  const done = (outcome, answer = null) => ({
    outcome,
    answer,
    chosen: answer ? candidates[answer - 1].session_id : null,
    elapsed_ms: now() - started,
    model: settings.model,
  });
  let key;
  try {
    key = readFileSync(settings.keyFile, 'utf8').trim();
  } catch {
    return done('unreachable');
  }
  if (!key) return done('unreachable');
  let res;
  try {
    res = await fetch(settings.url, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody(settings.model, exitPictures, candidates)),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (err) {
    return done(err?.name === 'TimeoutError' ? 'timeout' : 'unreachable');
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return done(err?.name === 'TimeoutError' ? 'timeout' : 'unclear');
  }
  if (!res.ok) return done('unreachable');
  const answer = answerOf(body, candidates.length);
  if (answer === null) return done('unclear');
  return answer === 0 ? done('none', 0) : done('picked', answer);
}
