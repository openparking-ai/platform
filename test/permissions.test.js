/**
 * A permission on every operator route (README, "Permissions: one on every
 * operator route"), and "Done by" (README, "Done by").
 *
 * The router itself is walked: a route that names no permission, two, or one
 * not in the list fails here. Then a linked person (test/fixtures/accounts-door)
 * holding a little, at one garage of two, is taken across the routes.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool, createTenant, buildWorld, superuserClient, withTenant } from './helpers.js';
import { createAdmin } from '../src/adminAccount.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import * as signIn from '../src/signIn.js';
import { ALL, EVERYTHING, PERMISSIONS, PERMISSION_REFUSED, holds, isPermission, permit, reaches } from '../src/permissions.js';
import { DONE_BY_REFUSED } from '../src/doneBy.js';
import { accountsStandIn } from './accounts-stand-in.js';

const ADMIN_ORIGIN = 'https://admin.example.test';
const PASSWORD = 'correct horse battery staple';

const door = accountsStandIn();
let main;
let theApp;
let server;
let su;

async function call(path, { method = 'GET', body, cookie, key, origin = ADMIN_ORIGIN, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = `${signIn.COOKIE}=${cookie}`;
  if (key) h.authorization = `Bearer ${key}`;
  if (origin && !key) h.origin = origin;
  const res = await fetch(`${main}${path}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  return { status: res.status, text, json, cookies: res.headers.getSetCookie() };
}

const tokenOf = (r) => {
  const c = r.cookies.find((x) => x.startsWith(`${signIn.COOKIE}=`) && !x.startsWith(`${signIn.COOKIE}=;`));
  return c ? c.split(';')[0].slice(signIn.COOKIE.length + 1) : null;
};

/** A tenant with two garages, its admin, and an operator key. */
async function account(tag) {
  const tenant = await createTenant(tag);
  const one = await buildWorld(tenant);
  const two = await withTenant(tenant, async (c) => {
    const garage = (await c.query("INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, 'Second Garage', 'America/New_York', 'USD') RETURNING id", [tenant])).rows[0].id;
    const entryLane = (await c.query("INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1, $2, 'Entry 1', 'entry') RETURNING id", [tenant, garage])).rows[0].id;
    return { garage, entryLane };
  });
  const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await createAdmin({ tenantId: tenant, email, password: PASSWORD });
  const key = generateDeviceToken();
  await withTenant(tenant, (c) => c.query("INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1, 'Front desk key', $2)", [tenant, hashToken(key)]));
  return { tenant, one, two, email, key };
}

async function linked(a, over) {
  const p = door.person(a.tenant, over);
  const r = await call('/api/v1/auth/sign-in', { method: 'POST', body: { email: p.email, password: p.password } });
  assert.equal(r.status, 200, r.text);
  return { ...p, token: tokenOf(r) };
}

/** The operator router's routes, each with its handlers, from the router itself. */
function operatorRoutes(app) {
  const out = [];
  for (const layer of app._router.stack) {
    if (layer.name !== 'router') continue;
    const source = layer.regexp.source;
    if (source.includes('auth') || source.includes('lane')) continue;
    for (const l of layer.handle.stack) {
      if (!l.route) continue;
      for (const method of Object.keys(l.route.methods)) out.push({ method: method.toUpperCase(), path: l.route.path, handlers: l.route.stack.map((s) => s.handle) });
    }
  }
  return out;
}

before(async () => {
  su = superuserClient();
  await su.connect();
  process.env.ADMIN_ORIGIN = ADMIN_ORIGIN;
  process.env.SIGN_IN_REFUSAL_FLOOR_MS = '200';
  process.env.SIGN_IN_ATTEMPTS_PER_ADDRESS = '1000';
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  main = `http://127.0.0.1:${server.address().port}`;
  theApp = app;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await su.end();
  await pool.end();
  door.end();
});

