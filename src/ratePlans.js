/**
 * The plan store: a garage's rate plans, held whole, validated by the engine
 * before they are stored, and read back as the list the engine prices from.
 *
 * `rate-engine` is a finished pricing engine with no persistence: `quote(plans,
 * stay)` takes every plan version of a garage on every call and picks the one
 * in force at entry. Nothing in this platform could hand it that list -- the
 * `rates` table is an hourly figure with no currency, no plan, no version and
 * no effective date -- so this module is the first caller the engine has. It
 * does not price, does not choose rules and does not interpret a plan
 * (migration 0012 says why each of those stays with the engine). It does
 * three things:
 *
 *   validate  the document goes to the engine's own `POST /v1/validate-plan`
 *             BEFORE it is stored. A plan the engine cannot load -- an unknown
 *             key, a missing field, a float where minor units belong -- is
 *             refused with the engine's sentence, which names the key. A plan
 *             that loads but has FINDINGS (a gap nothing prices, a conflict
 *             between rules) is refused too, naming every finding: a stay
 *             hitting a gap is a refusal in front of a driver, and catching it
 *             at write time is the difference between an owner seeing it in an
 *             admin screen and an attendant seeing it at 3 a.m. A settled
 *             finding is still a finding -- the engine's own rule, a decision
 *             is an acknowledgement and not a price -- so it refuses too.
 *   store     the document, whole, with the engine contract version that
 *             validated it. Refusals by name for the things only the store can
 *             see: the garage's currency (the document restates it, never sets
 *             it), a version name already used, an effective instant already
 *             taken.
 *   read      EVERY plan of the garage, oldest effective date first. No
 *             selection here -- the engine's `select_plan` does that and its
 *             own test holds the entry-time rule. `documents()` is the
 *             projection down to what `quote()` takes as `plans`.
 *
 * THE ENGINE IS REACHED OVER HTTP, at RATE_ENGINE_URL, the same door
 * `rate-engine quote` uses (`docs/CONTRACT.md` F6 in that repo: one code path,
 * one encoder, both surfaces byte-identical). Unset, or unreachable, the
 * store REFUSES to store, by name -- it never accepts a document nothing
 * validated. The read needs no engine.
 */
import * as repo from './repository.js';

export const RATE_PLAN_EVENT_KIND = 'rate_plan_stored';

/** Why the store would not store. `code` is published beside the message. */
export class RatePlanRefused extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Where the engine is. Read at call time so a test can point it somewhere. */
export function rateEngineUrl(env = process.env) {
  const raw = env.RATE_ENGINE_URL;
  if (!raw) return null;
  return raw.replace(/\/$/, '');
}

/**
 * The engine's answer to "can this plan price?", and nothing else.
 *
 * Three outcomes, each named:
 *   plan_invalid            the engine could not LOAD it (its 400): the
 *                           sentence names the field or the unknown key.
 *   plan_has_findings       it loads and has gaps or conflicts (its 200 with a
 *                           non-empty `findings`): every one is listed.
 *   rate_engine_unavailable no engine at RATE_ENGINE_URL, or an answer that is
 *                           not one of the two above. Not stored.
 * Returns `{ schemaVersion }` when the plan is whole.
 */
