/**
 * A validation at the exit (migration 0019): a linked module asked through its
 * own door, and the discount it answers written as one more ledger line.
 *
 * The module is ITS OWN SYSTEM, as garage-pass and monthly-billing are
 * (`entitlement.js`): its command line, run as a subprocess with the
 * environment the operator gave this platform, found in ENTITLEMENT_BIN_DIR or
 * on PATH. This platform imports nothing of it and holds none of its data.
 * THIS REPOSITORY GETS THE ABILITY TO ASK, NEVER THE MODULE: a garage links one
 * (`validations_link`, `{tenant_id, garage_id}`) or links none.
 *
 *   valet-validations validation-in-store --tenant T --garage G --at EXIT     < phone
 *       exit 0 validated · 1 not validated (the JSON names why) · 2 could not
 *       decide (configuration) · 3 the request was refused.
 *   valet-validations claim-in-store --tenant T --garage G --at EXIT
 *       --consumer openparking --ref SESSION --base-minor FEE --currency C  < phone
 *       exit 0 claimed, with the discount in minor units · 1 nothing to claim
 *       · 2 could not decide · 3 refused.
 *   valet-validations release-in-store --tenant T --garage G --at NOW
 *       --consumer openparking --ref SESSION
 *       exit 0 released · 1 not released (none, superseded) · 2 · 3.
 *
 * WHEN (amendment A1): the claim is made AT THE READER, the moment the phone
 * is entered, on the fee the lane priced -- `claimAtReader` -- and HELD on the
 * open stay, so the amount the driver is shown is already the discounted one.
 * The close RECORDS the hold (`recordAtClose`) and asks nothing. A hold no
 * close takes is RELEASED (`release`): by the close when it cannot take it,
 * by the sweep when the stay is still open a hold window later
 * (`releaseStaleHolds`) -- a driver who entered a phone and did not pay and
 * leave strands nothing.
 *
 * SHOWN IS RECORDED (amendment A2.2). The close carries what the reader
 * actually showed (`reader_shown`), and the hold is recorded only when the
 * reader showed its discounted fee. A reader that gave up before the claim
 * answered -- it showed the fee as priced -- or a close that says nothing about
 * the reader, gives the hold back: the row says what the driver saw.
 *
 * NO DOOR CALL IS EVER THE LAST WORD (amendment A2.3). The door commits in its
 * own database before this platform's transaction does, so a rollback here
 * after the door answered would leave the two systems disagreeing. So every
 * door call that changes the module is preceded by a record COMMITTED here:
 *   claiming   written before a claim is asked for; only `held`, written after
 *              the door answered, is ever recorded as a discount, so a claim
 *              whose hold was never stored is still named and given back;
 *   releasing  written before a release is asked for; a stay in it never
 *              records a discount, whatever the door did, so a release whose
 *              own bookkeeping rolled back cannot come back as a discount.
 * `finishRelease` asks the door and writes `released`; the close and the sweep
 * finish anything left in either state. Releasing a claim that never landed is
 * harmless: the door answers `none`.
 *
 * THE PHONE NUMBER GOES ON STDIN AND NOWHERE ELSE. Argv is kept on the record,
 * so it carries the tenant, the garage, the instant, the consumer, this
 * stay's id and the fee -- never the number. The door's answers carry the last
 * four digits for a human at a terminal; `kept()` drops them before an answer
 * is stored. Nothing here logs the number or puts it in an error message.
 *
 * MONEY CROSSES THIS DOOR. The discount is the module's assertion, computed on
 * the module's own rule; it is checked for shape (whole minor units, not more
 * than the fee it was asked about, the fee and currency echoed back) and then
 * kept verbatim beside the line it produced. It is never recomputed here.
 *
 * COULD-NOT-DECIDE IS NOT NO-VALIDATION. A door that cannot be run, or exits 2,
 * raises `ValidationsUnavailable`. At the reader the claim route answers 5xx
 * and the reader shows the fee undiscounted -- nothing was taken, and asking
 * again is safe: the module answers a claim made again by the same stay with
 * the same claim. At the close, a hold the close must give back and cannot
 * falls to a 5xx and the lane retries. A door that REFUSES the request (exit
 * 3: a garage it does not know, a currency it does not take) is not an outage:
 * nothing is held, and a `validation_refused` event tells a human.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { withTenant } from './db.js';
import * as repo from './repository.js';
import { assertMinor, formatMinor } from './money.js';

export const SCRIPT = 'valet-validations';
export const CONSUMER = 'openparking';
export const LINE_CODE = 'validation';
export const LINK_STATED_EVENT_KIND = 'validations_link_stated';
export const REFUSED_EVENT_KIND = 'validation_refused';
export const RELEASED_EVENT_KIND = 'validation_released';
export const RELEASED_BEFORE_CLOSE_EVENT_KIND = 'validation_released_before_close';

/** The module could not decide. Not a verdict; the close does not record one. */
export class ValidationsUnavailable extends Error {
  constructor(message) {
    super(`validations could not answer: ${message}`);
  }
}

