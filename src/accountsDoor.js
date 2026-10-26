/**
 * The linked accounts door (README, "Linked accounts: people beside the
 * admin"). The module that keeps other people is ITS OWN SYSTEM: its command
 * line, run as a subprocess with the environment this platform was given,
 * found in ENTITLEMENT_BIN_DIR or on PATH. This platform imports nothing of it
 * and keeps none of its data beyond a session's answer.
 *
 * WHICH COMMAND IS THE DEPLOYMENT'S TO SAY. `ACCOUNTS_DOOR` names it, a bare
 * command name, and there is NO default. Unset means this deployment has only
 * the one admin: nothing here ever runs, and sign-in is exactly what it was.
 *
 *   <door> sign-in                                < {"email", "password"}
 *       0 the person · 1 refused (no such person, a wrong password) · 2 could not decide
 *   <door> who --tenant T --person P
 *       0 the person · 1 gone · 2 could not decide
 *   <door> passkey --credential C
 *       0 {person, tenant, public_key, counter, transports} · 1 unknown · 2
 *   <door> passkey-used --credential C --counter N
 *       0 recorded · 1 refused (the counter did not go up) · 2
 *
 * THE PASSWORD GOES ON STDIN AND NOWHERE ELSE: argv is in the process list.
 *
 * COULD-NOT-DECIDE IS NEVER A YES. A door that cannot be run, does not answer
 * in time, exits anything but 0 or 1, or answers 0 with anything but the shape
 * below, raises `AccountsUndecided`: sign-in refuses and lets nobody in, and a
 * session waiting on `who` refuses the request.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { isPermission } from './permissions.js';

/** The module could not decide. Never a verdict. */
export class AccountsUndecided extends Error {
  constructor(message) {
    super(`the linked accounts module could not answer: ${message}`);
  }
}

const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CREDENTIAL = /^[A-Za-z0-9_-]{16,1366}$/;
const TIMEOUT_MS = 15_000;
const MAX_GARAGES = 1000;

/** Whether this deployment names an accounts door, read now. Unset and empty are the same: none. */
export function doorConfigured(env = process.env) {
  return env.ACCOUNTS_DOOR !== undefined && env.ACCOUNTS_DOOR !== '';
}

function executableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The one lookup of the door, for start-up and for every run. `{ path }` or `{ why }`. */
function findDoor(env) {
  if (!doorConfigured(env)) return { why: 'this deployment names no accounts door (ACCOUNTS_DOOR is unset)' };
  const name = env.ACCOUNTS_DOOR;
  if (!BARE_COMMAND.test(name) || name.includes('..')) return { why: 'ACCOUNTS_DOOR is not a bare command name' };
  const dirs = env.ENTITLEMENT_BIN_DIR ? [env.ENTITLEMENT_BIN_DIR] : (env.PATH ?? '').split(delimiter).filter(Boolean);
  const path = dirs.map((dir) => join(dir, name)).find(executableFile);
  if (path === undefined) return { why: `ACCOUNTS_DOOR names no executable file ${env.ENTITLEMENT_BIN_DIR ? 'in ENTITLEMENT_BIN_DIR' : 'on PATH'}` };
  return { path };
}

/** Before the port opens: a door that is named and could never run refuses to start. Unset passes. */
export function assertAccountsDoor(env = process.env) {
  if (!doorConfigured(env)) return;
  const { why } = findDoor(env);
  if (why !== undefined) throw new Error(`${why} (it is set to ${JSON.stringify(env.ACCOUNTS_DOOR)}).`);
}

