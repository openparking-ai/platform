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
 * raises `ValidationsUnavailable` and the close falls to a 5xx so the lane
 * retries -- closing without the discount would charge a validated driver on
 * the strength of an outage (0015's rule for the pass holder). The retry is
 * safe: the module answers a claim made again by the same stay with the same
 * claim. A door that REFUSES the request (exit 3: a garage it does not know, a
 * currency it does not take) is not an outage and a retry would not change it,
 * so the stay closes undiscounted with the refusal on the record -- the close
 * is never refused on its account.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import * as repo from './repository.js';
import { assertMinor, formatMinor } from './money.js';

export const SCRIPT = 'valet-validations';
export const CONSUMER = 'openparking';
export const LINE_CODE = 'validation';
export const LINK_STATED_EVENT_KIND = 'validations_link_stated';
export const REFUSED_EVENT_KIND = 'validation_refused';

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
 * The validation question for one closing stay. `phone` is what the driver
 * entered, or null. `pricing` is the close's pricing as decided -- by the lane
 * or by this platform -- and is returned unchanged unless a validation was
 * claimed, in which case it is returned with the line appended and the fee
 * the running total including it.
 *
 * Returns `{ pricing, record, refusal }`: `record` is what goes in
 * `sessions.validation` (null when no phone was given), `refusal` the door's
 * refusal when it refused, for an event beside the row.
 */
export async function atClose({ garage, sessionId, phone, pricing, currency, exitAt }, options = {}) {
  if (phone === null) return { pricing, record: null, refusal: null };
  const link = garage.validations_link;
  if (!link) {
    return { pricing, record: { consulted: false, reason: 'not linked: the garage names no garage in a validations module' }, refusal: null };
  }
  if (pricing.outcome !== 'transient' || pricing.refusal !== undefined || !Number.isInteger(pricing.feeMinor)) {
    const why = pricing.outcome === 'covered' ? 'the stay is covered' : 'the stay has no priced fee';
    return { pricing, record: { consulted: false, reason: `nothing to discount: ${why}` }, refusal: null };
  }
  if (pricing.feeMinor === 0) {
    return { pricing, record: { consulted: false, reason: 'nothing to discount: the fee is zero' }, refusal: null };
  }

  const at = exitAt.toISOString();
  const readArgv = ['validation-in-store', '--tenant', link.tenant_id, '--garage', link.garage_id, '--at', at];
  const read = await door(readArgv, phone, options);
  const readAnswer = parseJson(read.stdout);
  const asked = { argv: readArgv, exit_code: read.exit_code, answer: kept(readAnswer) };
  const record = { consulted: true, module: 'validations', link, asked };
  if (read.exit_code === 3) {
    return { pricing, record: { ...record, applied: false, refused: kept(readAnswer) }, refusal: kept(readAnswer) };
  }
  if (read.exit_code !== 0 && read.exit_code !== 1) throw unavailable('validation-in-store', read);
  if (!readAnswer || (readAnswer.outcome !== 'validated' && readAnswer.outcome !== 'not_validated')) {
    throw new ValidationsUnavailable(`validation-in-store exit ${read.exit_code} with an answer this platform does not recognise`);
  }
  // ALREADY CLAIMED MAY BE THIS STAY'S OWN CLAIM: a close whose transaction
  // rolled back after the module committed the claim, retried. The read cannot
  // tell whose claim it was; the claim can -- it answers this stay's claim again,
  // and answers already_claimed for anyone else's. So that one answer is asked on.
  if (read.exit_code === 1 && readAnswer.reason !== 'already_claimed') {
    return { pricing, record: { ...record, applied: false }, refusal: null };
  }

  const claimArgv = [
    'claim-in-store', '--tenant', link.tenant_id, '--garage', link.garage_id, '--at', at,
    '--consumer', CONSUMER, '--ref', sessionId,
    '--base-minor', String(pricing.feeMinor), '--currency', currency,
  ];
  const claimed = await door(claimArgv, phone, options);
  const claimAnswer = parseJson(claimed.stdout);
  record.claimed = { argv: claimArgv, exit_code: claimed.exit_code, answer: kept(claimAnswer) };
  if (claimed.exit_code === 3) {
    return { pricing, record: { ...record, applied: false, refused: kept(claimAnswer) }, refusal: kept(claimAnswer) };
  }
  if (claimed.exit_code === 1) return { pricing, record: { ...record, applied: false }, refusal: null };
  if (claimed.exit_code !== 0) throw unavailable('claim-in-store', claimed);

  const claim = checkedClaim(claimAnswer, { feeMinor: pricing.feeMinor, currency });
  const line = lineFor(claim, currency);
  const feeMinor = assertMinor(pricing.feeMinor + line.delta_minor, 'fee_minor');
  return {
    pricing: { ...pricing, feeMinor, breakdown: [...pricing.breakdown, line] },
    record: {
      ...record,
      applied: true,
      // What the module asserted, and what this platform did with it.
      asserted_by: 'validations',
      discount_minor: claim.discount_minor,
      fee_before_minor: pricing.feeMinor,
      fee_after_minor: feeMinor,
    },
    refusal: null,
  };
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