/** A stated link the module cannot answer questions about. */
export class LinkUnanswerable extends Error {
  constructor(message) {
    super(`the validations link cannot be used: ${message}`);
  }
}

function scriptPath(env = process.env) {
  return env.ENTITLEMENT_BIN_DIR ? join(env.ENTITLEMENT_BIN_DIR, SCRIPT) : SCRIPT;
}

/**
 * Run the door with `stdin` written and closed. Returns what it said and how it
 * exited; throws `ValidationsUnavailable` only when it could not be run at all.
 */
function door(argv, stdin, { env = process.env, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(scriptPath(env), argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new ValidationsUnavailable(`${SCRIPT} could not be run (${err.code ?? err.message})`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new ValidationsUnavailable(`${SCRIPT} did not answer within ${timeoutMs} ms`)));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    // A door that exits without reading stdin closes the pipe under the write.
    child.stdin.on('error', () => {});
    child.on('error', (err) =>
      finish(() => reject(new ValidationsUnavailable(`${SCRIPT} could not be run (${err.code ?? err.message})`))),
    );
    child.on('close', (code, signal) =>
      finish(() =>
        code === null
          ? reject(new ValidationsUnavailable(`${SCRIPT} was stopped by ${signal}`))
          : resolve({ exit_code: code, stdout, stderr }),
      ),
    );
    child.stdin.end(`${stdin}\n`);
  });
}

const parseJson = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

/** An answer as it is kept: verbatim, but for the phone's last four digits. */
function kept(answer) {
  if (answer === null) return null;
  const rest = { ...answer };
  delete rest.phone_last4;
  return rest;
}

/** A door's failure, in words that never include what was written to its stdin. */
function unavailable(step, out) {
  const said = parseJson(out.stdout);
  const why = (said?.detail ?? out.stderr ?? out.stdout ?? '').trim().slice(0, 300);
  return new ValidationsUnavailable(`${step} exit ${out.exit_code}: ${why}`);
}

/** The line a claim becomes: one more signed delta, after the engine's. */
function lineFor(claim, currency) {
  const rule =
    claim.discount_type === 'free' ? 'free parking'
      : claim.discount_type === 'percent' ? `${claim.discount_value}% off`
        : claim.discount_type === 'flat' ? `${formatMinor(Math.round(claim.discount_value * 100), currency)} off`
          : claim.discount_type;
  return {
    code: LINE_CODE,
    rule_id: null,
    text: `Validation from ${claim.validator_name ?? 'a merchant'} (${rule}): ${formatMinor(-claim.discount_minor, currency)}`,
    delta_minor: -claim.discount_minor,
  };
}

