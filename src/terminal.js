/**
 * A garage's Location and its readers (0021), registered on the garage's own
 * Stripe account, and each reader bound to one lane.
 *
 * Both are refused while the account cannot take a card: card_payments is
 * READ FROM STRIPE at the moment of the request (and kept, with its read
 * time, as any read is), never taken from an old read.
 *
 * RETRIES MAKE NOTHING TWICE. Each create carries an idempotency key derived
 * from what it asks for -- the garage and the location's details; the lane
 * and the registration code -- so the same request retried returns the same
 * object, and a corrected request is a different one.
 */
import { createHash } from 'node:crypto';
import { withTenant } from './db.js';
import { stripeCall, StripeUnreachable } from './stripe.js';
import { ConnectRefusal, refreshAccount, requireConnect } from './stripeAccount.js';
import { appendEvents } from './repository.js';

export const READER_BOUND_EVENT_KIND = 'lane_reader_bound';
export const READER_UNBOUND_EVENT_KIND = 'lane_reader_unbound';

const keyOf = (kind, ...parts) =>
  `openparking-${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;

/** The account can take a card, per Stripe, now. Answers the fresh row. */
async function accountThatTakesCards(tenantId, garageId, actor) {
  const account = await refreshAccount(tenantId, garageId, { actor });
  if (account.card_payments !== 'active') {
    throw new ConnectRefusal(
      409,
      'card_payments_not_active',
      `this garage's Stripe account cannot take a card yet: Stripe reports card_payments '${account.card_payments}'. ` +
        'Finish onboarding through the onboarding link, then ask again.',
    );
  }
  return account;
}

export function presentLocation(row) {
  if (!row) return null;
  return {
    garage_id: row.garage_id,
    location_id: row.location_id,
    display_name: row.display_name,
    created_at: row.created_at,
  };
}

export function presentReader(row) {
  return {
    lane_id: row.lane_id,
    reader_id: row.reader_id,
    label: row.label,
    location_id: row.location_id,
    bound_at: row.bound_at,
    unbound_at: row.unbound_at,
  };
}

const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'postal_code', 'country'];

function locationFields(body) {
  const displayName = body?.display_name;
  if (typeof displayName !== 'string' || !displayName.trim()) {
    throw new ConnectRefusal(400, 'bad_location', 'display_name is required');
  }
  const address = body?.address;
  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    throw new ConnectRefusal(400, 'bad_location', 'address is required: {line1, city, postal_code, country, ...}');
  }
  const clean = {};
  for (const [k, v] of Object.entries(address)) {
    if (!ADDRESS_FIELDS.includes(k)) throw new ConnectRefusal(400, 'bad_location', `unknown address field ${JSON.stringify(k)}`);
    if (typeof v !== 'string') throw new ConnectRefusal(400, 'bad_location', `address.${k} is a string`);
    clean[k] = v;
  }
  if (!clean.line1 || !clean.country) throw new ConnectRefusal(400, 'bad_location', 'address.line1 and address.country are required');
  return { displayName: displayName.trim(), address: clean };
}

