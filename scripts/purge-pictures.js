#!/usr/bin/env node
/**
 * Removes the lane and walk pictures whose 30 days are over
 * (src/pictureRetention.js). Run it on a schedule, daily.
 *
 *   node scripts/purge-pictures.js
 *
 * It prints one line of counts.
 */
import { pool } from '../src/db.js';
import { listTenantIds } from '../src/retention.js';
import { runPictureRetention, summary } from '../src/pictureRetention.js';

const tenants = await listTenantIds(pool);
console.log(summary(await runPictureRetention(tenants)));
await pool.end();
