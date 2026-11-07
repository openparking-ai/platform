#!/usr/bin/env node
/**
 * The control for the trusted server's door (src/personDoor.js,
 * src/boundedDatabase.js), and for the two public doors it shares code with.
 *
 * Each part below, taken out of a COPY of the tree, must turn its test red,
 * with another test of the same file green, so a break that stops the file
 * running is not mistaken for one that is caught. A plant whose anchor does not
 * occur exactly once is reported as not planted, and that is a failure too.
 *
 * THE POSITIVE CONTROL comes first: the copy with nothing planted must be green
 * end to end, or a red below could be the copy, not the plant.
 *
 * Needs the same environment as the suite. No tracked file is edited.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LIMIT_MS = Number(process.env.PERSON_DOOR_LIMIT_MS || 180_000);

const DOOR = 'src/personDoor.js';
const DB = 'src/boundedDatabase.js';
const SIGN_IN = 'src/signIn.js';
const LINKS = 'src/accountDoors.js';

const SUITES = {
  door: { file: 'test/person-door.test.js', green: 'THE SETTING IS A DIGEST' },
  stall: { file: 'test/person-door-stall.test.js', green: 'A REAL ERROR IS NOT A STALL' },
  held: { file: 'test/sign-in-answers-held.test.js', green: 'SIGN-IN: the right password' },
};

const PASSWORD_HEAD = "const body = exactly(req.body, ['email', 'password', 'clientAddress']);\n    const email = body && emailOf(body.email);\n";
const FORGOT_HEAD = "const body = exactly(req.body, ['email', 'clientAddress']);\n    const email = body && emailOf(body.email);\n";
const ADDRESS = '    const address = body && addressOf(body.clientAddress, countedAddress);\n';
const SOCKET = '    const address = countedAddress(req.socket.remoteAddress);\n';

const PLANTS = [
  // Who may knock.
  { name: 'any key opens the door', suite: 'door', test: 'THE WRONG KEY', file: DOOR, from: "return timingSafeEqual(digest, settings.trustedServerKey) && key !== null ? next() : next('route');", to: 'return next();' },
  { name: 'the door mounted with no key set', suite: 'door', test: 'OFF UNLESS NAMED', file: SIGN_IN, from: 'if (settings.trustedServerKey !== null && settings.adminOrigin !== null) {', to: 'if (settings.adminOrigin !== null) {', also: [{ file: DOOR, from: "const key = bearerFrom(req.get('authorization'));", to: "if (settings.trustedServerKey === null) return next();\n    const key = bearerFrom(req.get('authorization'));" }] },
  { name: 'the door mounted with sign-in off', suite: 'door', test: 'OFF WITH SIGN-IN', file: SIGN_IN, from: 'if (settings.trustedServerKey !== null && settings.adminOrigin !== null) {', to: 'if (settings.trustedServerKey !== null) {' },
  { name: 'a setting that is not a digest taken', suite: 'door', test: 'THE SETTING IS', green: 'OFF WITH SIGN-IN', file: SIGN_IN, from: "if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error('TRUSTED_SERVER_KEY_SHA256 must be the sha256 of the key, 64 lower-case hex characters');\n", to: '' },

  // The answer.
  { name: 'the stored hash in the answer', suite: 'door', test: 'WHO IT IS', file: DOOR, from: '  personId: row.id,\n', to: '  personId: row.id,\n  passwordHash: row.password_hash,\n' },
  { name: 'the version ignores the password', suite: 'door', test: 'THE VERSION', file: DOOR, from: "row.email, row.password_hash]", to: 'row.email]' },
  { name: 'the version ignores the email', suite: 'door', test: 'THE VERSION', file: DOOR, from: "row.tenant_id, row.email, row.password_hash]", to: 'row.tenant_id, row.password_hash]' },
  { name: 'the version ignores the person', suite: 'door', test: 'THE VERSION', file: DOOR, from: "['person-v1', row.id, row.tenant_id, row.email, row.password_hash]", to: "['person-v1', row.password_hash]" },
  { name: 'the version moves with the language', suite: 'door', test: 'THE VERSION', file: DOOR, from: "row.email, row.password_hash]", to: 'row.email, row.language, row.password_hash]' },
  { name: 'the door makes a session', suite: 'door', test: 'THE DOOR MAKES NO SESSION', file: DOOR, from: "return row ? await answer(req, res, 200, presented(row)) : await answer(req, res, 401, REFUSED);", to: "if (row) res.set('Set-Cookie', 'op_session=x');\n      return row ? await answer(req, res, 200, presented(row)) : await answer(req, res, 401, REFUSED);" },

  // One refusal.
  { name: 'a lock is not read', suite: 'door', test: 'ONE REFUSAL', file: DOOR, from: 'if (!found || !matches || locked) {', to: 'if (!found || !matches) {' },
  { name: 'a wrong password writes nothing', suite: 'door', test: "THE LOCK IS THE CALLER", file: DOOR, from: '      await db.inTenant(user.tenant_id, (c) => statements.writeFailure(c, user, address, Boolean(found) && !matches && !unreadable));\n', to: '' },
  { name: 'a right password leaves the count', suite: 'door', test: 'THE LOCK IS SIGN-IN', file: DOOR, from: '      await statements.clearLock(c, user, address);\n', to: '' },
  { name: 'a stored hash it cannot read is a 500', suite: 'door', test: 'ONE REFUSAL', file: DOOR, from: 'if (!(err instanceof PasswordHashUnrecognised)) throw err;', to: 'throw err;' },
  { name: 'a stored hash it cannot read counts as a wrong password', suite: 'door', test: 'ONE REFUSAL', file: DOOR, from: 'Boolean(found) && !matches && !unreadable', to: 'Boolean(found) && !matches' },
  { name: 'an unknown email runs no hash', suite: 'door', test: 'ONE HASH EACH', file: DOOR, from: '    const stored = found ? found.password_hash : await dummyHash();\n', to: "    if (!found) return null;\n    const stored = found ? found.password_hash : await dummyHash();\n" },
  { name: 'a right answer leaves before the floor', suite: 'door', test: 'A RIGHT ANSWER LEAVES', file: DOOR, from: 'return row ? await answer(req, res, 200, presented(row)) : await answer(req, res, 401, REFUSED);', to: 'return row ? res.json(presented(row)) : await answer(req, res, 401, REFUSED);' },
  { name: 'a password changed mid-check still passes', suite: 'stall', test: 'THE PASSWORD CHANGED', file: DOOR, from: '      if (still.rowCount !== 1) return null;\n', to: '' },

  // Shapes.
  { name: 'a control character reaches the lookup', suite: 'door', test: 'A BODY IT WILL NOT READ', file: DOOR, from: '  if (CONTROL.test(raw)) return null;\n', to: '' },
  { name: 'an email of any length', suite: 'door', test: 'A BODY IT WILL NOT READ', file: DOOR, from: 'return email.length >= 3 && email.length <= 254 ? email : null;', to: 'return email.length >= 3 ? email : null;' },
  { name: 'a password of any length', suite: 'door', test: 'A BODY IT WILL NOT READ', file: DOOR, from: 'password.length > 0 && passwordLength(password) <= MAX_PASSWORD_LENGTH', to: 'password.length > 0' },
  { name: 'a password measured in code units', suite: 'door', test: 'A PASSWORD OF THE RULE', file: DOOR, from: 'password.length > 0 && passwordLength(password) <= MAX_PASSWORD_LENGTH', to: 'password.length > 0 && password.length <= MAX_PASSWORD_LENGTH' },
  { name: 'any string is an address', suite: 'door', test: 'A BODY IT WILL NOT READ', file: DOOR, from: "raw.length <= 45 && !raw.includes('%') && isIP(raw) !== 0 ? countedAddress(raw) : null", to: 'countedAddress(raw)' },
  { name: "the door reads the app's size of body", suite: 'door', test: 'THE BODY CAP', file: DOOR, from: 'limit: BODY_LIMIT', to: "limit: '1mb'" },
  { name: 'a body too large in the parser\'s words', suite: 'door', test: 'THE BODY CAP', file: DOOR, from: 'err.status === 413 ? BODY_TOO_LARGE : UNREADABLE', to: '{ error: err.message }' },

  // By the caller's address.
  { name: "the lock counts the asker's address", suite: 'door', test: "THE LOCK IS THE CALLER", file: DOOR, from: PASSWORD_HEAD + ADDRESS, to: PASSWORD_HEAD + SOCKET },
  { name: "forgot counts the asker's address", suite: 'door', test: "FORGOT: its shape", file: DOOR, from: FORGOT_HEAD + ADDRESS, to: FORGOT_HEAD + SOCKET },
  { name: 'an address is read raw, not as sign-in reads it', suite: 'door', test: 'AN ADDRESS IS READ', file: DOOR, from: "isIP(raw) !== 0 ? countedAddress(raw) : null", to: 'isIP(raw) !== 0 ? raw : null' },
  { name: 'the limit is not counted', suite: 'door', test: "THE LIMIT IS THE CALLER", file: DOOR, from: '    if (!(await countOf(limiter, address, req, res, RATE_LIMITED))) return undefined;\n', to: '' },
  { name: "a limit apart from sign-in's", suite: 'door', test: "THE LIMIT IS THE CALLER", file: SIGN_IN, from: '      settings, line, limiter, links, answer: refuse,\n', to: '      settings, line, limiter: addressLimiter({ max: settings.attemptsPerAddress, windowSeconds: settings.attemptsWindowSeconds }), links, answer: refuse,\n' },
  { name: 'a 429 says nothing of when', suite: 'door', test: "THE LIMIT IS THE CALLER", file: DOOR, from: "    res.set('Retry-After', String(seen.retryAfterSeconds));\n", to: '' },

  // Forgot.
  { name: 'forgot sends no email', suite: 'door', test: "FORGOT: the same answer", file: DOOR, from: '      links.sendReset(made);\n', to: '' },
  { name: "forgot's count is not counted", suite: 'door', test: "FORGOT: its shape", file: DOOR, from: '    if (!(await countOf(links.forgotLimiter, address, req, res, LINK_RATE_LIMITED))) return undefined;\n', to: '' },

  // A stall, places, a held row.
  { name: 'the deadline ends nothing', suite: 'stall', test: 'A SILENT NETWORK, WITH', file: DB, from: 'timer = setTimeout(() => refuse(new DatabaseDidNotAnswer()), left);', to: 'timer = setTimeout(() => {}, left);' },
  { name: 'forgot on the shared pool', suite: 'stall', test: 'A SILENT NETWORK, WITH', file: DOOR, from: 'requestReset(email, NOBODY, database.forRequest(DEADLINE_MS.forgot))', to: 'requestReset(email, NOBODY)' },
  { name: 'a stuck connection goes back to the pool', suite: 'stall', test: 'A SILENT NETWORK, WITH', file: DB, from: '      else if (failed) drop(client);\n', to: '' },
  { name: 'the check by id has no limit on its places', suite: 'stall', test: 'A STALL NEVER KEEPS A PLACE', file: DOOR, from: '    const giveBack = takePlace.check();\n', to: '    const giveBack = () => {};\n' },
  { name: 'a stalled place is never given back', suite: 'stall', test: 'A STALL NEVER KEEPS A PLACE', file: DOOR, from: '    } finally {\n      giveBack();\n    }\n', to: '    } finally {\n      if (Number.isNaN(0)) giveBack();\n    }\n' },
  { name: 'the password check has no limit on its places', suite: 'stall', test: 'PLACES ARE APART', file: DOOR, from: '    const giveBack = takePlace.password();\n', to: '    const giveBack = () => {};\n' },
  { name: 'forgot has no limit on its places', suite: 'stall', test: 'PLACES ARE APART', file: DOOR, from: '    const giveBack = takePlace.forgot();\n', to: '    const giveBack = () => {};\n' },
  { name: 'forgot shares the password check\'s places', suite: 'stall', test: 'PLACES ARE APART', file: DOOR, from: '    const giveBack = takePlace.forgot();\n', to: '    const giveBack = takePlace.password();\n' },
  { name: 'a place given back as its hash ends', suite: 'stall', test: 'A PLACE IS HELD TO THE FLOOR', file: DOOR, from: 'return row ? await answer(req, res, 200, presented(row)) : await answer(req, res, 401, REFUSED);', to: 'giveBack();\n      return row ? await answer(req, res, 200, presented(row)) : await answer(req, res, 401, REFUSED);' },
  { name: "sign-in's hash line not used", suite: 'stall', test: 'THE HASH LINE IS', file: DOOR, from: '    const leave = line.enter(address);\n', to: '    const leave = () => {};\n' },
  { name: 'a hash holds the answer past the deadline', suite: 'stall', test: 'A HASH THAT OUTLIVES', file: DOOR, from: 'matches = await db.within(hash);', to: 'matches = await hash;' },
  { name: 'a place freed while its hash still runs', suite: 'stall', test: 'A HASH THAT OUTLIVES', file: DOOR, from: 'Promise.all([hashing, floor]).finally(giveBack);', to: 'floor.finally(giveBack);' },
  { name: 'a held row is a 503 for the password check', suite: 'stall', test: 'A ROW HELD', file: DOOR, from: "      if (err?.code === LOCK_BUSY) {\n        // Only an address with an account can meet a held row, so it must not say so.", to: "      if (err?.code === 'never') {\n        // Only an address with an account can meet a held row, so it must not say so." },
  { name: 'a held row is a 500 for forgot', suite: 'stall', test: 'A ROW HELD', file: DOOR, from: "      if (err?.code === LOCK_BUSY) {\n        // Only an address with an account can meet a held row: the one sentence, and no link.", to: "      if (err?.code === 'never') {\n        // Only an address with an account can meet a held row: the one sentence, and no link." },
  { name: 'no limit on a lock wait', suite: 'stall', test: "THE DOOR'S CONNECTIONS", green: 'THE DEADLINE IS', file: DB, from: '      lock_timeout: LIMITS.lockMs,\n', to: '' },
  { name: 'no limit on a statement', suite: 'stall', test: "THE DOOR'S CONNECTIONS", file: DB, from: '      statement_timeout: LIMITS.statementMs,\n', to: '' },
  { name: 'no limit on a quiet transaction', suite: 'stall', test: "THE DOOR'S CONNECTIONS", file: DB, from: '      idle_in_transaction_session_timeout: LIMITS.idleInTransactionMs,\n', to: '' },
  { name: 'a real error dressed as a stall', suite: 'stall', test: 'A REAL ERROR', green: 'THE DEADLINE IS', file: DB, from: '  return err;\n}\n\n/** Off the pool', to: '  return new DatabaseDidNotAnswer();\n}\n\n/** Off the pool' },
  { name: 'a lost lock dressed as a stall', suite: 'stall', test: 'A REAL ERROR', green: 'THE DEADLINE IS', file: DB, from: 'const NO_ANSWER_CODE = /^(08|53|57P0|57014$)/;', to: 'const NO_ANSWER_CODE = /^(08|53|57P0|57014$|55P03)/;' },
  { name: 'each statement has the whole deadline', suite: 'stall', test: 'THE DEADLINE IS', file: DB, from: '      const until = performance.now() + deadlineMs;\n      return {\n        query: (text, values) => onClient(until, (query) => query(text, values)),\n        inTenant: (tenantId, fn) => onClient(until, async (query) => {', to: '      return {\n        query: (text, values) => onClient(performance.now() + deadlineMs, (query) => query(text, values)),\n        inTenant: (tenantId, fn) => onClient(performance.now() + deadlineMs, async (query) => {' },
  { name: 'an email in a log line', suite: 'stall', file: DOOR, from: "console.error('[auth] person check: a row was held; answered as a refusal');", to: "console.error(`[auth] person check: a row was held; answered as a refusal ${req.body.email}`);" },

  // The two public doors, which this control holds to the byte.
  { name: 'the public refusal reworded', suite: 'held', test: 'SIGN-IN: every refusal', file: SIGN_IN, from: "error: 'Sign-in refused. Check the email and password.'", to: "error: 'Sign-in refused.'" },
  { name: 'the public limit grows a Retry-After', suite: 'held', test: 'SIGN-IN: past the limit', file: SIGN_IN, from: 'if (!limiter.take(address)) return await refuse(req, res, 429, RATE_LIMITED);', to: "if (!limiter.take(address)) { res.set('Retry-After', '1'); return await refuse(req, res, 429, RATE_LIMITED); }" },
  { name: 'the public floor dropped', suite: 'held', test: 'SIGN-IN: every refusal', file: SIGN_IN, from: 'const wait = floorMs - (performance.now() - req.arrivedAt);', to: 'const wait = 0;' },
  { name: 'public sign-in answers a broken hash as a refusal', suite: 'held', test: 'SIGN-IN: a stored hash', file: SIGN_IN, from: "if (onSignIn) return refuse(req, res, 500, { error: 'internal error' });", to: 'if (onSignIn) return refuse(req, res, 401, REFUSED);' },
  { name: 'public forgot sends nothing', suite: 'held', test: 'FORGOT: the same answer', file: LINKS, from: '      await answer(req, res, 200, FORGOT_SENT);\n      sendReset(made);\n', to: '      await answer(req, res, 200, FORGOT_SENT);\n' },
  { name: 'public forgot names the account', suite: 'held', test: 'FORGOT: the same answer', file: LINKS, from: '      await answer(req, res, 200, FORGOT_SENT);\n      sendReset(made);\n', to: "      await answer(req, res, 200, made ? { message: 'sent' } : FORGOT_SENT);\n      sendReset(made);\n" },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-person-door-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/** The named tests of a file, or all of them; never longer than LIMIT_MS, and a run that hangs counts as red. */
