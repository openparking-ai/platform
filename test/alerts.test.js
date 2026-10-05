/**
 * U4b -- WHO GETS WHICH ALERT, AND HOW (src/alerts.js, 0029).
 *
 *   1  your garage only: another account's garage or person is not found and
 *      nothing changes; no sign-in is 401; a write from another site, or
 *      with no site named, is refused
 *   2  phone and email: a generated set of good and bad ones, each kept as
 *      stated or refused with its reason
 *   3  the choices hold together: no text without a phone, no email without
 *      an address, before and after every change; taking a phone away turns
 *      its text choices off, and the answer and the line say so
 *   4  bounds: the 26th person and an over-long name, refused by name, by
 *      the route and by the database
 *   5  no contact details in any log: the change log, the security log and
 *      the server's output hold no phone number and no email address, as
 *      typed or as kept, after every route and every change kind
 *   7  the checklist step is the data: a garage with every alert covered and
 *      one with a gap; the open step is the same for both
 *   8  nothing is sent: no provider, no network call, no key read
 *
 * Check 6 (every change logged, nothing logged for nothing) is U4's suite,
 * test/change-log.test.js, which walks the router and holds the four new
 * routes to it with the rest.
 *
 * Every person, number and address here is invented: 555-01xx numbers and
 * example.com addresses.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { pool, withTenant } from './helpers.js';
import * as alerts from '../src/alerts.js';
import * as changes from '../src/changes.js';
import { STEP_KEYS } from '../src/setup.js';
import { startServer, owner, call, newGarage, newLane, linesOf, FOREIGN_ORIGIN } from './u4-world.js';

let server;
let base;
let a;
let b;
const STARTED = new Date();

// Everything the server prints while this file runs, to be scanned.
const printed = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

// Every phone number and email address this file sends, as typed: none may
// reach a log, as typed or as kept.
const details = new Set();
const send = (body) => {
  for (const k of ['phone', 'email']) if (typeof body?.[k] === 'string') details.add(body[k]);
  return body;
};

before(async () => {
  process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return realOut(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { printed.push(String(chunk)); return realErr(chunk, ...rest); };
  ({ server, base } = await startServer());
  a = await owner(base, 'alerts-a');
  b = await owner(base, 'alerts-b');
});

after(async () => {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

const contacts = (tenant, garageId) =>
  withTenant(tenant, async (c) => (await c.query('SELECT * FROM alert_contacts WHERE garage_id = $1 ORDER BY created_at, id', [garageId])).rows);

const addPerson = async (as, garageId, body) => {
  const r = await call(base, 'POST', `/garages/${garageId}/alert-contacts`, { as, body: send(body) });
  assert.equal(r.status, 201, r.text);
  return r.json.contact;
};

const ownerDb = async (fn) => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};

// ---------------------------------------------------------------------------
// 1
// ---------------------------------------------------------------------------

test('YOUR GARAGE ONLY: another account\'s garage or person is not found and nothing changes; no sign-in is 401; a write from another site or none is refused; the body never names the garage', async () => {
  const mine = await newGarage(base, a);
  const theirs = await newGarage(base, b);
  const theirPerson = await addPerson(b, theirs.id, { name: 'Their manager', email: 'their.manager@example.com' });
  const myPerson = await addPerson(a, mine.id, { name: 'My manager', phone: '555-010-2000' });
  const snapshot = async () => JSON.stringify([await contacts(a.tenant, mine.id), await contacts(b.tenant, theirs.id)]);
  const was = await snapshot();

  const routes = (g, p) => [
    ['GET', `/garages/${g}/alerts`, undefined],
    ['POST', `/garages/${g}/alert-contacts`, { name: 'Intruder', email: 'intruder@example.com' }],
    ['PATCH', `/garages/${g}/alert-contacts/${p}`, { name: 'Renamed' }],
    ['PUT', `/garages/${g}/alert-contacts/${p}/choices`, { by_text: [], by_email: ['lane_problem'] }],
    ['DELETE', `/garages/${g}/alert-contacts/${p}`, undefined],
  ];
  const writes = (g, p) => routes(g, p).filter(([m]) => m !== 'GET');
  const personal = (g, p) => routes(g, p).filter(([, path]) => path.includes(p));

  // Another account's garage, by session and by key.
  for (const via of ['session', 'key']) {
    for (const [method, path, body] of routes(theirs.id, theirPerson.id)) {
      const r = await call(base, method, path, { as: a, via, body: send(body) });
      assert.equal(r.status, 404, `${via} ${method} ${path}: ${r.status} ${r.text}`);
    }
  }
  // My garage, another account's person: not found either.
  for (const [method, path, body] of personal(mine.id, theirPerson.id)) {
    const r = await call(base, method, path, { as: a, body: send(body) });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.json.code, 'alert_contact_not_found');
  }
  // Another account's garage with my own person in the path: not found.
  for (const [method, path, body] of personal(theirs.id, myPerson.id)) {
    assert.equal((await call(base, method, path, { as: a, body: send(body) })).status, 404, `${method} ${path}`);
  }
  // No sign-in.
  for (const [method, path, body] of routes(mine.id, myPerson.id)) {
    assert.equal((await call(base, method, path, { body: send(body) })).status, 401, `${method} ${path}`);
  }
  // A write from another site, or with no site named, carried by the cookie.
  for (const [method, path, body] of writes(mine.id, myPerson.id)) {
    for (const origin of [FOREIGN_ORIGIN, null]) {
      const r = await call(base, method, path, { as: a, body: send(body), origin });
      assert.equal(r.status, 403, `${method} ${path} from ${origin}`);
      assert.equal(r.json.code, 'origin_refused');
    }
  }
  assert.equal(await snapshot(), was, 'a refused request changed something');

  // The garage comes from the path: a body naming one is refused, and nothing
  // of this account sits on any garage but its own.
  const r = await call(base, 'POST', `/garages/${mine.id}/alert-contacts`, { as: a, body: send({ name: 'Elsewhere', email: 'elsewhere@example.com', garage_id: theirs.id }) });
  assert.equal(r.status, 400, r.text);
  const astray = await withTenant(a.tenant, async (c) =>
    (await c.query('SELECT count(*)::int AS n FROM alert_contacts c WHERE NOT EXISTS (SELECT 1 FROM garages g WHERE g.id = c.garage_id)')).rows[0].n);
  assert.equal(astray, 0, 'a person of this account sits on a garage that is not its own');
  assert.equal(await snapshot(), was);
});

// ---------------------------------------------------------------------------
// 2
// ---------------------------------------------------------------------------

/** The generated set: what is typed, and what is kept -- or the reason it is refused. */
function phoneCases() {
  const cases = [];
  const digits = (n, start = 2) => Array.from({ length: n }, (_, i) => String((start + i * 3) % 10)).join('');
  for (const ten of ['5550101234', '2125550147', '4155550198']) {
    const kept = `+1${ten}`;
    for (const typed of [
      ten,
      `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`,
      `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`,
      `${ten.slice(0, 3)}.${ten.slice(3, 6)}.${ten.slice(6)}`,
      `1${ten}`,
      `1 ${ten.slice(0, 3)} ${ten.slice(3, 6)} ${ten.slice(6)}`,
      `+1 ${ten}`,
      `  ${ten}  `,
    ]) cases.push([typed, kept]);
  }
  for (const [typed, kept] of [
    ['+44 20 7946 0000', '+442079460000'],
    ['+52 55 1234 5678', '+525512345678'],
    ['+49 30 901820', '+4930901820'],
    ['+61 2 9374 4000', '+61293744000'],
    ['+12345678', '+12345678'],
    [`+${digits(15)}`, `+${digits(15)}`],
  ]) cases.push([typed, kept]);
  for (const [typed, reason] of [
    ['555-0101', 'too_short'],
    ['5550101', 'too_short'],
    ['555 010 123', 'too_short'],
    ['25550101234', 'not_us'],
    ['555010123456', 'not_us'],
    ['+1234567', 'too_short'],
    [`+${digits(16)}`, 'too_long'],
    ['555-CALL-NOW', 'letters'],
    ['call 5550101234', 'letters'],
    ['555​0101234', 'invisible'],
    ['555­0101234', 'invisible'],
    ['‮5550101234', 'invisible'],
    ['555\t0101234', 'invisible'],
    ['++15550101234', 'character'],
    ['555+0101234', 'character'],
    ['555/010/1234', 'character'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['5550101234#12', 'character'],
  ]) cases.push([typed, { refused: reason }]);
  return cases;
}

function emailCases() {
  const long = (n) => `${'a'.repeat(n - '@example.com'.length)}@example.com`;
  return [
    ['night.manager@example.com', 'night.manager@example.com'],
    ['  padded@example.com  ', 'padded@example.com'],
    ['First.Last+alerts@example.com', 'First.Last+alerts@example.com'],
    ['ñandú@example.com', 'ñandú@example.com'],
    [long(254), long(254)],
    [long(255), { refused: 'too_long' }],
    ['two words@example.com', { refused: 'space' }],
    ['tab\there@example.com', { refused: 'invisible' }],
    ['nbsp here@example.com', { refused: 'space' }],
    ['zero​width@example.com', { refused: 'invisible' }],
    ['a@@example.com', { refused: 'two_at' }],
    ['a@b@example.com', { refused: 'two_at' }],
    ['no-at.example.com', { refused: 'no_at' }],
    ['@example.com', { refused: 'empty_side' }],
    ['someone@', { refused: 'empty_side' }],
    ['', { refused: 'empty' }],
  ];
}

test('PHONE AND EMAIL: a generated set of good and bad numbers and addresses, each kept as stated or refused with its reason -- by the route and by the database', async () => {
  const g = await newGarage(base, a);
  let n = 0;
  for (const [typed, want] of phoneCases()) {
    const r = await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { as: a, body: send({ name: `Phone ${(n += 1)}`, phone: typed }) });
    if (typeof want === 'string') {
      assert.equal(r.status, 201, `${JSON.stringify(typed)}: ${r.text}`);
      assert.equal(r.json.contact.phone, want, JSON.stringify(typed));
      assert.equal((await contacts(a.tenant, g.id)).find((c) => c.id === r.json.contact.id).phone, want);
      assert.equal((await call(base, 'DELETE', `/garages/${g.id}/alert-contacts/${r.json.contact.id}`, { as: a })).status, 204);
    } else {
      assert.equal(r.status, 400, `${JSON.stringify(typed)} was kept`);
      assert.equal(r.json.code, 'alert_contact_phone_refused', JSON.stringify(typed));
      assert.equal(r.json.details.reason, want.refused, JSON.stringify(typed));
      // The refusal says why, and never quotes what was sent.
      if (typed.trim().length >= 4) assert.equal(r.text.includes(typed.trim()), false, `the refusal quotes ${JSON.stringify(typed)}`);
    }
  }
  for (const [typed, want] of emailCases()) {
    const r = await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { as: a, body: send({ name: `Email ${(n += 1)}`, email: typed }) });
    if (typeof want === 'string') {
      assert.equal(r.status, 201, `${JSON.stringify(typed)}: ${r.text}`);
      assert.equal(r.json.contact.email, want);
      assert.equal((await call(base, 'DELETE', `/garages/${g.id}/alert-contacts/${r.json.contact.id}`, { as: a })).status, 204);
    } else {
      assert.equal(r.status, 400, `${JSON.stringify(typed)} was kept`);
      assert.equal(r.json.code, 'alert_contact_email_refused', JSON.stringify(typed));
      assert.equal(r.json.details.reason, want.refused, JSON.stringify(typed));
      if (typed.trim().length >= 4) assert.equal(r.text.includes(typed.trim()), false, `the refusal quotes ${JSON.stringify(typed)}`);
    }
  }
  assert.deepEqual(await contacts(a.tenant, g.id), [], 'a refused number or address was kept');
  // Neither: refused by name.
  const none = await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { as: a, body: { name: 'Nobody to reach' } });
  assert.deepEqual([none.status, none.json.code], [400, 'alert_contact_unreachable']);

  // The database holds the same shapes whoever writes the row.
  const insert = (phone, email) => withTenant(a.tenant, (c) =>
    c.query('INSERT INTO alert_contacts (tenant_id, garage_id, name, phone, email) VALUES ($1, $2, $3, $4, $5)', [a.tenant, g.id, 'Direct', phone, email]));
  for (const phone of ['5550101234', '+1234567', '+1234567890123456', '+1 5550101234', '+1555CALLNOW']) {
    await assert.rejects(insert(phone, null), /alert_contacts_phone_shape/, phone);
  }
  for (const email of ['two words@example.com', 'a@@example.com', 'no-at', 'zero​width@example.com', 'nbsp x@example.com', `${'a'.repeat(250)}@example.com`]) {
    await assert.rejects(insert(null, email), /alert_contacts_email_shape/, JSON.stringify(email));
  }
  await assert.rejects(insert(null, null), /alert_contacts_reachable/);
});

