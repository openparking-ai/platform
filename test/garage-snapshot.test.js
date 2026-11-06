/**
 * A garage's own numbers (src/garageSnapshot.js): GET /garages/:garageId/today
 * and GET /garages/:garageId/snapshot.
 *
 * Held here: a car still inside counts in; a stay ended with no exit gate does
 * not count out; money is succeeded payments and never a stay's price; a
 * refund lands on the day it was refunded, and today's takings are net of it;
 * two currencies are refused, not added; a day is the garage's own across a
 * clock change, today's too; the first and last instant of a day are held; the
 * days refused in one sentence with no database words; another account's
 * garage is the same 404 as one that does not exist, and a person without
 * `money:read` is refused; one key is bounded by the minute and at once, and a
 * read by a statement timeout; and nothing that identifies a car, a person or
 * a payment is in either answer (each is planted, and none is found).
 *
 * `npm run garage-snapshot-fail-control` breaks each in turn.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, superuserClient } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import * as signIn from '../src/signIn.js';
import { instantToLocal } from '../src/garageTime.js';
import { READS_AT_ONCE, READS_PER_MINUTE } from '../src/garageSnapshot.js';
import { accountsStandIn } from './accounts-stand-in.js';

const PLATE = 'PLANTPLATE9';
const TICKET = 'PLANTTICKET7';
const DESCRIPTOR = 'planted-descriptor-silver-hatchback';
const PERSON = 'Planted Person Name';
const INTENT = 'pi_PLANTEDINTENT5';
const ACCOUNT = 'acct_fakeplanted3';
// The words a database error carries; none may reach an answer.
const DB_WORDS = /relation|column|syntax|SQLSTATE|violates|constraint|postgres|timestamptz|uuid|select|where/i;
const NO_GARAGE = '00000000-0000-4000-8000-000000000000';

const door = accountsStandIn();
let server;
let base;

const fetchAs = (path, headers) => fetch(`${base}/api/v1${path}`, { headers }).then(async (r) => {
  const text = await r.text();
  return { status: r.status, text, json: JSON.parse(text), noStore: r.headers.get('cache-control') };
});
const get = (path, key) => fetchAs(path, { authorization: `Bearer ${key}` });
const snapshot = (w, key, from, to) => get(`/garages/${w.garage}/snapshot?from=${from}&to=${to}`, key);

async function account(tag) {
  const tenant = await createTenant(tag);
  const world = await buildWorld(tenant);
  const key = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(key)]));
  return { tenant, world, key };
}

const asTenant = (w, fn) => withTenant(w.tenantId, fn);

async function car(c, w) {
  return (await c.query(`INSERT INTO vehicles (tenant_id, plate) VALUES ($1, $2) RETURNING id`, [w.tenantId, `${PLATE}${randomUUID().slice(0, 6)}`])).rows[0].id;
}

/** A car that came in at `entry` and is still inside. */
async function cameIn(c, w, entry, lane = w.entryLane) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO sessions (id, tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, open_event_id, currency, entry_confirmation, entry_descriptor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'USD','confirmed',$8)`,
    [id, w.tenantId, w.garage, await car(c, w), lane, entry, `open-${id}`, DESCRIPTOR],
  );
  return id;
}

/** A stay closed at an exit lane, at a price of `fee`. A price is not a payment: none is made here. */
async function leftByGate(c, w, id, exit, { fee = 400, lane = w.exitLane } = {}) {
  await c.query(
    `UPDATE sessions SET exit_at = $2, exit_lane_id = $3, close_event_id = $4, exit_confirmation = 'confirmed',
                         hourly_minor_applied = 250, fee_minor = $5
      WHERE id = $1`,
    [id, exit, lane, `close-${id}`, fee],
  );
}

/** A stay ended with no exit gate (0039). */
async function endedNoGate(c, id, at, reason) {
  const why = reason === 'superseded' ? {} : { by: `key:${PERSON}`, why: 'the car is gone' };
  await c.query(`UPDATE sessions SET exit_at = $2, ended = $3 WHERE id = $1`, [id, at, JSON.stringify({ reason, at, ...why })]);
}

/** A payment of a stay: open, then as `status` says, at `at`. */
async function paid(c, w, stay, { amount, at, status = 'succeeded', currency = 'usd' }) {
  const exit = (await c.query(
    `INSERT INTO exits (tenant_id, garage_id, lane_id, event_id, exit_at, method, session_id, quote)
     VALUES ($1,$2,$3,$4,$5,'single',$6,$7) RETURNING id`,
    [w.tenantId, w.garage, w.exitLane, `case-${randomUUID()}`, at, stay,
      JSON.stringify({ outcome: 'transient', fee_minor: amount, currency: currency.toUpperCase() })],
  )).rows[0].id;
  const id = (await c.query(
    `INSERT INTO exit_payments (tenant_id, garage_id, exit_id, session_id, channel, account_id, payment_intent_id,
                                amount_minor, currency, started_by)
     VALUES ($1,$2,$3,$4,'phone_reader',$5,$6,$7,$8,$9) RETURNING id`,
    [w.tenantId, w.garage, exit, stay, ACCOUNT, `${INTENT}${randomUUID().replaceAll('-', '')}`, amount, currency, PERSON],
  )).rows[0].id;
  if (status === 'succeeded') {
    await c.query(`UPDATE exit_payments SET status = 'succeeded', succeeded_at = $2 WHERE id = $1`, [id, at]);
  } else if (status === 'canceled') {
    await c.query(`UPDATE exit_payments SET status = 'canceled', canceled_at = $2 WHERE id = $1`, [id, at]);
  }
  return id;
}

/** One line of the refund ledger (0051): `amount` of `payment` at `at`, negative for a reversal. */
async function refundOf(c, w, payment, { amount, at, currency = 'usd' }) {
  await c.query(
    `INSERT INTO exit_refunds (tenant_id, garage_id, exit_payment_id, kind, amount_minor, refunded_total, currency, stripe_event_id, refunded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [w.tenantId, w.garage, payment, amount > 0 ? 'refund' : 'reversal', amount, Math.abs(amount), currency,
      `evt_fake${randomUUID().replaceAll('-', '')}`, at],
  );
}

