import { randomUUID } from 'node:crypto';
import { pool, withTenant } from '../src/db.js';

/**
 * Create a tenant using the application connection.
 *
 * The id is generated here rather than by the column default, because the
 * tenants policy is `WITH CHECK (id = current_tenant_id())` -- the row can only
 * be written by a connection already claiming to be that tenant. Seeding this
 * way exercises the policy instead of stepping around it, and behaves the same
 * whoever owns the database.
 */
export async function createTenant(name = 'tenant') {
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

/** One garage with both lanes, a vehicle and a rate — enough to exercise everything. */
export async function buildWorld(tenantId, { hourlyMinor = 250, currency = 'USD' } = {}) {
  return withTenant(tenantId, async (client) => {
    const garage = (
      await client.query(
        `INSERT INTO garages (tenant_id, name, timezone, currency)
         VALUES ($1, 'Test Garage', 'America/New_York', $2) RETURNING id`,
        [tenantId, currency],
      )
    ).rows[0].id;

    const lane = async (name, direction) =>
      (
        await client.query(
          `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id`,
          [tenantId, garage, name, direction],
        )
      ).rows[0].id;

    const entryLane = await lane('Entry 1', 'entry');
    const exitLane = await lane('Exit 1', 'exit');

    const vehicle = (
      await client.query(
        `INSERT INTO vehicles (tenant_id, plate) VALUES ($1, $2) RETURNING id`,
        [tenantId, `PLATE-${tenantId.slice(0, 6)}`],
      )
    ).rows[0].id;

    const rate = (
      await client.query(
        `INSERT INTO rates (tenant_id, garage_id, name, hourly_minor) VALUES ($1,$2,'Hourly',$3) RETURNING id`,
        [tenantId, garage, hourlyMinor],
      )
    ).rows[0].id;

    return { tenantId, garage, entryLane, exitLane, vehicle, rate, currency, hourlyMinor };
  });
}

export { pool, withTenant };