/** The garage's Location, registered on its account. Or the one it has. */
export async function createLocation(tenantId, garageId, body, { actor }) {
  const config = requireConnect();
  const existing = await getLocation(tenantId, garageId);
  if (existing) return { location: existing, created: false };
  const { displayName, address } = locationFields(body);
  const account = await accountThatTakesCards(tenantId, garageId, actor);

  const location = await stripeCall(
    {
      method: 'POST',
      path: '/v1/terminal/locations',
      account: account.account_id,
      form: { display_name: displayName, address },
      idempotencyKey: keyOf('location', garageId, account.account_id, displayName, address),
    },
    config,
  );
  if (typeof location?.id !== 'string') throw new StripeUnreachable('Stripe answered a location with no id');

  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO garage_terminal_locations (tenant_id, garage_id, account_id, location_id, display_name, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (garage_id) DO NOTHING
       RETURNING *`,
      [tenantId, garageId, account.account_id, location.id, displayName, actor],
    );
    if (rows[0]) return { location: rows[0], created: true };
    const { rows: again } = await client.query(
      'SELECT * FROM garage_terminal_locations WHERE tenant_id = $1 AND garage_id = $2', [tenantId, garageId]);
    return { location: again[0], created: false };
  });
}

export async function getLocation(tenantId, garageId) {
  return withTenant(tenantId, async (client) => {
    const { rows: g } = await client.query('SELECT 1 FROM garages WHERE tenant_id = $1 AND id = $2', [tenantId, garageId]);
    if (!g[0]) throw new ConnectRefusal(404, 'garage_not_found', 'garage not found');
    const { rows } = await client.query(
      'SELECT * FROM garage_terminal_locations WHERE tenant_id = $1 AND garage_id = $2', [tenantId, garageId]);
    return rows[0] ?? null;
  });
}

async function laneOr404(tenantId, laneId) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query('SELECT id, garage_id FROM lanes WHERE tenant_id = $1 AND id = $2', [tenantId, laneId]);
    if (!rows[0]) throw new ConnectRefusal(404, 'lane_not_found', 'lane not found');
    return rows[0];
  });
}

async function boundReader(client, tenantId, laneId) {
  const { rows } = await client.query(
    'SELECT * FROM lane_readers WHERE tenant_id = $1 AND lane_id = $2 AND unbound_at IS NULL', [tenantId, laneId]);
  return rows[0] ?? null;
}

/**
 * Register a reader on the garage's account, at its Location, and bind it to
 * the lane. The registration code is what the reader shows on its screen; it
 * is sent to Stripe and kept nowhere here.
 */
export async function bindReader(tenantId, laneId, body, { actor }) {
  const config = requireConnect();
  const code = body?.registration_code;
  if (typeof code !== 'string' || !code.trim()) {
    throw new ConnectRefusal(400, 'bad_reader', 'registration_code is required: the code the reader shows');
  }
  const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : null;
  if (!label) throw new ConnectRefusal(400, 'bad_reader', 'label is required');

  const lane = await laneOr404(tenantId, laneId);
  const held = await withTenant(tenantId, (c) => boundReader(c, tenantId, laneId));
  if (held) {
    throw new ConnectRefusal(409, 'lane_has_reader',
      `this lane already has reader ${held.reader_id} bound; unbind it first`);
  }
  const location = await getLocation(tenantId, lane.garage_id);
  if (!location) {
    throw new ConnectRefusal(409, 'no_terminal_location', "this garage has no Location yet; create it first");
  }
  const account = await accountThatTakesCards(tenantId, lane.garage_id, actor);

  const reader = await stripeCall(
    {
      method: 'POST',
      path: '/v1/terminal/readers',
      account: account.account_id,
      form: { registration_code: code.trim(), label, location: location.location_id },
      idempotencyKey: keyOf('reader', laneId, account.account_id, location.location_id, code.trim()),
    },
    config,
  );
  if (typeof reader?.id !== 'string') throw new StripeUnreachable('Stripe answered a reader with no id');

  return withTenant(tenantId, async (client) => {
    try {
      const { rows } = await client.query(
        `INSERT INTO lane_readers (tenant_id, garage_id, lane_id, account_id, location_id, reader_id, label, bound_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [tenantId, lane.garage_id, laneId, account.account_id, location.location_id, reader.id, label, actor],
      );
      await appendEvents(client, tenantId, [{
        garageId: lane.garage_id,
        laneId,
        eventId: `lane-reader-bound:${rows[0].id}`,
        kind: READER_BOUND_EVENT_KIND,
        occurredAt: new Date().toISOString(),
        detail: { reader_id: reader.id, location_id: location.location_id, actor },
      }]);
      return rows[0];
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'lane_readers_one_per_lane') {
        throw new ConnectRefusal(409, 'lane_has_reader', 'this lane already has a reader bound; unbind it first');
      }
      if (err.code === '23505' && err.constraint === 'lane_readers_one_lane_per_reader') {
        throw new ConnectRefusal(409, 'reader_bound_elsewhere', `reader ${reader.id} is bound to another lane; unbind it there first`);
      }
      throw err;
    }
  });
}

/** End the lane's binding, by recording it. The row stays. */
export async function unbindReader(tenantId, laneId, { actor }) {
  requireConnect();
  await laneOr404(tenantId, laneId);
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE lane_readers SET unbound_at = now(), unbound_by = $3
        WHERE tenant_id = $1 AND lane_id = $2 AND unbound_at IS NULL
        RETURNING *`,
      [tenantId, laneId, actor],
    );
    if (!rows[0]) throw new ConnectRefusal(409, 'no_reader_bound', 'this lane has no reader bound');
    await appendEvents(client, tenantId, [{
      garageId: rows[0].garage_id,
      laneId,
      eventId: `lane-reader-unbound:${rows[0].id}`,
      kind: READER_UNBOUND_EVENT_KIND,
      occurredAt: new Date().toISOString(),
      detail: { reader_id: rows[0].reader_id, actor },
    }]);
    return rows[0];
  });
}

/** Every binding a garage's lanes have had, the current ones first. */
export async function listReaders(tenantId, garageId) {
  requireConnect();
  await getLocation(tenantId, garageId); // 404s an unknown garage
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM lane_readers WHERE tenant_id = $1 AND garage_id = $2
        ORDER BY (unbound_at IS NULL) DESC, bound_at DESC`,
      [tenantId, garageId],
    );
    return rows;
  });
}
