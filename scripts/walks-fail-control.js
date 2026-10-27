#!/usr/bin/env node
/**
 * The control for the inventory walk (0040).
 *
 * Every property below is broken, one at a time, and `test/walks.test.js`
 * with `test/change-log.test.js` is REQUIRED to go red -- with at least one
 * test still green, so a break that stops the files running is not mistaken
 * for one the tests caught. A pass is the failure.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 * Each anchor must occur exactly once in its file.
 *
 *   second_open_walk            a person starting again gets a second open walk, not theirs
 *   stale_walk_resumed          a walk left WALK_ABANDON_HOURS is resumed, not abandoned
 *   sighting_on_abandoned       an abandoned walk takes sightings
 *   picture_not_kept            a walk's picture is not kept
 *   picture_any_walk            a sighting's picture is served through another walk
 *   picture_kept_forever        a walk's picture is kept past PICTURE_DAYS
 *   walk_any_garage             a walk is reached through another garage of its tenant
 *   typed_unconfirmed           a typed plate is kept without the person confirming it
 *   typed_unfolded              a typed plate is matched as typed, not folded as the rule folds
 *   picture_not_fresh           a picture goes to the reader with what was written into it
 *   picture_unchecked           a picture that does not open is taken
 *   big_picture_refused         a phone picture over 1 MB is refused before its route
 *   reader_unnamed              a read does not say which reader read it
 *   reader_down_kept            a reader that did not answer is not answered 503
 *   reader_off_unsaid           a picture with no reader set up is not kept for the person to type
 *   read_again_on_resend        a sighting sent again is read again
 *   client_ref_forgotten        a sighting sent again is kept twice
 *   candidates_dropped          a plate that fits several stays shows none to pick from
 *   zero_agreement_candidate    a stay that agrees in no sure character is a candidate
 *   pick_any_stay               a stay that is not a candidate is picked
 *   pick_ignored                the stay a person picked is not what the finish lists
 *   answered_still_listed       a sighting a later one answered stays in the lists
 *   answered_twice              a sighting is answered twice
 *   unreadable_not_listed       a picture with nothing sure is not listed as not readable
 *   seen_twice_loses_one        a car seen twice keeps only its last sighting
 *   late_stay_not_seen          a stay that came in during the walk is "not seen"
 *   left_stay_not_seen          a stay that left during the walk is "not seen"
 *   finished_reworked           a finished walk is worked out again
 *   sighting_on_finished        a finished walk takes sightings
 *   stuck_ignores_walks         the stuck list does not list the stays the latest walk missed
 *   stuck_any_walk              the stuck list reads the first walk, not the latest
 *   last_seen_missing           the stuck list does not say when a walk last saw a stay
 *   walks_kept_forever          a walk past the retention window is kept
 *   open_walk_kept_forever      a walk never finished is kept past the window
 *   walk_line_names_plate       the change-log line about a sighting names its plate
 *   threshold_not_the_garage    a walk is measured against 80% whatever the garage set
 *   threshold_exclusive         a walk at exactly the threshold does not feed the stuck list
 *   threshold_rounded_up        a walk one share under the threshold feeds it
 *   incomplete_unsaid           an incomplete walk's lists do not say "walk incomplete (N%)"
 *   incomplete_unshown          an incomplete walk's answer does not say so
 *   threshold_setting_unchecked the garage's walk threshold takes anything
 *   threshold_setting_dropped   the garage's walk threshold is never saved
 *   stuck_reason_not_seen       the stuck list sends `not_seen`, not `not_seen_on_walk`
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * statement of 0040 edited, so the property genuinely never existed there.
 *
 *   walk_garage_unchecked       a walk may be at another account's garage
 *   candidates_unchecked        a sighting's candidates may be stays elsewhere
 *   confirms_unchecked          a sighting may answer one of another walk
 *   walk_stays_unchecked        a walk may list a stay elsewhere
 *   walk_subject_refused        the change log does not take a walk as its subject
 *   walk_line_may_name          a line about a walk may carry a name
 *   two_open_walks_a_person     a person may have two walks open at a garage
 *   abandoned_and_finished      a walk may be both abandoned and finished
 *   threshold_unbounded         a garage's walk threshold may be 0 or over 100
 *   walk_feeds_under_threshold  a finished walk may feed the stuck list under its threshold
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.WALKS_SCRATCH_DB || 'openparking_walks_control';

const SOURCE_BREAKS = [
  {
    name: 'second_open_walk',
    why: "a person starting again gets a second open walk, not theirs",
    file: 'src/app.js',
    from: "        const open = await walks.openWalkOf(client, req.tenantId, garage.id, by);",
    to: "        const open = null;",
  },
  {
    name: 'stale_walk_resumed',
    why: "a walk left WALK_ABANDON_HOURS is resumed, not abandoned",
    file: 'src/app.js',
    from: "        await walks.abandonStale(client, req.tenantId, garage.id);",
    to: "",
  },
  {
    name: 'sighting_on_abandoned',
    why: "an abandoned walk takes sightings",
    file: 'src/app.js',
    from: "    if (walks.abandonedAt(walk)) {",
    to: "    if (false) {",
  },
  {
    name: 'picture_not_kept',
    why: "a walk's picture is not kept",
    file: 'src/walks.js',
    from: "      s.picture?.type ?? null, s.picture?.image ?? null, s.picture ? s.picture.digest : null],",
    to: "      null, null, null],",
  },
  {
    name: 'picture_any_walk',
    why: "a sighting's picture is served through another walk",
    file: 'src/walks.js',
    from: "      WHERE tenant_id = $1 AND walk_id = $2 AND id = $3 AND picture IS NOT NULL`,",
    to: "      WHERE tenant_id = $1 AND $2::uuid IS NOT NULL AND id = $3 AND picture IS NOT NULL`,",
  },
  {
    name: 'picture_kept_forever',
    why: "a walk's picture is kept past PICTURE_DAYS",
    file: 'src/walks.js',
    from: "      WHERE tenant_id = $1 AND picture IS NOT NULL\n        AND taken_at <",
    to: "      WHERE false AND tenant_id = $1 AND picture IS NOT NULL\n        AND taken_at <",
  },
  {
    name: 'walk_any_garage',
    why: "a walk is reached through another garage of its tenant",
    file: 'src/walks.js',
    from: "    `SELECT * FROM walks WHERE tenant_id = $1 AND garage_id = $2 AND id = $3${lock ? ' FOR UPDATE' : ''}`,",
    to: "    `SELECT * FROM walks WHERE tenant_id = $1 AND $2::uuid IS NOT NULL AND id = $3${lock ? ' FOR UPDATE' : ''}`,",
  },
  {
    name: 'typed_unconfirmed',
    why: "a typed plate is kept without the person confirming it",
    file: 'src/walks.js',
    from: "  if (plate !== null && body?.confirmed !== true) {",
    to: "  if (false) {",
  },
  {
    name: 'typed_unfolded',
    why: "a typed plate is matched as typed, not folded as the rule folds",
    file: 'src/walks.js',
    from: "    characters: { state: 'read', rule: exitMatch.PLATE_RULE, pattern: exitMatch.fold(plate) },",
    to: "    characters: { state: 'read', rule: exitMatch.PLATE_RULE, pattern: plate },",
  },
  {
    name: 'picture_not_fresh',
    why: "a picture goes to the reader with what was written into it",
    file: 'src/app.js',
    from: "        image = imageType ? await bans.freshPicture(bytes, imageType) : null;",
    to: "        image = imageType ? bytes : null;",
  },
  {
    name: 'picture_unchecked',
    why: "a picture that does not open is taken",
    file: 'src/app.js',
    from: "        if (!image || image.length > bans.PICTURE_MAX_BYTES) {",
    to: "        if (false) {",
  },
  {
    name: 'big_picture_refused',
    why: "a phone picture over 1 MB is refused before its route",
    file: 'src/app.js',
    from: "  app.use((req, res, next) => (req.path === '/api/v1/lane/pictures' || WALK_SIGHTING.test(req.path) ? next() : json(",
    to: "  app.use((req, res, next) => (req.path === '/api/v1/lane/pictures' ? next() : json(",
  },
  {
    name: 'reader_unnamed',
    why: "a read does not say which reader read it",
    file: 'src/walks.js',
    from: "      readers: [{ reader: READER, plate, confidence }],",
    to: "      readers: [],",
  },
  {
    name: 'reader_down_kept',
    why: "a reader that did not answer is not answered 503",
    file: 'src/app.js',
    from: "          if (!answer.ok) {",
    to: "          if (false) {",
  },
  {
    name: 'reader_off_unsaid',
    why: "a picture with no reader set up is not kept for the person to type",
    file: 'src/app.js',
    from: "          read = walks.READER_OFF;",
    to: "          throw new Error('no reader');",
  },
  {
    name: 'read_again_on_resend',
    why: "a sighting sent again is read again",
    file: 'src/app.js',
    from: "        if (!replay && walkClosed(walk)) throw walkClosed(walk);\n        return replay;",
    to: "        if (!replay && walkClosed(walk)) throw walkClosed(walk);\n        return null;",
  },
  {
    name: 'client_ref_forgotten',
    why: "a sighting sent again is kept twice",
    file: 'src/walks.js',
    from: "    `SELECT ${SIGHTING_COLUMNS} FROM walk_sightings WHERE tenant_id = $1 AND walk_id = $2 AND client_ref = $3`,",
    to: "    `SELECT ${SIGHTING_COLUMNS} FROM walk_sightings WHERE tenant_id = $1 AND walk_id = $2 AND client_ref = $3 AND false`,",
  },
  {
    name: 'candidates_dropped',
    why: "a plate that fits several stays shows none to pick from",
    file: 'src/app.js',
    from: "          ...read, clientRef: ask.clientRef, confirms, takenAt, candidates: found.candidates ?? [],",
    to: "          ...read, clientRef: ask.clientRef, confirms, takenAt, candidates: [],",
  },
  {
    name: 'picture_resend_kept_twice',
    why: "the same picture sent again without a client_ref is kept twice",
    file: 'src/walks.js',
    from: "    `SELECT ${SIGHTING_COLUMNS} FROM walk_sightings WHERE tenant_id = $1 AND walk_id = $2 AND picture_digest = $3`,",
    to: "    `SELECT ${SIGHTING_COLUMNS} FROM walk_sightings WHERE tenant_id = $1 AND walk_id = $2 AND picture_digest = $3 AND false`,",
  },
  {
    name: 'answer_not_inferred',
    why: "a typed plate that answers the one waiting read, without saying so, is a car of its own",
    file: 'src/app.js',
    from: "        const confirms = ask.confirms ?? inferred;",
    to: "        const confirms = ask.confirms;",
  },
  {
    name: 'answer_any_unsure',
    why: "a typed plate answers a waiting read it does not agree with",
    file: 'src/walks.js',
    from: "  const fits = waiting.filter(agrees);",
    to: "  const fits = waiting.filter((w) => w.read === 'unsure');",
  },
  {
    name: 'answer_among_several',
    why: "a typed plate answers one of several waiting reads",
    file: 'src/walks.js',
    from: "  if (fits.length === 0 && waiting.length === 1 && waiting[0].read === 'none') return waiting[0].id;",
    to: "  if (fits.length === 0 && waiting.length >= 1 && waiting[0].read === 'none') return waiting[0].id;",
  },
  {
    name: 'answer_inferred_despite_ref',
    why: "a typed plate the phone gave its own client_ref is taken as an answer",
    file: 'src/app.js',
    from: "        const inferred = !ask.confirms && !ask.clientRef && ask.picture === null && read.read === 'typed'",
    to: "        const inferred = !ask.confirms && ask.picture === null && read.read === 'typed'",
  },
  {
    name: 'empty_plate_kept',
    why: "an empty plate from the reader is kept as the plate",
    file: 'src/walks.js',
    from: "    const named = typeof identity.plate === 'string' && identity.plate.length >= 1 && identity.plate.length <= 32;",
    to: "    const named = typeof identity.plate === 'string' && identity.plate.length <= 32;",
  },
  {
    name: 'sightings_unlimited',
    why: "a key sends any number of sightings a minute",
    file: 'src/app.js',
    from: "      if (!sightingLimiter.take(`${req.actor.kind}:${req.actor.id}`)) {",
    to: "      if (false) {",
  },
  {
    name: 'pick_on_finished',
    why: "a pick on a finished walk is taken by the route",
    file: 'src/app.js',
    from: "        if (walkClosed(walk)) throw walkClosed(walk);\n        if (typeof stayId !== 'string'",
    to: "        if (typeof stayId !== 'string'",
  },
  {
    name: 'no_stay_listed_per_sighting',
    why: "one whole plate with no stay, sent twice, is listed twice",
    file: 'src/walks.js',
    from: "    if (same) {\n      same.sightings.push(s.id);",
    to: "    if (false) {\n      same.sightings.push(s.id);",
  },
  {
    name: 'zero_agreement_candidate',
    why: "a stay that agrees in no sure character is a candidate",
    file: 'src/walks.js',
    from: "    return !scored.excluded && scored.agree > 0;",
    to: "    return !scored.excluded;",
  },
  {
    name: 'pick_any_stay',
    why: "a stay that is not a candidate is picked",
    file: 'src/app.js',
    from: "        if (typeof stayId !== 'string' || !found.candidates.includes(stayId)) {",
    to: "        if (typeof stayId !== 'string') {",
  },
  {
    name: 'pick_ignored',
    why: "the stay a person picked is not what the finish lists",
    file: 'src/walks.js',
    from: "    if (!stay && found.candidates && s.picked_stay && found.candidates.includes(s.picked_stay)) stay = s.picked_stay;",
    to: "    if (false) stay = s.picked_stay;",
  },
  {
    name: 'answered_still_listed',
    why: "a sighting a later one answered stays in the lists",
    file: 'src/walks.js',
    from: "  const answered = new Set(sightings.filter((s) => s.confirms).map((s) => s.confirms));",
    to: "  const answered = new Set();",
  },
  {
    name: 'answered_twice',
    why: "a sighting is answered twice",
    file: 'src/app.js',
    from: "          if (await walks.answered(client, req.tenantId, earlier.id)) {",
    to: "          if (false) {",
  },
  {
    name: 'unreadable_not_listed',
    why: "a picture with nothing sure is not listed as not readable",
    file: 'src/walks.js',
    from: "    if (s.read === 'none') {\n      notReadable.push",
    to: "    if (false) {\n      notReadable.push",
  },
  {
    name: 'seen_twice_loses_one',
    why: "a car seen twice keeps only its last sighting",
    file: 'src/walks.js',
    from: "      const row = seen.get(stay) ?? { stay,",
    to: "      const row = { stay,",
  },
  {
    name: 'late_stay_not_seen',
    why: "a stay that came in during the walk is \"not seen\"",
    file: 'src/walks.js',
    from: "    .filter((s) => s.exit_at === null && new Date(s.entry_at) <= startedAt && !seen.has(s.id))",
    to: "    .filter((s) => s.exit_at === null && !seen.has(s.id))",
  },
  {
    name: 'left_stay_not_seen',
    why: "a stay that left during the walk is \"not seen\"",
    file: 'src/walks.js',
    from: "    .filter((s) => s.exit_at === null && new Date(s.entry_at) <= startedAt && !seen.has(s.id))",
    to: "    .filter((s) => new Date(s.entry_at) <= startedAt && !seen.has(s.id))",
  },
  {
    name: 'finished_reworked',
    why: "a finished walk is worked out again",
    file: 'src/app.js',
    from: "        if (open.finished_at) {",
    to: "        if (false) {",
  },
  {
    name: 'sighting_on_finished',
    why: "a finished walk takes sightings",
    file: 'src/app.js',
    from: "    if (walk.finished_at) return walkFinished();\n    if (walks.abandonedAt(walk)) {",
    to: "    if (false) return walkFinished();\n    if (walks.abandonedAt(walk)) {",
  },
  {
    name: 'stuck_ignores_walks',
    why: "the stuck list does not list the stays the latest walk missed",
    file: 'src/app.js',
    from: "        const unseen = await stuck.openStaysAmong(client, req.tenantId, req.params.garageId, [...facts.notSeenLast],",
    to: "        const unseen = await stuck.openStaysAmong(client, req.tenantId, req.params.garageId, [],",
  },
  {
    name: 'stuck_any_walk',
    why: "the stuck list reads the first walk, not the latest",
    file: 'src/walks.js',
    from: "         ORDER BY w.finished_at DESC, w.id LIMIT 1)",
    to: "         ORDER BY w.finished_at, w.id LIMIT 1)",
  },
  {
    name: 'stuck_any_garage',
    why: "the stuck list reads the latest walk at any garage of the tenant",
    file: 'src/walks.js',
    from: "        SELECT w.id FROM walks w WHERE w.tenant_id = $1 AND w.garage_id = $2 AND w.finished_at IS NOT NULL AND w.feeds_stuck",
    to: "        SELECT w.id FROM walks w WHERE w.tenant_id = $1 AND $2::uuid IS NOT NULL AND w.finished_at IS NOT NULL AND w.feeds_stuck",
  },
  {
    name: 'stuck_from_any_walk',
    why: "the stuck list reads a walk that saw too little of the garage",
    file: 'src/walks.js',
    from: " AND w.finished_at IS NOT NULL AND w.feeds_stuck\n",
    to: " AND w.finished_at IS NOT NULL\n",
  },
  {
    name: 'stuck_after_later_sighting',
    why: "a stay a later walk saw stays stuck",
    file: 'src/walks.js',
    from: "later.session_id = ws.session_id AND later.list = 'seen'",
    to: "later.session_id = ws.session_id AND later.list = 'seen' AND false",
  },
  {
    name: 'walk_always_feeds_stuck',
    why: "every finished walk, even one that saw nothing, feeds the stuck list",
    file: 'src/walks.js',
    from: "  const feeds = saw * 100 >= checked.length * completePercent;",
    to: "  const feeds = true;",
  },
  {
    name: 'partial_walk_feeds_stuck',
    why: `a walk that saw under the share of the garage feeds the stuck list`,
    file: 'src/walks.js',
    from: "  const feeds = saw * 100 >= checked.length * completePercent;",
    to: "  const feeds = saw >= 0;",
  },
  {
    name: 'threshold_not_the_garage',
    why: "a walk is measured against 80% whatever the garage set",
    file: 'src/app.js',
    from: "walks.coverage(open, found, stays, garage.walk_complete_percent)",
    to: "walks.coverage(open, found, stays, walks.WALK_COMPLETE_DEFAULT_PERCENT)",
  },
  {
    name: 'threshold_exclusive',
    why: "a walk that saw exactly the threshold does not feed the stuck list",
    file: 'src/walks.js',
    from: "  const feeds = saw * 100 >= checked.length * completePercent;",
    to: "  const feeds = saw * 100 > checked.length * completePercent;",
  },
  {
    name: 'threshold_rounded_up',
    why: "a walk one share under the threshold feeds it once rounded",
    file: 'src/walks.js',
    from: "  const feeds = saw * 100 >= checked.length * completePercent;",
    to: "  const feeds = saw * 100 + checked.length >= checked.length * completePercent;",
  },
  {
    name: 'incomplete_unsaid',
    why: "a walk under the threshold does not say \"walk incomplete (N%)\" in its lists",
    file: 'src/walks.js',
    from: "    incomplete: feeds ? null : incompleteWords(seenPercent),",
    to: "    incomplete: null,",
  },
  {
    name: 'incomplete_unshown',
    why: "a walk's answer does not say it was incomplete",
    file: 'src/walks.js',
    from: "    incomplete: w.feeds_stuck === false && w.seen_percent !== null ? incompleteWords(w.seen_percent) : null,",
    to: "    incomplete: null,",
  },
  {
    name: 'threshold_setting_unchecked',
    why: "the garage's walk threshold takes anything",
    file: 'src/app.js',
    from: "      if (walkComplete !== undefined && !(Number.isInteger(walkComplete) && walkComplete >= 1 && walkComplete <= 100)) {",
    to: "      if (false) {",
  },
  {
    name: 'threshold_setting_dropped',
    why: "the garage's walk threshold is never saved",
    file: 'src/app.js',
    from: "        walk_complete_percent: walkComplete,\n      };",
    to: "      };",
  },
  {
    name: 'stuck_reason_not_seen',
    why: "the stuck list sends `not_seen`, not `not_seen_on_walk`",
    file: 'src/stuckStays.js',
    from: "    why: walks.notSeenLast.has(r.id) ? 'not_seen_on_walk' : 'old',",
    to: "    why: walks.notSeenLast.has(r.id) ? 'not_seen' : 'old',",
  },
  {
    name: 'last_seen_missing',
    why: "the stuck list does not say when a walk last saw a stay",
    file: 'src/stuckStays.js',
    from: "    last_seen_on_walk: walks.lastSeen.get(r.id) ?? null,",
    to: "    last_seen_on_walk: null,",
  },
  {
    name: 'walks_kept_forever',
    why: "a walk past the retention window is kept",
    file: 'src/retention.js',
    from: "      `DELETE FROM walks\n        WHERE tenant_id = $1",
    to: "      `DELETE FROM walks\n        WHERE false AND tenant_id = $1",
  },
  {
    name: 'open_walk_kept_forever',
    why: "a walk never finished is kept past the window",
    file: 'src/retention.js',
    from: "          AND COALESCE(finished_at, abandoned_at, started_at) < COALESCE($2::timestamptz, now()) - make_interval(days => $3)`,",
    to: "          AND finished_at < COALESCE($2::timestamptz, now()) - make_interval(days => $3)`,",
  },
  {
    name: 'walk_line_names_plate',
    why: "the change-log line about a sighting names its plate",
    file: 'src/app.js',
    from: "          before: null, after: { sighting: row.id, read: row.read, confirms: row.confirms, ...(",
    to: "          before: null, after: { sighting: row.id, read: row.read, plate: row.plate, confirms: row.confirms, ...(",
  },
];

const ADDED_0040 = '0040_inventory_walks.sql';

const SCHEMA_BREAKS = [
  {
    name: 'threshold_unbounded',
    why: "a garage's walk threshold may be 0 or over 100",
    edits: [{ file: ADDED_0040, from: "    CONSTRAINT garages_walk_complete_percent_check CHECK (walk_complete_percent BETWEEN 1 AND 100);", to: ";" }],
  },
  {
    name: 'walk_feeds_under_threshold',
    why: "a finished walk may feed the stuck list under its threshold, or keep none",
    edits: [{
      file: ADDED_0040,
      from: "        AND feeds_stuck IS NOT NULL AND complete_percent IS NOT NULL AND finished_at >= started_at\n        AND (NOT feeds_stuck OR seen_percent >= complete_percent))",
      to: "        AND feeds_stuck IS NOT NULL AND finished_at >= started_at)",
    }],
  },
  {
    name: 'walk_garage_unchecked',
    why: "a walk may be at another account's garage",
    edits: [{ file: ADDED_0040, from: "    IF NOT EXISTS (SELECT 1 FROM garages g WHERE g.id = NEW.garage_id AND g.tenant_id = NEW.tenant_id) THEN", to: "    IF false THEN" }],
  },
  {
    name: 'candidates_unchecked',
    why: "a sighting's candidates may be stays elsewhere",
    edits: [{ file: ADDED_0040, from: "       WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = c.id AND s.tenant_id = NEW.tenant_id AND s.garage_id = walk_garage)", to: "       WHERE false" }],
  },
  {
    name: 'confirms_unchecked',
    why: "a sighting may answer one of another walk",
    edits: [{ file: ADDED_0040, from: "    IF NEW.confirms IS NOT NULL AND NOT EXISTS (", to: "    IF false AND NOT EXISTS (" }],
  },
  {
    name: 'walk_stays_unchecked',
    why: "a walk may list a stay elsewhere",
    edits: [{ file: ADDED_0040, from: "    IF NOT EXISTS (\n      SELECT 1 FROM walks w JOIN sessions s", to: "    IF false AND NOT EXISTS (\n      SELECT 1 FROM walks w JOIN sessions s" }],
  },
  {
    name: 'walk_subject_refused',
    why: "the change log does not take a walk as its subject",
    edits: [{ file: ADDED_0040, from: "'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'exit', 'stay', 'walk',", to: "'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message', 'exit', 'stay'," }],
  },
  {
    name: 'walk_line_may_name',
    why: "a line about a walk may carry a name",
    edits: [{ file: ADDED_0040, from: "  CHECK (subject_kind <> 'walk' OR subject_name IS NULL) NOT VALID;", to: "  CHECK (true) NOT VALID;" }],
  },
  {
    name: 'finished_walk_changes',
    why: "the app role may reopen or change a finished or abandoned walk",
    edits: [{ file: ADDED_0040, from: "    IF OLD.finished_at IS NOT NULL OR OLD.abandoned_at IS NOT NULL THEN", to: "    IF false THEN" }],
  },
  {
    name: 'finished_sightings_change',
    why: "the app role may add to or change a closed walk's sightings",
    edits: [{ file: ADDED_0040, from: "    IF NOT walk_closed(NEW.walk_id) THEN\n      RETURN NEW;", to: "    IF true THEN\n      RETURN NEW;" }],
  },
  {
    name: 'finished_walk_lists_more',
    why: "the app role may list more stays for a closed walk",
    edits: [{ file: ADDED_0040, from: "    IF walk_closed(NEW.walk_id) THEN\n      RAISE EXCEPTION 'walk_stays_frozen", to: "    IF false THEN\n      RAISE EXCEPTION 'walk_stays_frozen" }],
  },
  {
    name: 'listed_stays_deletable',
    why: "the app role may change or delete a walk's listed stays",
    edits: [{ file: ADDED_0040, from: "GRANT SELECT, INSERT ON walk_stays TO openparking_app;", to: "GRANT SELECT, INSERT, UPDATE, DELETE ON walk_stays TO openparking_app;" }],
  },
  {
    name: 'sightings_deletable',
    why: "the app role may delete a walk's sightings",
    edits: [{ file: ADDED_0040, from: "GRANT SELECT, INSERT, UPDATE ON walk_sightings TO openparking_app;", to: "GRANT SELECT, INSERT, UPDATE, DELETE ON walk_sightings TO openparking_app;" }],
  },
  {
    name: 'two_open_walks_a_person',
    why: "a person may have two walks open at a garage",
    edits: [{ file: ADDED_0040, from: "CREATE UNIQUE INDEX walks_one_open_per_person", to: "CREATE INDEX walks_one_open_per_person" }],
  },
  {
    name: 'abandoned_and_finished',
    why: "a walk may be both abandoned and finished",
    edits: [{ file: ADDED_0040, from: "    abandoned_at IS NULL OR (finished_at IS NULL AND abandoned_at >= started_at)", to: "    true" }],
  },
];

const SUITE = ['--test', 'test/walks.test.js', 'test/change-log.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-walks-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir, extraEnv = {}) {
  return spawnSync(process.execPath, SUITE, {
    cwd: dir,
    env: { ...process.env, ...extraEnv },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function counts(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return { pass: line('pass'), fail: line('fail') };
}

/**
 * A break is a control only when the suite RAN and went red: at least one test
 * failed AND at least one passed. All failed is a file that could not run --
 * an anchor that moved, a scratch database that did not build -- and it is
 * reported as not a control, never as "fails as required".
 */
