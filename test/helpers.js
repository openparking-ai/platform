import { randomUUID } from 'node:crypto';
import { pool, withTenant } from '../src/db.js';

/**
 * Create a tenant using the application connection.
 *
 * The id is generated here rather than by the default, because the tenants
 * policy is `WITH CHECK (id = current_tenant_id())` -- so the row can only be
 * written by a connection already claiming to be that tenant. Seeding this way
 * exercises the policy instead of stepping around it, and it works identically
 * whoever the owner role happens to be.
 */
export async function createTenant(name) {
  const id = randomUUID();
  await withTenant(id, (client) =>
    client.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [
      id,
      `${name}-${id.slice(0, 8)}`,
      name,
    ]),
  );
  return id;
}

export async function createSite(tenantId, name) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      'INSERT INTO parking_sites (tenant_id, name) VALUES ($1, $2) RETURNING id',
      [tenantId, name],
    );
    return rows[0].id;
  });
}

export { pool, withTenant };
