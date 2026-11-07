/**
 * Connections that cannot get stuck, for a door whose places must never be
 * lost to a stalled database (src/personDoor.js).
 *
 * THEY ARE NOT THE SHARED POOL'S. The door has a small pool of its own, opened
 * on first use, so nothing it does can take a connection from a garage, a lane
 * or a person at a screen, and the limits below sit on its sessions and on no
 * one else's. Its size is the door's places, so nobody ever waits in it.
 *
 * THE LIMITS, each for a different way of getting stuck:
 *   connectMs           a new connection that does not open.
 *   statementMs         Postgres ends any one statement.
 *   lockMs              Postgres gives up waiting on a row (55P03), so a write
 *                       never goes on waiting with nobody listening.
 *   idleInTransactionMs Postgres ends a transaction that has gone quiet, in
 *                       case it never hears the connection was dropped.
 *   the deadline        a whole request's time, here in this process. A network
 *                       gone silent stops Postgres's answer with no error and
 *                       no close, so only a timer on this side can end it. It
 *                       drops the connection, and whatever was in flight ends.
 *
 * A connection that failed in any way is dropped, never given back; the next
 * call opens a fresh one, so the door reopens alone when the database does.
 *
 * An answer that did not come is `DatabaseDidNotAnswer`: the door says 503.
 * LOCK_BUSY comes through as it is, so a door can answer a held row as it must.
 * Nothing here retries: the caller is told when to ask again.
 */
import pg from 'pg';

const { Pool } = pg;

export const LIMITS = Object.freeze({
  connectMs: 1000,
  statementMs: 1000,
  lockMs: 200,
  idleInTransactionMs: 3000,
  poolIdleMs: 30_000,
});

/** Postgres: a lock could not be had within lock_timeout. */
export const LOCK_BUSY = '55P03';

/** The database did not answer in time, or the connection went. Never a verdict on anyone. */
export class DatabaseDidNotAnswer extends Error {
  constructor(code = 'deadline') {
    super('the database did not answer');
    this.code = code;
  }
}

/** What the tests replace, to put a silent network between the door and Postgres. */
export const internals = { connectionString: () => process.env.APP_DATABASE_URL };

// Connection classes, a statement cut off, the server out of room; Node's and pg's own words for a lost socket.
const NO_ANSWER_CODE = /^(08|53|57P0|57014$)/;
const NO_ANSWER_ERRNO = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']);
const NO_ANSWER_WORDS = /^(timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error|Client was closed|Connection ended)/;

function answered(err) {
  if (err instanceof DatabaseDidNotAnswer) return err;
  const code = String(err?.code ?? '');
  if (NO_ANSWER_CODE.test(code) || NO_ANSWER_ERRNO.has(code) || NO_ANSWER_WORDS.test(String(err?.message))) {
    return new DatabaseDidNotAnswer(/^[0-9A-Z_]{1,32}$/.test(code) ? code : 'connection_lost');
  }
  return err;
}

/** Off the pool and its socket closed at once: on a silent network a polite close never ends. */
function drop(client) {
  client.release(true);
  client.connection?.stream?.destroy();
}

export function boundedDatabase({ connections }) {
  let pool = null;
  const thePool = () => {
    if (pool) return pool;
    pool = new Pool({
      connectionString: internals.connectionString(),
      max: connections,
      connectionTimeoutMillis: LIMITS.connectMs,
      idleTimeoutMillis: LIMITS.poolIdleMs,
      statement_timeout: LIMITS.statementMs,
      lock_timeout: LIMITS.lockMs,
      idle_in_transaction_session_timeout: LIMITS.idleInTransactionMs,
      allowExitOnIdle: true,
    });
    // As src/db.js says of the shared pool: a connection that closes, idle or
    // held, emits 'error', and with no listener the process exits.
    pool.on('error', (err) => console.error(`[db] a bounded connection closed (${err?.code ?? 'connection_lost'})`));
    pool.on('connect', (client) => client.on('error', () => {}));
    return pool;
  };

  /** `work(query)` on one connection, inside what is left of the time. */
  const onClient = async (until, work) => {
    const left = until - performance.now();
    if (left <= 0) throw new DatabaseDidNotAnswer();
    let timer;
    const timeUp = new Promise((_, refuse) => {
      timer = setTimeout(() => refuse(new DatabaseDidNotAnswer()), left);
    });
    timeUp.catch(() => {});
    const connecting = thePool().connect();
    let client = null;
    let failed = true;
    try {
      client = await Promise.race([connecting, timeUp]);
      const out = await work((text, values) => Promise.race([client.query(text, values), timeUp]));
      failed = false;
      return out;
    } catch (err) {
      throw answered(err);
    } finally {
      clearTimeout(timer);
      if (client === null) connecting.then(drop, () => {});
      else if (failed) drop(client);
      else client.release();
    }
  };

  return {
    /**
     * What one request may do, all of it inside `deadlineMs` from now: the same
     * two calls the shared code makes on src/db.js, with `within` for anything
     * else the request waits on.
     */
    forRequest(deadlineMs) {
      const until = performance.now() + deadlineMs;
      return {
        query: (text, values) => onClient(until, (query) => query(text, values)),
        inTenant: (tenantId, fn) => onClient(until, async (query) => {
          await query('BEGIN');
          await query('SELECT set_config($1, $2, true)', ['openparking.tenant_id', tenantId]);
          const out = await fn({ query });
          await query('COMMIT');
          return out;
        }),
        within(promise) {
          const left = until - performance.now();
          let timer;
          const timeUp = new Promise((_, refuse) => {
            timer = setTimeout(() => refuse(new DatabaseDidNotAnswer()), Math.max(0, left));
          });
          return Promise.race([promise, timeUp]).finally(() => clearTimeout(timer));
        },
      };
    },
    async close() {
      const closing = pool;
      pool = null;
      await closing?.end();
    },
  };
}
