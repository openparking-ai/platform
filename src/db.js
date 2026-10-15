import pg from 'pg';
import { startSetting } from './startSettings.js';

const { Pool } = pg;

/**
 * The application pool. Points at APP_DATABASE_URL, which is a NOSUPERUSER
 * NOBYPASSRLS role — see docs/RLS_TEMPLATE.md for why that is not optional.
 */
export const pool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  // Checked before the port opens (src/startSettings.js): 1 to 100.
  max: startSetting('PG_POOL_MAX'),
  // A database that cannot be reached is answered in seconds, as a 503, not
  // waited on for as long as the operating system waits on a connection.
  connectionTimeoutMillis: 5000,
});

// THE DATABASE GOES AWAY (a restart, a failover, pg_terminate_backend: 57P01).
//
// An IDLE client whose connection closes is emitted as 'error' on the pool.
// With no listener Node throws it and the whole process exits. The pool has
// already dropped that client, and the next query opens a fresh one, so
// saying so is all there is to do.
//
// A client that is OUT of the pool -- held by a request -- emits 'error' on
// itself, and the pool does not listen to it then. So every client is
// listened to from the moment it connects ('connect' comes before the pool
// hands it out) for as long as it lives. That also covers the moment Postgres
// sends "ready" and "terminated" in one packet, when a new client is handed
// out and ended before any request could listen to it. The listener marks the
// client lost; withTenant and query below read the mark.
//
// The log names the code only: never Postgres's message, never a setting.
pool.on('error', (err) => {
  console.error(`[db] an idle connection closed (${codeOf(err)}); the pool replaces it`);
});
pool.on('connect', (client) => {
  client.on('error', (err) => {
    if (!lost.has(client)) lost.set(client, err);
  });
});

/** Clients whose connection is gone, with the error that said so. Weak: a closed client is let go. */
const lost = new WeakMap();
const gone = (client) => lost.has(client);

/**
 * The database could not be reached for this request. `saving`: the
 * connection was lost while the COMMIT was on its way, so the change may have
 * been saved -- the caller is told to check, not to send it again.
 * Answered as a plain 503 (src/app.js, src/signIn.js, src/accountDoors.js).
 */
export class DatabaseUnavailable extends Error {
  constructor(saving = false) {
    super('the database cannot be reached');
    this.code = saving ? 'database_unavailable_saving' : 'database_unavailable';
    this.saving = saving;
  }
}

/** The 503's words: fixed sentences, never a table, a host or Postgres's message. */
export const DATABASE_UNAVAILABLE = Object.freeze({
  error: 'The garage system cannot reach its records right now. Nothing was changed. Try again in a moment.',
  code: 'database_unavailable',
});
export const DATABASE_LOST_SAVING = Object.freeze({
  error: 'The garage system lost its connection as your change was being saved. Reload to see whether it was saved before trying again.',
  code: 'database_unavailable_saving',
});
/**
 * The body a DatabaseUnavailable is answered with. A read changes nothing, so
 * a read lost at its COMMIT is told the plain "unavailable", never "saving".
 */
export const unavailableAnswer = (err, method = 'POST') =>
  (err.saving && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? DATABASE_LOST_SAVING : DATABASE_UNAVAILABLE);
/** Seconds a caller is asked to wait before trying again. */
export const UNAVAILABLE_RETRY_AFTER = '5';

// The connection-loss codes: class 08 (connection exception) and 57P01-57P03
// (the server shut down, crashed, or is starting up).
const LOST = /^(08[0-9A-Z]{3}|57P0[123])$/;
/** A code fit for a log line: a SQLSTATE or an errno name, never a message. */
const codeOf = (err) => (typeof err?.code === 'string' && /^[0-9A-Z_]{1,32}$/i.test(err.code) ? err.code : 'connection_lost');
const RETRY_AFTER_MS = 200;

