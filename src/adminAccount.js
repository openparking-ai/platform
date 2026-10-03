/**
 * Creating the owner's admin, and resetting its password (0024). Database
 * access, deliberately, as minting an operator token is: there is no route
 * that creates an account, because the operator surface is what one unlocks.
 *
 *   npm run create-admin -- --tenant <tenant-id> --email <email> [--password-file <path>]
 *   npm run reset-admin-password -- --email <email> [--password-file <path>]
 *
 * THE PASSWORD NEVER ARRIVES ON THE COMMAND LINE: argv is in the process
 * list, readable by anyone on the machine. It comes from a prompt that does not
 * echo, asked twice, or from a file. A password argument, in any spelling, is
 * refused by name; so is anything else the command does not take.
 *
 * A reset revokes every session of that admin and clears every lock on it.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pool, withTenant } from './db.js';
import { hashPassword, passwordRuleBroken } from './passwords.js';

export class AdminCommandRefused extends Error {}

const PASSWORD_ARGUMENT =
  'a password on the command line is refused: it is visible in the process list. ' +
  'Leave it out to be prompted, or pass --password-file <path>.';

/**
 * The options a command takes, from argv. Each option takes one value. Any
 * argument that looks like a password, anything unknown and any bare value are
 * refused, the first by its own sentence. A refusal NEVER repeats what was
 * typed: an unknown argument may be a password (`-p<password>` is one word).
 */
export function parseArgs(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const name = arg.split('=')[0];
    if (!allowed.includes(name) && /^-{1,2}(p|pw|pwd|pass\w*)$/i.test(name)) {
      throw new AdminCommandRefused(PASSWORD_ARGUMENT);
    }
    if (!allowed.includes(name)) {
      throw new AdminCommandRefused(
        arg.startsWith('-') ? `an unknown option (not repeated here: it may hold a password); this command takes ${allowed.join(', ')}`
          : `a bare value is not taken (a password is never an argument); this command takes ${allowed.join(', ')}`,
      );
    }
    const value = arg.includes('=') ? arg.slice(name.length + 1) : argv[(i += 1)];
    if (value === undefined || value === '') throw new AdminCommandRefused(`${name} needs a value`);
    out[name.replace(/^--/, '')] = value;
  }
  return out;
}

