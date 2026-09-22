import express from 'express';
import { pool, withTenant } from './db.js';
import { bearerFrom, generateDeviceToken, hashToken } from './auth.js';
import { assertMinor, toMinor } from './money.js';
import * as repo from './repository.js';
import { enqueueShadowSearch } from './shadow.js';
import * as ratePlans from './ratePlans.js';
import * as activation from './activation.js';
import * as entitlement from './entitlement.js';
import { reconcile } from './reconcile.js';

class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    // A MACHINE-READABLE name for the refusal, published beside the message.
    // Null for the statuses that do not carry one; see `conflict` below.
    this.code = code;
    // Structured detail beside the message, published only when set and only
    // with a code. The plan store attaches the engine's findings here: a list
    // an operator works through is data, not a sentence.
    this.details = null;
  }
}

const bad = (message) => new HttpError(400, message);

/**
 * A 409, and every one of them names itself.
 *
 * A 409 is the platform's TERMINAL refusal: the lane classifies 5xx as
 * retryable and re-sends forever, so anything the platform means as final
 * arrives as one of these. It dead-letters the item, counts it and logs it --
 * and until this existed, all seven of them arrived at the lane as the same
 * fact. One of the seven is a clock skew large enough that every session open
 * and close from that lane is being dropped, which is money leaving the record;
 * the others are ordinary. A lane could not tell them apart.
 *
 * The distinguishing thing is a FIELD, not the message. A message is prose: it
 * gets reworded, and a check keyed on its text goes quietly wrong the day
 * somebody improves it. The lane's own client already decides every failure
 * from a structure rather than from message text, for exactly this reason.
 *
 * It is on ALL seven and not only on the skew, because a code present on one
 * refusal and absent from six cannot distinguish "this was not a skew" from
 * "this platform is too old to say" -- and a consumer that read the absence as
 * "not a skew" would report a healthy clock while the money record lost every
 * session the lane sent. Under never-wrong-silently the unlabelled case has to
 * stay distinguishable, so every 409 carries the field.
 *
 * Every conflict in this file is built HERE and nowhere else. The status is a
 * constant rather than a literal precisely so the sweep in `test/api.test.js`
 * can search the source for the literal and require zero hits: a conflict
 * raised directly, without a name, would otherwise reintroduce exactly the
 * ambiguity above and nothing would notice.
 */
const CONFLICT_STATUS = 409;
const conflict = (code, message) => new HttpError(CONFLICT_STATUS, message, code);

/** `POST /garages/:id/rates` is gone for good: 410, with the name a caller can match on. */
const RATES_RETIRED_STATUS = 410;
const RATES_RETIRED_CODE = 'rates_retired';

/**
 * The most stays one delta carries. A garage that changes faster than a
 * reader polls follows `more` at once; the size bounds one answer, not the
 * feed.
 */
const STAY_PAGE = 500;

/**
 * What a lane does with a confidently-read plate that matches no rule.
 *
 * Only the two values the lane recognises by name. An unrecognised value is not
 * rejected by the lane -- it falls back, which is safe -- but it gets there
 * through an else-branch rather than through anything either side agreed, and
 * this platform does not serve values whose meaning rests on that. Refused
 * here rather than at the database so the operator is told which values exist;
 * the column's CHECK is what makes it true regardless of route.
 */
const DEFAULT_ACTIONS = ['allow', 'deny'];

/**
 * What a lane is allowed to say confirmed an entry or an exit.
 *
 * `confirmed` means two loops after the barrier saw a vehicle cross them
 * forward inside the confirmation window. `unconfirmable` means the lane has no
 * closing loops installed, so nothing could have confirmed or refuted it — a
 * weaker lane, saying so on every session it opens.
 *
 * `opened_on_vend` and `closed_on_vend` are NOT here. They are what migration
 * 0005 backfilled onto rows written before any of this existed, and a lane that
 * presented one would be claiming a history it does not have. The column's
 * CHECK permits them because the old rows carry them; this list is what a
 * REQUEST may say, and the two are deliberately different sets.
 */
const CONFIRMATIONS = ['confirmed', 'unconfirmable'];

/**
 * And what a lane may say about an EXIT, which is the same list plus one.
 *
 * `held` is an exit the loops did not confirm. It closes and bills anyway,
 * because the exit vend is the payment moment and the barrier opened — the car
 * is gone whatever the loops saw, and holding the session open would leave the
 * stay unbilled and the vehicle inside for ever. It is a flag for a human, not
 * a hole in the ledger, and the `exit_held` lane event sits beside it.
 *
 * There is deliberately NO entry equivalent. An entry nothing confirmed is not
 * a session at all — no row, no occupancy, no money — so `held` on an open is
 * refused, and a test asserts each side of that separately.
 */
const EXIT_CONFIRMATIONS = [...CONFIRMATIONS, 'held'];

/**
 * The event kinds a lane reports, and it is the whole set it can produce.
 *
 * `POST /lane/events` used to take any string. A device token then bought an
 * `events` table filled with kinds no lane emits -- fabricated evidence sitting
 * beside the real record, and `reconcile.js` counts three of these kinds, so a
 * log it cannot trust is a reconciliation it cannot trust.
 *
 * DERIVED FROM THE LANE, NOT INVENTED HERE: every string below is a name in
 * `lane-controller`, taken from the constants in `sync.py` and the literals
 * passed to `events.record()` -- with the exceptions marked where they sit:
 * a kind lands here FIRST, because of the ordering hazard two paragraphs down,
 * and the lane round that emits it follows. Until that round merges it is a
 * kind this platform accepts and no lane yet reports, and that is the only
 * direction the two copies may ever differ in: a platform ahead of the lane
 * refuses nothing; a lane ahead of the platform is refused 400.
 * `entry_unadmitted` landed this way and its lane round has since merged;
 * `arming_suppressed` and `arming_suppression_ended` are the ones ahead now.
 * `session_open` and `session_close` are
 * deliberately ABSENT -- the lane's transport routes those two to
 * `/sessions/open` and `/sessions/close` and never to this endpoint, so one
 * arriving here is a lane that has lost its routing, and refusing it is the
 * loud answer.
 *
 * THIS IS A SECOND COPY OF A SET THAT LIVES IN ANOTHER REPOSITORY, and there is
 * nothing in either repository's CI that compares them. A lane build that adds
 * a kind and deploys before this list does is refused 400 by an endpoint that
 * used to take anything. Stated here because it is the shape of the ordering
 * hazard the vehicle-id pin check exists for, and this one has no check yet.
 */
const LANE_EVENT_KINDS = [
  'armed',
  'arming_incomplete',
  'arming_rejected',
  // THE DEACTIVATE LOOP, before the arming loop: the arming cycle is held
  // while it reads occupied -- a second vehicle too close behind the one at
  // the barrier -- so the barrier does not open for a car another can follow
  // through. `arming_suppressed` is the START of one such held interval, with
  // its reason; `arming_suppression_ended` is its END, saying which of the two
  // ways it ended: the lane armed once the loop cleared, or the car at the
  // arming loop left without arming. Two kinds and not one, because an
  // interval that only ever started is a car nobody photographed and a record
  // that never closes -- the silent non-event the lane refuses to write. A
  // lane whose config declares no deactivate loop emits neither. Not counted
  // by `reconcile.js`. Ahead of the lane, per the header.
  'arming_suppressed',
  'arming_suppression_ended',
  // The lane's assisted vend: an identity a display or a human completed,
  // recorded BEFORE the relay is pulsed. Its detail names the identity's KIND,
  // the authority, the caller's idempotency key and the decision it completes
  // — and never the ticket reference itself. `events` is append-only by grant,
  // so the retention purge cannot reach a detail: a reference written here
  // would be the one identity on this platform that could never be removed.
  'assisted_identity',
  'decision',
  'entry_backed_out',
  'entry_confirmed',
  'entry_held',
  'entry_pending',
  // The closing loops saw a FORWARD crossing that no vend preceded. A car is
  // inside and nothing admitted it: whatever the lane decided, or never saw,
  // no vend followed, so no pending entry exists for the crossing to promote.
  // It is none of the other entry kinds: `entry_confirmed` had a pending
  // entry behind it, `entry_held` had a pending entry and no crossing,
  // `entry_backed_out` had a pending entry and a REVERSE crossing,
  // `entry_unconfirmable` is a lane with no closing loops at all, and
  // `entry_pending` is the vend itself. A stream of these is the stuck-boom
  // symptom: the camera's job has changed from deciding to recording, and
  // this is the record. It does NOT open a session and it is NOT an
  // `entry_confirmation` value -- that column answers "did anything see the
  // car cross" (yes, the loops did); this kind answers "did anything admit
  // it" (no), and migration 0006 says an entry nothing confirmed is not a
  // session at all. Not counted by `reconcile.js`.
  'entry_unadmitted',
  'entry_unconfirmable',
  'exit_backed_in',
  'exit_confirmed',
  'exit_held',
  'exit_pending',
  'exit_unconfirmable',
  'fallback_needs_human',
  'frames_captured',
  'vehicle_identified',
  'vended',
];

