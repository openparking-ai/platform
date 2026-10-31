/**
 * A QR SHOWN AT A LANE: the lane presents what the scanner read, with the
 * identity its camera measured, and this platform asks garage-pass whether
 * it binds -- through the module's own door, `redeem-enrolment`, exactly as
 * the exit's entitlement question goes through `access-in-store`
 * (src/entitlement.js). This platform decides nothing about the QR: the
 * module spends it (once, under concurrency, by its own lock order), binds
 * the car and answers the movement; what it printed is relayed verbatim.
 *
 *   garage-pass redeem-enrolment --tenant T --garage G --token TOKEN
 *                                --vehicle V --lane L --direction D --at AT
 *       exit 0 covered · 1 not covered · 2 refused to answer -- each with
 *       one JSON: `{ enrolment, answer }`, the enrolment half `redeemed`,
 *       `recognised` (with `passed_by`), `match_required` or `refused` (by
 *       code, field and detail), the answer the module's own access answer
 *       for this same movement. Anything else (3: a garage it does not know;
 *       a missing script; a database down) is COULD NOT ANSWER.
 *
 * WHETHER THE CAR IS THE QR'S CAR is the module's decision too -- the owner's
 * rule of 2026-10-30, "similar enough gets a pass" (garage-pass G33). A valid
 * QR made for a plate is `recognised` when the lane read the same plate, the
 * same once look-alikes are one character (0OQD, 1IL, 8B, 5S, 2Z, 6G), one
 * character off (only on a QR plate of five characters or more, folded), or
 * nothing usable; `passed_by` names which (`same_plate`, `look_alike`,
 * `one_difference`, `nothing_read`). Only a clearly different plate is
 * `match_required`. This platform relays the decision and makes none.
 *
 * THE GATE OPENS ON `covered` AND ON NOTHING ELSE. Not covered, refused to
 * answer, a refused redemption, a picture match the lane has not made: shut,
 * and the module's sentence says why. Could-not-answer is not a refusal: it
 * is a 503, which the lane treats exactly as it treats being offline -- the
 * QR cannot be checked, so a pass-only entry stays shut and the exit is the
 * attendant's.
 *
 * THE TOKEN IS A CREDENTIAL AND IS KEPT NOWHERE. It rides on the module's
 * argv because that is the module's door; it is not in the answer (the
 * module never renders it), not in an error (`door` names the script and the
 * exit status, never the argv), not in the event this records and not in the
 * response. Neither is the plate: `events` is append-only by grant, the
 * retention purge cannot reach a detail, and a plate written there would be
 * one this platform could never remove. The module's answer names plates
 * (`qr_plate`, `match_for`, `match_read`) for the lane, which checks its deny
 * rule against the car it lets in; the event takes none of them. It says what
 * happened to the QR -- by the enrolment's own id, which the module prints,
 * and how the car passed for it, `passed_by`, one of four names -- and to the
 * gate.
 */
import { door, EntitlementUnavailable } from './entitlement.js';

export const QR_PRESENTED_EVENT_KIND = 'qr_presented';

/**
 * How a car may pass for a QR's plate (garage-pass `enrolment.PASSED_*`). A
 * closed set, because the event keeps it forever: anything else the module
 * printed there is recorded as null, never copied.
 */
export const PASSED_BY = Object.freeze(['same_plate', 'look_alike', 'one_difference', 'nothing_read']);

/** What the module's exit status means for a redemption. */
const ANSWERED = new Map([[0, 'covered'], [1, 'not_covered'], [2, 'refused_to_answer']]);

/** The longest token a scanner may hand over; a QR carries far less. */
export const TOKEN_MAX = 512;

/** How long after the scan a presentation is still live: the car is at the barrier. */
export const PRESENTED_MAX_AGE_SECONDS = 120;

/** The QR's text, or a refusal naming the rule -- never quoting what was sent. */
export function tokenField(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TypeError('token is what the scanner read: a non-empty string');
  }
  if (raw.length > TOKEN_MAX) throw new TypeError(`token is at most ${TOKEN_MAX} characters`);
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new TypeError('token carries a control character');
  return raw.trim();
}

/**
 * The identity the lane measured, or '' when it read none. The module takes
 * an empty one: a valid QR made for a plate, shown with nothing read, passes
 * (`passed_by: nothing_read`, kept on the QR's own row in garage-pass); only a
 * QR stored before plates were required, bound at its first use, asks for a
 * picture match then (`match_required`), and an unbound one is refused by the
 * module, by name.
 */
export function vehicleField(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new TypeError('vehicle is the identity the lane read, a string, or null when it read none');
  if (raw.length > 64) throw new TypeError('vehicle is at most 64 characters');
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new TypeError('vehicle carries a control character');
  return raw.trim();
}

/**
 * Ask the module. Returns `{ open, outcome, enrolment, answer, exit_code }`,
 * the two halves verbatim; throws `EntitlementUnavailable` when the module
 * could not answer. The thrown message is the module's stderr, which never
 * carries the token (garage-pass renders no credential).
 */
export async function redeem({ link, token, vehicle, laneId, direction, at }, options = {}) {
  const argv = [
    'redeem-enrolment', '--tenant', link.tenant_id, '--garage', link.garage_id,
    '--token', token, '--vehicle', vehicle, '--lane', laneId, '--direction', direction,
    '--at', at.toISOString(),
  ];
  const out = await door('garage_pass', argv, options);
  const outcome = ANSWERED.get(out.exit_code);
  let printed = null;
  try {
    printed = JSON.parse(out.stdout);
  } catch {
    printed = null;
  }
  if (!outcome) {
    const said = printed?.detail ?? (out.stderr || '').trim();
    throw new EntitlementUnavailable('garage_pass', `exit ${out.exit_code}: ${String(said).slice(0, 300)}`);
  }
  if (!printed || typeof printed.enrolment !== 'object' || printed.answer?.outcome !== outcome) {
    throw new EntitlementUnavailable('garage_pass', `exit ${out.exit_code} with a redemption this platform does not recognise`);
  }
  return {
    open: outcome === 'covered',
    outcome,
    exit_code: out.exit_code,
    enrolment: printed.enrolment,
    answer: printed.answer,
  };
}

/**
 * The record of one presentation, for `events.detail`: what happened to the
 * QR and to the gate. No token, no plate (see the header) -- `read_identity`
 * says only WHETHER the lane read one, `passed_by` only HOW the car passed
 * for the QR's plate (null unless the module recognised it), `enrolment` the
 * QR's own id.
 */
export function presentedDetail({ laneId, direction, vehicle, result = null, unavailable = null }) {
  const detail = { lane_id: laneId, direction, read_identity: vehicle !== '' };
  if (unavailable) return { ...detail, answered: false, reason: 'garage-pass could not answer', open: false };
  const e = result.enrolment;
  return {
    ...detail,
    answered: true,
    open: result.open,
    outcome: result.outcome,
    enrolment: typeof e.enrolment === 'string' ? e.enrolment : null,
    redeemed: e.redeemed === true,
    recognised: e.recognised === true,
    passed_by: PASSED_BY.includes(e.passed_by) ? e.passed_by : null,
    match_required: e.match_required === true,
    refused: typeof e.refused === 'string' ? e.refused : null,
  };
}
