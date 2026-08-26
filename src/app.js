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

  /**
   * Authenticated by an operator token, and the tenant comes FROM the token.
   *
   * This used to trust an `x-tenant-id` header. Anyone who could reach the API
   * could then act as any tenant whose id they knew -- including minting lane
   * credentials for it, which is a route into that tenant's whole estate. The
   * header is no longer read anywhere.
   *
   * Same bootstrap problem as lane devices, same answer: resolve_operator_token
   * is SECURITY DEFINER because the tenant is what the lookup is for.
   */
  operator.use(async (req, _res, next) => {
    try {
      const token = bearerFrom(req.get('authorization'));
      if (!token) throw new HttpError(401, 'operator token required');
      const { rows } = await pool.query('SELECT * FROM resolve_operator_token($1)', [hashToken(token)]);
      if (rows.length === 0) throw new HttpError(401, 'unknown or revoked operator token');
      req.tenantId = rows[0].tenant_id;
      req.operatorTokenId = rows[0].token_id;
      pool.query('SELECT touch_operator_token($1)', [req.operatorTokenId]).catch(() => {});
      next();
    } catch (err) {
      next(err);
    }
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
   * What is currently open for this plate, so the exit lane can name the
   * session it is closing rather than leaving the platform to guess from a
   * plate. Best effort: an offline lane simply closes without it.
   */
  lane.get('/sessions/open', async (req, res, next) => {
    try {
      const { tenantId, garageId } = req.device;
      const plate = req.query?.plate;
      if (!plate) throw bad('plate is required');
      const session = await withTenant(tenantId, (client) =>
        repo.findOpenSessionByPlate(client, tenantId, garageId, String(plate)),
      );
      if (!session) throw new HttpError(404, 'no open session for this vehicle');
      res.json({ session: presentSession(session) });
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
      const {
        plate,
        plate_region: plateRegion = null,
        event_id: openEventId,
        make = null,
        model = null,
        color = null,
        attributes = null,
      } = req.body ?? {};
      if (!plate) throw bad('plate is required');
      // Required, not optional. Without it there is no key to be idempotent on
      // and the only thing left to check is state -- which is exactly how a
      // replay arriving after the car has left opens a second, phantom session.
      if (!openEventId) throw bad('event_id is required');
      const entryAt = parseTime(req.body?.entry_at, 'entry_at');

      const result = await withTenant(tenantId, async (client) => {
        const garage = await repo.getGarage(client, tenantId, garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        const vehicle = await repo.upsertVehicle(client, tenantId, {
          plate, plateRegion, seenAt: entryAt, make, model, color, attributes,
        });
        return repo.openSession(client, tenantId, {
          garageId,
          vehicleId: vehicle.id,
          laneId,
          entryAt,
          currency: garage.currency,
          openEventId: String(openEventId),
        });
      });

      res.status(result.created ? 201 : 200).json({
        session: presentSession(result.session),
        created: result.created,
      });
    } catch (err) {
      if (err.code === 'EVENT_ID_VEHICLE_CONFLICT') {
        return next(new HttpError(409, 'event_id already used for a different vehicle'));
      }
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
      const { plate, event_id: closeEventId, session_id: sessionId = null } = req.body ?? {};
      if (!plate) throw bad('plate is required');
      if (!closeEventId) throw bad('event_id is required');
      const exitAt = parseTime(req.body?.exit_at, 'exit_at');

      const out = await withTenant(tenantId, async (client) => {
        // Keyed on the event first, so a replay returns the very session this
        // exact exit closed -- not "the most recent closed one", which is a
        // guess that goes wrong the moment a vehicle visits twice.
        const already = await repo.findSessionByCloseEvent(client, tenantId, String(closeEventId));
        if (already) return { session: already, closed: false, replay: true };

        const vehicle = await repo.upsertVehicle(client, tenantId, { plate, seenAt: exitAt });

        // When the lane names the session, that is the session -- no guessing
        // from a plate, so a stale exit from an earlier visit can never land on
        // a later one. When it does not (it was offline at the exit), fall back
        // to the plate with the ordering guard below.
        const open = sessionId
          ? await repo.findOpenSessionById(client, tenantId, garageId, sessionId)
          : await repo.findOpenSession(client, tenantId, garageId, vehicle.id);

        if (!open) {
          throw new HttpError(
            404,
            sessionId
              ? 'the named session is not open in this garage'
              : 'no open session for this vehicle',
          );
        }
        if (sessionId && open.vehicle_id !== vehicle.id) {
          throw new HttpError(409, 'the named session belongs to a different vehicle');
        }

        if (exitAt < open.entry_at) {
          // A stale exit from an earlier visit, arriving after the vehicle has
          // come back. Closing this session with that timestamp would violate
          // sessions_exit_after_entry and surface as a 500 -- which the lane
          // classifies as RETRYABLE and would then re-send forever, jamming
          // everything behind it in its outbox. 409 is terminal: the lane
          // dead-letters it, counts it, and moves on.
          throw new HttpError(
            409,
            'exit precedes the entry of the open session — stale exit from an earlier visit',
          );
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
          closeEventId: String(closeEventId),
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