function judge(name, why, result) {
  const { pass, fail } = counts(result);
  const label = name.padEnd(36);
  if (result.status === 0 || !fail) {
    console.error(`  ${label} *** PASSED WHEN ${why.toUpperCase()} — the suite is not measuring this ***`);
    return false;
  }
  if (!pass) {
    console.error(`  ${label} *** NOT A CONTROL — ${pass} passed, ${fail} failed: the break fails everything ***`);
    return false;
  }
  console.log(`  ${label} fails as required when ${why} — ${pass} passed, ${fail} failed`);
  return true;
}

/** Apply one edit to a staged file; false when its anchor is not there exactly once. */
function apply(dir, { file, from, to }) {
  const path = join(dir, file);
  const source = readFileSync(path, 'utf8');
  if (source.split(from).length !== 2) return false;
  writeFileSync(path, source.replace(from, to));
  return true;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const adminUrl = required('DATABASE_URL');
const appPassword = required('APP_DB_PASSWORD');

const host = new URL(adminUrl).host;
const scratchAdmin = new URL(adminUrl);
scratchAdmin.pathname = `/${SCRATCH}`;
const scratchApp = new URL(`postgres://openparking_app@${host}/${SCRATCH}`);
scratchApp.password = appPassword;
const maintenance = new URL(required('SUPERUSER_URL'));
maintenance.pathname = '/postgres';

const scratchEnv = {
  DATABASE_URL: scratchAdmin.toString(),
  APP_DATABASE_URL: scratchApp.toString(),
};

async function withAdmin(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A scratch database built from `migrations/` with one statement of 0040 edited. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-walks-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  for (const edit of brk.edits) {
    if (!apply(partial, edit)) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, where: edit.file };
    }
  }

  for (const script of ['scripts/prepare-database.js', 'scripts/migrate.js']) {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, ...scratchEnv, MIGRATIONS_DIR: partial },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(result.stdout, result.stderr);
      throw new Error(`${script} failed against the scratch database`);
    }
  }
  rmSync(partial, { recursive: true, force: true });
  return { ok: true };
}

