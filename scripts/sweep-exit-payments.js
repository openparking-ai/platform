#!/usr/bin/env node
/**
 * The exit payments no lane finished (src/exitPaymentSweep.js). Run it on a
 * schedule, every minute:
 *
 *   npm run sweep-exit-payments
 *
 * It reads Stripe and writes this platform's records; it writes nothing at
 * Stripe. One run at a time: a run that finds another working stops, and a run
 * stops reading after 5 minutes. One account at a time, under its row security,
 * from a different account each run. Prints counts only, and a line on the error
 * output for each charge it wrote down and each read that failed. Exits 1 when a
 * read failed, or a charge was written down in the last 2 minutes by this run or
 * by a lane, a close, a let-out or a stay's end, so the schedule's own mail or
 * alarm says so. Each is seen by about two runs.
 *
 *   SWEEP_LIMIT=200   how many payments per account per run (default 200)
 */
import { pool } from '../src/db.js';
import { listTenantIds } from '../src/retention.js';
import {
  sweepOpenPayments, whileHoldingSweepLock, writtenDownSince, ALARM_WINDOW_MS, RUN_DEADLINE_MS, SWEEP_LIMIT,
} from '../src/exitPaymentSweep.js';

const limit = Number(process.env.SWEEP_LIMIT ?? SWEEP_LIMIT);
if (!Number.isInteger(limit) || limit < 1) {
  console.error('SWEEP_LIMIT must be a positive integer');
  process.exit(1);
}

const started = Date.now();
const total = { due: 0, paid: 0, recent: 0, failed: 0 };
const tenants = await listTenantIds(pool);
// A Stripe that hangs ends a run at its deadline: the next starts elsewhere.
const from = Math.floor(Math.random() * tenants.length);
const turns = [...tenants.slice(from), ...tenants.slice(0, from)];
const run = await whileHoldingSweepLock(async () => {
  for (const tenantId of turns) {
    try {
      const summary = await sweepOpenPayments(tenantId, { limit, deadline: started + RUN_DEADLINE_MS });
      total.due += summary.due;
      total.paid += summary.paid;
      total.failed += summary.failed;
      total.recent += await writtenDownSince(tenantId, new Date(started - ALARM_WINDOW_MS));
    } catch (err) {
      total.failed += 1;
      console.error(`exit payments: tenant ${tenantId.slice(0, 8)} not swept: ${err.message ?? err}`);
    }
  }
});
if (!run.ran) {
  console.log('exit payments: another run is working; this one stopped.');
} else {
  console.log(`exit payments: ${tenants.length} tenant(s); ${total.due} read, ${total.paid} recorded paid, ${total.recent} written down lately, ${total.failed} left for the next run.`);
}
await pool.end();
process.exit(total.failed || total.recent ? 1 : 0);