/** Thrown inside one try: the connection was lost (or never opened). */
class Lost extends Error {
  constructor(cause, saving) {
    super('connection lost');
    this.code = codeOf(cause);
    this.saving = saving;
  }
}

/** What the tests replace: the moment a COMMIT is lost cannot be timed against a real backend. */
export const internals = { connect: () => pool.connect() };

/** A client, or Lost when none can be had. */
async function connect() {
  try {
    return await internals.connect();
  } catch (err) {
    throw new Lost(err, false);
  }
}

/**
 * `once` tried, and tried once more on a fresh connection when the first was
 * lost before anything could have been saved. Anything else is thrown as it
 * came. `retry: false` for a transaction that does something outside this
 * database before its COMMIT (an email sent, another service asked to hold a
 * claim): a second try would do that thing twice.
 */
async function twice(once, { retry = true, what }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await once();
    } catch (err) {
      if (!(err instanceof Lost)) throw err;
      if (err.saving || !retry || attempt === 2) {
        console.error(`[db] database unavailable (${err.code}) during ${what}${err.saving ? ' while saving' : ''}; answered 503`);
        throw new DatabaseUnavailable(err.saving);
      }
      console.error(`[db] connection lost (${err.code}) during ${what}; trying once more on a fresh connection`);
      await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
    }
  }
}

/**
 * Run `fn` inside a transaction with the tenant context set.
 *
 * SET LOCAL scopes the setting to this transaction, so it cannot survive on a
 * pooled connection and leak into whatever borrows it next. A plain SET would.
 *
 * A connection lost (or never opened) BEFORE the COMMIT is sent: Postgres
 * rolls back a transaction whose connection ends, so nothing of that try is
 * kept, and the whole of `fn` is run once more on a fresh connection -- each
 * try its own BEGIN and its own tenant setting. A write and its change-log
 * line are written once, together, or not at all. A loss while the COMMIT
 * itself is on its way is NOT tried again: it may have been saved. Either way
 * the request ends in DatabaseUnavailable. A lost client is closed, never
 * handed to the next request.
 *
 * @param {string} tenantId
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @param {{ retry?: boolean }} [options]
 * @returns {Promise<T>}
 * @template T
 */
export async function withTenant(tenantId, fn, { retry = true } = {}) {
  if (!tenantId) throw new Error('withTenant requires a tenant id');

  return twice(async () => {
    const client = await connect();
    let committing = false;
    try {
      await client.query('BEGIN');
      // Parameterised: set_config is a function call, unlike SET LOCAL which
      // cannot take a bind parameter and would mean interpolating into SQL.
      await client.query('SELECT set_config($1, $2, true)', ['openparking.tenant_id', tenantId]);
      const result = await fn(client);
      // Lost before this line: the COMMIT is never sent, so nothing was saved.
      committing = !gone(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      if (gone(client) || LOST.test(String(err?.code ?? ''))) throw new Lost(lost.get(client) ?? err, committing);
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release(gone(client) ? true : undefined);
    }
  }, { retry, what: 'a transaction' });
}

/**
 * One statement outside a transaction, for the lookups that come before a
 * tenant is known (a key, a session, a device). Tried once more on a fresh
 * connection when the connection is lost, then DatabaseUnavailable. For a
 * statement that READS: one that writes in its own transaction could have
 * landed before the loss, and is sent with `pool.query`, its failure handled
 * where it is sent.
 */
export async function query(text, values) {
  return twice(async () => {
    const client = await connect();
    try {
      return await client.query(text, values);
    } catch (err) {
      if (gone(client) || LOST.test(String(err?.code ?? ''))) throw new Lost(lost.get(client) ?? err, false);
      throw err;
    } finally {
      client.release(gone(client) ? true : undefined);
    }
  }, { what: 'a lookup' });
}

/** Whether the database answers now: for /healthz. Never throws. */
export async function databaseAnswers() {
  let client;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    client?.release(client && gone(client) ? true : undefined);
  }
}

export async function closePool() {
  await pool.end();
}
