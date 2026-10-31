/**
 * THE EXCEPTIONS (0048): the record of a car a person let out.
 *
 * The owner, 2026-10-30: "record it as exceptions and add as much
 * information as we can. what happened, who did what, gate agent sent
 * messages times, who received, etc".
 *
 * ONE PER EXIT CASE, written in the transaction that lets the car out --
 * an attendant's let-out (`source: attendant`), or the close of a case a
 * person at the lane opened for (`source: lane`, the lane's `let_out_by`),
 * or that closed owing:
 *
 *   let_out_unpaid   the car still owed (a fee not paid, or one that could
 *                    not be priced) and a person let it out;
 *   barrier_opened   a person opened the barrier for a car that owed nothing
 *                    more -- kept too: every barrier a person opens is here.
 *
 * WHAT IT HOLDS, as it was at that moment (`story`): the garage, lane, stay
 * and case; who pressed it, when, the reason typed and the authority the
 * lane named; what was owed and what the stay had paid; the case as the lane
 * read it before the person decided; every payment of the stay -- its
 * states, times and Stripe's codes, never card data; and the lane's events
 * from the window's start to the let-out. No plate: the stay is named by its
 * id, and what the lane sent about a car is cut to its codes.
 *
 * WHAT IS LEARNED AFTER is appended, never edited (`exception_records`): the
 * gate agent's messages and calls for the lane over [case opened - 15 min,
 * let-out + 15 min] (src/gateAgent.js), copied with their ids at the let-out
 * and again once the window has passed (`npm run complete-exceptions`); the
 * payment as it stood once the let-out canceled it; and the platform's events
 * at the lane after the let-out. A gate agent not configured, or not
 * reachable, is a row saying so -- and never holds the let-out up.
 */
import * as exits from './exits.js';
import * as gateAgent from './gateAgent.js';

export const KINDS = Object.freeze({ LET_OUT_UNPAID: 'let_out_unpaid', BARRIER_OPENED: 'barrier_opened' });
export const GATE_AGENT_SOURCES = Object.freeze(['gate_agent_messages', 'gate_agent_calls']);
/** How long after the window's end a gate agent that could not be reached is asked again, and how many times at most. */
export const RETRY_HOURS = 24;
export const MAX_COPIES = 6;
/** The most lane events one record keeps. */
export const EVENTS_MAX = 200;

const WINDOW_MS = gateAgent.WINDOW_MINUTES * 60_000;

/**
 * What a lane's own event detail is cut to: its codes, never what it read of
 * a car. A lane's detail is the lane's JSON, and may carry a plate.
 */
const LANE_DETAIL_KEYS = Object.freeze([
  'cause', 'code', 'reason', 'outcome', 'authority', 'state', 'status', 'direction', 'transit', 'fault', 'error',
  'action', 'decision_id', 'flagged', 'released', 'relay', 'kind', 'case', 'needs', 'why',
]);

/** The events this platform writes about an exit, whose detail it wrote itself and names no car. */
const PLATFORM_KINDS = new Set([
  'exit_unmatched', 'exit_driver_word', 'exit_let_out_by_person', 'exit_superseded', 'exit_stay_reentered',
  'exit_payment_started', 'exit_paid', 'exit_payment_canceled', 'exit_covered', 'close_unpriced', 'exit_reader_refused',
]);

function cutDetail(kind, detail) {
  if (PLATFORM_KINDS.has(kind)) return detail ?? {};
  const out = {};
  for (const key of LANE_DETAIL_KEYS) {
    const v = detail?.[key];
    if (v === null || typeof v === 'boolean' || typeof v === 'number') out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, 200);
  }
  return out;
}

/** A lane's events in `[from, to]`, oldest first, cut to their codes. */
async function laneEvents(client, tenantId, garageId, laneId, from, to, { after = false } = {}) {
  const { rows } = await client.query(
    `SELECT id, event_id, kind, occurred_at, detail FROM events
      WHERE tenant_id = $1 AND garage_id = $2 AND lane_id = $3
        AND occurred_at ${after ? '>' : '>='} $4 AND occurred_at <= $5
      ORDER BY occurred_at, id
      LIMIT $6`,
    [tenantId, garageId, laneId, from, to, EVENTS_MAX],
  );
  return rows.map((e) => ({ id: e.id, event_id: e.event_id, kind: e.kind, at: e.occurred_at, detail: cutDetail(e.kind, e.detail) }));
}