/** The claim's money, checked for shape against what it was asked. Throws on a mismatch. */
function checkedClaim(answer, { feeMinor, currency }) {
  const claim = answer?.claim;
  if (answer?.outcome !== 'claimed' || !claim || typeof claim !== 'object') {
    throw new ValidationsUnavailable(`claim exit 0 with an answer this platform does not recognise: ${JSON.stringify(kept(answer)).slice(0, 200)}`);
  }
  try {
    assertMinor(claim.discount_minor, 'discount_minor');
    assertMinor(claim.base_minor, 'base_minor');
  } catch (err) {
    throw new ValidationsUnavailable(`claim exit 0 with money that is not minor units: ${err.message}`);
  }
  if (claim.base_minor !== feeMinor || claim.currency !== currency) {
    throw new ValidationsUnavailable(
      `the claim answered for ${claim.base_minor} ${claim.currency}; it was asked about ${feeMinor} ${currency}`,
    );
  }
  if (claim.discount_minor < 0 || claim.discount_minor > feeMinor) {
    throw new ValidationsUnavailable(`the claim's discount ${claim.discount_minor} is outside 0..${feeMinor}`);
  }
  return claim;
}

/**
 * THE CLAIM, AT THE READER (amendment A1): the driver has entered `phone` and
 * the lane holds its priced decision for this open stay, `feeMinor` in
 * `currency` at `exitAt`. Read, and when a validation is live, claim it for
 * this stay on that fee -- so the amount the driver is shown next is the
 * discounted one.
 *
 * Returns `{ outcome, record, refusal }`:
 *   outcome  'held' | 'not_validated' | 'refused' | 'not_linked', for the lane;
 *   record   what goes on the stay (`sessions.validation`) -- a HOLD, only when
 *            outcome is 'held'; null otherwise, because nothing was taken;
 *   refusal  the door's refusal when it refused, for an event.
 * Throws `ValidationsUnavailable` when the door could not decide.
 */
export async function claimAtReader({ garage, sessionId, phone, feeMinor, currency, exitAt }, options = {}) {
  const link = garage.validations_link;
  if (!link) return { outcome: 'not_linked', record: null, refusal: null, reason: 'the garage names no garage in a validations module' };

  const at = exitAt.toISOString();
  const readArgv = ['validation-in-store', '--tenant', link.tenant_id, '--garage', link.garage_id, '--at', at];
  const read = await door(readArgv, phone, options);
  const readAnswer = parseJson(read.stdout);
  const asked = { argv: readArgv, exit_code: read.exit_code, answer: kept(readAnswer) };
  if (read.exit_code === 3) return { outcome: 'refused', record: null, refusal: kept(readAnswer), asked };
  if (read.exit_code !== 0 && read.exit_code !== 1) throw unavailable('validation-in-store', read);
  if (!readAnswer || (readAnswer.outcome !== 'validated' && readAnswer.outcome !== 'not_validated')) {
    throw new ValidationsUnavailable(`validation-in-store exit ${read.exit_code} with an answer this platform does not recognise`);
  }
  // ALREADY CLAIMED MAY BE THIS STAY'S OWN CLAIM: a claim whose hold this
  // platform failed to store (its transaction rolled back after the module
  // committed), asked again. The read cannot tell whose claim it was; the claim
  // can -- it answers this stay's claim again, and already_claimed for anyone
  // else's. So that one answer is asked on.
  if (read.exit_code === 1 && readAnswer.reason !== 'already_claimed') {
    return { outcome: 'not_validated', record: null, refusal: null, reason: readAnswer.reason, asked };
  }

  const claimArgv = [
    'claim-in-store', '--tenant', link.tenant_id, '--garage', link.garage_id, '--at', at,
    '--consumer', CONSUMER, '--ref', sessionId,
    '--base-minor', String(feeMinor), '--currency', currency,
  ];
  const claimed = await door(claimArgv, phone, options);
  const claimAnswer = parseJson(claimed.stdout);
  const claimRecord = { argv: claimArgv, exit_code: claimed.exit_code, answer: kept(claimAnswer) };
  if (claimed.exit_code === 3) return { outcome: 'refused', record: null, refusal: kept(claimAnswer), asked, claimed: claimRecord };
  if (claimed.exit_code === 1) {
    return { outcome: 'not_validated', record: null, refusal: null, reason: claimAnswer?.reason ?? null, asked, claimed: claimRecord };
  }
  if (claimed.exit_code !== 0) throw unavailable('claim-in-store', claimed);

  const claim = checkedClaim(claimAnswer, { feeMinor, currency });
  const line = lineFor(claim, currency);
  return {
    outcome: 'held',
    refusal: null,
    record: {
      consulted: true,
      state: 'held',
      module: 'validations',
      link,
      asked,
      claimed: claimRecord,
      held_at: new Date().toISOString(),
      // What the module asserted, on which fee, and the line it becomes.
      asserted_by: 'validations',
      base_minor: feeMinor,
      currency,
      discount_minor: claim.discount_minor,
      fee_after_minor: assertMinor(feeMinor + line.delta_minor, 'fee_after_minor'),
      line,
    },
  };
}