before(async () => {
  process.env.ADMIN_ORIGIN = 'https://admin.example.test';
  process.env.SIGN_IN_REFUSAL_FLOOR_MS = '200';
  process.env.SIGN_IN_ATTEMPTS_PER_ADDRESS = '1000';
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  door.end();
});

test("TODAY: the phone's shape, for the garage's own day: a car still inside in, a car from yesterday out, takings net of today's refunds", async () => {
  const a = await account('snap-today');
  const w = a.world;
  // A zone where it is the middle of the day, so nothing here crosses midnight.
  const zone = ['America/New_York', 'Asia/Tokyo', 'Europe/London']
    .find((z) => { const hour = Number(instantToLocal(Date.now(), z).slice(11, 13)); return hour >= 4 && hour <= 19; });
  await asTenant(w, (c) => c.query('UPDATE garages SET timezone = $2 WHERE id = $1', [w.garage, zone]));
  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();
  await asTenant(w, async (c) => {
    await cameIn(c, w, ago(60_000)); // still inside
    await cameIn(c, w, ago(4 * 86_400_000)); // inside since before today
    await cameIn(c, w, ago(5 * 86_400_000)); // and another
    const fromYesterday = await cameIn(c, w, ago(3 * 86_400_000));
    await leftByGate(c, w, fromYesterday, ago(30_000));
    const payment = await paid(c, w, fromYesterday, { amount: 1250, at: ago(40_000) });
    await refundOf(c, w, payment, { amount: 250, at: ago(20_000) });
    // A refund today of an old payment comes off today.
    const old = await paid(c, w, await cameIn(c, w, ago(9 * 86_400_000)), { amount: 900, at: ago(8 * 86_400_000) });
    await refundOf(c, w, old, { amount: 100, at: ago(10_000) });
  });
  const r = await get(`/garages/${w.garage}/today`, a.key);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, {
    today: {
      date: instantToLocal(now, zone).slice(0, 10),
      entries: 1,
      exits: 1,
      open_stays: 4,
      takings_minor: 900,
      refunds_minor: 350,
      currency: 'USD',
    },
  });
  assert.equal(r.noStore, 'no-store');
});

test("TODAY IS THE GARAGE'S DAY, not UTC's: in the zone whose date differs from UTC's now", async () => {
  const a = await account('snap-today-zone');
  const w = a.world;
  const utc = new Date().toISOString().slice(0, 10);
  const zone = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((z) => instantToLocal(Date.now(), z).slice(0, 10) !== utc);
  await asTenant(w, (c) => c.query('UPDATE garages SET timezone = $2 WHERE id = $1', [w.garage, zone]));
  const r = await get(`/garages/${w.garage}/today`, a.key);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.today.date, instantToLocal(Date.now(), zone).slice(0, 10));
  assert.notEqual(r.json.today.date, utc);
});

