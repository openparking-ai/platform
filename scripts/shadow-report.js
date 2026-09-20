#!/usr/bin/env node
/**
 * What the shadow run may publish, for one garage, with its denominator and
 * its oracle on the same lines.
 *
 *   node scripts/shadow-report.js <tenant-id> <garage-id>
 */
import { pool } from '../src/db.js';
import { shadowReport } from '../src/shadow.js';

const [tenantId, garageId] = process.argv.slice(2);
if (!tenantId || !garageId) {
  console.error('usage: node scripts/shadow-report.js <tenant-id> <garage-id>');
  process.exit(1);
}
const report = await shadowReport(tenantId, garageId);
console.log(JSON.stringify(report, null, 2));
await pool.end();
