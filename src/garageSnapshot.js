/**
 * A garage's own numbers, for the owner's phone: how many cars came in and
 * went out, what was taken and given back, and when. It reads under the
 * caller's tenant and row-level security, one garage of its own account: it
 * is no one's read across accounts.
 *
 * WHAT COUNTS (the owner's words):
 *
 *   cars in   stays opened at an entry lane on a garage-local day, including
 *             cars still inside.
 *   cars out  stays closed AT AN EXIT LANE in the range. A stay ended with no
 *             exit gate (0039: superseded, ended by a person, abandoned) has
 *             no exit lane and is not counted out.
 *
 * MONEY IS WHAT WAS PAID, never `sessions.fee_minor`: that is the price, not
 * proof of payment. Takings are `exit_payments` that succeeded, by
 * `succeeded_at`, gross, tax included. Refunds are shown apart, on the day of
 * the payment they came out of and not on the day they were made, so a
 * day's takings and its refunds are the same payments and a past day's
 * takings never move. `refunded_minor` is what Stripe said when it was last
 * read (0048).
 *
 * AN AVERAGE STAY is of the cars counted out that day, on the day they left:
 * a stay with no exit gate has no time a gate saw it leave.
 *
 * DAYS ARE THE GARAGE'S OWN: the caller passes the instants its first day
 * starts and the day after its last starts (`garageDay` in src/app.js), and
 * a time is put on its day and hour by the garage's zone, so a day of 23 or
 * 25 hours is one day. The hour clocks repeat is one row; the hour they skip
 * is a row of zeros.
 *
 * NO IDENTITY. No plate, vehicle, picture, person or payment id: the query
 * selects times, lanes and amounts, and the answer is built field by field.
 *
 * ONE QUERY, the rows rolled up by the garage's hour once and read from there,
 * whatever the range. Three indexes take it to the rows wanted: the stays'
 * by entry and by exit (0039, 0044) and the payments' (0050).
 */
import { HttpError } from './errors.js';
import { toMinor } from './money.js';

export const RANGE_MAX_DAYS = 366;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const refused = () => new HttpError(
  400,
  `Choose a first and a last day, written YYYY-MM-DD, the first no later than the last, at most ${RANGE_MAX_DAYS} days.`,
  'days_refused',
);

/**
 * The days asked for, or a refusal. Named outright: an absent day is not today.
 * That each is a real date is `garageDay`'s to refuse, as for every garage day.
 */
export function readDays({ from, to } = {}) {
  if (typeof from !== 'string' || typeof to !== 'string' || !DAY.test(from) || !DAY.test(to)) throw refused();
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days < 0 || days >= RANGE_MAX_DAYS) throw refused();
  return { first: from, last: to };
}

/**
 * What the range adds up to, `from` and `to` being the instants its days run
 * between. `currencies` is every currency paid in: refusing to add across
 * them is the caller's.
 */
