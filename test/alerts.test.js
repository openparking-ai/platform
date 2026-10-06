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
 *   5  no typed contact text in any stored line (fix round 2): a line about
 *      a person holds their id and what kind of change it was, never their
 *      name, phone number or email address; the change log, the security
 *      log and the server's output hold none of them, in any form, read as
 *      raw text and as digits only, after every route and every change kind;
 *      a removed person is named in no line, on any read
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
import { pool, withTenant, createTenant } from './helpers.js';
import * as alerts from '../src/alerts.js';
import * as changes from '../src/changes.js';
import { DIGIT_ZEROS } from '../src/digits.js';
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
// And every name, refused or kept: a number hidden in one must not reach a log either.
const names = new Set();
const send = (body) => {
  for (const k of ['phone', 'email']) if (typeof body?.[k] === 'string') details.add(body[k]);
  if (typeof body?.name === 'string') names.add(body.name);
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

  // The database holds it too: a row written straight in, on another account's garage, is refused.
  await assert.rejects(withTenant(a.tenant, (c) =>
    c.query("INSERT INTO alert_contacts (tenant_id, garage_id, name, email) VALUES ($1, $2, 'Direct', 'direct@example.com')", [a.tenant, theirs.id])), /alert_contacts_garage/);
  await assert.rejects(withTenant(a.tenant, (c) =>
    c.query('UPDATE alert_contacts SET garage_id = $2 WHERE id = $1', [myPerson.id, theirs.id])), /alert_contacts_garage/);
  assert.equal(await snapshot(), was);
});

