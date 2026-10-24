/**
 * Pictures kept with an entry, and the owner's list of banned cars (0033, U7f).
 *
 * PICTURES. A lane sends the pictures it took between the vend and the closing
 * loop, and at the closing loop, each against the lane's event id of the entry
 * record it belongs to: a stay's open, a tailgater nobody identified, a banned
 * car refused. They are removed one week after the car left -- the stay's exit
 * -- or, when no stay holds them, one week after they were taken. A car still
 * inside keeps them, and so does a car on the list. The arming loop's pictures
 * are not here and nothing here touches them: none is stored anywhere.
 *
 * THE LIST. With the garage's "ban tailgaters" on, a tailgater stay opened
 * there with an identity read is listed; nothing else lists a car, and there
 * is no route that does. Its reach is the listing garage's `ban_reach`, read
 * when a lane loads its list: this garage, or every garage of the account.
 * A lane matches a car against the list by its descriptor (the OPA ID), the
 * way the exit search compares them. Removing a ban deletes the row.
 *
 * WRITTEN FRESH. Every picture is decoded and written again, as the type it
 * came in, before it is kept: what a lane sent beside the image -- EXIF,
 * comments, bytes after its end -- is never kept or shown to the owner. It is
 * turned upright as its EXIF said and kept at most PICTURE_MAX_SIDE pixels on
 * its longer side.
 */
import sharp from 'sharp';

/** How long a picture is kept after the car left. His answer: one week. */
export const PICTURE_DAYS = 7;

/** The largest picture a lane may send, in bytes, as the table holds it. */
export const PICTURE_MAX_BYTES = 3 * 1024 * 1024;

/** The longer side a picture is kept at, at most: lane cameras send 1920 to 2688 wide, and a plate reads at 2560. */
export const PICTURE_MAX_SIDE = 2560;

/** The most pixels a lane picture may decode to (8000 by 5000). Its header is read first: a few bytes can declare a vast image. */
export const PICTURE_MAX_PIXELS = 40_000_000;

sharp.cache(false);

/**
 * The picture decoded and written fresh as `contentType` (image/jpeg or
 * image/png): the image alone, upright, at most PICTURE_MAX_SIDE on a side.
 * Null when the bytes do not open as a picture of at most PICTURE_MAX_PIXELS.
 */
export async function freshPicture(bytes, contentType) {
  try {
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: PICTURE_MAX_PIXELS })
      .rotate()
      .resize({ width: PICTURE_MAX_SIDE, height: PICTURE_MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    return await (contentType === 'image/png' ? image.png() : image.jpeg({ quality: 90 })).toBuffer();
  } catch {
    return null;
  }
}

/** The picture's type, from its first bytes -- never from what the sender says. */
export function pictureType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return null;
}

/** Keep one picture. A resend of the same `picture_ref` is the same picture. */
export async function storePicture(client, tenantId, { garageId, laneId, pictureRef, eventId, takenAt, contentType, image }) {
  const { rows } = await client.query(
    `INSERT INTO entry_pictures (tenant_id, garage_id, lane_id, picture_ref, event_id, taken_at, content_type, image)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, lane_id, picture_ref) DO NOTHING
     RETURNING id`,
    [tenantId, garageId, laneId, pictureRef, eventId, takenAt, contentType, image],
  );
  return { created: rows.length === 1 };
}

/**
 * List a tailgater stay, if its garage bans tailgaters and the lane read the
 * car's identity. Called on the stay's open, in its transaction.
 */
export async function listIfBanned(client, tenantId, { garage, session }) {
  if (!session.tailgater || !garage.ban_tailgaters || !session.entry_descriptor) return false;
  const { rows } = await client.query(
    `INSERT INTO banned_vehicles (tenant_id, garage_id, session_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO NOTHING
     RETURNING id`,
    [tenantId, session.garage_id, session.id],
  );
  return rows.length === 1;
}

/**
 * The bans that reach this garage: listed here, or listed at a garage of the
 * account whose reach is all its garages. `extra` adds columns for the owner.
 */
const REACHING = `
  FROM banned_vehicles b
  JOIN sessions s ON s.id = b.session_id AND s.tenant_id = b.tenant_id
  JOIN garages  g ON g.id = b.garage_id  AND g.tenant_id = b.tenant_id
 WHERE b.tenant_id = $1
   AND (b.garage_id = $2 OR g.ban_reach = 'all')`;

/** What a lane matches arrivals against: each ban's id and the car's descriptor. */
export async function forLane(client, tenantId, garageId) {
  const { rows } = await client.query(
    `SELECT b.id, s.entry_descriptor AS descriptor ${REACHING}
        AND s.entry_descriptor IS NOT NULL
      ORDER BY b.listed_at, b.id`,
    [tenantId, garageId],
  );
  return rows;
}