/** Every payment of the stay (or, with none, of the case): states, times and Stripe's codes; never card data. */
async function paymentsOf(client, tenantId, exitCase) {
  const { rows } = await client.query(
    `SELECT p.* FROM exit_payments p
      WHERE p.tenant_id = $1 AND (p.exit_id = $2 OR ($3::uuid IS NOT NULL AND p.session_id = $3))
      ORDER BY p.created_at, p.id`,
    [tenantId, exitCase.id, exitCase.session_id],
  );
  return rows.map(presentPayment);
}

function presentPayment(p) {
  return {
    id: p.id,
    exit_id: p.exit_id,
    channel: p.channel,
    reader_id: p.reader_id,
    status: p.status,
    stripe_status: p.stripe_status,
    last_failure: p.last_failure,
    amount_minor: Number(p.amount_minor),
    currency: p.currency,
    payment_intent_id: p.payment_intent_id,
    started_by: p.started_by,
    created_at: p.created_at,
    read_at: p.read_at,
    succeeded_at: p.succeeded_at,
    canceled_at: p.canceled_at,
    receipt_sent: Boolean(p.receipt),
  };
}

/** The stay as the record names it: times, lanes and how it was identified, never the plate. */
async function stayOf(client, tenantId, sessionId) {
  if (!sessionId) return null;
  const { rows } = await client.query(
    `SELECT s.id, s.entry_at, s.entry_lane_id, s.entry_confirmation, s.tailgater, s.no_open_command,
            s.exit_at, s.ended, s.entry_qr, s.pass_session,
            CASE WHEN v.ticket_ref IS NOT NULL THEN 'ticket' WHEN v.unread_ref IS NOT NULL THEN 'unread' ELSE 'plate' END AS identified_by
       FROM sessions s JOIN vehicles v ON v.id = s.vehicle_id AND v.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.id = $2`,
    [tenantId, sessionId],
  );
  const s = rows[0];
  if (!s) return null;
  const qr = s.entry_qr ? Object.fromEntries(Object.entries(s.entry_qr).filter(([k]) => k !== 'qr_plate')) : null;
  return {
    id: s.id,
    entry_at: s.entry_at,
    entry_lane_id: s.entry_lane_id,
    identified_by: s.identified_by,
    entry_confirmation: s.entry_confirmation,
    tailgater: s.tailgater,
    no_open_command: s.no_open_command,
    entry_qr: qr,
    pass_session: s.pass_session,
  };
}

/** The case as it stood when the person decided: how the stay was found, what it owed and why it was not settled. */
function caseOf(row) {
  const q = row.quote;
  return {
    id: row.id,
    event_id: row.event_id,
    lane_id: row.lane_id,
    method: row.method,
    exit_at: row.exit_at,
    opened_at: row.created_at,
    candidates: Array.isArray(row.candidates) ? row.candidates.length : 0,
    picker: row.picker?.outcome ?? null,
    claimed_entry_at: row.claimed_entry_at,
    fee: q ? {
      outcome: q.outcome,
      stay_fee_minor: q.refusal ? null : q.fee_minor,
      credit_minor: exits.creditOf(q),
      due_minor: exits.dueOf(q),
      currency: q.currency,
      refused: Boolean(q.refusal),
      covered_by: q.covered_by ?? [],
    } : null,
    settled_before: exits.settledOf({ ...row, person: null }),
    person: row.person ?? null,
  };
}

/**
 * WRITE THE EXCEPTION for a case a person let out, in the caller's
 * transaction: `exitCase` as it stood before the person's decision (its
 * payments read with it). Once per case: a second let-out of the same case
 * -- the attendant's, then the lane's close -- keeps the first. Answers
 * `{row, created}`.
 */
