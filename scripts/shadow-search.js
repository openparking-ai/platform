#!/usr/bin/env node
/**
 * The shadow run's second half. Run it on a schedule, beside the purge.
 *
 *   VEHICLE_ID_URL=http://127.0.0.1:8088 \
 *   SHADOW_THRESHOLD_STRUCTURE=0.75 SHADOW_THRESHOLD_COLOUR=0.69 \
 *   node scripts/shadow-search.js
 *
 * Every pending shadow search, every tenant: the exit's descriptor against the
 * candidates the close snapshotted, the answer recorded, nothing acted on.
 *
 * The identity service it calls has to be reachable from this host -- loopback,
 * or a tokened bind (`VEHICLE_ID_TOKEN_FILE`) -- and it has to be one that
 * serves the search route. Nothing here starts one.
 */
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import { listTenantIds } from '../src/retention.js';
import { httpSearcher, runShadowSearches, thresholdsFromEnv } from '../src/shadow.js';

const url = process.env.VEHICLE_ID_URL;
if (!url) {
  console.error('VEHICLE_ID_URL is required: the identity service whose search route this run calls');
  process.exit(1);
}
const token = process.env.VEHICLE_ID_TOKEN_FILE
  ? readFileSync(process.env.VEHICLE_ID_TOKEN_FILE, 'utf8').trim()
  : null;
const thresholds = thresholdsFromEnv();
const search = httpSearcher(url, { token });

const tenants = await listTenantIds(pool);
let searched = 0;
let failed = 0;
for (const tenantId of tenants) {
  const summary = await runShadowSearches(tenantId, { search, thresholds });
  searched += summary.searched;
  failed += summary.failed;
  if (summary.pending > 0 || process.env.VERBOSE) {
    console.log(
      `${tenantId.slice(0, 8)}  pending=${summary.pending}  searched=${summary.searched}  failed=${summary.failed}`,
    );
  }
}
console.log(
  `${tenants.length} tenant(s); ${searched} shadow search(es) recorded, ${failed} left pending; ` +
    `thresholds structure=${thresholds.structure} colour=${thresholds.colour_bhattacharyya}`,
);
await pool.end();
process.exit(failed ? 1 : 0);
