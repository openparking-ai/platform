#!/usr/bin/env node
/**
 * Enforces the retention decision. Run it on a schedule.
 *
 *   node scripts/purge-vehicles.js            redact everything eligible
 *   node scripts/purge-vehicles.js --dry-run  report what would go, change nothing
 */
import { pool } from '../src/db.js';
import { listTenantIds, redactExpiredVehicles } from '../src/retention.js';

const dryRun = process.argv.includes('--dry-run');
const tenants = await listTenantIds(pool);

let total = 0;
for (const tenantId of tenants) {
  const result = await redactExpiredVehicles(tenantId, { dryRun });
  const n = dryRun ? result.wouldRedact : result.redacted;
  total += n;
  if (n > 0 || process.env.VERBOSE) {
    console.log(
      `${tenantId.slice(0, 8)}  retention=${result.retentionDays}d  ` +
        `${dryRun ? 'would redact' : 'redacted'} ${n}`,
    );
  }
}
console.log(`${tenants.length} tenant(s); ${dryRun ? 'would redact' : 'redacted'} ${total} vehicle(s).`);
await pool.end();