export async function recordLetOut(client, tenantId, { exitCase, source, by, authority = null, reason = null, at, garageCurrency, recovered = false }) {
  const owes = exits.owesAtExit({ ...exitCase, person: null });
  const q = exitCase.quote;
  const opened = new Date(Math.min(new Date(exitCase.exit_at).getTime(), new Date(exitCase.created_at).getTime()));
  const windowFrom = new Date(Math.min(opened.getTime(), at.getTime()) - WINDOW_MS);
  const windowTo = new Date(at.getTime() + WINDOW_MS);
  const payments = await paymentsOf(client, tenantId, exitCase);
  const paidMinor = payments.filter((p) => p.status === 'succeeded').reduce((sum, p) => sum + p.amount_minor, 0);
  const story = {
    what: owes ? 'a person let the car out while it still owed' : 'a person opened the barrier for a car that owed nothing more',
    case: caseOf(exitCase),
    stay: await stayOf(client, tenantId, exitCase.session_id),
    payments,
    lane_events: await laneEvents(client, tenantId, exitCase.garage_id, exitCase.lane_id, windowFrom, at),
    // Written by the sweep from what is on record, after the let-out's own
    // write failed: the payments are as they stand at the sweep.
    ...(recovered ? { recovered: true } : {}),
  };
  const { rows } = await client.query(
    `INSERT INTO exceptions (tenant_id, garage_id, lane_id, exit_id, session_id, kind, source, done_by, authority, reason,
                             let_out_at, case_opened_at, window_from, window_to, owed_minor, paid_minor, currency, story)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (tenant_id, exit_id) DO NOTHING
     RETURNING *`,
    [
      tenantId, exitCase.garage_id, exitCase.lane_id, exitCase.id, exitCase.session_id,
      owes ? KINDS.LET_OUT_UNPAID : KINDS.BARRIER_OPENED, source, String(by).slice(0, 300), authority,
      reason ? String(reason).slice(0, 500) : null,
      at, opened, windowFrom, windowTo,
      owes ? exits.dueOf(q) : 0, paidMinor,
      String(q?.currency ?? garageCurrency ?? '').toUpperCase() || null,
      JSON.stringify(story),
    ],
  );
  return { row: rows[0] ?? null, created: rows.length === 1 };
}

/**
 * THE LET-OUTS WITH NO EXCEPTION, for the sweep: a case an attendant let out
 * (`person`), or a stay closed let out at the lane (`let_out`), whose own
 * write of the record failed. Answers `{exitId, source, by, authority,
 * reason, at}`.
 */
export async function missing(client, tenantId, limit = 200) {
  const { rows } = await client.query(
    `SELECT e.id AS exit_id, e.garage_id, 'attendant' AS source, e.person->>'by' AS by, NULL AS authority,
            e.person->>'reason' AS reason, (e.person->>'at')::timestamptz AS at
       FROM exits e
      WHERE e.tenant_id = $1 AND e.person IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM exceptions x WHERE x.tenant_id = e.tenant_id AND x.exit_id = e.id)
     UNION ALL
     SELECT e.id, e.garage_id, 'lane', s.let_out->>'by',
            CASE WHEN s.let_out->>'reason' = ANY($2::text[]) THEN s.let_out->>'reason' END,
            NULL, (s.let_out->>'at')::timestamptz
       FROM sessions s JOIN exits e ON e.tenant_id = s.tenant_id AND e.id = (s.let_out->>'exit_id')::uuid
      WHERE s.tenant_id = $1 AND s.let_out IS NOT NULL AND e.person IS NULL
        AND NOT EXISTS (SELECT 1 FROM exceptions x WHERE x.tenant_id = e.tenant_id AND x.exit_id = e.id)
     LIMIT $3`,
    [tenantId, exits.LET_OUT_AUTHORITIES, limit],
  );
  return rows;
}