test('the phone and email rules themselves, one by one', () => {
  for (const [typed, want] of phoneCases()) {
    if (typeof want === 'string') assert.equal(alerts.phoneField(typed), want, JSON.stringify(typed));
    else assert.throws(() => alerts.phoneField(typed), (e) => e.details?.reason === want.refused, JSON.stringify(typed));
  }
  for (const [typed, want] of emailCases()) {
    if (typeof want === 'string') assert.equal(alerts.emailField(typed), want, JSON.stringify(typed));
    else assert.throws(() => alerts.emailField(typed), (e) => e.details?.reason === want.refused, JSON.stringify(typed));
  }
});

// ---------------------------------------------------------------------------
// 3
// ---------------------------------------------------------------------------

test('THE CHOICES HOLD TOGETHER: no text without a phone, no email without an address, before and after every change; taking a phone away turns its text choices off and says so', async () => {
  const g = await newGarage(base, a);
  const holds = async () => {
    for (const c of await contacts(a.tenant, g.id)) {
      assert.ok(c.phone !== null || c.by_text.length === 0, `${c.name} gets texts with no phone`);
      assert.ok(c.email !== null || c.by_email.length === 0, `${c.name} gets emails with no address`);
    }
  };
  const byMail = await addPerson(a, g.id, { name: 'Mail only', email: 'mail.only@example.com' });
  const byPhone = await addPerson(a, g.id, { name: 'Phone only', phone: '555 010 3000' });
  const both = await addPerson(a, g.id, { name: 'Both ways', phone: '555 010 3001', email: 'both.ways@example.com' });
  await holds();
  const choose = (p, body) => call(base, 'PUT', `/garages/${g.id}/alert-contacts/${p.id}/choices`, { as: a, body });

  let r = await choose(byMail, { by_text: ['lane_problem'], by_email: [] });
  assert.deepEqual([r.status, r.json.code], [409, 'alert_text_needs_phone']);
  r = await choose(byPhone, { by_text: [], by_email: ['lane_problem'] });
  assert.deepEqual([r.status, r.json.code], [409, 'alert_email_needs_email']);
  await holds();
  for (const bad of [{ by_text: ['no_such_alert'], by_email: [] }, { by_text: ['lane_problem', 'lane_problem'], by_email: [] }, { by_text: 'lane_problem', by_email: [] }, { by_text: [] }]) {
    r = await choose(both, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }

  r = await choose(both, { by_text: ['card_payments_stopped', 'lane_problem'], by_email: ['garage_not_answering'] });
  assert.equal(r.status, 200, r.text);
  // Kept in the list's order, whatever order they were sent in.
  assert.deepEqual(r.json.contact.by_text, ['lane_problem', 'card_payments_stopped']);
  await holds();

  // The phone taken away: its texts go with it, in the same change, and the answer says which.
  const since = new Set((await linesOf(a.tenant)).map((l) => l.id));
  r = await call(base, 'PATCH', `/garages/${g.id}/alert-contacts/${both.id}`, { as: a, body: { phone: null } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.turned_off, { by_text: ['lane_problem', 'card_payments_stopped'], by_email: [] });
  assert.deepEqual([r.json.contact.phone, r.json.contact.by_text, r.json.contact.by_email], [null, [], ['garage_not_answering']]);
  const [line] = (await linesOf(a.tenant)).filter((l) => !since.has(l.id));
  assert.deepEqual([line.action, line.before, line.after], ['alert_contact.change', { phone: 'given', by_text: ['lane_problem', 'card_payments_stopped'] }, { phone: 'none', by_text: [] }]);
  await holds();

  // The last way to reach someone cannot go.
  r = await call(base, 'PATCH', `/garages/${g.id}/alert-contacts/${both.id}`, { as: a, body: { email: null } });
  assert.deepEqual([r.status, r.json.code], [400, 'alert_contact_unreachable']);
  // An address replaced keeps its choices; one taken away (with a phone given) drops them.
  r = await call(base, 'PATCH', `/garages/${g.id}/alert-contacts/${both.id}`, { as: a, body: { email: 'both.new@example.com' } });
  assert.deepEqual([r.status, r.json.contact.by_email, r.json.turned_off], [200, ['garage_not_answering'], { by_text: [], by_email: [] }]);
  r = await call(base, 'PATCH', `/garages/${g.id}/alert-contacts/${both.id}`, { as: a, body: send({ email: null, phone: '+52 55 1234 5678' }) });
  assert.deepEqual([r.status, r.json.turned_off.by_email, r.json.contact.by_email], [200, ['garage_not_answering'], []]);
  await holds();

  // The database holds it too, whoever writes.
  await assert.rejects(withTenant(a.tenant, (c) => c.query("UPDATE alert_contacts SET by_text = '{lane_problem}' WHERE id = $1", [byMail.id])), /alert_contacts_text_needs_phone/);
  await assert.rejects(withTenant(a.tenant, (c) => c.query("UPDATE alert_contacts SET by_email = '{lane_problem}' WHERE id = $1", [byPhone.id])), /alert_contacts_email_needs_email/);
  await assert.rejects(withTenant(a.tenant, (c) => c.query('UPDATE alert_contacts SET confirmed = true WHERE id = $1', [byPhone.id])), /alert_contacts_not_confirmed_yet/);
  await holds();
});

// ---------------------------------------------------------------------------
// 4
// ---------------------------------------------------------------------------

test('BOUNDS: the 26th person and an over-long name are refused by name, by the route and by the database', async () => {
  const g = await newGarage(base, a);
  const long = 'N'.repeat(alerts.NAME_MAX + 1);
  let r = await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { as: a, body: send({ name: long, email: 'long.name@example.com' }) });
  assert.deepEqual([r.status, r.json.code], [400, 'alert_contact_name_refused']);
  for (const name of ['', '   ', 'Tab\there', 'Zero​width', 'Call 5550101234', 'mail me@example.com']) {
    r = await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { as: a, body: send({ name, email: 'name.rule@example.com' }) });
    assert.deepEqual([r.status, r.json.code], [400, 'alert_contact_name_refused'], JSON.stringify(name));
  }
  assert.equal((await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { as: a, body: send({ name: 'N'.repeat(alerts.NAME_MAX), email: 'eighty@example.com' }) })).status, 201);

  // 24 more, 20 of them at once: exactly 25 are kept.
  for (let i = 0; i < 4; i += 1) await addPerson(a, g.id, { name: `Person ${i}`, email: `person.${i}@example.com` });
  const racing = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    call(base, 'POST', `/garages/${g.id}/alert-contacts`, { as: a, body: send({ name: `Racer ${i}`, email: `racer.${i}@example.com` }) })));
  assert.deepEqual(racing.map((x) => x.status).sort(), [...Array(20).fill(201), ...Array(10).fill(409)]);
  assert.ok(racing.filter((x) => x.status === 409).every((x) => x.json.code === 'alert_contacts_full'));
  assert.equal((await contacts(a.tenant, g.id)).length, alerts.MAX_CONTACTS);
  r = await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { as: a, body: send({ name: 'The 26th', email: 'the.26th@example.com' }) });
  assert.deepEqual([r.status, r.json.code], [409, 'alert_contacts_full']);

  // The database: the 26th and a long name, written straight in.
  await assert.rejects(withTenant(a.tenant, (c) =>
    c.query("INSERT INTO alert_contacts (tenant_id, garage_id, name, email) VALUES ($1, $2, 'Direct 26th', 'direct@example.com')", [a.tenant, g.id])), /alert_contacts_full/);
  const other = await newGarage(base, a);
  await assert.rejects(withTenant(a.tenant, (c) =>
    c.query("INSERT INTO alert_contacts (tenant_id, garage_id, name, email) VALUES ($1, $2, $3, 'direct@example.com')", [a.tenant, other.id, long])), /alert_contacts_name_is_bounded/);
  await assert.rejects(withTenant(a.tenant, (c) =>
    c.query("INSERT INTO alert_contacts (tenant_id, garage_id, name, email) VALUES ($1, $2, $3, 'direct@example.com')", [a.tenant, other.id, 'Zero​width'])), /alert_contacts_name_is_bounded/);
  assert.equal((await contacts(a.tenant, g.id)).length, alerts.MAX_CONTACTS);
});