/** What a claim is before the door is asked (A2.3): committed first, never a discount. */
export function claimingRecord({ attempt, link, feeMinor, currency, prior, at = new Date() }) {
  return {
    consulted: true,
    state: 'claiming',
    module: 'validations',
    link,
    attempt,
    claiming_at: at.toISOString(),
    base_minor: feeMinor,
    currency,
    ...(prior ? { prior_state: prior.state } : {}),
  };
}

/** The states in which the module may hold a claim for this stay that no close will record. */
export const UNRESOLVED = new Set(['held', 'claiming', 'releasing']);

/**
 * THE CLOSE RECORDS WHAT WAS CLAIMED AND SHOWN. `held` is the stay's validation
 * record as it stands under the close's lock; `readerShown` is what the close
 * says the reader showed (`{fee_minor, currency}`), or null. A hold is taken
 * -- its line appended to the ledger, the fee the running total including it,
 * the record `recorded` -- only when the close's fee is the fee the claim was
 * made on AND the reader showed the discounted fee. Nothing asks the door and
 * nothing is recomputed.
 *
 * Anything else still unresolved -- a hold the close cannot take (covered,
 * unpriced, another fee, a reader that showed the fee as priced or said
 * nothing), a claim never held, a release never finished -- becomes
 * `releasing` on this row, in this transaction. The door is asked AFTER the
 * close commits (`finishRelease`), so no rollback here can undo a release the
 * module already made. Pure: no door, no database.
 *
 * Returns `{ pricing, record, releaseAfter }`.
 */
export function recordAtClose({ held, pricing, readerShown, at }) {
  if (!held || !UNRESOLVED.has(held.state)) return { pricing, record: held ?? null, releaseAfter: false };
  const priced = pricing.outcome === 'transient' && pricing.refusal === undefined && Number.isInteger(pricing.feeMinor);
  const shownDiscounted = readerShown !== null && readerShown !== undefined
    && readerShown.fee_minor === held.fee_after_minor && readerShown.currency === held.currency;
  if (held.state === 'held' && priced && pricing.feeMinor === held.base_minor && pricing.feeMinor > 0 && shownDiscounted) {
    const feeMinor = assertMinor(pricing.feeMinor + held.line.delta_minor, 'fee_minor');
    return {
      pricing: { ...pricing, feeMinor, breakdown: [...pricing.breakdown, held.line] },
      record: {
        ...held, state: 'recorded', recorded_at: at.toISOString(), fee_before_minor: pricing.feeMinor, fee_after_minor: feeMinor,
        reader_shown: readerShown,
      },
      releaseAfter: false,
    };
  }
  if (held.state === 'releasing') return { pricing, record: held, releaseAfter: true };
  const reason = held.state === 'claiming' ? 'a claim that was never held'
    : pricing.outcome === 'covered' ? 'the stay closed covered'
      : !priced ? 'the stay closed with no priced fee'
        : pricing.feeMinor !== held.base_minor ? `the stay closed at ${pricing.feeMinor}, not the ${held.base_minor} the claim was made on`
          : readerShown === null || readerShown === undefined ? 'the close does not say the reader showed the discounted fee'
            : `the reader showed ${readerShown.fee_minor} ${readerShown.currency}, not the discounted ${held.fee_after_minor} ${held.currency}`;
  return {
    pricing,
    record: {
      ...held, state: 'releasing', releasing_at: at.toISOString(), released_by: 'close', reason,
      ...(readerShown ? { reader_shown: readerShown } : {}),
    },
    releaseAfter: true,
  };
}

