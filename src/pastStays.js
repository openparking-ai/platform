/**
 * A garage's past stays: the operator reads its own history.
 *
 * `GET /garages/:garageId/stays/closed?from=&to=&limit=&after=` answers the
 * stays of one garage that CLOSED in a stated range -- when the car came in,
 * when it left, what it paid and how the exit ended -- oldest exit first,
 * a page at a time. It is a plain "your own history" read: it knows nothing
 * of what anyone will make of it, and it writes nothing and corrects nothing.
 *
 * NO VEHICLE IDENTITY. A stay row is joined to its vehicle, and the vehicle is
 * identity (a plate, a ticket, a descriptor, pictures). None of that is
 * selected here, and neither is the vehicle's id nor the stay's own id: a
 * history of money and times needs no handle on a car. The query reads
 * `sessions` alone, so there is no join that could carry one in.
 *
 * BOUNDED. The range is required, at most RANGE_MAX_DAYS long, and the
 * answer is paged at most PAGE_MAX rows a page. Anything outside the bounds
 * is refused in a sentence that says what is allowed -- never clamped
 * silently, because a history read over a quietly shortened range is wrong
 * without saying so.
 *
 * INSTANTS ONLY. `from`, `to` and every time in the answer are instants. The
 * garage's time zone is on the garage (`GET /garages/:garageId`); the reader
 * buckets by local day itself.
 */
import { HttpError } from './errors.js';

export const RANGE_MAX_DAYS = 93;
export const PAGE_DEFAULT = 1000;
export const PAGE_MAX = 5000;

const bad = (message, code) => new HttpError(400, message, code);

// An instant names its offset: a time without one would be read in this
// server's zone, which is nobody's garage.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

function instant(raw, label) {
  if (typeof raw !== 'string' || !INSTANT.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw bad(
      `${label} is required and must be a date and time with its offset, such as 2026-10-01T00:00:00Z`,
      'range_invalid',
    );
  }
  return new Date(raw);
}

/** The range and the page the caller asked for, or a refusal that says why. */
export function readQuery(query) {
  const from = instant(query.from, 'from');
  const to = instant(query.to, 'to');
  if (to <= from) throw bad('to must be later than from', 'range_invalid');
  if (to - from > RANGE_MAX_DAYS * 24 * 3600 * 1000) {
    throw bad(`the range can be at most ${RANGE_MAX_DAYS} days; ask for a shorter one`, 'range_too_long');
  }

  let limit = PAGE_DEFAULT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^\d{1,6}$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > PAGE_MAX) {
      throw bad(`limit must be a whole number from 1 to ${PAGE_MAX}`, 'page_size_invalid');
    }
    limit = Number(query.limit);
  }

  let after = null;
  if (query.after !== undefined) after = readCursor(query.after);
  return { from, to, limit, after };
}

// The cursor is where the last page ended: that stay's exit time, exactly as
// the database holds it (microseconds), and its id to break a tie. It is
// opaque to the caller and checked on the way back in.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function writeCursor(row) {
  return Buffer.from(JSON.stringify([row.exit_key, row.id])).toString('base64url');
}

function readCursor(raw) {
  const refused = () => bad('after must be the next value from the previous page, unchanged', 'cursor_invalid');
  if (typeof raw !== 'string' || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw refused();
  let value;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw refused();
  }
  if (!Array.isArray(value) || value.length !== 2) throw refused();
  const [at, id] = value;
  if (typeof at !== 'string' || !CURSOR_TIME.test(at) || Number.isNaN(Date.parse(at))) throw refused();
  if (typeof id !== 'string' || !UUID.test(id)) throw refused();
  return { at, id };
}

/**
 * One page of the garage's closed stays. The caller has already found the
 * garage under the tenant (another tenant's garage is the same 404 as one that
 * does not exist); `tenant_id` is in the predicate anyway, beside the tenant
 * policy -- two independent controls, per docs/RLS_TEMPLATE.md.
 */
export async function closedStays(client, tenantId, garageId, { from, to, limit, after }) {
  const { rows } = await client.query(
    `SELECT s.id, to_json(s.exit_at) #>> '{}' AS exit_key,
            s.entry_at, s.exit_at, s.fee_minor, s.subtotal_minor, s.currency, s.exit_outcome,
            (s.pricing_refusal IS NOT NULL) AS pricing_refused, s.occupancy_at_entry_bp,
            s.ended->>'reason' AS ended, (s.ended->'owed'->>'pass_unasked')::boolean AS pass_unasked,
            COALESCE(s.ended->'owed'->'fee_minor') AS owed_minor
       FROM sessions s
      WHERE s.tenant_id = $1 AND s.garage_id = $2
        AND s.exit_at >= $3 AND s.exit_at < $4
        AND ($5::timestamptz IS NULL OR (s.exit_at, s.id) > ($5::timestamptz, $6::uuid))
      ORDER BY s.exit_at, s.id
      LIMIT $7`,
    [tenantId, garageId, from, to, after?.at ?? null, after?.id ?? null, limit + 1],
  );
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return {
    stays: page.map(present),
    next: more ? writeCursor(page[page.length - 1]) : null,
  };
}

/**
 * The fields of a past stay, and only those. `exit_outcome` is null on a stay
 * priced by the old hourly rate, before outcomes were named (0015);
 * `fee_minor` is null on a covered stay and on one the engine refused to price
 * (`pricing_refused`), which is not a stay that paid nothing. `ended` names
 * how a stay no exit closed ended (0039) -- `superseded`, `ended` or
 * `abandoned` -- and is null on every stay an exit closed. `owed_minor` is
 * what a stay a person ended because the car left owes (0043) -- its
 * `fee_minor` stays null, because nothing was paid -- and null on every
 * other stay, or when the rates refused to price it. (Read from wherever a
 * stay keeps what it owes: one COALESCE, so another place is one more
 * argument.) `pass_unasked` is true on such a stay whose garage links a pass
 * and had no exit lane to ask it at, false when the pass was asked or none
 * is linked, and null where nothing is owed or it was not recorded.
 */
function present(row) {
  return {
    entry_at: row.entry_at,
    exit_at: row.exit_at,
    fee_minor: row.fee_minor === null ? null : Number(row.fee_minor),
    subtotal_minor: row.subtotal_minor === null ? null : Number(row.subtotal_minor),
    currency: row.currency,
    exit_outcome: row.exit_outcome,
    pricing_refused: row.pricing_refused,
    // How full the garage was when the car came in (0034), or null.
    occupancy_at_entry_bp: row.occupancy_at_entry_bp,
    ended: row.ended,
    owed_minor: row.owed_minor === null || row.owed_minor === undefined ? null : Number(row.owed_minor),
    pass_unasked: row.pass_unasked ?? null,
  };
}