function run(dir, file, pattern) {
  return new Promise((done) => {
    const args = ['--test', '--test-reporter=tap', '--test-timeout=60000', ...(pattern ? pattern.map((p) => `--test-name-pattern=${p}`) : []), file];
    const child = spawn(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ hung: true, pass: 0, fail: 0 }); }, LIMIT_MS);
    child.on('close', () => {
      clearTimeout(timer);
      const count = (label) => Number(new RegExp(`^# ${label} (\\d+)`, 'm').exec(out)?.[1] ?? 0);
      done({ hung: false, pass: count('pass'), fail: count('fail'), cancelled: count('cancelled') });
    });
  });
}

/** One plant in a fresh copy; { caught, why }. */
async function plant(p) {
  const dir = stage();
  try {
    for (const edit of [{ file: p.file, from: p.from, to: p.to }, ...(p.also ?? [])]) {
      const path = join(dir, edit.file);
      const text = readFileSync(path, 'utf8');
      if (text.split(edit.from).length !== 2) return { caught: false, why: `not planted: its anchor is not there exactly once in ${edit.file}` };
      writeFileSync(path, text.replace(edit.from, () => edit.to));
    }
    const suite = SUITES[p.suite];
    const r = await run(dir, suite.file, p.test ? [p.test, p.green ?? suite.green] : null);
    if (r.hung) return { caught: true, why: 'red: the run hung past the limit' };
    if (r.fail + (r.cancelled ?? 0) === 0) return { caught: false, why: `stayed green (${r.pass} passed)` };
    if (r.pass === 0) return { caught: false, why: 'every test failed: the file itself may not run, so this proves nothing' };
    return { caught: true, why: `red (${r.fail} failed, ${r.pass} passed)` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const only = process.argv[2];
const chosen = only ? PLANTS.filter((p) => p.name.includes(only)) : PLANTS;

const copy = stage();
let green = true;
if (!only) {
  for (const { file } of Object.values(SUITES)) {
    const r = await run(copy, file, null);
    const ok = !r.hung && r.fail === 0 && r.pass > 0;
    console.log(`${ok ? 'ok    ' : 'FAILED'} positive control: ${file} green with nothing planted (${r.pass} passed)`);
    green &&= ok;
  }
}
rmSync(copy, { recursive: true, force: true });
if (!green) {
  console.error('the copy with nothing planted is not green: no plant below could mean anything');
  process.exit(1);
}

let missed = 0;
for (const p of chosen) {
  const { caught, why } = await plant(p);
  console.log(`${caught ? 'ok    ' : 'FAILED'} ${p.name}: ${why}`);
  if (!caught) missed += 1;
}
if (missed > 0) {
  console.error(`${missed} of ${chosen.length} planted breaks were not caught`);
  process.exit(1);
}
console.log(`every one of ${chosen.length} planted breaks was caught`);
