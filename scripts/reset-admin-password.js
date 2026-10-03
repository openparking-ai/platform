#!/usr/bin/env node
/**
 * Give an admin a new password. Every session of that admin is revoked and
 * every sign-in lock on it cleared. The password is prompted for (not echoed,
 * asked twice) or read from a file -- never taken from the command line.
 *
 *   npm run reset-admin-password -- --email <email> [--password-file <path>]
 *
 * See src/adminAccount.js.
 */
import { parseArgs, readNewPassword, resetAdminPassword, runCommand, AdminCommandRefused } from '../src/adminAccount.js';

await runCommand(async () => {
  const args = parseArgs(process.argv.slice(2), ['--email', '--password-file']);
  if (!args.email) throw new AdminCommandRefused('--email is required');
  const password = await readNewPassword({ file: args['password-file'] });
  const done = await resetAdminPassword({ email: args.email, password });
  console.log(`password reset for ${done.email} (tenant ${done.tenant_id}): ${done.sessions_revoked} session(s) revoked, ${done.locks_cleared} lock(s) cleared`);
});