// ---------------------------------------------------------------------------
// 5
// ---------------------------------------------------------------------------

test('NO CONTACT DETAILS IN ANY LOG: after every route and every change kind, the change log, the security log and the server output hold no phone number and no email address, as typed or as kept', async () => {
  const g = await newGarage(base, a);
  const theirs = await newGarage(base, b);
  const p = await addPerson(a, g.id, { name: 'Every kind', phone: '(555) 010-4100', email: 'every.kind@example.com', language: 'es' });
  const q = await addPerson(a, g.id, { name: 'Second', phone: '+44 20 7946 0101' });
  const steps = [
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { phone: '555.010.4101' }],
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { email: 'every.kind.new@example.com', name: 'Every kind 2' }],
    ['PUT', `/garages/${g.id}/alert-contacts/${p.id}/choices`, { by_text: ['lane_problem', 'lane_not_answering'], by_email: ['card_payments_stopped'] }],
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { phone: null }],
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { phone: '+1 555 010 4102', language: 'en' }],
    // Refused: a bad number, a bad address, text with no phone, another account's.
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { phone: '555-010-41O2' }],
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { email: 'every kind@example.com' }],
    ['POST', `/garages/${g.id}/alert-contacts`, { name: 'Refused 555 0104103', phone: '5550104103' }],
    ['POST', `/garages/${theirs.id}/alert-contacts`, { name: 'Not mine', phone: '555 010 4104', email: 'not.mine@example.com' }],
    ['DELETE', `/garages/${g.id}/alert-contacts/${q.id}`, undefined],
    ['DELETE', `/garages/${g.id}/alert-contacts/${p.id}`, undefined],
  ];
  for (const [method, path, body] of steps) await call(base, method, path, { as: a, body: send(body) });
  // With no sign-in at all, and from another site: the security log and the caller's own log.
  await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { body: send({ name: 'Nobody', phone: '555 010 4105', email: 'nobody.here@example.com' }) });
  await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { as: a, origin: FOREIGN_ORIGIN, body: send({ name: 'Elsewhere', phone: '555 010 4106' }) });

  const kinds = new Set((await linesOf(a.tenant)).filter((l) => l.action.startsWith('alert_contact.')).map((l) => `${l.outcome}:${l.action}`));
  for (const k of ['done:alert_contact.add', 'done:alert_contact.change', 'done:alert_contact.choices', 'done:alert_contact.remove', 'refused:alert_contact.change', 'refused:alert_contact.add']) {
    assert.ok(kinds.has(k), `no ${k} line was made to scan`);
  }

  const { lines, security } = await ownerDb(async (c) => ({
    lines: (await c.query('SELECT * FROM garage_changes WHERE tenant_id = ANY($1)', [[a.tenant, b.tenant]])).rows,
    security: (await c.query('SELECT * FROM platform_security_log WHERE coalesce(last_at, at) >= $1', [STARTED])).rows,
  }));
  assert.ok(lines.length > 20 && security.length >= 1, `${lines.length} lines and ${security.length} security lines scanned`);
  const logs = JSON.stringify([lines, security]);
  const output = printed.join('');

  // Each detail as typed, as kept, and as its bare digits.
  const forms = new Set();
  for (const d of details) {
    // A fragment no one could be reached at (`@example.com`) is every owner's email's ending.
    if (d.trim().length < 7 || d.trim().startsWith('@')) continue;
    forms.add(d.trim());
    for (const kept of [() => alerts.phoneField(d), () => alerts.emailField(d)]) {
      try { forms.add(kept()); } catch { /* a refused one is scanned as typed */ }
    }
    const digits = d.replace(/[^0-9]/g, '');
    if (digits.length >= 7) forms.add(digits.slice(-7));
  }
  assert.ok(forms.size > 60, `${forms.size} forms scanned`);
  const inLogs = [...forms].filter((f) => logs.includes(f));
  const inOutput = [...forms].filter((f) => output.includes(f));
  assert.deepEqual(inLogs, [], 'a phone number or email address is in a log');
  assert.deepEqual(inOutput, [], 'a phone number or email address was printed');
  // And nothing shaped like one in a line about a person.
  for (const l of lines.filter((x) => x.subject_kind === 'alert_contact')) {
    const text = JSON.stringify([l.subject_name, l.before, l.after]);
    assert.equal(/@|\d{7,}/.test(text.replace(/[\s().+-]/g, '')), false, `line ${l.id} holds something shaped like a number or an address`);
  }
});

