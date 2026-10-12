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
 *             validated it -- and only once the owner confirmed it (U7g,
 *             `assertConfirmed`). Refusals by name for the things only the
 *             store can see: the garage's currency (the document restates it,
 *             never sets it), a version name already used, an effective instant
 *             already taken, and a start in the past (U7g, `assertStartsNow`).
 *   try       (U7g, the route in app.js) a draft is checked the store's way --
 *             `assertFitsGarage`, `assertNewBeside` -- and priced beside the
 *             stored plans through the close's own functions; nothing stored.
 *   read      EVERY plan of the garage, oldest effective date first. No
 *             selection here -- the engine's `select_plan` does that and its
 *             own test holds the entry-time rule. `documents()` is the
 *             projection down to what `quote()` takes as `plans`.
 *
 *   quote     (migration 0013) the close hands EVERY plan of the garage, the
 *             garage's currency and space class and the stay's two instants
 *             to the engine's `POST /v1/quote`, and freezes what comes back --
 *             fee, version, breakdown -- onto the stay. The engine chooses the
 *             version in force at entry; this module hands it the whole list
 *             and filters nothing. A refusal (the engine's 422, named
 *             findings) is `PricingRefused`, which the close turns into an
 *             UNPRICED close rather than a refused one. An engine that cannot
 *             be reached is `EngineUnavailable`, which the close lets fall to
 *             a 5xx so the lane retries: the stay can be priced, just not now.
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

/** The engine said no, by name: its findings, verbatim. The stay closes unpriced. */
export class PricingRefused extends Error {
  constructor(findings) {
    super(`the rate engine refused to price the stay: ${findings.map((f) => f.code).join(', ')}`);
    this.findings = findings;
  }
}

/** No engine to ask. Not a refusal: the stay can be priced, just not now. */
export class EngineUnavailable extends Error {}

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
 * How far before this server's clock a plan may say it starts: the owner's
 * screen and this server read two clocks, and "Now" pressed on one is a few
 * seconds in the past on the other. Anything earlier is a plan dated back.
 */
export const START_ALLOWANCE_MS = 60_000;

/**
 * A plan never starts in the past (U7g, Defect 2). The engine prices a stay on
 * the plan in force at ENTRY, so a plan dated one hour back is in force for a
 * car that came in half an hour ago, and that car's close is priced by it --
 * measured: 2.50 became 10.00. "A rate change never reaches back into a car
 * that is already parked" holds only while every plan starts after it is
 * saved. Called after the engine loaded the document, so `effective_from` is
 * an instant the engine accepted.
 */
export function assertStartsNow(document, { now = Date.now() } = {}) {
  const start = Date.parse(document.effective_from);
  if (Number.isFinite(start) && start < now - START_ALLOWANCE_MS) {
    throw new RatePlanRefused(
      'plan_starts_in_the_past',
      `the plan starts at ${document.effective_from}, more than ${START_ALLOWANCE_MS / 1000}s before this server's clock ` +
        `(${new Date(now).toISOString()}); a plan dated back would price cars that are already parked, so it starts now or later`,
    );
  }
}

/**
 * What only the garage can say about a document: its money and the space
 * class every stay here is priced as. Shared by the store and by the try, so
 * a draft the store would refuse is refused the same way when it is tried.
 */
export function assertFitsGarage(garage, document) {
  if (document.currency !== garage.currency) {
    throw new RatePlanRefused(
      'plan_currency_disagrees_with_garage',
      `the plan prices in ${JSON.stringify(document.currency)} but the garage's currency is ${garage.currency}; ` +
        'currency lives on the garage and a plan restates it',
    );
  }
  // The engine prices a SPACE and refuses a class the plan does not declare.
  // Every stay in this garage is priced as the garage's class (0013), so a
  // plan that does not declare it would refuse every exit -- caught here, in
  // front of an operator, and not at 3 a.m. at the barrier.
  const classes = Array.isArray(document.space_classes) ? document.space_classes : [];
  if (!classes.includes(garage.space_class)) {
    throw new RatePlanRefused(
      'plan_does_not_price_garage_space_class',
      `every stay in this garage is priced as space class ${JSON.stringify(garage.space_class)}, ` +
        `and the plan declares only: ${classes.map((c) => JSON.stringify(c)).join(', ') || 'nothing'}`,
    );
  }
}

/**
 * The store's two refusals about the OTHER plans, said before anything is
 * written, for a draft that is only being tried: a version name already used,
 * an effective instant already taken. The store itself learns both from the
 * database's constraints; this reads the same two facts: the instant from
 * `stored` (the plans that price), the name from `history` (every plan ever
 * stored -- 0034 keeps a withdrawn plan's name taken).
 */
