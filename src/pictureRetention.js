/**
 * PICTURE RETENTION, the scheduled job (scripts/purge-pictures.js; the
 * retention purge runs it too).
 *
 * A lane's pictures (0033) and a walk's (0040) are removed PICTURE_DAYS (30)
 * after they were taken. A stay keeps the pictures it holds -- the lane's of
 * its entry, and the walk's a finished walk listed as seeing it -- while the
 * car is inside, then for 30 days after it left, and for as long as its
 * customer has paid picture storage (`pictures_paid_until`, 0041). A car on
 * the banned list keeps its lane pictures. The rules themselves are in
 * src/bans.js and src/walks.js.
 *
 * ONE TENANT AT A TIME. Each tenant's pass is its own transaction under that
 * tenant's row security, so it reads and removes that tenant's pictures and
 * stays only; a stay of another tenant never keeps or lets go of a picture.
 *
 * COUNTS ONLY. What the job says is how many tenants it went through and how
 * many pictures it removed: never a tenant, a stay, a plate or a picture.
 */
import { withTenant } from './db.js';
import * as bans from './bans.js';
import * as walks from './walks.js';

/** One tenant's pass: the lane and walk pictures removed at `now`. */
export async function removeExpiredPictures(tenantId, { now = null } = {}) {
  return withTenant(tenantId, async (client) => ({
    lane: await bans.removeExpiredPictures(client, tenantId, { now }),
    walk: await walks.removeExpiredPictures(client, tenantId, { now }),
  }));
}

/** Every tenant in `tenantIds`, one pass each, and the counts. */
export async function runPictureRetention(tenantIds, { now = null } = {}) {
  const total = { tenants: 0, lane: 0, walk: 0 };
  for (const tenantId of tenantIds) {
    const removed = await removeExpiredPictures(tenantId, { now });
    total.tenants += 1;
    total.lane += removed.lane;
    total.walk += removed.walk;
  }
  return total;
}

/** The job's one line. */
export const summary = (total) =>
  `pictures: ${total.tenants} tenant(s); removed ${total.lane} lane picture(s) and ${total.walk} walk picture(s).`;