/**
 * What a session open or close SAYS saw the car, and it is required — never
 * defaulted.
 *
 * A default here would be a second copy of a claim about whether anything saw
 * the car, sitting where nobody looks, and the copy is always the one that
 * lies. An old lane build that does not send the field gets a 400 saying which
 * values exist, which is a deployment being told to catch up rather than a
 * money record quietly filling with a value nobody asserted.
 */
function confirmation(value, label, allowed = CONFIRMATIONS) {
  if (!allowed.includes(value)) {
    throw bad(`${label} is required and must be one of ${allowed.join(', ')}`);
  }
  return value;
}

/**
 * The two identities a stay can be opened or found on, and the rule between them.
 *
 * A vehicle used to BE a plate. It is now exactly one of:
 *
 *   plate       a plate a camera READ
 *   ticket_ref  an identity a display or a person ASSERTED, which is what the
 *               intercom can produce for a driver whose plate could not be read
 *
 * EXACTLY ONE, and the refusal names the rule rather than one missing field.
 * Neither means there is no identity to hold a stay against. BOTH would be a
 * claim that this platform established the plate and the ticket belong to the
 * same vehicle — a measurement and an assertion, joined by nothing here. That
 * binding is the identity module's job; `vehicles_exactly_one_identity` in
 * migration 0007 is what stops it being done accidentally in this one.
 *
 * `ticket_ref` IS OPAQUE TO THIS PLATFORM. What is checked is a closed alphabet
 * and a length, and nothing else: no signature, no expiry, no issuer. The agent
 * that mints and verifies tickets is a different module and this is not it, so
 * this platform's own claim about a ticket is exactly "it is unique per tenant
 * and it looks like a ticket" — which is what it can stand behind.
 *
 * The alphabet is closed rather than "any string" because this value is a
 * lookup key that is quoted into no SQL but is echoed into responses, compared
 * against a plate column's contents and read out over a telephone. Upper case,
 * digits and a hyphen are what survives all three; a length bound is what stops
 * a device token's worth of text becoming a vehicle's identity.
 */
const TICKET_REF_SHAPE = /^[A-Z0-9-]{6,64}$/;

/**
 * The longest `plate` this platform will hold, and it is an ADDITION: until now
 * `plate` had no shape rule of any kind.
 *
 * A bound and not an alphabet. This platform does not know the world's plate
 * formats -- they carry spaces, dots, accents and scripts, and a closed
 * alphabet here would refuse real vehicles in jurisdictions nobody on this
 * project has seen. What it CAN stand behind is that a plate is a string, that
 * it is not blank, and that it is not a device token's worth of text: a value
 * that is only whitespace is an identity nobody read, and an unbounded one is a
 * lookup key an attacker chooses the size of.
 *
 * It is a DECISION, not a measurement of any plate anywhere.
 */
const PLATE_MAX = 32;

/**
 * The longest appearance descriptor this platform will hold on a session.
 *
 * A descriptor is the identity service's opaque, versioned, compact string
 * (`opvid-fp/<version>:…`), and this platform does not parse it -- migration
 * 0009 says what it is and why it lives on the session. What this side CAN
 * stand behind is that it is a string, that it is not blank, and that it is not
 * a device token's worth of text: it is stored per stay and compared against
 * every open stay in a garage at the exit, so an unbounded one is a row an
 * attacker chooses the size of.
 *
 * The bound is a DECISION with a measurement behind it: the identity service
 * caps ORB at 256 keypoints and SIFT at 128, and an INCOMPRESSIBLE (random)
 * payload of that size encodes to 12,333 characters (ORB) and 23,262 (SIFT),
 * measured 2026-09-20 against vehicle-id f29f64f. Sixty-four KiB is more than
 * twice the worst case, with room for the descriptor's own version to grow.
 */
const DESCRIPTOR_MAX = 65536;

/**
 * The appearance descriptor on a session open OR close: OPTIONAL, and typed
 * before it is bounded, for the reason `laneIdentity` gives -- `String(value)`
 * on an array produces something a length check is happy with.
 *
 * Absent or null is NOT MEASURED: a lane with the descriptor switched off,
 * which is the default, sends none and is unchanged by this. Present, it is
 * stored on the session and ECHOED back on the row -- and the echo is a
 * contract term, not a convenience. A platform older than the column accepts
 * the same call and drops the field silently (both routes destructure known
 * keys and ignore the rest), so the lane treats an action whose response does
 * not carry the descriptor it sent as not delivered. That is the same rule
 * `entry_confirmation` and `exit_confirmation` already live under, and for the
 * same reason. ONE function for both ends, as `confirmation()` is.
 */
function descriptorField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > DESCRIPTOR_MAX) {
    throw bad(
      `descriptor must be a string of at most ${DESCRIPTOR_MAX} characters and not only ` +
        'whitespace; this platform stores a descriptor and does not otherwise read it',
    );
  }
  return value;
}

/** What a lane's exit decision can say it was (`lane-controller/exit_pricing.py`). */
const LOCAL_DECISION_STATUSES = new Set([
  'covered', 'priced', 'no_cached_entry', 'engine_refused', 'engine_invalid', 'stale_facts',
]);

/**
 * The lane's exit decision, as the close carries it (0017): the record the
 * lane made at the barrier, before the boom moved, from its cache and the
 * engine in-process. Shape by name; a decision that is not one is refused
 * 400 here, not consumed as something.
 *
 * Whether the close CONSUMES it is decided beside the open stay
 * (`consumableDecision`), not here: this only says the value is a decision.
 */
function localDecisionField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw bad('local_decision must be an object: the lane\'s exit decision as it recorded it');
  }
  const { status } = value;
  if (!LOCAL_DECISION_STATUSES.has(status)) {
    throw bad(`local_decision.status must be one of ${[...LOCAL_DECISION_STATUSES].join(', ')}`);
  }
  const from = value.computed_from;
  if (typeof from !== 'object' || from === null || Array.isArray(from)) {
    throw bad('local_decision.computed_from must be an object: when the lane\'s cache was refreshed');
  }
  if (status === 'priced') {
    if (!Number.isInteger(value.fee_minor) || value.fee_minor < 0) {
      throw bad('local_decision.fee_minor must be a whole number of minor units');
    }
    for (const key of ['currency', 'plan_version', 'entry_at', 'exit_at', 'session_id', 'space_class']) {
      if (typeof value[key] !== 'string' || value[key] === '') {
        throw bad(`local_decision.${key} must be a non-empty string on a priced decision`);
      }
    }
    if (!Array.isArray(value.breakdown)) throw bad('local_decision.breakdown must be the engine\'s ledger, a list');
  }
  if (status === 'covered' && (!Array.isArray(value.covered_by) || value.covered_by.length === 0)) {
    throw bad('local_decision.covered_by must name the module(s) that covered the stay');
  }
  return value;
}

/**
 * WHETHER THE CLOSE CONSUMES THE LANE'S DECISION, and why not when not.
 *
 * Consumed: `covered` (the lane read a register that stands today) and
 * `priced` (the lane priced from its cached entry) -- when the priced
 * decision is about THIS stay, in this stay's currency, in this garage's
 * space class, on a plan version this garage holds. Everything else is said
 * by name and the close prices for itself: the lane could not decide
 * (`no_cached_entry`, `stale_facts`, the engine's refusals -- brief 4.5),
 * or it decided about a different stay or with different money, which is
 * the one case a lane's word is not taken and the record keeps the word.
 *
 * Returns `{ consume: true }` or `{ consume: false, reason }`. Never throws:
 * a mismatch is a STATED RECONCILE on the record, never a 5xx the lane would
 * retry for ever and never a 4xx that leaves the stay open.
 */
function consumableDecision(decision, { open, garage, planVersions }) {
  if (decision === null) return { consume: false, reason: 'no local decision on the close' };
  if (decision.status === 'covered') return { consume: true };
  if (decision.status !== 'priced') {
    return { consume: false, reason: `the lane could not decide at the barrier: ${decision.status}` };
  }
  if (decision.session_id !== open.id) {
    return { consume: false, reason: 'the decision names a different session than the one being closed' };
  }
  if (decision.currency !== open.currency) {
    return { consume: false, reason: `the decision prices in ${decision.currency}; the stay is in ${open.currency}` };
  }
  if (decision.space_class !== garage.space_class) {
    return { consume: false, reason: `the decision priced space class ${decision.space_class}; the garage's is ${garage.space_class}` };
  }
  if (!planVersions.includes(decision.plan_version)) {
    return { consume: false, reason: `the decision names plan version ${decision.plan_version}, which this garage does not hold` };
  }
  return { consume: true };
}

