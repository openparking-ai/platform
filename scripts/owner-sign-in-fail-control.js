#!/usr/bin/env node
/**
 * The control for the owner's sign-in (0024).
 *
 * Every property sign-in rests on is broken below, one at a time, and the
 * suite named beside it is REQUIRED to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported as
 * not planted rather than run:
 *   mounted_after_operator   the auth routes are mounted after the operator router.
 *   token_logged             a minted session token is written to the log.
 *   message_logged           a failure inside sign-in is logged by its message.
 *   parser_text_answered     an unreadable body is answered with the parser's text.
 *   query_read               sign-in reads a credential from the query.
 *   dummy_skipped            an unknown email runs no hash.
 *   lock_off_by_one          the tenth wrong password does not lock.
 *   lock_whole_account       a lock on one address locks every address.
 *   address_from_header      the caller address is read from X-Forwarded-For, untrusted.
 *   idle_unchecked           a session never ends for being idle.
 *   sign_out_keeps_session   sign-out does not revoke the session.
 *   reset_keeps_sessions     a password reset leaves the admin's sessions live.
 *   reset_keeps_locks        a password reset leaves the locks in place.
 *   httponly_dropped         the cookie is readable by page script.
 *   secure_dropped           the cookie is sent without Secure by default.
 *   origin_unchecked         a cookie-authenticated change from any Origin is accepted.
 *   password_argument_taken  a password on the command line is accepted.
 *   no_store_dropped         operator responses may be stored.
 *   short_password_taken     the length rule is not enforced.
 *   refusal_floor_dropped    a refusal is answered as soon as its work is done (F1).
 *   unknown_skips_lock_read  an unknown email skips the lock lookup (F1).
 *   unknown_skips_failure_write  an unknown email skips the failure write (F1).
 *   hash_line_uncapped       the hash line has no length and no per-address share (F5).
 *   auth_body_failure_500    a sign-in body that cannot be read is a 500 (F4).
 *   auth_parser_router_wide  every path under /auth reads a body, so a non-route is not a 404 (F4).
 *   operator_parser_text     an operator body that cannot be read is answered in the parser's words (F3).
 *   operator_parse_headers_dropped  that answer may be stored and sniffed (F3).
 *   number_setting_unchecked a number setting is taken whatever it is (F6).
 *   hop_count_unbounded      TRUST_PROXY may name any number of hops (F6).
 *   password_file_mode_ignored  a password file others can read is taken (F7).
 *   refusal_echoes_argument  a refused option is repeated back, password and all (F7).
 *   no_origin_signs_in       with no ADMIN_ORIGIN, sign-in is on (decision 1).
 *   foreign_origin_signs_in  a sign-in from a foreign Origin is taken (decision 2).
 *   cookie_twice_first_taken a cookie sent twice is read as its first value (decision 4).
 *   ended_sessions_kept      a sign-in leaves the admin's ended sessions in place (decision 6).
 *   id_unchecked             an id that is not a uuid reaches the handler and the database (C3).
 *   unknown_garage_lane_500  a lane added to a garage that is not there is a database error (C3).
 *   unknown_lane_device_500  a device added to a lane that is not there is a database error (C3).
 *   body_check_by_path_case  an unreadable body is answered in one sentence only on the lower-case path (R1).
 *   decoy_after_listen       the port opens before the decoy hash is finished (R2).
 *   start_settings_unchecked PORT, PG_POOL_MAX and MAX_CLOCK_SKEW_SECONDS are not checked at start (R4).
 *   password_file_writable_taken  a password file others can write is taken (R6).
 *   password_folder_writable_taken  a password file in a folder others can write is taken (round 3, F1).
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0024, so the property genuinely never existed:
 *   absolute_unchecked       a session past its absolute end is still found.
 *   session_is_a_key         a session token is accepted as a Bearer key.
 *   public_execute_restored  resolve_operator_user is executable by PUBLIC again (F2).
 *
 * Needs the same environment as the suite.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.SIGN_IN_SCRATCH_DB || 'openparking_sign_in_control';

const SIGN_IN = ['test/owner-sign-in.test.js'];
const CLI = ['test/admin-cli.test.js'];
const OUTPUT = ['test/owner-sign-in-output.test.js'];
const DEFINERS = ['test/definer-grants.test.js'];
const IDS = ['test/ids.test.js'];
const COLD_START = ['test/sign-in-cold-start.test.js'];
const START = ['test/start-settings.test.js'];

const SOURCE_BREAKS = [
  {
    name: 'mounted_after_operator',
    why: 'the auth routes are mounted after the operator router',
    suite: SIGN_IN,
    file: 'src/app.js',
    from: "  app.use('/api/v1/auth', signIn.createAuthRouter(authSettings));\n",
    to: '',
    also: [{ file: 'src/app.js', from: "  app.use('/api/v1', operator);\n", to: "  app.use('/api/v1', operator);\n  app.use('/api/v1/auth', signIn.createAuthRouter(authSettings));\n" }],
  },
  {
    name: 'token_logged',
    why: 'a minted session token is written to the log',
    suite: OUTPUT,
    file: 'src/signIn.js',
    from: '    const token = generateDeviceToken();\n',
    to: "    const token = generateDeviceToken();\n    console.log('[auth] minted', token);\n",
  },
  {
    name: 'message_logged',
    why: 'a failure inside sign-in is logged by its message',
    suite: [...SIGN_IN, ...OUTPUT],
    file: 'src/signIn.js',
    from: "  console.error(`[auth] ${where} failed: ${kind}${err?.code ? ` ${err.code}` : ''}`);",
    to: "  console.error(`[auth] ${where} failed: ${kind}${err?.code ? ` ${err.code}` : ''}: ${err?.message}`);",
  },
  {
    name: 'parser_text_answered',
    why: "an unreadable body is answered with the parser's text",
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '    if (err?.unreadable) return refuse(req, res, 400, UNREADABLE);\n    // A stored hash',
    to: '    if (err?.unreadable) return refuse(req, res, 400, { error: err.cause?.message, code: UNREADABLE.code });\n    // A stored hash',
  },
  {
    name: 'query_read',
    why: 'sign-in reads a credential from the query',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '      const body = signInBody(req.body);\n',
    to: '      const body = signInBody(req.query.token ? { email: req.query.email, password: req.query.password } : req.body);\n',
  },
  {
    name: 'dummy_skipped',
    why: 'an unknown email runs no hash',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '      const matches = await internals.verifyPassword(body.password, found ? found.password_hash : await dummyHash());\n',
    to: '      const matches = found ? await internals.verifyPassword(body.password, found.password_hash) : false;\n',
  },
  {
    name: 'lock_off_by_one',
    why: 'the tenth wrong password does not lock',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '        [user.tenant_id, user.user_id, address, MAX_FAILED, LOCK_MINUTES, counted],',
    to: '        [user.tenant_id, user.user_id, address, MAX_FAILED + 1, LOCK_MINUTES, counted],',
  },
  {
    name: 'lock_whole_account',
    why: 'a lock on one address locks every address',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: "'SELECT failed_count, locked_until FROM operator_sign_in_locks WHERE user_id = $1 AND address = $2', [user.user_id, address]",
    to: "'SELECT failed_count, locked_until FROM operator_sign_in_locks WHERE user_id = $1 AND $2::text IS NOT NULL ORDER BY locked_until DESC NULLS LAST LIMIT 1', [user.user_id, address]",
  },
  {
    name: 'address_from_header',
    why: 'the caller address is read from X-Forwarded-For with no trusted proxy',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: "  let address = (settings.trustProxy === null ? req.socket.remoteAddress : req.ip) ?? 'unknown';",
    to: "  let address = (req.get?.('x-forwarded-for') ?? (settings.trustProxy === null ? req.socket.remoteAddress : req.ip)) ?? 'unknown';",
  },
  {
    name: 'idle_unchecked',
    why: 'a session never ends for being idle',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: "'SELECT * FROM resolve_operator_session($1, $2)', [hashToken(token), settings.idleSeconds]",
    to: "'SELECT * FROM resolve_operator_session($1, $2)', [hashToken(token), 10 ** 8]",
  },
  {
    name: 'sign_out_keeps_session',
    why: 'sign-out does not revoke the session',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: "c.query('UPDATE operator_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [req.session.token_id])",
    to: "c.query('SELECT $1::uuid', [req.session.token_id])",
  },
  {
    name: 'reset_keeps_sessions',
    why: "a password reset leaves the admin's sessions live",
    suite: [...SIGN_IN, ...CLI],
    file: 'src/adminAccount.js',
    from: "`UPDATE operator_tokens SET revoked_at = now() WHERE user_id = $1 AND kind = 'session' AND revoked_at IS NULL`",
    to: "`SELECT 1 WHERE $1::uuid IS NULL`",
  },
  {
    name: 'reset_keeps_locks',
    why: 'a password reset leaves the locks in place',
    suite: [...SIGN_IN, ...CLI],
    file: 'src/adminAccount.js',
    from: "c.query('DELETE FROM operator_sign_in_locks WHERE user_id = $1', [user.user_id])",
    to: "c.query('SELECT 1 WHERE $1::uuid IS NULL', [user.user_id])",
  },
  {
    name: 'httponly_dropped',
    why: 'the cookie is readable by page script',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '  return `Path=/api; HttpOnly; SameSite=Strict;',
    to: '  return `Path=/api; SameSite=Strict;',
  },
  {
    name: 'secure_dropped',
    why: 'the cookie is sent without Secure by default',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: "${settings.cookieSecure ? '; Secure' : ''}",
    to: '',
  },
  {
    name: 'origin_unchecked',
    why: 'a cookie-authenticated change from any Origin is accepted',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '  if (SAFE_METHODS.has(req.method)) return true;\n',
    to: '  if (SAFE_METHODS.has(req.method) || req) return true;\n',
  },
  {
    name: 'password_argument_taken',
    why: 'a password on the command line is accepted',
    suite: CLI,
    file: 'src/adminAccount.js',
    from: '      throw new AdminCommandRefused(PASSWORD_ARGUMENT);\n',
    to: "      out.password = argv[(i += 1)] ?? arg.split('=')[1];\n      continue;\n",
  },
  {
    name: 'no_store_dropped',
    why: 'operator responses may be stored',
    suite: SIGN_IN,
    file: 'src/app.js',
    from: '  operator.use(signIn.noStore);\n',
    to: '',
  },
  {
    name: 'short_password_taken',
    why: 'the length rule is not enforced',
    suite: CLI,
    file: 'src/passwords.js',
    from: '  if (length < MIN_PASSWORD_LENGTH) return',
    to: '  if (length < 1) return',
  },
  {
    name: 'refusal_floor_dropped',
    why: 'a refusal is answered as soon as its work is done',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '    if (wait > 0) await sleep(wait);\n',
    to: '',
  },
  {
    name: 'unknown_skips_lock_read',
    why: 'an unknown email skips the lock lookup',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '      const lock = await internals.lockOf(user, address);\n',
    to: '      const lock = found ? await internals.lockOf(user, address) : null;\n',
  },
  {
    name: 'unknown_skips_failure_write',
    why: 'an unknown email skips the failure write',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '        await internals.recordFailure(user, address, Boolean(found) && !matches);\n',
    to: '        if (found) await internals.recordFailure(user, address, Boolean(found) && !matches);\n',
  },
  {
    name: 'hash_line_uncapped',
    why: 'the hash line has no length and no per-address share',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '      if (held >= max || mine >= perAddress) return null;\n',
    to: '      if (held < 0 || mine < 0) return null;\n',
  },
  {
    name: 'auth_body_failure_500',
    why: 'a sign-in body that cannot be read is a 500',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '    if (err?.unreadable) return refuse(req, res, 400, UNREADABLE);\n',
    to: '',
  },
  {
    name: 'auth_parser_router_wide',
    why: 'every path under /auth reads a body, so a non-route is not a 404',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '  router.use(noStore);\n\n  router.post(',
    to: '  router.use(noStore);\n  router.use(readSignInBody);\n\n  router.post(',
  },
  {
    name: 'operator_parser_text',
    why: "an operator body that cannot be read is answered in the parser's words",
    suite: SIGN_IN,
    file: 'src/app.js',
    from: ': res.status(400).json(BODY_UNREADABLE);',
    to: ': res.status(400).json({ error: err.message });',
  },
  {
    name: 'operator_parse_headers_dropped',
    why: 'an operator body that cannot be read is answered without no-store and nosniff',
    suite: SIGN_IN,
    file: 'src/app.js',
    from: "      res.set('Cache-Control', 'no-store');\n      res.set('X-Content-Type-Options', 'nosniff');\n      return err.status === 413",
    to: '      return err.status === 413',
  },
  {
    name: 'number_setting_unchecked',
    why: 'a number setting is taken whatever it is',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '  if (!/^[0-9]{1,6}$/.test(raw) || Number(raw) < min || Number(raw) > max) {\n',
    to: '  if (Number.isNaN(Number(raw))) {\n',
  },
  {
    name: 'hop_count_unbounded',
    why: 'TRUST_PROXY may name any number of hops',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '    if (value < 1 || value > MAX_PROXY_HOPS) throw',
    to: '    if (value < 0) throw',
  },
  {
    name: 'password_file_mode_ignored',
    why: 'a password file others can read is taken',
    suite: CLI,
    file: 'src/adminAccount.js',
    from: '    if (mode & 0o044) {\n',
    to: '    if (mode & 0) {\n',
  },
  {
    name: 'refusal_echoes_argument',
    why: 'a refused option is repeated back, password and all',
    suite: CLI,
    file: 'src/adminAccount.js',
    from: '`an unknown option (not repeated here: it may hold a password); this command takes',
    to: '`unknown option ${name}; this command takes',
  },
  {
    name: 'no_origin_signs_in',
    why: 'with no ADMIN_ORIGIN, sign-in is on',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '      if (settings.adminOrigin === null) return await refuse(req, res, 409, NOT_CONFIGURED);\n',
    to: '',
  },
  {
    name: 'foreign_origin_signs_in',
    why: 'a sign-in from a foreign Origin is taken',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '      if (origin !== undefined && origin !== settings.adminOrigin) return await refuse(req, res, 403, ORIGIN_REFUSED);\n',
    to: '',
  },
  {
    name: 'cookie_twice_first_taken',
    why: 'a cookie sent twice is read as its first value',
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: '  if (values.length !== 1 || ',
    to: '  if (values.length < 1 || ',
  },
  {
    name: 'ended_sessions_kept',
    why: "a sign-in leaves the admin's ended sessions in place",
    suite: SIGN_IN,
    file: 'src/signIn.js',
    from: "        `DELETE FROM operator_tokens WHERE user_id = $1 AND kind = 'session'\n",
    to: "        `SELECT 1 FROM operator_tokens WHERE user_id = $1 AND kind = 'session'\n",
  },
  {
    name: 'id_unchecked',
    why: 'an id that is not a uuid reaches the handler and the database',
    suite: IDS,
    file: 'src/app.js',
    from: '    router.param(name, (req, _res, next, value) => next(UUID.test(value) ? undefined : notFound(req.route.path)));\n',
    to: '    router.param(name, (_req, _res, next) => next());\n',
  },
  {
    name: 'unknown_garage_lane_500',
    why: 'a lane added to a garage that is not there is a database error',
    suite: IDS,
    file: 'src/app.js',
    from: "        if (!(await repo.getGarage(client, req.tenantId, req.params.garageId))) throw new HttpError(404, 'garage not found');\n",
    to: '',
  },
  {
    name: 'unknown_lane_device_500',
    why: 'a device added to a lane that is not there is a database error',
    suite: IDS,
    file: 'src/app.js',
    from: "        if (lane.rowCount === 0) throw new HttpError(404, 'lane not found');\n",
    to: '',
  },
  {
    name: 'body_check_by_path_case',
    why: 'an unreadable body is answered in one sentence only on the lower-case path',
    suite: SIGN_IN,
    file: 'src/app.js',
    from: '    if (err.bodyUnreadable) {\n',
    to: "    if (err.bodyUnreadable && req.path.startsWith('/api/v1/') && !req.path.startsWith('/api/v1/lane/')) {\n",
  },
  {
    name: 'decoy_after_listen',
    why: 'the port opens before the decoy hash is finished',
    suite: COLD_START,
    file: 'src/server.js',
    from: '  await dummyHash();\n',
    to: '  void dummyHash;\n',
  },
  {
    name: 'start_settings_unchecked',
    why: 'PORT, PG_POOL_MAX and MAX_CLOCK_SKEW_SECONDS are not checked at start',
    suite: START,
    file: 'src/server.js',
    from: '  ({ PORT: port } = assertStartSettings());\n',
    to: '  port = Number(process.env.PORT || 3000);\n',
  },
  {
    name: 'password_file_writable_taken',
    why: 'a password file others can write is taken',
    suite: CLI,
    file: 'src/adminAccount.js',
    from: '    if (mode & 0o022) {\n',
    to: '    if (mode & 0) {\n',
  },
  {
    name: 'password_folder_writable_taken',
    why: 'a password file in a folder others can write is taken',
    suite: CLI,
    file: 'src/adminAccount.js',
    from: '      if (folder & 0o022 && !(folder & 0o1000)) {\n',
    to: '      if (folder & 0) {\n',
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'absolute_unchecked',
    why: 'a session past its absolute end is still found',
    suite: SIGN_IN,
    edits: [{ file: '0024_operator_sign_in.sql', from: "         AND t.expires_at > now()\n", to: '' }],
  },
  {
    name: 'session_is_a_key',
    why: 'a session token is accepted as a Bearer key',
    suite: SIGN_IN,
    edits: [{ file: '0024_operator_sign_in.sql', from: "      AND t.kind = 'key'\n", to: '' }],
  },
  {
    name: 'public_execute_restored',
    why: 'resolve_operator_user is executable by PUBLIC again',
    suite: DEFINERS,
    edits: [{ file: '0024_operator_sign_in.sql', from: 'REVOKE EXECUTE ON FUNCTION resolve_operator_user(text) FROM PUBLIC;\n', to: '' }],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-sign-in-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir, suite, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', ...suite], { cwd: dir, env, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  return `${line('pass')} passed, ${line('fail')} failed`;
}

/** A break and its `also` edits, every one or none: each anchor exactly once. */
function plant(dir, edit) {
  const planned = new Map();
  for (const e of [edit, ...(edit.also ?? [])]) {
    const path = join(dir, e.file);
    const source = planned.get(path) ?? readFileSync(path, 'utf8');
    if (source.split(e.from).length !== 2) return false;
    planned.set(path, source.replace(e.from, () => e.to));
  }
  for (const [path, text] of planned) writeFileSync(path, text);
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
const maintenance = new URL(adminUrl);
maintenance.pathname = '/postgres';
const scratchEnv = { DATABASE_URL: scratchAdmin.toString(), APP_DATABASE_URL: scratchApp.toString() };

async function withAdmin(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A scratch database built from `migrations/` with one statement edited out. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
    await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
  });
  const partial = mkdtempSync(join(tmpdir(), 'openparking-sign-in-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  for (const edit of brk.edits) {
    const path = join(partial, edit.file);
    const sql = readFileSync(path, 'utf8');
    if (sql.split(edit.from).length !== 2) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, where: edit.file };
    }
    writeFileSync(path, sql.replace(edit.from, () => edit.to));
  }
  for (const [script, extra] of [['scripts/migrate.js', { MIGRATIONS_DIR: partial }], ['scripts/ensure-app-role.js', {}]]) {
    const result = spawnSync(process.execPath, [script], { cwd: dir, env: { ...process.env, ...scratchEnv, ...extra }, encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(result.stdout, result.stderr);
      throw new Error(`${script} failed against the scratch database`);
    }
  }
  rmSync(partial, { recursive: true, force: true });
  return { ok: true };
}

