#!/usr/bin/env node
/**
 * Give an admin a new password. Every session of that admin is revoked, every
 * sign-in lock on it cleared, and every passkey of theirs removed (0047); when
 * passkeys were removed and email is configured, the admin is told by email.
 * The password is prompted for (not echoed, asked twice) or read from a file
 * -- never taken from the command line.
 *
 *   npm run reset-admin-password -- --email <email> [--password-file <path>]
 *
 * See src/adminAccount.js.
 */
import { parseArgs, readNewPassword, resetAdminPassword, runCommand, AdminCommandRefused } from '../src/adminAccount.js';
import { notify, readEmailSettings } from '../src/email.js';
import { passkeysRemovedEmail } from '../src/emailText.js';

await runCommand(async () => {
  const args = parseArgs(process.argv.slice(2), ['--email', '--password-file']);
  if (!args.email) throw new AdminCommandRefused('--email is required');
  const password = await readNewPassword({ file: args['password-file'] });
  const email = readEmailSettings();
  const done = await resetAdminPassword({ email: args.email, password });
  console.log(`password reset for ${done.email} (tenant ${done.tenant_id}): ${done.sessions_revoked} session(s) revoked, ${done.locks_cleared} lock(s) cleared, ${done.passkeys_removed} passkey(s) removed`);
  if (done.passkeys_removed > 0) {
    const told = await notify(email, { to: done.email, ...passkeysRemovedEmail(done.language, { count: done.passkeys_removed, at: new Date() }) }, 'passkeys-removed notice');
    console.log(told ? 'the admin was told by email that their passkeys were removed' : 'the admin was NOT told by email that their passkeys were removed: tell them yourself');
  }
});
