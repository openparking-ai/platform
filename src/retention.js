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
 * A car whose plate nobody could read (0036) carries `unread_ref`, the key of
 * its one stay, and it is redacted the same way, so the row keeps its shape.
 *
 * A SHADOW SEARCH (migration 0011) ages out with the stay it shadowed: the
 * row's session references -- `session_id`, `candidate_ids`, `matched_ids` --
 * are nulled and `redacted_at` stamped, and the counts and the outcome are
 * KEPT. The figure survives; what it was a figure about does not, which is the
 * vehicle's own redaction in the same shape. The `shadow_search` event beside
 * it is append-only by grant and the purge cannot reach it (see
 * docs/DATA_RETENTION.md, the open item).
 *
 * A session's ENTITLEMENT RECORD (migration 0015) -- what the pass and
 * monthly modules were asked and answered, which names the identity -- is
 * nulled in the same run, on the same sessions; the exit outcome it decided
 * is kept.
 *
 * A session's ENTRY DESCRIPTOR (migration 0009) and EXIT DESCRIPTOR (0010) are
 * redacted in the same run. They live on the session rather than the vehicle
 * -- a descriptor is one READ, not an identity -- but each describes one
 * specific car's appearance, so it is personal data on the same terms the
 * plate is. Both are nulled on every session of every vehicle this run
 * redacts, and on no other: the session keeps its times and its fee, exactly
 * as before.
 *
 * An INVENTORY WALK (0040) holds plates a person photographed or typed: it
 * is deleted, with its sightings and the stays it listed, once it finished,
 * was abandoned, or (neither) started longer ago than the window, and none
 * of its pictures is still kept. Its pictures, and the lane's, go by their
 * own rule, in the picture job (src/pictureRetention.js).
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
        -- A car on a banned list (0033) is kept whole while it is listed:
        -- its plate, its descriptor and its stay. Taken off, it ages out here
        -- as any other.
        AND NOT EXISTS (
              SELECT 1 FROM banned_vehicles b JOIN sessions s ON s.id = b.session_id
               WHERE s.vehicle_id = v.id)
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
              unread_ref   = CASE WHEN v.unread_ref IS NULL THEN NULL
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
    // The descriptors, on the sessions of exactly the vehicles redacted above.
    // Nulled rather than replaced: there is no unique index to keep satisfied,
    // and NULL already means NOT MEASURED on these columns.
    if (rows.length) {
      await client.query(
        `UPDATE sessions SET entry_descriptor = NULL, exit_descriptor = NULL
          WHERE tenant_id = $1
            AND (entry_descriptor IS NOT NULL OR exit_descriptor IS NOT NULL)
            AND vehicle_id = ANY($2::uuid[])`,
        [tenantId, rows.map((r) => r.id)],
      );
      // What was read of an unread car's plate below the lane's confidence
      // (0036): a plate's text, so it goes with the descriptors.
      await client.query(
        `UPDATE sessions SET entry_unsure_plate = NULL, entry_unsure_plate_confidence = NULL
          WHERE tenant_id = $1 AND entry_unsure_plate IS NOT NULL AND vehicle_id = ANY($2::uuid[])`,
        [tenantId, rows.map((r) => r.id)],
      );
      // The ID the exit matched by (0037): plate characters, colour, size --
      // on the stay, and on every exit case that found it.
      await client.query(
        `UPDATE sessions SET entry_plate_state = NULL, entry_plate_rule = NULL, entry_plate_pattern = NULL,
                             entry_colour_code = NULL, entry_size = NULL
          WHERE tenant_id = $1 AND vehicle_id = ANY($2::uuid[])
            AND (entry_plate_state IS NOT NULL OR entry_colour_code IS NOT NULL OR entry_size IS NOT NULL)`,
        [tenantId, rows.map((r) => r.id)],
      );
      await client.query(
        `UPDATE exits SET plate_state = NULL, plate_rule = NULL, plate_pattern = NULL, colour_code = NULL, size = NULL
          WHERE tenant_id = $1
            AND session_id IN (SELECT s.id FROM sessions s WHERE s.tenant_id = $1 AND s.vehicle_id = ANY($2::uuid[]))`,
        [tenantId, rows.map((r) => r.id)],
      );
      // The entitlement record (0015) names the identity the modules were
      // asked about, inside the argv and their answers. Nulled with the
      // descriptors; `exit_outcome` stays -- the outcome survives, who it was
      // about does not.
      await client.query(
        `UPDATE sessions SET entitlement = NULL
          WHERE tenant_id = $1 AND entitlement IS NOT NULL AND vehicle_id = ANY($2::uuid[])`,
        [tenantId, rows.map((r) => r.id)],
      );
      // The shadow rows about those vehicles' stays: references out, figure kept.
      await client.query(
        `UPDATE shadow_searches sh
            SET session_id = NULL, candidate_ids = NULL, matched_ids = NULL,
                redacted_at = COALESCE($3::timestamptz, now())
          WHERE sh.tenant_id = $1 AND sh.redacted_at IS NULL
            AND sh.session_id IN (SELECT s.id FROM sessions s WHERE s.vehicle_id = ANY($2::uuid[]))`,
        [tenantId, rows.map((r) => r.id), now],
      );
    }
    // An exit case that found no stay (the driver's word, or a person) has no
    // vehicle to age out with: its ID goes when the window has passed since
    // the car left.
    await client.query(
      `UPDATE exits SET plate_state = NULL, plate_rule = NULL, plate_pattern = NULL, colour_code = NULL, size = NULL
        WHERE tenant_id = $1 AND session_id IS NULL
          AND (plate_state IS NOT NULL OR colour_code IS NOT NULL OR size IS NOT NULL)
          AND COALESCE(closed_at, exit_at) < COALESCE($2::timestamptz, now()) - make_interval(days => $3)`,
      [tenantId, now, days],
    );
    // A walk one of whose pictures is still kept (src/pictureRetention.js)
    // waits for it: deleting the walk would take the picture with it.
    const { rowCount: walks } = await client.query(
      `DELETE FROM walks w
        WHERE w.tenant_id = $1
          AND COALESCE(w.finished_at, w.abandoned_at, w.started_at) < COALESCE($2::timestamptz, now()) - make_interval(days => $3)
          AND NOT EXISTS (
                SELECT 1 FROM walk_sightings ws
                 WHERE ws.tenant_id = w.tenant_id AND ws.walk_id = w.id AND ws.picture IS NOT NULL)`,
      [tenantId, now, days],
    );
    return { tenantId, retentionDays: days, redacted: rows.length, wouldRedact: rows.length, walksDeleted: walks };
  });
}

export async function listTenantIds(pool) {
  const { rows } = await pool.query('SELECT tenant_id FROM list_tenant_ids_for_maintenance()');
  return rows.map((r) => r.tenant_id);
}
