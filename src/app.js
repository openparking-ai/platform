import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  DatabaseUnavailable, UNAVAILABLE_RETRY_AFTER, databaseAnswers, pool, query, unavailableAnswer, withTenant,
} from './db.js';
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
import * as pastStays from './pastStays.js';
import * as stripeAccount from './stripeAccount.js';
import * as terminal from './terminal.js';
import * as signIn from './signIn.js';
import { startSetting } from './startSettings.js';
import { HttpError } from './errors.js';
import { GarageTimeInvalid, localToInstant } from './garageTime.js';
import * as changes from './changes.js';
import * as lanes from './lanes.js';
import * as board from './board.js';
import { SCREEN_CHARACTERS } from './screenText.js';
import { MESSAGE_MAX } from './lanes.js';
import * as setup from './setup.js';
import * as alerts from './alerts.js';
import * as bans from './bans.js';
import * as exits from './exits.js';
import * as exitMatch from './exitMatch.js';
import * as exitPicker from './exitPicker.js';
import * as exitPayments from './exitPayments.js';
import * as textReceipt from './textReceipt.js';
import * as stuck from './stuckStays.js';
import * as walks from './walks.js';
import { connectConfig, StripeError, StripeUnreachable } from './stripe.js';
import { garageCurrency, garageName, garageSpaces, garageTimezone } from './garageFields.js';
import { verifyUtf8 } from './utf8Body.js';

/**
 * The stay's open exit case changed, or took a payment, between the cancel
 * at Stripe and the transaction that supersedes it: the whole step is run
 * again, at most PRIOR_CASE_ATTEMPTS times, then the lane is asked to send
 * again (503).
 */
