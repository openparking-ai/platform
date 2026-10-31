/**
 * A permission on every operator route (README, "Permissions: one on every
 * operator route").
 *
 * THE LIST IS THIS PLATFORM'S OWN, each name a `read` or a `change`, and
 * `change` includes `read`. The admin and every operator key hold all of them
 * at every garage, so nothing either did before changes. A person from a
 * linked accounts module (src/linkedAccounts.js) holds what the module said,
 * at the garages it said.
 *
 * EVERY ROUTE NAMES EXACTLY ONE, as its first handler: `permit('lanes:change')`.
 * test/permissions.test.js walks the operator router and fails on a route that
 * names none, or one that is not in the list.
 *
 * A ROUTE ABOUT A GARAGE -- its id in the path, or a lane or a computer of it --
 * also checks that garage is in the session's list. One that is not answers
 * what an id naming nothing answers on that route, so the list never says what
 * lies outside it. The lookup runs inside the caller's tenant: another tenant's
 * lane is not found here either.
 */
import { withTenant } from './db.js';
import { HttpError } from './errors.js';

export const PERMISSIONS = Object.freeze([
  'garages', 'rates', 'lanes', 'payments', 'money', 'refunds', 'payouts', 'account', 'inventory', 'stays', 'log',
]);

//: Every permission there is: each name, read and change.
export const ALL = Object.freeze(PERMISSIONS.flatMap((p) => [`${p}:read`, `${p}:change`]));

//: What the admin and an operator key hold.
export const EVERYTHING = Object.freeze({ permissions: ALL, garages: 'all' });

export const PERMISSION_REFUSED = Object.freeze({ error: 'Your account does not allow this.', code: 'permission_refused' });

export const isPermission = (name) => typeof name === 'string' && ALL.includes(name);

/** Whether `permissions` covers `wanted`: held as it is, or a read covered by its change. */
export function holds(permissions, wanted) {
  if (permissions.includes(wanted)) return true;
  return wanted.endsWith(':read') && permissions.includes(`${wanted.slice(0, -':read'.length)}:change`);
}

/** Whether a session's garages reach `garageId`. */
export const reaches = (access, garageId) => access.garages === 'all' || access.garages.includes(garageId);

/**
 * The garage a route's path is about, read inside the tenant: its id, or a
 * lane's or a computer's garage. `undefined` when the path names none of
 * them; `null` when it names one that is not there.
 */
async function garageOfPath(req) {
  const { garageId, laneId, deviceId } = req.params ?? {};
  if (garageId) return garageId;
  if (laneId) {
    return withTenant(req.tenantId, async (c) =>
      (await c.query('SELECT garage_id FROM lanes WHERE tenant_id = $1 AND id = $2', [req.tenantId, laneId])).rows[0]?.garage_id ?? null);
  }
  if (deviceId) {
    return withTenant(req.tenantId, async (c) => (await c.query(
      `SELECT l.garage_id FROM lane_devices d JOIN lanes l ON l.id = d.lane_id AND l.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1 AND d.id = $2`, [req.tenantId, deviceId])).rows[0]?.garage_id ?? null);
  }
  return undefined;
}

/**
 * The route's one permission, as its first handler. `notFound` answers what
 * the route answers for an id naming nothing (src/app.js's ID_PARAMS);
 * `everyGarage` is for a route only a session over every garage may use.
 */
export function permit(permission, { notFound, everyGarage = false } = {}) {
  if (!isPermission(permission)) throw new Error(`a route names a permission that is not in the list: ${JSON.stringify(permission)}`);
  const check = async (req, _res, next) => {
    try {
      const access = req.access;
      if (!access || !holds(access.permissions, permission)) {
        throw new HttpError(403, PERMISSION_REFUSED.error, PERMISSION_REFUSED.code);
      }
      if (access.garages !== 'all') {
        if (everyGarage) throw new HttpError(403, PERMISSION_REFUSED.error, PERMISSION_REFUSED.code);
        const garage = await garageOfPath(req);
        if (garage !== undefined && (garage === null || !reaches(access, garage))) {
          const which = req.params.garageId ? 'garageId' : req.params.laneId ? 'laneId' : 'deviceId';
          throw notFound ? notFound(which, req.route.path) : new HttpError(404, 'not found');
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
  check.permission = permission;
  return check;
}