test('the guard itself: a line about a person that holds their phone or email is refused before it is written', async () => {
  const ctx = changes.context({ tenantId: a.tenant, actor: { kind: 'owner', id: a.userId, name: a.email } });
  ctx.private.push('+15550104200');
  const g = await newGarage(base, a);
  const write = (after) => withTenant(a.tenant, (c) =>
    changes.record(c, ctx, { garageId: g.id, action: 'alert_contact.change', subject: { kind: 'alert_contact', id: null, name: 'Guarded' }, before: {}, after }));
  await assert.rejects(write({ phone: '+15550104200' }), changes.ContactDetailInLine);
  await assert.rejects(write({ note: 'call 555 010 4299' }), changes.ContactDetailInLine);
  await assert.rejects(write({ note: 'guarded@example.com' }), changes.ContactDetailInLine);
  await withTenant(a.tenant, (c) => changes.record(c, ctx, { garageId: g.id, action: 'alert_contact.change', subject: { kind: 'alert_contact', id: null, name: 'Guarded' }, before: { phone: 'given' }, after: { phone: 'changed' } }));
  assert.equal(ctx.count, 1, 'a line that says only what changed is written');
});

// ---------------------------------------------------------------------------
// 6 (with test/change-log.test.js)
// ---------------------------------------------------------------------------