/** The garage's two settings and the cars banned there, each with its pictures. */
export async function forOwner(client, tenantId, garageId) {
  const { rows: garage } = await client.query(
    'SELECT ban_tailgaters, ban_reach FROM garages WHERE tenant_id = $1 AND id = $2',
    [tenantId, garageId],
  );
  if (!garage[0]) return null;
  const { rows: cars } = await client.query(
    `SELECT b.id, b.listed_at, b.garage_id, g.name AS garage_name, s.entry_at, v.plate,
            COALESCE((SELECT json_agg(json_build_object('id', p.id, 'taken_at', p.taken_at) ORDER BY p.taken_at, p.id)
                        FROM entry_pictures p
                       WHERE p.tenant_id = s.tenant_id AND p.event_id = s.open_event_id), '[]'::json) AS pictures
       FROM banned_vehicles b
       JOIN sessions s ON s.id = b.session_id AND s.tenant_id = b.tenant_id
       JOIN garages  g ON g.id = b.garage_id  AND g.tenant_id = b.tenant_id
       JOIN vehicles v ON v.id = s.vehicle_id AND v.tenant_id = s.tenant_id
      WHERE b.tenant_id = $1
        AND (b.garage_id = $2 OR g.ban_reach = 'all')
      ORDER BY b.listed_at DESC, b.id`,
    [tenantId, garageId],
  );
  return {
    ban_tailgaters: garage[0].ban_tailgaters,
    ban_reach: garage[0].ban_reach,
    cars: cars.map((c) => ({
      id: c.id,
      listed_at: c.listed_at,
      entry_at: c.entry_at,
      garage_id: c.garage_id,
      garage_name: c.garage_name,
      plate: c.plate,
      pictures: c.pictures,
    })),
  };
}

/** One ban that reaches this garage; null if there is none. */
export async function reaching(client, tenantId, garageId, banId) {
  const { rows } = await client.query(
    `SELECT b.id, b.garage_id, g.name AS garage_name ${REACHING} AND b.id = $3`,
    [tenantId, garageId, banId],
  );
  return rows[0] ?? null;
}

/**
 * Take a car off the list. Its stay and pictures then age out as any other's.
 * False when another request took it off first.
 */
export async function remove(client, tenantId, banId) {
  const { rowCount } = await client.query('DELETE FROM banned_vehicles WHERE tenant_id = $1 AND id = $2', [tenantId, banId]);
  return rowCount === 1;
}

/** One picture of a ban that reaches this garage; null if it is not one. */
export async function pictureOfBan(client, tenantId, garageId, banId, pictureId) {
  const { rows } = await client.query(
    `SELECT p.content_type, p.image
       FROM banned_vehicles b
       JOIN sessions s       ON s.id = b.session_id AND s.tenant_id = b.tenant_id
       JOIN garages  g       ON g.id = b.garage_id  AND g.tenant_id = b.tenant_id
       JOIN entry_pictures p ON p.event_id = s.open_event_id AND p.tenant_id = s.tenant_id
      WHERE b.tenant_id = $1
        AND (b.garage_id = $2 OR g.ban_reach = 'all')
        AND b.id = $3
        AND p.id = $4`,
    [tenantId, garageId, banId, pictureId],
  );
  return rows[0] ?? null;
}

/**
 * Remove the pictures whose week is over: one week after the stay that holds
 * them closed, or one week after they were taken when no stay holds them. A
 * stay still open keeps its pictures, and so does a stay on the list.
 */
export async function removeExpiredPictures(client, tenantId, { now = null } = {}) {
  const { rowCount } = await client.query(
    `DELETE FROM entry_pictures p
      WHERE p.tenant_id = $1
        AND NOT EXISTS (
              SELECT 1 FROM banned_vehicles b JOIN sessions s ON s.id = b.session_id
               WHERE s.tenant_id = p.tenant_id AND s.open_event_id = p.event_id)
        AND CASE
              WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.tenant_id = p.tenant_id AND s.open_event_id = p.event_id)
              THEN EXISTS (SELECT 1 FROM sessions s
                            WHERE s.tenant_id = p.tenant_id AND s.open_event_id = p.event_id
                              AND s.exit_at IS NOT NULL
                              AND s.exit_at < COALESCE($2::timestamptz, now()) - make_interval(days => $3))
              ELSE p.taken_at < COALESCE($2::timestamptz, now()) - make_interval(days => $3)
            END`,
    [tenantId, now, PICTURE_DAYS],
  );
  return rowCount;
}