export async function validateWithEngine(document, { url = rateEngineUrl(), timeoutMs = 10_000 } = {}) {
  if (!url) {
    throw new RatePlanRefused(
      'rate_engine_unavailable',
      'RATE_ENGINE_URL is not set; a plan is validated by the engine before it is stored, and nothing else can say whether it prices',
    );
  }
  let res;
  let text;
  try {
    res = await fetch(`${url}/v1/validate-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: document }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    throw new RatePlanRefused(
      'rate_engine_unavailable',
      `the rate engine at ${url} could not be reached (${err?.cause?.code ?? err?.name ?? err}); the plan was not stored`,
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object') {
    throw new RatePlanRefused(
      'rate_engine_unavailable',
      `the rate engine at ${url} answered HTTP ${res.status} without a JSON body; the plan was not stored`,
    );
  }
  if (res.status === 400 && body.invalid === true) {
    throw new RatePlanRefused('plan_invalid', `the rate engine refused the plan: ${body.error}`);
  }
  if (res.status === 200 && Array.isArray(body.findings)) {
    if (body.findings.length > 0) {
      const lines = body.findings.map((f) => `${f.code}: ${f.text}`).join('; ');
      throw new RatePlanRefused(
        'plan_has_findings',
        `the plan cannot price every stay it covers -- ${body.findings.length} finding(s), ` +
          `${body.outstanding} outstanding, ${body.settled} settled: ${lines}`,
        { findings: body.findings },
      );
    }
    if (!Number.isInteger(body.schema_version) || body.schema_version < 1) {
      throw new RatePlanRefused(
        'rate_engine_unavailable',
        `the rate engine at ${url} validated the plan but named no schema_version; the plan was not stored`,
      );
    }
    return { schemaVersion: body.schema_version };
  }
  throw new RatePlanRefused(
    'rate_engine_unavailable',
    `the rate engine at ${url} answered HTTP ${res.status} with a body this platform does not recognise; the plan was not stored`,
  );
}

/** The document's shape is the engine's business; this is only "is it a document at all". */
export function planDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RatePlanRefused('plan_invalid', 'plan is required and must be a JSON object: the plan document, whole');
  }
  return raw;
}

/**
 * Store one plan for one garage, inside the caller's tenant transaction, and
 * record that it happened.
 *
 * `garage` is the row the caller already loaded (it needed it for the 404);
 * its `currency` is the one place currency lives. The engine has ALREADY said
 * the plan is whole -- `validated.schemaVersion` is its word -- and this
 * function does not call it again.
 */
export async function storeRatePlan(client, tenantId, { garage, document, validated, actor, now = null }) {
  if (document.currency !== garage.currency) {
    throw new RatePlanRefused(
      'plan_currency_disagrees_with_garage',
      `the plan prices in ${JSON.stringify(document.currency)} but the garage's currency is ${garage.currency}; ` +
        'currency lives on the garage and a plan restates it',
    );
  }
  let row;
  try {
    const { rows } = await client.query(
      `INSERT INTO rate_plans (tenant_id, garage_id, plan_version, effective_from, document, engine_schema_version)
       VALUES ($1, $2, $3::jsonb->>'plan_version', ($3::jsonb->>'effective_from')::timestamptz, $3::jsonb, $4)
       RETURNING *`,
      [tenantId, garage.id, JSON.stringify(document), validated.schemaVersion],
    );
    row = rows[0];
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'rate_plans_one_document_per_version') {
      throw new RatePlanRefused(
        'plan_version_exists',
        `this garage already holds a plan named ${JSON.stringify(document.plan_version)}; a changed plan is a new version`,
      );
    }
    if (err.code === '23505' && err.constraint === 'rate_plans_one_version_per_instant') {
      throw new RatePlanRefused(
        'plan_effective_from_taken',
        `this garage already holds a plan taking effect at ${document.effective_from}; two versions at one instant ` +
          'would make the version in force at entry ambiguous, which the engine refuses on every stay from then on',
      );
    }
    throw err;
  }
  // The record: who stored which version of what, for which garage, and which
  // engine contract said it was whole. WHO travels inside `detail`, the
  // convention the `assisted_identity` kind set; `events` has no actor column.
  await repo.appendEvents(client, tenantId, [
    {
      garageId: garage.id,
      laneId: null,
      eventId: `rate_plan:${row.id}`,
      kind: RATE_PLAN_EVENT_KIND,
      occurredAt: now ?? row.created_at,
      detail: {
        actor,
        rate_plan_id: row.id,
        plan_version: row.plan_version,
        effective_from: row.effective_from,
        currency: document.currency,
        engine_schema_version: row.engine_schema_version,
        findings: 0,
      },
    },
  ]);
  return row;
}

/**
 * Every plan of the garage. Oldest effective date first, for a human reading
 * the list; the ORDER decides nothing -- the engine chooses by entry time and
 * refuses a tie whichever order the list arrives in.
 */
export async function ratePlansForGarage(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT id, garage_id, plan_version, effective_from, document, engine_schema_version, created_at
       FROM rate_plans
      WHERE tenant_id = $1 AND garage_id = $2
      ORDER BY effective_from, plan_version`,
    [tenantId, garageId],
  );
  return rows;
}

/** What `quote()` takes as `plans`: the documents, whole, and nothing of ours. */
export function documents(rows) {
  return rows.map((r) => r.document);
}
