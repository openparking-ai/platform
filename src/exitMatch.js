/**
 * WHICH OPEN STAY IS THE CAR AT THE EXIT, by its ID and not by an exact plate.
 *
 * The entry and exit cameras are a matched pair under the same light, so what
 * identifies a car is that both ends give the SAME ID: the same sure plate
 * characters in the same positions (folded, `opvid-plate-chars/1`), the same
 * colour code, the same size when one is measured -- even the same misread,
 * and the same "unreadable". This module is pure: it is handed the exit's ID
 * and the garage's open stays and says one of three things.
 *
 *   single  one stay, clearly: that stay is the car.
 *   few     a short list, numbered in this order, for the picker to choose
 *           from by pictures (src/exitPicker.js), or none of them.
 *   none    nothing to choose from: the driver's word decides the entry.
 *
 * A component that disagrees EXCLUDES a stay: a sure character that differs
 * in its position, a colour code further than `SAME_COLOUR_DISTANCE`, a
 * different size, a read plate against an unreadable one. A component that
 * cannot be compared (not measured, `not_seen`, a different rule or colour
 * version, plates of different lengths) says nothing either way.
 */

/** The look-alike classes of `opvid-plate-chars/1`, letters onto digits. */
const FOLD = Object.freeze({ O: '0', I: '1', B: '8', S: '5' });
export const PLATE_RULE = 'opvid-plate-chars/1';

/** Two colour codes are the same colour at or below this (vehicle-id's stated assumption). */
export const SAME_COLOUR_DISTANCE = 0.2;

/** Sure characters in agreement that pick a stay on their own. */
export const SURE_ALONE = 3;
/** Sure characters in agreement that pick a stay with the colour or the size beside them. */
export const SURE_WITH_LOOK = 2;
/** How far ahead of the next stay a winner must be, in agreeing sure characters. */
export const CLEAR_BY = 2;
/** The most candidates the picker is shown. */
export const MAX_CANDIDATES = 10;

export function fold(text) {
  return [...String(text).toUpperCase()].filter((c) => /[0-9A-Z]/.test(c)).map((c) => FOLD[c] ?? c).join('');
}

/**
 * A stay's plate ID as this module compares it. A stay opened with positioned
 * characters keeps them; a stay opened by an older lane with a whole plate
 * read above its threshold is every position sure; an unread stay (0036) with
 * no positioned characters is `unreadable`; a ticket stay says nothing.
 */
export function stayPlateId(stay) {
  if (stay.entry_plate_state) {
    return { state: stay.entry_plate_state, rule: stay.entry_plate_rule, pattern: stay.entry_plate_pattern };
  }
  if (stay.plate) return { state: 'read', rule: PLATE_RULE, pattern: fold(stay.plate) };
  if (stay.identity_kind === 'unread') return { state: 'unreadable', rule: null, pattern: null };
  return null;
}

/** Half the L1 distance of two `opvid-colour` codes, or null when they do not compare. */
export function colourDistance(a, b) {
  const pa = parseColour(a);
  const pb = parseColour(b);
  if (!pa || !pb || pa.version !== pb.version || pa.source !== pb.source) return null;
  const na = normalised(pa.bins);
  const nb = normalised(pb.bins);
  return 0.5 * na.reduce((sum, x, i) => sum + Math.abs(x - nb[i]), 0);
}

function parseColour(text) {
  const m = /^opvid-colour\/(\d+):([mf]):([0-9a-f]{16})$/.exec(text ?? '');
  if (!m) return null;
  return { version: Number(m[1]), source: m[2], bins: [...m[3]].map((c) => parseInt(c, 16) / 15) };
}

function normalised(bins) {
  const total = bins.reduce((a, b) => a + b, 0);
  return total > 0 ? bins.map((b) => b / total) : bins;
}

function comparePlates(exit, stay) {
  if (!exit || !stay || exit.state === 'not_seen' || stay.state === 'not_seen') return { excluded: false, agree: 0 };
  if (exit.state === 'unreadable' || stay.state === 'unreadable') {
    if (exit.state === stay.state) return { excluded: false, agree: 0, unreadable: true };
    return { excluded: true, why: 'plate read at one end and unreadable at the other' };
  }
  if (exit.rule !== stay.rule || exit.pattern.length !== stay.pattern.length) return { excluded: false, agree: 0 };
  let agree = 0;
  for (let i = 0; i < exit.pattern.length; i += 1) {
    const a = exit.pattern[i];
    const b = stay.pattern[i];
    if (a === '?' || b === '?') continue;
    if (a !== b) return { excluded: true, why: `sure character ${i} differs` };
    agree += 1;
  }
  return { excluded: false, agree };
}

/** One stay against the exit's ID: excluded with a reason, or what agreed. */
export function score(exitId, stay) {
  const plate = comparePlates(exitId.plate, stayPlateId(stay));
  if (plate.excluded) return { id: stay.id, excluded: true, why: plate.why };
  const distance = exitId.colour_code && stay.entry_colour_code ? colourDistance(exitId.colour_code, stay.entry_colour_code) : null;
  if (distance !== null && distance > SAME_COLOUR_DISTANCE) return { id: stay.id, excluded: true, why: 'colour differs' };
  if (exitId.size && stay.entry_size && exitId.size !== stay.entry_size) return { id: stay.id, excluded: true, why: 'size differs' };
  return {
    id: stay.id,
    excluded: false,
    agree: plate.agree,
    unreadable: plate.unreadable === true,
    colour_same: distance !== null,
    size_same: Boolean(exitId.size && stay.entry_size),
    entry_at: stay.entry_at,
  };
}

function strong(s) {
  if (s.agree >= SURE_ALONE) return true;
  if (s.agree >= SURE_WITH_LOOK && (s.colour_same || s.size_same)) return true;
  return false;
}

/**
 * The answer for one exit. `stays` are the garage's open stays that entered
 * at or before the exit; the caller filters them, this module decides.
 */
export function match(exitId, stays) {
  const scored = stays.map((s) => score(exitId, s));
  const left = scored
    .filter((s) => !s.excluded)
    .sort((a, b) => b.agree - a.agree || new Date(b.entry_at) - new Date(a.entry_at));
  const excluded = scored.length - left.length;
  if (left.length === 0) return { kind: 'none', why: 'no open stay agrees with this car', excluded };

  const [top, next] = left;
  if (strong(top) && (!next || next.agree <= top.agree - CLEAR_BY)) {
    return { kind: 'single', stay: top.id, agree: top.agree, excluded };
  }
  // An unreadable plate at both ends, and only one such stay of that colour:
  // there is no other car it could be among the stays held.
  if (left.length === 1 && top.unreadable && (top.colour_same || top.size_same)) {
    return { kind: 'single', stay: top.id, agree: 0, excluded };
  }

  let few = left;
  if (few.length > MAX_CANDIDATES && top.agree > 0) few = left.filter((s) => s.agree >= top.agree - 1);
  if (few.length > MAX_CANDIDATES) {
    return { kind: 'none', why: `${left.length} open stays agree with this car; too many to choose from by pictures`, excluded };
  }
  return { kind: 'few', candidates: few.map((s) => s.id), excluded };
}
