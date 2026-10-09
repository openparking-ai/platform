import express from 'express';
import { randomUUID } from 'node:crypto';
import { pool, withTenant } from './db.js';
import { bearerFrom, generateDeviceToken, hashToken } from './auth.js';
import { assertMinor, toMinor } from './money.js';
import * as repo from './repository.js';
import { enqueueShadowSearch } from './shadow.js';
import * as ratePlans from './ratePlans.js';
import * as activation from './activation.js';
import * as taxes from './taxes.js';
import * as entitlement from './entitlement.js';
import * as validations from './validations.js';
import { reconcile } from './reconcile.js';
import * as stripeAccount from './stripeAccount.js';
import * as terminal from './terminal.js';
import * as signIn from './signIn.js';
import { startSetting } from './startSettings.js';
import { HttpError } from './errors.js';
import * as changes from './changes.js';
import * as lanes from './lanes.js';
import * as board from './board.js';
import { SCREEN_CHARACTERS } from './screenText.js';
import { MESSAGE_MAX } from './lanes.js';
import * as setup from './setup.js';
import * as alerts from './alerts.js';

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

/** The one refusal of a validation claimed on a stay that is not open -- or that never was. */
const STAY_NOT_OPEN = 'the stay is not open in this garage: a validation is claimed before the close, never after';

/**
 * AN ID THAT IS NOT AN ID. Every path parameter is a uuid, and one that is not
 * is answered here -- before the handler reads the body, and before anything
 * reaches the database, where it was a 500 -- exactly as that route answers an
 * id that names nothing. `test/ids.test.js` walks both routers and requires
 * every parameter to be one of these.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
//: The Connect routes (0020, 0021) name their not-found with a code; the rest do not.
const CONNECT_ROUTE = /\/stripe-account|\/readers?(\/|$)/;
export const ID_PARAMS = Object.freeze({
  operator: Object.freeze({
    garageId: (route) => (CONNECT_ROUTE.test(route) ? new HttpError(404, 'garage not found', 'garage_not_found') : new HttpError(404, 'garage not found')),
    laneId: (route) => (CONNECT_ROUTE.test(route) ? new HttpError(404, 'lane not found', 'lane_not_found') : new HttpError(404, 'lane not found')),
    deviceId: () => new HttpError(404, 'device not found'),
    tokenId: () => new HttpError(404, 'operator token not found'),
    changeId: () => new HttpError(404, 'change not found'),
    contactId: () => new HttpError(404, 'alert contact not found', 'alert_contact_not_found'),
    messageId: () => new HttpError(404, 'board message not found', 'board_message_not_found'),
  }),
  lane: Object.freeze({
    sessionId: () => conflict('stay_not_open', STAY_NOT_OPEN),
  }),
});
function checkIds(router, params) {
  for (const [name, notFound] of Object.entries(params)) {
    // Marked, so the change log does not take a malformed id to the
    // database either (src/changes.js): it names nothing, and it never
    // reaches the database at all.
    router.param(name, (req, _res, next, value) => next(UUID.test(value) ? undefined : Object.assign(notFound(req.route.path), { malformedId: true })));
  }
}

//: A body that cannot be read: one sentence per case, never the parser's text.
export const BODY_UNREADABLE = Object.freeze({ error: 'The request body could not be read. Send JSON.', code: 'body_unreadable' });
export const BODY_TOO_LARGE = Object.freeze({ error: 'The request body is too large.', code: 'body_too_large' });

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

/** An ISO 8601 instant with an offset, to the microsecond: what is handed to `timestamptz` as an instant. */
const INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

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
 * 0009 says why it lives on the session. What this side CAN
 * stand behind is that it is a string, that it is not blank, and that it is not
 * a device token's worth of text: it is stored per stay and compared against
 * every open stay in a garage at the exit, so an unbounded one is a row an
 * attacker chooses the size of.
 *
 * The bound is a DECISION: sixty-four KiB is more than twice the longest
 * descriptor the identity service produces, with room for the descriptor's
 * own version to grow.
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

const PHONE_MAX = 32;

/**
 * The driver's phone number, entered at the reader (0019, amendment A1): the
 * one value on any lane request this platform must never keep. It is read
 * here, handed to the validations door on stdin (`validations.claimAtReader`),
 * and dropped -- no column, no event, no log line holds it. So a refusal below
 * names the field and never the value: an error message is the one place a
 * value can leave by accident.
 *
 * It must be a string of digits and the punctuation people type in a number;
 * whether it IS a number the module can match is the module's question, and a
 * number it cannot read is a not-validated answer, not a refusal.
 */
function phoneField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[0-9 +().-]+$/.test(value) || value.length > PHONE_MAX || !/[0-9]/.test(value)) {
    throw bad(`phone must be a string of at most ${PHONE_MAX} characters of digits, spaces and + ( ) . -`);
  }
  return value;
}

/**
 * What the reader actually showed the driver (amendment A2.2), carried on the
 * close: `{fee_minor, currency}`, or null when the close says nothing about
 * the reader. The close records a held validation only when this is the
 * discounted fee; anything else gives the hold back.
 */
