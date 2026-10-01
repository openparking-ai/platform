#!/usr/bin/env node
/**
 * Create a tenant's one admin. The password is prompted for (not echoed,
 * asked twice) or read from a file -- never taken from the command line.
 *
 *   npm run create-admin -- --tenant <tenant-id> --email <email> [--password-file <path>]
 *
 * See src/adminAccount.js.
 */
import { createAdmin, parseArgs, readNewPassword, runCommand, AdminCommandRefused } from '../src/adminAccount.js';

await runCommand(async () => {
  const args = parseArgs(process.argv.slice(2), ['--tenant', '--email', '--password-file']);
  if (!args.tenant || !args.email) throw new AdminCommandRefused('--tenant and --email are required');
  const password = await readNewPassword({ file: args['password-file'] });
  const admin = await createAdmin({ tenantId: args.tenant, email: args.email, password });
  console.log(`admin created for tenant ${admin.tenant_id}: ${admin.email}`);
});