test('TODAY ACROSS A CLOCK CHANGE: the 25th hour and the 23-hour day are still today, and no neighbour is', async (t) => {
  const a = await account('snap-today-clocks');
  const w = a.world;
  await asTenant(w, async (c) => {
    await cameIn(c, w, '2026-11-01T03:59:00Z'); // 23:59 on 31 October
    await cameIn(c, w, '2026-11-01T04:00:00Z'); // the day's first minute
    await cameIn(c, w, '2026-11-02T04:30:00Z'); // 23:30 EST, the 25th hour
    await cameIn(c, w, '2026-11-02T05:00:00Z'); // 00:00 on the 2nd
    await cameIn(c, w, '2026-03-08T04:59:00Z'); // 23:59 on the 7th
    await cameIn(c, w, '2026-03-08T05:00:00Z'); // the day's first minute
    await cameIn(c, w, '2026-03-09T03:30:00Z'); // 23:30 EDT, the 23rd hour
    await cameIn(c, w, '2026-03-09T04:00:00Z'); // 00:00 on the 9th
  });
  const at = async (now) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
    try {
      return await get(`/garages/${w.garage}/today`, a.key);
    } finally {
      t.mock.timers.reset();
    }
  };
  const back = await at('2026-11-02T04:45:00Z');
  assert.equal(back.status, 200, back.text);
  assert.deepEqual([back.json.today.date, back.json.today.entries], ['2026-11-01', 2]);
  const forward = await at('2026-03-09T03:45:00Z');
  assert.equal(forward.status, 200, forward.text);
  assert.deepEqual([forward.json.today.date, forward.json.today.entries], ['2026-03-08', 2]);
});

