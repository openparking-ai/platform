/**
 * A garage's own Stripe account (0020): created on the operator's request,
 * onboarded through Stripe's own link, and read back on demand.
 *
 * THE ACCOUNT IS THE GARAGE'S. It is created with Stripe's Accounts API (v1)
 * and its controller properties: the garage pays its own Stripe fees, Stripe
 * is responsible for its losses, and Stripe collects its requirements through
 * its own hosted onboarding -- so the deployment that onboarded it carries
 * none of the account's losses. The account has NO Stripe dashboard of its
 * own (`stripe_dashboard.type: none`): the onboarding Stripe shows the garage
 * asks about the garage, not about running a payments platform, and nothing
 * here links the garage to a Stripe dashboard. card_payments is requested at
 * creation, with the transfers capability Stripe requires beside it. Stripe
 * requires the account's country for this setup; the operator states it.
 *
 * NEVER IMPLICITLY. Nothing here runs except on the operator's request, and
 * nothing creates an account as a side effect of anything else.
 *
 * ONE ACCOUNT, EVEN ON A RETRY. See 0020: the create is reserved in its own
 * committed transaction before Stripe is asked, and Stripe is asked with the
 * reservation's idempotency key.
 */
import { withTenant } from './db.js';
import { connectConfig, stripeCall, StripeError, StripeUnreachable, NO_CONNECT_CONFIGURED } from './stripe.js';
import { appendEvents } from './repository.js';
import { randomUUID } from 'node:crypto';

export const STRIPE_ACCOUNT_CREATED_EVENT_KIND = 'stripe_account_created';
export const STRIPE_ACCOUNT_READ_EVENT_KIND = 'stripe_account_read';

//: Stripe keeps an idempotency key for 24 hours. A reservation older than
//: this with no account recorded may have created one Stripe answered and
//: this platform never heard, and asking again with the same key could then
//: make a second. So it is not asked again; it is refused by name and a human
//: looks (the account carries the garage's id in its metadata).
export const IDEMPOTENCY_WINDOW_HOURS = 23;

/** The operator asked for something this deployment cannot do. Named, not a 500. */
export class ConnectRefusal extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireConnect() {
  const config = connectConfig();
  if (!config.configured) throw new ConnectRefusal(409, 'connect_not_configured', NO_CONNECT_CONFIGURED);
  return config;
}

async function readRow(client, tenantId, garageId) {
  const { rows } = await client.query(
    'SELECT * FROM garage_stripe_accounts WHERE tenant_id = $1 AND garage_id = $2',
    [tenantId, garageId],
  );
  return rows[0] ?? null;
}

async function garageOr404(client, tenantId, garageId) {
  const { rows } = await client.query('SELECT id, name FROM garages WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    garageId,
  ]);
  if (!rows[0]) throw new ConnectRefusal(404, 'garage_not_found', 'garage not found');
  return rows[0];
}

/** What the operator sees. The key is not an operator's business. */
export function presentAccount(row) {
  if (!row) return null;
  return {
    garage_id: row.garage_id,
    account_id: row.account_id,
    create_requested_at: row.create_requested_at,
    account_recorded_at: row.account_recorded_at,
    card_payments: row.card_payments,
    card_payments_read_at: row.card_payments_read_at,
    charges_enabled: row.charges_enabled,
    charges_enabled_read_at: row.charges_enabled_read_at,
    details_submitted: row.details_submitted,
    details_submitted_read_at: row.details_submitted_read_at,
  };
}

/** The account's create body. Every field a deployment may not vary is written here. */
export function accountCreateBody({ tenantId, garage, country }) {
  return {
    country,
    controller: {
      stripe_dashboard: { type: 'none' },
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    },
    // Stripe refuses card_payments without transfers requested beside it:
    // "Accounts do not currently support `card_payments` without `transfers`."
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    business_profile: { name: garage.name },
    metadata: { openparking_tenant_id: tenantId, openparking_garage_id: garage.id },
  };
}

/**
 * Create the garage's account, or return the one it already has.
 * `{ account, created }` -- `created` is true only on the call that recorded it.
 */
/** Two capital letters, ISO 3166-1 alpha-2, as Stripe takes it. */
export function countryField(raw) {
  if (typeof raw !== 'string' || !/^[A-Z]{2}$/.test(raw)) {
    throw new ConnectRefusal(400, 'bad_country',
      'country is required: the garage\'s country as two capital letters (ISO 3166-1 alpha-2), e.g. "US"');
  }
  return raw;
}

