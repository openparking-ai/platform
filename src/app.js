import express from 'express';
import { pool, withTenant } from './db.js';
import { bearerFrom, generateDeviceToken, hashToken } from './auth.js';
import { computeFee } from './fees.js';
import { toMinor } from './money.js';
import * as repo from './repository.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);

function parseTime(value, label) {
  if (!value) throw bad(`${label} is required`);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw bad(`${label} is not a valid timestamp`);
  return at;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // -------------------------------------------------------------------------
  // Operator surface.
  //
  // Tenant comes from a header. This is a PLACEHOLDER for real operator
  // authentication and is the only thing here that is not production shaped;
  // whatever replaces it must set req.tenantId and nothing downstream changes.
  // -------------------------------------------------------------------------
  const operator = express.Router();
  operator.use((req, _res, next) => {
    const tenantId = req.get('x-tenant-id');
    if (!tenantId) return next(new HttpError(401, 'tenant context required'));
    req.tenantId = tenantId;
    next();
  });

  operator.post('/garages', async (req, res, next) => {
    try {
      const { name, timezone, currency } = req.body ?? {};
      if (!name || !timezone || !currency) throw bad('name, timezone and currency are required');
      const garage = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1,$2,$3,$4) RETURNING *`,
          [req.tenantId, name, timezone, currency],
        );
        return rows[0];
      });
      res.status(201).json({ garage });
    } catch (err) {
      next(err);
    }
  });

  operator.post('/garages/:garageId/lanes', async (req, res, next) => {
    try {
      const { name, direction } = req.body ?? {};
      if (!name || !['entry', 'exit'].includes(direction)) {
        throw bad("name and direction ('entry' or 'exit') are required");
      }
      const lane = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING *`,
          [req.tenantId, req.params.garageId, name, direction],
        );
        return rows[0];
      });
      res.status(201).json({ lane });
    } catch (err) {
      next(err);
    }
  });

  operator.post('/garages/:garageId/rates', async (req, res, next) => {
    try {
      const { name, hourly_minor: hourlyMinor } = req.body ?? {};
      if (!name || hourlyMinor === undefined) throw bad('name and hourly_minor are required');
      const value = toMinor(hourlyMinor, 'hourly_minor');
      const rate = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO rates (tenant_id, garage_id, name, hourly_minor) VALUES ($1,$2,$3,$4) RETURNING *`,
          [req.tenantId, req.params.garageId, name, value],
        );
        return rows[0];
      });
      res.status(201).json({ rate: { ...rate, hourly_minor: toMinor(rate.hourly_minor) } });
    } catch (err) {
      next(err);
    }
  });

  operator.post('/lanes/:laneId/devices', async (req, res, next) => {
    try {
      const { name } = req.body ?? {};
      if (!name) throw bad('name is required');
      // Generated here, hashed before it touches the database, and returned
      // exactly once. There is no endpoint that can show it again.
      const token = generateDeviceToken();
      const device = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)
           RETURNING id, lane_id, name, created_at`,
          [req.tenantId, req.params.laneId, name, hashToken(token)],
        );
        return rows[0];
      });
      res.status(201).json({ device, token, token_note: 'shown once; it is not recoverable' });
    } catch (err) {
      next(err);
    }
  });

  operator.get('/garages/:garageId/sessions/open', async (req, res, next) => {
    try {
      const sessions = await withTenant(req.tenantId, (client) =>
        repo.openSessionsForGarage(client, req.tenantId, req.params.garageId),
      );
      // The inside-count the occupancy module will want later, for free.
      res.json({ inside_count: sessions.length, sessions });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Lane surface. Authenticated by device token.
  // -------------------------------------------------------------------------
  const lane = express.Router();

  lane.use(async (req, _res, next) => {
    try {
      const token = bearerFrom(req.get('authorization'));
      if (!token) throw new HttpError(401, 'device token required');

      // The bootstrap problem: we do not yet know which tenant this token
      // belongs to, so this lookup cannot run under a tenant policy. It goes
      // through resolve_lane_device(), which is SECURITY DEFINER for exactly
      // that reason. See migration 0002.
      const { rows } = await pool.query('SELECT * FROM resolve_lane_device($1)', [hashToken(token)]);
      if (rows.length === 0) throw new HttpError(401, 'unknown or revoked device token');

      req.device = {
        deviceId: rows[0].device_id,
        tenantId: rows[0].tenant_id,
        laneId: rows[0].lane_id,
        garageId: rows[0].garage_id,
        direction: rows[0].direction,
      };
      pool.query('SELECT touch_lane_device($1)', [req.device.deviceId]).catch(() => {});
      next();
    } catch (err) {
      next(err);
    }
  });

  /** What the lane caches so it can decide with the network down. */
  lane.get('/rules', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      const payload = await withTenant(tenantId, async (client) => {
        const garage = await repo.getGarage(client, tenantId, garageId);
        const rate = await repo.currentRate(client, tenantId, garageId);
        return { garage, rate };
      });
      if (!payload.garage) throw new HttpError(404, 'garage not found');
      res.json({
        garage_id: garageId,
        lane_id: laneId,
        direction,
        timezone: payload.garage.timezone,
        currency: payload.garage.currency,
        // One simple hourly rate per garage, as specified. A lane with no rate
        // configured gets null and must fall back rather than invent one.
        hourly_minor: payload.rate ? payload.rate.hourlyMinor : null,
        rate_id: payload.rate ? payload.rate.id : null,
        // No per-plate rules exist yet, so the lane's default action governs.
        // The lane already supports per-plate rules; the platform has nothing
        // to put in them until an access-list module exists.
        default_action: 'allow',
        plate_rules: [],
        synced_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Append lane events. Idempotent on (tenant, event_id).
   *
   * A lane that has been offline re-sends whatever it could not confirm, so
   * this endpoint receives duplicates as a matter of course, not as an error.
   */
  lane.post('/events', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId } = req.device;
      const incoming = Array.isArray(req.body?.events) ? req.body.events : null;
      if (!incoming) throw bad('events[] is required');
      const events = incoming.map((e) => {
        if (!e.event_id) throw bad('every event needs an event_id');
        if (!e.kind) throw bad('every event needs a kind');
        return {
          garageId,
          laneId,
          eventId: String(e.event_id),
          kind: String(e.kind),
          occurredAt: parseTime(e.occurred_at, 'occurred_at'),
          detail: e.detail ?? {},
        };
      });
      const result = await withTenant(tenantId, (client) => repo.appendEvents(client, tenantId, events));
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Entry. Idempotent: replaying it returns the session already open.
   *
   * entry_at comes from the LANE, not from the server clock, because the lane
   * may have been offline when the car actually arrived.
   */
  lane.post('/sessions/open', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      if (direction !== 'entry') throw new HttpError(409, 'this device is not on an entry lane');
      const { plate, plate_region: plateRegion = null } = req.body ?? {};
      if (!plate) throw bad('plate is required');
      const entryAt = parseTime(req.body?.entry_at, 'entry_at');

      const result = await withTenant(tenantId, async (client) => {
        const garage = await repo.getGarage(client, tenantId, garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        const vehicle = await repo.upsertVehicle(client, tenantId, { plate, plateRegion, seenAt: entryAt });
        return repo.openSession(client, tenantId, {
          garageId,
          vehicleId: vehicle.id,
          laneId,
          entryAt,
          currency: garage.currency,
        });
      });

      res.status(result.created ? 201 : 200).json({
        session: presentSession(result.session),
        created: result.created,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Exit. Computes the fee and freezes it, along with the rate that produced it.
   * Idempotent: closing an already-closed session returns it unchanged.
   */
  lane.post('/sessions/close', async (req, res, next) => {
    try {
      const { tenantId, garageId, laneId, direction } = req.device;
      if (direction !== 'exit') throw new HttpError(409, 'this device is not on an exit lane');
      const { plate } = req.body ?? {};
      if (!plate) throw bad('plate is required');
      const exitAt = parseTime(req.body?.exit_at, 'exit_at');

      const out = await withTenant(tenantId, async (client) => {
        const vehicle = await repo.upsertVehicle(client, tenantId, { plate, seenAt: exitAt });
        const open = await repo.findOpenSession(client, tenantId, garageId, vehicle.id);

        if (!open) {
          // Either it never entered, or this exit was already processed. Look
          // for the most recent closed session so a replay is idempotent
          // rather than a 404 the lane will retry forever.
          const { rows } = await client.query(
            `SELECT * FROM sessions
              WHERE tenant_id = $1 AND garage_id = $2 AND vehicle_id = $3 AND exit_at IS NOT NULL
              ORDER BY exit_at DESC LIMIT 1`,
            [tenantId, garageId, vehicle.id],
          );
          if (rows[0]) return { session: rows[0], closed: false, replay: true };
          throw new HttpError(404, 'no open session for this vehicle');
        }

        const rate = await repo.currentRate(client, tenantId, garageId);
        if (!rate) throw new HttpError(409, 'garage has no rate configured');

        const { feeMinor } = computeFee({
          entryAt: open.entry_at,
          exitAt,
          hourlyMinor: rate.hourlyMinor,
        });

        const closed = await repo.closeSession(client, tenantId, open.id, {
          exitAt,
          laneId,
          rateId: rate.id,
          hourlyMinor: rate.hourlyMinor,
          feeMinor,
        });
        return { session: closed, closed: true, replay: false };
      });

      res.status(200).json({ session: presentSession(out.session), closed: out.closed, replay: out.replay });
    } catch (err) {
      next(err);
    }
  });

  // Order matters and is load-bearing. '/api/v1' is a prefix of '/api/v1/lane',
  // so the operator router — whose middleware demands an x-tenant-id header —
  // must be mounted AFTER the lane router. Mounted first it answers every lane
  // request with 401 'tenant context required' before the device router runs.
  // The test 'a lane call with no token is refused' asserts the message, not
  // just the status, because both orderings return 401.
  app.use('/api/v1/lane', lane);
  app.use('/api/v1', operator);

  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error('[api]', err);
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
  });

  return app;
}

/** Money leaves the database as a string; it leaves the API as a number. */
function presentSession(s) {
  return {
    ...s,
    hourly_minor_applied: toMinor(s.hourly_minor_applied, 'hourly_minor_applied'),
    fee_minor: toMinor(s.fee_minor, 'fee_minor'),
  };
}

export { pool };