test('THE LIST: each name a read and a change, a change covering its read and nothing else', () => {
  assert.equal(ALL.length, PERMISSIONS.length * 2);
  assert.deepEqual(EVERYTHING, { permissions: ALL, garages: 'all' });
  for (const p of PERMISSIONS) {
    assert.ok(holds([`${p}:change`], `${p}:read`), p);
    assert.equal(holds([`${p}:read`], `${p}:change`), false, p);
  }
  assert.equal(holds(['lanes:change'], 'rates:read'), false);
  assert.equal(holds([], 'garages:read'), false);
  for (const bad of ['garages', 'garages:write', 'GARAGES:read', 'everything', '', null, 3]) assert.equal(isPermission(bad), false, String(bad));
  assert.ok(reaches({ garages: 'all' }, 'x'));
  assert.ok(reaches({ garages: ['x'] }, 'x'));
  assert.equal(reaches({ garages: ['x'] }, 'y'), false);
  assert.throws(() => permit('garages:write'), /not in the list/);
});

test('EVERY OPERATOR ROUTE NAMES EXACTLY ONE PERMISSION, as its first handler, from the list', () => {
  const routes = operatorRoutes(theApp);
  assert.ok(routes.length >= 50, `only ${routes.length} operator routes found`);
  for (const r of routes) {
    const named = r.handlers.filter((h) => h.permission !== undefined);
    assert.equal(named.length, 1, `${r.method} ${r.path} names ${named.length} permissions`);
    assert.ok(r.handlers[0].permission, `${r.method} ${r.path}: the permission is not the first handler`);
    assert.ok(isPermission(r.handlers[0].permission), `${r.method} ${r.path}: ${r.handlers[0].permission}`);
  }
  // A read route names a read; a route that changes something names a change,
  // but for the one that tries a plan without keeping it.
  for (const r of routes) {
    const p = r.handlers[0].permission;
    if (r.method === 'GET') assert.ok(p.endsWith(':read'), `${r.method} ${r.path} names ${p}`);
    else if (r.path !== '/garages/:garageId/rate-plans/try') assert.ok(p.endsWith(':change'), `${r.method} ${r.path} names ${p}`);
  }
});

test('THE ADMIN AND A KEY HOLD EVERYTHING, at every garage: nothing either did before changes', async () => {
  const a = await account('pm-all');
  const cookie = tokenOf(await call('/api/v1/auth/sign-in', { method: 'POST', body: { email: a.email, password: PASSWORD } }));
  for (const who of [{ cookie }, { key: a.key }]) {
    const list = await call('/api/v1/garages', who);
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.garages.map((g) => g.id).sort(), [a.one.garage, a.two.garage].sort());
    assert.equal((await call(`/api/v1/garages/${a.two.garage}/lanes`, who)).status, 200);
    assert.equal((await call(`/api/v1/lanes/${a.two.entryLane}`, { ...who, method: 'PATCH', body: { name: `By ${who.key ? 'key' : 'admin'}` } })).status, 200);
  }
});

test('A PERSON SEES ONLY THEIR GARAGES: the list is cut, and another garage of the account answers as one that does not exist', async () => {
  const a = await account('pm-scope');
  const p = await linked(a, { garages: [a.one.garage], permissions: ['garages:read', 'lanes:change'] });
  const list = await call('/api/v1/garages', { cookie: p.token });
  assert.deepEqual(list.json.garages.map((g) => g.id), [a.one.garage]);
  assert.equal((await call(`/api/v1/garages/${a.one.garage}`, { cookie: p.token })).status, 200);

  const outside = await call(`/api/v1/garages/${a.two.garage}`, { cookie: p.token });
  const nothing = await call('/api/v1/garages/00000000-0000-4000-8000-000000000000', { cookie: p.token });
  assert.equal(outside.status, 404);
  assert.equal(outside.text, nothing.text, 'a garage outside the list says more than one that does not exist');

  // Through a lane, too: the lane of the other garage is not found, as one that is not there.
  const laneOut = await call(`/api/v1/lanes/${a.two.entryLane}`, { cookie: p.token, method: 'PATCH', body: { name: 'Not yours' } });
  const laneNone = await call('/api/v1/lanes/00000000-0000-4000-8000-000000000000', { cookie: p.token, method: 'PATCH', body: { name: 'Not yours' } });
  assert.equal(laneOut.status, 404);
  assert.equal(laneOut.text, laneNone.text);
  const lane = (await su.query('SELECT name FROM lanes WHERE id = $1', [a.two.entryLane])).rows[0];
  assert.equal(lane.name, 'Entry 1', 'the lane outside the list changed');
  // And the lane of their own garage changes; lanes:change covers lanes:read.
  assert.equal((await call(`/api/v1/lanes/${a.one.entryLane}`, { cookie: p.token, method: 'PATCH', body: { name: 'Mine' } })).status, 200);
  assert.equal((await call(`/api/v1/garages/${a.one.garage}/lanes`, { cookie: p.token })).status, 200);
});