/** Append one record learned after the let-out. */
export async function appendRecord(client, tenantId, exceptionId, r) {
  const { rows } = await client.query(
    `INSERT INTO exception_records (tenant_id, exception_id, source, state, asked_name, asked_from, asked_to, complete, detail, records)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [tenantId, exceptionId, r.source, r.state, r.lane ?? null, r.from ?? null, r.to ?? null, Boolean(r.complete),
      r.detail ?? null, JSON.stringify(r.records ?? [])],
  );
  return rows[0];
}

/** The payment of the case as it stood once the let-out canceled it, or found it paid. */
export async function recordPaymentAfter(client, tenantId, exception, payment) {
  if (!payment) return null;
  return appendRecord(client, tenantId, exception.id, {
    source: 'payment_after_let_out', state: 'copied', records: [presentPayment(payment)], complete: true,
  });
}

/**
 * COPY THE GATE AGENT'S RECORDS for an exception: its messages and its calls
 * for the lane, from the window's start to now or the window's end,
 * whichever is first -- `complete` when the window has passed. Each source
 * is one appended row, copied or saying why not. Never throws; `write` runs
 * a function in the tenant's transaction.
 */
export async function copyGateAgent(write, tenantId, exception, { now = new Date(), env = process.env, sources = GATE_AGENT_SOURCES } = {}) {
  const from = new Date(exception.window_from);
  const end = new Date(exception.window_to);
  const to = now < end ? now : end;
  const complete = now >= end;
  const out = await Promise.all(sources.map(async (source) => {
    const got = to > from
      ? await gateAgent.copy(source, { garageId: exception.garage_id, laneId: exception.lane_id, from, to }, env)
      : { state: 'not_reachable', detail: 'nothing to ask yet: the window has not begun' };
    return {
      source,
      state: got.state,
      lane: got.lane ?? null,
      from,
      to,
      complete: got.state === 'copied' && complete,
      detail: got.state === 'copied'
        ? (got.gap ? 'the gate agent says records in this range were removed for age or space before they were served' : null)
        : got.detail,
      records: got.state === 'copied' ? got.records : [],
    };
  }));
  try {
    return await write((client) => Promise.all(out.map((r) => appendRecord(client, tenantId, exception.id, r))));
  } catch (err) {
    console.error(`[exceptions] the gate agent's copy for exception ${exception.id} was not written: ${err.message ?? err}`);
    return null;
  }
}

/**
 * The exceptions whose record is still to be finished, for the sweep: the
 * window has passed and a gate-agent source has no complete copy -- one that
 * was copied part-way, or could not be reached and is still within
 * RETRY_HOURS of the window's end. Not configured is final. With them, the
 * ones with no `lane_events_after` yet.
 */
export async function toFinish(client, tenantId, now = new Date(), limit = 200) {
  const { rows } = await client.query(
    `SELECT x.* FROM exceptions x
      WHERE x.tenant_id = $1 AND x.window_to <= $2
        AND (
          NOT EXISTS (SELECT 1 FROM exception_records r WHERE r.tenant_id = x.tenant_id AND r.exception_id = x.id
                       AND r.source = 'lane_events_after')
          OR (x.window_to > $2::timestamptz - make_interval(hours => $3) AND EXISTS (
            SELECT 1 FROM unnest($4::text[]) AS s(source)
             WHERE NOT EXISTS (SELECT 1 FROM exception_records r WHERE r.tenant_id = x.tenant_id AND r.exception_id = x.id
                                AND r.source = s.source AND (r.complete OR r.state = 'not_configured'))
               AND (SELECT count(*) FROM exception_records r WHERE r.tenant_id = x.tenant_id AND r.exception_id = x.id
                       AND r.source = s.source) < $6
          ))
        )
      ORDER BY x.window_to, x.id
      LIMIT $5`,
    [tenantId, now, RETRY_HOURS, GATE_AGENT_SOURCES, limit, MAX_COPIES],
  );
  return rows;
}

/** Finish one exception: the lane's events after the let-out, once; then the gate agent's whole window. */
export async function finish(write, tenantId, exception, { now = new Date(), env = process.env } = {}) {
  const done = await write(async (client) => {
    const { rows } = await client.query(
      `SELECT source, state, complete FROM exception_records WHERE tenant_id = $1 AND exception_id = $2`,
      [tenantId, exception.id],
    );
    if (!rows.some((r) => r.source === 'lane_events_after')) {
      await appendRecord(client, tenantId, exception.id, {
        source: 'lane_events_after',
        state: 'copied',
        from: exception.let_out_at,
        to: exception.window_to,
        complete: true,
        records: await laneEvents(client, tenantId, exception.garage_id, exception.lane_id,
          exception.let_out_at, exception.window_to, { after: true }),
      });
    }
    return rows;
  });
  const settled = (source) => done.some((r) => r.source === source && (r.complete || r.state === 'not_configured'));
  const tries = (source) => done.filter((r) => r.source === source).length;
  const sources = GATE_AGENT_SOURCES.filter((source) => !settled(source) && tries(source) < MAX_COPIES);
  const late = now.getTime() > new Date(exception.window_to).getTime() + RETRY_HOURS * 3_600_000;
  if (!sources.length || late) return { copied: false };
  await copyGateAgent(write, tenantId, exception, { now, env, sources });
  return { copied: true };
}