/** A line typed at the terminal with nothing echoed. */
function promptHidden(question, { stdin = process.stdin, stderr = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    let typed = '';
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (fn) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
      fn();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(() => resolve(typed));
        if (ch === '\u0003') return done(() => reject(new AdminCommandRefused('stopped at the prompt; nothing was changed')));
        if (ch === '\u007f' || ch === '\b') typed = [...typed].slice(0, -1).join('');
        else typed += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * The new password: read from `file` (one trailing newline dropped), or asked
 * for twice at a terminal. Never from stdin that is not a terminal, never from
 * argv. The length rule is enforced here.
 */
export async function readNewPassword({ file, stdin = process.stdin, stderr = process.stderr } = {}) {
  let password;
  if (file !== undefined) {
    let mode;
    let folders;
    try {
      mode = statSync(file).mode;
      // The folder named, and the one the file is really in when a link was named.
      folders = [...new Set([dirname(resolve(file)), dirname(realpathSync(file))])].map((d) => statSync(d).mode);
      password = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new AdminCommandRefused(`the password file could not be read (${err.code ?? 'error'})`);
    }
    // A password anyone else on the machine can read is not a secret any more.
    if (mode & 0o044) {
      throw new AdminCommandRefused(
        `the password file can be read by users other than its owner (mode ${(mode & 0o777).toString(8).padStart(4, '0')}); ` +
          'make it the owner\'s only with: chmod 600 <the file>; nothing was changed',
      );
    }
    // Nor is one anyone else can write: they choose the password before this reads it.
    if (mode & 0o022) {
      throw new AdminCommandRefused(
        `the password file can be written by users other than its owner (mode ${(mode & 0o777).toString(8).padStart(4, '0')}); ` +
          'make it the owner\'s only with: chmod 600 <the file>; nothing was changed',
      );
    }
    // Nor is one in a folder anyone else can write: they can put another file in its place.
    // Unless the folder is sticky (as /tmp is): then only the file's owner, or the folder's, can.
    // Permission bits only, here as above; ACLs are not read.
    for (const folder of folders) {
      if (folder & 0o022 && !(folder & 0o1000)) {
        throw new AdminCommandRefused(
          `the folder holding the password file can be written by users other than its owner (mode ${(folder & 0o777).toString(8).padStart(4, '0')}), ` +
            'so they can put another file in its place; make it the owner\'s only with: chmod 700 <the folder>; nothing was changed',
        );
      }
    }
  } else {
    if (!stdin.isTTY) throw new AdminCommandRefused('no terminal to prompt at: run it at a terminal, or pass --password-file <path>');
    password = await promptHidden('New password: ', { stdin, stderr });
    const again = await promptHidden('Again: ', { stdin, stderr });
    if (again !== password) throw new AdminCommandRefused('the two passwords differ; nothing was changed');
  }
  const broken = passwordRuleBroken(password);
  if (broken) throw new AdminCommandRefused(`${broken}; nothing was changed`);
  return password;
}

export const normalEmail = (email) => String(email ?? '').trim().toLowerCase();

/** The one admin of `tenantId`. Refused by name when it has one, or the email names one already. */
export async function createAdmin({ tenantId, email, password }) {
  const normal = normalEmail(email);
  const hash = await hashPassword(password);
  try {
    return await withTenant(tenantId, async (c) =>
      (await c.query(
        `INSERT INTO operator_users (tenant_id, email, password_hash) VALUES ($1, $2, $3)
         RETURNING id, tenant_id, email, created_at`,
        [tenantId, normal, hash],
      )).rows[0]);
  } catch (err) {
    if (err.constraint === 'operator_users_tenant_id_key') throw new AdminCommandRefused('this tenant already has its admin; reset its password instead');
    if (err.constraint === 'operator_users_email_key') throw new AdminCommandRefused('that email already names an admin');
    if (err.constraint === 'operator_users_email_is_normal') throw new AdminCommandRefused('that is not an email address');
    if (err.constraint === 'operator_users_tenant_id_fkey' || err.code === '22P02') throw new AdminCommandRefused('no such tenant');
    throw err;
  }
}

/** A new password for the admin `email` names; every session revoked, every lock cleared. */
export async function resetAdminPassword({ email, password }) {
  const normal = normalEmail(email);
  const user = (await pool.query('SELECT user_id, tenant_id FROM resolve_operator_user($1)', [normal])).rows[0];
  if (!user) throw new AdminCommandRefused('no admin has that email');
  const hash = await hashPassword(password);
  return withTenant(user.tenant_id, async (c) => {
    await c.query('UPDATE operator_users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [user.user_id, hash]);
    const revoked = await c.query(
      `UPDATE operator_tokens SET revoked_at = now() WHERE user_id = $1 AND kind = 'session' AND revoked_at IS NULL`,
      [user.user_id],
    );
    const cleared = await c.query('DELETE FROM operator_sign_in_locks WHERE user_id = $1', [user.user_id]);
    return { tenant_id: user.tenant_id, email: normal, sessions_revoked: revoked.rowCount, locks_cleared: cleared.rowCount };
  });
}

/** Run a command's body; a refusal is one line on stderr and exit 2, never a trace. */
export async function runCommand(body) {
  try {
    await body();
    process.exitCode = 0;
  } catch (err) {
    if (err instanceof AdminCommandRefused) {
      console.error(`refused: ${err.message}`);
      process.exitCode = 2;
    } else {
      console.error(`failed: ${err?.constructor?.name ?? 'Error'}${err?.code ? ` ${err.code}` : ''}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => {});
  }
}
