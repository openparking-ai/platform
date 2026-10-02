/**
 * The settings older than sign-in that the server reads as numbers: a plain
 * decimal whole number inside its range, or the server does not start.
 *
 * `src/server.js` checks them before the port opens, beside the validations
 * door and the schema, and a bad value stops it with one line naming the
 * setting. Before this, `PORT=0x10` served on port 16, `PORT=" 7"` on port 7,
 * `PG_POOL_MAX=-5` hung on the schema check, `MAX_CLOCK_SKEW_SECONDS=1e12` was
 * taken -- which switches the future-time check off -- and a word in either of
 * the last two was a stack trace.
 *
 * The modules that use them read them with `startSetting`, which never throws:
 * they read at import, where a throw is a stack trace and not a sentence, and
 * by then `server.js` has refused any value that is not one of these.
 */

export const START_SETTINGS = Object.freeze({
  PORT: { min: 1, max: 65535, fallback: 3000 },
  PG_POOL_MAX: { min: 1, max: 100, fallback: 10 },
  // An hour at most: a tolerance much past that is the check switched off.
  MAX_CLOCK_SKEW_SECONDS: { min: 0, max: 3600, fallback: 120 },
});

/** The value, or `why` it is not one. Unset is the default. */
function read(name, env) {
  const { min, max, fallback } = START_SETTINGS[name];
  const raw = env[name];
  if (raw === undefined || raw === '') return { value: fallback };
  if (!/^[0-9]{1,6}$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    return { why: `${name} must be a whole number from ${min} to ${max}, not ${JSON.stringify(String(raw).slice(0, 40))}` };
  }
  return { value: Number(raw) };
}

/** Every start setting, checked: throws the first bad one by name. For `server.js`, before the port opens. */
export function assertStartSettings(env = process.env) {
  const out = {};
  for (const name of Object.keys(START_SETTINGS)) {
    const { value, why } = read(name, env);
    if (why !== undefined) throw new Error(why);
    out[name] = value;
  }
  return out;
}

/** One start setting, for the module that uses it: never throws; a bad value is the default (server.js has refused it). */
export function startSetting(name, env = process.env) {
  const { value } = read(name, env);
  return value ?? START_SETTINGS[name].fallback;
}