/** The exceptions of a garage in `[from, to)`, oldest first: the day's list. */
export async function forGarage(client, tenantId, garageId, { from, to, limit = 500 }) {
  const { rows } = await client.query(
    `SELECT x.*, (SELECT count(*)::int FROM exception_records r WHERE r.tenant_id = x.tenant_id AND r.exception_id = x.id) AS records
       FROM exceptions x
      WHERE x.tenant_id = $1 AND x.garage_id = $2 AND x.let_out_at >= $3 AND x.let_out_at < $4
      ORDER BY x.let_out_at, x.id
      LIMIT $5`,
    [tenantId, garageId, from, to, limit],
  );
  return rows;
}

/** One exception of this garage, with everything appended to it; null when it is not this garage's. */
export async function one(client, tenantId, garageId, exceptionId) {
  const { rows } = await client.query(
    'SELECT * FROM exceptions WHERE tenant_id = $1 AND garage_id = $2 AND id = $3',
    [tenantId, garageId, exceptionId],
  );
  if (!rows[0]) return null;
  const records = await client.query(
    'SELECT * FROM exception_records WHERE tenant_id = $1 AND exception_id = $2 ORDER BY copied_at, id',
    [tenantId, exceptionId],
  );
  return { ...rows[0], records: records.rows };
}

/** How many exceptions a garage had since `since`, by kind: the reconciliation's count. */
export async function countSince(client, tenantId, garageId, since) {
  const { rows } = await client.query(
    `SELECT count(*) FILTER (WHERE kind = 'let_out_unpaid')::int AS let_out_unpaid,
            count(*) FILTER (WHERE kind = 'barrier_opened')::int AS barrier_opened
       FROM exceptions WHERE tenant_id = $1 AND garage_id = $2 AND let_out_at >= $3`,
    [tenantId, garageId, since],
  );
  return { since, ...rows[0], total: rows[0].let_out_unpaid + rows[0].barrier_opened };
}

/** An exception as a list shows it. */
export function presentSummary(x) {
  return {
    id: x.id,
    kind: x.kind,
    source: x.source,
    garage_id: x.garage_id,
    lane_id: x.lane_id,
    exit_id: x.exit_id,
    stay_id: x.session_id,
    by: x.done_by,
    authority: x.authority,
    reason: x.reason,
    let_out_at: x.let_out_at,
    owed_minor: x.owed_minor,
    paid_minor: x.paid_minor,
    currency: x.currency,
    records: x.records ?? undefined,
  };
}

/** One exception's whole story, and everything learned after it. */
export function presentWhole(x) {
  const summary = { ...presentSummary(x), records: undefined };
  const gate = (source) => x.records.filter((r) => r.source === source).map(presentRecord);
  return {
    ...summary,
    case_opened_at: x.case_opened_at,
    window: { from: x.window_from, to: x.window_to },
    story: x.story,
    payment_after_let_out: x.records.filter((r) => r.source === 'payment_after_let_out').map((r) => r.records[0] ?? null)[0] ?? null,
    lane_events_after: gate('lane_events_after')[0]?.records ?? null,
    gate_agent: {
      messages: gate('gate_agent_messages'),
      calls: gate('gate_agent_calls'),
    },
    created_at: x.created_at,
  };
}

function presentRecord(r) {
  return {
    id: r.id,
    state: r.state,
    detail: r.detail,
    // The gate agent's own name for the lane it was asked about.
    asked_lane: r.asked_name,
    asked_from: r.asked_from,
    asked_to: r.asked_to,
    complete: r.complete,
    copied_at: r.copied_at,
    records: r.records,
  };
}
