import express from 'express';
import { pool, withTenant } from './db.js';
import { bearerFrom, generateDeviceToken, hashToken } from './auth.js';
import { computeFee } from './fees.js';
import { toMinor } from './money.js';
import * as repo from './repository.js';
import { reconcile } from './reconcile.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);

/**
 * What a lane does with a confidently-read plate that matches no rule.
 *
 * Only the two values the lane recognises by name. An unrecognised value is not
 * rejected by the lane -- it falls back, which is safe -- but it gets there
 * through an else-branch rather than through anything either side agreed, and
 * this platform does not serve values whose meaning rests on that. Refused
 * here rather than at the database so the operator is told which values exist;
 * the column's CHECK is what makes it true regardless of route.
 */
const DEFAULT_ACTIONS = ['allow', 'deny'];

/**
 * What a lane is allowed to say confirmed an entry or an exit.
 *
 * `confirmed` means two loops after the barrier saw a vehicle cross them
 * forward inside the confirmation window. `unconfirmable` means the lane has no
 * closing loops installed, so nothing could have confirmed or refuted it — a
 * weaker lane, saying so on every session it opens.
 *
 * `opened_on_vend` and `closed_on_vend` are NOT here. They are what migration
 * 0005 backfilled onto rows written before any of this existed, and a lane that
 * presented one would be claiming a history it does not have. The column's
 * CHECK permits them because the old rows carry them; this list is what a
 * REQUEST may say, and the two are deliberately different sets.
 */
const CONFIRMATIONS = ['confirmed', 'unconfirmable'];

/**
 * And what a lane may say about an EXIT, which is the same list plus one.
 *
 * `held` is an exit the loops did not confirm. It closes and bills anyway,
 * because the exit vend is the payment moment and the barrier opened — the car
 * is gone whatever the loops saw, and holding the session open would leave the
 * stay unbilled and the vehicle inside for ever. It is a flag for a human, not
 * a hole in the ledger, and the `exit_held` lane event sits beside it.
 *
 * There is deliberately NO entry equivalent. An entry nothing confirmed is not
 * a session at all — no row, no occupancy, no money — so `held` on an open is
 * refused, and a test asserts each side of that separately.
 */
const EXIT_CONFIRMATIONS = [...CONFIRMATIONS, 'held'];

/**
 * The event kinds a lane reports, and it is the whole set it can produce.
 *
 * `POST /lane/events` used to take any string. A device token then bought an
 * `events` table filled with kinds no lane emits -- fabricated evidence sitting
 * beside the real record, and `reconcile.js` counts three of these kinds, so a
 * log it cannot trust is a reconciliation it cannot trust.
 *
 * DERIVED FROM THE LANE, NOT INVENTED HERE: every string below is a name in
 * `lane-controller`, taken from the constants in `sync.py` and the literals
 * passed to `events.record()`. `session_open` and `session_close` are
 * deliberately ABSENT -- the lane's transport routes those two to
 * `/sessions/open` and `/sessions/close` and never to this endpoint, so one
 * arriving here is a lane that has lost its routing, and refusing it is the
 * loud answer.
 *
 * THIS IS A SECOND COPY OF A SET THAT LIVES IN ANOTHER REPOSITORY, and there is
 * nothing in either repository's CI that compares them. A lane build that adds
 * a kind and deploys before this list does is refused 400 by an endpoint that
 * used to take anything. Stated here because it is the shape of the ordering
 * hazard the vehicle-id pin check exists for, and this one has no check yet.
 */
const LANE_EVENT_KINDS = [
  'armed',
  'arming_incomplete',
  'arming_rejected',
  'decision',
  'entry_backed_out',
  'entry_confirmed',
  'entry_held',
  'entry_pending',
  'entry_unconfirmable',
  'exit_backed_in',
  'exit_confirmed',
  'exit_held',
  'exit_pending',
  'exit_unconfirmable',
  'fallback_needs_human',
  'frames_captured',
  'vehicle_identified',
  'vended',
];

/**
 * What a session open or close SAYS saw the car, and it is required — never
 * defaulted.
 *
 * A default here would be a second copy of a claim about whether anything saw
 * the car, sitting where nobody looks, and the copy is always the one that
 * lies. An old lane build that does not send the field gets a 400 saying which
 * values exist, which is a deployment being told to catch up rather than a
 * money record quietly filling with a value nobody asserted.
 */