/**
 * FINISH A RELEASE (A2.3): the stay's record is `releasing`, committed. Ask the
 * door -- outside any transaction here -- then write `released`, under the
 * row's lock, only if the record is still the one that was released. A door
 * that could not decide, or a write that fails, leaves `releasing` for the
 * next sweep; asking again is harmless. Returns the door's answer, or null
 * when there was nothing to finish.
 */
export async function finishRelease(tenantId, sessionId, { now = new Date(), options = {} } = {}) {
  const before = await withTenant(tenantId, (c) => repo.validationRow(c, tenantId, sessionId));
  if (!before || before.validation?.state !== 'releasing') return null;
  const garage = await withTenant(tenantId, (c) => repo.getGarage(c, tenantId, before.garage_id));
  const released = await release({ garage, sessionId, at: now }, options);
  await withTenant(tenantId, async (client) => {
    const row = await repo.lockValidationRow(client, tenantId, sessionId);
    if (row?.validation?.state !== 'releasing' || row.validation.releasing_at !== before.validation.releasing_at) return;
    await repo.setValidationRecord(client, tenantId, sessionId, {
      ...row.validation, state: 'released', released_at: now.toISOString(), release: released,
    });
  });
  return released;
}

/**
 * Give a hold back through the door. Returns the door's answer, kept; throws
 * `ValidationsUnavailable` when the door could not decide. `not_released` is
 * an answer, not a failure: `none` means the module holds no claim for this
 * stay (already given back), `superseded` that the phone has another live
 * validation for the day, which is the driver's.
 */
export async function release({ garage, sessionId, at }, options = {}) {
  const link = garage.validations_link;
  if (!link) throw new ValidationsUnavailable('a hold on a garage that no longer links a validations module cannot be released here');
  const argv = [
    'release-in-store', '--tenant', link.tenant_id, '--garage', link.garage_id, '--at', at.toISOString(),
    '--consumer', CONSUMER, '--ref', sessionId,
  ];
  const out = await door(argv, '', options);
  const answer = parseJson(out.stdout);
  if ((out.exit_code === 0 || out.exit_code === 1) && answer && typeof answer.outcome === 'string') {
    return { argv, exit_code: out.exit_code, answer: kept(answer) };
  }
  throw unavailable('release-in-store', out);
}

/**
 * THE SWEEP. Three queues, each moved to `releasing` under the row's own lock
 * and COMMITTED before the door is asked (A2.3), then finished:
 *   * a hold on a still-OPEN stay older than `holdMinutes` -- the driver
 *     entered a phone and did not pay and leave;
 *   * a `claiming` record on an open stay older than `claimingGraceSeconds`
 *     -- a claim whose hold was never stored (the transaction after the door
 *     rolled back); the grace keeps a claim in flight from being raced;
 *   * every `releasing` record, open or closed -- a release begun and not
 *     finished.
 * A release the door could not make is left `releasing` for the next run.
 * Returns a summary.
 */
