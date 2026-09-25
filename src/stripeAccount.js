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
 *
 * AND A REFUSED CREATE NEVER LOCKS THE GARAGE OUT. The country is checked
 * before anything is reserved. A create Stripe definitely refused is recorded
 * on the reservation, and the next create re-arms it with a new key. An
 * UNKNOWN outcome keeps its key inside Stripe's 24-hour window -- Stripe may
 * have made the account, and the same key answers with it. Past the window,
 * Stripe is ASKED: the account it made is attached, or none was made and the
 * reservation starts over. No garage is left unable to get an account.
 */
import { withTenant } from './db.js';
import { connectConfig, stripeCall, StripeError, StripeUnreachable, NO_CONNECT_CONFIGURED } from './stripe.js';
import { appendEvents } from './repository.js';
import { randomUUID } from 'node:crypto';

export const STRIPE_ACCOUNT_CREATED_EVENT_KIND = 'stripe_account_created';
export const STRIPE_ACCOUNT_READ_EVENT_KIND = 'stripe_account_read';

//: Stripe keeps an idempotency key for 24 hours. Inside that window an
//: unknown outcome is re-asked with the SAME key, and Stripe answers with the
//: account it made, if it made one. Past it the key no longer protects
//: anything, so the create ASKS STRIPE instead: every account carries its
//: tenant and garage in its metadata, and the full account list is read. One
//: match is attached; none means the lost request made nothing, and the
//: reservation starts over with a new key; two or more is refused by name.
export const IDEMPOTENCY_WINDOW_HOURS = 23;

//: A ceiling on the account list, so a lookup that cannot finish says so
//: rather than looping. 1,000 pages of 100 is 100,000 connected accounts.
export const ACCOUNT_LIST_MAX_PAGES = 1000;

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

/**
 * Stripe answered, and what it answered means nothing was created: a 4xx other
 * than a conflict. `409` (a lock, a key in use) and `idempotency_error` (this
 * key was already used for a request that RAN) are not refusals: the first
 * request may have created the account.
 */
export function definiteRefusal(err) {
  return err instanceof StripeError
    && err.status >= 400 && err.status < 500
    && err.status !== 409
    && err.type !== 'idempotency_error';
}

/** Every account at Stripe whose metadata names this tenant's garage. Reads all pages. */
export async function accountsNamingGarage(tenantId, garageId, config) {
  const found = [];
  let after = null;
  for (let page = 0; page < ACCOUNT_LIST_MAX_PAGES; page += 1) {
    const list = await stripeCall(
      { method: 'GET', path: `/v1/accounts?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}` },
      config,
    );
    if (!Array.isArray(list?.data)) throw new StripeUnreachable('Stripe answered the account list with no data');
    for (const a of list.data) {
      if (a?.metadata?.openparking_garage_id === garageId && a?.metadata?.openparking_tenant_id === tenantId) {
        found.push(a.id);
      }
    }
    if (!list.has_more) return found;
    after = list.data.at(-1)?.id;
    if (!after) throw new StripeUnreachable('Stripe said the account list has more, and gave no cursor');
  }
  throw new StripeUnreachable(`the account list did not end within ${ACCOUNT_LIST_MAX_PAGES} pages`);
}

/** Record an account found at Stripe for a reservation that never heard its answer. */
async function attachFound(tenantId, garageId, accountId, { actor }) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE garage_stripe_accounts
          SET account_id = $3, account_recorded_at = now()
        WHERE tenant_id = $1 AND garage_id = $2 AND account_id IS NULL
        RETURNING *`,
      [tenantId, garageId, accountId],
    );
    if (rows[0]) {
      await appendEvents(client, tenantId, [{
        garageId,
        laneId: null,
        eventId: `stripe-account-created:${garageId}`,
        kind: STRIPE_ACCOUNT_CREATED_EVENT_KIND,
        occurredAt: new Date().toISOString(),
        detail: { account_id: accountId, actor, found_at_stripe: true },
      }]);
    }
    return rows[0] ?? (await readRow(client, tenantId, garageId));
  });
}

/**
 * Stripe holds no account for this garage: the lost request made nothing.
 * Recorded as such, and the reservation re-armed with a new key, in one
 * transaction. A concurrent request that re-armed first wins; its key is used.
 */
async function startOver(tenantId, garageId, staleKey, { actor, hours }) {
  return withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE garage_stripe_accounts
          SET create_refused_at = now(), create_refused_reason = $4
        WHERE tenant_id = $1 AND garage_id = $2 AND account_id IS NULL
          AND create_idempotency_key = $3 AND create_refused_at IS NULL`,
      [tenantId, garageId, staleKey, `no account at stripe ${hours} h after the lost create`],
    );
    const { rows } = await client.query(
      `UPDATE garage_stripe_accounts
          SET create_idempotency_key = $4, create_requested_at = now(), create_requested_by = $5,
              create_refused_at = NULL, create_refused_reason = NULL
        WHERE tenant_id = $1 AND garage_id = $2 AND account_id IS NULL
          AND create_idempotency_key = $3 AND create_refused_at IS NOT NULL
        RETURNING *`,
      [tenantId, garageId, staleKey, `openparking-account-${randomUUID()}`, actor],
    );
    return rows[0] ?? (await readRow(client, tenantId, garageId));
  });
}

