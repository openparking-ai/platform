#!/usr/bin/env node
/**
 * The exceptions' records, finished (0048). Run it on a schedule -- every
 * few minutes, beside the validation sweep:
 *
 *   npm run complete-exceptions
 *
 * An exception is written when a person lets a car out, with what the gate
 * agent had sent until then. Its window runs to 15 minutes after the
 * let-out, so once that has passed this copies the gate agent's messages and
 * calls for the whole window again (complete), and the platform's own lane
 * events after the let-out. A gate agent that could not be reached is asked
 * again, at most 6 times, until 24 hours after the window; one not
 * configured is not asked again. A let-out whose own write of its exception
 * failed gets its exception here, from what is on record.
 *
 * One tenant at a time, under its row security. Prints counts only.
 */
import { pool, withTenant } from '../src/db.js';
import { listTenantIds } from '../src/retention.js';
import * as exits from '../src/exits.js';
import * as repo from '../src/repository.js';
import * as exceptions from '../src/exceptions.js';

const total = { recovered: 0, finished: 0, failed: 0 };
const tenants = await listTenantIds(pool);
for (const tenantId of tenants) {
  const write = (fn) => withTenant(tenantId, fn);
  try {
    for (const m of await write((client) => exceptions.missing(client, tenantId))) {
      const made = await write(async (client) => {
        const exitCase = await exits.caseById(client, tenantId, m.garage_id, m.exit_id);
        const garage = await repo.getGarage(client, tenantId, m.garage_id);
        return exceptions.recordLetOut(client, tenantId, {
          exitCase, source: m.source, by: m.by ?? 'unknown', authority: m.authority, reason: m.reason,
          at: new Date(m.at), garageCurrency: garage.currency, recovered: true,
        });
      });
      if (made.created) {
        total.recovered += 1;
        await exceptions.copyGateAgent(write, tenantId, made.row);
      }
    }
    for (const x of await write((client) => exceptions.toFinish(client, tenantId))) {
      await exceptions.finish(write, tenantId, x);
      total.finished += 1;
    }
  } catch (err) {
    total.failed += 1;
    console.error(`exceptions: tenant ${tenantId.slice(0, 8)} not finished: ${err.message ?? err}`);
  }
}
console.log(`exceptions: ${tenants.length} tenant(s); ${total.recovered} written from the record, ${total.finished} finished, ${total.failed} tenant(s) left for the next run.`);
await pool.end();
process.exit(total.failed ? 1 : 0);
