/**
 * The exit's entitlement question, and its three outcomes (migration 0015).
 *
 * Before a stay is priced, two modules are asked whether the stay is covered:
 * `garage-pass` (a pass) and `monthly-billing` (a monthly agreement). Each is
 * consulted THROUGH ITS OWN DOOR -- its command line, run as a subprocess
 * with the environment the operator gave this platform, exactly as the
 * pass-billing connector reaches them. This platform imports neither, holds
 * none of their data, and reads what they print.
 *
 *   garage-pass access-in-store --tenant T --garage G --vehicle V --lane L
 *                               --direction exit --at EXIT --entered-at ENTRY
 *       exit 0 covered · 1 not covered · anything else: could not decide
 *       (2: refused to answer / configuration; 3: the request was refused,
 *       e.g. a garage it does not know). Prints a JSON answer on 0/1/3.
 *   monthly-billing covered-in-store --tenant T --garage G --vehicle V
 *                                    --at EXIT --entered-at ENTRY
 *       exit 0 covered · 1 not covered · 2 could not decide. Prints lines.
 *
 * NO MONEY CROSSES EITHER CALL, in either direction: the argv carries an
 * identity, a garage, a lane and instants, and the answers carry access
 * facts. Their own tests hold their side (garage-pass G3/G21, monthly-billing
 * G6); the argv is kept on the record so this side can be checked too.
 *
 * EACH VISIT IS A SESSION OF THE PASS (the owner's rule, 2026-10-31; 0048):
 * a monthly or a pass holder's every in and out is a stay of its own, asked
 * about at its own exit with its own entry (`--entered-at`, to both
 * modules), so the pass's own rules -- its days, its hours, a car replaced on
 * it -- are judged per session, and nothing carries from one session to the
 * next. The pass a session belonged to is kept on it (`passSessionOf`).
 *
 * A STAY A REGISTRATION QR LET IN (0048) is asked about by the plate the QR
 * was made for (`passIdentity`, the stay's `entry_qr.qr_plate`), to
 * garage-pass only: the QR is its credential, and a car let in on one
 * difference or with nothing read is the pass's car. Monthly billing is
 * asked by the plate as read, or not at all when none was.
 *
 * COULD-NOT-DECIDE IS NOT NOT-COVERED. A module that cannot answer -- no DSN,
 * a database down, a garage it does not know, the script missing -- raises
 * `EntitlementUnavailable`, and the close lets that fall to a 5xx so the lane
 * retries: recording such a stay as transient would bill a pass holder on
 * the strength of an outage.
 *
 * LINKS ARE STATED. A garage names its garage-pass garage and its
 * monthly-billing garage, each under a tenant of that module
 * (`{tenant_id, garage_id}`), or is NOT LINKED to that module and the record
 * says so. `probeLink` asks the module a question it must be able to answer
 * -- covered or not, about a probe identity -- and refuses a link the module
 * cannot answer, by name, before it is stored.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as repo from './repository.js';

const run = promisify(execFile);

/** The closed set of what an exit can be. The third is declared and produced nowhere -- see 0015. */
export const EXIT_OUTCOMES = Object.freeze({
  COVERED: 'covered',
  TRANSIENT: 'transient',
  TRANSIENT_CARD_ON_FILE: 'transient_card_on_file',
});

export const MODULES = Object.freeze({
  garage_pass: { script: 'garage-pass', linkColumn: 'garage_pass_link' },
  monthly_billing: { script: 'monthly-billing', linkColumn: 'monthly_billing_link' },
});

export const EXIT_COVERED_EVENT_KIND = 'exit_covered';
export const LINKS_STATED_EVENT_KIND = 'entitlement_links_stated';

/** A module could not decide. Not a verdict; the close does not record one. */
export class EntitlementUnavailable extends Error {
  constructor(module, message) {
    super(`${module} could not answer: ${message}`);
    this.module = module;
  }
}

/** A stated link the module cannot answer questions about. */
export class LinkUnanswerable extends Error {
  constructor(module, message) {
    super(`the ${module} link cannot be used: ${message}`);
    this.module = module;
  }
}

