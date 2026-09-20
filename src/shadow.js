/**
 * The shadow run: the search is called for real exits, its answer RECORDED,
 * and nothing acts on it.
 *
 * Two halves, and the seam between them is a row in `shadow_searches`
 * (migration 0011).
 *
 * THE FIRST HALF RUNS INSIDE THE CLOSE. `enqueueShadowSearch` is called by
 * `POST /lane/sessions/close`, in its transaction, AFTER the stay to close has
 * been found and BEFORE `exit_at` is written on it. That ordering is the whole
 * of the design: a snapshot taken after the close would find the true stay
 * already closed and every plate-matched exit would read as "absent true car".
 * It holds ids and counts only -- the descriptors are immutable and are read
 * by id later; the measurement behind that is in the migration.
 *
 * THE SECOND HALF RUNS LATER, OUTSIDE ANY REQUEST. `runShadowSearches` takes
 * the pending rows, reads the exit's descriptor off the closed stay and the
 * candidates' off theirs, calls the identity service's search with `{id,
 * descriptor}` and the caller's stated thresholds, and writes the outcome onto
 * the row and a `shadow_search` event beside it. SESSION IDS, NEVER
 * DESCRIPTORS, in both: a descriptor is tens of kilobytes, times N, per exit,
 * and `events` is append-only by grant and outside the retention purge.
 *
 * THE ORACLE, and what may be published. On every row here the close picked
 * the stay by plate or ticket, independently of the search -- so whether the
 * search's `matched` names that stay is a measurement with ground truth.
 * `shadowReport` publishes a match rate and a tie rate over the rows where the
 * true stay was comparable, and every figure carries its denominator, names
 * that oracle, and states the bias: plate- or ticket-identified cars only,
 * inheriting the plate reader's own errors. A rate over ALL exits is not
 * measurable here -- a close that matches nothing answers 404 and inserts no
 * row -- and none is published.
 *
 * NOTHING HERE DECIDES ANYTHING. No vend, no fee, no session is touched by an
 * outcome; the match decision and the tie-break are another module's, later.
 */
import { withTenant } from './db.js';
import { candidateSnapshot } from './candidates.js';
import * as repo from './repository.js';

export const SHADOW_EVENT_KIND = 'shadow_search';

/** Inside the close transaction, before `exit_at` is written. */
export async function enqueueShadowSearch(
  client,
  tenantId,
  { garageId, sessionId, exitLaneId, closeEventId },
) {
  const snapshot = await candidateSnapshot(client, tenantId, garageId);
  const trueStayComparable = snapshot.ids.includes(sessionId);
  const { rows } = await client.query(
    `INSERT INTO shadow_searches (tenant_id, garage_id, session_id, exit_lane_id, close_event_id,
                                  candidate_ids, candidates_open, candidates_with_descriptor,
                                  true_stay_comparable)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $9)
     ON CONFLICT (tenant_id, close_event_id) DO NOTHING
     RETURNING id`,
    [
      tenantId, garageId, sessionId, exitLaneId, closeEventId,
      snapshot.ids, snapshot.open, snapshot.with_descriptor, trueStayComparable,
    ],
  );
  return { id: rows[0]?.id ?? null, ...snapshot, true_stay_comparable: trueStayComparable };
}

/**
 * The thresholds the search is told to apply. REQUIRED, never defaulted: no
 * operating point has been measured for the descriptor on real entry-and-exit
 * photographs, so the numbers are the operator's to state, and the identity
 * service echoes them beside every distance it applied them to.
 */
export function thresholdsFromEnv(env = process.env) {
  const read = (name) => {
    const raw = env[name];
    const value = Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(
        `${name} is required and must be a number in [0, 1]; the shadow run states its thresholds ` +
          'and has no default for them',
      );
    }
    return value;
  };
  return {
    structure: read('SHADOW_THRESHOLD_STRUCTURE'),
    colour_bhattacharyya: read('SHADOW_THRESHOLD_COLOUR'),
  };
}

/**
 * A search client for the identity service's `POST /v1/searches`, over HTTP,
 * loopback or a tokened bind -- the same route the lane would use. Returns the
 * `search` record; throws on anything that is not a 2xx.
 */