test('A PERSON\'S CHANGE AND ITS LINE ARE ONE TRANSACTION: the row and its line were written by the same transaction, on every write that leaves a row', async () => {
  const g = await newGarage(base, a);
  const xmin = (sql, id) => withTenant(a.tenant, async (c) => (await c.query(sql, [id])).rows[0]?.xmin);
  const lineOf = async (since) => (await linesOf(a.tenant)).filter((l) => !since.has(l.id));
  const ids = async () => new Set((await linesOf(a.tenant)).map((l) => l.id));
  let person;
  const writes = [
    ['add', async () => { person = await addPerson(a, g.id, { name: 'One transaction', phone: '555 010 7000', email: 'one.tx@example.com' }); }],
    ['change', () => call(base, 'PATCH', `/garages/${g.id}/alert-contacts/${person.id}`, { as: a, body: { name: 'One transaction 2' } })],
    ['choices', () => call(base, 'PUT', `/garages/${g.id}/alert-contacts/${person.id}/choices`, { as: a, body: { by_text: ['lane_problem'], by_email: ['lane_problem'] } })],
    ['phone taken away', () => call(base, 'PATCH', `/garages/${g.id}/alert-contacts/${person.id}`, { as: a, body: { phone: null } })],
  ];
  for (const [what, run] of writes) {
    const since = await ids();
    await run();
    const lines = await lineOf(since);
    assert.equal(lines.length, 1, `${what}: ${lines.length} lines`);
    const row = await xmin('SELECT xmin::text FROM alert_contacts WHERE id = $1', person.id);
    const line = await xmin('SELECT xmin::text FROM garage_changes WHERE id = $1', lines[0].id);
    assert.equal(line, row, `${what}: the line was written by another transaction than the change`);
  }
});

