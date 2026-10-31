#!/usr/bin/env node
/**
 * The control for the exit's rules and the exceptions (0048).
 *
 * Every property below is broken, one at a time, and the test file named
 * beside it is REQUIRED to go red -- with at least one of its tests still
 * green, so a break that stops the file running is not mistaken for one the
 * tests caught -- AND the test named as catching it must be among the red.
 * A pass is the failure.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 * Each anchor must occur exactly once in its file.
 *
 * Paid and left (test/exit-rules.test.js):
 *   paid_not_credited            a case superseding a paid one asks the whole price again
 *   credit_carries_no_limit      a paid fee is carried over whatever the stay costs now
 *   credit_goes_negative         a stay priced below what it paid is asked a negative figure
 *   credit_misses_a_payment      only the stay's latest payment is credited
 *   pay_whole_fee                the card is asked the whole stay, not the difference
 *   credit_settles_alone         any earlier payment settles the case, covering or not
 *   due_shown_whole              the lane is shown the whole stay as what to pay
 *   let_out_owes_whole           a car let out owing the difference is said to owe the whole stay
 *   end_counts_open_case_only    a person's end takes off only the open case's payment
 *   refund_counted_as_paid       a payment refunded at Stripe is credited whole
 *   refunds_never_read           the stay's payments are credited without asking Stripe for refunds
 *   refunds_unread_unsaid        a payment Stripe could not be asked about is credited and nothing says so
 *   refund_read_waits_30s        a returning car waits on a silent Stripe for 30 s, not 3
 *   repriced_lower_unmarked      a stay priced again lower than it paid is not marked
 *
 * A return is a new stay (test/exit-rules.test.js):
 *   return_folded_into_old_stay  a car back in soon after an exit is folded into its old stay
 *   reentry_leaves_case_open     the old stay's open exit case is left open at the return
 *   reentry_payment_left_open    the old case's unpaid payment is not canceled at Stripe first
 *   reentry_paid_not_recorded    the old stay does not say what it paid
 *   reentry_unlogged             closing the old case at the return leaves no change-log line
 *   late_close_after_return_refused  a lane's close arriving after the car came back in is refused
 *   late_close_at_return_time    such a close writes the stay's exit at the return, not when the car left
 *   late_close_after_reentry     such a close writes an exit after the car came back in
 *   late_close_no_exception      a person's opening on such a close leaves no exception
 *
 * The end reads first (test/exit-rules.test.js):
 *   end_cancels_before_reads     a person's end cancels the payment before left_at and the price are read
 *
 * A pass's sessions, a QR's car (test/pass-sessions.test.js):
 *   pass_session_unkept          a stay is not kept with the pass it was a session of
 *   session_asked_without_entry  garage-pass is asked without the session's own entry
 *   not_covered_session_unlinked a session the pass did not cover is not kept with its pass
 *   qr_not_kept                  the QR that let a car in is not stored on its stay
 *   qr_plate_not_asked           the exit asks garage-pass by the plate as read, not the QR's
 *   qr_plate_kept_past_window    the purge leaves the QR's plate on the stay
 *   qr_shape_unchecked           a QR's passed_by the pass module does not name is taken
 *
 * The exceptions (test/exceptions.test.js):
 *   no_exception_for_attendant   an attendant's let-out leaves no exception
 *   no_exception_at_lane         a person opening at the lane leaves no exception
 *   exception_names_plate        the exception carries the stay's plate
 *   lane_detail_uncut            a lane event's detail is kept whole, plate and all
 *   no_payment_attempts          the exception keeps no payment attempts
 *   reader_refusal_unkept        the reader's refusal of a case's payment is kept nowhere
 *   gate_agent_not_asked         the gate agent's records are not copied at the let-out
 *   copy_holds_answer            the let-out and the close wait for the gate agent before answering
 *   exception_failure_breaks_let_out  an exception that cannot be written takes the let-out back
 *   copies_never_blanked         a copy of the gate agent's records is kept past its window
 *   copy_window_ignores_account  the account's own window for the copies is not read
 *   gate_agent_token_unsent      the gate agent is asked without its token
 *   gate_agent_wrong_lane        the agent is asked by the monitor's name for the lane
 *   keyed_kept_whole             a keyed call-back number is kept whole
 *   redirect_followed            a gate agent's redirect is followed, token and all
 *   http_off_loopback            a gate agent off loopback is asked over plain http
 *   not_configured_blocks        a gate agent not configured fails the let-out
 *   window_not_finished          the copy after the window is never complete
 *   sweep_retries_forever        an unreachable gate agent is asked again without end
 *   missing_not_recovered        a let-out whose exception failed never gets one
 *   exceptions_any_garage        one garage's exception is read through another
 *   reconcile_uncounted          the reconciliation does not count the exceptions
 *   exception_pictures_unlisted  an exception lists no picture
 *   exception_picture_any        the exception's picture route serves any picture of the garage
 *   exception_pictures_any_lane  the window's pictures are taken from every lane, not the exception's
 *   summary_missing              the day's list says nothing of the gate agent
 *   failed_deliveries_uncounted  the list counts no failed delivery
 *   answered_calls_all           the list counts every call as answered
 *   copy_state_always_complete   the list says every copy is complete
 *   day_path_missing             the day cannot be named in the path
 *   day_in_path_ignored          a day named in the path is not the day answered
 *   day_year_unchecked           a day before 1970 is taken
 *   story_credit_dropped         the exception's story drops the case's credit and its refunds unread
 *   repriced_lower_not_in_story  the exception's story does not show a price lower than paid
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * statement of 0048 edited, so the property genuinely never existed there.
 *
 *   payment_any_amount           a payment may be any amount, not what its case asks
 *   stay_pays_past_fee           a stay's payments may add up to more than its fee
 *   two_open_payments            a stay may have two open payments
 *   exceptions_editable          the application may update and delete an exception
 *   records_editable             the application may delete what was appended
 *   records_edited               an appended record may be edited, not only blanked by the purge
 *   refunded_counts_in_fee_guard the stay-fee guard counts a refunded payment whole
 *   exception_any_case           an exception may name another lane or stay than its case's
 *   barrier_opened_owing         a barrier opened may owe
 *   record_without_why           a record not copied may say nothing of why
 *   entry_qr_any_shape           a stay's QR may hold anything
 *   pass_session_any_shape       a stay's pass may name no pass
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
const SCRATCH = process.env.EXIT_RULES_SCRATCH_DB || 'openparking_exit_rules_control';

const RULES = 'test/exit-rules.test.js';
const EXCEPTIONS = 'test/exceptions.test.js';
const PASSES = 'test/pass-sessions.test.js';

const SOURCE_BREAKS = [
  // --- paid and left ---------------------------------------------------------
  {
    name: 'paid_not_credited',
    why: 'a case superseding a paid one asks the whole price again',
    suite: RULES,
    catches: 'PAID AND LEFT, again and again',
    edits: [{ file: 'src/app.js', from: '            quote = exits.withCredit(priced, await exits.stayPayments(client, tenantId, sessionId), { refundsUnread });', to: '            quote = priced;' }],
  },
  {
    name: 'credit_carries_no_limit',
    why: 'a paid fee is carried over whatever the stay costs now',
    suite: RULES,
    catches: 'PAID AND LEFT, again and again',
    edits: [{ file: 'src/exits.js', from: "  if (priced.outcome !== 'covered' && priced.fee_minor > paidMinor) {", to: '  if (false) {' }],
  },
  {
    name: 'credit_goes_negative',
    why: 'a stay priced below what it paid is asked a negative figure',
    suite: RULES,
    catches: 'NEVER NEGATIVE',
    edits: [{ file: 'src/exits.js', from: "  if (priced.outcome !== 'covered' && priced.fee_minor > paidMinor) {", to: "  if (priced.outcome !== 'covered') {" }],
  },
  {
    name: 'credit_misses_a_payment',
    why: "only the stay's latest payment is credited",
    suite: RULES,
    catches: 'PAID AND LEFT, again and again',
    edits: [{ file: 'src/exits.js', from: '      ORDER BY p.succeeded_at, p.id`,', to: '      ORDER BY p.succeeded_at DESC, p.id DESC LIMIT 1`,' }],
  },
  {
    name: 'pay_whole_fee',
    why: 'the card is asked the whole stay, not the difference',
    suite: RULES,
    catches: 'PAID AND LEFT, again and again',
    edits: [{ file: 'src/app.js', from: '      const amountMinor = exits.dueOf(q);', to: '      const amountMinor = q.fee_minor;' }],
  },
  {
    name: 'credit_settles_alone',
    why: 'any earlier payment settles the case, covering or not',
    suite: RULES,
    catches: 'PAID AND LEFT, again and again',
    edits: [
      { file: 'src/exits.js', from: "  if (creditCovers(row.quote) && row.stay_payment?.status === 'succeeded') return row.stay_payment;", to: "  if (row.stay_payment?.status === 'succeeded') return row.stay_payment;" },
    ],
  },
  {
    name: 'due_shown_whole',
    why: 'the lane is shown the whole stay as what to pay',
    suite: RULES,
    catches: 'PAID AND LEFT, again and again',
    edits: [{ file: 'src/exits.js', from: '    fee_minor: dueOf(q),', to: '    fee_minor: q.fee_minor,' }],
  },
  {
    name: 'let_out_owes_whole',
    why: 'a car let out owing the difference is said to owe the whole stay',
    suite: RULES,
    catches: 'A CAR LET OUT OWING THE DIFFERENCE',
    edits: [{ file: 'src/exits.js', from: '    owed_minor: dueOf(q),', to: '    owed_minor: q && !q.refusal ? q.fee_minor : null,' }],
  },
  {
    name: 'refund_counted_as_paid',
    why: 'a payment refunded at Stripe is credited whole',
    suite: RULES,
    catches: 'A REFUND IS NOT PAID',
    edits: [{ file: 'src/exits.js', from: '  return payments.reduce((sum, p) => sum + Number(p.amount_minor) - Number(p.refunded_minor ?? 0), 0);', to: '  return payments.reduce((sum, p) => sum + Number(p.amount_minor), 0);' }],
  },
  {
    name: 'refunds_never_read',
    why: "the stay's payments are credited without asking Stripe for refunds",
    suite: RULES,
    catches: 'A REFUND IS NOT PAID',
    edits: [{ file: 'src/app.js', from: '      const refundsUnread = sessionId ? await readStayRefunds({ tenantId, sessionId }) : [];', to: '      const refundsUnread = [];' }],
  },
  {
    name: 'refunds_unread_unsaid',
    why: 'a payment Stripe could not be asked about is credited and nothing says so',
    suite: RULES,
    catches: 'REFUNDS UNREAD',
    edits: [{ file: 'src/exits.js', from: '    ...(refundsUnread.length ? { refunds_unread: refundsUnread } : {}),\n', to: '' }],
  },
  {
    name: 'refund_read_waits_30s',
    why: 'a returning car waits on a silent Stripe for 30 s, not 3',
    suite: RULES,
    catches: 'A SILENT STRIPE NEVER KEEPS A RETURNING CAR WAITING',
    edits: [{ file: 'src/exitPayments.js', from: 'export const REFUND_READ_TIMEOUT_MS = 3000;', to: 'export const REFUND_READ_TIMEOUT_MS = 30_000;' }],
  },
  {
    name: 'repriced_lower_unmarked',
    why: 'a stay priced again lower than it paid is not marked',
    suite: RULES,
    catches: 'NEVER NEGATIVE',
    edits: [{ file: 'src/exits.js', from: '    ...(repricedMinor < paidMinor ? { repriced_lower:', to: '    ...(false ? { repriced_lower:' }],
  },
  {
    name: 'end_counts_open_case_only',
    why: "a person's end takes off only the open case's payment",
    suite: RULES,
    catches: "A PERSON'S END after paying at a superseded case",
    edits: [{ file: 'src/app.js', from: '        const payments = await exits.stayPayments(client, req.tenantId, stay.id);', to: '        const payments = [];' }],
  },
  // --- a return is a new stay -----------------------------------------------
  {
    name: 'return_folded_into_old_stay',
    why: 'a car back in soon after an exit is folded into its old stay',
    suite: RULES,
    catches: 'A RETURN AFTER AN EXIT IS A NEW STAY',
    edits: [{ file: 'src/repository.js', from: '  return reapproach && !(await reachedAnExit(client, tenantId, existing.id, entryAt));', to: '  return reapproach;' }],
  },
  {
    name: 'reentry_leaves_case_open',
    why: "the old stay's open exit case is left open at the return",
    suite: RULES,
    catches: 'A RETURN AFTER AN EXIT IS A NEW STAY',
    edits: [{ file: 'src/app.js', from: '          onSupersede: (old, newId) => closeStayOnReentry(client, { tenantId, garageId, deviceId, old, newId, at: entryAt }),\n', to: '' }],
  },
  {
    name: 'reentry_payment_left_open',
    why: "the old case's unpaid payment is not canceled at Stripe first",
    suite: RULES,
    catches: 'A RETURN AFTER AN EXIT IS A NEW STAY',
    edits: [{ file: 'src/app.js', from: '        await settleBeforeReentry({ tenantId, garageId, plate, ticketRef, entryAt });\n', to: '' }],
  },
  {
    name: 'reentry_paid_not_recorded',
    why: 'the old stay does not say what it paid',
    suite: RULES,
    catches: 'THE PAID ONE STAYS PAID ON THE OLD STAY',
    edits: [{ file: 'src/app.js', from: '      ...(payments.length ? {\n        paid: {', to: '      ...(false ? {\n        paid: {' }],
  },
  {
    name: 'reentry_unlogged',
    why: 'closing the old case at the return leaves no change-log line',
    suite: RULES,
    catches: 'A RETURN AFTER AN EXIT IS A NEW STAY',
    edits: [{
      file: 'src/app.js',
      from: "        await changes.record(client, ctx, {\n          garageId,\n          action: 'exit.closed_on_return',",
      to: "        await (async () => null)(client, ctx, {\n          garageId,\n          action: 'exit.closed_on_return',",
    }],
  },
  {
    name: 'late_close_after_return_refused',
    why: "a lane's close arriving after the car came back in is refused",
    suite: RULES,
    catches: 'A CLOSE AFTER THE CAR CAME BACK IN, PAID',
    edits: [{ file: 'src/app.js', from: '          returned = exitCase.closed_at ? await stayLeftBeforeReturn(client, tenantId, garageId, exitCase) : null;', to: '          returned = null;' }],
  },
  {
    name: 'late_close_at_return_time',
    why: "such a close writes the stay's exit at the return, not when the car left",
    suite: RULES,
    catches: 'A CLOSE AFTER THE CAR CAME BACK IN, PAID',
    edits: [{ file: 'src/app.js', from: '        if (returned && exitAt > returned.exit_at) exitAt = new Date(returned.exit_at);', to: '        if (returned) exitAt = new Date(returned.exit_at);' }],
  },
  {
    name: 'late_close_after_reentry',
    why: 'such a close writes an exit after the car came back in',
    suite: RULES,
    catches: 'A CLOSE AFTER THE CAR CAME BACK IN, A PERSON OPENED',
    edits: [{ file: 'src/app.js', from: '        if (returned && exitAt > returned.exit_at) exitAt = new Date(returned.exit_at);\n', to: '' }],
  },
  {
    name: 'late_close_no_exception',
    why: "a person's opening on such a close leaves no exception",
    suite: RULES,
    catches: 'A CLOSE AFTER THE CAR CAME BACK IN, A PERSON OPENED',
    edits: [{ file: 'src/app.js', from: '          if (!exitCase.person && (letOutBy || letOut)) {', to: '          if (!returned && !exitCase.person && (letOutBy || letOut)) {' }],
  },
  // --- the end reads first ---------------------------------------------------
  {
    name: 'end_cancels_before_reads',
    why: "a person's end cancels the payment before left_at and the price are read",
    suite: RULES,
    catches: 'THE END READS FIRST',
    edits: [{
      file: 'src/app.js',
      from: '      const staged = await withTenant(req.tenantId, async (client) => {\n        const garage = await ownGarage(client, req);\n        const stay = await stayToEnd(client, req, garage);',
      to: '      await settleCasesBeforeEnd(req, { cases: await withTenant(req.tenantId, (client) => exits.openCasesOfStay(client, req.tenantId, req.params.stayId)) });\n      const staged = await withTenant(req.tenantId, async (client) => {\n        const garage = await ownGarage(client, req);\n        const stay = await stayToEnd(client, req, garage);',
    }],
  },
  // --- a pass's sessions, a QR's car -----------------------------------------
  {
    name: 'pass_session_unkept',
    why: 'a stay is not kept with the pass it was a session of',
    suite: PASSES,
    catches: 'EACH VISIT IS A SESSION OF THE PASS',
    edits: [{ file: 'src/app.js', from: '          passSession: passSessionFor(asked, localDecision, open.entry_qr ?? null),', to: '          passSession: null,' }],
  },
  {
    name: 'session_asked_without_entry',
    why: "garage-pass is asked without the session's own entry",
    suite: PASSES,
    catches: 'EACH VISIT IS A SESSION OF THE PASS',
    edits: [{ file: 'src/entitlement.js', from: "          '--entered-at', entryAt.toISOString(),\n", to: '' }],
  },
  {
    name: 'not_covered_session_unlinked',
    why: 'a session the pass did not cover is not kept with its pass',
    suite: PASSES,
    catches: "THE PASS'S OWN RULES, PER SESSION",
    edits: [{ file: 'src/entitlement.js', from: '  if (gp?.consulted && gp.answer?.pass_id) {', to: '  if (gp?.consulted && gp.covered && gp.answer?.pass_id) {' }],
  },
  {
    name: 'qr_not_kept',
    why: 'the QR that let a car in is not stored on its stay',
    suite: PASSES,
    catches: 'A CAR A QR LET IN ON ONE DIFFERENCE',
    edits: [{ file: 'src/repository.js', from: '       entryQr === null ? null : JSON.stringify(entryQr)],', to: '       null],' }],
  },
  {
    name: 'qr_plate_not_asked',
    why: "the exit asks garage-pass by the plate as read, not the QR's",
    suite: PASSES,
    catches: 'A CAR A QR LET IN ON ONE DIFFERENCE',
    edits: [{ file: 'src/app.js', from: '  const passIdentity = session.entry_qr?.qr_plate ?? null;', to: '  const passIdentity = null;' }],
  },
  {
    name: 'qr_plate_kept_past_window',
    why: "the purge leaves the QR's plate on the stay",
    suite: PASSES,
    catches: 'THE QR IS CHECKED TO ITS SHAPE',
    edits: [{ file: 'src/retention.js', from: "          WHERE tenant_id = $1 AND entry_qr ? 'qr_plate' AND vehicle_id = ANY($2::uuid[])`,", to: "          WHERE tenant_id = $1 AND entry_qr ? 'qr_plate' AND false AND vehicle_id = ANY($2::uuid[])`," }],
  },
  {
    name: 'qr_shape_unchecked',
    why: "a QR's passed_by the pass module does not name is taken",
    suite: PASSES,
    catches: 'THE QR IS CHECKED TO ITS SHAPE',
    edits: [{ file: 'src/app.js', from: "    if (!QR_PASSED_BY.includes(passedBy)) throw bad(`qr.passed_by must be one of ${QR_PASSED_BY.join(', ')}`);\n", to: '' }],
  },
  // --- the exceptions --------------------------------------------------------
  {
    name: 'no_exception_for_attendant',
    why: "an attendant's let-out leaves no exception",
    suite: EXCEPTIONS,
    catches: "AN ATTENDANT'S LET-OUT OF A CAR THAT OWES",
    edits: [{ file: 'src/app.js', from: '        exception = await recordException(client, req.tenantId, {', to: '        exception = null && await recordException(client, req.tenantId, {' }],
  },
  {
    name: 'no_exception_at_lane',
    why: 'a person opening at the lane leaves no exception',
    suite: EXCEPTIONS,
    catches: 'A PERSON AT THE LANE',
    edits: [{ file: 'src/app.js', from: '          if (!exitCase.person && (letOutBy || letOut)) {', to: '          if (false) {' }],
  },
  {
    name: 'exception_names_plate',
    why: "the exception carries the stay's plate",
    suite: EXCEPTIONS,
    catches: "AN ATTENDANT'S LET-OUT OF A CAR THAT OWES",
    edits: [
      { file: 'src/exceptions.js', from: '            s.exit_at, s.ended, s.entry_qr, s.pass_session,', to: '            s.exit_at, s.ended, s.entry_qr, s.pass_session, v.plate,' },
      { file: 'src/exceptions.js', from: '    identified_by: s.identified_by,', to: '    identified_by: s.identified_by,\n    plate: s.plate,' },
    ],
  },
  {
    name: 'lane_detail_uncut',
    why: "a lane event's detail is kept whole, plate and all",
    suite: EXCEPTIONS,
    catches: "AN ATTENDANT'S LET-OUT OF A CAR THAT OWES",
    edits: [{ file: 'src/exceptions.js', from: '  if (PLATFORM_KINDS.has(kind)) return detail ?? {};', to: '  return detail ?? {};' }],
  },
  {
    name: 'no_payment_attempts',
    why: 'the exception keeps no payment attempts',
    suite: EXCEPTIONS,
    catches: "AN ATTENDANT'S LET-OUT OF A CAR THAT OWES",
    edits: [{ file: 'src/exceptions.js', from: '    payments,\n    lane_events:', to: '    payments: [],\n    lane_events:' }],
  },
  {
    name: 'reader_refusal_unkept',
    why: "the reader's refusal of a case's payment is kept nowhere",
    suite: EXCEPTIONS,
    catches: "AN ATTENDANT'S LET-OUT OF A CAR THAT OWES",
    edits: [{ file: 'src/app.js', from: '      if (err instanceof stripeAccount.ConnectRefusal && exits.READER_REFUSALS.includes(err.code)) {', to: '      if (false) {' }],
  },
  {
    name: 'gate_agent_not_asked',
    why: "the gate agent's records are not copied at the let-out",
    suite: EXCEPTIONS,
    catches: "AN ATTENDANT'S LET-OUT OF A CAR THAT OWES",
    edits: [{ file: 'src/app.js', from: '    exceptionsRecord.copyLater(write, tenantId, exception);\n', to: '' }],
  },
  {
    name: 'copy_holds_answer',
    why: 'the let-out and the close wait for the gate agent before answering',
    suite: EXCEPTIONS,
    catches: 'A SLOW GATE AGENT NEVER HOLDS THE LET-OUT OR THE CLOSE',
    edits: [{ file: 'src/app.js', from: '    exceptionsRecord.copyLater(write, tenantId, exception);', to: '    await exceptionsRecord.copyGateAgent(write, tenantId, exception);' }],
  },
  {
    name: 'exception_failure_breaks_let_out',
    why: 'an exception that cannot be written takes the let-out back',
    suite: EXCEPTIONS,
    catches: "THE EXCEPTION'S OWN WRITE FAILING NEVER TAKES THE LET-OUT BACK",
    edits: [{ file: 'src/app.js', from: "      await client.query('ROLLBACK TO SAVEPOINT exception_record');\n", to: "      await client.query('ROLLBACK TO SAVEPOINT exception_record');\n      throw err;\n" }],
  },
  {
    name: 'copies_never_blanked',
    why: "a copy of the gate agent's records is kept past its window",
    suite: EXCEPTIONS,
    catches: "A COPY OF THE GATE AGENT'S RECORDS IS BLANKED",
    edits: [{ file: 'src/exceptions.js', from: '        AND copied_at < COALESCE($2::timestamptz, now()) - make_interval(days => $3)`,', to: '        AND false AND copied_at < COALESCE($2::timestamptz, now()) - make_interval(days => $3)`,' }],
  },
  {
    name: 'copy_window_ignores_account',
    why: "the account's own window for the copies is not read",
    suite: EXCEPTIONS,
    catches: "A COPY OF THE GATE AGENT'S RECORDS IS BLANKED",
    edits: [{ file: 'src/exceptions.js', from: '  return rows[0] ? Number(rows[0].exception_copy_retention_days) : 400;', to: '  return 400;' }],
  },
  {
    name: 'gate_agent_token_unsent',
    why: 'the gate agent is asked without its token',
    suite: EXCEPTIONS,
    catches: "AN ATTENDANT'S LET-OUT OF A CAR THAT OWES",
    edits: [{ file: 'src/gateAgent.js', from: '  if (t.tokenFile) headers.authorization = `Bearer ${readToken(t.tokenFile)}`;', to: '' }],
  },
  {
    name: 'gate_agent_wrong_lane',
    why: "the agent is asked by the monitor's name for the lane",
    suite: EXCEPTIONS,
    catches: "AN ATTENDANT'S LET-OUT OF A CAR THAT OWES",
    edits: [{ file: 'src/gateAgent.js', from: '  const lane = garage.lanes?.[String(laneId).toLowerCase()]?.[spec.laneKey];', to: '  const lane = garage.lanes?.[String(laneId).toLowerCase()]?.monitor_lane;' }],
  },
  {
    name: 'keyed_kept_whole',
    why: 'a keyed call-back number is kept whole',
    suite: EXCEPTIONS,
    catches: "AN ATTENDANT'S LET-OUT OF A CAR THAT OWES",
    edits: [{ file: 'src/gateAgent.js', from: "  if (!o || typeof o !== 'object' || !Object.hasOwn(o, 'keyed')) return o;", to: '  return o;' }],
  },
  {
    name: 'redirect_followed',
    why: "a gate agent's redirect is followed, token and all",
    suite: EXCEPTIONS,
    catches: 'NOT CONFIGURED, NOT REACHABLE, A REDIRECT',
    edits: [{ file: 'src/gateAgent.js', from: "redirect: 'manual'", to: "redirect: 'follow'" }],
  },
  {
    name: 'http_off_loopback',
    why: 'a gate agent off loopback is asked over plain http',
    suite: EXCEPTIONS,
    catches: 'NOT CONFIGURED, NOT REACHABLE, A REDIRECT',
    edits: [{ file: 'src/gateAgent.js', from: "    if (url.protocol !== 'https:') throw notConfigured(`the ${name} is off loopback, so its url must be https`);\n", to: '' }],
  },
  {
    name: 'not_configured_blocks',
    why: 'a gate agent not configured fails the let-out',
    suite: EXCEPTIONS,
    catches: 'NOT CONFIGURED, NOT REACHABLE, A REDIRECT',
    edits: [{ file: 'src/gateAgent.js', from: '    if (err instanceof NotCopied) return { state: err.state, detail: err.message.slice(0, 300) };\n    throw err;', to: '    throw err;' }],
  },
  {
    name: 'window_not_finished',
    why: 'the copy after the window is never complete',
    suite: EXCEPTIONS,
    catches: 'THE WINDOW FINISHED',
    edits: [{ file: 'src/exceptions.js', from: "      complete: got.state === 'copied' && complete,", to: '      complete: false,' }],
  },
  {
    name: 'sweep_retries_forever',
    why: 'an unreachable gate agent is asked again without end',
    suite: EXCEPTIONS,
    catches: 'THE WINDOW FINISHED',
    edits: [{ file: 'src/exceptions.js', from: '!settled(source) && tries(source) < MAX_COPIES', to: '!settled(source)' }],
  },
  {
    name: 'missing_not_recovered',
    why: 'a let-out whose exception failed never gets one',
    suite: EXCEPTIONS,
    catches: 'A LET-OUT WHOSE OWN WRITE FAILED',
    edits: [{ file: 'scripts/complete-exceptions.js', from: '    for (const m of await write((client) => exceptions.missing(client, tenantId))) {', to: '    for (const m of []) {' }],
  },
  {
    name: 'exceptions_any_garage',
    why: "one garage's exception is read through another",
    suite: EXCEPTIONS,
    catches: "THE READS ARE THE GARAGE'S OWN",
    edits: [{ file: 'src/exceptions.js', from: "    'SELECT * FROM exceptions WHERE tenant_id = $1 AND garage_id = $2 AND id = $3',", to: "    'SELECT * FROM exceptions WHERE tenant_id = $1 AND $2::uuid IS NOT NULL AND id = $3'," }],
  },
  {
    name: 'exception_pictures_unlisted',
    why: 'an exception lists no picture',
    suite: EXCEPTIONS,
    catches: 'THE PICTURES OF AN EXCEPTION, BY ID',
    edits: [{ file: 'src/app.js', from: '        return found && { ...found, pictures: await exceptionsRecord.picturesOf(client, req.tenantId, found) };', to: '        return found;' }],
  },
  {
    name: 'exception_picture_any',
    why: "the exception's picture route serves any picture of the garage",
    suite: EXCEPTIONS,
    catches: 'THE PICTURES OF AN EXCEPTION, BY ID',
    edits: [{ file: 'src/exceptions.js', from: '  if (![...listed.entry, ...listed.exit, ...listed.lane].some((p) => p.id === pictureId)) return null;\n', to: '' }],
  },
  {
    name: 'exception_pictures_any_lane',
    why: "the window's pictures are taken from every lane, not the exception's",
    suite: EXCEPTIONS,
    catches: 'THE PICTURES OF AN EXCEPTION, BY ID',
    edits: [{ file: 'src/exceptions.js', from: '             OR (p.lane_id = $5 AND p.taken_at >= $6 AND p.taken_at <= $7))', to: '             OR ($5::uuid IS NOT NULL AND p.taken_at >= $6 AND p.taken_at <= $7))' }],
  },
  {
    name: 'summary_missing',
    why: "the day's list says nothing of the gate agent",
    suite: EXCEPTIONS,
    catches: "THE DAY'S LIST SAYS THE GATE AGENT IN SHORT",
    edits: [{ file: 'src/app.js', from: '        return { day, from, to, rows: rows.map((x) => ({ ...x, gate_agent_summary: gate.get(x.id) })) };', to: '        return { day, from, to, rows };' }],
  },
  {
    name: 'failed_deliveries_uncounted',
    why: 'the list counts no failed delivery',
    suite: EXCEPTIONS,
    catches: "THE DAY'S LIST SAYS THE GATE AGENT IN SHORT",
    edits: [{ file: 'src/exceptions.js', from: "                        WHERE d->>'state' = 'failed') END AS failed,", to: '                        WHERE false) END AS failed,' }],
  },
  {
    name: 'answered_calls_all',
    why: 'the list counts every call as answered',
    suite: EXCEPTIONS,
    catches: "THE DAY'S LIST SAYS THE GATE AGENT IN SHORT",
    edits: [{ file: 'src/exceptions.js', from: "WHERE coalesce(c->>'person_answered_at', '') <> '') END AS answered", to: 'WHERE true) END AS answered' }],
  },
  {
    name: 'copy_state_always_complete',
    why: 'the list says every copy is complete',
    suite: EXCEPTIONS,
    catches: "THE DAY'S LIST SAYS THE GATE AGENT IN SHORT",
    edits: [{ file: 'src/exceptions.js', from: "    if (copied?.ever_complete) return 'complete';", to: "    return 'complete';" }],
  },
  {
    name: 'day_path_missing',
    why: 'the day cannot be named in the path',
    suite: EXCEPTIONS,
    catches: "THE DAY'S LIST SAYS THE GATE AGENT IN SHORT",
    edits: [{ file: 'src/app.js', from: "  operator.get('/garages/:garageId/exceptions/day/:day', may('stays:read'), (req, res, next) => exceptionsOfDay(req, res, next, req.params.day));\n", to: '' }],
  },
  {
    name: 'day_in_path_ignored',
    why: 'a day named in the path is not the day answered',
    suite: EXCEPTIONS,
    catches: "THE DAY'S LIST SAYS THE GATE AGENT IN SHORT",
    edits: [{ file: 'src/app.js', from: "exceptionsOfDay(req, res, next, req.params.day));", to: 'exceptionsOfDay(req, res, next, req.query.day));' }],
  },
  {
    name: 'day_year_unchecked',
    why: 'a day before 1970 is taken',
    suite: EXCEPTIONS,
    catches: "THE DAY'S LIST SAYS THE GATE AGENT IN SHORT",
    edits: [{ file: 'src/app.js', from: " || Number(day.slice(0, 4)) < 1970\n", to: '\n' }],
  },
  {
    name: 'story_credit_dropped',
    why: "the exception's story drops the case's credit and its refunds unread",
    suite: EXCEPTIONS,
    catches: 'THE STORY KEEPS THE CREDIT',
    edits: [{ file: 'src/exceptions.js', from: '      credit: q.credit\n        ? { paid_minor', to: '      credit: null && q.credit\n        ? { paid_minor' }],
  },
  {
    name: 'repriced_lower_not_in_story',
    why: "the exception's story does not show a price lower than paid",
    suite: EXCEPTIONS,
    catches: 'THE STORY KEEPS THE CREDIT',
    edits: [{ file: 'src/exceptions.js', from: '      repriced_lower: q.repriced_lower ?? null,', to: '      repriced_lower: null,' }],
  },
  {
    name: 'reconcile_uncounted',
    why: 'the reconciliation does not count the exceptions',
    suite: EXCEPTIONS,
    catches: "THE READS ARE THE GARAGE'S OWN",
    edits: [{ file: 'src/reconcile.js', from: '    exceptions: await exceptionsSince(client, tenantId, garageId, since),', to: '' }],
  },
];

const ADDED_0048 = '0048_exit_rules_and_exceptions.sql';

const SCHEMA_BREAKS = [
  {
    name: 'payment_any_amount',
    why: 'a payment may be any amount, not what its case asks',
    suite: RULES,
    catches: 'NEVER CHARGED TWICE, AT THE DATABASE',
    edits: [{ file: ADDED_0048, from: '    IF due IS NULL OR NEW.amount_minor <> due THEN', to: '    IF false THEN' }],
  },
  {
    name: 'stay_pays_past_fee',
    why: "a stay's payments may add up to more than its fee",
    suite: RULES,
    catches: 'NEVER CHARGED TWICE, AT THE DATABASE',
    edits: [{ file: ADDED_0048, from: '    IF taken > fee THEN', to: '    IF false THEN' }],
  },
  {
    name: 'two_open_payments',
    why: 'a stay may have two open payments',
    suite: RULES,
    catches: 'NEVER CHARGED TWICE, AT THE DATABASE',
    edits: [{ file: ADDED_0048, from: 'CREATE UNIQUE INDEX exit_payments_one_open_per_stay', to: 'CREATE INDEX exit_payments_one_open_per_stay' }],
  },
  {
    name: 'exceptions_editable',
    why: 'the application may update and delete an exception',
    suite: EXCEPTIONS,
    catches: 'THE DATABASE HOLDS THE RECORD',
    edits: [{ file: ADDED_0048, from: 'GRANT SELECT, INSERT ON exceptions TO openparking_app;', to: 'GRANT SELECT, INSERT, UPDATE, DELETE ON exceptions TO openparking_app;' }],
  },
  {
    name: 'records_editable',
    why: 'the application may delete what was appended',
    suite: EXCEPTIONS,
    catches: 'THE DATABASE HOLDS THE RECORD',
    edits: [{ file: ADDED_0048, from: 'GRANT SELECT, INSERT, UPDATE ON exception_records TO openparking_app;', to: 'GRANT SELECT, INSERT, UPDATE, DELETE ON exception_records TO openparking_app;' }],
  },
  {
    name: 'records_edited',
    why: 'an appended record may be edited, not only blanked by the purge',
    suite: EXCEPTIONS,
    catches: 'THE DATABASE HOLDS THE RECORD',
    edits: [{ file: ADDED_0048, from: '  BEFORE UPDATE ON exception_records', to: '  BEFORE UPDATE OF id ON exception_records' }],
  },
  {
    name: 'refunded_counts_in_fee_guard',
    why: 'the stay-fee guard counts a refunded payment whole',
    suite: RULES,
    catches: 'A REFUND IS NOT PAID',
    edits: [{ file: ADDED_0048, from: '    SELECT COALESCE(sum(p.amount_minor - p.refunded_minor), 0) INTO taken', to: '    SELECT COALESCE(sum(p.amount_minor), 0) INTO taken' }],
  },
  {
    name: 'exception_any_case',
    why: "an exception may name another lane or stay than its case's",
    suite: EXCEPTIONS,
    catches: 'THE DATABASE HOLDS THE RECORD',
    edits: [{ file: ADDED_0048, from: '         AND e.lane_id = NEW.lane_id AND e.session_id IS NOT DISTINCT FROM NEW.session_id', to: '' }],
  },
  {
    name: 'barrier_opened_owing',
    why: 'a barrier opened may owe',
    suite: EXCEPTIONS,
    catches: 'THE DATABASE HOLDS THE RECORD',
    edits: [{ file: ADDED_0048, from: "CHECK (kind <> 'barrier_opened' OR coalesce(owed_minor, 0) = 0)", to: 'CHECK (true)' }],
  },
  {
    name: 'record_without_why',
    why: 'a record not copied may say nothing of why',
    suite: EXCEPTIONS,
    catches: 'THE DATABASE HOLDS THE RECORD',
    edits: [{ file: ADDED_0048, from: "    (state = 'copied') OR (records = '[]'::jsonb AND NOT complete AND detail IS NOT NULL)", to: '    true' }],
  },
  {
    name: 'entry_qr_any_shape',
    why: "a stay's QR may hold anything",
    suite: PASSES,
    catches: 'THE QR IS CHECKED TO ITS SHAPE',
    edits: [{ file: ADDED_0048, from: '    CONSTRAINT sessions_entry_qr_shape CHECK (', to: '    CONSTRAINT sessions_entry_qr_shape CHECK (true OR' }],
  },
  {
    name: 'pass_session_any_shape',
    why: "a stay's pass may name no pass",
    suite: PASSES,
    catches: 'THE QR IS CHECKED TO ITS SHAPE',
    edits: [{ file: ADDED_0048, from: '    CONSTRAINT sessions_pass_session_shape CHECK (', to: '    CONSTRAINT sessions_pass_session_shape CHECK (true OR' }],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-exit-rules-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir, suite, extraEnv = {}) {
  return spawnSync(process.execPath, ['--test', '--test-reporter=spec', suite], {
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

/** The titles the run reported failed. */
function failed(result) {
  return result.stdout.split('\n').filter((l) => /^\s*✖ /.test(l)).map((l) => l.replace(/^\s*✖ /, ''));
}

