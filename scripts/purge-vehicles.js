#!/usr/bin/env node
/**
 * Enforces the retention decision. Run it on a schedule.
 *
 *   node scripts/purge-vehicles.js            redact everything eligible
 *   node scripts/purge-vehicles.js --dry-run  report what would go, change nothing
 */
import { pool, withTenant } from '../src/db.js';
import { listTenantIds, redactExpiredVehicles } from '../src/retention.js';
import { runPictureRetention, summary } from '../src/pictureRetention.js';
import { blankExpiredCopies } from '../src/exceptions.js';

const dryRun = process.argv.includes('--dry-run');
const tenants = await listTenantIds(pool);

// The pictures first (src/pictureRetention.js, the same job as
// scripts/purge-pictures.js): a walk is deleted only once none of its
// pictures is kept. Never in a dry run.
const pictures = dryRun ? null : await runPictureRetention(tenants);

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
if (pictures) console.log(summary(pictures));

// The gate agent's records copied onto exceptions (0048), past each account's
// window: blanked, counts only. Never in a dry run.
if (!dryRun) {
  let blanked = 0;
  for (const tenantId of tenants) blanked += await withTenant(tenantId, (client) => blankExpiredCopies(client, tenantId));
  console.log(`exceptions: ${tenants.length} tenant(s); blanked ${blanked} gate-agent copy(ies) past their window.`);
}
await pool.end();