// ---------------------------------------------------------------------------
// 7
// ---------------------------------------------------------------------------

test('THE CHECKLIST STEP IS THE DATA: alerts after card readers, done when every alert has someone to tell; the open step is the same with it or without', async () => {
  const read = async (g) => (await call(base, 'GET', `/garages/${g.id}/setup`, { as: a })).json.setup;
  const step = (s, key) => s.steps.find((x) => x.key === key);
  assert.deepEqual(STEP_KEYS.slice(-3), ['card_readers', 'alerts', 'open']);

  const covered = await newGarage(base, a, { transient_available: true });
  const gap = await newGarage(base, a, { transient_available: true });
  await newLane(base, a, covered.id, 'In', 'entry');
  await newLane(base, a, gap.id, 'In', 'entry');
  const nothing = await read(covered);
  assert.deepEqual(step(nothing, 'alerts'), {
    key: 'alerts', done: false,
    facts: { people: 0, alerts: alerts.ALERT_KEYS.map((key) => ({ key, by_text: 0, by_email: 0 })), nobody_told: alerts.ALERT_KEYS },
  });
  const openBefore = step(nothing, 'open');

  const one = await addPerson(a, covered.id, { name: 'Texts', phone: '555 010 5000' });
  const two = await addPerson(a, covered.id, { name: 'Emails', email: 'emails@example.com' });
  const choose = (g, p, body) => call(base, 'PUT', `/garages/${g.id}/alert-contacts/${p.id}/choices`, { as: a, body });
  assert.equal((await choose(covered, one, { by_text: ['lane_problem', 'lane_not_answering', 'garage_not_answering'], by_email: [] })).status, 200);
  assert.equal((await choose(covered, two, { by_text: [], by_email: ['card_payments_stopped', 'attendant_link_dropped', 'lane_problem'] })).status, 200);

  const three = await addPerson(a, gap.id, { name: 'Most', phone: '555 010 5001', email: 'most@example.com' });
  assert.equal((await choose(gap, three, { by_text: ['lane_problem', 'lane_not_answering'], by_email: ['garage_not_answering', 'card_payments_stopped'] })).status, 200);

  const done = await read(covered);
  const notYet = await read(gap);
  assert.equal(step(done, 'alerts').done, true);
  assert.deepEqual(step(done, 'alerts').facts.nobody_told, []);
  assert.deepEqual(step(done, 'alerts').facts.alerts.find((x) => x.key === 'lane_problem'), { key: 'lane_problem', by_text: 1, by_email: 1 });
  assert.equal(step(notYet, 'alerts').done, false);
  assert.deepEqual(step(notYet, 'alerts').facts.nobody_told, ['attendant_link_dropped']);
  // The read and the rows say the same.
  const rows = await contacts(a.tenant, gap.id);
  for (const x of step(notYet, 'alerts').facts.alerts) {
    assert.equal(x.by_text, rows.filter((r) => r.by_text.includes(x.key)).length);
    assert.equal(x.by_email, rows.filter((r) => r.by_email.includes(x.key)).length);
  }
  // The open step: the same whether the alerts are covered, not covered, or untouched.
  assert.deepEqual(step(done, 'open'), openBefore);
  assert.deepEqual(step(notYet, 'open'), openBefore);
  assert.equal(step(notYet, 'open').facts.not_done.includes('alerts'), false);

  // Taking the phone away uncovers what only texts covered.
  assert.equal((await call(base, 'PATCH', `/garages/${covered.id}/alert-contacts/${one.id}`, { as: a, body: { phone: null, email: 'texts.now.email@example.com' } })).status, 200);
  assert.deepEqual(step(await read(covered), 'alerts').facts.nobody_told, ['lane_not_answering', 'garage_not_answering']);
});

