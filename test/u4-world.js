/**
 * The U4 suites' shared world: the real app on a port, and owners who can be
 * reached both ways the operator surface takes -- a signed-in session (the
 * owner's screens) and an operator key. Each owner is a tenant of its own.
 *
 * Every secret made here -- password, key, session cookie, lane computer code
 * -- is added to `secrets`, so a suite can require that none of them was ever
 * written to the change log or printed.
 */
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { withTenant, createTenant } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { createAdmin } from '../src/adminAccount.js';

export const ADMIN_ORIGIN = 'https://admin.example.test';
export const FOREIGN_ORIGIN = 'https://elsewhere.example.test';
const PASSWORD = 'u4 correct horse battery staple';

export const secrets = new Set([PASSWORD]);

export async function startServer() {
  process.env.ADMIN_ORIGIN = ADMIN_ORIGIN;
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { app, server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function issueKey(tenant, name = 'Front desk key') {
  const key = generateDeviceToken();
  secrets.add(key);
  const { rows } = await withTenant(tenant, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,$2,$3) RETURNING id`, [tenant, name, hashToken(key)]));
  return { key, id: rows[0].id };
}

export async function signIn(base, email) {
  const res = await fetch(`${base}/api/v1/auth/sign-in`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0].split(';')[0];
  secrets.add(cookie.split('=')[1]);
  return cookie;
}

/** A tenant with its admin, signed in, and an operator key. */
export async function owner(base, tag) {
  const tenant = await createTenant(tag);
  const email = `${tag}-${tenant.slice(0, 8)}@example.com`;
  const { id: userId } = await createAdmin({ tenantId: tenant, email, password: PASSWORD });
  const cookie = await signIn(base, email);
  const { key, id: keyId } = await issueKey(tenant);
  return { tenant, email, userId, cookie, key, keyId };
}

/**
 * One request. `as` is the owner; `via` is 'session' (cookie + the admin's
 * Origin, as the screens send it) or 'key'. `origin` overrides the Origin
 * (null sends none).
 */
export async function call(base, method, path, { as, via = 'session', body, origin, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined || raw !== undefined) h['content-type'] = 'application/json';
  if (as && via === 'session') {
    h.cookie = as.cookie;
    const o = origin === undefined ? ADMIN_ORIGIN : origin;
    if (o !== null) h.origin = o;
  } else if (as && via === 'key') {
    h.authorization = `Bearer ${as.key}`;
    if (origin) h.origin = origin;
  } else if (origin) {
    h.origin = origin;
  }
  const res = await fetch(`${base}/api/v1${path}`, {
    method, headers: h, ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

/** A garage made through the route, as an owner makes one. */
export async function newGarage(base, as, body = {}) {
  const r = await call(base, 'POST', '/garages', { as, body: { name: 'Harbor Garage', timezone: 'America/New_York', currency: 'USD', ...body } });
  assert.equal(r.status, 201, r.text);
  return r.json.garage;
}

export async function newLane(base, as, garageId, name, direction) {
  const r = await call(base, 'POST', `/garages/${garageId}/lanes`, { as, body: { name, direction } });
  assert.equal(r.status, 201, r.text);
  return r.json.lane;
}

/** Every change-log line of a tenant, oldest first, read as the application reads it. */
export function linesOf(tenant) {
  return withTenant(tenant, async (c) => (await c.query('SELECT * FROM garage_changes WHERE tenant_id = $1 ORDER BY at, id', [tenant])).rows);
}
