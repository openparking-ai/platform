import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool, createTenant } from './helpers.js';

let server;
let base;
let tenantId;

before(async () => {
  tenantId = await createTenant('http-tenant');
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('healthz is open', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('the api refuses a request with no tenant context', async () => {
  const res = await fetch(`${base}/api/sites`);
  assert.equal(res.status, 401);
});

test('a site round-trips for its own tenant', async () => {
  const created = await fetch(`${base}/api/sites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId },
    body: JSON.stringify({ name: 'North deck' }),
  });
  assert.equal(created.status, 201);
  const { site } = await created.json();
  assert.equal(site.name, 'North deck');
  assert.equal(site.tenant_id, tenantId);

  const listed = await fetch(`${base}/api/sites`, { headers: { 'x-tenant-id': tenantId } });
  const { sites } = await listed.json();
  assert.ok(sites.some((s) => s.id === site.id));
  assert.ok(sites.every((s) => s.tenant_id === tenantId));
});
