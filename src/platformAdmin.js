/**
 * THE PLATFORM ADMIN'S DOOR: one read, for the person who runs this platform,
 * of every account's garages, lanes, spaces and cars in and out between two
 * days (migration 0049, `platform_admin_summary`). Names and counts only: no
 * plate, vehicle, picture, person or money is in it.
 *
 *   GET /api/v1/platform-admin/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 *       Authorization: Bearer <the key>
 *     200 { from, to, customers: [{ id, name, createdAt, garages: [{ id, name,
 *           timezone, open, spaces, lanes: [{ id, name, direction, closed }],
 *           carsIn, carsOut }] }] }
 *     400 the days are not two dates, the first first, at most 366 days apart
 *     401 no key, or not the key
 *     429 too many refused keys from this caller
 *     404 the door is off (PLATFORM_ADMIN_KEY_FILE is not set)
 *
 * OFF UNLESS THE DEPLOYMENT NAMES A KEY FILE:
 *   PLATFORM_ADMIN_KEY_FILE  absolute path of the file holding the key, at
 *                            least 32 characters of A-Z a-z 0-9 _ -. Re-read
 *                            on every request, so a changed key needs no
 *                            restart. Unset: every path here is 404, exactly
 *                            as a path that does not exist.
 *
 * The key is compared as a SHA-256 hash in constant time. It is never logged,
 * never echoed and never stored. A refused key is counted per caller address
 * (REFUSED_PER_WINDOW in REFUSED_WINDOW_MINUTES), and past that the caller is
 * answered 429 without the key being read. Every answer is no-store.
 *
 * The deployment's proxy should not pass this path from the internet at all:
 * the page that calls it reaches the platform on the private network.
 */
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { bearerFrom } from './auth.js';
import { query, DatabaseUnavailable, DATABASE_UNAVAILABLE } from './db.js';

export const REFUSED_PER_WINDOW = 10;
export const REFUSED_WINDOW_MINUTES = 15;
export const MAX_DAYS = 366;
const KEY_SHAPE = /^[A-Za-z0-9_-]{32,256}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const NO_KEY = Object.freeze({ error: 'Sign in first.', code: 'platform_admin_key_required' });
const TOO_MANY = Object.freeze({ error: 'Too many tries. Wait a few minutes, then try again.', code: 'too_many_requests' });
const DAYS_REFUSED = Object.freeze({
  error: `Choose a first and a last day, the first first, at most ${MAX_DAYS} days apart.`,
  code: 'days_refused',
});
const NOT_FOUND = Object.freeze({ error: 'Not found.', code: 'not_found' });

/** The door's settings, or `{ on: false }`. A named file that is not absolute refuses to start. */
export function readPlatformAdminSettings(env = process.env) {
  const file = env.PLATFORM_ADMIN_KEY_FILE;
  if (file === undefined || file === '') return { on: false };
  if (!isAbsolute(file)) throw new Error('PLATFORM_ADMIN_KEY_FILE must be an absolute path to the file holding the key');
  return { on: true, keyFile: file };
}

const digest = (value) => createHash('sha256').update(String(value)).digest();

/** The key from its file, or null when it cannot be read or is not of its shape. Never throws. */
function keyFrom(file) {
  try {
    const key = readFileSync(file, 'utf8').trim();
    return KEY_SHAPE.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** A day, `YYYY-MM-DD`, that is a real date; else null. */
export function dayOf(raw) {
  if (typeof raw !== 'string' || !DAY.test(raw)) return null;
  const at = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === raw ? raw : null;
}

const daysApart = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The rows of 0049, one per garage (or one with no garage), as customers with their garages. */
export function customersOf(rows) {
  const byId = new Map();
  for (const r of rows) {
    let c = byId.get(r.tenant_id);
    if (!c) {
      c = { id: r.tenant_id, name: r.tenant_name, createdAt: new Date(r.tenant_created).toISOString(), garages: [] };
      byId.set(r.tenant_id, c);
    }
    if (r.garage_id === null) continue;
    c.garages.push({
      id: r.garage_id,
      name: r.garage_name,
      timezone: r.garage_timezone,
      open: r.garage_open === true,
      spaces: r.garage_spaces ?? null,
      lanes: (r.lanes ?? []).map((l) => ({ id: l.id, name: l.name, direction: l.direction, closed: l.closed === true })),
      carsIn: Number(r.cars_in),
      carsOut: Number(r.cars_out),
    });
  }
  return [...byId.values()];
}

/** The router, mounted at /api/v1/platform-admin. `now` for the refusal counts. */
export function createPlatformAdminRouter({ settings = readPlatformAdminSettings(), now = () => Date.now() } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  if (!settings.on) {
    router.use((_req, res) => res.status(404).json(NOT_FOUND));
    return router;
  }

  // Refused keys per caller address, in a window that starts at the first.
  const refused = new Map();
  const windowMs = REFUSED_WINDOW_MINUTES * 60_000;
  const over = (who) => {
    const r = refused.get(who);
    if (!r) return false;
    if (now() - r.since >= windowMs) {
      refused.delete(who);
      return false;
    }
    return r.count >= REFUSED_PER_WINDOW;
  };
  const refuse = (who) => {
    const r = refused.get(who);
    if (!r || now() - r.since >= windowMs) refused.set(who, { since: now(), count: 1 });
    else r.count += 1;
    if (refused.size > 10_000) refused.clear();
  };

  router.use((req, res, next) => {
    const who = String(req.ip ?? '');
    if (over(who)) return res.status(429).json(TOO_MANY);
    const presented = bearerFrom(req.get('authorization'));
    const key = keyFrom(settings.keyFile);
    const good = presented !== null && key !== null && timingSafeEqual(digest(presented), digest(key));
    if (!good) {
      refuse(who);
      console.warn(`[platform-admin] refused: ${presented === null ? 'no key' : 'not the key'}${key === null ? ' (the key file cannot be read or is not a key)' : ''}`);
      return res.status(401).json(NO_KEY);
    }
    return next();
  });

  router.get('/summary', async (req, res, next) => {
    const from = dayOf(req.query.from);
    const to = dayOf(req.query.to);
    if (from === null || to === null || daysApart(from, to) < 0 || daysApart(from, to) >= MAX_DAYS) {
      return res.status(400).json(DAYS_REFUSED);
    }
    try {
      const { rows } = await query('SELECT * FROM platform_admin_summary($1::date, $2::date)', [from, to]);
      return res.json({ from, to, customers: customersOf(rows) });
    } catch (err) {
      if (err instanceof DatabaseUnavailable) return res.status(503).json(DATABASE_UNAVAILABLE);
      return next(err);
    }
  });

  router.use((_req, res) => res.status(404).json(NOT_FOUND));
  router.use((err, _req, res, _next) => {
    console.error(`[platform-admin] failed (${err?.code ?? err?.name ?? 'Error'})`);
    return res.status(500).json({ error: 'Something went wrong.', code: 'internal' });
  });
  return router;
}