function confirmation(value, label, allowed = CONFIRMATIONS) {
  if (!allowed.includes(value)) {
    throw bad(`${label} is required and must be one of ${allowed.join(', ')}`);
  }
  return value;
}

/**
 * What a lane may call an event, and it is refused rather than stored.
 *
 * Same shape as `confirmation()` above and for the same reason: the route is
 * where the sender is told which values exist. The kind is NAMED in the
 * refusal, because a lane build ahead of this one needs to see which of its
 * kinds this platform does not know.
 */
function eventKind(value) {
  if (!LANE_EVENT_KINDS.includes(value)) {
    throw bad(
      `kind ${JSON.stringify(value)} is not one a lane reports; it must be one of ` +
        LANE_EVENT_KINDS.join(', '),
    );
  }
  return value;
}

function defaultAction(value, { required }) {
  if (value === undefined || value === null) {
    if (required) throw bad(`default_action is required and must be one of ${DEFAULT_ACTIONS.join(', ')}`);
    return undefined;
  }
  if (!DEFAULT_ACTIONS.includes(value)) {
    throw bad(`default_action must be one of ${DEFAULT_ACTIONS.join(', ')}`);
  }
  return value;
}

function parseTime(value, label) {
  if (!value) throw bad(`${label} is required`);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw bad(`${label} is not a valid timestamp`);
  return at;
}

/**
 * How far ahead of this server's clock a lane-supplied time may be, in seconds.
 *
 * Times come from the LANE and that is a decision with a reason: the car may
 * have arrived while the lane had no network, so a time in the PAST is
 * legitimate and is not bounded anywhere. A time in the FUTURE is a different
 * claim -- that something has happened which has not -- and no decision covered
 * it. Unbounded, an `exit_at` a lane can name freezes a fee for a stay nobody
 * has had yet.
 *
 * The tolerance is for CLOCK DRIFT between a lane device and this server and
 * for nothing else: comfortably more than NTP leaves on a device that is
 * working, and far below any interval that could be billed. It is a DECISION,
 * not a measurement of anything.
 *
 * Read once, at load, and a value that is not a number is refused HERE rather
 * than becoming a NaN comparison that is false for every input -- which is this
 * bound silently absent, on a process that started cleanly.
 */
const MAX_CLOCK_SKEW_SECONDS = (() => {
  const raw = process.env.MAX_CLOCK_SKEW_SECONDS;
  if (raw === undefined || raw === '') return 120;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `MAX_CLOCK_SKEW_SECONDS must be a non-negative number of seconds, not ${JSON.stringify(raw)}`,
    );
  }
  return value;
})();

/**
 * Refuse a lane time that has not happened yet.
 *
 * 409 and not 400, for the reason the stale exit is a 409: the lane classifies
 * 5xx as retryable and re-sends forever with its whole outbox stuck behind it,
 * while a 4xx is terminal -- dead-lettered, counted and logged at error. One
 * function for both ends of a stay, because two copies of this rule would be
 * two claims about the same thing and the copy is the one that goes wrong.
 *
 * The message carries how far ahead the time was and how far ahead is
 * tolerated, both derived, so the operator reading the lane's error log does
 * not have to find this constant to know what happened.
 */