test('A PERMISSION NOT HELD is 403 permission_refused, changes nothing, and is a refused attempt naming the person', async () => {
  const a = await account('pm-refuse');
  const p = await linked(a, { garages: 'all', permissions: ['garages:read'] });
  const cases = [
    ['PATCH', `/api/v1/garages/${a.one.garage}`, { name: 'Renamed' }],
    ['POST', `/api/v1/garages/${a.one.garage}/lanes`, { name: 'New', direction: 'entry' }],
    ['GET', `/api/v1/garages/${a.one.garage}/lanes`, undefined],
    ['GET', `/api/v1/garages/${a.one.garage}/reconciliation`, undefined],
    ['GET', `/api/v1/garages/${a.one.garage}/changes`, undefined],
  ];
  for (const [method, path, body] of cases) {
    const r = await call(path, { cookie: p.token, method, body });
    assert.equal(r.status, 403, `${method} ${path}: ${r.text}`);
    assert.deepEqual(r.json, { error: PERMISSION_REFUSED.error, code: PERMISSION_REFUSED.code }, path);
  }
  assert.equal((await su.query('SELECT name FROM garages WHERE id = $1', [a.one.garage])).rows[0].name, 'Test Garage');
  const refused = (await su.query(
    "SELECT actor_kind, actor_name, refusal FROM garage_changes WHERE tenant_id = $1 AND outcome = 'refused' AND refusal = 'permission_refused'",
    [a.tenant],
  )).rows;
  assert.ok(refused.length >= 2, 'the refused changes were not recorded');
  assert.ok(refused.every((l) => l.actor_kind === 'linked' && l.actor_name === p.email));
});

test('A ROUTE FOR THE WHOLE ACCOUNT needs every garage: a person at some garages cannot add one or cancel a key, whatever they hold', async () => {
  const a = await account('pm-every');
  const some = await linked(a, { garages: [a.one.garage], permissions: ['garages:change', 'account:change'] });
  const keyId = (await su.query('SELECT id FROM operator_tokens WHERE tenant_id = $1 AND kind = $2', [a.tenant, 'key'])).rows[0].id;
  assert.equal((await call('/api/v1/garages', { cookie: some.token, method: 'POST', body: { name: 'Another', timezone: 'America/New_York', currency: 'USD' } })).status, 403);
  assert.equal((await call(`/api/v1/operator-tokens/${keyId}/revoke`, { cookie: some.token, method: 'POST', body: {} })).status, 403);
  const every = await linked(a, { garages: 'all', permissions: ['garages:change'] });
  const made = await call('/api/v1/garages', { cookie: every.token, method: 'POST', body: { name: 'Another', timezone: 'America/New_York', currency: 'USD' } });
  assert.equal(made.status, 201, made.text);
});