class PriorCaseMoved extends Error {}
const PRIOR_CASE_ATTEMPTS = 3;

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
    banId: () => new HttpError(404, 'banned car not found', 'banned_car_not_found'),
    pictureId: () => new HttpError(404, 'picture not found'),
    exitId: () => new HttpError(404, 'exit case not found', 'exit_not_found'),
    stayId: () => new HttpError(404, 'stay not found', 'stay_not_found'),
    walkId: () => new HttpError(404, 'walk not found', 'walk_not_found'),
    sightingId: () => new HttpError(404, 'sighting not found', 'sighting_not_found'),
  }),
  lane: Object.freeze({
    sessionId: () => conflict('stay_not_open', STAY_NOT_OPEN),
    exitId: () => new HttpError(404, 'exit case not found', 'exit_not_found'),
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
  // this is the record. It is NOT an `entry_confirmation` value -- that column
  // answers "did anything see the car cross" (yes, the loops did); this kind
  // answers "did anything admit it" (no). The CAR is a stay all the same (the
  // owner's rule, 2026-10-26: the loops and the pictures make the entry): the
  // lane opens one beside this event through `/sessions/open`, `confirmed`,
  // `tailgater: true`, with a plate or `plate_unreadable` (0036). Not counted
  // by `reconcile.js`.
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
 * AND A THIRD, ON AN ENTRY'S OPEN ONLY (0036): `plate_unreadable: true` -- a
 * car the lane's loops saw go in whose plate nobody could read. The owner's
 * rule makes every such car a stay ("unreadable" is part of the car's
 * identity, not a failure to have one), and before this it had no identity to
 * open one on. It is alone or it is refused: beside a plate it would say the
 * plate was both read and not read, and beside a ticket it would be two cars.
 * The stay's vehicle is a row of its own, keyed on the open's event id, so two
 * unread cars are never one (src/repository.js `upsertVehicle`). Nothing finds
 * or closes a stay by it: the close and the exit's lookup take a plate or a
 * ticket, as before.
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
 * A lane's id for anything it records (0036), on every route that takes one --
 * an open, a close, a log event: 1 to 64 characters of letters, digits, hyphen
 * and underscore. Our lane mints a UUID; another lane's own scheme (`tp-0001`)
 * fits too. The open's id is now also the key an unread car's vehicle is held
 * under, so it is checked for its shape like any identity -- a JSON object
 * would otherwise reach the database as `[object Object]`, a value shaped like
 * the purge's `redacted:<id>` would be a live key that reads as a redacted one,
 * and an unbounded one is a row an attacker chooses the size of.
 */
const LANE_EVENT_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** `value` as a lane's event id, or a 400 naming the rule. */
function laneEventId(value, label = 'event_id') {
  if (typeof value !== 'string' || !LANE_EVENT_ID_SHAPE.test(value)) {
    throw bad(`${label} must be 1 to 64 characters of A-Z, a-z, 0-9, hyphen and underscore`);
  }
  return value;
}

/**
 * What the camera read of an UNREAD car's plate below the lane's confidence,
 * and that confidence (0036): `unsure_plate` and `unsure_plate_confidence`,
 * both or neither, and only beside `plate_unreadable: true` -- a car whose
 * plate was read has a plate, and a ticket is asserted, not read. Kept on the
 * stay for the exit's matching and never an identity.
 */
function unsurePlateFields(body, { plateUnreadable }) {
  const plate = body?.unsure_plate ?? null;
  const confidence = body?.unsure_plate_confidence ?? null;
  if (plate === null && confidence === null) return { plate: null, confidence: null };
  if (!plateUnreadable) {
    throw bad('unsure_plate goes only with plate_unreadable: true -- a plate read with confidence is the plate');
  }
  if (typeof plate !== 'string' || plate.trim() === '' || plate.length > PLATE_MAX) {
    throw bad(`unsure_plate must be a string of at most ${PLATE_MAX} characters and not only whitespace`);
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw bad('unsure_plate_confidence must be a number from 0 to 1, given with unsure_plate');
  }
  return { plate, confidence };
}

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
 * (`opvid-opa-id/<version>:…`), and this platform does not parse it -- migration
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
  // HOW FULL AT ENTRY (0034). A lane says which figure it priced the stay on;
  // one that is not the stay's own -- a lane that dropped it, or held an older
  // copy -- is not taken, and the close prices on the stay's own.
  if (decision.occupancy_at_entry_bp !== undefined && (decision.occupancy_at_entry_bp ?? null) !== (open.occupancy_at_entry_bp ?? null)) {
    return {
      consume: false,
      reason: `the decision priced the stay at ${JSON.stringify(decision.occupancy_at_entry_bp)} bp full at entry; the stay's own figure is ${JSON.stringify(open.occupancy_at_entry_bp ?? null)}`,
    };
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
function laneIdentity(source, { where = 'body', unreadable = false } = {}) {
  const plate = source?.plate ?? null;
  const ticketRef = source?.ticket_ref ?? null;
  const plateUnreadable = unreadable ? (source?.plate_unreadable ?? null) : null;
  if (plateUnreadable !== null) {
    if (plateUnreadable !== true) {
      throw bad('plate_unreadable must be true when given: a car whose plate nobody could read');
    }
    if (plate !== null || ticketRef !== null) {
      throw bad(
        'plate_unreadable is an identity of its own: send it with neither plate nor ticket_ref',
      );
    }
    return { plate: null, ticketRef: null, plateUnreadable: true };
  }
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
  return {
    plate: plate ? String(plate) : null,
    ticketRef: ticketRef ? String(ticketRef) : null,
    plateUnreadable: false,
  };
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

/** Where a garage's banned list reaches (0033): this garage, or every garage of the account. */
const BAN_REACHES = Object.freeze(['garage', 'all']);

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

// What the lane accepts from a driver (Python's `fromisoformat` with an
// offset): a `T` or a space, seconds optional, and Z, +hh:mm, +hhmm or +hh.
const DRIVER_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(?:\.\d{1,6})?)?(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * A TIME A DRIVER SAID, WITH ITS OFFSET, or a 400 saying so. Without one,
 * `new Date` reads it on this server's clock, which is not the garage's,
 * and the stay is priced for hours the car was not there.
 */
function driverTime(value, label) {
  if (!value) throw bad(`${label} is required`);
  const m = typeof value === 'string' ? DRIVER_TIME.exec(value.trim()) : null;
  if (!m) {
    throw new HttpError(400,
      `${label} must be a date and time with its time zone offset, such as 2026-10-27T09:00:00-04:00: a time without one cannot be placed`,
      'entry_time_without_offset');
  }
  const [, date, minutes, seconds = ':00', zone] = m;
  const offset = zone.toUpperCase() === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3).replace(':', '') || '00'}`;
  const at = new Date(`${date}T${minutes}${seconds}${offset}`);
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
/** How far apart an exit lane's clock and an entry lane's may be: each off by the tolerance, opposite ways. */
const LANE_CLOCKS_APART_MS = 2 * MAX_CLOCK_SKEW_SECONDS * 1000;

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
  // No answer names the framework (OWASP information exposure).
  app.disable('x-powered-by');
  const authSettings = signIn.readAuthSettings();
  if (authSettings.trustProxy !== null) app.set('trust proxy', authSettings.trustProxy);

  // FIRST, before the app-wide body parser and before the operator router.
  // The operator router answers 401 to everything under /api/v1, so mounted
  // after it sign-in is unreachable; and the auth routes read their own body,
  // so a body that cannot be parsed is answered with their one sentence and
  // never with the parser's text, which quotes what was sent.
  app.use('/api/v1/auth', signIn.createAuthRouter(authSettings));

  // Any failure to read a body is marked as one, so it is answered in one
  // fixed sentence (below), whatever the path. A body that is not UTF-8 is
  // one (src/utf8Body.js): refused before it is decoded, never stored as U+FFFD.
  const json = express.json({ limit: '1mb', verify: verifyUtf8 });
  // A lane's picture (U7f) is the one larger body: up to PICTURE_MAX_BYTES,
  // base64 in JSON, read by its route after the device token (below), so a
  // body from no known device is never read. Every other path keeps the one
  // limit.
  const pictureJson = express.json({ limit: '5mb', verify: verifyUtf8 });
  const readPicture = (req, res, next) => pictureJson(
    req, res, (err) => next(err ? Object.assign(err, { bodyUnreadable: true }) : undefined));
  // A walk's sighting (0040) carries a phone's picture: the same larger body,
  // read by its route after the operator token.
  const WALK_SIGHTING = /^\/api\/v1\/garages\/[^/]+\/walks\/[^/]+\/sightings\/?$/i;
  app.use((req, res, next) => (req.path === '/api/v1/lane/pictures' || WALK_SIGHTING.test(req.path) ? next() : json(
    req, res, (err) => next(err ? Object.assign(err, { bodyUnreadable: true }) : undefined))));

  // Says whether the database answers NOW: 503 while it cannot be reached, 200
  // again when it can, with no restart between.
  app.get('/healthz', async (_req, res) => {
    if (await databaseAnswers()) return res.json({ ok: true, db: 'connected' });
    return res.status(503).json({ ok: false, db: 'unreachable' });
  });

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
        const { rows } = await query('SELECT * FROM resolve_operator_token($1)', [hashToken(token)]);
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
  const changeTx = (req, fn) => {
    // A try lost to the database is rolled back and run again (src/db.js):
    // what the lost try said about the change log goes with it.
    const unchanged = req.change.unchanged;
    return withTenant(req.tenantId, async (client) => {
      req.change.unchanged = unchanged;
      const before = req.change.count;
      const out = await fn(client);
      const lines = req.change.count - before;
      if (lines !== 1 && !(lines === 0 && req.change.unchanged)) {
        throw new Error(`a write recorded ${lines} change-log lines, not one`);
      }
      return out;
    });
  };

  /**
   * A write whose change ran in a module's own transactions (the payment
   * account and card readers, which ask Stripe between them): the module
   * records the line in the transaction that changed something. When nothing
   * changed -- asked again, answered with what was there -- there is no line.
   */
  const recorder = (req) => (client, line) => changes.record(client, req.change, line);

  operator.post('/garages', async (req, res, next) => {
    try {
      const raw = req.body ?? {};
      if (!raw.name || !raw.timezone || !raw.currency) throw bad('name, timezone and currency are required');
      // Each refused in its own sentence before the database is asked to
      // store it (src/garageFields.js): never a bare 500, never taken unread.
      const name = garageName(raw.name);
      const currency = garageCurrency(raw.currency);
      const timezone = await garageTimezone({ query }, raw.timezone);
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
      // The location setup's two settings for tailgaters (0033, U7f).
      const banTailgaters = req.body?.ban_tailgaters;
      if (banTailgaters !== undefined && typeof banTailgaters !== 'boolean') {
        throw bad('ban_tailgaters must be true or false when given');
      }
      const banReach = req.body?.ban_reach;
      if (banReach !== undefined && !BAN_REACHES.includes(banReach)) {
        throw bad(`ban_reach must be one of ${BAN_REACHES.join(', ')} when given`);
      }
      // The garage's number of spaces (0034): the garage map writes its count of
      // switched-on spots here, or the owner types it on the Garages page.
      const spaces = req.body?.spaces === undefined ? undefined : garageSpaces(req.body.spaces);
      // The share of the stays a walk must see to feed the stuck list (0040).
      const walkComplete = req.body?.walk_complete_percent;
      if (walkComplete !== undefined && !(Number.isInteger(walkComplete) && walkComplete >= 1 && walkComplete <= 100)) {
        throw bad('walk_complete_percent must be a whole number from 1 to 100 when given');
      }
      const given = {
        default_action: action, transient_available: transient, ban_tailgaters: banTailgaters, ban_reach: banReach, spaces,
        walk_complete_percent: walkComplete,
      };
      const fields = Object.keys(given).filter((f) => given[f] !== undefined);
      if (fields.length === 0) {
        throw bad('default_action, transient_available, ban_tailgaters, ban_reach, spaces or walk_complete_percent is required');
      }
      const garage = await changeTx(req, async (client) => {
        // Read first, locked: the line says what each field was.
        const { rows: was } = await client.query(
          'SELECT * FROM garages WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
          [req.tenantId, req.params.garageId],
        );
        if (!was[0]) throw new HttpError(404, 'garage not found');
        if (spaces === null && was[0].spaces !== null) {
          // Rates with a fill rule price on the number of spaces: it is not
          // taken away under them. Decided behind the garage's rates lock, the
          // one a save of new rates holds, so the two cannot cross.
          await ratePlans.lockGarageRates(client, was[0].id);
          const newest = await ratePlans.newestRatePlan(client, req.tenantId, was[0].id);
          const { rows: plan } = newest
            ? await client.query('SELECT document FROM rate_plans WHERE tenant_id = $1 AND id = $2', [req.tenantId, newest.id])
            : { rows: [] };
          if (plan[0] && ratePlans.hasFillRule(plan[0].document)) {
            throw conflict(
              'spaces_needed_by_fill_rule',
              'the rates in force raise the price when the garage is full, which needs the number of spaces; ' +
                'change the rates first, then clear it. Nothing was changed.',
            );
          }
        }
        const sets = [];
        const values = [req.tenantId, req.params.garageId];
        for (const f of fields) { values.push(given[f]); sets.push(`${f} = $${values.length}`); }
        const { rows } = await client.query(
          `UPDATE garages SET ${sets.join(', ')}
            WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          values,
        );
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
   * operator token that did it. Refused, `409 garage_not_activatable`, while
   * any setup step except alerts is not done, every one of them listed in
   * `details.unmet` by its step key -- the setup read's `not_done`, from the
   * same function (src/setup.js `openingSteps`). Idempotent.
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
   *
   * U7i: nothing is scheduled. A plan starts when it is saved -- later than
   * this server's clock (beyond the clock allowance) is `422
   * rates_start_when_saved` -- and `based_on` names the rates the owner
   * checked these against (the id of the plan in force, null for none): any
   * other plan stored since is `409 rates_changed_since_check`. Nothing is
   * stored on either.
   */
  operator.post('/garages/:garageId/rate-plans', async (req, res, next) => {
    try {
      // The owner's confirmation first (U7g): nothing reaches the engine, let
      // alone the store, until somebody has said they checked the prices.
      ratePlans.assertConfirmed(req.body);
      const document = ratePlans.planDocument(req.body?.plan);
      ratePlans.assertFillAnswers(document);
      const out = await withTenant(req.tenantId, async (client) => {
        let garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        // Validated BEFORE it is stored, by the only thing that knows what a
        // plan means. The currency check sits after it deliberately: a
        // document the engine cannot load has no currency worth comparing.
        const validated = await ratePlans.validateWithEngine(document);
        // Nothing scheduled (U7i): new rates start when they are saved.
        ratePlans.assertStartsWhenSaved(document);
        // The rates the owner checked are still the newest (U7i): decided
        // here, in the transaction that inserts, behind the garage's lock.
        await ratePlans.lockGarageRates(client, garage.id);
        // Read again behind the lock: the number of spaces a fill rule needs
        // is cleared only behind this same lock (PATCH /garages/:id).
        garage = await repo.getGarage(client, req.tenantId, garage.id);
        ratePlans.assertFitsGarage(garage, document);
        ratePlans.assertBasedOnNewest(req.body, await ratePlans.newestRatePlan(client, req.tenantId, garage.id));
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
          // `confirmed`: the owner ticked "I checked these prices" and pressed
          // Confirm. Who confirmed, and when, are this line's own actor and time.
          before: null, after: { plan_version: row.plan_version, effective_from: row.effective_from, confirmed: true },
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
      const out = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        return { garage, rows: await ratePlans.ratePlansForGarage(client, req.tenantId, garage.id) };
      });
      // The space class every stay here is priced as (U7g): a plan must
      // declare it, and the owner's Rates form builds the plan with it.
      res.json({ rate_plans: out.rows.map(presentRatePlan), space_class: out.garage.space_class });
    } catch (err) {
      next(err);
    }
  });

  /**
   * TRY A STAY (U7g): what a car would pay, through the close's own pricing,
   * with nothing stored. The owner checks the rates on real stays before they
   * are saved.
   *
   * `stays` is 1-100 `{ entry, exit }`, each a date and time in the garage's
   * own time (YYYY-MM-DDTHH:MM). Without `plan`, the garage's stored plans
   * price them. With `plan`, the stored plans AND the draft, exactly as the
   * close would see them once the draft is saved: a car that came in before
   * the draft starts is priced by the plan it would really get.
   *
   * Each stay goes through `priceStay` and then `taxedPricing` -- the two
   * functions the close calls, in the close's order, with the tax taken at the
   * exit as the close takes it -- so the try cannot drift from what a driver
   * is charged. Run in a READ ONLY transaction: it stores nothing, writes no
   * event and no change-log line, and a write slipped in here fails instead of
   * landing. A draft the engine cannot load is the store's own 400; one the
   * store would refuse for this garage is the store's own refusal. At most 20
   * tries a minute for each signed-in owner (or key).
   */
  operator.post('/garages/:garageId/rate-plans/try', async (req, res, next) => {
    try {
      if (!tryLimiter.take(`${req.actor.kind}:${req.actor.id}`)) {
        throw new HttpError(429, `at most ${TRY_PER_MINUTE} tries a minute; wait a minute and try again`, 'too_many_tries');
      }
      const body = req.body ?? {};
      const draft = body.plan === undefined ? null : ratePlans.planDocument(body.plan);
      if (draft !== null) ratePlans.assertFillAnswers(draft);
      const rawStays = body.stays;
      if (!Array.isArray(rawStays) || rawStays.length < 1 || rawStays.length > TRY_MAX_STAYS) {
        throw bad(`stays is a list of 1 to ${TRY_MAX_STAYS} stays, each { entry, exit } in the garage's own time`);
      }
      // The engine first, as the store does: a draft it cannot load has no
      // currency or start worth comparing. Findings do not stop a try -- the
      // stays they touch come back refused, which is how the owner sees them.
      let draftFindings = [];
      if (draft !== null) {
        try {
          await ratePlans.validateWithEngine(draft);
        } catch (err) {
          if (!(err instanceof ratePlans.RatePlanRefused) || err.code !== 'plan_has_findings') throw err;
          draftFindings = err.details.findings;
        }
      }
      const out = await withTenant(req.tenantId, async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        const stays = rawStays.map((stay, i) => tryStay(stay, i, garage.timezone));
        const stored = await ratePlans.ratePlansForGarage(client, req.tenantId, garage.id);
        if (draft !== null) {
          ratePlans.assertFitsGarage(garage, draft);
          ratePlans.assertNewBeside(stored, draft);
        }
        const documents = [...ratePlans.documents(stored), ...(draft === null ? [] : [draft])];
        if (documents.length === 0) {
          throw conflict('no_rate_plan', 'this garage has no rates yet: send the draft as plan to try it');
        }
        const answers = [];
        for (const stay of stays) answers.push(await tryOne(client, req.tenantId, garage, documents, stay));
        return { garage, answers };
      });
      res.json({
        currency: out.garage.currency,
        timezone: out.garage.timezone,
        draft_findings: draftFindings,
        stays: out.answers,
      });
    } catch (err) {
      if (err instanceof ratePlans.EngineUnavailable) {
        return next(new HttpError(503, `${err.message}; nothing was priced`, 'rate_engine_unavailable'));
      }
      if (err instanceof GarageTimeInvalid) return next(bad(err.message));
      next(ratePlanRefusal(err));
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

  /**
   * A garage's past stays (src/pastStays.js): the stays that closed in a
   * stated range, paged, with no vehicle identity. Read-only.
   */
  operator.get('/garages/:garageId/stays/closed', async (req, res, next) => {
    try {
      const asked = pastStays.readQuery(req.query);
      const page = await withTenant(req.tenantId, async (client) => {
        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        return pastStays.closedStays(client, req.tenantId, req.params.garageId, asked);
      });
      res.json({
        garage_id: req.params.garageId,
        from: asked.from.toISOString(),
        to: asked.to.toISOString(),
        limit: asked.limit,
        ...page,
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Lane surface. Authenticated by device token.
  // -------------------------------------------------------------------------
  const lane = express.Router();
  checkIds(lane, ID_PARAMS.lane);

  lane.use(async (req, res, next) => {
    try {
      const token = bearerFrom(req.get('authorization'));
      if (!token) throw new HttpError(401, 'device token required');

      // The bootstrap problem: we do not yet know which tenant this token
      // belongs to, so this lookup cannot run under a tenant policy. It goes
      // through resolve_lane_device(), which is SECURITY DEFINER for exactly
      // that reason. See migration 0002.
      const { rows } = await query('SELECT * FROM resolve_lane_device($1)', [hashToken(token)]);
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
      // A picture's body is still unread here: closing the connection keeps
      // the rest of it from being taken in.
      if (req.path === '/pictures') res.set('Connection', 'close');
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
        const banned = await bans.forLane(client, tenantId, garageId);
        return { garage, plans, taxSets, stays: { cursor, open }, laneState, boardState, banned };
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
        // The garage's number of spaces (0034), or null: the lane's price board
        // prices a car coming in now on how full the garage is now, the figure
        // the open will freeze onto it.
        spaces: payload.garage.spaces ?? null,
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
        // The cars this lane refuses (0033, U7f): each ban that reaches this
        // garage, by its id and the car's descriptor. The lane compares an
        // arriving car's descriptor against these the way the exit search
        // compares them, and refuses a match with reason `banned`.
        banned: payload.banned,
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
          eventId: laneEventId(e.event_id, 'every event_id'),
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
      // Exactly one of plate or ticket_ref -- or, on an open only, a plate
      // nobody could read (0036). A lane that sends only a plate is an older
      // lane and is unchanged by this; a lane that sends a ticket is the
      // intercom completing an identity for a driver the camera could not
      // read; a lane that sends `plate_unreadable` is recording a car its
      // loops saw go in, which is a stay whatever opened the barrier.
      const { plate, ticketRef, plateUnreadable } = laneIdentity(req.body, { unreadable: true });
      const entryConfirmation = confirmation(req.body?.entry_confirmation, 'entry_confirmation');
      // A car through the gate that no open command let in, identified at the
      // closing loop (U7f; and, since the owner's rule of 2026-10-26, read or
      // not): a stay like any other, which pays at the exit -- and, where the
      // garage bans tailgaters, a car on its list.
      const tailgaterSaid = req.body?.tailgater ?? false;
      if (typeof tailgaterSaid !== 'boolean') throw bad('tailgater must be true or false when given');
      // NEVER A CAR NOBODY COULD READ (0036): `tailgater` is a car no vend let
      // in whose plate was read. An unread open that says otherwise is stored
      // as not one -- the stay is never refused over it -- so no unread car is
      // a tailgater in the data, whatever a lane sent.
      const tailgater = tailgaterSaid && !plateUnreadable;
      // A car the lane's loops saw go in that no open command let in (0036),
      // read or not. Its own field: `tailgater` above keeps its own meaning.
      const noOpenCommand = req.body?.no_open_command ?? false;
      if (typeof noOpenCommand !== 'boolean') throw bad('no_open_command must be true or false when given');
      // What was read of an unread car's plate below the lane's confidence
      // (0036): kept, never an identity.
      const unsure = unsurePlateFields(req.body, { plateUnreadable });
      // The ID the exit finds this stay by (0037): the positioned plate
      // characters, the colour code, the size. Each optional; an older lane
      // sends none and its stays are found by their plate.
      const entryId = exits.idFields(req.body);
      // Required, not optional. Without it there is no key to be idempotent on
      // and the only thing left to check is state -- which is exactly how a
      // replay arriving after the car has left opens a second, phantom session.
      if (!openEventId) throw bad('event_id is required');
      // AND OF ONE SHAPE (0036): it is the key an unread car's vehicle is held
      // under -- never an object coerced to text, never `redacted:...`, never
      // a device token's worth (`LANE_EVENT_ID_SHAPE`).
      laneEventId(openEventId);
      const entryAt = refuseFuture(parseTime(req.body?.entry_at, 'entry_at'), 'entry_at');

      // THE GATE (0014): an inactive garage opens no stay. Recorded, then
      // refused -- in that order, because the lane drops the 409.
      const garage = await activeGarageOrRefuse({
        tenantId, garageId, laneId, laneEventId: String(openEventId), action: 'open', at: entryAt,
      });

      const result = await withTenant(tenantId, async (client) => {
        const vehicle = await repo.upsertVehicle(client, tenantId, {
          plate,
          ticketRef,
          // The one stay this unread car is (0036): keyed on the open's own
          // event id, so its replay is its row and a second car is another.
          unreadRef: plateUnreadable ? String(openEventId) : null,
          plateRegion, seenAt: entryAt, make, model, color, attributes,
        });
        const opened = await repo.openSession(client, tenantId, {
          garageId,
          vehicleId: vehicle.id,
          laneId,
          entryAt,
          currency: garage.currency,
          openEventId: String(openEventId),
          entryConfirmation,
          entryDescriptor,
          tailgater,
          noOpenCommand,
          entryUnsurePlate: unsure.plate,
          entryUnsurePlateConfidence: unsure.confidence,
          entryId,
        });
        if (opened.created) await bans.listIfBanned(client, tenantId, { garage, session: opened.session, vehicle });
        // A stay of this car the new entry ended (0039), or this open itself
        // stored ended because a later stay of the car is already here.
        const endedNow = [...opened.superseded, ...(opened.created && opened.session.ended ? [opened.session] : [])];
        if (endedNow.length) {
          await repo.appendEvents(client, tenantId, endedNow.map((s) => ({
            garageId,
            laneId,
            eventId: `${stuck.STAY_ENDED_EVENT_KIND}:${s.id}`,
            kind: stuck.STAY_ENDED_EVENT_KIND,
            occurredAt: s.exit_at,
            detail: { actor: 'platform:open', session_id: s.id, reason: 'superseded', by_session: s.ended.by_session, exit_at: s.exit_at },
          })));
        }
        return opened;
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
   * A PICTURE KEPT WITH AN ENTRY (0033, U7f). Body:
   *   {picture_ref, event_id, taken_at, image}
   * `image` is the picture as base64, a JPEG or a PNG by its first bytes, at
   * most PICTURE_MAX_BYTES; `event_id` is the lane's id of the entry record it
   * belongs to (a stay's open, a crossing no car made, a banned car
   * refused); `picture_ref` is the lane's own id for it, so a resend is the
   * same picture. Kept 30 days after the car left, and only as it is once
   * decoded and written fresh (src/bans.js).
   */
  lane.post('/pictures', readPicture, async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId } = req.device;
      const body = req.body ?? {};
      const text = (value, label, max) => {
        if (typeof value !== 'string' || value.length === 0 || value.length > max) {
          throw bad(`${label} is required, a string of at most ${max} characters`);
        }
        return value;
      };
      const pictureRef = text(body.picture_ref, 'picture_ref', 64);
      const eventId = text(body.event_id, 'event_id', 200);
      const takenAt = refuseFuture(parseTime(body.taken_at, 'taken_at'), 'taken_at');
      if (typeof body.image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image)) {
        throw bad('image is required, base64');
      }
      const image = Buffer.from(body.image, 'base64');
      if (image.length === 0 || image.length > bans.PICTURE_MAX_BYTES) {
        throw bad(`image must be at most ${bans.PICTURE_MAX_BYTES} bytes`);
      }
      const contentType = bans.pictureType(image);
      if (!contentType) throw bad('image must be a JPEG or a PNG');
      const fresh = await bans.freshPicture(image, contentType);
      if (!fresh) throw bad(`image does not open as a JPEG or a PNG of at most ${bans.PICTURE_MAX_PIXELS} pixels`);
      if (fresh.length > bans.PICTURE_MAX_BYTES) {
        throw bad(`image is more than ${bans.PICTURE_MAX_BYTES} bytes once written fresh`);
      }
      const { created } = await withTenant(tenantId, (client) =>
        bans.storePicture(client, tenantId, { garageId, laneId, pictureRef, eventId, takenAt, contentType, image: fresh }));
      res.status(created ? 201 : 200).json({ picture_ref: pictureRef, event_id: eventId, created });
    } catch (err) {
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
      // Not tried twice when the database connection is lost (src/db.js): the
      // door commits in its own database, and a second try would ask it again.
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
      }, { retry: false });
      res.status(200).json({ validation: presentClaim(out) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * THE EXIT CASE (0037). The car is on the exit's arming loop and the lane
   * could not let it out on its own copy (a pass it holds, or nothing to
   * pay): which stay is it, and what does it owe? Body:
   *
   *   {event_id, exit_at, plate_characters?, color_code?, size?, session_id?}
   *
   * `session_id`: the lane matched the stay itself. Otherwise the platform
   * finds it by the ID (src/exitMatch.js): one clear stay; or a few, and the
   * picker chooses by pictures -- the lane's pictures under this `event_id`
   * and each candidate's entry pictures -- within its time limit; or none.
   * A matched stay is priced here, the modules asked first; the fee is what
   * the lane shows and what is paid. 201 with the case; a resend of the
   * same `event_id` is the same case (200), and the picker is never asked
   * twice for one car.
   */
  lane.post('/exits', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      if (direction !== 'exit') throw conflict('wrong_lane_direction', 'this device is not on an exit lane');
      const body = req.body ?? {};
      if (!body.event_id) throw bad('event_id is required');
      const eventId = String(laneEventId(body.event_id));
      const exitAt = refuseFuture(parseTime(body.exit_at, 'exit_at'), 'exit_at');
      const id = exits.idFields(body);
      const namedStay = exits.uuidField(body.session_id, 'session_id');
      const garage = await activeGarageOrRefuse({ tenantId, garageId, laneId, laneEventId: eventId, action: 'close', at: exitAt });

      const staged = await withTenant(tenantId, async (client) => {
        const already = await exits.caseByEvent(client, tenantId, eventId);
        if (already) return { already };
        if (namedStay) {
          const open = await repo.findOpenSessionById(client, tenantId, garageId, namedStay);
          if (!open) throw conflict('stay_not_open', 'the named stay is not open in this garage');
          return { method: 'lane', sessionId: open.id, candidates: [] };
        }
        const stays = await exits.openStaysForMatch(client, tenantId, garageId, exitAt);
        const found = exitMatch.match(id, stays);
        if (found.kind === 'single') return { method: 'single', sessionId: found.stay, candidates: [found.stay] };
        if (found.kind === 'none') return { method: 'none', candidates: [] };
        const byId = new Map(stays.map((s) => [s.id, s]));
        const exitPictures = await exits.picturesOf(client, tenantId, eventId, exitPicker.PICTURES_PER_CAR);
        const candidates = [];
        for (const sid of found.candidates) {
          candidates.push({ session_id: sid, pictures: await exits.picturesOf(client, tenantId, byId.get(sid).open_event_id, exitPicker.PICTURES_PER_CAR) });
        }
        return { few: { exitPictures, candidates } };
      });
      if (staged.already) return res.status(200).json({ exit: exits.present(staged.already) });

      // THE PICKER, outside any transaction: nothing is held while a car waits
      // on an answer from the network.
      let method = staged.method;
      let sessionId = staged.sessionId ?? null;
      let candidates = staged.candidates;
      let picker = null;
      if (staged.few) {
        const { exitPictures, candidates: shown } = staged.few;
        candidates = shown.map((c) => c.session_id);
        const settings = exitPicker.readPickerSettings();
        const pictures = { exit: exitPictures.map((p) => p.id), candidates: shown.map((c) => c.pictures.map((p) => p.id)) };
        if (!settings.on) {
          picker = { outcome: 'off' };
        } else if (exitPictures.length === 0 || shown.some((c) => c.pictures.length === 0)) {
          // A candidate it cannot see is one it can never choose: asking would
          // let it choose the wrong one with the right one hidden.
          picker = { outcome: 'not_asked', reason: 'a car without pictures', pictures };
        } else {
          const asked = await exitPicker.pick(settings, { exitPictures, candidates: shown });
          picker = { outcome: asked.outcome, answer: asked.answer, model: asked.model, elapsed_ms: asked.elapsed_ms, pictures };
          if (asked.outcome === 'picked') sessionId = asked.chosen;
        }
        method = sessionId ? 'picker' : 'none';
      }

      // A CASE ALREADY OPEN FOR THE SAME STAY (0045) is superseded, never a
      // second open case: its open payment is canceled at Stripe first,
      // outside any transaction, and the case is closed in the one that
      // writes this one. A payment started on it in between: asked again.
      let out = null;
      for (let attempt = 1; !out; attempt += 1) {
        if (sessionId) await settlePriorCase({ tenantId, garageId, sessionId, eventId });
        out = await withTenant(tenantId, (client) => writeCase(client)).catch((err) => {
          if (!(err instanceof PriorCaseMoved)) throw err;
          if (attempt >= PRIOR_CASE_ATTEMPTS) throw paymentUnsettled();
          return null;
        });
      }
      res.status(out.created ? 201 : 200).json({ exit: exits.present(out.row) });

      async function writeCase(client) {
        const already = await exits.caseByEvent(client, tenantId, eventId);
        if (already) return { row: already, created: false };
        let quote = null;
        let prior = null;
        if (sessionId) {
          // The stay's open case, then the stay: a case is locked before its
          // stay everywhere (the close's order), so nobody waits crosswise.
          [prior = null] = await exits.openCasesOfStay(client, tenantId, sessionId, { lock: true });
          const open = await repo.findOpenSessionById(client, tenantId, garageId, sessionId);
          if (open) {
            await repo.lockOpenStay(client, tenantId, garageId, sessionId);
            const [now = null] = await exits.openCasesOfStay(client, tenantId, sessionId);
            if (now?.id !== prior?.id) throw new PriorCaseMoved();
            if (prior?.payment?.status === 'open') throw new PriorCaseMoved();
            const paid = prior ? exits.paidFor(prior) : null;
            if (paid) {
              // PAID AT THE CASE IT SUPERSEDES: "I paid, the gate didn't
              // open" -- the paid stay opens, on the fee it paid.
              quote = { ...prior.quote, paid_at_exit: prior.id };
            } else {
              const vehicle = await exits.vehicleOf(client, tenantId, open.vehicle_id);
              quote = await quoteStay(client, { tenantId, garage, laneId, session: open, vehicle, exitAt });
            }
          } else {
            method = 'none';
            sessionId = null;
            prior = null;
          }
        }
        const caseId = prior ? randomUUID() : null;
        if (prior) {
          await exits.endCase(client, tenantId, prior.id, { why: 'superseded', by_exit: caseId });
          await recordSuperseded(client, { tenantId, garageId, laneId, deviceId: req.device.deviceId, prior, caseId, at: exitAt });
        }
        const written = await exits.insertCase(client, tenantId, {
          garageId, laneId, eventId, exitAt, id, method, sessionId, candidates, picker, quote, caseId,
        });
        if (written.created && method === 'none') {
          await repo.appendEvents(client, tenantId, [{
            garageId,
            laneId,
            eventId: `${exits.UNMATCHED_EVENT_KIND}:${written.row.id}`,
            kind: exits.UNMATCHED_EVENT_KIND,
            occurredAt: exitAt,
            detail: { actor: 'platform:exit', exit_id: written.row.id, candidates: candidates.length, picker: picker?.outcome ?? null },
          }]);
        }
        return written;
      }
    } catch (err) {
      next(err);
    }
  });

  /** The case as it stands: what the lane polls while the driver pays or a person decides. */
  lane.get('/exits/:exitId', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      if (direction !== 'exit') throw conflict('wrong_lane_direction', 'this device is not on an exit lane');
      const row = await withTenant(tenantId, (client) => exits.caseById(client, tenantId, garageId, req.params.exitId));
      if (!row) throw new HttpError(404, 'exit case not found', 'exit_not_found');
      if (row.lane_id !== laneId) throw conflict('exit_on_another_lane', 'this exit case is at another lane');
      res.json({ exit: exits.present(await refreshPayment(tenantId, garageId, row)) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * THE DRIVER'S WORD. No stay was found for the car; the driver says when
   * it came in, `{entry_at}` with its offset (one without is refused, 400
   * `entry_time_without_offset`), and the engine prices that stay by the
   * garage's own rules. Kept on the case with the pictures; the attendants
   * on duty are told (`exit_driver_word`). No later than the exit, no more
   * than WORD_MAX_DAYS before it; said once.
   */
  lane.post('/exits/:exitId/word', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      if (direction !== 'exit') throw conflict('wrong_lane_direction', 'this device is not on an exit lane');
      const claimed = driverTime(req.body?.entry_at, 'entry_at');
      const out = await withTenant(tenantId, async (client) => {
        const row = await exits.caseById(client, tenantId, garageId, req.params.exitId, { lock: true });
        if (!row) throw new HttpError(404, 'exit case not found', 'exit_not_found');
        // The case's own lane only: a driver's word is said where the car is.
        if (row.lane_id !== laneId) throw conflict('exit_on_another_lane', 'this exit case is at another lane');
        if (row.method !== 'none' || row.closed_at) {
          throw conflict('word_not_wanted', 'the driver is asked for an entry time only when no stay was found, once');
        }
        const exitAt = row.exit_at;
        if (claimed > exitAt) throw conflict('word_after_exit', 'the entry time said is after the car reached the exit');
        if (exitAt - claimed > exits.WORD_MAX_DAYS * 86_400_000) {
          throw conflict('word_too_old', `the entry time said is more than ${exits.WORD_MAX_DAYS} days before the exit`);
        }
        const garage = await repo.getGarage(client, tenantId, garageId);
        const session = { entry_at: claimed, currency: garage.currency, occupancy_at_entry_bp: null };
        const quote = await quoteStay(client, { tenantId, garage, laneId, session, vehicle: null, exitAt });
        const updated = await exits.recordWord(client, tenantId, row.id, { claimedEntryAt: claimed, quote });
        await repo.appendEvents(client, tenantId, [{
          garageId,
          laneId,
          eventId: `${exits.DRIVER_WORD_EVENT_KIND}:${row.id}`,
          kind: exits.DRIVER_WORD_EVENT_KIND,
          occurredAt: new Date(),
          detail: {
            actor: 'platform:exit',
            exit_id: row.id,
            claimed_entry_at: claimed.toISOString(),
            exit_at: exitAt.toISOString(),
            fee_minor: quote.fee_minor,
            currency: quote.currency,
            refused: Boolean(quote.refusal),
          },
        }]);
        return updated;
      });
      res.json({ exit: exits.present(out) });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PAYING AT THE EXIT (0038, src/exitPayments.js). One PaymentIntent per
  // case for the case's own fee, on the garage's account; the lane's reader
  // or an attendant's phone takes the card; the case is settled when Stripe
  // says the intent succeeded for that amount.
  // -------------------------------------------------------------------------

  const paidEvent = (client, tenantId, row, payment) => repo.appendEvents(client, tenantId, [{
    garageId: row.garage_id,
    laneId: row.lane_id,
    eventId: `${exitPayments.PAID_EVENT_KIND}:${payment.id}`,
    kind: exitPayments.PAID_EVENT_KIND,
    occurredAt: new Date(),
    detail: {
      actor: 'platform:exit',
      exit_id: row.id,
      amount_minor: payment.amount_minor,
      currency: payment.currency,
      payment_intent_id: payment.payment_intent_id,
      channel: payment.channel,
    },
  }]);

  /** What Stripe says of the case's intent, written down; the case as it now stands. */
  const recordIntent = (tenantId, garageId, exitId, intent, readerId = null) => withTenant(tenantId, async (client) => {
    const row = await exits.caseById(client, tenantId, garageId, exitId, { lock: true });
    let payment = await exitPayments.paymentOf(client, tenantId, exitId);
    if (readerId) payment = await exitPayments.recordReader(client, tenantId, payment, readerId);
    const written = await exitPayments.recordIntent(client, tenantId, payment, intent);
    if (written.paidNow) await paidEvent(client, tenantId, row, written.row);
    return exits.caseById(client, tenantId, garageId, exitId);
  });

  /**
   * Start the payment of a case's fee, or carry on with the one it has.
   * `lane_reader`: the intent is handed to the lane's bound reader whenever
   * it is waiting for a card -- the first time, and again after a decline.
   * `phone_reader`: the intent's client secret is answered for the phone to
   * collect. Never a second intent for a case.
   */
  async function payCase({ tenantId, garageId, exitId, channel, laneId = null, actor, record = null }) {
    const config = stripeAccount.requireConnect();
    const staged = await withTenant(tenantId, async (client) => {
      const row = await exits.caseById(client, tenantId, garageId, exitId, { lock: true });
      if (!row) throw new HttpError(404, 'exit case not found', 'exit_not_found');
      if (row.closed_at) throw conflict('exit_closed', 'the car has already left: this case is closed');
      const owed = exits.settledOf(row);
      if (owed.settled) throw conflict('exit_settled', `there is nothing to pay: this exit is settled (${owed.why})`);
      if (owed.needs !== 'payment') {
        throw conflict('nothing_to_pay_yet', `this exit needs ${owed.needs === 'driver_word' ? "the driver's word" : 'a person'} before a payment`);
      }
      let reader = null;
      if (channel === 'lane_reader') {
        if (row.lane_id !== laneId) throw conflict('exit_on_another_lane', 'this exit case is at another lane');
        reader = await exitPayments.boundReader(client, tenantId, laneId);
        if (!reader) throw conflict('no_reader_bound', 'this lane has no card reader bound');
      }
      const existing = await exitPayments.paymentOf(client, tenantId, row.id);
      if (existing?.status === 'canceled') {
        throw conflict('payment_canceled', "this case's payment was canceled and is not taken again; a person decides");
      }
      const accountId = existing?.account_id ?? reader?.account_id ?? (await exitPayments.garageAccount(client, tenantId, garageId));
      if (!accountId) throw conflict('no_payment_account', 'this garage has no Stripe account to take a card on');
      if (reader && reader.account_id !== accountId) {
        throw conflict('reader_on_another_account', "the lane's reader is on another Stripe account than this payment");
      }
      return { row, reader, accountId, existing };
    });

    let intent = null;
    let payment = staged.existing;
    if (!payment) {
      const q = staged.row.quote;
      try {
        intent = await exitPayments.createIntent(config, staged.accountId,
          exitPayments.intentBody({ amountMinor: q.fee_minor, currency: q.currency, exitId, garageId }), exitId);
      } catch (err) {
        if (err instanceof StripeError && err.code === 'amount_too_small') {
          throw conflict('fee_below_card_minimum', 'the fee is below the least a card can be charged; a person decides');
        }
        throw err;
      }
      if (typeof intent?.id !== 'string') throw new StripeUnreachable('Stripe answered an intent with no id');
      const written = await withTenant(tenantId, async (client) => {
        // Under the case's lock, as the close takes it: a case closed since
        // it was read gets no payment, and its new intent is canceled below.
        const fresh = await exits.caseById(client, tenantId, garageId, exitId, { lock: true });
        if (fresh.closed_at) return { closedMeanwhile: true };
        const w = await exitPayments.insertPayment(client, tenantId, {
          garageId, exitId, sessionId: staged.row.session_id, channel, readerId: staged.reader?.reader_id ?? null,
          accountId: staged.accountId, intentId: intent.id, amountMinor: q.fee_minor,
          currency: String(q.currency).toLowerCase(), stripeStatus: String(intent.status).slice(0, 40), startedBy: actor,
        });
        if (w.created) {
          await repo.appendEvents(client, tenantId, [{
            garageId,
            laneId: staged.row.lane_id,
            eventId: `${exitPayments.PAYMENT_STARTED_EVENT_KIND}:${w.row.id}`,
            kind: exitPayments.PAYMENT_STARTED_EVENT_KIND,
            occurredAt: new Date(),
            detail: { actor, exit_id: exitId, amount_minor: w.row.amount_minor, currency: w.row.currency, channel },
          }]);
          await record?.(client, {
            garageId, action: 'exit.payment_start',
            subject: { kind: 'exit', id: exitId, name: null },
            before: { payment: null },
            after: { payment: 'started', amount_minor: w.row.amount_minor, currency: w.row.currency, channel },
          });
        }
        return w;
      });
      if (written.closedMeanwhile) {
        await exitPayments.cancelIntent(config, staged.accountId, intent.id, exitPayments.cancelKey(intent)).catch(() => {});
        throw conflict('exit_closed', 'the car has already left: this case is closed');
      }
      payment = written.row;
      if (payment.payment_intent_id !== intent.id) {
        // Another request for this case wrote its intent first (past the
        // idempotency key's 24 hours): this one is never used.
        await exitPayments.cancelIntent(config, staged.accountId, intent.id, exitPayments.cancelKey(intent)).catch(() => {});
        intent = null;
      }
    }
    if (!intent) intent = await exitPayments.readIntent(config, payment.account_id, payment.payment_intent_id);

    let sent = channel === 'lane_reader' ? false : null;
    if (channel === 'lane_reader' && intent.status === 'requires_payment_method') {
      sent = await sendToLaneReader({ config, tenantId, garageId, exitId, payment, readerId: staged.reader.reader_id });
      if (sent === false) intent = await exitPayments.readIntent(config, payment.account_id, payment.payment_intent_id);
    }
    const row = await recordIntent(tenantId, garageId, exitId, intent, channel === 'lane_reader' ? staged.reader.reader_id : null);
    return { row, sent, clientSecret: channel === 'phone_reader' ? intent.client_secret : undefined };
  }

  /**
   * HAND THE CASE'S INTENT TO THE LANE'S READER. Stripe refuses while the
   * reader is busy (`terminal_reader_busy`), and the reader is read to see
   * with what:
   *   this intent     already on it, waiting for the card: sent;
   *   another case's  a payment of a case that is not this one -- a car
   *                   gone whose cancel did not land -- is canceled at
   *                   Stripe and cleared from the reader FIRST, so this
   *                   driver can never pay another car's fee; one that
   *                   succeeded is never canceled. Then sent again, once;
   *   anything else   an action this platform did not start: 409
   *                   reader_busy, nothing touched.
   * A card being authorised on another case's intent is never cut off: 409
   * reader_busy, ask again.
   */
  async function sendToLaneReader({ config, tenantId, garageId, exitId, payment, readerId }) {
    const send = async () => (await exitPayments.sendToReader(config, payment.account_id, readerId, payment.payment_intent_id)).sent;
    const busy = (why) => new stripeAccount.ConnectRefusal(409, 'reader_busy', why);
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof stripeAccount.ConnectRefusal && err.code === 'reader_busy')) throw err;
    }
    const action = await exitPayments.readerAction(config, payment.account_id, readerId);
    if (action?.status !== 'in_progress' || !action.intent) {
      throw busy("the lane's card reader is busy with another action; cancel it or wait");
    }
    if (action.intent === payment.payment_intent_id) return true;
    const held = await withTenant(tenantId, async (client) => {
      const p = await exitPayments.paymentByIntent(client, tenantId, action.intent);
      if (!p || p.garage_id !== garageId || p.exit_id === exitId) return null;
      return exits.caseById(client, tenantId, garageId, p.exit_id);
    });
    if (!held) throw busy("the lane's card reader is busy with a payment this platform did not start; cancel it or wait");
    if (held.payment.status === 'succeeded') {
      throw busy("the lane's card reader is finishing another car's payment, which has paid; wait");
    }
    try {
      if (held.payment.status === 'canceled') {
        await exitPayments.clearReader(config, payment.account_id, readerId);
      } else {
        // Paid in the instant before the cancel: recorded paid, never
        // canceled; its action is over and the reader is free.
        await cancelPayment(tenantId, garageId, held, { why: 'reader_needed' });
      }
    } catch (err) {
      if (err instanceof StripeUnreachable) throw err;
      if (err.code === 'payment_in_progress' || err.code === 'reader_busy' || err.code === 'payment_amount_mismatch'
        || err instanceof StripeError || err instanceof stripeAccount.ConnectRefusal) {
        throw busy("a card is being authorised on the lane's reader for another car's payment; ask again in a few seconds");
      }
      throw err;
    }
    try {
      return await send();
    } catch (err) {
      if (err instanceof stripeAccount.ConnectRefusal && err.code === 'reader_busy') {
        throw busy("the lane's card reader is still busy; ask again in a few seconds");
      }
      throw err;
    }
  }

  /**
   * While the lane polls a case whose payment is open, Stripe is asked how
   * the intent stands, at most once every READ_EVERY_MS. Stripe out of reach
   * is not a failed poll: the case is answered as last recorded.
   */
  async function refreshPayment(tenantId, garageId, row) {
    const p = row.payment;
    if (!p || p.status !== 'open') return row;
    if (p.read_at && Date.now() - new Date(p.read_at).getTime() < exitPayments.READ_EVERY_MS) return row;
    const config = connectConfig();
    if (!config.key) return row;
    let intent;
    try {
      intent = await exitPayments.readIntent(config, p.account_id, p.payment_intent_id);
    } catch (err) {
      if (err instanceof StripeUnreachable || err instanceof StripeError) return row;
      throw err;
    }
    return recordIntent(tenantId, garageId, row.id, intent);
  }

  /**
   * CANCEL A CASE'S OPEN PAYMENT AT STRIPE: the lane let the case go, or a
   * person let the car out. Answers `{row, outcome}`:
   *   canceled  Stripe says the intent is canceled: no card can be taken;
   *   paid      Stripe says it succeeded: recorded paid, nothing refunded;
   *   none      the case has no payment.
   * A card being authorised (`payment_in_progress`) or Stripe not answering
   * (`StripeUnreachable`) is thrown with nothing recorded but what Stripe
   * said, so asking again is safe. The reader is cleared only while it shows
   * this intent: a later car's payment on the same reader is never touched.
   */
  async function cancelPayment(tenantId, garageId, row, { why }) {
    const p = row.payment;
    if (!p) return { row, outcome: 'none' };
    if (p.status === 'succeeded') return { row, outcome: 'paid' };
    if (p.status === 'canceled') return { row, outcome: 'canceled' };
    const config = connectConfig();
    if (!config.key) throw new StripeUnreachable('Stripe is not configured: the open payment cannot be canceled');
    if (p.reader_id) {
      let onReader = null;
      try {
        onReader = await exitPayments.readerIntent(config, p.account_id, p.reader_id);
      } catch (err) {
        if (!(err instanceof StripeError)) throw err;
      }
      if (onReader === p.payment_intent_id) {
        try {
          await exitPayments.clearReader(config, p.account_id, p.reader_id);
        } catch (err) {
          if (err instanceof stripeAccount.ConnectRefusal && err.code === 'reader_busy') {
            throw conflict('payment_in_progress', 'a card is being authorised for this exit: ask again in a few seconds');
          }
          if (!(err instanceof stripeAccount.ConnectRefusal || err instanceof StripeError)) throw err;
        }
      }
    }
    let intent = await exitPayments.readIntent(config, p.account_id, p.payment_intent_id);
    if (exitPayments.CANCELABLE.has(intent.status)) {
      try {
        intent = await exitPayments.cancelIntent(config, p.account_id, p.payment_intent_id, exitPayments.cancelKey(intent));
      } catch (err) {
        if (!(err instanceof StripeError)) throw err;
        intent = await exitPayments.readIntent(config, p.account_id, p.payment_intent_id);
      }
    }
    const updated = await recordIntent(tenantId, garageId, row.id, intent);
    const status = updated.payment?.status;
    if (status === 'succeeded') return { row: updated, outcome: 'paid' };
    if (intent.status === 'succeeded') {
      throw conflict('payment_amount_mismatch', "Stripe took an amount other than this case's fee: a person decides");
    }
    if (status !== 'canceled') {
      throw conflict('payment_in_progress', 'a card is being authorised for this exit: ask again in a few seconds');
    }
    await withTenant(tenantId, (client) => repo.appendEvents(client, tenantId, [{
      garageId,
      laneId: row.lane_id,
      eventId: `${exitPayments.PAYMENT_CANCELED_EVENT_KIND}:${p.id}`,
      kind: exitPayments.PAYMENT_CANCELED_EVENT_KIND,
      occurredAt: new Date(),
      detail: { actor: 'platform:exit', exit_id: row.id, payment_intent_id: p.payment_intent_id, why },
    }]));
    return { row: updated, outcome: 'canceled' };
  }

  /** A 503 the lane retries: its outbox sends a 5xx close again, and dead-letters a 4xx. */
  const paymentUnsettled = () => new HttpError(503,
    "the exit case's payment could not be settled with Stripe now; send the close again", 'payment_unsettled');

  /** Stripe could not settle a payment now: out of reach, or a card being authorised. */
  const notSettledNow = (err) => err instanceof StripeUnreachable || err instanceof StripeError
    || err instanceof stripeAccount.ConnectRefusal || err.code === 'payment_in_progress';

  /**
   * BEFORE A NEW CASE SUPERSEDES THE STAY'S OPEN ONE (0045): that case's open
   * payment is canceled at Stripe, or found paid -- never a card left that
   * can still be taken for a case nobody is at. A card being authorised on
   * it, or Stripe out of reach: 503, nothing written, and the lane sends
   * the case again. Stripe having taken another amount than the fee: a
   * person decides (409).
   */
  async function settlePriorCase({ tenantId, garageId, sessionId, eventId }) {
    const [prior = null] = await withTenant(tenantId, (client) => exits.openCasesOfStay(client, tenantId, sessionId));
    if (!prior || prior.event_id === eventId || prior.payment?.status !== 'open') return;
    try {
      await cancelPayment(tenantId, garageId, prior, { why: 'superseded' });
    } catch (err) {
      if (err.code === 'payment_amount_mismatch') {
        throw conflict('prior_payment_amount_mismatch',
          "Stripe took another amount than the fee at this car's earlier exit case: a person decides");
      }
      if (notSettledNow(err)) throw paymentUnsettled();
      throw err;
    }
  }

  /**
   * THE SUPERSEDING, IN THE CHANGE LOG: by the lane computer whose case took
   * the old one's place, naming both cases, the stay and how the old
   * payment stood. Ids only: no plate.
   */
  async function recordSuperseded(client, { tenantId, garageId, laneId, deviceId, prior, caseId, at }) {
    const { rows } = await client.query('SELECT name FROM lane_devices WHERE tenant_id = $1 AND id = $2', [tenantId, deviceId]);
    const ctx = { tenantId, actor: { kind: 'computer', id: deviceId, name: rows[0]?.name ?? null }, count: 0, secrets: [], private: [] };
    const paid = exits.paidFor(prior);
    await changes.record(client, ctx, {
      garageId,
      action: 'exit.superseded',
      subject: { kind: 'exit', id: prior.id, name: null },
      before: { open: true, lane_id: prior.lane_id },
      after: {
        open: false,
        superseded_by: caseId,
        lane_id: laneId,
        stay_id: prior.session_id,
        payment: paid ? 'succeeded' : prior.payment?.status ?? null,
        paid_minor: paid?.amount_minor ?? null,
      },
    });
    await repo.appendEvents(client, tenantId, [{
      garageId,
      laneId: prior.lane_id,
      eventId: `${exits.SUPERSEDED_EVENT_KIND}:${prior.id}`,
      kind: exits.SUPERSEDED_EVENT_KIND,
      occurredAt: at,
      detail: { actor: `lane_device:${deviceId}`, exit_id: prior.id, by_exit: caseId, stay_id: prior.session_id, paid: Boolean(paid) },
    }]);
  }

  /**
   * BEFORE A CASE'S CLOSE: an open payment is canceled at Stripe, or found
   * paid, so the stay is written as one or the other -- never let out unpaid
   * with a card that can still be taken. Stripe not answering, or a card
   * being authorised: 503, nothing written, and the lane sends it again.
   */
  async function settleBeforeClose(tenantId, garageId, exitId) {
    const row = await withTenant(tenantId, (client) => exits.caseById(client, tenantId, garageId, exitId));
    if (!row || row.closed_at || row.payment?.status !== 'open') return;
    try {
      await cancelPayment(tenantId, garageId, row, { why: 'let_out_at_lane' });
    } catch (err) {
      if (err instanceof StripeUnreachable || err instanceof StripeError || err instanceof stripeAccount.ConnectRefusal
        || err.code === 'payment_in_progress' || err.code === 'payment_amount_mismatch') {
        throw paymentUnsettled();
      }
      throw err;
    }
  }

  /**
   * WHO LET THE CAR OUT AT THE LANE: a line in the change log, by the lane
   * computer the person used, naming the case and the stay -- when the lane
   * says a person opened (`let_out_by`), or the case closes owing and no
   * attendant had already decided it (theirs is the line they wrote).
   */
  async function recordLetOutAtLane(client, { tenantId, garageId, deviceId, exitCase, letOut, letOutBy }) {
    if (exitCase.person || (!letOutBy && !letOut)) return;
    const { rows } = await client.query('SELECT name FROM lane_devices WHERE tenant_id = $1 AND id = $2', [tenantId, deviceId]);
    const ctx = { tenantId, actor: { kind: 'computer', id: deviceId, name: rows[0]?.name ?? null }, count: 0, secrets: [], private: [] };
    await changes.record(client, ctx, {
      garageId,
      action: 'exit.let_out',
      subject: { kind: 'exit', id: exitCase.id, name: null },
      before: { let_out: false },
      after: {
        let_out: true,
        at_lane: true,
        authority: letOutBy,
        flagged: letOutBy === exits.FLAGGED_AUTHORITY,
        stay_id: exitCase.session_id,
        paid: Boolean(exits.paidFor(exitCase)),
        owed_minor: letOut?.owed_minor ?? null,
        currency: letOut?.currency ?? exitCase.quote?.currency ?? null,
        payment: (exitCase.payment ?? exits.paidFor(exitCase))?.status ?? null,
      },
    });
  }

  /**
   * A person let the car out while its payment was open: the intent is
   * canceled so no card is taken for an exit already settled. If Stripe says
   * it had already succeeded, that is recorded instead -- paid and let out.
   * After the person's decision is written, never in its way: a payment left
   * open here is settled by the case's close, which cancels before it writes.
   */
  async function cancelForPerson(tenantId, garageId, row) {
    try {
      return (await cancelPayment(tenantId, garageId, row, { why: 'let_out_by_person' })).row;
    } catch (err) {
      if (err instanceof StripeUnreachable || err instanceof StripeError || err instanceof stripeAccount.ConnectRefusal
        || err.code === 'payment_in_progress' || err.code === 'payment_amount_mismatch') return row;
      throw err;
    }
  }

  /**
   * PAY AT THE LANE'S READER. The case's fee goes to the reader bound to
   * this lane; the driver presents a card there. Sent again on a resend
   * while the intent waits for a card (a decline, the driver's cancel), never
   * a second intent. The lane then polls the case; it opens on `settled`.
   * `sent` is true, false (the intent was not waiting for a card: paid or
   * paying), or "unknown" (the reader did not acknowledge in time; it may
   * have it -- the poll says).
   */
  lane.post('/exits/:exitId/pay', connectRoute(async (req, res) => {
    const { tenantId, garageId, laneId, direction } = req.device;
    if (direction !== 'exit') throw conflict('wrong_lane_direction', 'this device is not on an exit lane');
    const { row, sent } = await payCase({
      tenantId, garageId, exitId: req.params.exitId, channel: 'lane_reader', laneId, actor: `lane_device:${req.device.deviceId}`,
    });
    res.json({ exit: exits.present(row), sent });
  }));

  /**
   * CANCEL THE CASE'S PAYMENT: the car left, the next car came, or a person
   * opened at the lane. The intent is canceled at Stripe and the reader
   * cleared while it shows it. Asked again, the same answer: canceled, with
   * no second call to Stripe. A card that had already paid is never refunded
   * or voided here: 409 `exit_paid`, and the case is settled as paid. A card
   * being authorised: 409 `payment_in_progress`, ask again. Stripe not
   * answering: 503, nothing recorded, ask again.
   */
  lane.post('/exits/:exitId/pay/cancel', connectRoute(async (req, res) => {
    const { tenantId, garageId, laneId, direction } = req.device;
    if (direction !== 'exit') throw conflict('wrong_lane_direction', 'this device is not on an exit lane');
    stripeAccount.requireConnect();
    const row = await withTenant(tenantId, (client) => exits.caseById(client, tenantId, garageId, req.params.exitId));
    if (!row) throw new HttpError(404, 'exit case not found', 'exit_not_found');
    if (row.lane_id !== laneId) throw conflict('exit_on_another_lane', 'this exit case is at another lane');
    if (!row.payment) throw conflict('no_payment', 'this exit case has no payment to cancel');
    const out = await cancelPayment(tenantId, garageId, row, { why: 'lane_cancel' });
    if (out.outcome === 'paid') {
      throw conflict('exit_paid', 'the card had already paid: nothing was canceled, and the exit is settled as paid');
    }
    res.json({ exit: exits.present(out.row), canceled: true });
  }));

  /**
   * A TEXT RECEIPT for a paid exit, `{phone}`: to a US or Canadian number
   * only; any other is refused and nothing is sent. Once per payment. The
   * number is kept nowhere: the payment keeps its last two digits.
   */
  lane.post('/exits/:exitId/receipt', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      if (direction !== 'exit') throw conflict('wrong_lane_direction', 'this device is not on an exit lane');
      let settings;
      try {
        settings = textReceipt.readTextSettings();
      } catch {
        throw conflict('text_receipts_misconfigured', 'text receipts are set up wrongly on this deployment');
      }
      if (!settings.on) throw conflict('text_receipts_off', 'this deployment sends no text receipts');
      const to = textReceipt.usOrCanada(req.body?.phone);
      if (!to) throw new HttpError(400, 'text receipts go to United States and Canadian numbers only', 'phone_not_us_or_canada');
      const staged = await withTenant(tenantId, async (client) => {
        const row = await exits.caseById(client, tenantId, garageId, req.params.exitId);
        if (!row) throw new HttpError(404, 'exit case not found', 'exit_not_found');
        // The case's own lane only: the driver types the number where the car is.
        if (row.lane_id !== laneId) throw conflict('exit_on_another_lane', 'this exit case is at another lane');
        // Its own payment, or the one that paid its stay at a case it superseded.
        const paid = exits.paidFor(row);
        if (!paid) throw conflict('not_paid', 'a receipt is sent for a paid exit');
        if (paid.receipt) throw conflict('receipt_sent', 'the receipt for this payment was already sent');
        return { row, paid, garage: await repo.getGarage(client, tenantId, garageId) };
      });
      const p = staged.paid;
      let ref;
      try {
        ref = await textReceipt.sendText(settings, {
          to,
          body: textReceipt.receiptText({
            garageName: staged.garage.name,
            amountMinor: p.amount_minor,
            currency: p.currency,
            paidAt: p.succeeded_at,
            timezone: staged.garage.timezone,
            reference: p.payment_intent_id,
          }),
        });
      } catch (err) {
        if (err instanceof textReceipt.TextNotSent) throw new HttpError(502, err.message, 'text_not_sent');
        throw err;
      }
      const row = await withTenant(tenantId, async (client) => {
        await exitPayments.recordReceipt(client, tenantId, p, { sent_at: new Date().toISOString(), to_last2: to.slice(-2), provider_ref: ref });
        return exits.caseById(client, tenantId, garageId, req.params.exitId);
      });
      res.json({ exit: exits.present(row) });
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
      const { tenantId, garageId, laneId, direction, deviceId } = req.device;
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
      // OR THE EXIT CASE (0037), which already names the stay it found by
      // the car's ID -- a stay no plate could find, an unread one included --
      // or, for the driver's word, no stay at all.
      const exitId = exits.uuidField(req.body?.exit_id, 'exit_id');
      const { plate, ticketRef } = exitId ? { plate: null, ticketRef: null } : laneIdentity(req.body);
      if (!closeEventId) throw bad('event_id is required');
      // WHO OPENED for a car with a case (0042): the authority a person at
      // the lane opened the barrier on, as the lane's vend names it.
      const letOutBy = exits.letOutByField(req.body?.let_out_by, exitId);
      laneEventId(closeEventId);
      const exitConfirmation = confirmation(
        req.body?.exit_confirmation,
        'exit_confirmation',
        EXIT_CONFIRMATIONS,
      );
      const sentExitAt = refuseFuture(parseTime(req.body?.exit_at, 'exit_at'), 'exit_at');
      let exitAt = sentExitAt;

      // THE GATE (0014), at the other end: an inactive garage closes no stay.
      // Activation is monotonic, so a stay that exists was opened at an
      // active garage and this never fires for one -- it is here so the rule
      // is stated at both doors and not inferred from the other.
      await activeGarageOrRefuse({
        tenantId, garageId, laneId, laneEventId: String(closeEventId), action: 'close', at: exitAt,
      });
      if (exitId) await settleBeforeClose(tenantId, garageId, exitId);

      const out = await withTenant(tenantId, async (client) => {
        // Keyed on the event first, so a replay returns the very session this
        // exact exit closed -- not "the most recent closed one", which is a
        // guess that goes wrong the moment a vehicle visits twice.
        const already = await repo.findSessionByCloseEvent(client, tenantId, String(closeEventId));
        if (already) return { session: already, closed: false, replay: true };

        let exitCase = null;
        let letOut = null;
        if (exitId) {
          const keptClose = await exits.caseByCloseEvent(client, tenantId, String(closeEventId));
          if (keptClose) return { session: null, exitCase: keptClose, closed: false, replay: true };
          exitCase = await exits.caseById(client, tenantId, garageId, exitId, { lock: true });
          if (!exitCase) throw new HttpError(404, 'exit case not found', 'exit_not_found');
          if (exitCase.closed_at) {
            throw conflict('exit_closed', exitCase.ended?.why === 'superseded'
              ? 'this exit case was superseded by a newer case for the same stay; close that one'
              : exitCase.ended ? 'this exit case was closed when a person ended its stay' : 'this exit case was closed by another exit event');
          }
          // A payment started since `settleBeforeClose`: asked again, it is
          // canceled or found paid before the stay is written.
          if (exitCase.payment?.status === 'open') throw paymentUnsettled();
          letOut = exits.letOutOf(exitCase, { by: `lane_device:${deviceId}`, authority: letOutBy, at: exitAt });
          await recordLetOutAtLane(client, { tenantId, garageId, deviceId, exitCase, letOut, letOutBy });
          if (!exitCase.session_id) {
            // The driver's word, or no stay found and a person let the car
            // out: the case is the whole record of this exit.
            const closedCase = await exits.markClosed(client, tenantId, exitCase.id, { closeEventId: String(closeEventId), closedAt: exitAt });
            return { session: null, exitCase: closedCase, closed: true, replay: false };
          }
        }

        const named = exitCase?.session_id ?? sessionId;
        const openByCase = exitCase ? await repo.findOpenSessionById(client, tenantId, garageId, exitCase.session_id) : null;
        const vehicle = exitCase
          ? (openByCase ? await exits.vehicleOf(client, tenantId, openByCase.vehicle_id) : null)
          : await repo.upsertVehicle(client, tenantId, { plate, ticketRef, seenAt: exitAt });

        // When the lane names the session, that is the session -- no guessing
        // from a plate, so a stale exit from an earlier visit can never land on
        // a later one. When it does not (it was offline at the exit), fall back
        // to the plate with the ordering guard below.
        let open = exitCase
          ? openByCase
          : named
            ? await repo.findOpenSessionById(client, tenantId, garageId, named)
            : await repo.findOpenSession(client, tenantId, garageId, vehicle.id);

        // A LATE CLOSE FOR AN ENDED STAY (0039): the stay a later entry of
        // the car superseded, or a person ended, whose time inside holds this
        // exit -- named, or by the car's whole plate or ticket. It is that
        // stay's exit: the stay closes and prices from it, and `ended` goes.
        // Asked before the open stay's ordering guard below: an exit before
        // the car's current stay came in may be the exit of the one before.
        let wasEnded = null;
        if (!exitCase && (!open || exitAt < open.entry_at)) {
          wasEnded = await repo.endedStayAt(client, tenantId, garageId,
            named ? { sessionId: named } : { vehicleId: vehicle.id }, exitAt);
          if (wasEnded) open = wasEnded;
        }
        if (!open) {
          throw new HttpError(
            404,
            named
              ? 'the named session is not open in this garage'
              : 'no open session for this vehicle',
            named ? 'session_not_open' : 'no_open_stay',
          );
        }
        if (!exitCase && sessionId && open.vehicle_id !== vehicle.id) {
          throw conflict('session_vehicle_mismatch', 'the named session belongs to a different vehicle');
        }

        // TWO LANE CLOCKS APART (0039): each lane may be MAX_CLOCK_SKEW_SECONDS
        // off, so an exit up to twice that before its stay's entry is the
        // same car on two clocks. It closes the stay at its entry, and an
        // event keeps the time the lane sent.
        let clocksApart = false;
        if (exitAt < open.entry_at && open.entry_at - exitAt <= LANE_CLOCKS_APART_MS) {
          exitAt = new Date(open.entry_at);
          clocksApart = true;
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
        if (exitCase) {
          // The case's figures (0037), asked and priced when the car reached
          // the barrier: the fee it was shown and paid.
          ({ asked, pricing } = quotePricing(exitCase.quote));
          if (pricing.outcome === entitlement.EXIT_OUTCOMES.COVERED) plans = [];
          // LET OUT WITH NOTHING PAID (0042): no fee, because none was paid;
          // what it owed is on the record beside it. No validation is
          // recorded on it and no tax taken.
          if (letOut && !pricing.refusal) pricing = { outcome: pricing.outcome };
        } else if (consumable.consume) {
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
            occupancy_at_entry_bp: localDecision.occupancy_at_entry_bp ?? null,
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
          letOut,
        });
        if (wasEnded || clocksApart) {
          await repo.appendEvents(client, tenantId, [
            ...(wasEnded ? [{
              garageId,
              laneId,
              eventId: `${stuck.ENDED_STAY_CLOSED_EVENT_KIND}:${closed.id}`,
              kind: stuck.ENDED_STAY_CLOSED_EVENT_KIND,
              occurredAt: exitAt,
              detail: { actor: 'platform:close', session_id: closed.id, close_event_id: String(closeEventId), was: wasEnded.ended },
            }] : []),
            ...(clocksApart ? [{
              garageId,
              laneId,
              eventId: `${stuck.EXIT_BEFORE_ENTRY_EVENT_KIND}:${closed.id}`,
              kind: stuck.EXIT_BEFORE_ENTRY_EVENT_KIND,
              occurredAt: exitAt,
              detail: { actor: 'platform:close', session_id: closed.id, close_event_id: String(closeEventId), exit_at_sent: sentExitAt.toISOString(), entry_at: closed.entry_at },
            }] : []),
          ]);
        }
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
        const closedCase = exitCase
          ? await exits.markClosed(client, tenantId, exitCase.id, { closeEventId: String(closeEventId), closedAt: exitAt })
          : null;
        return { session: closed, exitCase: closedCase, closed: true, replay: false, releaseAfter: validated.releaseAfter };
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
      res.status(200).json({
        session: out.session ? presentSession(out.session) : null,
        ...(out.exitCase ? { exit: exits.present(out.exitCase) } : {}),
        closed: out.closed,
        replay: out.replay,
      });
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

  /**
   * THE EXIT CASES STILL AT A LANE (0037): every car at an exit of this
   * garage whose case is not closed, newest first, with what is missing --
   * the driver's word, a person, a payment -- and, for a case the picker
   * was asked about, what it was shown and answered.
   */
  operator.get('/garages/:garageId/exits', async (req, res, next) => {
    try {
      const open = await withTenant(req.tenantId, async (client) => {
        await ownGarage(client, req);
        return exits.openCases(client, req.tenantId, req.params.garageId);
      });
      res.json({ exits: open.map(exits.presentForPerson) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * A PERSON LETS THE CAR OUT, `{reason}`: the case is settled whatever it
   * owed, with who and why on the case, an event beside it, and a line in
   * the change log. Once per case, and only while the car is at the lane.
   */
  operator.post('/garages/:garageId/exits/:exitId/let-out', async (req, res, next) => {
    try {
      const reason = req.body?.reason;
      if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 500) {
        throw bad('reason is required: why the car is let out, at most 500 characters');
      }
      const row = await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        const found = await exits.caseById(client, req.tenantId, garage.id, req.params.exitId, { lock: true });
        if (!found) throw new HttpError(404, 'exit case not found', 'exit_not_found');
        if (found.closed_at) throw conflict('exit_closed', 'the car has already left: this case is closed');
        if (found.person) throw conflict('exit_already_let_out', 'a person has already let this car out');
        const actor = await changes.who(client, req.change);
        const person = { by: `${actor.kind}:${actor.name ?? actor.id ?? ''}`.slice(0, 300), reason: reason.trim(), at: new Date().toISOString() };
        const updated = await exits.recordPerson(client, req.tenantId, found.id, person);
        await repo.appendEvents(client, req.tenantId, [{
          garageId: garage.id,
          laneId: found.lane_id,
          eventId: `${exits.PERSON_EVENT_KIND}:${found.id}`,
          kind: exits.PERSON_EVENT_KIND,
          occurredAt: new Date(),
          detail: { actor: person.by, exit_id: found.id, reason: person.reason, owed: exits.settledOf(found) },
        }]);
        await changes.record(client, req.change, {
          garageId: garage.id,
          action: 'exit.let_out',
          subject: { kind: 'exit', id: found.id, name: null },
          before: { let_out: false },
          after: { let_out: true, reason: person.reason },
        });
        return updated;
      });
      res.json({ exit: exits.presentForPerson(await cancelForPerson(req.tenantId, row.garage_id, row)) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * THE STAYS THAT LOOK STUCK (0039): this garage's open stays that came in
   * at least `older_than_hours` ago (72 by default), and those the latest
   * finished walk did not see (0040), oldest first, for a person to end. A
   * read.
   */
  operator.get('/garages/:garageId/stays/stuck', async (req, res, next) => {
    try {
      const hours = stuck.olderThanHours(req.query.older_than_hours);
      const { stays, facts } = await withTenant(req.tenantId, async (client) => {
        await ownGarage(client, req);
        const old = await stuck.stuckStays(client, req.tenantId, req.params.garageId, { hours });
        const facts = await walks.walkFacts(client, req.tenantId, req.params.garageId);
        const unseen = await stuck.openStaysAmong(client, req.tenantId, req.params.garageId, [...facts.notSeenLast],
          new Set(old.map((r) => r.id)));
        const all = [...old, ...unseen].sort((a, b) => a.entry_at - b.entry_at || (a.id < b.id ? -1 : 1));
        return { stays: all, facts };
      });
      res.json({ older_than_hours: hours, stays: stays.map((r) => stuck.presentStuck(r, facts)) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * A PERSON ENDS A STAY NOTHING CLOSED, `{outcome, reason, left_at?}`:
   * `ended` (the car left, at `left_at` or now) or `abandoned` (written off,
   * now). Closed unpriced, with who and why on the stay, an event beside it
   * and a line in the change log. Once: only an open stay ends. Not while a
   * car is at an exit lane on it -- a person lets that one out there.
   */
  operator.post('/garages/:garageId/stays/:stayId/end', async (req, res, next) => {
    try {
      const ask = stuck.endRequest(req.body, parseTime);
      // AN EXIT CASE OPEN ON THE STAY (0045) never blocks the end: the car
      // left the lane without its close, a let-out included. Its open
      // payment is canceled at Stripe first, outside any transaction; one
      // that succeeded stays paid, and the end says so.
      await settleCasesBeforeEnd(req);
      const ended = await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        const stay = await repo.getSession(client, req.tenantId, req.params.stayId);
        if (!stay || stay.garage_id !== garage.id) throw new HttpError(404, 'stay not found', 'stay_not_found');
        if (stay.exit_at) throw conflict('stay_not_open', 'this stay is not open: it has already been closed or ended');
        // The stay's open cases, then the stay: the close's order.
        // A stay closed meanwhile is refused below, where `endStay` finds it not open.
        const atExit = await exits.openCasesOfStay(client, req.tenantId, stay.id, { lock: true });
        await repo.lockOpenStay(client, req.tenantId, garage.id, stay.id);
        const nowAtExit = await exits.openCasesOfStay(client, req.tenantId, stay.id);
        if (nowAtExit.map((c) => c.id).join() !== atExit.map((c) => c.id).join() || atExit.some((c) => c.payment?.status === 'open')) {
          throw conflict('stay_payment_moving', 'a car reached an exit or started paying on this stay just now: ask again');
        }
        const now = new Date();
        const leftAt = ask.leftAt ? refuseFuture(ask.leftAt, 'left_at', now) : now;
        if (leftAt < stay.entry_at) throw new HttpError(400, 'left_at is before the stay came in', 'left_at_before_entry');
        const actor = await changes.who(client, req.change);
        const by = `${actor.kind}:${actor.name ?? actor.id ?? ''}`.slice(0, 300);
        const closedCases = [];
        let paid = null;
        for (const c of atExit) {
          await exits.endCase(client, req.tenantId, c.id, { why: 'stay_ended', by });
          const p = exits.paidFor(c);
          paid ??= p ? { exit_id: p.exit_id, amount_minor: p.amount_minor, currency: p.currency } : null;
          closedCases.push({ exit_id: c.id, payment: p ? 'succeeded' : c.payment?.status ?? null });
        }
        const row = await repo.endStay(client, req.tenantId, stay.id, {
          reason: ask.outcome,
          exitAt: leftAt,
          record: {
            by,
            why: ask.reason,
            ...(closedCases.length ? { exit_cases: closedCases.map((c) => c.exit_id) } : {}),
            ...(paid ? { paid } : {}),
          },
        });
        if (!row) throw conflict('stay_not_open', 'this stay is not open: it has already been closed or ended');
        await repo.appendEvents(client, req.tenantId, [{
          garageId: garage.id,
          laneId: null,
          eventId: `${stuck.STAY_ENDED_EVENT_KIND}:${row.id}`,
          kind: stuck.STAY_ENDED_EVENT_KIND,
          occurredAt: now,
          detail: { actor: by, session_id: row.id, reason: ask.outcome, why: ask.reason, exit_at: row.exit_at },
        }]);
        await changes.record(client, req.change, {
          garageId: garage.id,
          action: 'stay.end',
          subject: { kind: 'stay', id: row.id, name: null },
          before: { open: true },
          after: {
            open: false,
            outcome: ask.outcome,
            reason: ask.reason,
            exit_at: row.exit_at,
            ...(closedCases.length ? { exit_cases_closed: closedCases } : {}),
            ...(paid ? { paid_minor: paid.amount_minor, currency: paid.currency } : {}),
          },
        });
        return row;
      });
      res.json({ stay: stuck.presentEnded(ended) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * BEFORE A PERSON ENDS A STAY: its open exit case's open payment is
   * canceled at Stripe, or found paid. A card being authorised: 409, ask
   * again. Stripe out of reach: 503, nothing written. Another account's or
   * garage's stay: nothing asked here; the end answers 404.
   */
  async function settleCasesBeforeEnd(req) {
    const found = await withTenant(req.tenantId, async (client) => {
      const garage = await ownGarage(client, req);
      const stay = await repo.getSession(client, req.tenantId, req.params.stayId);
      if (!stay || stay.garage_id !== garage.id || stay.exit_at) return null;
      return { garageId: garage.id, cases: await exits.openCasesOfStay(client, req.tenantId, stay.id) };
    });
    for (const c of found?.cases ?? []) {
      if (c.payment?.status !== 'open') continue;
      try {
        await cancelPayment(req.tenantId, found.garageId, c, { why: 'stay_ended' });
      } catch (err) {
        if (err.code === 'payment_in_progress') {
          throw conflict('payment_in_progress', 'a card is being authorised at an exit for this stay: ask again in a few seconds');
        }
        if (err.code === 'payment_amount_mismatch') throw err;
        if (notSettledNow(err)) {
          throw new HttpError(503, "this stay's exit payment could not be settled with Stripe now; nothing was changed, ask again", 'payment_unsettled');
        }
        throw err;
      }
    }
  }

  /**
   * THE INVENTORY WALK (0040): a person walks the garage with a phone,
   * photographs the cars parked there or types their plates, and the walk
   * finishes into four lists, frozen. A picture is read by vehicle-id and
   * kept 30 days. A person has one unfinished walk at a garage at a time.
   */
  // The person: the actor, and the name a key says acted through it where
  // the request carries one (`req.change.doneBy`).
  const walkActor = async (client, req) => {
    const actor = await changes.who(client, req.change);
    const by = `${actor.kind}:${actor.name ?? actor.id ?? ''}`;
    return (req.change.doneBy ? `${by} (${req.change.doneBy})` : by).slice(0, 300);
  };
  const ownWalk = async (client, req, { lock = false } = {}) => {
    const walk = await walks.getWalk(client, req.tenantId, req.params.garageId, req.params.walkId, { lock });
    if (!walk) throw new HttpError(404, 'walk not found', 'walk_not_found');
    return walk;
  };
  const walkFinished = () => conflict('walk_finished', 'this walk is finished: start another');
  const walkClosed = (walk) => {
    if (walk.finished_at) return walkFinished();
    if (walks.abandonedAt(walk)) {
      return conflict('walk_abandoned', `this walk was left unfinished for ${walks.WALK_ABANDON_HOURS} hours: start another`);
    }
    return null;
  };

  operator.post('/garages/:garageId/walks', async (req, res, next) => {
    try {
      const { walk, created } = await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        const by = await walkActor(client, req);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`walks|${garage.id}|${by}`]);
        await walks.abandonStale(client, req.tenantId, garage.id);
        const open = await walks.openWalkOf(client, req.tenantId, garage.id, by);
        if (open) {
          await changes.record(client, req.change, {
            garageId: garage.id, action: 'walk.start', subject: { kind: 'walk', id: open.id, name: null },
            before: { open: true }, after: { open: true },
          });
          return { walk: open, created: false };
        }
        const row = await walks.startWalk(client, req.tenantId, garage.id, by);
        await changes.record(client, req.change, {
          garageId: garage.id,
          action: 'walk.start',
          subject: { kind: 'walk', id: row.id, name: null },
          before: null,
          after: { open: true },
        });
        return { walk: row, created: true };
      });
      res.status(created ? 201 : 200).json({ walk: { id: walk.id, started_at: walk.started_at } });
    } catch (err) {
      next(err);
    }
  });

  // A sighting sent again: by the phone's client_ref, or, with none, by the picture's own bytes.
  const sightingSentBefore = async (client, req, walk, ask, digest) =>
    (ask.clientRef ? await walks.sightingByRef(client, req.tenantId, walk.id, ask.clientRef) : null)
      ?? (digest ? await walks.sightingByPicture(client, req.tenantId, walk.id, digest) : null);

  operator.post('/garages/:garageId/walks/:walkId/sightings', readPicture, async (req, res, next) => {
    try {
      // The phone waits the `Retry-After` it is sent and keeps the picture
      // until it is saved: whole seconds until this key's minute ends.
      const limit = sightingLimiter.attempt(`${req.actor.kind}:${req.actor.id}`);
      if (!limit.allowed) {
        const refusal = new HttpError(429, `at most ${walks.SIGHTINGS_PER_MINUTE} sightings a minute; send the rest in a minute`, 'too_many_sightings');
        refusal.retryAfter = limit.retryAfterSeconds;
        throw refusal;
      }
      const ask = walks.sightingRequest(req.body);
      const takenAt = ask.takenAt === null ? new Date() : refuseFuture(parseTime(ask.takenAt, 'taken_at'), 'taken_at');
      let image = null;
      let imageType = null;
      let digest = null;
      if (ask.picture !== null) {
        const bytes = Buffer.from(ask.picture, 'base64');
        imageType = bytes.length > 0 && bytes.length <= bans.PICTURE_MAX_BYTES ? bans.pictureType(bytes) : null;
        image = imageType ? await bans.freshPicture(bytes, imageType) : null;
        if (!image || image.length > bans.PICTURE_MAX_BYTES) {
          throw new HttpError(400, `picture must be a JPEG or a PNG of at most ${bans.PICTURE_MAX_BYTES} bytes that opens`, 'picture_invalid');
        }
        digest = walks.pictureDigest(bytes);
      }
      // Asked before the picture is read, so a sighting sent again is not read twice.
      const kept = await withTenant(req.tenantId, async (client) => {
        await ownGarage(client, req);
        const walk = await ownWalk(client, req);
        const replay = await sightingSentBefore(client, req, walk, ask, digest);
        if (!replay && walkClosed(walk)) throw walkClosed(walk);
        return replay;
      });
      let read;
      if (kept) {
        read = null;
      } else if (ask.plate !== null) {
        read = walks.fromTyped(ask.plate);
      } else {
        const settings = walks.readerSettings();
        if (!settings.on) {
          read = walks.READER_OFF;
        } else {
          const answer = await walks.readPicture(settings, image, takenAt);
          if (answer.refused) throw new HttpError(400, 'the plate reader could not open this picture', 'picture_invalid');
          if (!answer.ok) {
            throw new HttpError(503, 'the plate reader did not answer: nothing was kept, send the sighting again', 'reader_unanswered');
          }
          read = walks.fromRead(answer);
        }
      }
      const { sighting, stays, created } = await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        const walk = await ownWalk(client, req, { lock: true });
        const replay = await sightingSentBefore(client, req, walk, ask, digest);
        const stays = await walks.staysDuring(client, req.tenantId, garage.id, walk.started_at);
        if (replay) {
          await changes.record(client, req.change, {
            garageId: garage.id, action: 'walk.sighting', subject: { kind: 'walk', id: walk.id, name: null },
            before: { sighting: replay.id }, after: { sighting: replay.id },
          });
          return { sighting: replay, stays, created: false };
        }
        if (walkClosed(walk)) throw walkClosed(walk);
        if (await walks.sightingCount(client, req.tenantId, walk.id) >= walks.SIGHTINGS_MAX) {
          throw conflict('walk_full', `a walk holds at most ${walks.SIGHTINGS_MAX} sightings: finish it and start another`);
        }
        if (ask.confirms) {
          const earlier = await walks.getSighting(client, req.tenantId, walk.id, ask.confirms);
          if (!earlier) throw new HttpError(400, 'confirms must be a sighting of this walk', 'confirms_invalid');
          if (await walks.answered(client, req.tenantId, earlier.id)) {
            throw conflict('sighting_already_confirmed', 'a later sighting already answers that one');
          }
        }
        // A phone that answers a sighting by typing its plate, and says neither which one nor its own id.
        const inferred = !ask.confirms && !ask.clientRef && ask.picture === null && read.read === 'typed'
          ? walks.answersWaiting(read.characters, await walks.waitingSightings(client, req.tenantId, walk.id))
          : null;
        const confirms = ask.confirms ?? inferred;
        const found = walks.fit({ plate_state: read.characters?.state, plate_rule: read.characters?.rule,
          plate_pattern: read.characters?.pattern }, stays.filter((s) => s.exit_at === null));
        const row = await walks.addSighting(client, req.tenantId, walk.id, {
          ...read, clientRef: ask.clientRef, confirms, takenAt, candidates: found.candidates ?? [],
          by: await walkActor(client, req), picture: image ? { type: imageType, image, digest } : null,
        });
        await changes.record(client, req.change, {
          garageId: garage.id, action: 'walk.sighting', subject: { kind: 'walk', id: walk.id, name: null },
          before: null, after: { sighting: row.id, read: row.read, confirms: row.confirms, ...(inferred ? { confirms_inferred: true } : {}) },
        });
        return { sighting: row, stays, created: true };
      });
      res.status(created ? 201 : 200).json({ sighting: walks.presentSighting(sighting, stays) });
    } catch (err) {
      next(err);
    }
  });

  operator.post('/garages/:garageId/walks/:walkId/sightings/:sightingId/pick', async (req, res, next) => {
    try {
      const stayId = req.body?.stay;
      const { sighting, stays } = await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        const walk = await ownWalk(client, req, { lock: true });
        const found = await walks.getSighting(client, req.tenantId, walk.id, req.params.sightingId);
        if (!found) throw new HttpError(404, 'sighting not found', 'sighting_not_found');
        if (walkClosed(walk)) throw walkClosed(walk);
        if (typeof stayId !== 'string' || !found.candidates.includes(stayId)) {
          throw new HttpError(400, "stay must be one of the sighting's candidates", 'stay_not_a_candidate');
        }
        const row = await walks.pickStay(client, req.tenantId, found.id, stayId);
        await changes.record(client, req.change, {
          garageId: garage.id, action: 'walk.pick', subject: { kind: 'walk', id: walk.id, name: null },
          before: { sighting: found.id, picked_stay: found.picked_stay }, after: { sighting: row.id, picked_stay: row.picked_stay },
        });
        return { sighting: row, stays: await walks.staysDuring(client, req.tenantId, garage.id, walk.started_at) };
      });
      res.json({ sighting: walks.presentSighting(sighting, stays) });
    } catch (err) {
      next(err);
    }
  });

  operator.post('/garages/:garageId/walks/:walkId/finish', async (req, res, next) => {
    try {
      const walk = await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        const open = await ownWalk(client, req, { lock: true });
        const subject = { kind: 'walk', id: open.id, name: null };
        if (!open.finished_at && walks.abandonedAt(open)) throw walkClosed(open);
        if (open.finished_at) {
          await changes.record(client, req.change, {
            garageId: garage.id, action: 'walk.finish', subject, before: { open: false }, after: { open: false },
          });
          return open;
        }
        const sightings = await walks.sightingsOf(client, req.tenantId, open.id);
        const stays = await walks.staysDuring(client, req.tenantId, garage.id, open.started_at);
        const found = walks.lists(open, sightings, stays);
        const cover = walks.coverage(open, found, stays, garage.walk_complete_percent);
        const row = await walks.finishWalk(client, req.tenantId, open.id, await walkActor(client, req), found, cover);
        await changes.record(client, req.change, {
          garageId: garage.id, action: 'walk.finish', subject, before: { open: true },
          after: {
            open: false,
            ...Object.fromEntries(walks.LISTS.map((l) => [l, found[l].length])),
            feeds_stuck: cover.feeds_stuck,
            seen_percent: cover.seen_percent,
            complete_percent: cover.complete_percent,
          },
        });
        return row;
      });
      res.json({
        walk: { id: walk.id, started_at: walk.started_at, finished_at: walk.finished_at, lists: walk.lists, ...walks.walkCoverage(walk) },
      });
    } catch (err) {
      next(err);
    }
  });

  operator.get('/garages/:garageId/walks/:walkId/sightings/:sightingId/picture', async (req, res, next) => {
    try {
      const picture = await withTenant(req.tenantId, async (client) => {
        await ownGarage(client, req);
        const walk = await ownWalk(client, req);
        return walks.sightingPicture(client, req.tenantId, walk.id, req.params.sightingId);
      });
      if (!picture) throw new HttpError(404, 'picture not found');
      res.set({ 'Content-Type': picture.content_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      res.send(picture.image);
    } catch (err) {
      next(err);
    }
  });

  operator.get('/garages/:garageId/walks/:walkId', async (req, res, next) => {
    try {
      const out = await withTenant(req.tenantId, async (client) => {
        const garage = await ownGarage(client, req);
        const walk = await ownWalk(client, req);
        const sightings = await walks.sightingsOf(client, req.tenantId, walk.id);
        return walks.presentWalk(walk, sightings, await walks.staysDuring(client, req.tenantId, garage.id, walk.started_at));
      });
      res.json({ walk: out });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PAY AT A PHONE READER: an attendant's phone, with Stripe's Terminal SDK,
   * collects the case's fee. The same intent the lane's reader would take
   * (one per case); answered with its client secret for the phone, which
   * then presents the card to it. The case is settled when Stripe says the
   * intent succeeded -- the lane's poll, or this route asked again, reads it.
   */
  operator.post('/garages/:garageId/exits/:exitId/pay', connectRoute(async (req, res) => {
    const garage = await withTenant(req.tenantId, (client) => ownGarage(client, req));
    const { row, clientSecret } = await payCase({
      tenantId: req.tenantId, garageId: garage.id, exitId: req.params.exitId, channel: 'phone_reader',
      actor: `operator_token:${req.operatorTokenId}`, record: recorder(req),
    });
    const out = { exit: exits.presentForPerson(row) };
    if (row.payment?.status === 'open') out.client_secret = clientSecret;
    res.json(out);
  }));

  /**
   * THE BANNED CARS (0033, U7f). The garage's two settings, and every car
   * whose ban reaches it -- listed here, or at a garage of the account that
   * bans across all its garages -- each with its pictures. A read.
   */
  operator.get('/garages/:garageId/banned', async (req, res, next) => {
    try {
      const out = await withTenant(req.tenantId, async (client) => {
        await ownGarage(client, req);
        return bans.forOwner(client, req.tenantId, req.params.garageId);
      });
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Take a car off the list. There is no route that puts one on it: a car is
   * listed only as a tailgater, where the garage bans them. Its stay and its
   * pictures then age out by the normal rules.
   */
  operator.post('/garages/:garageId/banned/:banId/remove', async (req, res, next) => {
    try {
      await changeTx(req, async (client) => {
        const garage = await ownGarage(client, req);
        const ban = await bans.reaching(client, req.tenantId, garage.id, req.params.banId);
        if (!ban) throw new HttpError(404, 'banned car not found', 'banned_car_not_found');
        if (!(await bans.remove(client, req.tenantId, ban.id))) {
          throw new HttpError(404, 'banned car not found', 'banned_car_not_found');
        }
        await changes.record(client, req.change, {
          garageId: ban.garage_id,
          action: 'garage.banned_car_remove',
          subject: { kind: 'garage', id: ban.garage_id, name: ban.garage_name },
          before: { banned: true },
          after: { banned: false },
        });
      });
      res.json({ removed: true });
    } catch (err) {
      next(err);
    }
  });

  /** One picture of a banned car whose ban reaches this garage, as the image itself. */
  operator.get('/garages/:garageId/banned/:banId/pictures/:pictureId', async (req, res, next) => {
    try {
      const picture = await withTenant(req.tenantId, async (client) => {
        await ownGarage(client, req);
        return bans.pictureOfBan(client, req.tenantId, req.params.garageId, req.params.banId, req.params.pictureId);
      });
      if (!picture) throw new HttpError(404, 'picture not found');
      res.set({ 'Content-Type': picture.content_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      res.send(picture.image);
    } catch (err) {
      next(err);
    }
  });

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
    if (!SAFE_METHODS.has(req.method) && !isReadPost(req) && status >= 400 && status < 500 && !err?.malformedId) {
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
    // The database could not be reached (src/db.js): a 503 in plain words,
    // which a lane re-sends and a page shows. Already logged by its code.
    if (err instanceof DatabaseUnavailable) {
      res.set('Retry-After', UNAVAILABLE_RETRY_AFTER);
      return res.status(503).json(unavailableAnswer(err, req.method));
    }
    const status = err.status ?? 500;
    // How long to wait, on a refusal that says so: whole seconds, at least 1.
    if (err instanceof HttpError && Number.isInteger(err.retryAfter) && err.retryAfter >= 1 && (status === 429 || status === 503)) {
      res.set('Retry-After', String(err.retryAfter));
    }
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

/** How many stays one try may price, and how many tries a minute one owner may make. */
export const TRY_MAX_STAYS = 100;
export const TRY_PER_MINUTE = 20;
const tryLimiter = signIn.addressLimiter({ max: TRY_PER_MINUTE, windowSeconds: 60 });
const sightingLimiter = signIn.addressLimiter({ max: walks.SIGHTINGS_PER_MINUTE, windowSeconds: 60 });

/** One `{ entry, exit }` of a try, read in the garage's time and refused by name. */
function tryStay(raw, i, timezone) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad(`stays[${i}] is { entry, exit }, each a date and time in the garage's own time`);
  }
  const entryAt = localToInstant(raw.entry, timezone, `stays[${i}].entry`);
  const exitAt = localToInstant(raw.exit, timezone, `stays[${i}].exit`);
  if (exitAt < entryAt) throw bad(`stays[${i}] leaves (${raw.exit}) before it came in (${raw.entry})`);
  // How full the garage was when this car came in, for rates with a fill rule
  // (0034): a whole number of basis points of full, 0 to 10000, or left out --
  // and then a fill rule cannot price the stay, and says so, as at the close.
  const occupancy = raw.occupancy_at_entry_bp;
  if (occupancy !== undefined && occupancy !== null && !(Number.isInteger(occupancy) && occupancy >= 0 && occupancy <= 10000)) {
    throw bad(`stays[${i}].occupancy_at_entry_bp is how full the garage was at entry: a whole number from 0 to 10000 (basis points of full)`);
  }
  return { entry: raw.entry, exit: raw.exit, entryAt, exitAt, occupancyAtEntryBp: occupancy ?? null };
}

/** The rule a breakdown line was written by, in the plan that priced the stay. */
function ruleOf(documents, planVersion, ruleId) {
  const plan = documents.find((d) => d.plan_version === planVersion);
  return plan?.rules?.find((r) => r.id === ruleId) ?? null;
}

/**
 * One stay of a try, priced exactly as the close prices it: `priceStay`, then
 * `taxedPricing` at the exit. A garage whose taxes are not stated for that
 * moment yet (rates are set before taxes) gets the price without tax and says
 * so -- the close itself never meets that garage, because it cannot open.
 */
async function tryOne(client, tenantId, garage, documents, stay) {
  const minutes = Math.ceil((stay.exitAt - stay.entryAt) / 60_000);
  const at = { entry: stay.entry, exit: stay.exit, entry_at: stay.entryAt.toISOString(), exit_at: stay.exitAt.toISOString(), minutes };
  if (stay.occupancyAtEntryBp !== null) at.occupancy_at_entry_bp = stay.occupancyAtEntryBp;
  const session = { entry_at: stay.entryAt, currency: garage.currency, occupancy_at_entry_bp: stay.occupancyAtEntryBp };
  const priced = await priceStay({ garage, plans: documents, session, exitAt: stay.exitAt });
  if (priced.refusal) return { ...at, refused: true, findings: priced.refusal };
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM garage_tax_sets WHERE tenant_id = $1 AND garage_id = $2 AND effective_from <= $3',
    [tenantId, garage.id, stay.exitAt],
  );
  const taxesStated = rows[0].n > 0;
  const pricing = taxesStated
    ? await taxedPricing({ outcome: entitlement.EXIT_OUTCOMES.TRANSIENT, ...priced }, { client, tenantId, garage, currency: garage.currency, at: stay.exitAt })
    : { ...priced, subtotalMinor: priced.feeMinor };
  const isTax = (line) => taxes.withoutTaxLines([line]).length === 0;
  const applied = pricing.breakdown
    .filter((l) => l.rule_id && /\.applied$/.test(l.code))
    .map((l) => ({ line: l, rule: ruleOf(documents, pricing.planVersion, l.rule_id) }));
  const special = applied.find((a) => a.rule?.stage === 'QUALIFY');
  return {
    ...at,
    refused: false,
    plan_version: pricing.planVersion,
    special: special ? { rule_id: special.rule.id, label: special.rule.label ?? null } : null,
    adjustments: applied.filter((a) => a.rule?.stage === 'ADJUST').map((a) => ({ rule_id: a.rule.id, label: a.rule.label ?? null })),
    rate_lines: pricing.breakdown.filter((l) => !isTax(l)),
    tax_lines: pricing.breakdown.filter(isTax),
    taxes_stated: taxesStated,
    subtotal_minor: pricing.subtotalMinor,
    fee_minor: pricing.feeMinor,
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
      // The stay's own figure, frozen when it opened (0034): the price never
      // moves with how full the garage is when the car leaves.
      occupancyAtEntryBp: session.occupancy_at_entry_bp ?? null,
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
 * THE FEE OF AN EXIT CASE (0037), worked out as the close works out its own
 * when it prices -- the modules asked, then the engine, then the tax -- and
 * kept on the case whole: what the lane shows, what is paid, and what the
 * close writes (`quotePricing`). A stay with no plate read cannot be asked
 * about by the modules (they hold plates), so it prices as a transient and
 * says why. `vehicle` null: the driver's word, which no module is asked about.
 */
async function quoteStay(client, { tenantId, garage, laneId, session, vehicle, exitAt }) {
  const identity = vehicle?.plate ?? vehicle?.ticket_ref ?? null;
  const asked = identity
    ? await entitlement.consult({ garage, identity, laneId, entryAt: session.entry_at, exitAt })
    : {
        outcome: entitlement.EXIT_OUTCOMES.TRANSIENT,
        covered_by: [],
        record: {
          identity: null,
          asked_at: exitAt.toISOString(),
          covered_by: [],
          reason: vehicle ? 'no plate was read at the entry: no module can be asked about this car' : "the driver's word: no stay to ask about",
        },
      };
  const base = {
    entry_at: new Date(session.entry_at).toISOString(),
    exit_at: exitAt.toISOString(),
    currency: session.currency,
    covered_by: asked.covered_by,
    entitlement: asked.record,
  };
  if (asked.outcome === entitlement.EXIT_OUTCOMES.COVERED) {
    return { ...base, outcome: entitlement.EXIT_OUTCOMES.COVERED, fee_minor: 0, subtotal_minor: 0, breakdown: [], refusal: null, pre_tax: null };
  }
  const plans = ratePlans.documents(await ratePlans.ratePlansForGarage(client, tenantId, garage.id));
  const priced = await priceStay({ garage, plans, session, exitAt });
  if (priced.refusal) {
    return { ...base, outcome: entitlement.EXIT_OUTCOMES.TRANSIENT, fee_minor: null, subtotal_minor: null, breakdown: null, refusal: priced.refusal, pre_tax: null };
  }
  const taxed = await taxedPricing({ outcome: entitlement.EXIT_OUTCOMES.TRANSIENT, ...priced }, {
    client, tenantId, garage, currency: session.currency, at: exitAt,
  });
  return {
    ...base,
    outcome: entitlement.EXIT_OUTCOMES.TRANSIENT,
    fee_minor: taxed.feeMinor,
    subtotal_minor: taxed.subtotalMinor,
    breakdown: taxed.breakdown,
    plan_version: priced.planVersion,
    space_class: priced.spaceClass,
    refusal: null,
    pre_tax: { feeMinor: priced.feeMinor, planVersion: priced.planVersion, breakdown: priced.breakdown, spaceClass: priced.spaceClass },
  };
}

/**
 * The close's `asked` and pre-tax `pricing` for a stay a case found: the
 * case's own figures, written as shown -- the taxed fee and its lines ride
 * as `asDecided`, so the close writes the number the driver saw and paid
 * and does not price a second time.
 */
function quotePricing(quote) {
  const asked = { outcome: quote.outcome, covered_by: quote.covered_by, record: quote.entitlement };
  if (quote.outcome === entitlement.EXIT_OUTCOMES.COVERED) return { asked, pricing: { outcome: quote.outcome } };
  if (quote.refusal) return { asked, pricing: { outcome: quote.outcome, refusal: quote.refusal } };
  return {
    asked,
    pricing: {
      outcome: quote.outcome,
      ...quote.pre_tax,
      asDecided: { feeMinor: quote.fee_minor, breakdown: quote.breakdown },
    },
  };
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
    `this garage is not active: no stay is ${action === 'open' ? 'opened' : 'closed'} here until its setup is done and it is opened`,
  );
}

/** The methods that change nothing: a refusal of one is not a refused change. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The POSTs that change nothing: a read that needs a body. Not writes, so no
 * change-log line is written for them, done or refused (U7g's try).
 * test/change-log.test.js requires the router's non-GET routes to be exactly
 * WRITE_ROUTES and these.
 */
export const READ_POSTS = Object.freeze([['POST', '/garages/:garageId/rate-plans/try']]);
const READ_POST_PATTERNS = READ_POSTS.map(([method, path]) => [method, new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[^/]+')}/?$`, 'i')]);
const isReadPost = (req) => READ_POST_PATTERNS.some(([method, re]) => method === req.method && re.test(req.path));

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
  ['POST', '/garages/:garageId/banned/:banId/remove', 'garage.banned_car_remove'],
  ['POST', '/garages/:garageId/exits/:exitId/let-out', 'exit.let_out'],
  ['POST', '/garages/:garageId/exits/:exitId/pay', 'exit.payment_start'],
  ['POST', '/garages/:garageId/stays/:stayId/end', 'stay.end'],
  ['POST', '/garages/:garageId/walks', 'walk.start'],
  ['POST', '/garages/:garageId/walks/:walkId/sightings', 'walk.sighting'],
  ['POST', '/garages/:garageId/walks/:walkId/sightings/:sightingId/pick', 'walk.pick'],
  ['POST', '/garages/:garageId/walks/:walkId/finish', 'walk.finish'],
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
  if (err.code === 'not_confirmed') return new HttpError(400, err.message, err.code);
  if (err.code === 'rates_start_when_saved') return new HttpError(422, err.message, err.code);
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