/**
 * A break is a control only when the file RAN and went red: at least one test
 * failed AND at least one passed, and the test named as catching it is among
 * the red. All failed is a file that could not run -- an anchor that moved, a
 * scratch database that did not build -- and it is reported as not a control.
 */
function judge(brk, result) {
  const { pass, fail } = counts(result);
  const label = brk.name.padEnd(30);
  if (result.status === 0 || !fail) {
    console.error(`  ${label} *** PASSED WHEN ${brk.why.toUpperCase()} -- the suite is not measuring this ***`);
    return false;
  }
  if (!pass) {
    console.error(`  ${label} *** NOT A CONTROL -- ${pass} passed, ${fail} failed: the break fails everything ***`);
    return false;
  }
  if (!failed(result).some((t) => t.startsWith(brk.catches))) {
    console.error(`  ${label} *** RED, BUT NOT IN "${brk.catches}" -- the test named as catching it did not ***`);
    return false;
  }
  console.log(`  ${label} fails as required when ${brk.why} -- caught by "${brk.catches}" (${brk.suite}: ${pass} passed, ${fail} failed)`);
  return true;
}

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

/** A scratch database built from `migrations/` with one statement of 0048 edited. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });
  const partial = mkdtempSync(join(tmpdir(), 'openparking-exit-rules-migrations-'));
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
  console.log('== control A: each file must PASS intact ==');
  for (const suite of [RULES, EXCEPTIONS, PASSES]) {
    const intact = run(intactDir, suite);
    const { pass, fail } = counts(intact);
    if (intact.status === 0 && pass > 0 && fail === 0) {
      console.log(`  control A OK -- ${suite}: ${pass} passed`);
    } else {
      console.error(`  CONTROL A FAILED -- ${suite} does not pass even intact: ${pass} passed, ${fail} failed`);
      console.error(intact.stdout);
      console.error(intact.stderr);
      failures += 1;
    }
  }
} finally {
  rmSync(intactDir, { recursive: true, force: true });
}

console.log('\n== control B: each SOURCE break must make it FAIL ==');
for (const brk of SOURCE_BREAKS) {
  const dir = stage();
  try {
    const missing = brk.edits.find((e) => !apply(dir, e));
    if (missing) {
      console.error(`  ${brk.name.padEnd(30)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing.file} ***`);
      failures += 1;
      continue;
    }
    if (!judge(brk, run(dir, brk.suite))) failures += 1;
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
      console.error(`  ${brk.name.padEnd(30)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${built.where} ***`);
      failures += 1;
      continue;
    }
    if (!judge(brk, run(dir, brk.suite, scratchEnv))) failures += 1;
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
  console.error(`\n${failures} control(s) failed. Do not trust the exit-rules tests.`);
  process.exit(1);
}
console.log('\nall controls OK -- the tests fail on every property the exit\'s rules and the exceptions rest on.');
