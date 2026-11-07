#!/usr/bin/env node
/**
 * The exit payments no lane finished (src/exitPaymentSweep.js). Run it on a
 * schedule, every minute:
 *
 *   npm run sweep-exit-payments
 *
 * It reads Stripe and writes this platform's records; it writes nothing at
 * Stripe. Runs that overlap are safe. One account at a time, under its row
 * security. Prints counts only, and a line on the error output for each charge
 * it wrote down and each read that failed. Exits 1 when there was either, so
 * the schedule's own mail or alarm says so.
 *
 *   SWEEP_LIMIT=200   how many payments per account per run (default 200)
 */
import { pool } from '../src/db.js';
import { listTenantIds } from '../src/retention.js';
import { sweepOpenPayments, SWEEP_LIMIT } from '../src/exitPaymentSweep.js';

const limit = Number(process.env.SWEEP_LIMIT ?? SWEEP_LIMIT);
if (!Number.isInteger(limit) || limit < 1) {
  console.error('SWEEP_LIMIT must be a positive integer');
  process.exit(1);
}

const total = { due: 0, paid: 0, unplaced: 0, failed: 0 };
const tenants = await listTenantIds(pool);
for (const tenantId of tenants) {
  try {
    const summary = await sweepOpenPayments(tenantId, { limit });
    for (const key of Object.keys(total)) total[key] += summary[key];
  } catch (err) {
    total.failed += 1;
    console.error(`exit payments: tenant ${tenantId.slice(0, 8)} not swept: ${err.message ?? err}`);
  }
}
console.log(`exit payments: ${tenants.length} tenant(s); ${total.due} read, ${total.paid} recorded paid, ${total.unplaced} written down, ${total.failed} left for the next run.`);
await pool.end();
process.exit(total.failed || total.unplaced ? 1 : 0);