export function httpSearcher(baseUrl, { token = null, timeoutMs = 10_000 } = {}) {
  return async (body) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/searches`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`search answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !parsed.search) {
      throw new Error('search answered without a `search` record');
    }
    return parsed.search;
  };
}

const OUTCOMES = new Set(['match', 'tie', 'no_match']);

/**
 * Run every pending shadow search for one tenant. `search(body)` is the
 * identity service's route (or a stand-in that speaks its contract); it is
 * injected so the tests speak the documented shape without a service running.
 *
 * Each row is finished in its own transaction: the outcome on the row and the
 * event beside it commit together, or neither does. A search that cannot be
 * obtained leaves the row pending with `attempts` and `last_error`, so the
 * next run tries again and a dead service is a count, not a silence.
 */
export async function runShadowSearches(tenantId, { search, thresholds, limit = 100, now = null }) {
  const pending = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM shadow_searches
        WHERE tenant_id = $1 AND searched_at IS NULL AND redacted_at IS NULL
        ORDER BY created_at LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((r) => r.id);
  });

  const summary = { tenantId, pending: pending.length, searched: 0, failed: 0 };
  for (const id of pending) {
    try {
      await withTenant(tenantId, (client) => runOne(client, tenantId, id, { search, thresholds, now }));
      summary.searched += 1;
    } catch (err) {
      summary.failed += 1;
      await withTenant(tenantId, (client) =>
        client.query(
          `UPDATE shadow_searches SET attempts = attempts + 1, last_error = $3
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, id, String(err.message ?? err).slice(0, 500)],
        ),
      );
    }
  }
  return summary;
}

async function runOne(client, tenantId, id, { search, thresholds, now }) {
  const { rows } = await client.query(
    `SELECT sh.*, s.exit_descriptor
       FROM shadow_searches sh JOIN sessions s ON s.id = sh.session_id
      WHERE sh.tenant_id = $1 AND sh.id = $2 AND sh.searched_at IS NULL
      FOR UPDATE OF sh`,
    [tenantId, id],
  );
  const row = rows[0];
  if (!row) return;

  // The descriptors, BY ID, now -- for exactly the candidates the snapshot
  // named. A candidate whose descriptor is gone by now (retention cannot reach
  // an open stay, so this is a stay that closed and aged out between the
  // snapshot and this run) is simply not sent; it is still in `candidate_ids`.
  const candidates = row.candidate_ids.length
    ? (
        await client.query(
          `SELECT id, entry_descriptor AS descriptor FROM sessions
            WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND entry_descriptor IS NOT NULL
            ORDER BY entry_at, id`,
          [tenantId, row.candidate_ids],
        )
      ).rows
    : [];

  const at = now ?? new Date();
  let outcome;
  let matched = [];
  let counts;
  let searchRef = null;
  let refused = null;

  if (row.exit_descriptor === null || candidates.length === 0) {
    // Nothing to compare: the exit read has no descriptor any more, or no
    // candidate has one. Recorded as such rather than as no_match -- "not
    // comparable" is a different fact from "compared and nothing matched".
    outcome = 'none_comparable';
    counts = { candidates: candidates.length, matched: 0, excluded: 0, refused: 0 };
  } else {
    // What leaves for the identity service: ids and descriptors, nothing else.
    const record = await search({
      descriptor: row.exit_descriptor,
      candidates: candidates.map((c) => ({ id: c.id, descriptor: c.descriptor })),
      thresholds,
    });
    if (!OUTCOMES.has(record.outcome)) {
      throw new Error(`search answered an outcome this build does not know: ${JSON.stringify(record.outcome)}`);
    }
    outcome = record.outcome;
    matched = Array.isArray(record.matched) ? record.matched.map(String) : [];
    counts = record.counts ?? null;
    searchRef = record.search_id ?? null;
    refused = (record.candidates ?? []).filter((c) => c.verdict === 'refused').map((c) => c.id);
  }
  const trueStayMatched = matched.includes(row.session_id);

  await client.query(
    `UPDATE shadow_searches
        SET searched_at = $3, outcome = $4, matched_ids = $5::uuid[], true_stay_matched = $6,
            counts = $7, thresholds = $8, search_ref = $9, attempts = attempts + 1, last_error = NULL
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, at, outcome, matched, trueStayMatched, counts, thresholds, searchRef],
  );
  // The record: SESSION IDS and verdicts. No descriptor, no plate.
  await repo.appendEvents(client, tenantId, [
    {
      garageId: row.garage_id,
      laneId: row.exit_lane_id,
      eventId: `shadow:${row.id}`,
      kind: SHADOW_EVENT_KIND,
      occurredAt: at,
      detail: {
        actor: 'platform:shadow',
        shadow_search_id: row.id,
        session_id: row.session_id,
        close_event_id: row.close_event_id,
        outcome,
        matched_ids: matched,
        refused_ids: refused,
        true_stay_comparable: row.true_stay_comparable,
        true_stay_matched: trueStayMatched,
        candidates_open: row.candidates_open,
        candidates_with_descriptor: row.candidates_with_descriptor,
        candidates_sent: candidates.length,
        counts,
        thresholds,
        search_ref: searchRef,
      },
    },
  ]);
}

/**
 * What may be published, and how it is said.
 *
 * Every figure names its denominator and its oracle. The match rate is over
 * `comparable`: rows where the stay the close picked had a descriptor and was
 * among the candidates sent -- because only there does the search's answer
 * have a ground truth to be right or wrong against. A MATCH is a `match`
 * outcome naming the true stay and nothing else; a tie that includes the true
 * stay is a TIE, counted in the tie rate and not the match rate, because a
 * search that names two cars has not identified one. The four rates partition
 * `comparable`: match, wrong match, tie, no match. `exits` is every shadowed
 * close; `searched` every one the worker has finished; the difference between
 * `searched` and `comparable` is the count this measurement cannot say
 * anything about, stated rather than folded in. A row the purge has redacted
 * still counts: its references are gone and its outcome is not, which is
 * exactly what a figure over it needs.
 */
export async function shadowReport(tenantId, garageId) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)                                                    AS exits,
              count(*) FILTER (WHERE searched_at IS NOT NULL)             AS searched,
              count(*) FILTER (WHERE searched_at IS NULL)                 AS pending,
              count(*) FILTER (WHERE searched_at IS NOT NULL
                                 AND true_stay_comparable)                AS comparable,
              count(*) FILTER (WHERE searched_at IS NOT NULL
                                 AND true_stay_comparable
                                 AND outcome = 'match'
                                 AND true_stay_matched)                   AS true_stay_matched,
              count(*) FILTER (WHERE searched_at IS NOT NULL
                                 AND true_stay_comparable
                                 AND outcome = 'tie')                     AS ties,
              count(*) FILTER (WHERE searched_at IS NOT NULL
                                 AND true_stay_comparable
                                 AND outcome = 'no_match')                AS no_match,
              count(*) FILTER (WHERE searched_at IS NOT NULL
                                 AND true_stay_comparable
                                 AND outcome = 'match'
                                 AND NOT true_stay_matched)               AS wrong_match,
              count(*) FILTER (WHERE searched_at IS NOT NULL
                                 AND NOT true_stay_comparable)            AS not_comparable
         FROM shadow_searches
        WHERE tenant_id = $1 AND garage_id = $2`,
      [tenantId, garageId],
    );
    const r = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
    const rate = (n) => (r.comparable > 0 ? n / r.comparable : null);
    return {
      garage_id: garageId,
      denominator: {
        exits: r.exits,
        searched: r.searched,
        pending: r.pending,
        comparable: r.comparable,
        not_comparable: r.not_comparable,
      },
      oracle:
        'the stay the close picked by plate or ticket, independently of the search; ' +
        'plate- or ticket-identified cars only, inheriting the plate reader\'s own errors; ' +
        'a close that matched nothing (a 404) inserted no row and is not in any figure here',
      match_rate: rate(r.true_stay_matched),
      wrong_match_rate: rate(r.wrong_match),
      tie_rate: rate(r.ties),
      no_match_rate: rate(r.no_match),
      counts: {
        true_stay_matched: r.true_stay_matched,
        wrong_match: r.wrong_match,
        ties: r.ties,
        no_match: r.no_match,
      },
      not_measurable: 'a match rate over ALL exits',
    };
  });
}
