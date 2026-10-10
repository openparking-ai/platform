#!/usr/bin/env node
/**
 * Invite the one admin of a new tenant (0032): the tenant made, an invite for
 * the email, and the email sent, all of it or none. Or send a waiting invite
 * again: the earlier link then says "replaced".
 *
 *   npm run invite-admin -- --name "<company>" --email <email> [--language es]
 *   npm run invite-admin -- --resend <email> [--language es]
 *
 * It prints one line, "invited <email> for tenant <id>; the link ends <date>",
 * and NEVER THE LINK: the link is a credential, and it goes to the inbox only.
 * With no email configured here (EMAIL_KEY_FILE, EMAIL_FROM) or no ADMIN_ORIGIN
 * for the link to lead to, it refuses in plain words before storing anything.
 *
 * See src/invites.js. The argument rules are create-admin's (src/adminAccount.js):
 * a password argument, an unknown option and a bare value are refused.
 */
import { parseArgs, runCommand, AdminCommandRefused } from '../src/adminAccount.js';
import { inviteAdmin, resendInvite } from '../src/invites.js';
import { readAuthSettings } from '../src/signIn.js';
import { readEmailSettings } from '../src/email.js';
import { whenUtc } from '../src/emailText.js';

await runCommand(async () => {
  const args = parseArgs(process.argv.slice(2), ['--name', '--email', '--language', '--resend']);
  const resend = args.resend !== undefined;
  if (resend && (args.name !== undefined || args.email !== undefined)) {
    throw new AdminCommandRefused('--resend <email> takes no --name or --email: it sends the waiting invite of that email again');
  }
  if (!resend && (!args.name || !args.email)) throw new AdminCommandRefused('--name and --email are required, or --resend <email>');
  let settings;
  try {
    settings = { adminOrigin: readAuthSettings().adminOrigin, email: readEmailSettings() };
  } catch (err) {
    throw new AdminCommandRefused(`${err.message}; nothing was changed`);
  }
  const done = resend
    ? await resendInvite({ email: args.resend, language: args.language }, settings)
    : await inviteAdmin({ name: args.name, email: args.email, language: args.language }, settings);
  console.log(`invited ${done.email} for tenant ${done.tenantId}; the link ends ${whenUtc(done.expiresAt)}`);
});