/** Where the two scripts are. A directory, or the PATH. */
function scriptPath(script, env = process.env) {
  return env.ENTITLEMENT_BIN_DIR ? join(env.ENTITLEMENT_BIN_DIR, script) : script;
}

/**
 * Run one door. Returns what it said and how it exited; throws only when it
 * could not be run at all. The error names the script and why, never the
 * argv: a QR's token rides on it (`redeem`).
 */
export async function door(module, argv, { env = process.env, timeoutMs = 15_000 } = {}) {
  const script = MODULES[module].script;
  try {
    const { stdout, stderr } = await run(scriptPath(script, env), argv, {
      env,
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
    });
    return { exit_code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code === 'number' && err.stdout !== undefined) {
      return { exit_code: err.code, stdout: err.stdout, stderr: err.stderr };
    }
    // ENOENT, a timeout, a signal: the door could not be run at all.
    throw new EntitlementUnavailable(module, `${script} could not be run (${err.code ?? err.signal ?? 'no exit status'})`);
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * One module's answer for one movement, in one shape whichever module it
 * came from: `{ consulted: true, covered, argv, exit_code, answer, ... }`.
 * `answer` is what the module printed -- the JSON object for garage-pass,
 * the lines for monthly-billing -- verbatim, because the named reason is the
 * module's sentence and this platform does not paraphrase it.
 */
async function ask(module, link, { identity, laneId, entryAt, exitAt }, options) {
  const at = exitAt.toISOString();
  const argv =
    module === 'garage_pass'
      ? [
          'access-in-store', '--tenant', link.tenant_id, '--garage', link.garage_id,
          '--vehicle', identity, '--lane', laneId, '--direction', 'exit', '--at', at,
          '--entered-at', entryAt.toISOString(),
        ]
      : [
          'covered-in-store', '--tenant', link.tenant_id, '--garage', link.garage_id,
          '--vehicle', identity, '--at', at, '--entered-at', entryAt.toISOString(),
        ];
  const out = await door(module, argv, options);
  const record = { consulted: true, module, link, argv, exit_code: out.exit_code };
  if (module === 'garage_pass') {
    const answer = parseJson(out.stdout);
    if (out.exit_code === 0 || out.exit_code === 1) {
      if (!answer || (answer.outcome !== 'covered' && answer.outcome !== 'not_covered')) {
        throw new EntitlementUnavailable(module, `exit ${out.exit_code} with an answer this platform does not recognise: ${out.stdout.slice(0, 200)}`);
      }
      return { ...record, covered: answer.outcome === 'covered', answer };
    }
    throw new EntitlementUnavailable(module, `exit ${out.exit_code}: ${(answer?.detail ?? out.stderr ?? out.stdout).trim().slice(0, 300)}`);
  }
  const lines = out.stdout.split('\n').filter((l) => l.length > 0);
  if (out.exit_code === 0 || out.exit_code === 1) {
    const verdict = lines[0];
    if (verdict !== 'COVERED' && verdict !== 'NOT COVERED') {
      throw new EntitlementUnavailable(module, `exit ${out.exit_code} with an answer this platform does not recognise: ${out.stdout.slice(0, 200)}`);
    }
    return { ...record, covered: out.exit_code === 0, answer: { verdict, lines } };
  }
  throw new EntitlementUnavailable(module, `exit ${out.exit_code}: ${(out.stderr || out.stdout).trim().slice(0, 300)}`);
}

/**
 * The question, for one exiting stay. Both modules are asked -- every linked
 * one, always, so the record says what each said even when the first
 * already covered the stay -- and the outcome is COVERED if any said so,
 * TRANSIENT otherwise. Returns `{ outcome, covered_by, record }`; `record`
 * is what goes on the row.
 */
export async function consult({ garage, identity, passIdentity = null, qr = null, laneId, exitLaneIds = null, entryAt, exitAt }, options = {}) {
  const record = { identity, asked_at: exitAt.toISOString() };
  const coveredBy = [];
  for (const module of Object.keys(MODULES)) {
    const link = garage[MODULES[module].linkColumn];
    if (!link) {
      record[module] = { consulted: false, reason: 'not linked: the garage names no garage in this module' };
      continue;
    }
    // Who is asked about: the QR's plate, to garage-pass, for a stay a QR let
    // in; the plate or ticket as read otherwise.
    const asked = module === 'garage_pass' && passIdentity ? passIdentity : identity;
    if (!asked) {
      record[module] = { consulted: false, reason: 'no plate was read at the entry: this module cannot be asked about this car' };
      continue;
    }
    const byQr = module === 'garage_pass' && Boolean(passIdentity);
    const asQr = (r) => (byQr ? { ...r, asked_as: 'qr_plate', qr } : r);
    if (module === 'garage_pass' && laneId === null) {
      // A STAY A PERSON ENDED (0043): no lane was crossed, and a pass answers
      // for a lane. It is asked at each of the garage's exit lanes
      // (`exitLaneIds`), and covers the stay if any of them says so. A
      // garage with no exit lane has nowhere to ask: the pass is not asked,
      // and the record says so (`unasked`) for a person to see.
      const lanes = exitLaneIds ?? [];
      if (lanes.length === 0) {
        record[module] = { consulted: false, unasked: true, reason: 'no exit lane to ask at: a person ended this stay, and a pass answers for a lane' };
        continue;
      }
      const atLanes = [];
      let answer = null;
      for (const lane of lanes) {
        answer = await ask(module, link, { identity: asked, laneId: lane, entryAt, exitAt }, options);
        atLanes.push({ lane_id: lane, covered: answer.covered });
        if (answer.covered) break;
      }
      record[module] = asQr({ ...answer, asked_at_lanes: atLanes });
      if (atLanes.some((a) => a.covered)) coveredBy.push('garage_pass');
      continue;
    }
    const answer = await ask(module, link, { identity: asked, laneId, entryAt, exitAt }, options);
    record[module] = asQr(answer);
    if (answer.covered) coveredBy.push(module);
  }
  return {
    outcome: coveredBy.length ? EXIT_OUTCOMES.COVERED : EXIT_OUTCOMES.TRANSIENT,
    covered_by: coveredBy,
    record: { ...record, covered_by: coveredBy },
  };
}

/**
 * THE PASS A STAY WAS A SESSION OF (0048), from what its exit was told: the
 * garage-pass answer that named a pass -- covered or not, its reason kept --
 * or else the monthly agreement that covered it. Null when no module named
 * one. Each session of a pass is its own stay with its own answer; nothing
 * carries from one to the next.
 */
export function passSessionOf(record, qr = null) {
  const gp = record?.garage_pass;
  if (gp?.consulted && gp.answer?.pass_id) {
    return {
      module: 'garage_pass',
      pass_id: String(gp.answer.pass_id),
      covered: Boolean(gp.covered),
      reason: gp.covered ? null : gp.answer.reason ?? null,
      covering_term: gp.covered ? gp.answer.covering_term ?? null : null,
      ...(qr?.enrolment ? { enrolment: qr.enrolment } : {}),
      ...(qr?.passed_by ? { passed_by: qr.passed_by } : {}),
    };
  }
  const mb = record?.monthly_billing;
  const agreement = mb?.consulted && mb.covered
    ? mb.answer?.lines?.find((l) => l.includes('under agreement'))?.trim() ?? null
    : null;
  if (agreement) return { module: 'monthly_billing', agreement, covered: true };
  return null;
}

export const REGISTER_VERB = 'show-garage-register';

/**
 * THE ENTITLEMENT FACTS FOR A GARAGE, for the lane's cache: each linked
 * module's register, read whole through its own `show-garage-register`
 * verb -- garage-pass G27, monthly-billing G48 -- the JSON it printed kept
 * verbatim under `register`, beside the argv and the exit code, exactly as
 * `consult` keeps a movement's answer. This platform paraphrases neither
 * module: which vehicle a pass or an agreement holds at the garage, its
 * state and its days are the modules' words, and the lane reads them with
 * its own clock, which is how both verbs are written to be read.
 *
 * A READ THAT COULD NOT BE MADE IS SAID, NEVER FILLED IN. A module that is
 * not linked is `{ consulted: false, reason }`. A door that could not be run,
 * or answered with something that is not its register, is
 * `{ consulted: true, unavailable, argv, exit_code }` -- no `register` key --
 * and `complete` is false. An empty register is a fact a module states
 * (exit 0, `registrations: []`); an absent one is an outage, and a reader
 * that replaced what it holds with nothing on the strength of an outage
 * would have every pass holder paying at the next exit. So: a module's facts
 * are replaced only when its `register` is present. The rest of the payload
 * is still served -- plans and stays are this platform's own -- which is why
 * this is a field and not a 5xx.
 */
export async function registers(garage, options = {}) {
  const facts = { read_at: new Date().toISOString(), complete: true };
  for (const module of Object.keys(MODULES)) {
    const link = garage[MODULES[module].linkColumn];
    if (!link) {
      facts[module] = { consulted: false, reason: 'not linked: the garage names no garage in this module' };
      continue;
    }
    const argv = [REGISTER_VERB, '--tenant', link.tenant_id, '--garage', link.garage_id];
    let out;
    try {
      out = await door(module, argv, options);
    } catch (err) {
      facts[module] = { consulted: true, module, link, argv, unavailable: err.message };
      facts.complete = false;
      continue;
    }
    const record = { consulted: true, module, link, argv, exit_code: out.exit_code };
    const register = out.exit_code === 0 ? parseJson(out.stdout) : null;
    if (!register || !Array.isArray(register.registrations)) {
      facts[module] = {
        ...record,
        unavailable: `exit ${out.exit_code}: ${(out.stderr || out.stdout).trim().slice(0, 300)}`,
      };
      facts.complete = false;
      continue;
    }
    facts[module] = { ...record, register };
  }
  return facts;
}

/**
 * Prove a stated link can be used: the module must ANSWER a question about
 * that garage -- covered or not, for a probe identity nothing is registered
 * under -- before the link is stored. A module that refuses the garage, or
 * cannot be reached, refuses the link by name. A read; the modules write
 * nothing for an access question.
 */
export async function probeLink(module, link, options = {}) {
  const now = new Date();
  try {
    const answer = await ask(
      module,
      link,
      { identity: `probe-${now.getTime()}`, laneId: 'probe', entryAt: new Date(now.getTime() - 3_600_000), exitAt: now },
      options,
    );
    return { answered: true, exit_code: answer.exit_code };
  } catch (err) {
    if (err instanceof EntitlementUnavailable) throw new LinkUnanswerable(module, err.message);
    throw err;
  }
}

/** The shape of a link from a request body, or a refusal naming the field. */
export function linkField(raw, name) {
  if (raw === null) return null;
  if (
    !raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.tenant_id !== 'string' || raw.tenant_id.trim() === ''
    || typeof raw.garage_id !== 'string' || raw.garage_id.trim() === ''
  ) {
    throw new TypeError(`${name} is null (not linked) or {tenant_id, garage_id}, both non-empty strings`);
  }
  return { tenant_id: raw.tenant_id, garage_id: raw.garage_id };
}

/** Store the links, probed, and record who stated them. */
export async function stateLinks(client, tenantId, garage, links, { actor, options = {} }) {
  const probes = {};
  for (const module of Object.keys(MODULES)) {
    if (links[module]) probes[module] = await probeLink(module, links[module], options);
  }
  const { rows } = await client.query(
    `UPDATE garages SET garage_pass_link = $3, monthly_billing_link = $4
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, garage.id, links.garage_pass ? JSON.stringify(links.garage_pass) : null,
     links.monthly_billing ? JSON.stringify(links.monthly_billing) : null],
  );
  const updated = rows[0];
  await repo.appendEvents(client, tenantId, [
    {
      garageId: garage.id,
      laneId: null,
      eventId: `entitlement_links:${garage.id}:${Date.now()}`,
      kind: LINKS_STATED_EVENT_KIND,
      occurredAt: new Date(),
      detail: {
        actor,
        garage_id: garage.id,
        before: { garage_pass: garage.garage_pass_link, monthly_billing: garage.monthly_billing_link },
        after: { garage_pass: updated.garage_pass_link, monthly_billing: updated.monthly_billing_link },
        probes,
      },
    },
  ]);
  return updated;
}