export function assertNewBeside(stored, document, history = stored) {
  if (history.some((r) => r.plan_version === document.plan_version)) {
    throw new RatePlanRefused(
      'plan_version_exists',
      `this garage already holds a plan named ${JSON.stringify(document.plan_version)}; a changed plan is a new version`,
    );
  }
  const start = Date.parse(document.effective_from);
  if (stored.some((r) => new Date(r.effective_from).getTime() === start)) {
    throw new RatePlanRefused(
      'plan_effective_from_taken',
      `this garage already holds a plan taking effect at ${document.effective_from}; two versions at one instant ` +
        'would make the version in force at entry ambiguous, which the engine refuses on every stay from then on',
    );
  }
}

/**
 * The owner's confirmation (U7g): nothing is saved until the owner has seen
 * the prices and said so. Every caller sends `confirmed: true`, the admin and
 * a key alike; anything else is refused before the engine is asked.
 */
export function assertConfirmed(body) {
  if (body?.confirmed !== true) {
    throw new RatePlanRefused(
      'not_confirmed',
      'rates are saved only once the owner has checked the prices they charge and confirmed them: send confirmed: true',
    );
  }
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
  assertFitsGarage(garage, document);
  assertStartsNow(document, { now: now ? new Date(now).getTime() : Date.now() });
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
 * THE PLANS THAT PRICE: every plan of the garage that was not withdrawn
 * (0034). This is the one place the platform selects them, and every path
 * that hands plans on -- the close, the try, `/lane/rules`, `/lane/stays`,
 * the reconcile, the opening readout -- goes through it
 * (scripts/rate-plan-readers.js lists every reader of `rate_plans` and holds
 * that). A withdrawn plan never started, so it priced nothing; leaving it out
 * is not a choice among versions -- the engine still chooses by entry time.
 * Oldest effective date first, for a human reading the list; the ORDER
 * decides nothing -- the engine refuses a tie whichever order it arrives in.
 */
export async function ratePlansForGarage(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT id, garage_id, plan_version, effective_from, document, engine_schema_version, created_at
       FROM rate_plans
      WHERE tenant_id = $1 AND garage_id = $2 AND withdrawn_at IS NULL
      ORDER BY effective_from, plan_version`,
    [tenantId, garageId],
  );
  return rows;
}

/**
 * Every plan the garage ever stored, withdrawn ones too, marked: the history
 * the owner reads ("replaced before it started"). NEVER handed to the engine
 * -- `ratePlansForGarage` is what prices. Also what the try checks a draft's
 * version name against: a name is never used twice, withdrawn or not.
 */
export async function ratePlanHistory(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT id, garage_id, plan_version, effective_from, document, engine_schema_version, created_at,
            withdrawn_at, withdrawn_by
       FROM rate_plans
      WHERE tenant_id = $1 AND garage_id = $2
      ORDER BY effective_from, plan_version, created_at`,
    [tenantId, garageId],
  );
  return rows;
}

/** At most this many later versions are carried in one save. */
export const CARRY_MAX = 50;

/**
 * The save's `carry` (U7i fix 1): `[{ withdraw: <plan id>, plan: <document> }]`,
 * each a later version, not started yet, that today's change is carried into.
 * Absent is none. `plan` left out means the save's own plan replaces it -- a
 * change saved to start exactly when that later version would (the owner
 * changing a special that starts with it); it is `null` here. Only the shape
 * is read here; whether each plan may be withdrawn is the store's to say, in
 * the save's own transaction.
 */
export function carryList(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > CARRY_MAX) {
    throw new RatePlanRefused('plan_invalid', `carry is a list of at most ${CARRY_MAX} { withdraw, plan }: each a later version and the plan that replaces it`);
  }
  const seen = new Set();
  const out = raw.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.withdraw !== 'string' || !UUID.test(c.withdraw)) {
      throw new RatePlanRefused('plan_invalid', `carry[${i}] is { withdraw, plan }: withdraw the id of a stored plan that has not started, plan its replacement`);
    }
    if (seen.has(c.withdraw)) {
      throw new RatePlanRefused('plan_invalid', `carry names plan ${c.withdraw} twice; a plan is replaced once`);
    }
    seen.add(c.withdraw);
    return { withdraw: c.withdraw, plan: c.plan === undefined || c.plan === null ? null : planDocument(c.plan) };
  });
  if (out.filter((c) => c.plan === null).length > 1) {
    throw new RatePlanRefused('plan_invalid', 'carry names more than one plan the save itself replaces; the save starts at one instant');
  }
  return out;
}

/**
 * The plans a try prices with, as they will be once a save with this `carry`
 * is stored: the plans that price, less each one the carry withdraws, plus
 * its replacement, plus the draft. The same list the store will leave behind.
 */
