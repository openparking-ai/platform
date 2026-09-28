/**
 * A garage's taxes: stated as sets, held as stated, read back whole
 * (migration 0022).
 *
 * `rate-engine`'s `tax.py` is the only tax arithmetic in the estate, and it
 * has no persistence: it takes a garage's tax SETS -- each an
 * `effective_from` and its rules -- and picks the one in force at an instant.
 * This module is where those sets live. It judges none of them and computes
 * nothing:
 *
 *   judge     is the ENGINE's, and only the engine's. The set, exactly as the
 *             request carried it, goes to `POST /v1/validate-tax-sets` --
 *             which hands it to `load_tax_sets`, the loader the close will use
 *             -- BEFORE anything here reads a field of it. Whatever that door
 *             refuses is refused, in its words; whatever it loads is valid.
 *             This platform once kept its own copy of those rules, and the two
 *             disagreed on ten inputs: a set one accepted and the other
 *             refused was stored where it could never be loaded again. So
 *             there is no copy, here or in the table.
 *   store     what the door accepted, and only that: the instant as the
 *             engine READ it (its echo, not the request's spelling), the rules
 *             as given. What a valid set can still fail is STORAGE -- a NUL
 *             byte PostgreSQL text cannot hold, a number past its `integer`,
 *             an instant `timestamptz` cannot hold or cannot give back. Each is
 *             refused as `tax_set_not_storable`, named as a limit of where the
 *             set is kept and never as a judgement of the set.
 *   prove     before the transaction commits, the garage's WHOLE list is read
 *             back in the form a load gets it and handed to the same door. A
 *             stored set that would not load is not stored. That is the
 *             failure this module exists to make impossible: sets are
 *             append-only and the engine loads a garage's list whole, so one
 *             unloadable set would make every later one unloadable too.
 *   read      every set of the garage, each with its rules in the garage's
 *             stated order, the instant to the microsecond it is stored at.
 *             No selection here: the engine chooses the set in force.
 *
 * NO PERCENTAGE IS COMPUTED HERE, and nothing here hands a set to the close:
 * no stay carries a tax after this round.
 */
import * as repo from './repository.js';
import { EngineUnavailable, rateEngineUrl } from './ratePlans.js';

export const TAX_SET_STATED_EVENT_KIND = 'tax_set_stated';

/** PostgreSQL's `integer`, the type of `percent_bp` and `sequence`. A storage bound, not a rule of tax. */
const INTEGER_MIN = -2_147_483_648;
const INTEGER_MAX = 2_147_483_647;

/**
 * A stored instant as a load gets it: UTC, to the microsecond `timestamptz`
 * holds. A JavaScript Date keeps milliseconds, so reading the column as one
 * would hand the engine an instant the table does not hold -- and two sets a
 * microsecond apart as one instant, which the engine refuses.
 */