test('CARS: in counts a car still inside; out counts an exit lane and no stay that ended without one', async () => {
  const a = await account('snap-cars');
  const w = a.world;
  const closedExit = await asTenant(w, async (c) => {
    const lane = (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction, closed_at, closed_reason, closed_message, closed_by)
                                 VALUES ($1,$2,'Old Exit','exit',now(),'everyone','Closed','key:ops') RETURNING id`, [w.tenantId, w.garage])).rows[0].id;
    const left = await cameIn(c, w, '2026-09-01T13:00:00Z'); // 09:00 in New York
    await leftByGate(c, w, left, '2026-09-01T14:30:00Z'); // 90 minutes
    const quick = await cameIn(c, w, '2026-09-01T13:30:00Z');
    await leftByGate(c, w, quick, '2026-09-01T14:01:00Z', { lane }); // 31 minutes, at the lane closed since
    await cameIn(c, w, '2026-09-01T15:00:00Z'); // still inside
    await cameIn(c, w, '2026-08-20T15:00:00Z'); // inside since before the range: inside, not in
    for (const reason of ['superseded', 'ended', 'abandoned']) {
      await endedNoGate(c, await cameIn(c, w, '2026-09-01T16:00:00Z'), '2026-09-01T18:00:00Z', reason);
    }
    return lane;
  });
  const r = await snapshot(w, a.key, '2026-09-01', '2026-09-02');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ['by_hour', 'by_lane', 'currency', 'days', 'from', 'open_stays', 'spaces', 'to']);
  assert.equal(r.json.currency, 'USD');
  assert.equal(r.json.open_stays, 2);
  assert.equal(r.json.spaces, null);
  assert.deepEqual(r.json.days, [
    { date: '2026-09-01', cars_in: 6, cars_out: 2, takings_minor: 0, refunds_minor: 0, average_stay_minutes: 61 }, // 60.5, rounded
    { date: '2026-09-02', cars_in: 0, cars_out: 0, takings_minor: 0, refunds_minor: 0, average_stay_minutes: null },
  ]);
  // Hours are the garage's: 09:00 and 10:00 in New York, not 13:00 at UTC.
  assert.equal(r.json.by_hour.length, 24);
  assert.deepEqual(r.json.by_hour.map((h) => h.hour), Array.from({ length: 24 }, (_, i) => i));
  assert.deepEqual(r.json.by_hour[9], { hour: 9, cars_in: 2, cars_out: 0, takings_minor: 0, refunds_minor: 0 });
  assert.deepEqual(r.json.by_hour[10], { hour: 10, cars_in: 0, cars_out: 2, takings_minor: 0, refunds_minor: 0 });
  assert.equal(r.json.by_hour.reduce((n, h) => n + h.cars_out, 0), 2);
  assert.deepEqual(r.json.by_lane, [
    { lane_id: w.entryLane, name: 'Entry 1', direction: 'entry', closed: false, cars: 6 },
    { lane_id: w.exitLane, name: 'Exit 1', direction: 'exit', closed: false, cars: 1 },
    { lane_id: closedExit, name: 'Old Exit', direction: 'exit', closed: true, cars: 1 },
  ].sort((x, y) => x.direction.localeCompare(y.direction) || x.name.toLowerCase().localeCompare(y.name.toLowerCase())));

  await asTenant(w, (c) => c.query('UPDATE garages SET spaces = 80 WHERE id = $1', [w.garage]));
  assert.equal((await snapshot(w, a.key, '2026-09-01', '2026-09-01')).json.spaces, 80);
});

test("MONEY: what succeeded, on its garage-local day, never a stay's price; a refund on the day it was refunded, a reversal on its own", async () => {
  const a = await account('snap-money');
  const w = a.world;
  await asTenant(w, async (c) => {
    // A price of 900 and no payment: nothing was taken.
    await leftByGate(c, w, await cameIn(c, w, '2026-09-01T13:00:00Z'), '2026-09-01T14:00:00Z', { fee: 900 });
    // 23:30 on the 1st in New York, 03:30 on the 2nd at UTC.
    const first = await paid(c, w, await cameIn(c, w, '2026-09-01T20:00:00Z'), { amount: 1000, at: '2026-09-02T03:30:00Z' });
    // 00:30 on the 2nd in New York.
    await paid(c, w, await cameIn(c, w, '2026-09-01T21:00:00Z'), { amount: 500, at: '2026-09-02T04:30:00Z' });
    await paid(c, w, await cameIn(c, w, '2026-09-01T22:00:00Z'), { amount: 700, at: '2026-09-02T05:00:00Z', status: 'open' });
    await paid(c, w, await cameIn(c, w, '2026-09-01T22:30:00Z'), { amount: 800, at: '2026-09-02T05:00:00Z', status: 'canceled' });
    // Two refunds on the 4th, days after the payment, at 10:00 and 10:30 in New York.
    await refundOf(c, w, first, { amount: 300, at: '2026-09-04T14:00:00Z' });
    await refundOf(c, w, first, { amount: 200, at: '2026-09-04T14:30:00Z' });
    // One of them failed, the next day: back on that day, not undone on the 4th.
    await refundOf(c, w, first, { amount: -200, at: '2026-09-05T15:00:00Z' });
  });
  const r = await snapshot(w, a.key, '2026-09-01', '2026-09-05');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.days.map((d) => [d.date, d.takings_minor, d.refunds_minor]), [
    ['2026-09-01', 1000, 0], ['2026-09-02', 500, 0], ['2026-09-03', 0, 0], ['2026-09-04', 0, 500], ['2026-09-05', 0, -200],
  ]);
  assert.equal(r.json.by_hour[23].takings_minor, 1000);
  assert.equal(r.json.by_hour[0].takings_minor, 500);
  assert.equal(r.json.by_hour[10].refunds_minor, 500, 'by the hour it was refunded, added up');
  assert.equal(r.json.by_hour[11].refunds_minor, -200);
  assert.equal(r.json.by_hour[23].refunds_minor, 0);

  // A refund this week of a payment outside the range is still this week's.
  const week = await snapshot(w, a.key, '2026-09-04', '2026-09-04');
  assert.deepEqual([week.json.days[0].takings_minor, week.json.days[0].refunds_minor], [0, 500]);
});

test("A DAY'S EDGES: its first instant is in, the next day's first instant is out, for cars out, payments and refunds", async () => {
  const a = await account('snap-edges');
  const w = a.world;
  const first = '2026-09-02T04:00:00.000Z'; // 00:00 on the 2nd in New York
  const next = '2026-09-03T04:00:00.000Z'; // 00:00 on the 3rd
  await asTenant(w, async (c) => {
    for (const [i, at] of [[1, first], [2, next]]) {
      const stay = await cameIn(c, w, '2026-09-01T12:00:00Z');
      await leftByGate(c, w, stay, at);
      const payment = await paid(c, w, stay, { amount: 100 * i, at });
      await refundOf(c, w, payment, { amount: 10 * i, at });
    }
  });
  const r = await snapshot(w, a.key, '2026-09-02', '2026-09-02');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.days[0].cars_out, 1);
  assert.equal(r.json.by_lane.find((l) => l.direction === 'exit').cars, 1);
  assert.equal(r.json.by_hour.reduce((n, h) => n + h.cars_out, 0), 1);
  assert.equal(r.json.days[0].takings_minor, 100);
  assert.equal(r.json.by_hour.reduce((n, h) => n + h.takings_minor, 0), 100);
  assert.equal(r.json.days[0].refunds_minor, 10);
  assert.equal(r.json.by_hour.reduce((n, h) => n + h.refunds_minor, 0), 10);
});

test('A BIG SUM stays a whole number of minor units, and comes as a number', async () => {
  const a = await account('snap-sum');
  const w = a.world;
  await asTenant(w, async (c) => {
    for (let i = 0; i < 3; i += 1) {
      await paid(c, w, await cameIn(c, w, '2026-09-01T20:00:00Z'), { amount: 2_000_000_000, at: '2026-09-01T21:00:00Z' });
    }
  });
  const r = await snapshot(w, a.key, '2026-09-01', '2026-09-01');
  assert.strictEqual(r.json.days[0].takings_minor, 6_000_000_000);
});

test('TWO CURRENCIES are refused in a sentence, on both reads, and only for the days they fall in', async () => {
  const a = await account('snap-currency');
  const w = a.world;
  await asTenant(w, async (c) => {
    await paid(c, w, await cameIn(c, w, '2026-09-01T20:00:00Z'), { amount: 100, at: '2026-09-01T21:00:00Z' });
    await paid(c, w, await cameIn(c, w, '2026-09-02T20:00:00Z'), { amount: 100, at: '2026-09-02T21:00:00Z' });
    await paid(c, w, await cameIn(c, w, '2026-09-03T20:00:00Z'), { amount: 100, at: '2026-09-03T21:00:00Z', currency: 'eur' });
    // A refund of it, on a later day, is in that currency too.
    const late = await paid(c, w, await cameIn(c, w, '2026-08-20T20:00:00Z'), { amount: 100, at: '2026-08-20T21:00:00Z', currency: 'eur' });
    await refundOf(c, w, late, { amount: 50, at: '2026-09-10T15:00:00Z', currency: 'eur' });
  });
  const mixed = await snapshot(w, a.key, '2026-09-01', '2026-09-03');
  assert.equal(mixed.status, 409, mixed.text);
  assert.equal(mixed.json.code, 'currency_mixed');
  assert.match(mixed.json.error, /different currency/);
  assert.doesNotMatch(mixed.text, DB_WORDS);
  assert.equal((await snapshot(w, a.key, '2026-09-01', '2026-09-02')).json.days[1].takings_minor, 100);

  const refund = await snapshot(w, a.key, '2026-09-10', '2026-09-10');
  assert.equal(refund.status, 409, refund.text);

  const b = await account('snap-currency-today');
  await asTenant(b.world, async (c) => {
    await paid(c, b.world, await cameIn(c, b.world, new Date(Date.now() - 60_000).toISOString()), { amount: 100, at: new Date().toISOString(), currency: 'eur' });
  });
  const today = await get(`/garages/${b.world.garage}/today`, b.key);
  assert.equal(today.status, 409, today.text);
  assert.equal(today.json.code, 'currency_mixed');
});

test("A DAY ACROSS A CLOCK CHANGE is the garage's day of 25 or 23 hours, and the hours are its own", async () => {
  const a = await account('snap-clocks');
  const w = a.world;
  await asTenant(w, async (c) => {
    // Clocks back on 1 November 2026 in New York: a day of 25 hours.
    await cameIn(c, w, '2026-11-01T03:59:00Z'); // 23:59 on 31 October
    await cameIn(c, w, '2026-11-01T04:00:00Z'); // 00:00, the day's first minute
    await paid(c, w, await cameIn(c, w, '2026-11-01T05:30:00Z'), { amount: 100, at: '2026-11-01T05:40:00Z' }); // 01:30 EDT
    await paid(c, w, await cameIn(c, w, '2026-11-01T06:30:00Z'), { amount: 200, at: '2026-11-01T06:40:00Z' }); // 01:30 EST: the same hour again
    await cameIn(c, w, '2026-11-02T04:30:00Z'); // 23:30 EST, the 25th hour: a 24-hour day would have ended
    await cameIn(c, w, '2026-11-02T05:00:00Z'); // 00:00 on the 2nd
    // Clocks forward on 8 March 2026: a day of 23 hours, and no 02:00.
    await cameIn(c, w, '2026-03-08T05:00:00Z'); // 00:00 on the 8th
    await cameIn(c, w, '2026-03-08T06:59:00Z'); // 01:59 EST
    await cameIn(c, w, '2026-03-08T07:00:00Z'); // 03:00 EDT
    await cameIn(c, w, '2026-03-09T03:59:00Z'); // 23:59 EDT, a 24-hour day from midnight would be the same
    await cameIn(c, w, '2026-03-09T04:00:00Z'); // 00:00 on the 9th: a 24-hour day would still hold it
  });
  const back = await snapshot(w, a.key, '2026-11-01', '2026-11-01');
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json.days[0].cars_in, 4, 'the first minute to the 25th hour, and neither neighbour');
  assert.equal(back.json.by_hour[1].cars_in, 2, 'the hour the clocks repeat is one row');
  assert.equal(back.json.by_hour[1].takings_minor, 300);
  assert.equal(back.json.by_lane.find((l) => l.direction === 'entry').cars, 4, "the next day's first minute is the next day's");
  const around = await snapshot(w, a.key, '2026-10-31', '2026-11-02');
  assert.deepEqual(around.json.days.map((d) => [d.date, d.cars_in]), [['2026-10-31', 1], ['2026-11-01', 4], ['2026-11-02', 1]]);

  const forward = await snapshot(w, a.key, '2026-03-08', '2026-03-08');
  assert.equal(forward.json.days[0].cars_in, 4);
  assert.equal(forward.json.by_hour[2].cars_in, 0, 'the hour the clocks skip is a row of zeros');
  assert.equal(forward.json.by_hour[3].cars_in, 1);
  assert.equal(forward.json.by_hour.length, 24);
});

test('THE DAYS: 1 to 366 of them, and anything else refused in one plain sentence', async () => {
  const a = await account('snap-days');
  const w = a.world;
  assert.equal((await snapshot(w, a.key, '2026-01-01', '2026-01-01')).json.days.length, 1);
  const longest = await snapshot(w, a.key, '2025-01-01', '2026-01-01');
  assert.equal(longest.status, 200, longest.text);
  assert.equal(longest.json.days.length, 366);
  assert.equal(longest.json.days[365].date, '2026-01-01');
  const refused = [
    'from=2025-01-01&to=2026-01-02', // 367 days
    'from=2026-01-02&to=2026-01-01', // backwards
    'from=2026-01-01', // no last day: not "today"
    'to=2026-01-01', // no first day
    '',
    'from=2026-02-30&to=2026-03-01', // no such day
    'from=2026-01-01&to=2026-13-01',
    'from=1969-12-31&to=1969-12-31',
    'from=9999-12-31&to=9999-12-31',
    'from=2026-1-1&to=2026-1-2',
    "from=2026-01-01'&to=2026-01-02",
    'from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
    'from=2026-01-01&from=2026-01-02&to=2026-01-03', // two of one
    'from[a]=1&to=2026-01-03',
  ];
  for (const q of refused) {
    const r = await get(`/garages/${w.garage}/snapshot?${q}`, a.key);
    assert.equal(r.status, 400, `${q}: ${r.text}`);
    assert.match(r.json.error, /^(Choose a first and a last day|day is a date)/, q);
    assert.ok(['days_refused', 'day_invalid'].includes(r.json.code), q);
    assert.doesNotMatch(r.text, DB_WORDS, q);
  }
});

test('THE LAST DAYS OF THE CALENDAR are refused, not a 500, whatever the zone', async () => {
  const a = await account('snap-year-9999');
  const w = a.world;
  await asTenant(w, (c) => c.query(`UPDATE garages SET timezone = 'UTC' WHERE id = $1`, [w.garage]));
  for (const q of ['from=9999-12-30&to=9999-12-31', 'from=9999-12-31&to=9999-12-31', 'from=9999-01-01&to=9999-01-02']) {
    const r = await get(`/garages/${w.garage}/snapshot?${q}`, a.key);
    assert.equal(r.status, 400, `${q}: ${r.text}`);
    assert.equal(r.json.code, 'day_invalid', q);
  }
  assert.equal((await snapshot(w, a.key, '9998-12-30', '9998-12-31')).status, 200);
});

test('ONE KEY, BY THE MINUTE: past the limit it is 429 with a Retry-After; another key and other routes are not held', async () => {
  const a = await account('snap-limit');
  const b = await account('snap-limit-other');
  const w = a.world;
  for (let i = 0; i < READS_PER_MINUTE; i += 1) {
    const r = await get(`/garages/${w.garage}/today`, a.key);
    assert.equal(r.status, 200, `read ${i}: ${r.text}`);
  }
  const res = await fetch(`${base}/api/v1/garages/${w.garage}/today`, { headers: { authorization: `Bearer ${a.key}` } });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, 'too_many_reads');
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
  assert.equal((await snapshot(w, a.key, '2026-09-01', '2026-09-01')).status, 429, 'one limit for both reads');
  assert.equal((await get(`/garages/${b.world.garage}/today`, b.key)).status, 200);
  assert.equal((await get(`/garages/${w.garage}/lanes`, a.key)).status, 200);
});

test('ONE KEY, AT ONCE: past the limit a read is refused at once, and the turns come back', async () => {
  const a = await account('snap-at-once');
  const w = a.world;
  const su = superuserClient();
  await su.connect();
  await su.query('BEGIN');
  await su.query('LOCK TABLE exit_refunds IN ACCESS EXCLUSIVE MODE');
  try {
    const held = Array.from({ length: READS_AT_ONCE }, () => get(`/garages/${w.garage}/today`, a.key));
    await new Promise((r) => setTimeout(r, 150));
    const refused = await get(`/garages/${w.garage}/today`, a.key);
    assert.equal(refused.status, 429, refused.text);
    await su.query('ROLLBACK');
    for (const r of await Promise.all(held)) assert.equal(r.status, 200, r.text);
  } finally {
    await su.query('ROLLBACK').catch(() => {});
    await su.end();
  }
  assert.equal((await get(`/garages/${w.garage}/today`, a.key)).status, 200, 'every turn was given back');
});

test("A READ THAT RUNS LONG is cut off in a sentence, and the timeout stays with that read", async () => {
  const a = await account('snap-timeout');
  const w = a.world;
  const su = superuserClient();
  await su.connect();
  await su.query('BEGIN');
  await su.query('LOCK TABLE exit_refunds IN ACCESS EXCLUSIVE MODE');
  process.env.SNAPSHOT_TIMEOUT_MS = '200';
  try {
    for (const tail of ['today', 'snapshot?from=2026-09-01&to=2026-09-01']) {
      const res = await fetch(`${base}/api/v1/garages/${w.garage}/${tail}`, { headers: { authorization: `Bearer ${a.key}` } });
      const body = await res.json();
      assert.equal(res.status, 503, JSON.stringify(body));
      assert.equal(body.code, 'snapshot_timed_out');
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.doesNotMatch(body.error, DB_WORDS);
    }
  } finally {
    delete process.env.SNAPSHOT_TIMEOUT_MS;
    await su.query('ROLLBACK');
    await su.end();
  }
  const seen = await Promise.all(Array.from({ length: 10 }, () => pool.query('SHOW statement_timeout')));
  assert.ok(seen.every((r) => r.rows[0].statement_timeout === '0'), 'the pool keeps no timeout');
});

test("ANOTHER ACCOUNT'S GARAGE is the same 404 as one that does not exist; no account's numbers reach another; nor one garage's another's", async () => {
  const a = await account('snap-mine');
  const b = await account('snap-theirs');
  await asTenant(b.world, async (c) => {
    await cameIn(c, b.world, '2026-09-01T13:00:00Z');
  });
  await asTenant(a.world, async (c) => {
    await cameIn(c, a.world, '2026-09-01T13:00:00Z');
    await cameIn(c, a.world, '2026-09-01T14:00:00Z');
  });
  for (const tail of ['today', 'snapshot?from=2026-09-01&to=2026-09-01']) {
    const theirs = await get(`/garages/${b.world.garage}/${tail}`, a.key);
    const nothing = await get(`/garages/${NO_GARAGE}/${tail}`, a.key);
    assert.equal(theirs.status, 404, tail);
    assert.deepEqual([theirs.status, theirs.text], [nothing.status, nothing.text], tail);
    assert.equal((await get(`/garages/not-a-garage/${tail}`, a.key)).status, 404, tail);
    assert.equal((await fetchAs(`/garages/${a.world.garage}/${tail}`, {})).status, 401, tail);
  }
  // A bad range on another's garage says nothing more than the garage's 404.
  assert.equal((await get(`/garages/${b.world.garage}/snapshot?from=x`, a.key)).status, 404);

  // A second garage of the same account: its own numbers only.
  const second = await asTenant(a.world, async (c) => {
    const garage = (await c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Second','America/New_York','USD') RETURNING id`, [a.tenant])).rows[0].id;
    const entryLane = (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,'Second Entry','entry') RETURNING id`, [a.tenant, garage])).rows[0].id;
    const exitLane = (await c.query(`INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,'Second Exit','exit') RETURNING id`, [a.tenant, garage])).rows[0].id;
    const there = { ...a.world, garage, entryLane, exitLane };
    await paid(c, there, await cameIn(c, there, '2026-09-01T15:00:00Z', entryLane), { amount: 900, at: '2026-09-01T16:00:00Z' });
    return { garage };
  });
  const mine = await snapshot(a.world, a.key, '2026-09-01', '2026-09-01');
  assert.equal(mine.json.days[0].cars_in, 2);
  assert.equal(mine.json.open_stays, 2);
  assert.equal(mine.json.days[0].takings_minor, 0);
  assert.deepEqual(mine.json.by_lane.map((l) => l.name), ['Entry 1', 'Exit 1']);
  const theirSecond = await snapshot(second, a.key, '2026-09-01', '2026-09-01');
  assert.deepEqual([theirSecond.json.days[0].cars_in, theirSecond.json.days[0].takings_minor, theirSecond.json.open_stays], [1, 900, 1]);
});

test('MONEY:READ: a person without it is refused, one with it reads, and a garage outside their list is not there', async () => {
  const a = await account('snap-permission');
  const w = a.world;
  const other = await asTenant(w, async (c) => (await c.query(
    `INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,'Other','America/New_York','USD') RETURNING id`, [a.tenant])).rows[0].id);
  const person = async (permissions) => {
    const p = door.person(a.tenant, { garages: [w.garage], permissions });
    const r = await fetch(`${base}/api/v1/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: p.email, password: p.password }) });
    assert.equal(r.status, 200, await r.text());
    const c = r.headers.getSetCookie().find((x) => x.startsWith(`${signIn.COOKIE}=`));
    return { cookie: c.split(';')[0] };
  };
  const without = await person(['garages:read', 'stays:read']);
  const holder = await person(['money:read']);
  for (const tail of ['today', 'snapshot?from=2026-09-01&to=2026-09-01']) {
    const refused = await fetchAs(`/garages/${w.garage}/${tail}`, without);
    assert.equal(refused.status, 403, tail);
    assert.equal(refused.json.code, 'permission_refused', tail);
    assert.equal((await fetchAs(`/garages/${w.garage}/${tail}`, holder)).status, 200, tail);
    assert.equal((await fetchAs(`/garages/${other}/${tail}`, holder)).status, 404, tail);
  }
});

