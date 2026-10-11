/**
 * A garage's own time: a wall-clock reading in its time zone, to an instant
 * and back. The owner types "came in 08:30 on 14 October" in the garage's
 * time; the engine and the close work in instants.
 *
 * Standard library only (`Intl`), like the rest of this platform. Two edges a
 * time zone has, each decided here and said:
 *
 *   a time that does not exist  (clocks go forward, 02:30 is skipped) is
 *                               REFUSED by name -- no car came in then, and
 *                               moving it an hour is a guess about money;
 *   a time that happens twice   (clocks go back, 01:30 twice) is the FIRST
 *                               of the two, the earlier instant.
 */

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** A garage time that cannot be read, by name. */
export class GarageTimeInvalid extends Error {}

const formatters = new Map();
function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock at instant `ms` in `timeZone`, as 'YYYY-MM-DDTHH:MM'. */
export function instantToLocal(ms, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** The wall clock read as if it were UTC, in ms: the arithmetic below needs one. */
function wallAsUtc(local) {
  const m = LOCAL.exec(local);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/**
 * 'YYYY-MM-DDTHH:MM' in `timeZone` -> a Date. Refuses a reading that is not a
 * real date and time, and one the zone skips.
 */
export function localToInstant(local, timeZone, label = 'time') {
  if (typeof local !== 'string' || !LOCAL.test(local)) {
    throw new GarageTimeInvalid(`${label} is a date and time in the garage's own time, written YYYY-MM-DDTHH:MM, not ${JSON.stringify(local)}`);
  }
  const wall = wallAsUtc(local);
  // Not a real calendar reading (31 February, 25:00): Date.UTC rolls it over.
  if (new Date(wall).toISOString().slice(0, 16) !== local) {
    throw new GarageTimeInvalid(`${label} ${local} is not a real date and time`);
  }
  // Every instant whose wall clock in the zone is `local`: the zone's offset is
  // within a day of UTC, so the candidates are wall minus each offset seen
  // around it. Sorted, so a reading that happens twice gives the earlier.
  const offsets = new Set();
  for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) {
    offsets.add(wallAsUtc(instantToLocal(probe, timeZone)) - probe);
  }
  const matches = [...offsets].map((o) => wall - o).filter((t) => instantToLocal(t, timeZone) === local).sort((a, b) => a - b);
  if (matches.length === 0) {
    throw new GarageTimeInvalid(`${label} ${local} does not happen in ${timeZone}: the clocks go forward past it`);
  }
  return new Date(matches[0]);
}
