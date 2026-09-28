/**
 * A garage's taxes: stated as sets, held as stated, read back whole
 * (migration 0022).
 *
 * `rate-engine`'s `tax.py` is the only tax arithmetic in the estate, and it
 * has no persistence: it takes a garage's tax SETS -- each an
 * `effective_from` and its rules -- and picks the one in force at an instant.
 * This module is where those sets live. It does three things and computes
 * nothing:
 *
 *   validate  the set's shape, to the engine's own load rules: exactly
 *             `effective_from` and `rules` on a set, exactly `id`, `label`,
 *             `percent_bp`, `rounding` and `sequence` on a rule. A missing
 *             field and an unknown one -- `base` included, because there is
 *             one base and it is not stated -- are refused and named. The
 *             pinned engine has no door that validates a tax set, so this is
 *             said here and held again by the table's CHECKs; it is the
 *             engine's rule, restated, not a second opinion of it.
 *   store     the set and its rules, in one transaction, with the number of
 *             rules it states. Zero rules is the statement "this garage
 *             charges no tax". A set taking effect at an instant another set
 *             already holds is refused, both named.
 *   read      every set of the garage, each with its rules in the garage's
 *             stated order. No selection here: the engine chooses the set in
 *             force, as it chooses the plan.
 *
 * NO PERCENTAGE IS COMPUTED HERE, and nothing here hands a set to the close:
 * no stay carries a tax after this round.
 */
import * as repo from './repository.js';

export const TAX_SET_STATED_EVENT_KIND = 'tax_set_stated';

/** The engine's `TAX_ROUNDINGS`. No default: who keeps the fraction is the garage's to state. */
export const TAX_ROUNDINGS = Object.freeze(['up', 'down', 'nearest']);

/** The engine's `TAX_SET_KEYS` and `TAX_RULE_KEYS`: all required, nothing else. */
const SET_KEYS = Object.freeze(['effective_from', 'rules']);
const RULE_KEYS = Object.freeze(['id', 'label', 'percent_bp', 'rounding', 'sequence']);

/** The columns are `integer`; a larger number is refused by name, not by a 500. */
const INTEGER_MAX = 2_147_483_647;

/** An ISO 8601 instant WITH an offset. A naive timestamp would be read in the server's zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Why the store would not store. `code` is published beside the message. */
export class TaxSetRefused extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const invalid = (message) => new TaxSetRefused('tax_set_invalid', message);

function exactKeys(raw, keys, where) {
  const missing = keys.filter((k) => !Object.hasOwn(raw, k));
  const unknown = Object.keys(raw).filter((k) => !keys.includes(k));
  if (missing.length || unknown.length) {
    const said = [];
    if (missing.length) said.push(`missing ${missing.join(', ')}`);
    if (unknown.length) said.push(`unknown ${unknown.join(', ')}`);
    throw invalid(
      `${where}: ${said.join('; ')}. A ${where.includes('rules[') ? 'rule' : 'set'} carries exactly ` +
        `${keys.join(', ')}` +
        (unknown.includes('base')
          ? ' -- there is no base: tax is a percentage of the money actually paid, and nothing states otherwise'
          : ''),
    );
  }
}

function whole(value, label, { min }) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > INTEGER_MAX) {
    throw invalid(`${label} must be a whole number from ${min} to ${INTEGER_MAX}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function text(value, label, why = '') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${label} must be a non-empty string${why}`);
  }
  return value;
}

/**
 * The set from a request body, or a refusal naming the field. Returns
 * `{ effectiveFrom, rules }` with the rules as given; the order they arrive
 * in decides nothing -- `sequence` does.
 */