function readerShownField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw bad('reader_shown must be an object: {fee_minor, currency}, what the reader showed');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'fee_minor' && key !== 'currency') throw bad(`reader_shown has an unknown field ${JSON.stringify(key)}`);
  }
  if (!Number.isInteger(value.fee_minor) || value.fee_minor < 0) throw bad('reader_shown.fee_minor must be a whole number of minor units');
  if (typeof value.currency !== 'string' || value.currency === '') throw bad('reader_shown.currency must be a non-empty string');
  return { fee_minor: value.fee_minor, currency: value.currency };
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
    // TAX ON THE STAY (0023). Absent on a lane older than it -- and then the
    // decision is not consumed (`consumableDecision`), never refused here: an
    // old lane's close must still close. Present, each is shaped.
    if (value.subtotal_minor !== undefined && (!Number.isInteger(value.subtotal_minor) || value.subtotal_minor < 0)) {
      throw bad('local_decision.subtotal_minor must be a whole number of minor units: the fee before tax');
    }
    if (value.tax_sets_held !== undefined) {
      const held = value.tax_sets_held;
      if (typeof held !== 'object' || held === null || Array.isArray(held)
          || !Number.isInteger(held.count) || held.count < 0
          || !(held.newest_effective_from === null || (typeof held.newest_effective_from === 'string' && INSTANT_SHAPE.test(held.newest_effective_from)))) {
        throw bad('local_decision.tax_sets_held must be {count, newest_effective_from}: how many tax sets the lane held, and the latest instant among them');
      }
    }
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
 * space class, on a plan version this garage holds -- and, since 0023, carrying
 * a pre-tax subtotal that adds up with its tax lines to its fee, taxed with
 * the garage's current list of sets. Everything else is said by name and the
 * close prices for itself: the lane could not decide
 * (`no_cached_entry`, `stale_facts`, the engine's refusals -- brief 4.5),
 * or it decided about a different stay or with different money, which is
 * the one case a lane's word is not taken and the record keeps the word.
 *
 * Returns `{ consume: true }` or `{ consume: false, reason }`. Never throws:
 * a mismatch is a STATED RECONCILE on the record, never a 5xx the lane would
 * retry for ever and never a 4xx that leaves the stay open.
 */
function consumableDecision(decision, { open, garage, planVersions, taxFacts }) {
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
  // TAX ON THE STAY (0023). A lane older than it wrote an untaxed fee; the
  // close prices for itself rather than write that number onto the row.
  if (decision.subtotal_minor === undefined || decision.tax_sets_held === undefined) {
    return { consume: false, reason: 'the decision carries no pre-tax subtotal or tax facts: the lane that made it is older than tax on the stay' };
  }
  if (decision.subtotal_minor + taxes.taxDelta(decision.breakdown) !== decision.fee_minor) {
    return {
      consume: false,
      reason: `the decision's subtotal ${decision.subtotal_minor} and its tax lines do not add up to its fee ${decision.fee_minor}`,
    };
  }
  // A STALE TAX SET, refused as a stale plan version is. Two tests on two
  // premises, and neither is redundant: COUNT rests on the table being
  // append-only (0022 grants no UPDATE and no DELETE), so a lane that missed
  // any set -- a backdated one included -- holds fewer; WINDOW rests on the
  // lane's copy being the whole list, so a set later than the newest it held
  // and in force by the exit is one it could not have used. Neither copies the
  // engine's choice of set. COUNT also refuses a decision that was fine (only
  // a future set was added): the close then prices for itself, the safe way
  // to be wrong, until the lane's next refresh.
  if (!INSTANT_SHAPE.test(decision.exit_at) || taxFacts === null) {
    return { consume: false, reason: `the decision's exit_at ${JSON.stringify(decision.exit_at)} is not an instant a tax set can be chosen by` };
  }
  const held = decision.tax_sets_held;
  if (taxFacts.stated > held.count) {
    return {
      consume: false,
      reason: `the lane held ${held.count} tax set(s) and the garage has stated ${taxFacts.stated}: a set stated since the lane's last refresh may be the one in force`,
    };
  }
  if (taxFacts.in_window > 0) {
    return {
      consume: false,
      reason: `a tax set taking effect after the newest the lane held (${held.newest_effective_from}) and by the decision's exit (${decision.exit_at}) is in force: the lane taxed with an older one`,
    };
  }
  return { consume: true };
}

/**
 * What `consumableDecision` judges a priced decision's tax facts against, read
 * beside the open stay -- or null when the decision carries none it could be
 * judged by (it is then not consumed, and says why).
 */
async function taxFactsForDecision(client, tenantId, garageId, decision) {
  if (decision?.status !== 'priced' || decision.tax_sets_held === undefined || !INSTANT_SHAPE.test(decision.exit_at)) return null;
  return taxes.taxFactsFor(client, tenantId, garageId, { newest: decision.tax_sets_held.newest_effective_from, at: decision.exit_at });
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

// Checked before the port opens (src/startSettings.js): a whole number of
// seconds, 0 to 3600.
const MAX_CLOCK_SKEW_SECONDS = startSetting('MAX_CLOCK_SKEW_SECONDS');

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
  const authSettings = signIn.readAuthSettings();
  if (authSettings.trustProxy !== null) app.set('trust proxy', authSettings.trustProxy);

  // FIRST, before the app-wide body parser and before the operator router.
  // The operator router answers 401 to everything under /api/v1, so mounted
  // after it sign-in is unreachable; and the auth routes read their own body,
  // so a body that cannot be parsed is answered with their one sentence and
  // never with the parser's text, which quotes what was sent.
  app.use('/api/v1/auth', signIn.createAuthRouter(authSettings));

  // Any failure to read a body is marked as one, so it is answered in one
  // fixed sentence (below), whatever the path.
  const json = express.json({ limit: '1mb' });
  app.use((req, res, next) => json(req, res, (err) => next(err ? Object.assign(err, { bodyUnreadable: true }) : undefined)));

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
   *
   * OR the owner's session cookie (0024): a Bearer KEY is read first and is
   * unchanged; with none, the cookie. A request authenticated by the cookie
   * that changes something must carry an Origin equal to ADMIN_ORIGIN, checked
   * BEFORE the session is looked up, so a refused cross-site request does not
   * even keep a session alive. An ended session answers 401 `session_ended`.
   * A session token presented as a Bearer key is not a key and is refused.
   */
  operator.use(signIn.noStore);
  checkIds(operator, ID_PARAMS.operator);
  operator.use(async (req, res, next) => {
    try {
      const token = bearerFrom(req.get('authorization'));
      if (token) {
        // What came with the request, kept for the change log's refusal line
        // (src/changes.js), which sends only its hash to the database.
        req.credential = { kind: 'key', token };
        const { rows } = await pool.query('SELECT * FROM resolve_operator_token($1)', [hashToken(token)]);
        if (rows.length === 0) throw new HttpError(401, 'unknown or revoked operator token');
        req.tenantId = rows[0].tenant_id;
        req.operatorTokenId = rows[0].token_id;
        req.actor = { kind: 'key', id: rows[0].token_id };
        req.change = changes.context(req, [token]);
        pool.query('SELECT touch_operator_token($1)', [req.operatorTokenId]).catch(() => {});
        return next();
      }
      const session = signIn.sessionToken(req);
      req.credential = session ? { kind: 'session', token: session } : { kind: 'none', token: null };
      if (session === null) throw new HttpError(401, 'operator token required');
      if (!signIn.originAllows(req, authSettings)) {
        throw new HttpError(403, signIn.ORIGIN_REFUSED.error, signIn.ORIGIN_REFUSED.code);
      }
      const found = await signIn.resolveSession(session, authSettings);
      if (!found) {
        signIn.clearCookie(res, authSettings);
        throw new HttpError(401, signIn.SESSION_ENDED.error, signIn.SESSION_ENDED.code);
      }
      req.tenantId = found.tenant_id;
      req.operatorTokenId = found.token_id;
      req.actor = { kind: 'owner', id: found.user_id, name: found.email };
      req.change = changes.context(req, [session]);
      next();
    } catch (err) {
      next(err);
    }
  });

  /**
   * A write in one transaction with its change-log line (src/changes.js): `fn`
   * makes the change and records its line on the same client, and a request
   * that recorded no line, or more than one, rolls back. A change without its
   * line cannot commit. The one request with no line is one `record` found
   * changed nothing (the same before and after): it writes no line at all.
   */
  const changeTx = (req, fn) =>
    withTenant(req.tenantId, async (client) => {
      const before = req.change.count;
      const out = await fn(client);
      const lines = req.change.count - before;
      if (lines !== 1 && !(lines === 0 && req.change.unchanged)) {
        throw new Error(`a write recorded ${lines} change-log lines, not one`);
      }
      return out;
    });

  /**
   * A write whose change ran in a module's own transactions (the payment
   * account and card readers, which ask Stripe between them): the module
   * records the line in the transaction that changed something. When nothing
   * changed -- asked again, answered with what was there -- there is no line.
   */
  const recorder = (req) => (client, line) => changes.record(client, req.change, line);

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
      const garage = await changeTx(req, async (client) => {
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
        const created = rows[0];
        await changes.record(client, req.change, {
          garageId: created.id,
          action: 'garage.create',
          subject: { kind: 'garage', id: created.id, name: created.name },
          before: null,
          after: {
            name: created.name, timezone: created.timezone, currency: created.currency,
            default_action: created.default_action, space_class: created.space_class,
            transient_available: created.transient_available,
          },
        });
        return created;
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
  /**
   * THE THREE READS THE OWNER'S SCREENS NEED (U2a): the tenant's garages, one
   * garage, and its lanes with their devices and reader. Tenant from the
   * session or key, as every operator route; another tenant's garage is NOT
   * FOUND. Reads only: nothing here writes.
   */
  operator.get('/garages', async (req, res, next) => {
    try {
      const rows = await withTenant(req.tenantId, (client) => repo.garagesForTenant(client, req.tenantId));
      res.json({ garages: rows.map(repo.presentGarage) });
    } catch (err) {
      next(err);
    }
  });

  operator.get('/garages/:garageId', async (req, res, next) => {
    try {
      const garage = await withTenant(req.tenantId, (client) => repo.getGarage(client, req.tenantId, req.params.garageId));
      if (!garage) throw new HttpError(404, 'garage not found');
      res.json({ garage: repo.presentGarage(garage) });
    } catch (err) {
      next(err);
    }
  });

  operator.get('/garages/:garageId/lanes', async (req, res, next) => {
    try {
      const lanes = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        return repo.lanesForGarage(client, req.tenantId, req.params.garageId);
      });
      // The one setting that says when a lane computer counts as not heard
      // from (src/setup.js), served so the screens read it and keep no copy.
      // What a lane's screen can draw, so the owner's screens can say, as
      // the owner types, which characters a message cannot have (U4c, rule 7).
      res.json({ lanes, quiet_minutes: setup.quietMinutes(), screen: { characters: SCREEN_CHARACTERS, message_max: MESSAGE_MAX } });
    } catch (err) {
      next(err);
    }
  });

  operator.patch('/garages/:garageId', async (req, res, next) => {
    try {
      const action = defaultAction(req.body?.default_action, { required: false });
      const transient = transientField(req.body?.transient_available, { required: false });
      if (action === undefined && transient === undefined) {
        throw bad('default_action or transient_available is required');
      }
      const garage = await changeTx(req, async (client) => {
        // Read first, locked: the line says what each field was.
        const { rows: was } = await client.query(
          'SELECT * FROM garages WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
          [req.tenantId, req.params.garageId],
        );
        if (!was[0]) throw new HttpError(404, 'garage not found');
        const sets = [];
        const values = [req.tenantId, req.params.garageId];
        if (action !== undefined) { values.push(action); sets.push(`default_action = $${values.length}`); }
        if (transient !== undefined) { values.push(transient); sets.push(`transient_available = $${values.length}`); }
        const { rows } = await client.query(
          `UPDATE garages SET ${sets.join(', ')}
            WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          values,
        );
        const fields = [...(action !== undefined ? ['default_action'] : []), ...(transient !== undefined ? ['transient_available'] : [])];
        await changes.record(client, req.change, {
          garageId: rows[0].id,
          action: 'garage.update',
          subject: { kind: 'garage', id: rows[0].id, name: rows[0].name },
          before: Object.fromEntries(fields.map((f) => [f, was[0][f]])),
          after: Object.fromEntries(fields.map((f) => [f, rows[0][f]])),
        });
        return rows[0];
      });
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
      const out = await changeTx(req, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        const done = await activation.activate(client, req.tenantId, garage, {
          actor: `operator_token:${req.operatorTokenId}`,
        });
        await changes.record(client, req.change, {
          garageId: garage.id,
          action: 'garage.open',
          subject: { kind: 'garage', id: garage.id, name: garage.name },
          before: { open: garage.activated_at !== null },
          after: { open: true },
        });
        return done;
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
      const garage = await changeTx(req, async (client) => {
        const current = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!current) throw new HttpError(404, 'garage not found');
        const stated = await entitlement.stateLinks(client, req.tenantId, current, links, {
          actor: `operator_token:${req.operatorTokenId}`,
        });
        await changes.record(client, req.change, {
          garageId: current.id,
          action: 'garage.pass_links',
          subject: { kind: 'garage', id: current.id, name: current.name },
          before: linksOf(current, Object.keys(entitlement.MODULES)),
          after: linksOf(stated, Object.keys(entitlement.MODULES)),
        });
        return stated;
      });
      res.json({ garage });
    } catch (err) {
      if (err instanceof entitlement.LinkUnanswerable) {
        return next(conflict('entitlement_link_unanswerable', err.message));
      }
      next(err);
    }
  });

  /**
   * State which garage of a validations module this garage is, under which
   * of its tenants (`{tenant_id, garage_id}`), or that it links none (null).
   * PROBED before it is stored: the module must answer a read about that
   * garage, and a link it cannot answer is refused by name. Recorded with
   * what changed. The module itself is the operator's; this platform only
   * asks it (0019). A deployment that names no validations door
   * (`VALIDATIONS_DOOR` unset) refuses a link by name, 409
   * `validations_not_configured`, and runs nothing; unlinking needs no door.
   */
  operator.put('/garages/:garageId/validations-link', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      for (const key of Object.keys(body)) {
        if (key !== 'validations') throw bad(`unknown field ${JSON.stringify(key)}; the body is {validations}`);
      }
      if (!('validations' in body)) throw bad('validations is required: null (not linked) or {tenant_id, garage_id}');
      const link = linkField(body.validations, 'validations');
      const garage = await changeTx(req, async (client) => {
        const current = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!current) throw new HttpError(404, 'garage not found');
        const stated = await validations.stateLink(client, req.tenantId, current, link, {
          actor: `operator_token:${req.operatorTokenId}`,
        });
        await changes.record(client, req.change, {
          garageId: current.id,
          action: 'garage.validations_link',
          subject: { kind: 'garage', id: current.id, name: current.name },
          before: linksOf(current, ['validations']),
          after: linksOf(stated, ['validations']),
        });
        return stated;
      });
      res.json({ garage });
    } catch (err) {
      if (err instanceof validations.ValidationsNotConfigured) {
        return next(conflict('validations_not_configured', err.message));
      }
      if (err instanceof validations.LinkUnanswerable) {
        return next(conflict('validations_link_unanswerable', err.message));
      }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // The garage's own Stripe account (0020). Four routes, each only on the
  // operator's request. A deployment with no Connect configured answers each
  // with one sentence saying so, and every other route is unaffected.
  // -------------------------------------------------------------------------
  const connectRoute = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      const refusal = stripeAccount.stripeRefusal(err);
      next(refusal ? new HttpError(refusal.status, refusal.message, refusal.code) : err);
    }
  };

  /** Create the garage's account, or answer the one it has. Never a second. Body: {country}. */
  operator.post('/garages/:garageId/stripe-account', connectRoute(async (req, res) => {
    const { account, created } = await stripeAccount.createAccount(req.tenantId, req.params.garageId, {
      actor: `operator_token:${req.operatorTokenId}`,
      country: req.body?.country,
      record: recorder(req),
    });
    res.status(created ? 201 : 200).json({ stripe_account: stripeAccount.presentAccount(account) });
  }));

  /** What this platform last read, without asking Stripe. */
  operator.get('/garages/:garageId/stripe-account', connectRoute(async (req, res) => {
    const row = await stripeAccount.getAccount(req.tenantId, req.params.garageId);
    res.json({ stripe_account: stripeAccount.presentAccount(row) });
  }));

  /** Stripe's onboarding link, for the operator to open. */
  operator.post('/garages/:garageId/stripe-account/onboarding-link', connectRoute(async (req, res) => {
    const link = await stripeAccount.onboardingLink(req.tenantId, req.params.garageId);
    // Nothing of this platform's is changed: Stripe made a link. So no line.
    res.status(201).json({ onboarding_link: link });
  }));

  /** Ask Stripe now, and keep the answer with when it was read. */
  operator.post('/garages/:garageId/stripe-account/refresh', connectRoute(async (req, res) => {
    const row = await stripeAccount.refreshAccount(req.tenantId, req.params.garageId, {
      actor: `operator_token:${req.operatorTokenId}`,
      record: recorder(req),
    });
    res.json({ stripe_account: stripeAccount.presentAccount(row) });
  }));

  /**
   * The garage's Location, on its own account: where its readers are grouped.
   * Refused while the account cannot take a card.
   */
  operator.post('/garages/:garageId/stripe-account/location', connectRoute(async (req, res) => {
    const { location, created } = await terminal.createLocation(req.tenantId, req.params.garageId, req.body ?? {}, {
      actor: `operator_token:${req.operatorTokenId}`,
      record: recorder(req),
    });
    res.status(created ? 201 : 200).json({ location: terminal.presentLocation(location) });
  }));

  /** The garage's Location as this platform recorded it, or null. Asks Stripe nothing. */
  operator.get('/garages/:garageId/stripe-account/location', connectRoute(async (req, res) => {
    const row = await terminal.readLocation(req.tenantId, req.params.garageId);
    res.json({ location: terminal.presentLocation(row) });
  }));

  /** Every reader binding the garage's lanes have had, current ones first. */
  operator.get('/garages/:garageId/readers', connectRoute(async (req, res) => {
    const rows = await terminal.listReaders(req.tenantId, req.params.garageId);
    res.json({ readers: rows.map(terminal.presentReader) });
  }));

  /** Register a reader on the garage's account and bind it to this lane. */
  operator.post('/lanes/:laneId/reader', connectRoute(async (req, res) => {
    const row = await terminal.bindReader(req.tenantId, req.params.laneId, req.body ?? {}, {
      actor: `operator_token:${req.operatorTokenId}`,
      record: recorder(req),
    });
    res.status(201).json({ reader: terminal.presentReader(row) });
  }));

  /** End the lane's binding. Recorded; the binding's row stays. */
  operator.post('/lanes/:laneId/reader/unbind', connectRoute(async (req, res) => {
    const row = await terminal.unbindReader(req.tenantId, req.params.laneId, {
      actor: `operator_token:${req.operatorTokenId}`,
      record: recorder(req),
    });
    res.json({ reader: terminal.presentReader(row) });
  }));

  operator.post('/garages/:garageId/lanes', async (req, res, next) => {
    try {
      const { name, direction } = req.body ?? {};
      if (!name || !['entry', 'exit'].includes(direction)) {
        throw bad("name and direction ('entry' or 'exit') are required");
      }
      const lane = await changeTx(req, async (client) => {
        // Asked first: a garage that is not there is a 404, not a foreign-key violation.
        if (!(await repo.getGarage(client, req.tenantId, req.params.garageId))) throw new HttpError(404, 'garage not found');
        const { rows } = await client.query(
          `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING *`,
          [req.tenantId, req.params.garageId, name, direction],
        );
        await changes.record(client, req.change, {
          garageId: rows[0].garage_id, action: 'lane.add',
          subject: { kind: 'lane', id: rows[0].id, name: rows[0].name },
          before: null, after: { name: rows[0].name, direction: rows[0].direction },
        });
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
   * and nothing writes it any more. Always refused, so its one change-log
   * line is the refused-attempt line (src/changes.js).
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
        // The plan's name and when it takes effect: the document itself stays
        // where it is kept, and the line points at it.
        await changes.record(client, req.change, {
          garageId: garage.id, action: 'rate_plan.add',
          subject: { kind: 'rate_plan', id: row.id, name: row.plan_version },
          before: null, after: { plan_version: row.plan_version, effective_from: row.effective_from },
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
      // The code is never part of the change log: the line names the computer
      // and its lane, and `record` refuses any line that holds the code.
      req.change.secrets.push(token);
      const device = await changeTx(req, async (client) => {
        // Asked first, and held: a lane that is not there -- or is being
        // removed at this moment -- is a 404, not a foreign-key violation.
        const lane = await client.query('SELECT garage_id, name FROM lanes WHERE tenant_id = $1 AND id = $2 FOR KEY SHARE', [req.tenantId, req.params.laneId]);
        if (lane.rowCount === 0) throw new HttpError(404, 'lane not found');
        const { rows } = await client.query(
          `INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)
           RETURNING id, lane_id, name, created_at`,
          [req.tenantId, req.params.laneId, name, hashToken(token)],
        );
        await changes.record(client, req.change, {
          garageId: lane.rows[0].garage_id, action: 'computer.connect',
          subject: { kind: 'computer', id: rows[0].id, name: rows[0].name },
          before: null, after: { name: rows[0].name, lane: lane.rows[0].name },
        });
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
      const device = await changeTx(req, async (client) => {
        const { rows: was } = await client.query(
          `SELECT d.revoked_at, l.garage_id, l.name AS lane FROM lane_devices d JOIN lanes l ON l.id = d.lane_id AND l.tenant_id = d.tenant_id
            WHERE d.tenant_id = $1 AND d.id = $2 FOR UPDATE OF d`,
          [req.tenantId, req.params.deviceId],
        );
        // Another tenant's device is not found rather than forbidden, which is
        // what row-level security makes it: the row is not visible to ask about.
        if (!was[0]) throw new HttpError(404, 'device not found');
        const { rows } = await client.query(
          `UPDATE lane_devices SET revoked_at = coalesce(revoked_at, now())
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, lane_id, name, created_at, revoked_at`,
          [req.tenantId, req.params.deviceId],
        );
        await changes.record(client, req.change, {
          garageId: was[0].garage_id,
          action: 'computer.cancel',
          subject: { kind: 'computer', id: rows[0].id, name: rows[0].name },
          before: { access: was[0].revoked_at === null ? 'connected' : 'cancelled', lane: was[0].lane },
          after: { access: 'cancelled', lane: was[0].lane },
        });
        return rows[0];
      });
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
      const tokenRow = await changeTx(req, async (client) => {
        const { rows: was } = await client.query(
          'SELECT revoked_at, kind FROM operator_tokens WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
          [req.tenantId, req.params.tokenId],
        );
        if (!was[0]) throw new HttpError(404, 'operator token not found');
        const { rows } = await client.query(
          `UPDATE operator_tokens SET revoked_at = coalesce(revoked_at, now())
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, name, created_at, last_seen_at, revoked_at`,
          [req.tenantId, req.params.tokenId],
        );
        await changes.record(client, req.change, {
          garageId: null,
          action: 'key.cancel',
          subject: { kind: 'key', id: rows[0].id, name: was[0].kind === 'key' ? rows[0].name : 'a sign-in' },
          before: { access: was[0].revoked_at === null ? 'active' : 'cancelled' },
          after: { access: 'cancelled' },
        });
        return rows[0];
      });
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
  checkIds(lane, ID_PARAMS.lane);

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
        // The garage's WHOLE list of tax sets, as a load takes them (0023):
        // the lane replaces its copy with this, never merges into it, so the
        // count and the newest instant it reports describe every set it holds.
        const taxSets = taxes.loadable(await taxes.taxSetsForGarage(client, tenantId, garageId));
        // The cursor is read BEFORE the open set in the same transaction: a
        // row that lands between the two reads is then past the cursor and
        // arrives on the first delta, rather than being in the set AND past
        // it -- which is harmless -- or, read the other way round, before the
        // cursor and in no delta.
        const cursor = await repo.stayCursor(client, tenantId, garageId);
        const open = await repo.openStaysForLane(client, tenantId, garageId);
        const laneState = await lanes.laneState(client, tenantId, laneId);
        const boardState = await board.forLane(client, tenantId, laneId);
        return { garage, plans, taxSets, stays: { cursor, open }, laneState, boardState };
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
        // This lane, open or closed by hand (0026): the reason -- `full` lets
        // pass and monthly holders in, `everyone` closes it to all -- and the
        // owner's message for the lane to show. The lane acts on it (U4c),
        // and the fast read below carries the same object, so a close or a
        // reopen reaches the lane within one fast cadence.
        lane: payload.laneState,
        // This lane's board (0030): its price switch and the owner's
        // messages for it that have not ended. The fast read carries it too.
        board: payload.boardState,
        // The gate's verdict (0014). Served so a lane can see it; the lane
        // does not read it yet, and a platform ahead of the lane refuses
        // nothing by adding a key.
        active: payload.garage.activated_at !== null,
        rate_plans: payload.plans,
        tax_sets: payload.taxSets,
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
      const { tenantId, garageId, laneId } = req.device;
      const since = req.query.since;
      if (since !== undefined && !/^\d{1,18}$/.test(String(since))) {
        throw bad('since must be a cursor this route handed out: a string of digits');
      }
      const answer = await withTenant(tenantId, async (client) => {
        const garage = await repo.getGarage(client, tenantId, garageId);
        if (!garage) return null;
        // THE LANE'S OWN STATE RIDES THE FAST READ (U4c, rule 4): open or
        // closed, and its board, on every answer -- the full set and every
        // delta -- so a close, a reopen or a message reaches the lane within
        // one fast cadence rather than the slow read's five minutes.
        const lane = await lanes.laneState(client, tenantId, laneId);
        const laneBoard = await board.forLane(client, tenantId, laneId);
        if (since === undefined) {
          const cursor = await repo.stayCursor(client, tenantId, garageId);
          const open = await repo.openStaysForLane(client, tenantId, garageId);
          return { cursor, open, lane, board: laneBoard };
        }
        const { changes, more } = await repo.stayChangesSince(client, tenantId, garageId, String(since), STAY_PAGE);
        // The cursor never runs ahead of what was delivered: the last row's
        // value, or `since` itself when nothing changed. A cursor taken from
        // the table after the rows were read could cover a row that committed
        // in between, and that row would then be in no delta.
        const cursor = changes.length ? changes[changes.length - 1].change_seq : String(since);
        return { since: String(since), cursor, changes, more, lane, board: laneBoard };
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
   * THE VALIDATION CLAIM, AT THE READER (0019, amendment A1). The driver has
   * entered a phone on the reader's screen, which shows the fee the lane
   * priced; this claims a live validation for the stay ON THAT FEE, before
   * anything is paid, and holds it on the open stay -- so the next amount the
   * driver is shown is the discounted one, and the close records the hold.
   *
   * The body is `{phone, local_decision}`: the decision the reader is showing,
   * which must be a priced one this platform would consume at the close for
   * this very stay (`consumableDecision`) -- the claim is made on the PRE-TAX
   * subtotal the close will write (0023), or not at all, and the reader is
   * told the taxed discounted figure. A stay already holding a claim on that
   * subtotal answers it again (`replay`), without the door: one validation per
   * stay. A hold on another fee is given back first. A stay that is not open
   * is refused: a claim is made before the close, never after.
   *
   * 200 with `validation.outcome`: held (with the line, the fee before and
   * after), not_validated (with the module's reason), refused, not_linked. A
   * door that could not decide is a 5xx: nothing was held, and the reader
   * shows the fee as priced.
   */
  lane.post('/sessions/:sessionId/validation', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      if (direction !== 'exit') {
        throw conflict('wrong_lane_direction', 'this device is not on an exit lane');
      }
      const phone = phoneField(req.body?.phone);
      if (phone === null) throw bad('phone is required: the number the driver entered');
      const decision = localDecisionField(req.body?.local_decision);
      // On the PRE-TAX subtotal (0023): a discount taken off the taxed total
      // would come off the tax too, and leave tax on money nobody paid.
      if (decision === null || decision.status !== 'priced' || decision.subtotal_minor === 0) {
        throw conflict('nothing_to_discount', 'a validation is claimed on a priced fee above zero; this request carries none');
      }
      const sessionId = req.params.sessionId;
      // FIRST TRANSACTION (amendment A2.3): everything checked, and the intent
      // -- `claiming`, no phone in it -- COMMITTED before the door is asked.
      // The door commits in its own database; were this platform's write to
      // come only after it, a rollback here would leave a claim the module
      // holds and nothing here names. `claiming` is never a discount, and the
      // sweep and the close give back whatever it left behind.
      const pre = await withTenant(tenantId, async (client) => {
        const stay = await repo.lockOpenStay(client, tenantId, garageId, sessionId);
        if (!stay) {
          throw conflict('stay_not_open', STAY_NOT_OPEN);
        }
        const garage = await repo.getGarage(client, tenantId, garageId);
        const open = await repo.findOpenSessionById(client, tenantId, garageId, sessionId);
        const plans = ratePlans.documents(await ratePlans.ratePlansForGarage(client, tenantId, garageId));
        const taxFacts = await taxFactsForDecision(client, tenantId, garageId, decision);
        const consumable = consumableDecision(decision, { open, garage, planVersions: plans.map((p) => p.plan_version), taxFacts });
        if (!consumable.consume) throw conflict('decision_not_consumable', consumable.reason);
        const current = stay.validation;
        if (current?.state === 'held' && current.base_minor === decision.subtotal_minor) {
          const tax = await taxOnHold(client, tenantId, garage, current, decision);
          return { answer: { outcome: 'held', record: current, replay: true, tax } };
        }
        if (!garage.validations_link) {
          return { answer: { outcome: 'not_linked', reason: 'the garage names no garage in a validations module' } };
        }
        const attempt = randomUUID();
        const prior = current && validations.UNRESOLVED.has(current.state) ? current : null;
        await repo.setValidationRecord(client, tenantId, sessionId, validations.claimingRecord({
          attempt, link: garage.validations_link, feeMinor: decision.subtotal_minor, currency: decision.currency, prior,
        }));
        return { attempt, prior };
      });
      if (pre.answer) return res.status(200).json({ validation: presentClaim(pre.answer) });

      // SECOND TRANSACTION: under the stay's lock, still this attempt's
      // `claiming`, the door is asked -- a claim held elsewhere for this stay
      // given back first -- and `held` written only after it answered. A
      // rollback from here on leaves `claiming`, which no close records.
      const out = await withTenant(tenantId, async (client) => {
        const stay = await repo.lockOpenStay(client, tenantId, garageId, sessionId);
        if (!stay) {
          throw conflict('stay_not_open', STAY_NOT_OPEN);
        }
        if (stay.validation?.state !== 'claiming' || stay.validation.attempt !== pre.attempt) {
          throw conflict('claim_superseded', 'another claim or a release for this stay came first; nothing was asked');
        }
        const garage = await repo.getGarage(client, tenantId, garageId);
        const released = pre.prior
          ? await validations.release({ garage, sessionId, at: new Date(), claimIds: validations.claimIdsOf(pre.prior) })
          : null;
        // The claim is named by this attempt (A3): a release that arrives late
        // names an earlier one and cannot undo it.
        const claimed = await validations.claimAtReader({
          garage, sessionId, claimId: pre.attempt, phone, feeMinor: decision.subtotal_minor, currency: decision.currency, exitAt: new Date(decision.exit_at),
        });
        // The figure the reader is told: the tax on the discounted subtotal,
        // at the decision's exit -- the instant the close uses, so the two
        // choose the same set. Taken BEFORE `held` is written: an engine that
        // cannot answer rolls this back to `claiming`, which no close records.
        const tax = claimed.outcome === 'held' ? await taxOnHold(client, tenantId, garage, claimed.record, decision) : null;
        const record = claimed.record
          ?? (pre.prior
            ? {
                ...pre.prior, state: 'released', released_at: new Date().toISOString(), released_by: 'reclaim',
                reason: `claimed again on ${decision.subtotal_minor}, not ${pre.prior.base_minor}`, release: released,
              }
            : null);
        await repo.setValidationRecord(client, tenantId, sessionId, record);
        if (claimed.refusal) {
          // The module refused the request: nothing is held, and a human is
          // told why. The module's words, without the phone.
          await repo.appendEvents(client, tenantId, [
            {
              garageId,
              laneId,
              eventId: `validation_refused:${sessionId}:${Date.now()}`,
              kind: validations.REFUSED_EVENT_KIND,
              occurredAt: new Date(),
              detail: { actor: 'platform:reader', session_id: sessionId, link: garage.validations_link, refused: claimed.refusal },
            },
          ]);
        }
        return { ...claimed, replay: false, tax };
      });
      res.status(200).json({ validation: presentClaim(out) });
    } catch (err) {
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
      // What the reader showed the driver (A2.2): a held validation is
      // recorded only when it showed the discounted fee.
      const readerShown = readerShownField(req.body?.reader_shown);
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
        // prices again -- unless a validation is recorded, when the engine is
        // asked for the tax on the discounted subtotal and nothing else
        // (0023). What it decided from goes beside the fee, and the
        // reconciler re-derives the number from it out of band.
        let plans = ratePlans.documents(await ratePlans.ratePlansForGarage(client, tenantId, garageId));
        const consumable = consumableDecision(localDecision, {
          open, garage, planVersions: plans.map((p) => p.plan_version),
          taxFacts: await taxFactsForDecision(client, tenantId, garageId, localDecision),
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
          // PRE-TAX, like every pricing until the tax step below (0023): the
          // lane's subtotal and its base lines. Its own taxed total and whole
          // ledger ride beside them, and are what is written when no
          // validation is recorded -- the number the driver was shown.
          pricing = coveredBy.length
            ? { outcome: entitlement.EXIT_OUTCOMES.COVERED }
            : {
                outcome: entitlement.EXIT_OUTCOMES.TRANSIENT,
                feeMinor: assertMinor(localDecision.subtotal_minor, 'local_decision.subtotal_minor'),
                planVersion: localDecision.plan_version,
                breakdown: taxes.withoutTaxLines(localDecision.breakdown),
                spaceClass: localDecision.space_class,
                asDecided: {
                  feeMinor: assertMinor(localDecision.fee_minor, 'local_decision.fee_minor'),
                  breakdown: localDecision.breakdown,
                },
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
          // TODAY'S PATH, EXACTLY: the entitlement question to every module
          // the garage links, each through its own door (0015) -- two, one or
          // none -- and the engine (0013) only when none of them covers the
          // stay; a covered stay closes covered with no engine call. And, when
          // a decision was carried and not taken, the decision and the reason
          // kept on the record for the reconciler, never dropped.
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

        // THE VALIDATION (0019, amendments A1 and A2), after the fee is decided
        // -- by the lane or by this platform, the same either way -- and
        // before it is written. The claim was made AT THE READER and held on
        // this stay; the close RECORDS it -- the held line appended to the
        // ledger, the fee the running total including it -- only when the
        // reader showed the discounted fee (`reader_shown`). No door is asked
        // and nothing is re-priced. Anything unresolved the close cannot take
        // becomes `releasing` here, and the door is asked AFTER this
        // transaction commits (`finishRelease`), so no rollback can undo a
        // release the module already made. Read under the row's lock, so the
        // sweep and this close never both act on one record.
        const heldAtClose = await repo.lockValidation(client, tenantId, open.id);
        // WHICH INSTANT CHOOSES THE TAX SET (0023): the decision's exit when
        // the lane's numbers are what is written, the close's own when this
        // platform priced. Never "now".
        const taxAt = consumable.consume && localDecision.status === 'priced' ? new Date(localDecision.exit_at) : exitAt;
        // The tax on a hold's discounted subtotal, worked out BEFORE
        // `recordAtClose`, which stays pure: it judges what the reader showed
        // against this figure, and these are the lines appended when it
        // records the hold -- one derivation for both. Taken ONLY for a hold
        // the close could record (`recordableHold`, the rule `recordAtClose`
        // decides by -- not restated here): a released, releasing or unshown
        // record costs no engine call, so a close consuming a lane's decision
        // still closes while the engine is down (0017).
        const taxOnHeld = validations.recordableHold({ held: heldAtClose, pricing, readerShown })
          ? await taxes.taxOn(client, tenantId, garage, { subtotalMinor: heldAtClose.fee_after_minor, currency: heldAtClose.currency, at: taxAt })
          : null;
        const validated = validations.recordAtClose({ held: heldAtClose, pricing, readerShown, taxOnHeld, at: new Date() });
        pricing = await taxedPricing(validated.pricing, { client, tenantId, garage, currency: open.currency, at: taxAt });

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
          validation: validated.record,
        });
        const releasedBySweep = validated.record?.released_by === 'sweep';
        const releasedByClose = validated.releaseAfter && !releasedBySweep && heldAtClose?.state !== 'releasing';
        if (releasedByClose || releasedBySweep) {
          // A claim this stay made and did not record: given back now by the
          // close, or already given back by the sweep before this close came
          // -- a driver the reader may have shown a discount to, closing
          // without it. Either way a human is told.
          await repo.appendEvents(client, tenantId, [
            {
              garageId,
              laneId,
              eventId: `validation_unrecorded:${closed.id}`,
              kind: releasedByClose ? validations.RELEASED_EVENT_KIND : validations.RELEASED_BEFORE_CLOSE_EVENT_KIND,
              occurredAt: exitAt,
              detail: {
                actor: 'platform:close',
                session_id: closed.id,
                close_event_id: String(closeEventId),
                reason: validated.record.reason,
                released_by: validated.record.released_by,
                release: validated.record.release ?? null,
              },
            },
          ]);
        }
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
        return { session: closed, closed: true, replay: false, releaseAfter: validated.releaseAfter };
      });

      // The release the close decided on, asked AFTER the close committed
      // (A2.3). A door that cannot answer now leaves `releasing` for the
      // sweep; the stay is closed either way and the lane is not asked to
      // retry a close that happened.
      if (out.releaseAfter) {
        try {
          await validations.finishRelease(tenantId, out.session.id);
        } catch (err) {
          console.error(`validation release after the close failed for ${out.session.id}: ${err.message ?? err}`);
        }
      }

      // The row as written, `exit_descriptor` with it -- echoed for the reason
      // `entry_descriptor` is on the open, and a replay echoes what the close
      // that actually closed the stay stored.
      res.status(200).json({ session: presentSession(out.session), closed: out.closed, replay: out.replay });
    } catch (err) {
      next(err);
    }
  });

  /**
   * State a garage's taxes from an instant: a tax set, whole (0022).
   *
   * ONE VERB. A set is stated once and never edited; stating a new one
   * supersedes nothing -- a later `effective_from` is how a rate changes, a
   * tax is added or a tax ends. A set with no rules is the statement "this
   * garage charges no tax", and it satisfies the activation gate exactly as a
   * set with rules does; no set at all is UNSTATED, and does not.
   *
   * JUDGED BY THE ENGINE FIRST, and by nothing here: the set goes to its
   * `/v1/validate-tax-sets` exactly as sent, before any field of it is read,
   * and a set it refuses is a 400 carrying its sentence. A set it accepts and
   * this platform cannot hold (a NUL byte, a number past `integer`, an
   * instant `timestamptz` cannot hold) is `409 tax_set_not_storable` -- a
   * limit of storage, said as one. A set taking effect at an instant another
   * set already holds is `409 tax_set_effective_from_taken`, naming both. No
   * engine to ask is `503 rate_engine_unavailable`, and nothing is stored.
   * Nothing here computes a percentage; the close takes its tax lines from
   * the engine (0023).
   */
  operator.post('/garages/:garageId/tax-sets', async (req, res, next) => {
    try {
      const set = await taxes.judgeTaxSet(req.body?.tax_set);
      taxes.assertStorable(set);
      const out = await changeTx(req, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        const stored = await taxes.storeTaxSet(client, req.tenantId, {
          garage,
          set,
          actor: `operator_token:${req.operatorTokenId}`,
        });
        await changes.record(client, req.change, {
          garageId: garage.id, action: 'tax_set.add',
          subject: { kind: 'tax_set', id: stored.id ?? null, name: null },
          before: null,
          after: { effective_from: stored.effective_from ?? null, taxes: (stored.rules ?? []).map((r) => ({ label: r.label, percent_bp: r.percent_bp })) },
        });
        return stored;
      });
      res.status(201).json({ tax_set: out });
    } catch (err) {
      next(taxSetRefusal(err));
    }
  });

  /**
   * Every tax set of the garage, each with its rules in stated order. No
   * "current set": the engine picks the one in force by instant, and the
   * activation readout says which one that is today.
   */
  operator.get('/garages/:garageId/tax-sets', async (req, res, next) => {
    try {
      const sets = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        return taxes.taxSetsForGarage(client, req.tenantId, garage.id);
      });
      res.json({ tax_sets: sets });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // SETUP (U4): the checklist, lane setup and closing, and the change log.
  // -------------------------------------------------------------------------

  /**
   * The garage's setup checklist: every step worked out from its own data,
   * in order, done or not, with the facts it was decided on (src/setup.js).
   * A read: nothing here writes.
   */
  operator.get('/garages/:garageId/setup', async (req, res, next) => {
    try {
      const out = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        return setup.checklist(client, req.tenantId, garage);
      });
      res.json({ setup: out });
    } catch (err) {
      next(err);
    }
  });

  /** Rename a lane. Body: {name}. */
  operator.patch('/lanes/:laneId', async (req, res, next) => {
    try {
      const lane = await changeTx(req, (client) => lanes.rename(client, req.tenantId, req.params.laneId, req.body ?? {}, req.change));
      res.json({ lane: { id: lane.id, garage_id: lane.garage_id, name: lane.name, direction: lane.direction } });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Remove a lane that was never used: no stay, no computer, no card reader,
   * no recorded event. Anything else is refused by name, `lane_has_history`,
   * with what it has in `details`, and nothing is changed.
   */
  operator.delete('/lanes/:laneId', async (req, res, next) => {
    try {
      await changeTx(req, (client) => lanes.remove(client, req.tenantId, req.params.laneId, req.change));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /**
   * Close a lane by hand. Body: {reason: 'full' | 'everyone', message, override?}.
   * The last open lane of a direction is refused, `last_open_lane`, unless
   * `override` is true. Closing a closed lane changes its reason and message.
   */
  operator.post('/lanes/:laneId/close', async (req, res, next) => {
    try {
      const closed = await changeTx(req, (client) => lanes.close(client, req.tenantId, req.params.laneId, req.body ?? {}, req.change));
      res.json({ lane: { id: req.params.laneId, closed: { reason: closed.closed_reason, message: closed.closed_message, at: closed.closed_at } } });
    } catch (err) {
      next(err);
    }
  });

  /** Open a closed lane again. Refused by name when it is open. */
  operator.post('/lanes/:laneId/reopen', async (req, res, next) => {
    try {
      const opened = await changeTx(req, (client) => lanes.reopen(client, req.tenantId, req.params.laneId, req.body, req.change));
      res.json({ lane: { id: req.params.laneId, closed: null, reopened_at: opened.reopened_at } });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // ALERTS (U4b): who gets which alert, and how (src/alerts.js). Nothing is
  // sent. The garage and the person come from the session and the path only:
  // another account's garage, or a person of another garage, is not found.
  // -------------------------------------------------------------------------

  /** The garage, or a 404: read on the write's own transaction. */
  const ownGarage = async (client, req) => {
    const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
    if (!garage) throw new HttpError(404, 'garage not found');
    return garage;
  };

  /** The alerts, in order, and the garage's people with what each gets. A read. */
  operator.get('/garages/:garageId/alerts', async (req, res, next) => {
    try {
      const out = await withTenant(req.tenantId, async (client) => {
        const garage = await ownGarage(client, req);
        return alerts.read(client, req.tenantId, garage.id);
      });
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  /** Add a person. Body: {name, phone?, email?, language?}: a phone, an email, or both. */
  operator.post('/garages/:garageId/alert-contacts', async (req, res, next) => {
    try {
      const out = await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        return alerts.add(client, req.tenantId, garage.id, req.body ?? {}, req.change);
      });
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  });

  /** Change a person: any of {name, phone, email, language}; null takes a phone or email away. */
  operator.patch('/garages/:garageId/alert-contacts/:contactId', async (req, res, next) => {
    try {
      const out = await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        return alerts.change(client, req.tenantId, garage.id, req.params.contactId, req.body ?? {}, req.change);
      });
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  /** Remove a person, and every choice of theirs with them. */
  operator.delete('/garages/:garageId/alert-contacts/:contactId', async (req, res, next) => {
    try {
      await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        return alerts.remove(client, req.tenantId, garage.id, req.params.contactId, req.change);
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /** Which alerts a person gets: {by_text: [alert], by_email: [alert]}, the whole of both. */
  operator.put('/garages/:garageId/alert-contacts/:contactId/choices', async (req, res, next) => {
    try {
      const out = await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        return alerts.setChoices(client, req.tenantId, garage.id, req.params.contactId, req.body ?? {}, req.change);
      });
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // THE BOARD (U4c, amendment 1): the owner's messages for the lanes' screens,
  // and each lane's price switch (src/board.js). The garage comes from the
  // path and the session only.
  // -------------------------------------------------------------------------

  /** The garage's board: its messages and each lane's price switch. A read. */
  operator.get('/garages/:garageId/board', async (req, res, next) => {
    try {
      const out = await withTenant(req.tenantId, async (client) => board.read(client, req.tenantId, await ownGarage(client, req)));
      res.json({ ...out, screen: { characters: SCREEN_CHARACTERS, message_max: MESSAGE_MAX } });
    } catch (err) {
      next(err);
    }
  });

  /** Add a message. Body: {text, lanes: [laneId], starts?, ends?}, times in the garage's own time as YYYY-MM-DDTHH:MM. */
  operator.post('/garages/:garageId/board-messages', async (req, res, next) => {
    try {
      const out = await changeTx(req, async (client) => board.add(client, req.tenantId, await ownGarage(client, req), req.body ?? {}, req.change));
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  });

  /** Change a message: any of {text, lanes, starts, ends}; null takes a start or an end away. */
  operator.patch('/garages/:garageId/board-messages/:messageId', async (req, res, next) => {
    try {
      const out = await changeTx(req, async (client) => board.change(client, req.tenantId, await ownGarage(client, req), req.params.messageId, req.body ?? {}, req.change));
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  /** Remove a message from every lane it shows on. */
  operator.delete('/garages/:garageId/board-messages/:messageId', async (req, res, next) => {
    try {
      await changeTx(req, async (client) => board.remove(client, req.tenantId, await ownGarage(client, req), req.params.messageId, req.change));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /** This lane shows the price on its board, or not. Body: {show: true | false}. */
  operator.put('/lanes/:laneId/board-prices', async (req, res, next) => {
    try {
      const out = await changeTx(req, (client) => board.setPrices(client, req.tenantId, req.params.laneId, req.body ?? {}, req.change));
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  /**
   * The garage's change log, newest first: its own lines and the account's.
   * The changes made and the refused attempts are read apart, so no number
   * of refused attempts can push a change out of sight. `/changes/<id>` (or
   * `/refused-attempts/<id>`) continues after that line: `next` is the id of
   * the last line of the page, or null on the last page. An id in the path,
   * checked as every id is, and no query: the owner's screens build no query
   * string, so an address carries ids only. A line not in this garage's log
   * is 404. The refused attempts also say how many there are.
   */
  const logRead = (outcome) => async (req, res, next) => {
    try {
      const out = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        const page = await changes.linesForGarage(client, req.tenantId, garage.id, { outcome, after: req.params.changeId ?? null });
        if (!page) throw new HttpError(404, 'change not found');
        return { page, count: outcome === 'refused' ? await changes.refusedCount(client, req.tenantId, garage.id) : null };
      });
      if (outcome === 'done') res.json({ changes: out.page.lines.map(presentChange), next: out.page.next });
      else res.json({ refused: out.page.lines.map(presentChange), next: out.page.next, count: out.count });
    } catch (err) {
      next(err);
    }
  };
  operator.get('/garages/:garageId/changes', logRead('done'));
  operator.get('/garages/:garageId/changes/:changeId', logRead('done'));
  operator.get('/garages/:garageId/refused-attempts', logRead('refused'));
  operator.get('/garages/:garageId/refused-attempts/:changeId', logRead('refused'));

  /**
   * A refused write is a line in the change log (src/changes.js): in the log
   * of the account the path names, of the caller's account, or of nobody --
   * the platform's own security log. Then answered as before.
   */
  operator.use(async (err, req, _res, next) => {
    const status = err?.status ?? (err?.bodyUnreadable ? 400 : 500);
    if (!SAFE_METHODS.has(req.method) && status >= 400 && status < 500 && !err?.malformedId) {
      await changes.refused(req, err, {
        action: actionFor(req),
        request: requestFor(req),
        credential: req.credential?.kind ?? 'none',
        credentialToken: req.credential?.token ?? null,
        address: signIn.callerAddress(req, authSettings),
        idleSeconds: authSettings.idleSeconds,
      });
    }
    next(err);
  });

  // Order matters and is load-bearing. '/api/v1' is a prefix of '/api/v1/lane',
  // so the operator router must be mounted AFTER the lane router. Mounted first
  // it answers every lane request 401 before the device router runs. The test
  // 'a lane call with no token is refused BY THE LANE ROUTER' asserts the
  // message, not just the status, because both orderings return 401.
  app.use('/api/v1/lane', lane);
  app.use('/api/v1', operator);

  app.use((err, req, res, _next) => {
    // A request whose body could not be read: one fixed sentence, never the
    // parser's, which quotes what was sent; and never stored or sniffed. For
    // EVERY request, not for a path prefix: routing ignores the letter case of
    // the path and a prefix test does not, so `/API/V1/garages` was routed as
    // an operator request and answered in the parser's words. The parser runs
    // before any router, so no path here is known to be anyone's. The lane is
    // answered the same way: still a 4xx, without the parser's text.
    if (err.bodyUnreadable) {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      return err.status === 413 ? res.status(413).json(BODY_TOO_LARGE) : res.status(400).json(BODY_UNREADABLE);
    }
    const status = err.status ?? 500;
    // A NAMED 5xx is ours and says what failed upstream -- Stripe refused, or
    // could not be reached -- and the operator needs that sentence. Anything
    // else at 5xx is an internal error and says nothing.
    const namedUpstream = err instanceof HttpError && err.code && status >= 500;
    if (status >= 500 && !namedUpstream) console.error('[api]', err);
    if (status >= 500 && !namedUpstream) return res.status(status).json({ error: 'internal error' });
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

/** A claim as the reader is told it: what to show, never the phone. */
function presentClaim(out) {
  if (out.outcome !== 'held') {
    return { outcome: out.outcome, ...(out.reason !== undefined ? { reason: out.reason } : {}) };
  }
  const r = out.record;
  // The record's amounts are PRE-TAX (0023): what the claim was made on, and
  // what is left after it. The reader is told the TAXED figure: the subtotal
  // after the discount plus the tax lines the engine took on it.
  return {
    outcome: 'held',
    replay: out.replay,
    currency: r.currency,
    fee_before_minor: r.base_minor,
    discount_minor: r.discount_minor,
    subtotal_minor: r.fee_after_minor,
    tax_lines: out.tax.lines,
    fee_minor: assertMinor(r.fee_after_minor + out.tax.totalMinor, 'fee_minor'),
    line: r.line,
    held_at: r.held_at,
  };
}

/**
 * The tax on a hold's discounted subtotal, at the decision's exit. One
 * derivation for the figure the reader is told; the close derives it again,
 * at the same instant, to judge what the reader showed.
 */
function taxOnHold(client, tenantId, garage, record, decision) {
  return taxes.taxOn(client, tenantId, garage, {
    subtotalMinor: record.fee_after_minor, currency: record.currency, at: new Date(decision.exit_at),
  });
}

/** Money leaves the database as a string; it leaves the API as a number. */
function presentSession(s) {
  return {
    ...s,
    hourly_minor_applied: toMinor(s.hourly_minor_applied, 'hourly_minor_applied'),
    fee_minor: toMinor(s.fee_minor, 'fee_minor'),
    subtotal_minor: toMinor(s.subtotal_minor, 'subtotal_minor'),
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
 * THE TAX LINES, LAST (0023). `pricing` arrives PRE-TAX -- base lines, then a
 * recorded validation line if there is one -- and leaves with the tax lines
 * after them, `subtotalMinor` beside the fee, and the fee the running total:
 *
 *   a recorded validation   the lines `recordAtClose` judged the reader's
 *                           figure by, taken on the discounted subtotal;
 *   the lane's decision     written EXACTLY as the lane decided it, tax
 *                           included -- the number the driver was shown, and a
 *                           second derivation would be a second answer to one
 *                           question (0017);
 *   this platform priced    the engine's tax on the subtotal, at the close.
 *
 * A covered or unpriced stay carries no tax and no subtotal. The table checks
 * the sum as well; this checks it first, so a mismatch is named here.
 */
async function taxedPricing(pricing, { client, tenantId, garage, currency, at }) {
  if (!validations.isPriced(pricing)) return pricing;
  const { asDecided, taxLines, ...rest } = pricing;
  const subtotalMinor = assertMinor(rest.feeMinor, 'subtotal_minor');
  let taxed;
  if (taxLines !== undefined) {
    taxed = { ...rest, subtotalMinor, feeMinor: subtotalMinor + taxes.taxDelta(taxLines), breakdown: [...rest.breakdown, ...taxLines] };
  } else if (asDecided !== undefined) {
    taxed = { ...rest, subtotalMinor, feeMinor: asDecided.feeMinor, breakdown: asDecided.breakdown };
  } else {
    const { lines } = await taxes.taxOn(client, tenantId, garage, { subtotalMinor, currency, at });
    taxed = { ...rest, subtotalMinor, feeMinor: subtotalMinor + taxes.taxDelta(lines), breakdown: [...rest.breakdown, ...lines] };
  }
  if (taxed.subtotalMinor + taxes.taxDelta(taxed.breakdown) !== taxed.feeMinor) {
    throw new Error(`the stay's subtotal ${taxed.subtotalMinor} and its tax lines do not add up to its fee ${taxed.feeMinor}`);
  }
  return taxed;
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
    `this garage is not active: no stay is ${action === 'open' ? 'opened' : 'closed'} here until its rate setup is complete, its transient mode is stated and its taxes are stated`,
  );
}

/** The methods that change nothing: a refusal of one is not a refused change. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * EVERY OPERATOR WRITE ROUTE, with the action its change-log line names.
 * test/change-log.test.js walks the router and requires this list to be
 * exactly the routes it finds, so a write added without a line is caught.
 */
export const WRITE_ROUTES = Object.freeze([
  ['POST', '/garages', 'garage.create'],
  ['PATCH', '/garages/:garageId', 'garage.update'],
  ['POST', '/garages/:garageId/activate', 'garage.open'],
  ['PUT', '/garages/:garageId/entitlement-links', 'garage.pass_links'],
  ['PUT', '/garages/:garageId/validations-link', 'garage.validations_link'],
  ['POST', '/garages/:garageId/stripe-account', 'payment_account.create'],
  ['POST', '/garages/:garageId/stripe-account/onboarding-link', 'payment_account.setup_link'],
  ['POST', '/garages/:garageId/stripe-account/refresh', 'payment_account.read'],
  ['POST', '/garages/:garageId/stripe-account/location', 'payment_account.reader_place'],
  ['POST', '/lanes/:laneId/reader', 'lane.card_reader_connect'],
  ['POST', '/lanes/:laneId/reader/unbind', 'lane.card_reader_disconnect'],
  ['POST', '/garages/:garageId/lanes', 'lane.add'],
  ['POST', '/garages/:garageId/rates', 'rates.retired'],
  ['POST', '/garages/:garageId/rate-plans', 'rate_plan.add'],
  ['POST', '/lanes/:laneId/devices', 'computer.connect'],
  ['POST', '/devices/:deviceId/revoke', 'computer.cancel'],
  ['POST', '/operator-tokens/:tokenId/revoke', 'key.cancel'],
  ['POST', '/garages/:garageId/tax-sets', 'tax_set.add'],
  ['PATCH', '/lanes/:laneId', 'lane.rename'],
  ['DELETE', '/lanes/:laneId', 'lane.remove'],
  ['POST', '/lanes/:laneId/close', 'lane.close'],
  ['POST', '/lanes/:laneId/reopen', 'lane.reopen'],
  ['POST', '/garages/:garageId/alert-contacts', 'alert_contact.add'],
  ['PATCH', '/garages/:garageId/alert-contacts/:contactId', 'alert_contact.change'],
  ['DELETE', '/garages/:garageId/alert-contacts/:contactId', 'alert_contact.remove'],
  ['PUT', '/garages/:garageId/alert-contacts/:contactId/choices', 'alert_contact.choices'],
  ['POST', '/garages/:garageId/board-messages', 'board_message.add'],
  ['PATCH', '/garages/:garageId/board-messages/:messageId', 'board_message.change'],
  ['DELETE', '/garages/:garageId/board-messages/:messageId', 'board_message.remove'],
  ['PUT', '/lanes/:laneId/board-prices', 'lane.board_prices'],
]);

const WRITE_PATTERNS = WRITE_ROUTES.map(([method, path, action]) => [
  method,
  new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[^/]+')}/?$`, 'i'),
  action,
]);

/** The action a write request was asking for, whether or not its route was reached. */
function actionFor(req) {
  const found = WRITE_PATTERNS.find(([method, re]) => method === req.method && re.test(req.path));
  return found ? found[2] : 'unknown.write';
}

const CONTACT_PATH = /\/alert-contacts(\/|$)/i;

/**
 * The request a refused attempt names, when it is aimed at a person to tell:
 * the route as it is written, never the path as it was sent, which could
 * carry anything typed in place of an id. Undefined for any other request.
 */
function requestFor(req) {
  if (!CONTACT_PATH.test(req.path ?? '')) return undefined;
  const at = WRITE_PATTERNS.findIndex(([method, re]) => method === req.method && re.test(req.path));
  return `${req.method} ${req.baseUrl ?? ''}${at >= 0 ? WRITE_ROUTES[at][1] : '/garages/:garageId/alert-contacts/...'}`;
}

/** A change-log line as the owner's screens read it. */
function presentChange(line) {
  return {
    id: line.id,
    garage_id: line.garage_id,
    at: line.at,
    outcome: line.outcome,
    who: { kind: line.actor_kind, name: line.actor_name },
    action: line.action,
    // A person to tell is named as they are now, or not at all when they
    // have been removed (src/changes.js): the line itself never holds a name.
    subject: { kind: line.subject_kind, id: line.subject_id, name: line.subject_name, removed: line.subject_removed === true },
    before: line.before,
    after: line.after,
    refusal: line.refusal,
    // A refused attempt repeated from the same source within a minute is one
    // line: how many times, and when the last was (0027).
    attempts: line.attempts,
    last_at: line.last_at,
  };
}

/** A garage's stated links, as the change log shows them: `{module: {tenant_id, garage_id} | null}`. */
function linksOf(garage, modules) {
  return Object.fromEntries(modules.map((m) => [m, garage[`${m}_link`] ?? null]));
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

/**
 * The tax store's refusals onto the wire: a set the engine refused is a 400
 * like every malformed body here; a set it accepted and this platform will not
 * hold is a named conflict, with what it names in `details`. No engine to ask
 * is a NAMED 5xx: the save did not happen and can, once the engine answers.
 */
function taxSetRefusal(err) {
  if (err instanceof ratePlans.EngineUnavailable) {
    return new HttpError(503, `${err.message}; the tax set was not stored`, 'rate_engine_unavailable');
  }
  if (!(err instanceof taxes.TaxSetRefused)) return err;
  if (err.code === 'tax_set_invalid') return bad(err.message);
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