let failures = 0;
const report = (brk, broken) => {
  if (broken.status === 0) {
    console.error(`  ${brk.name.padEnd(24)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
    failures += 1;
  } else {
    console.log(`  ${brk.name.padEnd(24)} fails as required when ${brk.why} — ${summarise(broken)}`);
  }
};

const intactDir = stage();
try {
  console.log('== control A: the suites must PASS intact ==');
  for (const suite of [SIGN_IN, CLI, OUTPUT, DEFINERS, IDS, COLD_START, START]) {
    const intact = run(intactDir, suite);
    if (intact.status === 0) {
      console.log(`  control A OK — ${suite.join(' ')}: ${summarise(intact)}`);
    } else {
      console.error(`  CONTROL A FAILED — ${suite.join(' ')} does not pass even intact: ${summarise(intact)}`);
      console.error(intact.stdout.slice(-4000));
      console.error(intact.stderr.slice(-4000));
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
    if (!plant(dir, brk)) {
      console.error(`  ${brk.name.padEnd(24)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    report(brk, run(dir, brk.suite));
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
      console.error(`  ${brk.name.padEnd(24)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${built.where} ***`);
      failures += 1;
      continue;
    }
    report(brk, run(dir, brk.suite, scratchEnv));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await withAdmin(maintenance.toString(), (c) => c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`));

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's sign-in tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suites fail on every property owner sign-in rests on.');
