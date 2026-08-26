import pg from 'pg';

const { Pool } = pg;

/**
 * The application pool. Points at APP_DATABASE_URL, which is a NOSUPERUSER
 * NOBYPASSRLS role — see docs/RLS_TEMPLATE.md for why that is not optional.
 */
export const pool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
});

// A pool with no error handler takes the process down on any idle-client
// disconnect (failover, restart, network blip). Handle it.
pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

/**
 * Run `fn` inside a transaction with the tenant context set.
 *
 * SET LOCAL scopes the setting to this transaction, so it cannot survive on a
 * pooled connection and leak into whatever borrows it next. A plain SET would.
 *
 * @param {string} tenantId
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withTenant(tenantId, fn) {
  if (!tenantId) throw new Error('withTenant requires a tenant id');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Parameterised: set_config is a function call, unlike SET LOCAL which
    // cannot take a bind parameter and would mean interpolating into SQL.
    await client.query('SELECT set_config($1, $2, true)', ['openparking.tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