/**
 * THE TYPE IS TESTED BEFORE THE SHAPE, and that is the whole of this paragraph.
 *
 * `String(value)` on a JSON array or a number produces something a regex is
 * happy to match -- `["ABCDEF"]` becomes `ABCDEF` -- so a coercion in front of
 * a shape rule is a shape rule that reads a value the caller did not send. The
 * lane refuses a non-string `ticket_ref` at `vend.parse`, and
 * `lane-controller`'s `contract.py` publishes a claim about which side of that
 * seam fails first; a claim about a rule should be true of the rule.
 *
 * A third party calls this route without going through our lane at all, which
 * is the premise of the whole project, so this side does its own typing.
 */
function laneIdentity(source, { where = 'body' } = {}) {
  const plate = source?.plate ?? null;
  const ticketRef = source?.ticket_ref ?? null;
  if (Boolean(plate) === Boolean(ticketRef)) {
    throw bad(
      `exactly one of plate or ticket_ref is required in the ${where}; ` +
        `this request sent ${plate && ticketRef ? 'both' : 'neither'}`,
    );
  }
  if (ticketRef !== null && ticketRef !== undefined) {
    if (typeof ticketRef !== 'string' || !TICKET_REF_SHAPE.test(ticketRef)) {
      throw bad(
        'ticket_ref must be a string of 6 to 64 characters of A-Z, 0-9 and hyphen; ' +
          'this platform verifies nothing else about a ticket',
      );
    }
  }
  if (plate !== null && plate !== undefined) {
    if (typeof plate !== 'string' || plate.trim() === '' || plate.length > PLATE_MAX) {
      throw bad(
        `plate must be a string of at most ${PLATE_MAX} characters and not only whitespace; ` +
          'this platform bounds a plate and does not otherwise check its shape',
      );
    }
  }
  return { plate: plate ? String(plate) : null, ticketRef: ticketRef ? String(ticketRef) : null };
}

/**
 * What a lane may call an event, and it is refused rather than stored.
 *
 * Same shape as `confirmation()` above and for the same reason: the route is
 * where the sender is told which values exist. The kind is NAMED in the
 * refusal, because a lane build ahead of this one needs to see which of its
 * kinds this platform does not know.
 */
function eventKind(value) {
  if (!LANE_EVENT_KINDS.includes(value)) {
    throw bad(
      `kind ${JSON.stringify(value)} is not one a lane reports; it must be one of ` +
        LANE_EVENT_KINDS.join(', '),
    );
  }
  return value;
}

function defaultAction(value, { required }) {
  if (value === undefined || value === null) {
    if (required) throw bad(`default_action is required and must be one of ${DEFAULT_ACTIONS.join(', ')}`);
    return undefined;
  }
  if (!DEFAULT_ACTIONS.includes(value)) {
    throw bad(`default_action must be one of ${DEFAULT_ACTIONS.join(', ')}`);
  }
  return value;
}

function parseTime(value, label) {
  if (!value) throw bad(`${label} is required`);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw bad(`${label} is not a valid timestamp`);
  return at;
}

/**
 * How far ahead of this server's clock a lane-supplied time may be, in seconds.
 *
 * Times come from the LANE and that is a decision with a reason: the car may
 * have arrived while the lane had no network, so a time in the PAST is
 * legitimate and is not bounded anywhere. A time in the FUTURE is a different
 * claim -- that something has happened which has not -- and no decision covered
 * it. Unbounded, an `exit_at` a lane can name freezes a fee for a stay nobody
 * has had yet.
 *
 * The tolerance is for CLOCK DRIFT between a lane device and this server and
 * for nothing else: comfortably more than NTP leaves on a device that is
 * working, and far below any interval that could be billed. It is a DECISION,
 * not a measurement of anything.
 *
 * Read once, at load, and a value that is not a number is refused HERE rather
 * than becoming a NaN comparison that is false for every input -- which is this
 * bound silently absent, on a process that started cleanly.
 */
/**
 * The name the skew refusal carries in `code`.
 *
 * Exported because it is the one 409 a lane derives a MALFUNCTION from -- a
 * clock running fast dead-letters every session open and close that lane sends
 * -- so the string is part of this platform's published surface and not an
 * implementation detail. One copy; `lane-controller` pins this exact value and
 * its own test names where it came from.
 */
export const CLOCK_SKEW = 'clock_skew';

const MAX_CLOCK_SKEW_SECONDS = (() => {
  const raw = process.env.MAX_CLOCK_SKEW_SECONDS;
  if (raw === undefined || raw === '') return 120;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `MAX_CLOCK_SKEW_SECONDS must be a non-negative number of seconds, not ${JSON.stringify(raw)}`,
    );
  }
  return value;
})();

/**
 * Refuse a lane time that has not happened yet.
 *
 * 409 and not 400, for the reason the stale exit is a 409: the lane classifies
 * 5xx as retryable and re-sends forever with its whole outbox stuck behind it,
 * while a 4xx is terminal -- dead-lettered, counted and logged at error. One
 * function for both ends of a stay, because two copies of this rule would be
 * two claims about the same thing and the copy is the one that goes wrong.
 *
 * The message carries how far ahead the time was and how far ahead is
 * tolerated, both derived, so the operator reading the lane's error log does
 * not have to find this constant to know what happened.
 */