test('DONE BY: a key may name who acts through it; the name is kept beside the line and trusted for nothing else', async () => {
  const a = await account('pm-doneby');
  const name = 'María José O\'Neil';
  const r = await call(`/api/v1/lanes/${a.one.entryLane}`, {
    key: a.key, method: 'PATCH', body: { name: 'Front lane' }, headers: { 'x-done-by': encodeURIComponent(name) },
  });
  assert.equal(r.status, 200, r.text);
  const line = (await su.query("SELECT actor_kind, done_by FROM garage_changes WHERE tenant_id = $1 AND action = 'lane.rename' ORDER BY at DESC LIMIT 1", [a.tenant])).rows[0];
  assert.deepEqual(line, { actor_kind: 'key', done_by: name });
  const read = await call(`/api/v1/garages/${a.one.garage}/changes`, { key: a.key });
  assert.equal(read.json.changes.find((c) => c.action === 'lane.rename').done_by, name);

  // Refused, and nothing changes: empty, too long, a control character, not percent-encoding.
  for (const bad of ['', '%20%20', encodeURIComponent('x'.repeat(81)), encodeURIComponent('tab\there'), '%E0%A4%A', encodeURIComponent('\u202Eevil')]) {
    const out = await call(`/api/v1/lanes/${a.one.entryLane}`, { key: a.key, method: 'PATCH', body: { name: 'Changed' }, headers: { 'x-done-by': bad } });
    assert.equal(out.status, 400, JSON.stringify(bad));
    assert.deepEqual(out.json, { error: DONE_BY_REFUSED.error, code: DONE_BY_REFUSED.code });
  }
  assert.equal((await su.query('SELECT name FROM lanes WHERE id = $1', [a.one.entryLane])).rows[0].name, 'Front lane');

  // A session's header is not read: the line names the person signed in.
  const cookie = tokenOf(await call('/api/v1/auth/sign-in', { method: 'POST', body: { email: a.email, password: PASSWORD } }));
  assert.equal((await call(`/api/v1/lanes/${a.one.entryLane}`, { cookie, method: 'PATCH', body: { name: 'By the admin' }, headers: { 'x-done-by': 'Someone%20else' } })).status, 200);
  const p = await linked(a, { permissions: ['lanes:change'] });
  assert.equal((await call(`/api/v1/lanes/${a.one.entryLane}`, { cookie: p.token, method: 'PATCH', body: { name: 'By a person' }, headers: { 'x-done-by': 'Someone%20else' } })).status, 200);
  const lines = (await su.query(
    "SELECT actor_kind, done_by FROM garage_changes WHERE tenant_id = $1 AND action = 'lane.rename' AND actor_kind <> 'key' ORDER BY at",
    [a.tenant],
  )).rows;
  assert.deepEqual(lines, [{ actor_kind: 'owner', done_by: null }, { actor_kind: 'linked', done_by: null }]);
  // The database holds the rule too: only a key's line names anyone beside it.
  // The key's own line, copied as it is, is taken (the control); copied as the
  // admin's or a person's, it is refused.
  const copy = (kind) => su.query(
    `INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name, action, subject_kind, subject_id, subject_name, before, after, done_by)
     SELECT tenant_id, garage_id, outcome, $2, actor_id, CASE WHEN $2 = 'key' THEN actor_name ELSE 'x@example.com' END,
            action, subject_kind, subject_id, subject_name, before, after, done_by
       FROM garage_changes WHERE tenant_id = $1 AND actor_kind = 'key' AND done_by IS NOT NULL LIMIT 1`,
    [a.tenant, kind],
  );
  assert.equal((await copy('key')).rowCount, 1);
  for (const kind of ['owner', 'linked']) await assert.rejects(copy(kind), /garage_changes_done_by_shape/, kind);
});