export async function createAccount(tenantId, garageId, { actor, country: rawCountry }) {
  const config = requireConnect();

  // 1. Reserve, committed, before Stripe is asked.
  const reserved = await withTenant(tenantId, async (client) => {
    const garage = await garageOr404(client, tenantId, garageId);
    const existing = await readRow(client, tenantId, garageId);
    if (existing) return { garage, row: existing };
    const { rows } = await client.query(
      `INSERT INTO garage_stripe_accounts (tenant_id, garage_id, create_idempotency_key, create_requested_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (garage_id) DO NOTHING
       RETURNING *`,
      [tenantId, garageId, `openparking-account-${randomUUID()}`, actor],
    );
    // Lost the race to a concurrent request: its reservation is the one.
    return { garage, row: rows[0] ?? (await readRow(client, tenantId, garageId)) };
  });
  if (reserved.row.account_id) return { account: reserved.row, created: false };
  // Checked before Stripe is asked. Asked only when there is an account to make.
  const country = countryField(rawCountry);

  const ageHours = (Date.now() - new Date(reserved.row.create_requested_at).getTime()) / 3_600_000;
  if (ageHours > IDEMPOTENCY_WINDOW_HOURS) {
    throw new ConnectRefusal(
      409,
      'stripe_account_create_unresolved',
      `an account was requested for this garage at ${new Date(reserved.row.create_requested_at).toISOString()} ` +
        'and Stripe\'s answer was never recorded; asking again now could create a second account. Look in ' +
        `Stripe for an account whose metadata names garage ${garageId}.`,
    );
  }

  // 2. Ask Stripe, outside any transaction, with the reservation's key.
  const account = await stripeCall(
    {
      method: 'POST',
      path: '/v1/accounts',
      form: accountCreateBody({ tenantId, garage: reserved.garage, country }),
      idempotencyKey: reserved.row.create_idempotency_key,
    },
    config,
  );
  if (typeof account?.id !== 'string') throw new StripeUnreachable('Stripe answered a create with no account id');

  // 3. Record it. A concurrent request that got here first recorded the same
  //    id (same key, same answer); the frozen-account trigger refuses any other.
  const recorded = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE garage_stripe_accounts
          SET account_id = $3, account_recorded_at = now()
        WHERE tenant_id = $1 AND garage_id = $2 AND account_id IS NULL
        RETURNING *`,
      [tenantId, garageId, account.id],
    );
    if (rows[0]) {
      await appendEvents(client, tenantId, [
        {
          garageId,
          laneId: null,
          eventId: `stripe-account-created:${garageId}`,
          kind: STRIPE_ACCOUNT_CREATED_EVENT_KIND,
          occurredAt: new Date().toISOString(),
          detail: { account_id: account.id, actor },
        },
      ]);
      return { row: rows[0], created: true };
    }
    return { row: await readRow(client, tenantId, garageId), created: false };
  });
  return { account: recorded.row, created: recorded.created };
}

async function recordedAccount(tenantId, garageId) {
  const row = await withTenant(tenantId, async (client) => {
    await garageOr404(client, tenantId, garageId);
    return readRow(client, tenantId, garageId);
  });
  if (!row?.account_id) {
    throw new ConnectRefusal(409, 'no_stripe_account', 'this garage has no Stripe account yet; create it first');
  }
  return row;
}

/** Stripe's onboarding link for the garage's account. Single-use, short-lived. */
export async function onboardingLink(tenantId, garageId) {
  const config = requireConnect();
  const row = await recordedAccount(tenantId, garageId);
  const link = await stripeCall(
    {
      method: 'POST',
      path: '/v1/account_links',
      form: {
        account: row.account_id,
        type: 'account_onboarding',
        return_url: config.returnUrl,
        refresh_url: config.refreshUrl,
      },
    },
    config,
  );
  if (typeof link?.url !== 'string') throw new StripeUnreachable('Stripe answered a link with no url');
  return {
    url: link.url,
    expires_at: Number.isFinite(link.expires_at) ? new Date(link.expires_at * 1000).toISOString() : null,
  };
}

/** What Stripe says now: the three facts, each stamped with when it was read. */
export function readFacts(account) {
  const status = account?.capabilities?.card_payments;
  return {
    card_payments: typeof status === 'string' ? status : 'unrequested',
    charges_enabled: account?.charges_enabled === true,
    details_submitted: account?.details_submitted === true,
  };
}

export async function refreshAccount(tenantId, garageId, { actor }) {
  const config = requireConnect();
  const row = await recordedAccount(tenantId, garageId);
  // One read reports all three facts the platform keeps.
  const account = await stripeCall({ method: 'GET', path: `/v1/accounts/${encodeURIComponent(row.account_id)}` }, config);
  if (account?.id !== row.account_id) throw new StripeUnreachable('Stripe answered a read for a different account');
  const facts = readFacts(account);
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE garage_stripe_accounts
          SET card_payments = $3, card_payments_read_at = now(),
              charges_enabled = $4, charges_enabled_read_at = now(),
              details_submitted = $5, details_submitted_read_at = now()
        WHERE tenant_id = $1 AND garage_id = $2
        RETURNING *`,
      [tenantId, garageId, facts.card_payments, facts.charges_enabled, facts.details_submitted],
    );
    await appendEvents(client, tenantId, [
      {
        garageId,
        laneId: null,
        eventId: `stripe-account-read:${randomUUID()}`,
        kind: STRIPE_ACCOUNT_READ_EVENT_KIND,
        occurredAt: new Date().toISOString(),
        detail: { account_id: row.account_id, ...facts, actor },
      },
    ]);
    return rows[0];
  });
}

export async function getAccount(tenantId, garageId) {
  requireConnect();
  return withTenant(tenantId, async (client) => {
    await garageOr404(client, tenantId, garageId);
    return readRow(client, tenantId, garageId);
  });
}

/** Map a Stripe failure onto the operator's answer. Never echoes a key. */
export function stripeRefusal(err) {
  if (err instanceof ConnectRefusal) return err;
  if (err instanceof StripeError) {
    return new ConnectRefusal(502, 'stripe_refused', `Stripe refused the request (${err.status}${err.code ? `, ${err.code}` : ''}): ${err.message}`);
  }
  if (err instanceof StripeUnreachable) return new ConnectRefusal(503, 'stripe_unreachable', err.message);
  return null;
}