function refuseFuture(at, label, now = new Date()) {
  const ahead = (at.getTime() - now.getTime()) / 1000;
  if (ahead > MAX_CLOCK_SKEW_SECONDS) {
    throw conflict(
      CLOCK_SKEW,
      `${label} is ${Math.round(ahead)}s ahead of this server's clock, more than the ` +
        `${MAX_CLOCK_SKEW_SECONDS}s of drift tolerated — a time in the future is not a stay ` +
        'that has happened',
    );
  }
  return at;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // -------------------------------------------------------------------------
  // Operator surface.
  // -------------------------------------------------------------------------
  const operator = express.Router();

  /**
   * Authenticated by an operator token, and the tenant comes FROM the token.
   *
   * This used to trust an `x-tenant-id` header. Anyone who could reach the API
   * could then act as any tenant whose id they knew -- including minting lane
   * credentials for it, which is a route into that tenant's whole estate. The
   * header is no longer read anywhere.
   *
   * Same bootstrap problem as lane devices, same answer: resolve_operator_token
   * is SECURITY DEFINER because the tenant is what the lookup is for.
   */
  operator.use(async (req, _res, next) => {
    try {
      const token = bearerFrom(req.get('authorization'));
      if (!token) throw new HttpError(401, 'operator token required');
      const { rows } = await pool.query('SELECT * FROM resolve_operator_token($1)', [hashToken(token)]);
      if (rows.length === 0) throw new HttpError(401, 'unknown or revoked operator token');
      req.tenantId = rows[0].tenant_id;
      req.operatorTokenId = rows[0].token_id;
      pool.query('SELECT touch_operator_token($1)', [req.operatorTokenId]).catch(() => {});
      next();
    } catch (err) {
      next(err);
    }
  });

  operator.post('/garages', async (req, res, next) => {
    try {
      const { name, timezone, currency } = req.body ?? {};
      if (!name || !timezone || !currency) throw bad('name, timezone and currency are required');
      // Optional. A garage that says nothing gets the column default, which is
      // the value this platform has always served.
      const action = defaultAction(req.body?.default_action, { required: false });
      // Optional, and frozen after creation like the currency: every stay in
      // the garage is priced as this class (0013), and a plan is refused at
      // the store unless it declares it.
      const spaceClass = spaceClassField(req.body?.space_class);
      // Optional at creation, statable later, never defaulted: unstated is
      // the absence of the field, and an unstated garage cannot activate.
      const transient = transientField(req.body?.transient_available, { required: false });
      const garage = await withTenant(req.tenantId, async (client) => {
        // Each column is left out entirely when nothing was asked for, so the
        // value an unconfigured garage gets is written down in exactly one
        // place -- the column default in 0004 (0013 for the space class).
        // Naming it here too would be a second copy of the same claim, and
        // the two would drift.
        const columns = ['tenant_id', 'name', 'timezone', 'currency'];
        const values = [req.tenantId, name, timezone, currency];
        if (action !== undefined) { columns.push('default_action'); values.push(action); }
        if (spaceClass !== undefined) { columns.push('space_class'); values.push(spaceClass); }
        if (transient !== undefined) { columns.push('transient_available'); values.push(transient); }
        const { rows } = await client.query(
          `INSERT INTO garages (${columns.join(', ')})
           VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          values,
        );
        return rows[0];
      });
      res.status(201).json({ garage });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Change what an existing garage does with an unknown plate, and/or state
   * its transient mode.
   *
   * Creation-time only would have left every garage that already exists unable
   * to be strict, which is the whole of what was wrong. It takes these two
   * fields and nothing else: a garage's timezone, currency and space class are
   * frozen onto sessions and money and are not a thing to edit in passing.
   * `transient_available` is the activation gate's second condition (0014):
   * true or false, statable here at any time, restatable, never un-statable
   * -- the trigger refuses NULL after a value -- and never defaulted.
   */
  operator.patch('/garages/:garageId', async (req, res, next) => {
    try {
      const action = defaultAction(req.body?.default_action, { required: false });
      const transient = transientField(req.body?.transient_available, { required: false });
      if (action === undefined && transient === undefined) {
        throw bad('default_action or transient_available is required');
      }
      const garage = await withTenant(req.tenantId, async (client) => {
        const sets = [];
        const values = [req.tenantId, req.params.garageId];
        if (action !== undefined) { values.push(action); sets.push(`default_action = $${values.length}`); }
        if (transient !== undefined) { values.push(transient); sets.push(`transient_available = $${values.length}`); }
        const { rows } = await client.query(
          `UPDATE garages SET ${sets.join(', ')}
            WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          values,
        );
        return rows[0];
      });
      if (!garage) throw new HttpError(404, 'garage not found');
      res.json({ garage });
    } catch (err) {
      next(err);
    }
  });

  /**
   * What the activation gate sees for this garage: active or not, and each
   * condition with whether it holds and why not. The operator's readout
   * before -- and after -- asking to activate.
   */
  operator.get('/garages/:garageId/activation', async (req, res, next) => {
    try {
      const state = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        return activation.readout(client, req.tenantId, garage);
      });
      res.json({ activation: state });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Activate the garage: the act his ruling names, with a timestamp and the
   * operator token that did it. Refused by name, with every unmet condition
   * listed in `details`, while either condition is unmet. Idempotent.
   */
  operator.post('/garages/:garageId/activate', async (req, res, next) => {
    try {
      const out = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        return activation.activate(client, req.tenantId, garage, {
          actor: `operator_token:${req.operatorTokenId}`,
        });
      });
      res.status(out.activated ? 201 : 200).json({ garage: out.garage, activated: out.activated });
    } catch (err) {
      if (err instanceof activation.NotActivatable) {
        const refusal = conflict('garage_not_activatable', err.message);
        refusal.details = { unmet: err.unmet };
        return next(refusal);
      }
      next(err);
    }
  });

  /**
   * State which garage-pass garage and which monthly-billing garage this
   * garage is, under which tenant of each -- or that it is not linked to one
   * (null). Each stated link is PROBED before it is stored: the module must
   * answer a question about that garage at all, and a link it cannot answer
   * is refused by name. Restatable; every statement is recorded with what
   * changed and what the probes saw.
   */
  operator.put('/garages/:garageId/entitlement-links', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      for (const key of Object.keys(body)) {
        if (!(key in entitlement.MODULES)) throw bad(`unknown module ${JSON.stringify(key)}; the links are garage_pass and monthly_billing`);
      }
      const links = {};
      for (const module of Object.keys(entitlement.MODULES)) {
        if (!(module in body)) throw bad(`${module} is required: null (not linked) or {tenant_id, garage_id}`);
        links[module] = linkField(body[module], module);
      }
      const garage = await withTenant(req.tenantId, async (client) => {
        const current = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!current) throw new HttpError(404, 'garage not found');
        return entitlement.stateLinks(client, req.tenantId, current, links, {
          actor: `operator_token:${req.operatorTokenId}`,
        });
      });
      res.json({ garage });
    } catch (err) {
      if (err instanceof entitlement.LinkUnanswerable) {
        return next(conflict('entitlement_link_unanswerable', err.message));
      }
      next(err);
    }
  });

  operator.post('/garages/:garageId/lanes', async (req, res, next) => {
    try {
      const { name, direction } = req.body ?? {};
      if (!name || !['entry', 'exit'].includes(direction)) {
        throw bad("name and direction ('entry' or 'exit') are required");
      }
      const lane = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING *`,
          [req.tenantId, req.params.garageId, name, direction],
        );
        return rows[0];
      });
      res.status(201).json({ lane });
    } catch (err) {
      next(err);
    }
  });

  /**
   * RETIRED, BY NAME. The one-hourly-figure `rates` table was superseded by
   * the plan store (0012) and the engine-priced close (0013): nothing has
   * priced from it since, and 0016 took it off the lane's payload too. The
   * route stays as a refusal rather than vanishing into a 404, so an operator
   * who still calls it is told where the price now lives instead of being
   * left to guess whether the path was mistyped. The table itself stays --
   * `sessions.rate_id` references it and the hourly-legacy rows name it --
   * and nothing writes it any more.
   */
  operator.post('/garages/:garageId/rates', (_req, _res, next) => {
    next(
      new HttpError(
        RATES_RETIRED_STATUS,
        `the hourly rate table is retired: nothing prices from it since migration 0013. ` +
          `Store a rate plan with POST /api/v1/garages/:garageId/rate-plans instead.`,
        RATES_RETIRED_CODE,
      ),
    );
  });

  /**
   * Store a rate plan for a garage: the plan document, whole, as the engine
   * validated it.
   *
   * Every refusal is named. The engine's own refusals come through with its
   * sentence -- an unknown key is named by the engine, not paraphrased here --
   * and a plan that loads but cannot price every stay it covers is refused
   * with every finding listed, because a gap found here is a gap not found at
   * the barrier. What only the store can see -- the garage's currency, a
   * version name already used, an effective instant already taken -- is
   * refused here. No engine reachable is a refusal too, not an acceptance.
   *
   * The close route prices from what is stored here (0013): every plan of
   * the garage goes to the engine, unfiltered, and the engine picks the
   * version in force at entry.
   */
  operator.post('/garages/:garageId/rate-plans', async (req, res, next) => {
    try {
      const document = ratePlans.planDocument(req.body?.plan);
      const out = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        // Validated BEFORE it is stored, by the only thing that knows what a
        // plan means. The currency check sits after it deliberately: a
        // document the engine cannot load has no currency worth comparing.
        const validated = await ratePlans.validateWithEngine(document);
        const row = await ratePlans.storeRatePlan(client, req.tenantId, {
          garage,
          document,
          validated,
          actor: `operator_token:${req.operatorTokenId}`,
        });
        return row;
      });
      res.status(201).json({ rate_plan: presentRatePlan(out) });
    } catch (err) {
      next(ratePlanRefusal(err));
    }
  });

  /**
   * Every plan of the garage. The list the engine prices from, plus what the
   * store knows about each: no selection, no "current plan" -- the engine
   * chooses by entry time, and a second chooser here is the copy that drifts.
   */
  operator.get('/garages/:garageId/rate-plans', async (req, res, next) => {
    try {
      const rows = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        return ratePlans.ratePlansForGarage(client, req.tenantId, garage.id);
      });
      res.json({ rate_plans: rows.map(presentRatePlan) });
    } catch (err) {
      next(err);
    }
  });

  operator.post('/lanes/:laneId/devices', async (req, res, next) => {
    try {
      const { name } = req.body ?? {};
      if (!name) throw bad('name is required');
      // Generated here, hashed before it touches the database, and returned
      // exactly once. There is no endpoint that can show it again.
      const token = generateDeviceToken();
      const device = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)
           RETURNING id, lane_id, name, created_at`,
          [req.tenantId, req.params.laneId, name, hashToken(token)],
        );
        return rows[0];
      });
      res.status(201).json({ device, token, token_note: 'shown once; it is not recoverable' });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Revoke a device token.
   *
   * A device token is a lane's identity: it resolves server-side to one lane,
   * one direction, one garage, one tenant, and the platform records what the
   * holder reports. A token that leaks is therefore a lane that leaked, and
   * until this route existed there was no way for an operator to end that.
   * Setting the garage to `deny` does not: it stops vends, while
   * `/lane/sessions/open` and `/lane/sessions/close` stay fully usable by the
   * stolen token. The only remaining move was an UPDATE against the production
   * database by hand.
   *
   * `revoked_at` and the filter that reads it are not new -- they have been in
   * `lane_devices` and in `resolve_lane_device` since 0002. What was missing
   * was anything that sets the column.
   *
   * `coalesce` rather than a plain assignment: revoking twice is not an error,
   * and the first revocation is when the credential stopped being trusted. A
   * second call must not move that moment. There is no route back: a revoked
   * device is issued again, not un-revoked, so a mistake costs an issuance and
   * never quietly restores a credential somebody else may be holding.
   */
  operator.post('/devices/:deviceId/revoke', async (req, res, next) => {
    try {
      const device = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `UPDATE lane_devices SET revoked_at = coalesce(revoked_at, now())
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, lane_id, name, created_at, revoked_at`,
          [req.tenantId, req.params.deviceId],
        );
        return rows[0];
      });
      // Another tenant's device is not found rather than forbidden, which is
      // what row-level security makes it: the row is not visible to ask about.
      if (!device) throw new HttpError(404, 'device not found');
      res.json({ device });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Revoke an operator token.
   *
   * The same route as the device revoke above, because the schema is the same
   * shape: `operator_tokens.revoked_at` (0003:71) and `resolve_operator_token`'s
   * `AND t.revoked_at IS NULL` (0003:92) have been there since 0003, and
   * nothing set the column. The L3 that reviewed the device fix found its twin.
   *
   * It is NOT as sharp a gap as the device one, and that is worth writing down
   * rather than letting the identical code imply an identical case. An operator
   * token is issued by `scripts/issue-operator-token.js`, so whoever would
   * revoke one already holds the database access to UPDATE it by hand; a device
   * token is issued through the API, so its holder had no such move. The reason
   * to close it anyway is that "you still have psql" was not an acceptable
   * answer for devices, and this route costs nothing the device one did not
   * already pay for.
   *
   * `coalesce` so a second revocation cannot move the moment the credential
   * stopped being trusted; 404 rather than 403 for another tenant's token,
   * because row-level security makes it not-found; and no un-revoke, so a
   * revoked token is issued again rather than quietly restored. Identical to
   * the device route, for identical reasons.
   *
   * `token_hash` is not in the RETURNING list. Revoking a credential is not an
   * occasion to hand it back out.
   */
  operator.post('/operator-tokens/:tokenId/revoke', async (req, res, next) => {
    try {
      const tokenRow = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `UPDATE operator_tokens SET revoked_at = coalesce(revoked_at, now())
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, name, created_at, last_seen_at, revoked_at`,
          [req.tenantId, req.params.tokenId],
        );
        return rows[0];
      });
      if (!tokenRow) throw new HttpError(404, 'operator token not found');
      res.json({ operator_token: tokenRow });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The devices on this garage's lanes, and when each was last heard from.
   *
   * `last_seen_at` has been written on every authenticated lane request since
   * 0002 (`touch_lane_device`), and until this route existed the platform
   * published it nowhere: the column was returned only by the device-create
   * response, which is one row at one moment and never again. So the platform
   * KNEW which lanes had gone quiet and could not tell anybody.
   *
   * There is no new column and no new write. This is a read of what is already
   * recorded, and the malfunction a monitor derives from it -- a lane that has
   * stopped reporting -- is that consumer's threshold to set, not this
   * platform's. Publishing the timestamp and refusing to publish a verdict is
   * deliberate: how long is too long is a per-site assumption, and a number
   * chosen here would be one nobody measured, applied to every site.
   *
   * `token_hash` is not in the list, for the same reason the revoke route does
   * not return it. `revoked_at` is, because a revoked device that stops being
   * seen is not a fault and a consumer needs to be able to tell.
   *
   * Tenant from the token, as every operator route. Another tenant's garage is
   * NOT FOUND rather than forbidden -- the row is not visible to ask about,
   * which is what row-level security makes it, and it is the convention every
   * other garage-scoped route here already follows.
   */
  operator.get('/garages/:garageId/devices', async (req, res, next) => {
    try {
      const devices = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        return repo.devicesForGarage(client, req.tenantId, req.params.garageId);
      });
      res.json({ devices });
    } catch (err) {
      next(err);
    }
  });

  /**
   * What this garage believes is inside, and on what evidence.
   *
   * `inside_count` counts CONFIRMED sessions only — the ones where two loops
   * after the barrier saw a vehicle cross them. That is a change in what the
   * number means, and it is the point: it used to count every vend, so a driver
   * who took a ticket and drove away was counted as inside forever, and a
   * garage filled up on paper before it filled in concrete.
   *
   * The rest are not hidden, which would be the same defect in the other
   * direction — a real car in an unconfirmable lane is still a real car.
   * `unconfirmable_count` and `open_count` are returned beside it, so a
   * consumer can see the whole of what is open and what is behind each part.
   */
  operator.get('/garages/:garageId/sessions/open', async (req, res, next) => {
    try {
      const sessions = await withTenant(req.tenantId, (client) =>
        repo.openSessionsForGarage(client, req.tenantId, req.params.garageId),
      );
      const confirmed = sessions.filter((s) => s.entry_confirmation === 'confirmed');
      res.json({
        inside_count: confirmed.length,
        unconfirmable_count: sessions.length - confirmed.length,
        open_count: sessions.length,
        sessions,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Reconciliation. Counts that should agree, reported when they do not.
   *
   * Read-only and correcting nothing, deliberately: an auto-correcting
   * reconciler on a money record destroys the evidence of the thing it was
   * meant to detect.
   */
  operator.get('/garages/:garageId/reconciliation', async (req, res, next) => {
    try {
      const hours = clampWindow(req.query.hours, 24);
      const maxHours = statedWindow(req.query.max_stay_hours, 'max_stay_hours');
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const report = await withTenant(req.tenantId, (client) =>
        reconcile(client, req.tenantId, req.params.garageId, { since, maxHours }),
      );
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Lane surface. Authenticated by device token.
  // -------------------------------------------------------------------------
  const lane = express.Router();

  lane.use(async (req, _res, next) => {
    try {
      const token = bearerFrom(req.get('authorization'));
      if (!token) throw new HttpError(401, 'device token required');

      // The bootstrap problem: we do not yet know which tenant this token
      // belongs to, so this lookup cannot run under a tenant policy. It goes
      // through resolve_lane_device(), which is SECURITY DEFINER for exactly
      // that reason. See migration 0002.
      const { rows } = await pool.query('SELECT * FROM resolve_lane_device($1)', [hashToken(token)]);
      if (rows.length === 0) throw new HttpError(401, 'unknown or revoked device token');

      req.device = {
        deviceId: rows[0].device_id,
        tenantId: rows[0].tenant_id,
        laneId: rows[0].lane_id,
        garageId: rows[0].garage_id,
        direction: rows[0].direction,
      };
      pool.query('SELECT touch_lane_device($1)', [req.device.deviceId]).catch(() => {});
      next();
    } catch (err) {
      next(err);
    }
  });

  /**
   * WHAT THE LANE CACHES SO IT CAN DECIDE WITH THE NETWORK DOWN -- and, since
   * 0016, what the exit needs to decide a covered car and price a transient
   * on the box, off the barrier's path:
   *
   *   rate_plans     the garage's plans, WHOLE, as 0012 stores them, oldest
   *                  effective date first. The engine selects among them by
   *                  entry time; this platform filters nothing (the same
   *                  list the close hands the engine, `ratePlans.documents`).
   *   space_class    the garage's, which every quote takes (0013).
   *   entitlements   each linked module's register, read through its own
   *                  `show-garage-register` verb and kept verbatim; a module
   *                  whose register could not be read says so and
   *                  `complete` is false (`entitlement.registers`).
   *   stays          the garage's OPEN stays and the cursor to continue from
   *                  on `GET /lane/stays?since=` -- the fast cadence. This
   *                  is the slow one: plans, entitlements and settings change
   *                  rarely; open stays change with every car.
   *
   * What LEFT the payload: `hourly_minor` and `rate_id`, an hourly figure
   * nothing has priced with since 0013 (serving it beside the real plans
   * would be two prices on one channel); and `plate_rules`, an empty list
   * that said the platform had nothing to put in it, now that it has.
   *
   * THIS IS A READ AND IT RECORDS NOTHING: like the two module verbs it
   * calls, it writes no row and appends no event.
   */
  lane.get('/rules', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      const payload = await withTenant(tenantId, async (client) => {
        const garage = await repo.getGarage(client, tenantId, garageId);
        if (!garage) return { garage };
        const plans = ratePlans.documents(await ratePlans.ratePlansForGarage(client, tenantId, garageId));
        // The cursor is read BEFORE the open set in the same transaction: a
        // row that lands between the two reads is then past the cursor and
        // arrives on the first delta, rather than being in the set AND past
        // it -- which is harmless -- or, read the other way round, before the
        // cursor and in no delta.
        const cursor = await repo.stayCursor(client, tenantId, garageId);
        const open = await repo.openStaysForLane(client, tenantId, garageId);
        return { garage, plans, stays: { cursor, open } };
      });
      if (!payload.garage) throw new HttpError(404, 'garage not found');
      // Outside the transaction: two subprocesses, and nothing of theirs is
      // this database's.
      const entitlements = await entitlement.registers(payload.garage);
      res.json({
        garage_id: garageId,
        lane_id: laneId,
        direction,
        timezone: payload.garage.timezone,
        currency: payload.garage.currency,
        space_class: payload.garage.space_class,
        // The garage's own value, not a literal. It was a literal until 0004,
        // which meant a garage that wanted the strict behaviour could not have
        // it -- the lane supports 'deny' and always has, and nothing could
        // reach it. A garage that has set nothing still gets 'allow'.
        default_action: payload.garage.default_action,
        // The gate's verdict (0014). Served so a lane can see it; the lane
        // does not read it yet, and a platform ahead of the lane refuses
        // nothing by adding a key.
        active: payload.garage.activated_at !== null,
        rate_plans: payload.plans,
        entitlements,
        stays: payload.stays,
        synced_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * THE STAY FEED, the fast cadence. `?since=<cursor>` answers every stay of
   * the garage whose `change_seq` is past the cursor -- opened, closed, or
   * re-identified since -- in cursor order, closed rows included so a reader
   * drops them; `cursor` is where to continue from, and `more` says a page
   * filled and the next call should follow at once. Without `since` it is
   * the full open set with the garage's cursor, the same as `/lane/rules`
   * carries: the resync a reader takes on the slow cadence, and the bound on
   * what a delta can miss (0016 says why a delta can).
   *
   * `since` is the cursor as this route handed it out: a string of digits.
   * Anything else is refused by name.
   */
  lane.get('/stays', async (req, res, next) => {
    try {
      const { tenantId, garageId } = req.device;
      const since = req.query.since;
      if (since !== undefined && !/^\d{1,18}$/.test(String(since))) {
        throw bad('since must be a cursor this route handed out: a string of digits');
      }
      const answer = await withTenant(tenantId, async (client) => {
        const garage = await repo.getGarage(client, tenantId, garageId);
        if (!garage) return null;
        if (since === undefined) {
          const cursor = await repo.stayCursor(client, tenantId, garageId);
          const open = await repo.openStaysForLane(client, tenantId, garageId);
          return { cursor, open };
        }
        const { changes, more } = await repo.stayChangesSince(client, tenantId, garageId, String(since), STAY_PAGE);
        // The cursor never runs ahead of what was delivered: the last row's
        // value, or `since` itself when nothing changed. A cursor taken from
        // the table after the rows were read could cover a row that committed
        // in between, and that row would then be in no delta.
        const cursor = changes.length ? changes[changes.length - 1].change_seq : String(since);
        return { since: String(since), cursor, changes, more };
      });
      if (!answer) throw new HttpError(404, 'garage not found');
      res.json(answer);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Append lane events. Idempotent on (tenant, event_id).
   *
   * A lane that has been offline re-sends whatever it could not confirm, so
   * this endpoint receives duplicates as a matter of course, not as an error.
   */
  lane.post('/events', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId } = req.device;
      const incoming = Array.isArray(req.body?.events) ? req.body.events : null;
      if (!incoming) throw bad('events[] is required');
      const events = incoming.map((e) => {
        if (!e.event_id) throw bad('every event needs an event_id');
        if (!e.kind) throw bad('every event needs a kind');
        return {
          garageId,
          laneId,
          eventId: String(e.event_id),
          kind: eventKind(e.kind),
          // The same bound as an entry_at and an exit_at, on the third
          // lane-supplied time. A future-dated event satisfies every window a
          // reconciliation report will ever ask for and nothing removes it, so
          // one batch makes the surface that exists to show a lane being worked
          // permanently deaf.
          occurredAt: refuseFuture(parseTime(e.occurred_at, 'occurred_at'), 'occurred_at'),
          detail: e.detail ?? {},
        };
      });
      const result = await withTenant(tenantId, (client) => repo.appendEvents(client, tenantId, events));
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * What is currently open for this identity, so the exit lane can name the
   * session it is closing rather than leaving the platform to guess from it.
   * Best effort: an offline lane simply closes without it.
   *
   * `?plate=` or `?ticket_ref=`, exactly one, by the same rule the open uses —
   * a stay opened on a ticket has no plate to be looked up by, and a lookup
   * that could only ask about plates would leave every ticket stay
   * unfindable at the exit.
   */
  lane.get('/sessions/open', async (req, res, next) => {
    try {
      const { tenantId, garageId } = req.device;
      const identity = laneIdentity(req.query, { where: 'query string' });
      const session = await withTenant(tenantId, (client) =>
        repo.findOpenSessionByIdentity(client, tenantId, garageId, identity),
      );
      if (!session) throw new HttpError(404, 'no open session for this vehicle');
      res.json({ session: presentSession(session) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Entry. Idempotent: replaying it returns the session already open.
   *
   * entry_at comes from the LANE, not from the server clock, because the lane
   * may have been offline when the car actually arrived.
   */
  lane.post('/sessions/open', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      if (direction !== 'entry') {
        throw conflict('wrong_lane_direction', 'this device is not on an entry lane');
      }
      const {
        plate_region: plateRegion = null,
        event_id: openEventId,
        make = null,
        model = null,
        color = null,
        attributes = null,
      } = req.body ?? {};
      const entryDescriptor = descriptorField(req.body?.descriptor);
      // Exactly one of plate or ticket_ref. A lane that sends only a plate is
      // an older lane and is unchanged by this; a lane that sends a ticket is
      // the intercom completing an identity for a driver the camera could not
      // read.
      const { plate, ticketRef } = laneIdentity(req.body);
      const entryConfirmation = confirmation(req.body?.entry_confirmation, 'entry_confirmation');
      // Required, not optional. Without it there is no key to be idempotent on
      // and the only thing left to check is state -- which is exactly how a
      // replay arriving after the car has left opens a second, phantom session.
      if (!openEventId) throw bad('event_id is required');
      const entryAt = refuseFuture(parseTime(req.body?.entry_at, 'entry_at'), 'entry_at');

      // THE GATE (0014): an inactive garage opens no stay. Recorded, then
      // refused -- in that order, because the lane drops the 409.
      const garage = await activeGarageOrRefuse({
        tenantId, garageId, laneId, laneEventId: String(openEventId), action: 'open', at: entryAt,
      });

      const result = await withTenant(tenantId, async (client) => {
        const vehicle = await repo.upsertVehicle(client, tenantId, {
          plate, ticketRef, plateRegion, seenAt: entryAt, make, model, color, attributes,
        });
        return repo.openSession(client, tenantId, {
          garageId,
          vehicleId: vehicle.id,
          laneId,
          entryAt,
          currency: garage.currency,
          openEventId: String(openEventId),
          entryConfirmation,
          entryDescriptor,
        });
      });

      // The row that was written, echoed whole -- `entry_confirmation` and
      // `entry_descriptor` with it.
      // A LANE DEPENDS ON THAT FIELD BEING HERE: a platform that predates the
      // column answers this call exactly as successfully and hands back a
      // session without it, so the lane treats an open that does not come back
      // carrying the value it sent as not delivered, and says so. Dropping the
      // field from this response would be indistinguishable, to a lane, from
      // deploying against a platform that cannot record it.
      res.status(result.created ? 201 : 200).json({
        session: presentSession(result.session),
        created: result.created,
      });
    } catch (err) {
      if (err.code === 'EVENT_ID_VEHICLE_CONFLICT') {
        return next(conflict('event_id_reused', 'event_id already used for a different vehicle'));
      }
      next(err);
    }
  });

  /**
   * Exit. Computes the fee and freezes it, along with the rate that produced it.
   * Idempotent: closing an already-closed session returns it unchanged.
   */
  lane.post('/sessions/close', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      if (direction !== 'exit') {
        throw conflict('wrong_lane_direction', 'this device is not on an exit lane');
      }
      const { event_id: closeEventId, session_id: sessionId = null } = req.body ?? {};
      // The exit read's descriptor, on the CLOSE and on no other channel: the
      // sessions sync and the events ingest arrive in no specified order, and
      // the shadow search snapshots the open stays inside this transaction --
      // so what it compares has to be in this call. Migration 0010.
      const exitDescriptor = descriptorField(req.body?.descriptor);
      // The lane's decision at the barrier (0017), or null on a close that
      // carries none -- a lane built before it existed, or one that was
      // offline at the exit and closes from its outbox.
      const localDecision = localDecisionField(req.body?.local_decision);
      // The same rule at the other end of the stay. Without it a stay opened on
      // a ticket could never be closed: the close would upsert a vehicle from a
      // plate it does not have, find no open session, and 404 — a car that got
      // in and a stay that stays open and unbilled for ever.
      const { plate, ticketRef } = laneIdentity(req.body);
      if (!closeEventId) throw bad('event_id is required');
      const exitConfirmation = confirmation(
        req.body?.exit_confirmation,
        'exit_confirmation',
        EXIT_CONFIRMATIONS,
      );
      const exitAt = refuseFuture(parseTime(req.body?.exit_at, 'exit_at'), 'exit_at');

      // THE GATE (0014), at the other end: an inactive garage closes no stay.
      // Activation is monotonic, so a stay that exists was opened at an
      // active garage and this never fires for one -- it is here so the rule
      // is stated at both doors and not inferred from the other.
      await activeGarageOrRefuse({
        tenantId, garageId, laneId, laneEventId: String(closeEventId), action: 'close', at: exitAt,
      });

      const out = await withTenant(tenantId, async (client) => {
        // Keyed on the event first, so a replay returns the very session this
        // exact exit closed -- not "the most recent closed one", which is a
        // guess that goes wrong the moment a vehicle visits twice.
        const already = await repo.findSessionByCloseEvent(client, tenantId, String(closeEventId));
        if (already) return { session: already, closed: false, replay: true };

        const vehicle = await repo.upsertVehicle(client, tenantId, {
          plate, ticketRef, seenAt: exitAt,
        });

        // When the lane names the session, that is the session -- no guessing
        // from a plate, so a stale exit from an earlier visit can never land on
        // a later one. When it does not (it was offline at the exit), fall back
        // to the plate with the ordering guard below.
        const open = sessionId
          ? await repo.findOpenSessionById(client, tenantId, garageId, sessionId)
          : await repo.findOpenSession(client, tenantId, garageId, vehicle.id);

        if (!open) {
          throw new HttpError(
            404,
            sessionId
              ? 'the named session is not open in this garage'
              : 'no open session for this vehicle',
          );
        }
        if (sessionId && open.vehicle_id !== vehicle.id) {
          throw conflict('session_vehicle_mismatch', 'the named session belongs to a different vehicle');
        }

        if (exitAt < open.entry_at) {
          // A stale exit from an earlier visit, arriving after the vehicle has
          // come back. Closing this session with that timestamp would violate
          // sessions_exit_after_entry and surface as a 500 -- which the lane
          // classifies as RETRYABLE and would then re-send forever, jamming
          // everything behind it in its outbox. 409 is terminal: the lane
          // dead-letters it, counts it, and moves on.
          throw conflict(
            'stale_exit',
            'exit precedes the entry of the open session — stale exit from an earlier visit',
          );
        }

        // THE PRICE, from the engine and nothing else. Every plan of the
        // garage goes to it unfiltered -- the engine picks the version in
        // force at entry -- with the garage's currency and space class. What
        // comes back is frozen onto the row below and echoed from the row,
        // never recomputed for the response.
        //
        // A REFUSAL IS NOT A REFUSAL OF THE CLOSE. The barrier has opened and
        // the car is gone; a 409 here is dropped by the lane and the stay
        // stays open and unbilled for ever. So the engine's findings -- or
        // the platform's own named reason when there is no plan to ask about
        // -- close the stay UNPRICED, on the record, with an event beside it
        // for a human. An engine that cannot be reached is not that: the stay
        // can be priced, just not now, so it falls through as a 5xx, this
        // transaction rolls back, and the lane retries.
        const garage = await repo.getGarage(client, tenantId, garageId);

        // THE ENTITLEMENT QUESTION, BEFORE PRICING (0015): the pass module and
        // the monthly module, each through its own door, each linked one
        // always, and the record of what they said goes on the row whichever
        // way it went. Covered means no transient fee; not covered means the
        // stay prices like any other, with the modules' named reasons kept.
        // A module that could not decide is not a not-covered: it falls
        // through as a 5xx like an unreachable engine, and the lane retries.
        // THE LANE'S DECISION FIRST (0017). One computation feeds the screen,
        // the card and the row: a close that carries a decision the platform
        // can consume WRITES THAT DECISION'S NUMBERS and neither consults nor
        // prices again. What it decided from goes beside the fee, and the
        // reconciler re-derives the number from it out of band.
        let plans = ratePlans.documents(await ratePlans.ratePlansForGarage(client, tenantId, garageId));
        const consumable = consumableDecision(localDecision, {
          open, garage, planVersions: plans.map((p) => p.plan_version),
        });
        const identity = vehicle.plate ?? vehicle.ticket_ref;
        let asked;
        let pricing;
        let decidedBy = 'platform';
        let decisionInputs = null;
        if (consumable.consume) {
          decidedBy = 'lane';
          const coveredBy = localDecision.status === 'covered' ? localDecision.covered_by : [];
          asked = {
            outcome: coveredBy.length ? entitlement.EXIT_OUTCOMES.COVERED : entitlement.EXIT_OUTCOMES.TRANSIENT,
            covered_by: coveredBy,
            record: {
              identity,
              asked_at: exitAt.toISOString(),
              decided_by: 'lane',
              local_decision: localDecision,
              covered_by: coveredBy,
            },
          };
          pricing = coveredBy.length
            ? { outcome: entitlement.EXIT_OUTCOMES.COVERED }
            : {
                outcome: entitlement.EXIT_OUTCOMES.TRANSIENT,
                feeMinor: assertMinor(localDecision.fee_minor, 'local_decision.fee_minor'),
                planVersion: localDecision.plan_version,
                breakdown: localDecision.breakdown,
                spaceClass: localDecision.space_class,
              };
          decisionInputs = {
            status: localDecision.status,
            entry_at: localDecision.entry_at ?? open.entry_at.toISOString(),
            exit_at: localDecision.exit_at ?? exitAt.toISOString(),
            space_class: localDecision.space_class ?? garage.space_class,
            plan_version: localDecision.plan_version ?? null,
            currency: localDecision.currency ?? open.currency,
            fee_minor: localDecision.fee_minor ?? null,
            session_id: localDecision.session_id ?? open.id,
            synced_at: localDecision.computed_from,
          };
        } else {
          // TODAY'S PATH, EXACTLY: the entitlement question through both
          // doors (0015), then the engine (0013) -- and, when a decision was
          // carried and not taken, the decision and the reason kept on the
          // record for the reconciler, never dropped.
          asked = await entitlement.consult({
            garage,
            identity,
            laneId,
            entryAt: open.entry_at,
            exitAt,
          });
          if (localDecision !== null) {
            asked.record.local_decision_ignored = { reason: consumable.reason, local_decision: localDecision };
          }
          if (asked.outcome === entitlement.EXIT_OUTCOMES.COVERED) {
            pricing = { outcome: entitlement.EXIT_OUTCOMES.COVERED };
            plans = [];
          } else {
            pricing = { outcome: entitlement.EXIT_OUTCOMES.TRANSIENT, ...(await priceStay({ garage, plans, session: open, exitAt })) };
          }
        }

        // THE SHADOW SNAPSHOT, HERE AND NOWHERE ELSE: after the stay to close
        // is known, BEFORE `exit_at` is written on it, in this transaction.
        // Taken after the UPDATE below, the true stay is already closed and
        // every plate-matched exit reads as "absent true car". Ids and counts
        // only (the measurement is in migration 0011); nothing is decided by
        // it, and a close that carried no descriptor snapshots nothing.
        if (exitDescriptor !== null) {
          await enqueueShadowSearch(client, tenantId, {
            garageId,
            sessionId: open.id,
            exitLaneId: laneId,
            closeEventId: String(closeEventId),
          });
        }

        const closed = await repo.closeSession(client, tenantId, open.id, {
          exitAt,
          laneId,
          closeEventId: String(closeEventId),
          exitConfirmation,
          exitDescriptor,
          pricing,
          entitlement: asked.record,
          decidedBy,
          decisionInputs,
        });
        if (pricing.outcome === entitlement.EXIT_OUTCOMES.COVERED) {
          // The record: a stay that leaves with no transient fee, and who
          // said it could. Money not charged is a decision as much as money
          // charged, and it is written where it cannot be edited.
          await repo.appendEvents(client, tenantId, [
            {
              garageId,
              laneId,
              eventId: `exit_covered:${closed.id}`,
              kind: entitlement.EXIT_COVERED_EVENT_KIND,
              occurredAt: exitAt,
              detail: {
                actor: decidedBy === 'lane' ? 'lane:decision' : 'platform:close',
                decided_by: decidedBy,
                session_id: closed.id,
                close_event_id: String(closeEventId),
                entry_at: closed.entry_at,
                exit_at: closed.exit_at,
                covered_by: asked.covered_by,
                pass_id: asked.record.garage_pass?.answer?.pass_id
                  ?? localDecision?.matched?.find((m) => m.pass)?.pass ?? null,
                agreement: asked.record.monthly_billing?.answer?.lines?.find((l) => l.includes('under agreement'))?.trim() ?? null,
              },
            },
          ]);
        }
        if (pricing.refusal) {
          // The record: what was refused and why, named -- not a null fee.
          // Append-only, beside the row, the thing a human works from.
          await repo.appendEvents(client, tenantId, [
            {
              garageId,
              laneId,
              eventId: `close_unpriced:${closed.id}`,
              kind: CLOSE_UNPRICED_EVENT_KIND,
              occurredAt: exitAt,
              detail: {
                actor: 'platform:close',
                session_id: closed.id,
                close_event_id: String(closeEventId),
                entry_at: closed.entry_at,
                exit_at: closed.exit_at,
                currency: closed.currency,
                space_class: garage.space_class,
                plan_versions_offered: plans.map((p) => p.plan_version),
                findings: pricing.refusal,
              },
            },
          ]);
        }
        return { session: closed, closed: true, replay: false };
      });

      // The row as written, `exit_descriptor` with it -- echoed for the reason
      // `entry_descriptor` is on the open, and a replay echoes what the close
      // that actually closed the stay stored.
      res.status(200).json({ session: presentSession(out.session), closed: out.closed, replay: out.replay });
    } catch (err) {
      next(err);
    }
  });

  // Order matters and is load-bearing. '/api/v1' is a prefix of '/api/v1/lane',
  // so the operator router must be mounted AFTER the lane router. Mounted first
  // it answers every lane request 401 before the device router runs. The test
  // 'a lane call with no token is refused BY THE LANE ROUTER' asserts the
  // message, not just the status, because both orderings return 401.
  app.use('/api/v1/lane', lane);
  app.use('/api/v1', operator);

  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error('[api]', err);
    if (status >= 500) return res.status(status).json({ error: 'internal error' });
    // `code` is published only for an error THIS FILE raised. A driver error
    // carries a `code` of its own -- a Postgres SQLSTATE -- and it has no
    // `status`, so it becomes a 500 above and never reaches here. The instance
    // check is the second control on that: nothing that is not ours can put a
    // name on the wire.
    const named = err instanceof HttpError && err.code;
    if (!named) return res.status(status).json({ error: err.message });
    res
      .status(status)
      .json(err.details ? { error: err.message, code: err.code, details: err.details } : { error: err.message, code: err.code });
  });

  return app;
}

/** Money leaves the database as a string; it leaves the API as a number. */
function presentSession(s) {
  return {
    ...s,
    hourly_minor_applied: toMinor(s.hourly_minor_applied, 'hourly_minor_applied'),
    fee_minor: toMinor(s.fee_minor, 'fee_minor'),
  };
}

/** A stored plan: the document whole, and what the store knows about it. */
function presentRatePlan(r) {
  return {
    id: r.id,
    garage_id: r.garage_id,
    plan_version: r.plan_version,
    effective_from: r.effective_from,
    engine_schema_version: r.engine_schema_version,
    created_at: r.created_at,
    plan: r.document,
  };
}

/** The event a close that could not be priced leaves beside the row. */
const CLOSE_UNPRICED_EVENT_KIND = 'close_unpriced';

/**
 * Price a stay, or say by name why it cannot be priced. Never both, never
 * neither.
 *
 * `{ refusal }` carries the engine's findings, verbatim -- the engine's word
 * is the only refusal this platform records. It used to add one of its own,
 * a garage with no plan stored; the activation gate (0014) made that
 * unreachable through every door and the database alike -- a garage cannot
 * activate without a plan in force, plans are append-only, and an inactive
 * garage closes nothing -- and a refusal nobody can reach is a sentence, not
 * a behaviour. So an active garage with no plan is not a refusal to record:
 * it is a broken invariant, and it fails loudly. `EngineUnavailable` is
 * deliberately NOT caught here either -- see the close route.
 */
async function priceStay({ garage, plans, session, exitAt }) {
  if (plans.length === 0) {
    throw new Error(
      `garage ${garage.id} is active and holds no rate plan; activation requires one and plans are append-only`,
    );
  }
  try {
    const quote = await ratePlans.quoteWithEngine({
      plans,
      currency: garage.currency,
      spaceClass: garage.space_class,
      entryAt: session.entry_at,
      exitAt,
    });
    if (quote.currency !== session.currency) {
      // Cannot happen -- the store refuses a plan in another currency -- and
      // if it does, this is not a stay to record as priced in the wrong money.
      throw new Error(`the engine priced in ${quote.currency}; the stay is in ${session.currency}`);
    }
    return {
      feeMinor: assertMinor(quote.feeMinor, 'fee_minor'),
      planVersion: quote.planVersion,
      breakdown: quote.breakdown,
      spaceClass: garage.space_class,
    };
  } catch (err) {
    if (err instanceof ratePlans.PricingRefused) return { refusal: err.findings };
    throw err;
  }
}

/**
 * The lane's side of the activation gate. Loads the garage; an inactive one
 * is RECORDED (its own transaction, committed before anything is refused)
 * and then refused by name. Returns the garage for the caller's use.
 */
async function activeGarageOrRefuse({ tenantId, garageId, laneId, laneEventId, action, at }) {
  const garage = await withTenant(tenantId, (client) => repo.getGarage(client, tenantId, garageId));
  if (!garage) throw new HttpError(404, 'garage not found');
  if (garage.activated_at !== null) return garage;
  await withTenant(tenantId, (client) =>
    activation.recordInactiveRefusal(client, tenantId, { garageId, laneId, laneEventId, action, at }),
  );
  throw conflict(
    'garage_not_active',
    `this garage is not active: no stay is ${action === 'open' ? 'opened' : 'closed'} here until its rate setup is complete and its transient mode is stated`,
  );
}

/** A link from a request body, through the one place its shape is written. */
function linkField(raw, name) {
  try {
    return entitlement.linkField(raw, name);
  } catch (err) {
    throw bad(err.message);
  }
}

/** `transient_available` from a request body, through the one place its shape is written. */
function transientField(raw, { required }) {
  try {
    return activation.transientAvailableField(raw, { required });
  } catch (err) {
    throw bad(err.message);
  }
}

/**
 * The garage's space class, when the request names one. Frozen after
 * creation; the shape rule is the column's (`garages_space_class_not_blank`)
 * said here so the operator is told, not the driver.
 */
function spaceClassField(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 64) {
    throw bad('space_class must be a non-empty string of at most 64 characters when given');
  }
  return raw;
}

/**
 * The store's refusals onto the wire. `plan_invalid` is a 400 -- the request
 * carried a document the engine cannot load, and a 400 carries no code, like
 * every other malformed body here. Everything else the store refuses is a
 * named conflict: the document is well-formed and this platform will not hold
 * it, and says why by name. An engine that cannot be reached is a conflict
 * too, not a 5xx -- nothing was stored, the operator is told so by name, and
 * a 5xx here would be answered 'internal error' with the name stripped.
 */
function ratePlanRefusal(err) {
  if (!(err instanceof ratePlans.RatePlanRefused)) return err;
  if (err.code === 'plan_invalid') return bad(err.message);
  const out = conflict(err.code, err.message);
  out.details = err.details;
  return out;
}

export { pool, LANE_EVENT_KINDS, CLOSE_UNPRICED_EVENT_KIND };

/**
 * A window the caller asked for, bounded.
 *
 * Unbounded, `?hours=1000000` is a full table scan somebody can ask for from
 * outside. Rejecting it outright would be unhelpful for a caller who simply
 * wants "everything"; clamping gives them the most this will do and says so by
 * echoing the value back in the report.
 */
function clampWindow(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), 24 * 90);
}

/**
 * A window the caller must state, because nothing here can produce it.
 *
 * `max_stay_hours` had a typed default of 48. Nothing measured that number and
 * no command emits it, yet it decided which open sessions an operator was
 * shown -- a garage worked for six hours reads as clean under it. There is no
 * honest replacement, so there is no default: the caller says how long is too
 * long for the garage they are asking about, or is told which parameter is
 * missing. The clamp stays where it is, in one place.
 */
function statedWindow(raw, label) {
  const value = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(value) || value <= 0) {
    throw bad(
      `${label} is required and must be a positive number of hours; this report has no default`,
    );
  }
  return clampWindow(raw, null);
}
