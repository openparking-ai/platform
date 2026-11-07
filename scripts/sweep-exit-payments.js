#!/usr/bin/env node
/**
 * The exit payments no lane finished (src/exitPaymentSweep.js). Run it on a
 * schedule, every minute:
 *
 *   npm run sweep-exit-payments
 *
 * It reads Stripe and writes this platform's records; it writes nothing at
 * Stripe. One run at a time: a run that finds another working stops, exit 0. A
 * run stops reading after 5 minutes, and a run stuck a minute past that is ended
 * by its watchdog, exit 1, which lets the lock go. One account at a time, under
 * its row security, from a random account each run.
 *
 * Prints counts only: what it actually read, and each charge written down that no
 * run has reported yet, by this run or by a lane, a close, a let-out or a stay's
 * end. Exits 1 when there is one, or a read failed, so the schedule's own mail
 * or alarm says so. Exactly one run reports each charge, however long runs take.
 *
 *   SWEEP_LIMIT=200   how many payments per account per run (default 200)
 */
import { pool } from '../src/db.js';
import { listTenantIds } from '../src/retention.js';
import {
  reportWrittenDown, sweepOpenPayments, whileHoldingSweepLock, RUN_DEADLINE_MS, SWEEP_LIMIT, WATCHDOG_AFTER_MS,
} from '../src/exitPaymentSweep.js';

const positive = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
};
const limit = positive('SWEEP_LIMIT', SWEEP_LIMIT);
const deadlineMs = positive('SWEEP_DEADLINE_MS', RUN_DEADLINE_MS);

// The deadline stops the reads; only this bounds a wait on the database.
setTimeout(() => {
  console.error('exit payments: this run is stuck past its deadline; ending it.');
  process.exit(1);
}, deadlineMs + positive('SWEEP_WATCHDOG_AFTER_MS', WATCHDOG_AFTER_MS));

const deadline = Date.now() + deadlineMs;
const total = { read: 0, paid: 0, written: 0, failed: 0 };
const tenants = await listTenantIds(pool);
// A Stripe that hangs ends a run at its deadline: the next starts elsewhere.
const from = Math.floor(Math.random() * tenants.length);
const turns = [...tenants.slice(from), ...tenants.slice(0, from)];
const tell = (tenantId, err) => {
  total.failed += 1;
  console.error(`exit payments: tenant ${tenantId.slice(0, 8)} not swept: ${err.message ?? err}`);
};
const run = await whileHoldingSweepLock(async () => {
  for (const tenantId of turns) {
    try {
      const summary = await sweepOpenPayments(tenantId, { limit, deadline });
      total.read += summary.due;
      total.paid += summary.paid;
      total.failed += summary.failed;
    } catch (err) {
      tell(tenantId, err);
    }
  }
  // Last, after every read: and what this leaves is the next run's.
  for (const tenantId of turns) {
    try {
      total.written += await reportWrittenDown(tenantId);
    } catch (err) {
      tell(tenantId, err);
    }
  }
});
if (!run.ran) {
  console.log('exit payments: another run is working; this one stopped.');
} else {
  const cut = Date.now() >= deadline ? ' Stopped reading at the deadline.' : '';
  console.log(`exit payments: ${tenants.length} tenant(s); ${total.read} read, ${total.paid} recorded paid, ${total.written} written down, ${total.failed} left for the next run.${cut}`);
}
await pool.end();
process.exit(total.failed || total.written ? 1 : 0);
