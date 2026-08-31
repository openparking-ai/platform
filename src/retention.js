/**
 * Retention for vehicle identity.
 *
 * REDACTION, not deletion, and the distinction is load-bearing: `sessions`
 * references `vehicles` with ON DELETE CASCADE, so deleting a vehicle would
 * take its parking sessions -- and therefore the financial record of every
 * stay it ever paid for -- with it. Purging personal data must not destroy the
 * books.
 *
 * So the row survives, the sessions keep pointing at it, and everything that
 * identifies a person or a car is replaced. `redacted_at` records that it
 * happened, and the placeholder plate keeps the unique index satisfied without
 * carrying any information.
 *
 * A vehicle is identified by a plate OR a TICKET REFERENCE (migration 0007),
 * and both are redacted the same way, on the same window, under the same
 * never-redact rules. The `CASE` below is what keeps `vehicles_exactly_one_identity`
 * true through the redaction: whichever column the row carries gets the
 * placeholder and the other stays NULL. Writing the placeholder into both
 * would violate the constraint and fail the whole purge; writing it into
 * neither would leave a ticket — which a person read out loud and which
 * identifies a stay — as the one piece of identity retention could not remove.
 */
import { withTenant } from './db.js';
import * as repo from './repository.js';

export async function redactExpiredVehicles(tenantId, { now = null, dryRun = false } = {}) {
  return withTenant(tenantId, async (client) => {
    const days = await repo.retentionDays(client, tenantId);

    // A vehicle is eligible when it is not enrolled, is not already redacted,
    // has no session still open, and its most recent stay closed longer ago
    // than the tenant's retention window. A vehicle that never had a session
    // falls back to when it was last seen, so a read that never became a
    // parking session ages out too.
    const where = `
      WHERE v.tenant_id = $1
        AND v.enrolled = false
        AND v.redacted_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM sessions s WHERE s.vehicle_id = v.id AND s.exit_at IS NULL)
        AND COALESCE(
              (SELECT max(s.exit_at) FROM sessions s WHERE s.vehicle_id = v.id),
              v.last_seen_at
            ) < COALESCE($2::timestamptz, now()) - make_interval(days => $3)`;

    if (dryRun) {
      const { rows } = await client.query(
        `SELECT v.id, v.plate, v.ticket_ref FROM vehicles v ${where} ORDER BY v.last_seen_at`,
        [tenantId, now, days],
      );
      return { tenantId, retentionDays: days, redacted: 0, wouldRedact: rows.length, rows };
    }

    const { rows } = await client.query(
      `UPDATE vehicles v
          SET plate        = CASE WHEN v.plate      IS NULL THEN NULL
                                  ELSE 'redacted:' || v.id END,
              ticket_ref   = CASE WHEN v.ticket_ref IS NULL THEN NULL
                                  ELSE 'redacted:' || v.id END,
              plate_region = NULL,
              make         = NULL,
              model        = NULL,
              color        = NULL,
              attributes   = '{}'::jsonb,
              redacted_at  = COALESCE($2::timestamptz, now())
        ${where}
        RETURNING v.id`,
      [tenantId, now, days],
    );
    return { tenantId, retentionDays: days, redacted: rows.length, wouldRedact: rows.length };
  });
}

export async function listTenantIds(pool) {
  const { rows } = await pool.query('SELECT tenant_id FROM list_tenant_ids_for_maintenance()');
  return rows.map((r) => r.tenant_id);
}
