/**
 * A new garage's name, time zone and money, checked before they are stored
 * (POST /garages; src/garageFields.js). Each refusal is one plain sentence
 * with its own code -- never the bare 500 "usd" used to be, and never a 201
 * for "XYZ", "Mars/Olympus" or a name that is a number -- and a refusal
 * stores nothing. "America/New_York" with "USD" is still a garage.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { CURRENCY_CODES } from '../src/currencies.js';
import { GARAGE_NAME_MAX } from '../src/garageFields.js';

let server;
let base;
let tenant;
let key;

before(async () => {
  tenant = await createTenant('garage-checks');
  key = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(key)]));
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

const create = async (body) => {
  const res = await fetch(`${base}/api/v1/garages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};
const garages = async () => Number((await withTenant(tenant, (c) => c.query('SELECT count(*) FROM garages'))).rows[0].count);

const GOOD = { name: 'Main Street Garage', timezone: 'America/New_York', currency: 'USD' };
const TIMEZONE = 'timezone must be a time zone name this platform knows, such as "America/New_York"';
const CURRENCY = 'currency must be an ISO 4217 currency code in use today, such as "USD"';
const NAME = `name must be text of 1 to ${GARAGE_NAME_MAX} characters`;

test('"America/New_York" with "USD" is a garage', async () => {
  const r = await create(GOOD);
  assert.equal(r.status, 201);
  assert.equal(r.json.garage.timezone, 'America/New_York');
  assert.equal(r.json.garage.currency, 'USD');
  assert.equal(r.json.garage.name, 'Main Street Garage');
});

test('each refused in a plain sentence with its own code, and nothing stored: "Mars/Olympus", "usd", "XYZ"', async () => {
  const cases = [
    [{ ...GOOD, timezone: 'Mars/Olympus' }, TIMEZONE, 'garage_timezone_refused'],
    [{ ...GOOD, currency: 'usd' }, 'currency is written in capital letters: "USD"', 'garage_currency_refused'],
    [{ ...GOOD, currency: 'Usd' }, 'currency is written in capital letters: "USD"', 'garage_currency_refused'],
    [{ ...GOOD, currency: 'XYZ' }, CURRENCY, 'garage_currency_refused'],
  ];
  for (const [body, error, code] of cases) {
    const before = await garages();
    const r = await create(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.json, { error, code }, JSON.stringify(body));
    assert.equal(await garages(), before, `${JSON.stringify(body)} stored a garage`);
  }
});

test('a time zone must be one the database knows, spelled as it spells it; any it knows is taken', async () => {
  for (const timezone of ['america/new_york', 'America/New York', 'Eastern', 'EST5EDTX', 'x'.repeat(65), 7, ['UTC'], { zone: 'UTC' }]) {
    const r = await create({ ...GOOD, timezone });
    assert.equal(r.status, 400, JSON.stringify(timezone));
    assert.deepEqual(r.json, { error: TIMEZONE, code: 'garage_timezone_refused' });
  }
  for (const timezone of ['UTC', 'Europe/Madrid', 'America/Indiana/Indianapolis', 'Asia/Kolkata']) {
    assert.equal((await create({ ...GOOD, timezone })).status, 201, timezone);
  }
});

test('a currency must be one of the list, in capitals; every code of the list is taken', async () => {
  for (const currency of ['US', 'USDD', 'XAU', 'XTS', 'XXX', 'BGN', 7, ['USD'], { code: 'USD' }]) {
    const r = await create({ ...GOOD, currency });
    assert.equal(r.status, 400, JSON.stringify(currency));
    assert.deepEqual(r.json, { error: CURRENCY, code: 'garage_currency_refused' }, JSON.stringify(currency));
  }
  assert.equal(CURRENCY_CODES.length, 155);
  assert.ok(CURRENCY_CODES.every((c) => /^[A-Z]{3}$/.test(c)), 'every code is three capitals, as the column requires');
  for (const currency of ['EUR', 'CAD', 'MXN', 'JPY', 'XCG', 'ZWG']) assert.equal((await create({ ...GOOD, currency })).status, 201, currency);
});

test('a name must be text of 1 to 100 characters, not only spaces: a number, an object, a list and 101 characters are refused', async () => {
  for (const name of [5, true, { a: 1 }, ['x'], '   ', 'x'.repeat(GARAGE_NAME_MAX + 1), '😀'.repeat(GARAGE_NAME_MAX + 1)]) {
    const before = await garages();
    const r = await create({ ...GOOD, name });
    assert.equal(r.status, 400, JSON.stringify(name).slice(0, 30));
    assert.deepEqual(r.json, { error: NAME, code: 'garage_name_refused' });
    assert.equal(await garages(), before);
  }
  // At the bound, counted as a person counts characters.
  for (const name of ['x'.repeat(GARAGE_NAME_MAX), '😀'.repeat(GARAGE_NAME_MAX), 'G']) {
    assert.equal((await create({ ...GOOD, name })).status, 201, name.slice(0, 10));
  }
});

test('the column holds the same bound: a longer name written past the route is refused by the database, one at the bound is not', async () => {
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, $2, 'UTC', 'USD')`, [tenant, 'x'.repeat(GARAGE_NAME_MAX + 1)])),
    (err) => err.constraint === 'garages_name_is_bounded',
  );
  await withTenant(tenant, (c) => c.query(`INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, $2, 'UTC', 'USD')`, [tenant, 'x'.repeat(GARAGE_NAME_MAX)]));
});

test('the fields still required say so first', async () => {
  for (const missing of ['name', 'timezone', 'currency']) {
    const body = { ...GOOD };
    delete body[missing];
    const r = await create(body);
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: 'name, timezone and currency are required' });
  }
});