function refuseFuture(at, label, now = new Date()) {
  const ahead = (at.getTime() - now.getTime()) / 1000;
  if (ahead > MAX_CLOCK_SKEW_SECONDS) {
    throw new HttpError(
      409,
      `${label} is ${Math.round(ahead)}s ahead of this server's clock, more than the ` +
        `${MAX_CLOCK_SKEW_SECONDS}s of drift tolerated — a time in the future is not a stay ` +
        'that has happened',
    );
  }
  return at;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // -------------------------------------------------------------------------
  // Operator surface.
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
      // Optional. A garage that says nothing gets the column default, which is
      // the value this platform has always served.
      const action = defaultAction(req.body?.default_action, { required: false });
      const garage = await withTenant(req.tenantId, async (client) => {
        // The column is left out entirely when nothing was asked for, so the
        // value an unconfigured garage gets is written down in exactly one
        // place -- the column default in 0004. Naming it here too would be a
        // second copy of the same claim, and the two would drift.
        const { rows } =
          action === undefined
            ? await client.query(
                `INSERT INTO garages (tenant_id, name, timezone, currency)
                 VALUES ($1,$2,$3,$4) RETURNING *`,
                [req.tenantId, name, timezone, currency],
              )
            : await client.query(
                `INSERT INTO garages (tenant_id, name, timezone, currency, default_action)
                 VALUES ($1,$2,$3,$4,$5) RETURNING *`,
                [req.tenantId, name, timezone, currency, action],
              );
        return rows[0];
      });
      res.status(201).json({ garage });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Change what an existing garage does with an unknown plate.
   *
   * Creation-time only would have left every garage that already exists unable
   * to be strict, which is the whole of what was wrong. It takes this one
   * field and nothing else: a garage's timezone and currency are frozen onto
   * sessions and money and are not a thing to edit in passing.
   */
  operator.patch('/garages/:garageId', async (req, res, next) => {
    try {
      const action = defaultAction(req.body?.default_action, { required: true });
      const garage = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `UPDATE garages SET default_action = $3
            WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          [req.tenantId, req.params.garageId, action],
        );
        return rows[0];
      });
      if (!garage) throw new HttpError(404, 'garage not found');
      res.json({ garage });
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

  /**
   * Revoke a device token.
   *
   * A device token is a lane's identity: it resolves server-side to one lane,
   * one direction, one garage, one tenant, and the platform records what the
   * holder reports. A token that leaks is therefore a lane that leaked, and
   * until this route existed there was no way for an operator to end that.
   * Setting the garage to `deny` does not: it stops vends, while
   * `/lane/sessions/open` and `/lane/sessions/close` stay fully usable by the
   * stolen token. The only remaining move was an UPDATE against the production
   * database by hand.
   *
   * `revoked_at` and the filter that reads it are not new -- they have been in
   * `lane_devices` and in `resolve_lane_device` since 0002. What was missing
   * was anything that sets the column.
   *
   * `coalesce` rather than a plain assignment: revoking twice is not an error,
   * and the first revocation is when the credential stopped being trusted. A
   * second call must not move that moment. There is no route back: a revoked
   * device is issued again, not un-revoked, so a mistake costs an issuance and
   * never quietly restores a credential somebody else may be holding.
   */
  operator.post('/devices/:deviceId/revoke', async (req, res, next) => {
    try {
      const device = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `UPDATE lane_devices SET revoked_at = coalesce(revoked_at, now())
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, lane_id, name, created_at, revoked_at`,
          [req.tenantId, req.params.deviceId],
        );
        return rows[0];
      });
      // Another tenant's device is not found rather than forbidden, which is
      // what row-level security makes it: the row is not visible to ask about.
      if (!device) throw new HttpError(404, 'device not found');
      res.json({ device });
    } catch (err) {
      next(err);
    }
  });

  /**
   * What this garage believes is inside, and on what evidence.
   *
   * `inside_count` counts CONFIRMED sessions only — the ones where two loops
   * after the barrier saw a vehicle cross them. That is a change in what the
   * number means, and it is the point: it used to count every vend, so a driver
   * who took a ticket and drove away was counted as inside forever, and a
   * garage filled up on paper before it filled in concrete.
   *
   * The rest are not hidden, which would be the same defect in the other
   * direction — a real car in an unconfirmable lane is still a real car.
   * `unconfirmable_count` and `open_count` are returned beside it, so a
   * consumer can see the whole of what is open and what is behind each part.
   */
  operator.get('/garages/:garageId/sessions/open', async (req, res, next) => {
    try {
      const sessions = await withTenant(req.tenantId, (client) =>
        repo.openSessionsForGarage(client, req.tenantId, req.params.garageId),
      );
      const confirmed = sessions.filter((s) => s.entry_confirmation === 'confirmed');
      res.json({
        inside_count: confirmed.length,
        unconfirmable_count: sessions.length - confirmed.length,
        open_count: sessions.length,
        sessions,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Reconciliation. Counts that should agree, reported when they do not.
   *
   * Read-only and correcting nothing, deliberately: an auto-correcting
   * reconciler on a money record destroys the evidence of the thing it was
   * meant to detect.
   */
  operator.get('/garages/:garageId/reconciliation', async (req, res, next) => {
    try {
      const hours = clampWindow(req.query.hours, 24);
      const maxHours = statedWindow(req.query.max_stay_hours, 'max_stay_hours');
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const report = await withTenant(req.tenantId, (client) =>
        reconcile(client, req.tenantId, req.params.garageId, { since, maxHours }),
      );
      res.json(report);
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
        //
        // The garage's own value, not a literal. It was a literal until 0004,
        // which meant a garage that wanted the strict behaviour could not have
        // it -- the lane supports 'deny' and always has, and nothing could
        // reach it. A garage that has set nothing still gets 'allow'.
        default_action: payload.garage.default_action,
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
          kind: eventKind(e.kind),
          // The same bound as an entry_at and an exit_at, on the third
          // lane-supplied time. A future-dated event satisfies every window a
          // reconciliation report will ever ask for and nothing removes it, so
          // one batch makes the surface that exists to show a lane being worked
          // permanently deaf.
          occurredAt: refuseFuture(parseTime(e.occurred_at, 'occurred_at'), 'occurred_at'),
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
      const entryConfirmation = confirmation(req.body?.entry_confirmation, 'entry_confirmation');
      // Required, not optional. Without it there is no key to be idempotent on
      // and the only thing left to check is state -- which is exactly how a
      // replay arriving after the car has left opens a second, phantom session.
      if (!openEventId) throw bad('event_id is required');
      const entryAt = refuseFuture(parseTime(req.body?.entry_at, 'entry_at'), 'entry_at');

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
          entryConfirmation,
        });
      });

      // The row that was written, echoed whole -- `entry_confirmation` with it.
      // A LANE DEPENDS ON THAT FIELD BEING HERE: a platform that predates the
      // column answers this call exactly as successfully and hands back a
      // session without it, so the lane treats an open that does not come back
      // carrying the value it sent as not delivered, and says so. Dropping the
      // field from this response would be indistinguishable, to a lane, from
      // deploying against a platform that cannot record it.
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
      const exitConfirmation = confirmation(
        req.body?.exit_confirmation,
        'exit_confirmation',
        EXIT_CONFIRMATIONS,
      );
      const exitAt = refuseFuture(parseTime(req.body?.exit_at, 'exit_at'), 'exit_at');

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
          exitConfirmation,
        });
        return { session: closed, closed: true, replay: false };
      });

      res.status(200).json({ session: presentSession(out.session), closed: out.closed, replay: out.replay });
    } catch (err) {
      next(err);
    }
  });

  // Order matters and is load-bearing. '/api/v1' is a prefix of '/api/v1/lane',
  // so the operator router must be mounted AFTER the lane router. Mounted first
  // it answers every lane request 401 before the device router runs. The test
  // 'a lane call with no token is refused BY THE LANE ROUTER' asserts the
  // message, not just the status, because both orderings return 401.
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

export { pool, LANE_EVENT_KINDS };

/**
 * A window the caller asked for, bounded.
 *
 * Unbounded, `?hours=1000000` is a full table scan somebody can ask for from
 * outside. Rejecting it outright would be unhelpful for a caller who simply
 * wants "everything"; clamping gives them the most this will do and says so by
 * echoing the value back in the report.
 */
function clampWindow(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), 24 * 90);
}

/**
 * A window the caller must state, because nothing here can produce it.
 *
 * `max_stay_hours` had a typed default of 48. Nothing measured that number and
 * no command emits it, yet it decided which open sessions an operator was
 * shown -- a garage worked for six hours reads as clean under it. There is no
 * honest replacement, so there is no default: the caller says how long is too
 * long for the garage they are asking about, or is told which parameter is
 * missing. The clamp stays where it is, in one place.
 */
function statedWindow(raw, label) {
  const value = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(value) || value <= 0) {
    throw bad(
      `${label} is required and must be a positive number of hours; this report has no default`,
    );
  }
  return clampWindow(raw, null);
}