const instantText = (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Why the store would not store. `code` is published beside the message. */
export class TaxSetRefused extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const notStorable = (message, details) =>
  new TaxSetRefused(
    'tax_set_not_storable',
    `${message}. The rate engine accepts this set; this is a limit of where this platform keeps it, not a judgement of the set, and nothing was stored`,
    details,
  );

/**
 * Hand `taxSets` to the engine's `POST /v1/validate-tax-sets`, as they are.
 *
 * `{ loaded: [{ effective_from, rule_count }, ...] }` -- the engine's reading of
 * each set, in order -- or `{ refused: <the engine's sentence> }`. No engine,
 * or an answer that is neither, is `EngineUnavailable`: handled as
 * `quoteWithEngine` handles it, and never counted as a yes.
 */
async function askEngine(taxSets, { url = rateEngineUrl(), timeoutMs = 10 * 1000 } = {}) {
  if (!url) {
    throw new EngineUnavailable('RATE_ENGINE_URL is not set; a tax set is judged by the engine before it is stored, and by nothing else');
  }
  let res;
  let text;
  try {
    res = await fetch(`${url}/v1/validate-tax-sets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tax_sets: taxSets }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    throw new EngineUnavailable(`the rate engine at ${url} could not be reached (${err?.cause?.code ?? err?.name ?? err})`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object') {
    throw new EngineUnavailable(`the rate engine at ${url} answered HTTP ${res.status} without a JSON body`);
  }
  if (res.status === 400 && body.invalid === true && typeof body.error === 'string') {
    return { refused: body.error };
  }
  if (
    res.status === 200 &&
    Array.isArray(body.tax_sets) &&
    body.tax_sets.length === taxSets.length &&
    body.tax_sets.every((s) => typeof s?.effective_from === 'string' && Number.isInteger(s?.rule_count))
  ) {
    return { loaded: body.tax_sets };
  }
  throw new EngineUnavailable(
    `the rate engine at ${url} answered HTTP ${res.status} with a body this platform does not recognise as a tax-set validation: ${text.slice(0, 300)}`,
  );
}

/**
 * The set from a request body, judged by the engine and by nothing here --
 * called before anything reads a field of it. Returns `{ given, effectiveFrom,
 * rules }`: the set as written, the instant as the engine read it, and the
 * rules the engine accepted. Refused sets are `tax_set_invalid`, carrying the
 * engine's sentence.
 */
export async function judgeTaxSet(raw, engine = {}) {
  const answer = await askEngine([raw ?? null], engine);
  if (answer.refused !== undefined) {
    throw new TaxSetRefused('tax_set_invalid', `the rate engine refused the tax set: ${answer.refused}`);
  }
  return { given: raw, effectiveFrom: answer.loaded[0].effective_from, rules: raw.rules };
}

/**
 * The storage limits a set the engine accepted can still exceed, each named
 * as one. Two of them are PostgreSQL's: text holds no U+0000, and `integer`
 * ends at 2^31. The third is UTF-8's: a lone UTF-16 surrogate has no encoding,
 * and the driver would silently write U+FFFD -- a text the engine never
 * judged. Nothing here asks whether a value is a GOOD one.
 */
export function assertStorable(set) {
  set.rules.forEach((rule, i) => {
    for (const key of ['id', 'label']) {
      const where = `tax_set.rules[${i}].${key}`;
      if (rule[key].includes('\u0000')) {
        throw notStorable(`${where} contains U+0000 (NUL), which PostgreSQL text cannot hold`, { field: where, limit: 'text_nul' });
      }
      if (!rule[key].isWellFormed()) {
        throw notStorable(
          `${where} contains a lone UTF-16 surrogate, which has no UTF-8 form; it would be stored as U+FFFD, a text nothing judged`,
          { field: where, limit: 'text_encoding' },
        );
      }
    }
    for (const key of ['percent_bp', 'sequence']) {
      const where = `tax_set.rules[${i}].${key}`;
      if (rule[key] < INTEGER_MIN || rule[key] > INTEGER_MAX) {
        throw notStorable(
          `${where} is ${rule[key]}, outside the column's integer range ${INTEGER_MIN} to ${INTEGER_MAX}`,
          { field: where, limit: 'integer_range' },
        );
      }
    }
  });
}

/**
 * Store one judged set for one garage, inside the caller's tenant
 * transaction, prove the garage's whole list still loads, and record it.
 * Stating a set supersedes nothing: a later `effective_from` is how a rate
 * changes or a tax ends.
 *
 * Two sets at one instant is refused with BOTH named, by the table's UNIQUE
 * constraint -- which is here for the one case the door cannot see: two
 * requests racing, each loading alone. The instant is compared as an instant:
 * `10:00-05:00` and `15:00Z` are one moment.
 */