export async function releaseStaleHolds(tenantId, { holdMinutes, claimingGraceSeconds = 60, now = new Date(), options = {} }) {
  const cutoff = new Date(now.getTime() - holdMinutes * 60_000);
  const claimingCutoff = new Date(now.getTime() - claimingGraceSeconds * 1000);
  const summary = { tenant_id: tenantId, stale: 0, claiming: 0, unfinished: 0, released: 0, not_released: 0, failed: 0 };
  const queues = await withTenant(tenantId, async (c) => ({
    stale: await repo.staleValidationHolds(c, tenantId, cutoff),
    claiming: await repo.staleClaimingRecords(c, tenantId, claimingCutoff),
    unfinished: await repo.releasingRecords(c, tenantId),
  }));
  for (const key of ['stale', 'claiming', 'unfinished']) summary[key] = queues[key].length;

  const begin = async (id, fits, reason) => {
    await withTenant(tenantId, async (client) => {
      const row = await repo.lockValidationRow(client, tenantId, id);
      if (!row || row.exit_at !== null || !fits(row.validation)) return;
      await repo.setValidationRecord(client, tenantId, id, {
        ...row.validation, state: 'releasing', releasing_at: now.toISOString(), released_by: 'sweep', reason,
      });
      await repo.appendEvents(client, tenantId, [{
        garageId: row.garage_id,
        laneId: null,
        eventId: `validation_released:${id}:${row.validation.held_at ?? row.validation.claiming_at}`,
        kind: RELEASED_EVENT_KIND,
        occurredAt: now,
        detail: { actor: 'platform:sweep', session_id: id, held_at: row.validation.held_at ?? null, reason },
      }]);
    });
  };
  const finish = async (id) => {
    try {
      const released = await finishRelease(tenantId, id, { now, options });
      if (released) summary[released.answer.outcome === 'released' ? 'released' : 'not_released'] += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(`validation hold release failed for ${id}: ${err.message ?? err}`);
    }
  };

  for (const { id } of queues.stale) {
    try {
      await begin(id, (v) => v?.state === 'held' && new Date(v.held_at) <= cutoff,
        `no close took the claim within ${holdMinutes} minutes of it`);
    } catch (err) {
      summary.failed += 1;
      console.error(`validation hold release failed for ${id}: ${err.message ?? err}`);
      continue;
    }
    await finish(id);
  }
  for (const { id } of queues.claiming) {
    try {
      await begin(id, (v) => v?.state === 'claiming' && new Date(v.claiming_at) <= claimingCutoff,
        'a claim whose hold was never stored');
    } catch (err) {
      summary.failed += 1;
      console.error(`validation hold release failed for ${id}: ${err.message ?? err}`);
      continue;
    }
    await finish(id);
  }
  for (const { id } of queues.unfinished) await finish(id);
  return summary;
}

/** The sum of the validation lines on a ledger: what the fee holds that the engine did not price. */
export function validationDelta(breakdown) {
  if (!Array.isArray(breakdown)) return 0;
  return breakdown.filter((l) => l?.code === LINE_CODE).reduce((sum, l) => sum + Number(l.delta_minor), 0);
}

/**
 * Prove a stated link can be used: the module must ANSWER a read about that
 * garage before the link is stored. The probe's stdin is not a phone number,
 * so the module answers "not validated: phone_unreadable" after it has checked
 * the garage -- and refuses the garage by name if it does not know it. A read;
 * the module writes nothing.
 */
export async function probeLink(link, options = {}) {
  const argv = ['validation-in-store', '--tenant', link.tenant_id, '--garage', link.garage_id, '--at', new Date().toISOString()];
  let out;
  try {
    out = await door(argv, 'probe', options);
  } catch (err) {
    throw new LinkUnanswerable(err.message);
  }
  const answer = parseJson(out.stdout);
  if ((out.exit_code === 0 || out.exit_code === 1) && answer && typeof answer.outcome === 'string') {
    return { answered: true, exit_code: out.exit_code };
  }
  throw new LinkUnanswerable(unavailable('validation-in-store', out).message);
}

/** Store the link, probed, and record who stated it. `link` null unlinks. */
export async function stateLink(client, tenantId, garage, link, { actor, options = {} }) {
  const probe = link ? await probeLink(link, options) : null;
  const { rows } = await client.query(
    `UPDATE garages SET validations_link = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, garage.id, link ? JSON.stringify(link) : null],
  );
  const updated = rows[0];
  await repo.appendEvents(client, tenantId, [
    {
      garageId: garage.id,
      laneId: null,
      eventId: `validations_link:${garage.id}:${Date.now()}`,
      kind: LINK_STATED_EVENT_KIND,
      occurredAt: new Date(),
      detail: {
        actor,
        garage_id: garage.id,
        before: garage.validations_link,
        after: updated.validations_link,
        probe,
      },
    },
  ]);
  return updated;
}