test('THROUGH A LANE COMPUTER, TOO: a computer of a garage outside the list answers as one that does not exist, and is not cancelled', async () => {
  const a = await account('pm-device');
  const device = async (lane) => (await su.query(
    `INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash)
     VALUES ($1, $2, 'Gate computer', md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)) RETURNING id`,
    [a.tenant, lane],
  )).rows[0].id;
  const outsideDevice = await device(a.two.entryLane);
  const ownDevice = await device(a.one.entryLane);
  const p = await linked(a, { garages: [a.one.garage], permissions: ['lanes:change'] });
  const outside = await call(`/api/v1/devices/${outsideDevice}/revoke`, { cookie: p.token, method: 'POST', body: {} });
  const nothing = await call('/api/v1/devices/00000000-0000-4000-8000-000000000000/revoke', { cookie: p.token, method: 'POST', body: {} });
  assert.equal(outside.status, 404, outside.text);
  assert.equal(outside.text, nothing.text, 'a computer outside the list says more than one that does not exist');
  assert.equal((await su.query('SELECT revoked_at FROM lane_devices WHERE id = $1', [outsideDevice])).rows[0].revoked_at, null, 'the computer outside the list was cancelled');
  // The control: a computer of their own garage is cancelled.
  const own = await call(`/api/v1/devices/${ownDevice}/revoke`, { cookie: p.token, method: 'POST', body: {} });
  assert.equal(own.status, 200, own.text);
  assert.ok((await su.query('SELECT revoked_at FROM lane_devices WHERE id = $1', [ownDevice])).rows[0].revoked_at);
});

test('THE ACCOUNT\'S OWN LINES ARE FOR THE WHOLE ACCOUNT: a reader at some garages sees their garage\'s lines and refused attempts, never the account\'s', async () => {
  const a = await account('pm-log');
  // An account-wide line (the admin's language) and a refused one, and a line of garage one.
  const cookie = tokenOf(await call('/api/v1/auth/sign-in', { method: 'POST', body: { email: a.email, password: PASSWORD } }));
  assert.equal((await call('/api/v1/auth/language', { cookie, method: 'PUT', body: { language: 'es' } })).status, 200);
  assert.equal((await call('/api/v1/auth/language', { cookie, method: 'PUT', body: { language: 'fr' } })).status, 400);
  assert.equal((await call(`/api/v1/lanes/${a.one.entryLane}`, { key: a.key, method: 'PATCH', body: { name: 'Front lane' } })).status, 200);
  const accountLine = (await su.query("SELECT id FROM garage_changes WHERE tenant_id = $1 AND garage_id IS NULL AND outcome = 'done' LIMIT 1", [a.tenant])).rows[0].id;

  const some = await linked(a, { garages: [a.one.garage], permissions: ['log:read'] });
  const every = await linked(a, { garages: 'all', permissions: ['log:read'] });
  const read = async (who, path) => (await call(`/api/v1/garages/${a.one.garage}/${path}`, { cookie: who.token })).json;
  const someDone = await read(some, 'changes');
  const everyDone = await read(every, 'changes');
  assert.ok(someDone.changes.some((c) => c.action === 'lane.rename'), 'the garage\'s own line is missing');
  assert.equal(someDone.changes.some((c) => c.garage_id === null), false, 'a reader at some garages sees the account\'s lines');
  assert.ok(everyDone.changes.some((c) => c.action === 'language.change' && c.garage_id === null), 'a reader over the whole account misses the account\'s lines');
  // Paging from an account line: not a line of this reader's log.
  assert.equal((await call(`/api/v1/garages/${a.one.garage}/changes/${accountLine}`, { cookie: some.token })).status, 404);
  assert.equal((await call(`/api/v1/garages/${a.one.garage}/changes/${accountLine}`, { cookie: every.token })).status, 200);
  // Refused attempts and their count, the same way.
  const someRefused = await read(some, 'refused-attempts');
  const everyRefused = await read(every, 'refused-attempts');
  assert.equal(someRefused.refused.some((c) => c.garage_id === null), false);
  assert.ok(everyRefused.refused.some((c) => c.garage_id === null));
  assert.ok(someRefused.count.lines < everyRefused.count.lines, 'the count includes the account\'s refused attempts');
  // The admin and a key read the whole account, as before.
  assert.ok((await call(`/api/v1/garages/${a.one.garage}/changes`, { key: a.key })).json.changes.some((c) => c.garage_id === null));
});