export function asTheyWillBe(stored, draft, carry) {
  const gone = new Set(carry.map((c) => c.withdraw));
  for (const c of carry) {
    if (!stored.some((r) => r.id === c.withdraw)) {
      throw new RatePlanRefused('plan_not_found', `this garage holds no plan ${c.withdraw} that prices; a carry replaces a later version not started yet`);
    }
  }
  return [
    ...documents(stored.filter((r) => !gone.has(r.id))),
    ...(draft === null ? [] : [draft]),
    ...carry.filter((c) => c.plan !== null).map((c) => c.plan),
  ];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Withdraw one plan of this garage that has not started (0034), and return
 * it as it was. Refused by name: a plan that is not this garage's, one
 * already withdrawn, and one that has started (`plan_already_started`) --
 * that one may have priced a stay and is never touched. The trigger refuses
 * the same three; this says it first, with a sentence.
 */
export async function withdrawRatePlan(client, tenantId, { garage, planId, actor }) {
  const { rows } = await client.query(
    `SELECT id, plan_version, effective_from, withdrawn_at, effective_from <= clock_timestamp() AS started
       FROM rate_plans WHERE tenant_id = $1 AND garage_id = $2 AND id = $3 FOR UPDATE`,
    [tenantId, garage.id, planId],
  );
  const plan = rows[0];
  if (!plan) {
    throw new RatePlanRefused('plan_not_found', `this garage holds no plan ${planId} to replace`);
  }
  if (plan.withdrawn_at !== null) {
    throw new RatePlanRefused('plan_already_withdrawn', `the plan ${JSON.stringify(plan.plan_version)} was already replaced`);
  }
  if (plan.started) {
    throw new RatePlanRefused(
      'plan_already_started',
      `the plan ${JSON.stringify(plan.plan_version)} started at ${new Date(plan.effective_from).toISOString()} and may have priced a stay; ` +
        'a plan that has started is never withdrawn',
    );
  }
  try {
    const out = await client.query(
      `UPDATE rate_plans SET withdrawn_at = clock_timestamp(), withdrawn_by = $4
        WHERE tenant_id = $1 AND garage_id = $2 AND id = $3
        RETURNING id, garage_id, plan_version, effective_from, document, engine_schema_version, created_at, withdrawn_at, withdrawn_by`,
      [tenantId, garage.id, planId, actor],
    );
    return out.rows[0];
  } catch (err) {
    // Started between the read and the write: the trigger's word, by name.
    if (err.code === '23514' && err.constraint === 'rate_plans_withdrawn_before_start') {
      throw new RatePlanRefused('plan_already_started', `the plan ${JSON.stringify(plan.plan_version)} has started; a plan that has started is never withdrawn`);
    }
    throw err;
  }
}

/** What `quote()` takes as `plans`: the documents, whole, and nothing of ours. */
export function documents(rows) {
  return rows.map((r) => r.document);
}

/**
 * Price one stay with the engine, from every plan of the garage.
 *
 * `plans` is the WHOLE list the store holds for the garage, unfiltered: the
 * engine's `select_plan` picks the version in force at entry, and its own
 * test (`test_f3_entry_time_governs`) is what holds that rule. A platform
 * that handed it one version -- the latest, say -- would have made the choice
 * itself, silently, and by exit time. `currency` and `spaceClass` are the
 * garage's; the engine refuses a plan in another currency and a class the
 * plan does not declare, both by name.
 *
 * Returns `{ feeMinor, currency, planVersion, breakdown, schemaVersion }` --
 * the engine's words, converted only at the money boundary. Throws
 * `PricingRefused` on the engine's 422 (named findings), `EngineUnavailable`
 * when there is no engine or it answered something that is not a quote. An
 * engine 400 here is a platform bug -- every plan it holds was validated
 * before it was stored -- and is `EngineUnavailable` too: the close is not
 * recorded as unpriced on the strength of a request this platform built wrong.
 */
export async function quoteWithEngine(
  { plans, currency, spaceClass, entryAt, exitAt },
  { url = rateEngineUrl(), timeoutMs = 10_000 } = {},
) {
  if (!url) throw new EngineUnavailable('RATE_ENGINE_URL is not set; the close prices through the engine and nothing else');
  let res;
  let text;
  try {
    res = await fetch(`${url}/v1/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        plans,
        currency,
        space_class: spaceClass,
        entry_at: entryAt.toISOString(),
        exit_at: exitAt.toISOString(),
      }),
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
  if (res.status === 422 && body.refused === true && Array.isArray(body.findings)) {
    throw new PricingRefused(body.findings);
  }
  if (res.status === 200 && Number.isInteger(body.fee_minor) && Array.isArray(body.breakdown)) {
    return {
      feeMinor: body.fee_minor,
      currency: body.currency,
      planVersion: body.plan_version,
      breakdown: body.breakdown,
      schemaVersion: body.schema_version,
    };
  }
  throw new EngineUnavailable(
    `the rate engine at ${url} answered HTTP ${res.status} with a body this platform does not recognise as a quote: ${text.slice(0, 300)}`,
  );
}
