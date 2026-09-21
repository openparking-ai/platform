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
 *                               --direction exit --at EXIT
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

/** Run one door. Returns what it said and how it exited; throws only when it could not be run at all. */
async function door(module, argv, { env = process.env, timeoutMs = 15_000 } = {}) {
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
    throw new EntitlementUnavailable(module, `${script} could not be run (${err.code ?? err.signal ?? err.message})`);
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
export async function consult({ garage, identity, laneId, entryAt, exitAt }, options = {}) {
  const record = { identity, asked_at: exitAt.toISOString() };
  const coveredBy = [];
  for (const module of Object.keys(MODULES)) {
    const link = garage[MODULES[module].linkColumn];
    if (!link) {
      record[module] = { consulted: false, reason: 'not linked: the garage names no garage in this module' };
      continue;
    }
    const answer = await ask(module, link, { identity, laneId, entryAt, exitAt }, options);
    record[module] = answer;
    if (answer.covered) coveredBy.push(module);
  }
  return {
    outcome: coveredBy.length ? EXIT_OUTCOMES.COVERED : EXIT_OUTCOMES.TRANSIENT,
    covered_by: coveredBy,
    record: { ...record, covered_by: coveredBy },
  };
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
