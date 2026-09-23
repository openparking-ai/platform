#!/usr/bin/env node
/**
 * The validation holds nobody took, given back. Run it on a schedule, beside
 * the purge and the reconciler's sweep:
 *
 *   node scripts/release-validation-holds.js
 *
 * A driver who enters a phone at the reader has a validation CLAIMED for their
 * stay at that moment, so the amount they are shown is the discounted one
 * (0019, amendment A1). The close records the claim. A driver who then does
 * not pay and leave has claimed something no close will record -- and a
 * validation held by a stay that never closes would be stranded. So every
 * OPEN stay whose claim is older than the hold window is released through the
 * module's own door: the validation is unclaimed again, live if its
 * garage-day has not ended, and the stay's record and an event say so. A
 * driver who comes back to the reader later enters the phone and claims again.
 *
 *   VALIDATION_HOLD_MINUTES=30   the hold window (default 30)
 *   VERBOSE=1                    a line per tenant even when there was nothing
 *
 * Needs the validations door (ENTITLEMENT_BIN_DIR or PATH) and its DSN, as
 * the close does. A release the door could not make leaves the hold for the
 * next run; the exit code says how many.
 */
import { pool } from '../src/db.js';
import { listTenantIds } from '../src/retention.js';
import { releaseStaleHolds } from '../src/validations.js';

const holdMinutes = Number(process.env.VALIDATION_HOLD_MINUTES ?? 30);
if (!Number.isFinite(holdMinutes) || holdMinutes <= 0) {
  console.error('VALIDATION_HOLD_MINUTES must be a positive number');
  process.exit(1);
}

const tenants = await listTenantIds(pool);
const total = { stale: 0, released: 0, not_released: 0, failed: 0 };
for (const tenantId of tenants) {
  const summary = await releaseStaleHolds(tenantId, { holdMinutes });
  for (const key of Object.keys(total)) total[key] += summary[key];
  if (summary.stale > 0 || process.env.VERBOSE) {
    console.log(
      `${tenantId.slice(0, 8)}  stale=${summary.stale}  released=${summary.released}  ` +
        `not_released=${summary.not_released}  failed=${summary.failed}`,
    );
  }
}
console.log(
  `${tenants.length} tenant(s); ${total.stale} hold(s) older than ${holdMinutes} min on open stays: ` +
    `${total.released} released, ${total.not_released} not released (already given back, or superseded), ` +
    `${total.failed} left for the next run.`,
);
await pool.end();
process.exit(total.failed ? 1 : 0);
