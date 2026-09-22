#!/usr/bin/env node
/**
 * The reconciler, running because the clock said so. Run it on a schedule,
 * beside the purge and the shadow search:
 *
 *   node scripts/reconcile-lane-decisions.js
 *
 * Every lane-decided close, every tenant, that nothing has checked yet -- with
 * NO WINDOW over it. Since 0017 this platform stores fees a DEVICE wrote, and
 * the protection specified for that was a reconciler re-deriving each one from
 * what the lane said it decided from. That reconciler only ran when an
 * operator asked, inside the reconciliation route's window (24 hours by
 * default), so a fee nobody queried inside that day was never re-derived by
 * anything. This is the thing that looks.
 *
 * IT CORRECTS NOTHING. The verdict goes on the row in the two columns 0018
 * added, and a verdict that is not `agreed` also goes into `events`, which is
 * append-only by grant. The fee, the plan version, the inputs and the outcome
 * are left exactly as the close wrote them -- an auto-correcting reconciler on
 * a money record loses the evidence of the thing it was built to detect, and
 * one that corrects unattended does it with nobody watching.
 *
 * Needs the rate engine (`RATE_ENGINE_PYTHON`), because re-deriving a fee is
 * the same engine call the close would have made. A row whose engine cannot be
 * asked is left UNCHECKED and taken again next time; the exit code says how
 * many.
 *
 *   SWEEP_LIMIT=200   how many rows per tenant per run (default 200)
 *   VERBOSE=1         print a line per tenant even when there was nothing
 */
import { pool } from '../src/db.js';
import { sweepLaneDecisions } from '../src/reconcile.js';
import { listTenantIds } from '../src/retention.js';

const limit = Number(process.env.SWEEP_LIMIT ?? 200);
if (!Number.isInteger(limit) || limit < 1) {
  console.error('SWEEP_LIMIT must be a positive integer');
  process.exit(1);
}

const tenants = await listTenantIds(pool);
const total = { pending: 0, checked: 0, failed: 0, agreed: 0, diverged: 0, inputs_disagree: 0, unrecomputable: 0, covered: 0 };
for (const tenantId of tenants) {
  const summary = await sweepLaneDecisions(tenantId, { limit });
  for (const key of Object.keys(total)) total[key] += summary[key];
  if (summary.pending > 0 || process.env.VERBOSE) {
    console.log(
      `${tenantId.slice(0, 8)}  pending=${summary.pending}  checked=${summary.checked}  ` +
        `agreed=${summary.agreed}  diverged=${summary.diverged}  ` +
        `inputs_disagree=${summary.inputs_disagree}  unrecomputable=${summary.unrecomputable}  ` +
        `covered=${summary.covered}  failed=${summary.failed}`,
    );
  }
}
console.log(
  `${tenants.length} tenant(s); ${total.checked} lane-decided close(s) checked, ` +
    `${total.diverged} diverged, ${total.inputs_disagree} with inputs that disagree, ` +
    `${total.unrecomputable} unrecomputable, ${total.failed} left unchecked. Nothing was corrected.`,
);
await pool.end();
process.exit(total.failed ? 1 : 0);
