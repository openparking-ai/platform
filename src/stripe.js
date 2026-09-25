/**
 * The Stripe REST client: plain `fetch`, no SDK.
 *
 * A public AGPL repository that talks to one processor through a handful of
 * calls carries the calls, not a dependency. Stripe's v1 API takes the nested
 * form encoding in form.js. The API version is PINNED here, so a change in
 * Stripe's defaults is a change to this file and not a surprise in production.
 *
 * CONFIGURATION IS THE DEPLOYMENT'S, AND NONE OF ITS VALUES ARE HERE. The
 * fields are public; the values -- the key, the onboarding URLs -- are read
 * from the environment at the moment of each call, never at import, so a
 * deployment with no Stripe configuration at all starts and serves every other
 * route exactly as it did before this file existed.
 *
 *   STRIPE_API_KEY        the deployment's own key. A restricted key is the
 *                         right kind: it holds only the grants the calls below
 *                         make.
 *   CONNECT_RETURN_URL    where Stripe sends an operator who finished (or left)
 *   CONNECT_REFRESH_URL   onboarding, and where it sends one whose link
 *                         expired. Both, with the key, are what "Connect is
 *                         configured" means here.
 *   STRIPE_API_BASE       optional; the API's origin. Only tests set it.
 */
import { encodeForm } from './form.js';

//: Pinned, not defaulted: the version decides response shapes.
export const STRIPE_V1_VERSION = '2026-08-26.dahlia';

//: The sentence a Connect route answers with when this deployment has none.
//: One sentence, the same everywhere, so an operator is told what is missing
//: rather than handed a 500 or a guess.
export const NO_CONNECT_CONFIGURED = 'This deployment has no Stripe Connect configured.';

/** What this deployment has configured, read now. Never a value in a log. */
export function connectConfig(env = process.env) {
  const key = env.STRIPE_API_KEY || null;
  const returnUrl = env.CONNECT_RETURN_URL || null;
  const refreshUrl = env.CONNECT_REFRESH_URL || null;
  return {
    configured: Boolean(key && returnUrl && refreshUrl),
    key,
    returnUrl,
    refreshUrl,
    base: env.STRIPE_API_BASE || 'https://api.stripe.com',
  };
}

/** Stripe answered, and the answer was an error. */
export class StripeError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(e.message || `Stripe answered ${status}`);
    this.status = status;
    this.code = e.code ?? null;
    this.type = e.type ?? null;
  }
}

/** Stripe could not be reached, or answered something that is not JSON. */
export class StripeUnreachable extends Error {}

/**
 * One call.
 *
 * `account` sets the `Stripe-Account` header: the call acts ON that connected
 * account (a direct charge, and its device resources, belong to it).
 * `idempotencyKey` makes a retried create return the first result instead of
 * making a second object.
 */
export async function stripeCall(
  { method, path, form, account, idempotencyKey },
  config = connectConfig(),
) {
  if (!config.key) throw new StripeUnreachable('no Stripe key is configured');
  const headers = {
    Authorization: `Bearer ${config.key}`,
    'Stripe-Version': STRIPE_V1_VERSION,
  };
  if (account) headers['Stripe-Account'] = account;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let body;
  if (form !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = encodeForm(form);
  }

  let res;
  try {
    res = await fetch(`${config.base}${path}`, { method, headers, body, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new StripeUnreachable(`Stripe could not be reached: ${err.message}`);
  }
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    throw new StripeUnreachable(`Stripe answered ${res.status} with a body that is not JSON`);
  }
  if (!res.ok) throw new StripeError(res.status, parsed);
  return parsed;
}