export async function read(client, tenantId, garage, { from, to }) {
  const { rows } = await client.query(
    `WITH facts AS (
       SELECT s.entry_at AT TIME ZONE $5 AS local, s.entry_lane_id AS lane_id, 1 AS cars_in, 0 AS cars_out,
              NULL::numeric AS minutes, 0 AS takings, 0 AS refunds, NULL::text AS currency
         FROM sessions s
        WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.entry_at >= $3 AND s.entry_at < $4
       UNION ALL
       SELECT s.exit_at AT TIME ZONE $5, s.exit_lane_id, 0, 1,
              extract(epoch FROM s.exit_at - s.entry_at) / 60, 0, 0, NULL
         FROM sessions s
        WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_lane_id IS NOT NULL
          AND s.exit_at >= $3 AND s.exit_at < $4
       UNION ALL
       SELECT p.succeeded_at AT TIME ZONE $5, NULL, 0, 0, NULL, p.amount_minor, p.refunded_minor, upper(p.currency)
         FROM exit_payments p
        WHERE p.tenant_id = $1 AND p.garage_id = $2 AND p.status = 'succeeded'
          AND p.succeeded_at >= $3 AND p.succeeded_at < $4
     ),
     hours AS (
       SELECT date_trunc('hour', local) AS at, lane_id, currency, sum(cars_in) AS cars_in, sum(cars_out) AS cars_out,
              sum(minutes) AS minutes, sum(takings) AS takings, sum(refunds) AS refunds
         FROM facts GROUP BY 1, 2, 3
     ),
     by_day AS (
       SELECT to_char(at, 'YYYY-MM-DD') AS date, sum(cars_in) AS cars_in, sum(cars_out) AS cars_out,
              sum(takings) AS takings_minor, sum(refunds) AS refunds_minor,
              round(sum(minutes) / nullif(sum(cars_out), 0)) AS average_stay_minutes
         FROM hours GROUP BY 1
     ),
     by_hour AS (
       SELECT extract(hour FROM at)::int AS hour, sum(cars_in) AS cars_in, sum(cars_out) AS cars_out, sum(takings) AS takings_minor
         FROM hours GROUP BY 1
     ),
     by_lane AS (
       SELECT lane_id, sum(cars_in + cars_out) AS cars FROM hours WHERE lane_id IS NOT NULL GROUP BY 1
     )
     SELECT (SELECT count(*)::int FROM sessions s
              WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL) AS open_stays,
            (SELECT coalesce(jsonb_agg(DISTINCT currency) FILTER (WHERE currency IS NOT NULL), '[]') FROM hours) AS currencies,
            (SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]') FROM by_day d) AS days,
            (SELECT coalesce(jsonb_agg(to_jsonb(h)), '[]') FROM by_hour h) AS hours,
            (SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'lane_id', l.id, 'name', l.name, 'direction', l.direction,
                      'closed', l.closed_at IS NOT NULL, 'cars', coalesce(b.cars, 0))
                      ORDER BY l.direction, lower(l.name), l.id), '[]')
               FROM lanes l LEFT JOIN by_lane b ON b.lane_id = l.id
              WHERE l.tenant_id = $1 AND l.garage_id = $2) AS lanes`,
    [tenantId, garage.id, from, to, garage.timezone],
  );
  return rows[0];
}

/** Every day from `first` to `last`, in order, each as `YYYY-MM-DD`. */
function eachDay(first, last) {
  const out = [];
  for (let at = Date.parse(`${first}T00:00:00Z`); at <= Date.parse(`${last}T00:00:00Z`); at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

const presentDay = (date, row) => ({
  date,
  cars_in: Number(row?.cars_in ?? 0),
  cars_out: Number(row?.cars_out ?? 0),
  takings_minor: toMinor(row?.takings_minor ?? 0, 'takings_minor'),
  refunds_minor: toMinor(row?.refunds_minor ?? 0, 'refunds_minor'),
  average_stay_minutes: row?.average_stay_minutes ?? null,
});

/** The answer for one day: what the phone's Today screen reads. */
export function presentToday(day, figures, currency) {
  const d = presentDay(day, figures.days.find((x) => x.date === day));
  return {
    date: day,
    entries: d.cars_in,
    exits: d.cars_out,
    open_stays: figures.open_stays,
    takings_minor: d.takings_minor,
    currency,
  };
}

/** The answer for a range: every day and every hour, a quiet one as zeros. */
export function presentRange({ first, last }, figures, garage) {
  const hour = (h) => figures.hours.find((x) => x.hour === h);
  return {
    from: first,
    to: last,
    currency: garage.currency,
    open_stays: figures.open_stays,
    spaces: garage.spaces ?? null,
    days: eachDay(first, last).map((date) => presentDay(date, figures.days.find((x) => x.date === date))),
    by_hour: Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      cars_in: Number(hour(h)?.cars_in ?? 0),
      cars_out: Number(hour(h)?.cars_out ?? 0),
      takings_minor: toMinor(hour(h)?.takings_minor ?? 0, 'takings_minor'),
    })),
    by_lane: figures.lanes.map((l) => ({ lane_id: l.lane_id, name: l.name, direction: l.direction, closed: l.closed, cars: Number(l.cars) })),
  };
}