test('YOUR GARAGE ONLY, within the account: a person reached through another garage of the same account is not found and nothing changes, on every person route', async () => {
  const here = await newGarage(base, a);
  const there = await newGarage(base, a);
  const person = await addPerson(a, here.id, { name: 'Here only', phone: '555-010-2100', email: 'here.only@example.com' });
  const snapshot = async () => JSON.stringify([await contacts(a.tenant, here.id), await contacts(a.tenant, there.id)]);
  const was = await snapshot();
  const linesBefore = (await linesOf(a.tenant)).filter((l) => l.outcome === 'done').length;
  for (const via of ['session', 'key']) {
    for (const [method, path, body] of [
      ['PATCH', `/garages/${there.id}/alert-contacts/${person.id}`, { name: 'Moved' }],
      ['PATCH', `/garages/${there.id}/alert-contacts/${person.id}`, { phone: null }],
      ['PUT', `/garages/${there.id}/alert-contacts/${person.id}/choices`, { by_text: ['lane_problem'], by_email: ['lane_problem'] }],
      ['DELETE', `/garages/${there.id}/alert-contacts/${person.id}`, undefined],
    ]) {
      const r = await call(base, method, path, { as: a, via, body: send(body) });
      assert.deepEqual([r.status, r.json?.code], [404, 'alert_contact_not_found'], `${via} ${method} ${path}: ${r.status} ${r.text}`);
    }
  }
  assert.equal(await snapshot(), was, 'a person was changed through another garage of the same account');
  assert.equal((await linesOf(a.tenant)).filter((l) => l.outcome === 'done').length, linesBefore, 'a change line was written');
  // The other garage's people, read, do not hold them either.
  const read = await call(base, 'GET', `/garages/${there.id}/alerts`, { as: a });
  assert.deepEqual(read.json.contacts, []);
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
  for (const name of ['', '   ', 'Tab\there', 'Zero​width']) {
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
// 4b -- what an owner types about a person is theirs, and never in a log
// ---------------------------------------------------------------------------

/**
 * Digits Unicode gives a value that are not decimal digits, and that NFKC
 * leaves as they are -- the re-gate's forms -- and the Han numerals: read by
 * the scan below from this table of its own, not from the platform's code.
 */
const OTHER_DIGITS = new Map([
  ...[...'❶❷❸❹❺❻❼❽❾'].map((c, i) => [c, i + 1]), ['⓿', 0],
  ...[...'➀➁➂➃➄➅➆➇➈'].map((c, i) => [c, i + 1]),
  ...[...'➊➋➌➍➎➏➐➑➒'].map((c, i) => [c, i + 1]),
  ...[...'⓵⓶⓷⓸⓹⓺⓻⓼⓽'].map((c, i) => [c, i + 1]),
  ...[...'፩፪፫፬፭፮፯፰፱'].map((c, i) => [c, i + 1]),
  ...[...'〇一二三四五六七八九'].map((c, i) => [c, i]),
]);

/**
 * A digit's value, read here from the running engine's own idea of a digit
 * and NOT from src/digits.js, so the scan below does not lean on the code it
 * checks: a decimal digit's value is its distance from the start of its
 * run of digits, modulo 10 (Unicode keeps each script's 0-9 together); any
 * other is OTHER_DIGITS's.
 */
function scanDigitValue(ch) {
  if (OTHER_DIGITS.has(ch)) return OTHER_DIGITS.get(ch);
  if (!/\p{Nd}/u.test(ch)) return -1;
  let cp = ch.codePointAt(0);
  let back = 0;
  while (/\p{Nd}/u.test(String.fromCodePoint(cp - 1))) { cp -= 1; back += 1; }
  return back % 10;
}

/** The text's digits as plain 0-9, after compatibility normalisation, everything else dropped. */
function scanDigits(text) {
  let out = '';
  for (const ch of String(text).normalize('NFKC')) {
    const v = scanDigitValue(ch);
    if (v >= 0) out += v;
  }
  return out;
}

const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMES = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?/g;

/** Every string inside a value, keys and all. */
function* textsOf(value) {
  if (value instanceof Date) return;
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* textsOf(v);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { yield k; yield* textsOf(v); }
}

/**
 * THE SCAN, as digits: which of `numbers` (each a phone number in any form)
 * sits in any text of `logs`. Each text is read as its digits only -- ids and
 * times taken out first, as they are the platform's own -- so no separator,
 * letter or script between a number's digits hides it.
 */
function numbersIn(logs, numbers) {
  // A number's last 7 digits find it, with or without its country.
  const wanted = [...new Set(numbers.map(scanDigits).filter((d) => d.length >= 7).map((d) => d.slice(-7)))];
  const found = new Set();
  for (const text of textsOf(logs)) {
    const digits = scanDigits(text.replace(UUIDS, ' ').replace(TIMES, ' '));
    for (const d of wanted) if (digits.includes(d)) found.add(d);
  }
  return [...found];
}

/** THE SCAN, as raw text: which of `typed` sits in any text of `logs`, as typed or normalised. */
function typedIn(logs, typed) {
  const wanted = [...new Set(typed.flatMap((t) => [t.trim(), t.trim().normalize('NFKC')]))].filter((t) => t.length >= 4);
  const found = new Set();
  for (const text of textsOf(logs)) {
    for (const t of wanted) if (text.includes(t) || text.normalize('NFKC').includes(t)) found.add(t);
  }
  return [...found];
}

/** A number written every way the first fix round named, and a generated set besides. */
function numberForms(seed = 7) {
  const arabicIndic = (d) => [...d].map((c) => String.fromCodePoint(0x660 + Number(c))).join('');
  const easternArabic = (d) => [...d].map((c) => String.fromCodePoint(0x6F0 + Number(c))).join('');
  const devanagari = (d) => [...d].map((c) => String.fromCodePoint(0x966 + Number(c))).join('');
  const fullWidth = (d) => [...d].map((c) => String.fromCodePoint(0xFF10 + Number(c))).join('');
  const mathBold = (d) => [...d].map((c) => String.fromCodePoint(0x1D7CE + Number(c))).join('');
  const forms = [
    ['commas', 'Maria 555,010,0199'],
    ['slashes', 'Bay 1/2/3/4/5/6/7'],
    ['Arabic-Indic digits', `Ana ${arabicIndic('5550100198')}`],
    ['Eastern Arabic digits', `Ana ${easternArabic('5550100197')}`],
    ['Devanagari digits', `Ravi ${devanagari('5550100196')}`],
    ['full-width digits', `Kim ${fullWidth('5550100195')}`],
    ['full-width with full-width commas', `Kim ${fullWidth('555')}，${fullWidth('010')}，${fullWidth('0194')}`],
    ['mathematical digits', `Lee ${mathBold('5550100193')}`],
    ['circled digits', 'Joe ⑤⑤⑤⓪①⓪⓪①⑨②'],
    ['superscript digits', 'Sam ⁵⁵⁵⁰¹⁰⁰¹⁹¹'],
    ['digits split by letters', 'Pat 5a5b5c0d1e0f0g1h9i0'],
    ['digits split by words', 'Pat five 555 then 010 then 0189'],
    ['dots', 'Joe 555.010.0188'],
    ['spaces', 'Joe 555 010 0187'],
    ['no-break spaces', 'Joe 555 010 0186'],
    ['underscores and bars', 'Joe 555_010|0185'],
    ['one digit a word', 'Ed 5 5 5 0 1 0 0 1 8 4'],
    ['scripts mixed', `Mo 5${arabicIndic('5')}${devanagari('5')}0${fullWidth('1')}0${mathBold('0')}183`],
    ['seven, the fewest', 'Unit 1-2-3-4-5-6-7'],
  ];
  // The generated set: 7 to 12 digits, each in a script drawn at random, with
  // anything at all between them.
  let state = seed;
  const rand = (n) => { state = (state * 1103515245 + 12345) % 2147483648; return state % n; };
  const scripts = [(c) => c, arabicIndic, easternArabic, devanagari, fullWidth, mathBold, (c) => String.fromCodePoint(0xE50 + Number(c)), (c) => String.fromCodePoint(0x9E6 + Number(c))];
  const between = [',', '/', ' ', '.', '-', '_', '|', ';', ':', '·', '~', '*', 'x', 'o', 'ab', ' ', '，', '／', '、', '#', "'", '"', ''];
  for (let i = 0; i < 60; i += 1) {
    const n = 7 + rand(6);
    let text = `Gen ${i} `;
    let digits = '';
    for (let k = 0; k < n; k += 1) {
      const d = String((5 + k + rand(10)) % 10);
      digits += d;
      text += scripts[rand(scripts.length)](d) + between[rand(between.length)];
    }
    forms.push([`generated ${i} (${digits})`, text.trim().slice(0, 80)]);
  }
  return forms;
}

/**
 * The re-gate's forms: a number no count of digits finds -- digits that are
 * not decimal, words, look-alike letters, Han and Roman numerals -- and the
 * plain ones. Each a name, as an owner could type it.
 */
const RE_GATE_FORMS = [
  ['negative circled digits', 'Maria ❺❺❺⓿❶⓿⓿❶❾❾'],
  ['sans-serif circled digits', 'Marta ➄➄➄➀➀➈➈'],
  ['double circled digits', 'Marco ⓹⓹⓹⓵⓵⓽⓽'],
  ['Ethiopic digits', 'Abebe ፭፭፭፩፩፱፱'],
  ['words', 'Maria five five five oh one oh oh one nine nine'],
  ['look-alike letters', 'Maria 555-OlO-Ol99'],
  ['Han numerals', 'Maria 五五五〇一〇〇一九九'],
  ['Roman numerals', 'Maria ⅤⅤⅤ ⅠⅠ ⅨⅨ'],
  ['plain digits', 'Maria 555-010-0199'],
  ['an address', 'Maria maria.n@example.com'],
  ['a full-width address', 'Maria maria.w＠example.com'],
];

const AT_FORMS = [['@', 'Mail me@example'], ['full-width @', 'Mail me＠example'], ['small @', 'Mail me﹫example']];

test('A NAME IS THE OWNER\'S: a name with a number in any form, or an address, is kept as typed -- by the route and by the database', async () => {
  const g = await newGarage(base, a);
  const person = await addPerson(a, g.id, { name: 'Renamed later', email: 'renamed.later@example.com' });
  const insert = (name) => withTenant(a.tenant, (c) =>
    c.query("INSERT INTO alert_contacts (tenant_id, garage_id, name, email) VALUES ($1, $2, $3, 'direct.name@example.com') RETURNING id", [a.tenant, g.id, name]));
  const forms = [...RE_GATE_FORMS, ...AT_FORMS, ...numberForms().slice(0, 25)];
  for (const [what, name] of forms) {
    const r = await call(base, 'PATCH', `/garages/${g.id}/alert-contacts/${person.id}`, { as: a, body: send({ name }) });
    assert.deepEqual([r.status, r.json?.contact?.name], [200, name], `${what}: ${JSON.stringify(name)} -> ${r.status} ${r.text}`);
    const { rows: [row] } = await insert(name);
    await withTenant(a.tenant, (c) => c.query('DELETE FROM alert_contacts WHERE id = $1', [row.id]));
  }
});

test('the digits the line guard reads lack none the running engine knows', () => {
  const missing = [];
  for (let cp = 0; cp <= 0x10FFFF; cp += 1) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;
    if (/\p{Nd}/u.test(String.fromCodePoint(cp)) && !DIGIT_ZEROS.some((z) => cp >= z && cp <= z + 9)) missing.push(cp.toString(16));
  }
  assert.deepEqual(missing, [], 'digits the table lacks');
});

test('THE SCAN finds what was typed: a name planted in a line read back from the database is found as raw text, and a number in it as digits only; none is found where none is', async () => {
  const c = await createTenant('alerts-scan');
  const forms = [...numberForms(11), ...RE_GATE_FORMS];
  const found = await withTenant(c, async (client) => {
    // Planted inside a transaction that is rolled back: the log can only be added to.
    await client.query('SAVEPOINT plant');
    try {
      for (const [, name] of forms) {
        await client.query(
          `INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name, action, subject_kind, subject_id, subject_name, before, after)
           VALUES ($1, NULL, 'done', 'owner', gen_random_uuid(), 'scan@example.com', 'lane.rename', 'lane', gen_random_uuid(), NULL, NULL, $2)`,
          [c, JSON.stringify({ name })],
        );
      }
      const { rows } = await client.query('SELECT * FROM garage_changes WHERE tenant_id = $1', [c]);
      return forms.map(([what, name]) => [what, typedIn(rows, [name]), numbersIn(rows, [name]), scanDigits(name).length]);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT plant');
    }
  });
  for (const [what, raw, numbers, digits] of found) {
    assert.ok(raw.length >= 1, `${what}: the scan did not find the planted name`);
    if (digits >= 7) assert.equal(numbers.length, 1, `${what}: the scan did not find the planted number`);
  }
  // The re-gate's digit forms are read as digits too.
  for (const what of ['negative circled digits', 'Ethiopic digits', 'Han numerals', 'double circled digits']) {
    assert.ok(found.find(([w]) => w === what)[3] >= 7, `${what}: the scan reads too few digits`);
  }
  // Each form's number as plain digits, found in each other written form.
  assert.deepEqual(numbersIn(['call 555 010 0199'], ['Maria 555,010,0199']), ['0100199']);
  assert.deepEqual(numbersIn([`a ${'٥٥٥٠١٠٠١٩٩'}`], ['+1 555-010-0199']), ['0100199']);
  assert.deepEqual(numbersIn(['call 555 010 0199'], ['Maria ❺❺❺⓿❶⓿⓿❶❾❾']), ['0100199']);
  // Ids and times are the platform's own; a few digits are not a number.
  assert.deepEqual(numbersIn([{ id: 'a5550100-1990-4000-8000-000000000000', at: '2026-10-05T20:20:00.000Z', name: 'Bay 12' }], ['555-010-0199', '2026100520']), []);
  assert.deepEqual(typedIn([{ action: 'alert_contact.change', after: { name: 'changed' } }], ['Maria 555-010-0199']), []);
});

// ---------------------------------------------------------------------------
// 5
// ---------------------------------------------------------------------------

/** What a stored line about a person may hold besides ids and times: the platform's own words, lower-case and underscores. */
const PLATFORM_WORD = /^[a-z_]+$/;

test('NO TYPED CONTACT TEXT IN ANY STORED LINE: after every route and every change kind, no name, phone number or email address -- in any form -- is in the change log, the security log or the server output, read as raw text and as digits only', async () => {
  const g = await newGarage(base, a);
  const theirs = await newGarage(base, b);
  const p = await addPerson(a, g.id, { name: 'Every kind', phone: '(555) 010-4100', email: 'every.kind@example.com', language: 'es' });
  const q = await addPerson(a, g.id, { name: 'Second person', phone: '+44 20 7946 0101' });
  const nameForms = [...RE_GATE_FORMS, ...AT_FORMS, ...numberForms(5).slice(0, 25)].map(([, n]) => n);
  // An address and a number written in the re-gate's forms, as a phone or an address: refused, and not in the line either.
  const oddPhones = ['❺❺❺⓿❶⓿⓿❶❾❾', '፭፭፭፩፩፱፱፱፱', 'five five five oh one oh', '555-OlO-Ol99', '五五五〇一〇〇一九九'];
  const oddEmails = ['maria.❺❺❺@example.com', 'maria five@example.com', 'maria.n＠example.com'];
  const steps = [
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { phone: '555.010.4101' }],
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { email: 'every.kind.new@example.com', name: 'Every kind renamed' }],
    ['PUT', `/garages/${g.id}/alert-contacts/${p.id}/choices`, { by_text: ['lane_problem', 'lane_not_answering'], by_email: ['card_payments_stopped'] }],
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { phone: null }],
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { phone: '+1 555 010 4102', language: 'en' }],
    // Every name form, as a change and as an add (each added one removed again).
    ...nameForms.map((name) => ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { name }]),
    ...RE_GATE_FORMS.map(([, name]) => ['POST', `/garages/${g.id}/alert-contacts`, { name, email: 'name.form@example.com', phone: '555 010 4110' }]),
    // Refused: a bad number, a bad address, in plain and the re-gate's forms; a name too long; text with no phone; another account's.
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { phone: '555-010-41O2' }],
    ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { email: 'every kind@example.com' }],
    ...oddPhones.map((phone) => ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { phone }]),
    ...oddEmails.map((email) => ['PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { email }]),
    ['POST', `/garages/${g.id}/alert-contacts`, { name: `Maria 555 010 0199 ${'x'.repeat(80)}`, phone: '5550104103' }],
    ['PUT', `/garages/${g.id}/alert-contacts/${q.id}/choices`, { by_text: [], by_email: ['lane_problem'] }],
    ['POST', `/garages/${theirs.id}/alert-contacts`, { name: 'Not mine 555 010 4104', phone: '555 010 4104', email: 'not.mine@example.com' }],
  ];
  for (const [method, path, body] of steps) await call(base, method, path, { as: a, body: send(body) });
  for (const c of await contacts(a.tenant, g.id)) {
    if (c.id !== p.id && c.id !== q.id) assert.equal((await call(base, 'DELETE', `/garages/${g.id}/alert-contacts/${c.id}`, { as: a })).status, 204);
  }
  await call(base, 'DELETE', `/garages/${g.id}/alert-contacts/${q.id}`, { as: a });
  await call(base, 'DELETE', `/garages/${g.id}/alert-contacts/${p.id}`, { as: a });
  // With no sign-in at all, and from another site: the security log and the caller's own log.
  await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { body: send({ name: 'Nobody 555 010 4105', phone: '555 010 4105', email: 'nobody.here@example.com' }) });
  await call(base, 'POST', `/garages/${g.id}/alert-contacts`, { as: a, origin: FOREIGN_ORIGIN, body: send({ name: 'Elsewhere ❺❺❺⓿❶⓿⓿❶❾❽', phone: '555 010 4106' }) });
  // Typed text where an id goes: in the path, with no sign-in, which is refused before the id is read.
  const inPaths = ['Maria-5550100177', 'maria.p@example.com', 'Maria ❺❺❺⓿❶⓿⓿❶❼❼'];
  for (const text of inPaths) {
    send({ name: text });
    for (const [method, path] of [
      ['PATCH', `/garages/${g.id}/alert-contacts/${encodeURIComponent(text)}`],
      ['DELETE', `/garages/${g.id}/alert-contacts/${encodeURIComponent(text)}`],
      ['PUT', `/garages/${g.id}/alert-contacts/${encodeURIComponent(text)}/choices`],
      ['POST', `/garages/${g.id}/alert-contacts/${encodeURIComponent(text)}/more`],
    ]) {
      await call(base, method, path, { body: { name: text } });
      await call(base, method, path, { as: a, origin: FOREIGN_ORIGIN, body: { name: text } });
    }
  }
  // And in every spelling of the address the server takes for the contact
  // routes: any case, a trailing slash, a doubled slash, the garage's id in
  // capitals, characters encoded in the id. Each spelling carries its own
  // text, so a red names the spelling it came through.
  const spelled = (n) => `Maria-55501002${String(n).padStart(2, '0')}`;
  const spellings = [
    ['PATCH', '/api/v1/garages/G/alert-contacts/{id}'],
    ['PATCH', '/api/v1/garages/G/Alert-Contacts/{id}'],
    ['PATCH', '/api/v1/garages/G/ALERT-CONTACTS/{id}'],
    ['DELETE', '/api/v1/garages/G/aLeRt-CoNtAcTs/{id}'],
    ['PATCH', '/api/v1/garages/G/alert-contacts/{id}/'],
    ['DELETE', '/api/v1/garages/G/Alert-Contacts/{id}/'],
    ['PUT', '/api/v1/garages/G/alert-contacts/{id}/choices/'],
    ['PUT', '/api/v1/garages/G/Alert-Contacts/{id}/CHOICES'],
    ['POST', '/api/v1/garages/G/ALERT-CONTACTS/{id}/more'],
    ['PATCH', '/API/V1/GARAGES/G/ALERT-CONTACTS/{id}'],
    ['PATCH', '/api/v1//garages/G/Alert-Contacts/{id}'],
    ['PATCH', '/api/v1/garages/{GARAGE}/Alert-Contacts/{id}'],
    ['PATCH', '/api/v1/garages/G/alert-contacts/{encoded}'],
    ['PATCH', '/api/v1/garages/G/Alert-Contacts/{encoded}/'],
    ['PATCH', '/api/v1/garages/G/ALERT-CONTACTS/{id}%2Fchoices'],
  ].map(([method, shape], n) => {
    const text = spelled(n);
    const id = shape.includes('{encoded}') ? text.replace('M', '%4D').replace('5', '%35') : encodeURIComponent(text);
    const path = shape.replace('{GARAGE}', g.id.toUpperCase()).replace('/G/', `/${g.id}/`).replace(/\{(id|encoded)\}/, id);
    return { method, shape, text, sent: id, path };
  });
  for (const s of spellings) {
    send({ name: s.text });
    for (const headers of [{}, { cookie: a.cookie, origin: FOREIGN_ORIGIN }]) {
      const r = await fetch(`${base}${s.path}`, { method: s.method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: s.text }) });
      assert.ok([401, 403].includes(r.status), `${s.method} ${s.shape} was answered ${r.status}, not refused`);
    }
  }

  const kinds = new Set((await linesOf(a.tenant)).filter((l) => l.action.startsWith('alert_contact.')).map((l) => `${l.outcome}:${l.action}`));
  for (const k of ['done:alert_contact.add', 'done:alert_contact.change', 'done:alert_contact.choices', 'done:alert_contact.remove', 'refused:alert_contact.change', 'refused:alert_contact.add', 'refused:alert_contact.choices', 'refused:alert_contact.remove']) {
    assert.ok(kinds.has(k), `no ${k} line was made to scan`);
  }

  const { lines, security } = await ownerDb(async (c) => ({
    lines: (await c.query('SELECT * FROM garage_changes WHERE tenant_id = ANY($1)', [[a.tenant, b.tenant]])).rows,
    security: (await c.query('SELECT * FROM platform_security_log WHERE coalesce(last_at, at) >= $1', [STARTED])).rows,
  }));
  assert.ok(lines.length > 60 && security.length >= 1, `${lines.length} lines and ${security.length} security lines scanned`);
  // The test runner reports through the same stream in its own binary frames
  // (names, times, places); those are not the server's output.
  const output = printed.filter((chunk) => !chunk.includes('"\x04type"'));

  // Each stored line about a person: no name, and nothing but the platform's own words -- a red names the line.
  for (const l of lines.filter((x) => x.subject_kind === 'alert_contact')) {
    assert.equal(l.subject_name, null, `line ${l.id} (${l.action}) holds a name`);
    for (const text of textsOf([l.before, l.after])) assert.match(text, PLATFORM_WORD, `line ${l.id} (${l.action}) holds ${JSON.stringify(text)}`);
  }
  // RAW TEXT: every name, phone number and email address this file sent, as
  // typed, as kept and normalised.
  const typed = new Set();
  for (const d of [...details, ...names]) {
    // A fragment no one could be reached at (`@example.com`) is every owner's email's ending.
    if (d.trim().length < 6 || d.trim().startsWith('@')) continue;
    typed.add(d.trim());
    for (const kept of [() => alerts.phoneField(d), () => alerts.emailField(d)]) {
      try { typed.add(kept()); } catch { /* a refused one is scanned as typed */ }
    }
  }
  assert.ok(typed.size > 80, `${typed.size} typed texts scanned`);
  for (const form of [...RE_GATE_FORMS.map(([, n]) => n), ...oddPhones, ...oddEmails, ...inPaths, ...spellings.map((s) => s.text)]) assert.ok(typed.has(form), `${form} was not scanned`);
  // Each spelling of the address, by name: neither its text nor the id as it was sent is in a log.
  for (const s of spellings) {
    const held = [...lines, ...security].filter((l) => [s.text, s.sent].some((t) => JSON.stringify(l).includes(t)));
    assert.deepEqual(held.map((l) => l.request), [], `typed text sent through ${s.method} ${s.shape} is in a log`);
  }
  assert.deepEqual(typedIn([lines, security], [...typed]), [], 'something typed about a person is in a log');
  assert.deepEqual(typedIn(output, [...typed]), [], 'something typed about a person was printed');
  // DIGITS ONLY: every number sent, as a phone, in a name, in an address or a path.
  const numbers = [...typed].filter((d) => scanDigits(d).length >= 7);
  assert.ok(numbers.length > 60, `${numbers.length} numbers scanned`);
  assert.deepEqual(numbersIn([lines, security], numbers), [], 'a number typed about a person is in a log, written some way');
  assert.deepEqual(numbersIn(output, numbers), [], 'a number typed about a person was printed, written some way');
  // A refused attempt on a person names the route, never the path as it was sent.
  const ROUTES = new Set(['POST /api/v1/garages/:garageId/alert-contacts', 'PATCH /api/v1/garages/:garageId/alert-contacts/:contactId',
    'DELETE /api/v1/garages/:garageId/alert-contacts/:contactId', 'PUT /api/v1/garages/:garageId/alert-contacts/:contactId/choices',
    'POST /api/v1/garages/:garageId/alert-contacts/...']);
  const tried = [...lines, ...security].filter((l) => /alert-contacts/i.test(l.request ?? ''));
  assert.ok(tried.length >= 4, `${tried.length} refused attempts on a person`);
  // The mount is named as it was sent (`/API/V1`): the platform's own words, in the caller's case.
  for (const l of tried) assert.ok(ROUTES.has(l.request.replace(/^([A-Z]+) \/api\/v1\//i, '$1 /api/v1/')), `a refused attempt names ${JSON.stringify(l.request)}`);
});

test('REMOVAL REMOVES: a person is named in every line as they are named now; removed, every line about them says so and names no one, on every read', async () => {
  const g = await newGarage(base, a);
  const stays = await addPerson(a, g.id, { name: 'Stays named', email: 'stays.named@example.com' });
  const p = await addPerson(a, g.id, { name: 'Ravi before', phone: '555 010 4300' });
  await call(base, 'PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { as: a, body: send({ name: 'Ravi now', email: 'ravi.now@example.com' }) });
  await call(base, 'PATCH', `/garages/${g.id}/alert-contacts/${p.id}`, { as: a, body: send({ phone: '555 010 4301', language: 'es' }) });
  await call(base, 'PUT', `/garages/${g.id}/alert-contacts/${p.id}/choices`, { as: a, body: { by_text: ['card_payments_stopped'], by_email: ['lane_problem'] } });
  const read = async () => {
    const r = await call(base, 'GET', `/garages/${g.id}/changes`, { as: a });
    assert.equal(r.status, 200, r.text);
    return r.json.changes.filter((l) => l.subject.kind === 'alert_contact');
  };
  const about = (lines, id) => lines.filter((l) => l.subject.id === id);
  let lines = await read();
  assert.equal(about(lines, p.id).length, 4, 'add, two changes and the choices');
  for (const l of about(lines, p.id)) assert.deepEqual([l.subject.name, l.subject.removed], ['Ravi now', false], `${l.action}: named as they are now`);
  assert.equal(JSON.stringify(lines).includes('Ravi before'), false, 'the name before is still read');
  assert.deepEqual(about(lines, p.id).find((l) => l.after?.name).after, { name: 'changed', email: 'given' }, 'the name changed, said with no before and after');

  assert.equal((await call(base, 'DELETE', `/garages/${g.id}/alert-contacts/${p.id}`, { as: a })).status, 204);
  lines = await read();
  assert.equal(about(lines, p.id).length, 5, 'and the removal');
  for (const l of about(lines, p.id)) assert.deepEqual([l.subject.name, l.subject.removed], [null, true], `${l.action}: still named after the removal`);
  for (const l of about(lines, stays.id)) assert.deepEqual([l.subject.name, l.subject.removed], ['Stays named', false], 'another person lost their name');
  const refused = await call(base, 'GET', `/garages/${g.id}/refused-attempts`, { as: a });
  const stored = await ownerDb(async (c) => (await c.query('SELECT * FROM garage_changes WHERE tenant_id = $1', [a.tenant])).rows);
  for (const [where, value] of [['the change log read', lines], ['the refused attempts read', refused.json], ['the stored lines', stored]]) {
    assert.deepEqual(typedIn(value, ['Ravi before', 'Ravi now']), [], `${where} still names the removed person`);
  }
  // Every other kind of line still names its subject as it was written.
  const lane = await newLane(base, a, g.id, 'North gate', 'entry');
  const laneLine = (await call(base, 'GET', `/garages/${g.id}/changes`, { as: a })).json.changes.find((l) => l.subject.id === lane.id);
  assert.deepEqual([laneLine.subject.name, laneLine.subject.removed], ['North gate', false]);
});

test('the guard itself: a line about a person holds no name and nothing but the platform\'s words, and no line holds their phone or email -- refused before it is written, by the route\'s guard and by the database', async () => {
  const ctx = changes.context({ tenantId: a.tenant, actor: { kind: 'owner', id: a.userId, name: a.email } });
  ctx.private.push('+15550104200');
  const g = await newGarage(base, a);
  const person = (name = null) => ({ kind: 'alert_contact', id: null, name });
  const write = (after, subject = person()) => withTenant(a.tenant, (c) =>
    changes.record(c, ctx, { garageId: g.id, action: 'alert_contact.change', subject, before: {}, after }));
  await assert.rejects(write({ phone: '+15550104200' }), changes.ContactDetailInLine);
  await assert.rejects(write({ note: 'call 555 010 4299' }), changes.ContactDetailInLine);
  await assert.rejects(write({ note: 'guarded@example.com' }), changes.ContactDetailInLine);
  await assert.rejects(write({ name: 'maria' }), changes.ContactDetailInLine, 'a typed name in lower case');
  await assert.rejects(write({ name: 'changed' }, person('Guarded')), changes.ContactDetailInLine, 'a name as the subject');
  // However the name is written.
  for (const [what, text] of [...numberForms(13), ...AT_FORMS, ...RE_GATE_FORMS]) {
    await assert.rejects(write({ name: text }), changes.ContactDetailInLine, `${what}: ${JSON.stringify(text)} got through`);
    assert.throws(() => changes.assertContactLineWords({ subject: person(text), before: null, after: null }), changes.ContactDetailInLine, what);
  }
  // A line about something else still never holds the person's own number, written any way.
  for (const text of ['5,5,5,0,1,0,4,2,0,0', '555/010/4200', '٥٥٥٠١٠٤٢٠٠', '５５５０１０４２００', '5a5b5c0d1e0f4g2h0i0']) {
    assert.throws(() => changes.assertNoContactDetail({ after: { note: text } }, ['+15550104200']), changes.ContactDetailInLine, text);
  }
  await withTenant(a.tenant, (c) => changes.record(c, ctx, { garageId: g.id, action: 'alert_contact.change', subject: person(), before: { phone: 'given' }, after: { phone: 'changed', name: 'changed', by_text: ['lane_problem'] } }));
  assert.equal(ctx.count, 1, 'a line that says only what kind of change it was is written');
  // The database: a line about a person never holds a name, whoever writes it.
  await assert.rejects(withTenant(a.tenant, (c) => c.query(
    `INSERT INTO garage_changes (tenant_id, garage_id, outcome, actor_kind, actor_id, actor_name, action, subject_kind, subject_id, subject_name, before, after)
     VALUES ($1, $2, 'done', 'owner', $3, $4, 'alert_contact.add', 'alert_contact', gen_random_uuid(), 'Maria five five five', NULL, NULL)`,
    [a.tenant, g.id, a.userId, a.email])), /garage_changes_person_unnamed/);
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