export function taxSetDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('tax_set is required and must be a JSON object: { effective_from, rules }');
  }
  exactKeys(raw, SET_KEYS, 'tax_set');
  const effectiveFrom = raw.effective_from;
  if (typeof effectiveFrom !== 'string' || !INSTANT.test(effectiveFrom) || Number.isNaN(Date.parse(effectiveFrom))) {
    throw invalid(
      `tax_set.effective_from must be an ISO 8601 instant with a UTC offset, got ${JSON.stringify(effectiveFrom)}; ` +
        'a naive timestamp would be read in whatever zone the server runs in',
    );
  }
  if (!Array.isArray(raw.rules)) {
    throw invalid(
      'tax_set.rules must be a list. An EMPTY list is how a garage states that it charges no tax from effective_from',
    );
  }
  const rules = raw.rules.map((r, i) => {
    const where = `tax_set.rules[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw invalid(`${where} must be an object`);
    exactKeys(r, RULE_KEYS, where);
    const rounding = r.rounding;
    if (!TAX_ROUNDINGS.includes(rounding)) {
      throw invalid(
        `${where}.rounding is ${JSON.stringify(rounding)}; expected one of ${TAX_ROUNDINGS.join(', ')}. ` +
          'There is no default: who keeps a fraction of a minor unit is the garage\'s to state',
      );
    }
    return {
      id: text(r.id, `${where}.id`),
      label: text(r.label, `${where}.label`, '; it is what a driver and an operator both read on the line'),
      percent_bp: whole(r.percent_bp, `${where}.percent_bp`, { min: 1 }),
      rounding,
      sequence: whole(r.sequence, `${where}.sequence`, { min: 0 }),
    };
  });
  const byId = new Map();
  const bySequence = new Map();
  for (const rule of rules) {
    if (byId.has(rule.id)) throw invalid(`tax_set.rules contains two rules with id ${JSON.stringify(rule.id)}`);
    byId.set(rule.id, rule);
    const other = bySequence.get(rule.sequence);
    if (other) {
      throw invalid(
        `tax_set.rules: ${JSON.stringify(other.id)} and ${JSON.stringify(rule.id)} both state sequence ${rule.sequence}; ` +
          'the order of a set\'s taxes is the garage\'s to state, and two rules in one place is an order nobody stated',
      );
    }
    bySequence.set(rule.sequence, rule);
  }
  return { effectiveFrom, rules };
}

/**
 * Store one set for one garage, inside the caller's tenant transaction, and
 * record that it happened. Stating a set supersedes nothing: a later
 * `effective_from` is how a rate changes or a tax ends.
 *
 * Two sets at one instant is refused with BOTH named: the one already held
 * (by id, and when it was stated) and this one (as written). The instant is
 * compared as an instant, by the table's UNIQUE constraint -- `10:00-05:00`
 * and `15:00Z` are one moment.
 */
export async function storeTaxSet(client, tenantId, { garage, set, actor, now = null }) {
  await client.query('SAVEPOINT tax_set_insert');
  let row;
  try {
    const { rows } = await client.query(
      `INSERT INTO garage_tax_sets (tenant_id, garage_id, effective_from, rule_count)
       VALUES ($1, $2, $3::timestamptz, $4)
       RETURNING *`,
      [tenantId, garage.id, set.effectiveFrom, set.rules.length],
    );
    row = rows[0];
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'garage_tax_sets_one_set_per_instant') {
      await client.query('ROLLBACK TO SAVEPOINT tax_set_insert');
      const held = (
        await client.query(
          `SELECT id, effective_from, created_at FROM garage_tax_sets
            WHERE tenant_id = $1 AND garage_id = $2 AND effective_from = $3::timestamptz`,
          [tenantId, garage.id, set.effectiveFrom],
        )
      ).rows[0];
      throw new TaxSetRefused(
        'tax_set_effective_from_taken',
        `two tax sets would be in force from one instant: set ${held?.id ?? '(stated concurrently)'}, stated ` +
          `${held?.created_at?.toISOString?.() ?? 'just now'}, already takes effect at ` +
          `${held?.effective_from?.toISOString?.() ?? set.effectiveFrom}, and this set would take effect at ` +
          `${set.effectiveFrom}. Which one is in force would be decided by nothing; refused, both named`,
        {
          held: held ? { id: held.id, effective_from: held.effective_from, created_at: held.created_at } : null,
          refused: { effective_from: set.effectiveFrom, rule_count: set.rules.length },
        },
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
  // The record: who stated which set, for which garage. WHO travels inside
  // `detail`, the convention every operator act here follows.
  await repo.appendEvents(client, tenantId, [
    {
      garageId: garage.id,
      laneId: null,
      eventId: `tax_set:${row.id}`,
      kind: TAX_SET_STATED_EVENT_KIND,
      occurredAt: now ?? row.created_at,
      detail: {
        actor,
        tax_set_id: row.id,
        effective_from: row.effective_from,
        rule_count: row.rule_count,
        rules: [...set.rules].sort((a, b) => a.sequence - b.sequence),
      },
    },
  ]);
  return (await taxSetsForGarage(client, tenantId, garage.id)).find((s) => s.id === row.id);
}

/**
 * Every set of the garage, oldest effective date first, each with its rules
 * in their stated `sequence`. The ORDER decides nothing; the engine picks
 * the set in force by instant.
 *
 * Each rule is exactly the engine's five keys, so a set read here is a set
 * `tax.py` loads: `rule_id` is named back to `id` on the way out.
 */
export async function taxSetsForGarage(client, tenantId, garageId) {
  const { rows: sets } = await client.query(
    `SELECT id, garage_id, effective_from, rule_count, created_at
       FROM garage_tax_sets
      WHERE tenant_id = $1 AND garage_id = $2
      ORDER BY effective_from`,
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