/** Run the door with `stdin` written and closed: what it said and how it exited. */
function run(argv, stdin, { env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const { path, why } = findDoor(env);
    if (why !== undefined) {
      reject(new AccountsUndecided(why));
      return;
    }
    let child;
    try {
      child = spawn(path, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new AccountsUndecided(`the door could not be run (${err.code ?? 'error'})`));
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new AccountsUndecided(`the door did not answer within ${timeoutMs} ms`)));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => {
      if (stdout.length < 65_536) stdout += d;
    });
    // What the door says on stderr is its own; it may quote what it was given.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', (err) => finish(() => reject(new AccountsUndecided(`the door could not be run (${err.code ?? 'error'})`))));
    child.on('close', (code, signal) => finish(() => (code === null
      ? reject(new AccountsUndecided(`the door was stopped by ${signal}`))
      : resolve({ exitCode: code, stdout }))));
    child.stdin.end(stdin);
  });
}

function parse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A person as the door answered, checked for shape; anything else is could-not-decide. */
export function personOf(answer) {
  const a = answer ?? {};
  const email = typeof a.email === 'string' ? a.email.trim().toLowerCase() : '';
  const garages = a.garages === 'all' ? 'all'
    : Array.isArray(a.garages) && a.garages.length <= MAX_GARAGES && a.garages.every((g) => typeof g === 'string' && UUID.test(g)) ? [...new Set(a.garages)]
      : null;
  const ok = typeof a.person === 'string' && UUID.test(a.person)
    && typeof a.tenant === 'string' && UUID.test(a.tenant)
    && email.length >= 3 && email.length <= 254 && email.includes('@')
    && (a.name === null || a.name === undefined || (typeof a.name === 'string' && [...a.name].length <= 200))
    && (a.language === undefined || a.language === null || a.language === 'en' || a.language === 'es')
    && garages !== null
    && Array.isArray(a.permissions) && a.permissions.every(isPermission)
    && typeof a.version === 'string' && a.version.length >= 1 && a.version.length <= 128;
  if (!ok) throw new AccountsUndecided('an answer that is not a person');
  return {
    person: a.person, tenant: a.tenant, email, name: a.name ?? null, language: a.language ?? 'en',
    garages, permissions: [...new Set(a.permissions)], version: a.version,
  };
}

/** The verdict of a run: 0 and 1 are answers, anything else could not decide. */
function verdict(step, out) {
  if (out.exitCode === 1) return null;
  if (out.exitCode !== 0) throw new AccountsUndecided(`${step} exit ${out.exitCode}`);
  const answer = parse(out.stdout);
  if (!answer) throw new AccountsUndecided(`${step} answered no JSON`);
  return answer;
}

/** The person this email and password are, or null when refused. */
export async function signIn(email, password, options) {
  const answer = verdict('sign-in', await run(['sign-in'], `${JSON.stringify({ email, password })}\n`, options));
  return answer === null ? null : personOf(answer);
}

/** The person as they are now, or null when gone. */
export async function who(tenant, person, options) {
  const answer = verdict('who', await run(['who', '--tenant', tenant, '--person', person], '', options));
  return answer === null ? null : personOf(answer);
}

/** A passkey the module keeps, or null when it knows none by this id. */
export async function passkey(credential, options) {
  if (!CREDENTIAL.test(credential)) return null;
  const a = verdict('passkey', await run(['passkey', '--credential', credential], '', options));
  if (a === null) return null;
  const ok = typeof a.person === 'string' && UUID.test(a.person) && typeof a.tenant === 'string' && UUID.test(a.tenant)
    && typeof a.public_key === 'string' && /^[A-Za-z0-9_-]{16,4096}$/.test(a.public_key)
    && Number.isSafeInteger(a.counter) && a.counter >= 0
    && (a.transports === undefined || (Array.isArray(a.transports) && a.transports.every((t) => typeof t === 'string')));
  if (!ok) throw new AccountsUndecided('passkey answered something that is not a passkey');
  return { person: a.person, tenant: a.tenant, publicKey: Buffer.from(a.public_key, 'base64url'), counter: a.counter, transports: a.transports ?? [] };
}

/** Whether the module recorded the use: false when the counter did not go up. */
export async function passkeyUsed(credential, counter, options) {
  const answer = verdict('passkey-used', await run(['passkey-used', '--credential', credential, '--counter', String(counter)], '', options));
  return answer !== null;
}