test('THE ALERTS READ: the five alerts in their order, the quiet setting read from the platform, the people with what each gets, and nothing sent', async () => {
  const g = await newGarage(base, a);
  const p = await addPerson(a, g.id, { name: 'Reader', phone: '555 010 6000', language: 'es' });
  const r = await call(base, 'GET', `/garages/${g.id}/alerts`, { as: a });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['alerts', 'contacts', 'max_contacts', 'quiet_minutes', 'sending']);
  assert.deepEqual(r.json.alerts.map((x) => x.key), ['lane_problem', 'lane_not_answering', 'garage_not_answering', 'card_payments_stopped', 'attendant_link_dropped']);
  assert.deepEqual(r.json.alerts.find((x) => x.key === 'lane_not_answering').needs, ['quiet_minutes']);
  assert.equal(r.json.sending, false);
  assert.equal(r.json.max_contacts, 25);
  const lanes = await call(base, 'GET', `/garages/${g.id}/lanes`, { as: a });
  assert.equal(r.json.quiet_minutes, lanes.json.quiet_minutes, 'the quiet setting is the one the lanes read uses');
  assert.deepEqual(r.json.contacts, [{ id: p.id, name: 'Reader', phone: '+15550106000', email: null, language: 'es', confirmed: false, by_text: [], by_email: [] }]);
});

