#!/usr/bin/env node
/**
 * Mints an operator token. Requires database access, deliberately: there is no
 * HTTP route that can create one, because the operator surface is what a token
 * unlocks.
 *
 *   node scripts/issue-operator-token.js <tenant-id> "<name>"
 */
import { pool, withTenant } from '../src/db.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';

const [tenantId, name] = process.argv.slice(2);
if (!tenantId || !name) {
  console.error('usage: issue-operator-token.js <tenant-id> "<name>"');
  process.exit(1);
}

const token = generateDeviceToken();
const row = await withTenant(tenantId, async (client) => {
  const { rows } = await client.query(
    `INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,$2,$3)
     RETURNING id, name, created_at`,
    [tenantId, name, hashToken(token)],
  );
  return rows[0];
});

console.log(`operator token for tenant ${tenantId}`);
console.log(`  id:    ${row.id}`);
console.log(`  name:  ${row.name}`);
console.log(`  token: ${token}`);
console.log('\nShown once. Only its SHA-256 is stored.');
await pool.end();