export async function storeTaxSet(client, tenantId, { garage, set, actor, now = null, engine = {} }) {
  await client.query('SAVEPOINT tax_set_insert');
  let row;
  try {
    const { rows } = await client.query(
      `INSERT INTO garage_tax_sets (tenant_id, garage_id, effective_from, rule_count)
       VALUES ($1, $2, $3::timestamptz, $4)
       RETURNING id`,
      [tenantId, garage.id, set.effectiveFrom, set.rules.length],
    );
    row = rows[0];
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'garage_tax_sets_one_set_per_instant') {
      await client.query('ROLLBACK TO SAVEPOINT tax_set_insert');
      const held = (
        await client.query(
          `SELECT id, ${instantText('effective_from')} AS effective_from, created_at FROM garage_tax_sets
            WHERE tenant_id = $1 AND garage_id = $2 AND effective_from = $3::timestamptz`,
          [tenantId, garage.id, set.effectiveFrom],
        )
      ).rows[0];
      throw new TaxSetRefused(
        'tax_set_effective_from_taken',
        `two tax sets would be in force from one instant: set ${held?.id ?? '(stated concurrently)'}, stated ` +
          `${held?.created_at?.toISOString?.() ?? 'just now'}, already takes effect at ` +
          `${held?.effective_from ?? set.effectiveFrom}, and this set would take effect at ` +
          `${set.given.effective_from}. Which one is in force would be decided by nothing; refused, both named`,
        {
          held: held ? { id: held.id, effective_from: held.effective_from, created_at: held.created_at } : null,
          refused: { effective_from: set.given.effective_from, rule_count: set.rules.length },
        },
      );
    }
    // A data exception on this row can only be the instant: the engine read
    // it, and `timestamptz` cannot hold it (an offset past +/-15:59, say).
    if (err.code?.startsWith('22')) {
      throw notStorable(
        `tax_set.effective_from ${JSON.stringify(set.given.effective_from)} cannot be held as a PostgreSQL timestamptz (${err.message})`,
        { field: 'tax_set.effective_from', limit: 'timestamptz' },
      );
    }
    throw err;
  }
  await client.query('RELEASE SAVEPOINT tax_set_insert');
  for (const rule of set.rules) {
    await client.query(
      `INSERT INTO garage_tax_rules (tenant_id, tax_set_id, rule_id, label, percent_bp, rounding, sequence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, row.id, rule.id, rule.label, rule.percent_bp, rule.rounding, rule.sequence],
    );
  }

  // Held as given? The instant must come back as the instant stored -- UTC
  // before year 1 does not -- and the rules as the rules judged.
  const faithful = (
    await client.query(
      `SELECT ${instantText('effective_from')}::timestamptz = effective_from AS instant FROM garage_tax_sets WHERE id = $1`,
      [row.id],
    )
  ).rows[0];
  const sets = await taxSetsForGarage(client, tenantId, garage.id);
  const stored = sets.find((s) => s.id === row.id);
  if (!faithful.instant) {
    throw notStorable(
      `tax_set.effective_from ${JSON.stringify(set.given.effective_from)} is stored, but reads back in UTC as ` +
        `${stored.effective_from}, a different instant`,
      { field: 'tax_set.effective_from', limit: 'timestamptz_read_back' },
    );
  }
  const bySequence = (a, b) => a.sequence - b.sequence;
  const judged = [...set.rules].sort(bySequence).map(({ id, label, percent_bp, rounding, sequence }) => ({ id, label, percent_bp, rounding, sequence }));
  if (JSON.stringify(stored.rules) !== JSON.stringify(judged)) {
    throw notStorable('tax_set.rules read back differently from how they were given', { field: 'tax_set.rules', limit: 'read_back' });
  }
  // The garage's whole list, as a load gets it, through the same door.
  const load = await askEngine(sets.map((s) => ({ effective_from: s.effective_from, rules: s.rules })), engine);
  if (load.refused !== undefined) {
    throw notStorable(
      `stored, this garage's tax sets would not load in the rate engine: ${load.refused}`,
      { field: 'tax_set', limit: 'load' },
    );
  }

  // The record: who stated which set, for which garage. WHO travels inside
  // `detail`, the convention every operator act here follows.
  await repo.appendEvents(client, tenantId, [
    {
      garageId: garage.id,
      laneId: null,
      eventId: `tax_set:${row.id}`,
      kind: TAX_SET_STATED_EVENT_KIND,
      occurredAt: now ?? stored.created_at,
      detail: {
        actor,
        tax_set_id: row.id,
        effective_from: stored.effective_from,
        rule_count: stored.rule_count,
        rules: stored.rules,
      },
    },
  ]);
  return stored;
}

/**
 * Every set of the garage, oldest effective date first, each with its rules
 * in their stated `sequence`. The ORDER decides nothing; the engine picks
 * the set in force by instant.
 *
 * Each set is exactly what a load takes -- `effective_from` as UTC text to
 * the microsecond, each rule the engine's five keys (`rule_id` is named back
 * to `id` on the way out) -- beside the store's own `id`, `garage_id`,
 * `rule_count` and `created_at`.
 */
export async function taxSetsForGarage(client, tenantId, garageId) {
  const { rows: sets } = await client.query(
    `SELECT s.id, s.garage_id, ${instantText('s.effective_from')} AS effective_from, s.rule_count, s.created_at
       FROM garage_tax_sets s
      WHERE s.tenant_id = $1 AND s.garage_id = $2
      ORDER BY s.effective_from`,
    [tenantId, garageId],
  );
  if (sets.length === 0) return [];
  const { rows: rules } = await client.query(
    `SELECT tax_set_id, rule_id, label, percent_bp, rounding, sequence
       FROM garage_tax_rules
      WHERE tenant_id = $1 AND tax_set_id = ANY($2::uuid[])
      ORDER BY sequence`,
    [tenantId, sets.map((s) => s.id)],
  );
  return sets.map((s) => ({
    ...s,
    rules: rules
      .filter((r) => r.tax_set_id === s.id)
      .map((r) => ({ id: r.rule_id, label: r.label, percent_bp: r.percent_bp, rounding: r.rounding, sequence: r.sequence })),
  }));
}

/**
 * What the activation gate sees of the garage's taxes: how many sets are
 * stated, how many are in force at `now`, and the one in force (the latest
 * at or before `now`). Presence and coverage only -- no set is interpreted.
 */
export async function taxPosition(client, tenantId, garageId, { now = null } = {}) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS stated,
            count(*) FILTER (WHERE effective_from <= COALESCE($3::timestamptz, now()))::int AS in_force,
            min(effective_from) AS earliest,
            (SELECT row_to_json(s) FROM (
               SELECT id, effective_from, rule_count FROM garage_tax_sets
                WHERE tenant_id = $1 AND garage_id = $2 AND effective_from <= COALESCE($3::timestamptz, now())
                ORDER BY effective_from DESC LIMIT 1) s) AS current
       FROM garage_tax_sets
      WHERE tenant_id = $1 AND garage_id = $2`,
    [tenantId, garageId, now],
  );
  return rows[0];
}