export async function createAccount(tenantId, garageId, { actor, country: rawCountry }) {
  const config = requireConnect();

  // 1. Reserve, committed, before Stripe is asked.
  const reserved = await withTenant(tenantId, async (client) => {
    const garage = await garageOr404(client, tenantId, garageId);
    const existing = await readRow(client, tenantId, garageId);
    if (existing?.account_id) return { garage, row: existing };
    // Checked before anything is written: a create refused here leaves nothing.
    const country = countryField(rawCountry);
    if (existing?.create_refused_at) {
      // Stripe definitely refused the last ask and made nothing: re-arm.
      const { rows } = await client.query(
        `UPDATE garage_stripe_accounts
            SET create_idempotency_key = $3, create_requested_at = now(), create_requested_by = $4,
                create_refused_at = NULL, create_refused_reason = NULL
          WHERE tenant_id = $1 AND garage_id = $2 AND account_id IS NULL AND create_refused_at IS NOT NULL
          RETURNING *`,
        [tenantId, garageId, `openparking-account-${randomUUID()}`, actor],
      );
      return { garage, country, row: rows[0] ?? (await readRow(client, tenantId, garageId)) };
    }
    if (existing) return { garage, country, row: existing };
    const { rows } = await client.query(
      `INSERT INTO garage_stripe_accounts (tenant_id, garage_id, create_idempotency_key, create_requested_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (garage_id) DO NOTHING
       RETURNING *`,
      [tenantId, garageId, `openparking-account-${randomUUID()}`, actor],
    );
    // Lost the race to a concurrent request: its reservation is the one.
    return { garage, country, row: rows[0] ?? (await readRow(client, tenantId, garageId)) };
  });
  if (reserved.row.account_id) return { account: reserved.row, created: false };
  const { country } = reserved;

  const ageHours = (Date.now() - new Date(reserved.row.create_requested_at).getTime()) / 3_600_000;
  if (ageHours > IDEMPOTENCY_WINDOW_HOURS) {
    // The key no longer protects anything: ask Stripe what the lost request did.
    const found = await accountsNamingGarage(tenantId, garageId, config);
    if (found.length > 1) {
      throw new ConnectRefusal(
        409,
        'stripe_account_ambiguous',
        `Stripe holds ${found.length} accounts naming this garage (${found.join(', ')}); ` +
          'one garage has one account, so none is attached and none is made. A person decides which is the garage\'s.',
      );
    }
    if (found.length === 1) {
      return { account: await attachFound(tenantId, garageId, found[0], { actor }), created: false };
    }
    const fresh = await startOver(tenantId, garageId, reserved.row.create_idempotency_key, {
      actor, hours: Math.floor(ageHours),
    });
    if (fresh.account_id) return { account: fresh, created: false };
    reserved.row = fresh;
  }

  // 2. Ask Stripe, outside any transaction, with the reservation's key.
  let account;
  try {
    account = await stripeCall(
      {
        method: 'POST',
        path: '/v1/accounts',
        form: accountCreateBody({ tenantId, garage: reserved.garage, country }),
        idempotencyKey: reserved.row.create_idempotency_key,
      },
      config,
    );
  } catch (err) {
    if (definiteRefusal(err)) {
      // Nothing was created: record it, so the next create re-arms instead of
      // waiting out a key that can never produce an account.
      await withTenant(tenantId, (client) =>
        client.query(
          `UPDATE garage_stripe_accounts
              SET create_refused_at = now(), create_refused_reason = $4
            WHERE tenant_id = $1 AND garage_id = $2 AND account_id IS NULL AND create_idempotency_key = $3`,
          [tenantId, garageId, reserved.row.create_idempotency_key,
            `stripe ${err.status}${err.code ? ` ${err.code}` : ''}`],
        ));
    }
    throw err;
  }
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