test('NO IDENTITY: a plate, a ticket, a descriptor, a person, payment ids and the ids of a car and a stay are planted, and none is in either answer', async () => {
  const a = await account('snap-identity');
  const w = a.world;
  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();
  const planted = await asTenant(w, async (c) => {
    const stay = await cameIn(c, w, ago(120_000));
    const vehicle = (await c.query('SELECT vehicle_id FROM sessions WHERE id = $1', [stay])).rows[0].vehicle_id;
    const payment = await paid(c, w, stay, { amount: 500, at: ago(60_000) });
    await refundOf(c, w, payment, { amount: 100, at: ago(50_000) });
    await leftByGate(c, w, stay, ago(30_000));
    const ticketed = (await c.query('INSERT INTO vehicles (tenant_id, ticket_ref) VALUES ($1, $2) RETURNING id', [w.tenantId, TICKET])).rows[0].id;
    const inside = await cameIn(c, w, ago(10_000));
    await c.query('UPDATE sessions SET vehicle_id = $2 WHERE id = $1', [inside, ticketed]);
    return { vehicle, stay, payment, ticketed, inside };
  });
  const day = (ms) => new Date(now + ms).toISOString().slice(0, 10);
  const range = await snapshot(w, a.key, day(-86_400_000), day(86_400_000));
  assert.equal(range.status, 200, range.text);
  assert.equal(range.json.days.reduce((n, d) => n + d.takings_minor, 0), 500, 'the planted stay is in the range');
  const answers = [range.text, (await get(`/garages/${w.garage}/today`, a.key)).text];
  for (const text of answers) {
    for (const word of [PLATE, TICKET, DESCRIPTOR, PERSON, INTENT, ACCOUNT, 'pi_', 'acct_', ...Object.values(planted)]) {
      assert.equal(text.includes(word), false, `${word} is in ${text}`);
    }
  }
  // And nothing beyond the fields named, at any depth.
  const keys = (v) => (Array.isArray(v) ? v.flatMap(keys) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
  assert.deepEqual([...new Set(keys(range.json))].sort(), [
    'average_stay_minutes', 'by_hour', 'by_lane', 'cars', 'cars_in', 'cars_out', 'closed', 'currency', 'date', 'days', 'direction',
    'from', 'hour', 'lane_id', 'name', 'open_stays', 'refunds_minor', 'spaces', 'takings_minor', 'to',
  ]);
});