let failures = 0;

const intactDir = stage();
try {
  console.log('== control A: the suite must PASS intact ==');
  const intact = run(intactDir);
  const { pass, fail } = counts(intact);
  if (intact.status === 0 && pass > 0 && fail === 0) {
    console.log(`  control A OK — ${pass} passed`);
  } else {
    console.error(`  CONTROL A FAILED — the suite does not pass even intact: ${pass} passed, ${fail} failed`);
    console.error(intact.stdout);
    console.error(intact.stderr);
    failures += 1;
  }
} finally {
  rmSync(intactDir, { recursive: true, force: true });
}

console.log('\n== control B: each SOURCE break must make it FAIL ==');
for (const brk of SOURCE_BREAKS) {
  const dir = stage();
  try {
    const edits = [{ file: brk.file, from: brk.from, to: brk.to }, ...(brk.also ?? [])];
    const missing = edits.find((e) => !apply(dir, e));
    if (missing) {
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing.file} ***`);
      failures += 1;
      continue;
    }
    if (!judge(brk.name, brk.why, run(dir))) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== control C: each SCHEMA break must make it FAIL ==');
for (const brk of SCHEMA_BREAKS) {
  const dir = stage();
  try {
    const built = await buildScratch(dir, brk);
    if (!built.ok) {
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${built.where} ***`);
      failures += 1;
      continue;
    }
    if (!judge(brk.name, brk.why, run(dir, scratchEnv))) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The scratch database is a database with a property removed: dropped, so
// nothing is later run against it by accident.
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust the walk tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property the walk rests on.');