// ---------------------------------------------------------------------------
// 8
// ---------------------------------------------------------------------------

/** The round's own code: every file that reads or writes a person to tell. */
export const ROUND_FILES = ['src/alerts.js', 'src/setup.js', 'migrations/0029_alert_contacts.sql'];

test('NOTHING IS SENT: no provider package, no network call, no key read, anywhere in the round\'s code', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const PROVIDERS = /twilio|sendgrid|mailgun|postmark|nodemailer|vonage|nexmo|plivo|messagebird|sinch|telnyx|bandwidth|aws-sdk|@aws-sdk|resend|sparkpost|mailchimp|mandrill|ses|sns|smtp|firebase/i;
  assert.deepEqual(deps.filter((d) => PROVIDERS.test(d)), [], 'a provider package is a dependency');
  const SENDING = [
    [/\bfetch\s*\(/, 'a network call (fetch)'],
    [/from\s+['"]node:(https?|net|tls|dgram|dns|child_process)['"]/, 'a network or process module'],
    [/require\(\s*['"](https?|net|tls|child_process)['"]\s*\)/, 'a network or process module'],
    [/process\.env\b/, 'a setting or key read'],
    [/startSetting\(\s*['"][A-Z_]*(KEY|TOKEN|SECRET|SID|PASSWORD)/, 'a key read'],
    [/\b(sendSms|sendText|sendEmail|sendMail|messages\.create)\b/, 'a send call'],
    [/\bhttp\s*\(/, 'a network call (http)'],
  ];
  const found = [];
  for (const file of ROUND_FILES) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      // Comments say what is not done; only code is scanned.
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/--.*$/gm, '');
    for (const [shape, what] of SENDING) if (shape.test(text)) found.push(`${file}: ${what}`);
  }
  assert.deepEqual(found, [], 'the round\'s code sends, or could');
});
