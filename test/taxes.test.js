/**
 * A garage's taxes (migration 0022): stated as sets, held as stated, read
 * back whole -- and nothing computed.
 *
 * Every refusal here is paired with the call that succeeds, so "cannot" is
 * measured against "can". A set is judged by the REAL engine -- the pinned
 * `rate-engine`, started here -- and by nothing in this platform: a stand-in
 * would be this platform's opinion of the engine, tested against itself. The
 * activation condition is test/activation.test.js.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, stateTaxes } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { TAX_SET_STATED_EVENT_KIND } from '../src/taxes.js';
import { startRateEngine } from './rate-engine.js';

let server;
let base;
let tenant;
let other;
let operatorToken;
let operatorTokenId;
let otherToken;
let engine;

async function issueOperatorToken(tenantId) {
  const token = generateDeviceToken();
  const { rows } = await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2) RETURNING id`, [tenantId, hashToken(token)]),
  );
  return { token, id: rows[0].id };
}

const call = (token) => (method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
let op;

async function newGarage(as = op) {
  const res = await as('POST', '/garages', { name: 'Tax', timezone: 'America/New_York', currency: 'USD' });
  assert.equal(res.status, 201);
  return (await res.json()).garage;
}
const state = (garageId, taxSet, as = op) => as('POST', `/garages/${garageId}/tax-sets`, { tax_set: taxSet });
const read = async (garageId, as = op) => {
  const res = await as('GET', `/garages/${garageId}/tax-sets`);
  assert.equal(res.status, 200);
  return (await res.json()).tax_sets;
};

const CITY = { id: 'city', label: 'City parking tax', percent_bp: 1850, rounding: 'nearest', sequence: 1 };
const STATE = { id: 'state', label: 'State sales tax', percent_bp: 625, rounding: 'up', sequence: 2 };
const FEE = { id: 'fee', label: 'Stadium district fee', percent_bp: 1, rounding: 'down', sequence: 0 };

/** The engine's own answer to a garage's whole list: what a load of it says. */
async function load(taxSets) {
  const res = await fetch(`${engine.url}/v1/validate-tax-sets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tax_sets: taxSets.map((s) => ({ effective_from: s.effective_from, rules: s.rules })) }),
  });
  return { status: res.status, body: await res.json() };
}

const REFUSED = /^the rate engine refused the tax set: request\.tax_sets\[0\]/;

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('taxes');
  other = await createTenant('taxes-other');
  ({ token: operatorToken, id: operatorTokenId } = await issueOperatorToken(tenant));
  ({ token: otherToken } = await issueOperatorToken(other));
  op = call(operatorToken);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Guarded: a `before` that threw leaves these unset, and an unguarded close
  // would hang the file with the engine child still running.
  if (server) await new Promise((r) => server.close(r));
  if (engine) await engine.stop();
  await pool.end();
});

// --- 1. a set stores and reads back exactly -----------------------------------------

test('a set stores and reads back exactly: every rule, all five fields, in stated order, the instant as an instant', async () => {
  const g = await newGarage();
  // Given out of sequence order on purpose: the order decides nothing.
  const res = await state(g.id, { effective_from: '2026-01-01T00:00:00-05:00', rules: [STATE, CITY, FEE] });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const { tax_set: stored } = await res.json();
  const [back] = await read(g.id);
  assert.deepEqual(back, stored, 'the read is the stored answer');
  assert.equal(back.effective_from, '2026-01-01T05:00:00.000000Z', 'the same instant, said in UTC, to the microsecond');
  assert.equal(back.rule_count, 3);
  assert.deepEqual(back.rules, [FEE, CITY, STATE], 'exactly the rules given, in the garage\'s stated sequence');
  for (const rule of back.rules) {
    assert.deepEqual(Object.keys(rule).sort(), ['id', 'label', 'percent_bp', 'rounding', 'sequence'], 'the engine\'s five keys, nothing else');
  }
  // CONTROL: the four valid fields the brief names (and the engine's id)
  // really are columns, and each holds the value it was given.
  const rows = await withTenant(tenant, async (c) =>
    (await c.query('SELECT rule_id, label, percent_bp, rounding, sequence FROM garage_tax_rules WHERE tax_set_id = $1 ORDER BY sequence', [back.id])).rows,
  );
  assert.deepEqual(rows, [FEE, CITY, STATE].map((r) => ({ rule_id: r.id, label: r.label, percent_bp: r.percent_bp, rounding: r.rounding, sequence: r.sequence })));
});

test('a rule with a base is impossible: the table has no column for it, and the route names the key', async () => {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('garage_tax_sets', 'garage_tax_rules') ORDER BY table_name, ordinal_position`,
  );
  const columns = (t) => rows.filter((r) => r.table_name === t).map((r) => r.column_name);
  assert.deepEqual(columns('garage_tax_rules'), ['id', 'tenant_id', 'tax_set_id', 'rule_id', 'label', 'percent_bp', 'rounding', 'sequence']);
  assert.deepEqual(columns('garage_tax_sets'), ['id', 'tenant_id', 'garage_id', 'effective_from', 'rule_count', 'created_at']);
  const g = await newGarage();
  await assert.rejects(
    withTenant(tenant, async (c) => {
      const set = await c.query(`INSERT INTO garage_tax_sets (tenant_id, garage_id, effective_from, rule_count) VALUES ($1,$2,now(),1) RETURNING id`, [tenant, g.id]);
      await c.query(
        `INSERT INTO garage_tax_rules (tenant_id, tax_set_id, rule_id, label, percent_bp, rounding, sequence, base)
         VALUES ($1,$2,'x','X',100,'up',0,'subtotal')`,
        [tenant, set.rows[0].id],
      );
    }),
    (err) => err.code === '42703' && /base/.test(err.message),
  );
  const res = await state(g.id, { effective_from: '2026-01-01T00:00:00Z', rules: [{ ...CITY, base: 'subtotal' }] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, REFUSED);
  assert.match(body.error, /rules\[0\] carries key\(s\) this version does not understand: base/);
  assert.deepEqual(await read(g.id), [], 'nothing stored');
  // CONTROL: the same rule without it stores.
  assert.equal((await state(g.id, { effective_from: '2026-01-01T00:00:00Z', rules: [CITY] })).status, 201);
});

test('every shape the engine refuses is refused at save, in the engine\'s own sentence, and nothing is stored', async () => {
  const g = await newGarage();
  const at = '2026-02-01T00:00:00Z';
  const cases = [
    [undefined, /request\.tax_sets\[0\] must be an object/],
    [{ rules: [] }, /missing required field\(s\): effective_from/],
    [{ effective_from: at }, /missing required field\(s\): rules/],
    [{ effective_from: at, rules: [], garage: 'x' }, /does not understand: garage/],
    [{ effective_from: '2026-02-01T00:00:00', rules: [] }, /has no UTC offset/],
    [{ effective_from: 'soon', rules: [] }, /is not ISO 8601: 'soon'/],
    [{ effective_from: at, rules: {} }, /rules must be a list/],
    [{ effective_from: at, rules: [{ ...CITY, id: undefined }] }, /rules\[0\] is missing required field\(s\): id/],
    [{ effective_from: at, rules: [{ label: 'x', percent_bp: 1, rounding: 'up', sequence: 0, id: 'a', fixed_minor: 5 }] }, /does not understand: fixed_minor/],
    [{ effective_from: at, rules: [{ ...CITY, id: ' ' }] }, /rules\[0\]\.id must be a non-empty string/],
    [{ effective_from: at, rules: [{ ...CITY, label: '' }] }, /rules\[0\]\.label must be a non-empty string/],
    [{ effective_from: at, rules: [{ ...CITY, percent_bp: 0 }] }, /percent_bp must be a positive whole number, got 0/],
    [{ effective_from: at, rules: [{ ...CITY, percent_bp: 18.5 }] }, /percent_bp is a float/],
    [{ effective_from: at, rules: [{ ...CITY, percent_bp: '1850' }] }, /percent_bp must be a positive whole number/],
    [{ effective_from: at, rules: [{ ...CITY, percent_bp: true }] }, /percent_bp is a boolean/],
    [{ effective_from: at, rules: [{ ...CITY, rounding: 'half_even' }] }, /rounding is 'half_even'; expected one of up, down, nearest\. There is no default/],
    [{ effective_from: at, rules: [{ ...CITY, rounding: null }] }, /rounding is None/],
    [{ effective_from: at, rules: [{ ...CITY, sequence: -1 }] }, /sequence must be a whole number, got -1/],
    [{ effective_from: at, rules: [CITY, { ...STATE, id: 'city' }] }, /two rules with id 'city'/],
    [{ effective_from: at, rules: [CITY, { ...STATE, sequence: 1 }] }, /'city' and 'state' both state sequence 1/],
  ];
  for (const [body, message] of cases) {
    const res = await op('POST', `/garages/${g.id}/tax-sets`, body === undefined ? {} : { tax_set: body });
    assert.equal(res.status, 400, JSON.stringify(body));
    const { error } = await res.json();
    assert.match(error, REFUSED, JSON.stringify(body));
    assert.match(error, message, JSON.stringify(body));
  }
  assert.deepEqual(await read(g.id), [], 'nothing was stored by any of them');
  // CONTROL: sequence 0 is a sequence, and a whole set of edges stores.
  assert.equal((await state(g.id, { effective_from: at, rules: [FEE, { ...CITY, percent_bp: 2 ** 31 - 1 }] })).status, 201);
});

// --- the engine judges; the platform does not ------------------------------------------

/** The ten the gate found: an id or a label made only of what JavaScript's trim() keeps and Python's strip() removes. */
const BLANKS = ['\u001c', '\u001d', '\u001e', '\u001f', '\u0085'];

test('the ten blank-text cases are refused at save, by the engine\'s refusal, and nothing is stored', async () => {
  const g = await newGarage();
  const at = '2026-02-01T00:00:00Z';
  let refused = 0;
  for (const blank of BLANKS) {
    for (const key of ['id', 'label']) {
      const res = await state(g.id, { effective_from: at, rules: [{ ...CITY, [key]: blank }] });
      assert.equal(res.status, 400, `${key} = U+${blank.codePointAt(0).toString(16)}`);
      const { error } = await res.json();
      assert.match(error, REFUSED);
      assert.match(error, new RegExp(`rules\\[0\\]\\.${key} must be a non-empty string`));
      refused += 1;
    }
  }
  assert.equal(refused, 10);
  assert.deepEqual(await read(g.id), [], 'none of the ten was stored');
  // CONTROL: an ordinary id and label store.
  assert.equal((await state(g.id, { effective_from: at, rules: [CITY] })).status, 201);
  assert.equal((await read(g.id))[0].rules[0].label, CITY.label);
});

test('the inputs that used to answer 500 are named refusals now, and a valid value on each field stores', async () => {
  const g = await newGarage();
  const at = '2026-02-01T00:00:00Z';
  // The engine refuses these three instants itself (Feb 30, Feb 29 in a
  // non-leap year, year 0000).
  for (const effective_from of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '0000-01-01T00:00:00Z']) {
    const res = await state(g.id, { effective_from, rules: [] });
    assert.equal(res.status, 400, effective_from);
    const { error } = await res.json();
    assert.match(error, REFUSED, effective_from);
    assert.match(error, /effective_from is not ISO 8601/, effective_from);
  }
  // The engine ACCEPTS these -- a NUL in an id or a label, an offset of
  // +23:59 -- and this platform cannot hold them: a storage refusal, named.
  for (const [taxSet, field] of [
    [{ effective_from: at, rules: [{ ...CITY, id: 'ci\u0000ty' }] }, 'tax_set.rules[0].id'],
    [{ effective_from: at, rules: [{ ...CITY, label: 'City\u0000tax' }] }, 'tax_set.rules[0].label'],
    [{ effective_from: '2026-02-01T00:00:00+23:59', rules: [] }, 'tax_set.effective_from'],
  ]) {
    assert.equal((await load([taxSet])).status, 200, `the engine accepts ${field}`);
    const res = await state(g.id, taxSet);
    assert.equal(res.status, 409, field);
    const body = await res.json();
    assert.equal(body.code, 'tax_set_not_storable', field);
    assert.equal(body.details.field, field);
  }
  assert.deepEqual(await read(g.id), [], 'nothing was stored by any of them');
  // CONTROL: a valid value on each of those fields stores.
  for (const [i, effective_from] of ['2028-02-29T00:00:00Z', '2026-03-01T00:00:00Z', '0001-01-02T00:00:00Z', '2026-02-01T00:00:00+15:59'].entries()) {
    assert.equal((await state(g.id, { effective_from, rules: [{ ...CITY, id: `city${i}`, label: `City tax ${i}` }] })).status, 201, effective_from);
  }
  assert.equal((await read(g.id)).length, 4);
});

test('a storage refusal is its own kind: the engine said valid, and the platform says it cannot hold it', async () => {
  const g = await newGarage();
  const at = '2026-02-01T00:00:00Z';
  const cases = [
    [{ ...CITY, label: 'City\u0000tax' }, 'tax_set.rules[0].label', 'text_nul', /U\+0000 \(NUL\), which PostgreSQL text cannot hold/],
    [{ ...CITY, percent_bp: 2 ** 31 }, 'tax_set.rules[0].percent_bp', 'integer_range', /outside the column's integer range/],
    [{ ...CITY, sequence: 2 ** 40 }, 'tax_set.rules[0].sequence', 'integer_range', /outside the column's integer range/],
    [{ ...CITY, label: 'City \ud800 tax' }, 'tax_set.rules[0].label', 'text_encoding', /lone UTF-16 surrogate/],
  ];
  for (const [rule, field, limit, message] of cases) {
    const taxSet = { effective_from: at, rules: [rule] };
    // The door's word first: VALID.
    const judged = await load([taxSet]);
    assert.equal(judged.status, 200, `the engine accepts ${field}: ${JSON.stringify(judged.body)}`);
    const res = await state(g.id, taxSet);
    assert.equal(res.status, 409, field);
    const body = await res.json();
    assert.equal(body.code, 'tax_set_not_storable', field);
    assert.deepEqual(body.details, { field, limit });
    assert.match(body.error, message);
    assert.match(body.error, /The rate engine accepts this set; this is a limit of where this platform keeps it, not a judgement of the set/);
    assert.doesNotMatch(body.error, /the rate engine refused/, 'never worded as a validity refusal');
  }
  // And a validity refusal is not a storage one: a 400, no storage code.
  const invalid = await state(g.id, { effective_from: at, rules: [{ ...CITY, percent_bp: 0 }] });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, undefined);
  assert.deepEqual(await read(g.id), [], 'nothing stored');
  // CONTROL: the same set with an ordinary label and an in-range number stores.
  const res = await state(g.id, { effective_from: at, rules: [{ ...CITY, percent_bp: 2 ** 31 - 1, sequence: 2 ** 31 - 1 }] });
  assert.equal(res.status, 201);
  assert.equal((await read(g.id))[0].rules[0].percent_bp, 2 ** 31 - 1);
});

test('an instant the engine reads and the store cannot give back is a storage refusal, not a set that never loads', async () => {
  const g = await newGarage();
  // Year 1 at +01:00 is 1 BC in UTC; 9999-12-31 at -05:00 is year 10000.
  // The engine reads both; this platform hands the engine UTC, and cannot.
  for (const effective_from of ['0001-01-01T00:00:00+01:00', '9999-12-31T23:00:00-05:00']) {
    assert.equal((await load([{ effective_from, rules: [] }])).status, 200, effective_from);
    const res = await state(g.id, { effective_from, rules: [] });
    assert.equal(res.status, 409, effective_from);
    const body = await res.json();
    assert.equal(body.code, 'tax_set_not_storable', effective_from);
  }
  assert.deepEqual(await read(g.id), []);
  // CONTROL: the other end of each range, inside it, stores and loads.
  for (const effective_from of ['0001-01-01T00:00:00-01:00', '9999-12-31T23:00:00+05:00']) {
    assert.equal((await state(g.id, { effective_from, rules: [] })).status, 201, effective_from);
  }
  assert.equal((await load(await read(g.id))).status, 200);
});

test('no engine to ask: the save answers 5xx, names it, and stores nothing', async () => {
  const g = await newGarage();
  const live = process.env.RATE_ENGINE_URL;
  try {
    process.env.RATE_ENGINE_URL = 'http://127.0.0.1:1';
    const res = await state(g.id, { effective_from: '2026-01-01T00:00:00Z', rules: [CITY] });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'rate_engine_unavailable');
    assert.match(body.error, /could not be reached.*the tax set was not stored/);
    delete process.env.RATE_ENGINE_URL;
    const unset = await state(g.id, { effective_from: '2026-01-01T00:00:00Z', rules: [CITY] });
    assert.equal(unset.status, 503);
    assert.equal((await unset.json()).code, 'rate_engine_unavailable');
  } finally {
    process.env.RATE_ENGINE_URL = live;
  }
  assert.deepEqual(await read(g.id), [], 'nothing stored');
  // CONTROL: reachable, the same set is stored.
  assert.equal((await state(g.id, { effective_from: '2026-01-01T00:00:00Z', rules: [CITY] })).status, 201);
  assert.equal((await read(g.id)).length, 1);
});

test('every set stored through the route loads, garage by garage, as the whole list; a planted unloadable row is refused by the same load', async () => {
  const garages = [await newGarage(), await newGarage(), await newGarage()];
  const statements = [
    [{ effective_from: '2026-01-01T00:00:00-05:00', rules: [STATE, CITY, FEE] }, { effective_from: '2026-07-01T00:00:00Z', rules: [] }],
    [{ effective_from: '2000-01-01T00:00:00Z', rules: [] }, { effective_from: '2026-01-01T00:00:00.123456+05:30', rules: [CITY] },
      { effective_from: '2026-01-01T00:00:00.1234575+05:30', rules: [FEE] }],
    [{ effective_from: '2026-03-01T00:00:00.000001Z', rules: [FEE] }, { effective_from: '2026-03-01T00:00:00.000002Z', rules: [] }],
  ];
  for (const [i, sets] of statements.entries()) {
    for (const taxSet of sets) {
      const res = await state(garages[i].id, taxSet);
      assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    }
  }
  // The instant stored is the one the engine READ: it keeps six digits of a
  // second, so a seventh names the instant already held.
  const seventh = await state(garages[1].id, { effective_from: '2026-01-01T00:00:00.1234569+05:30', rules: [] });
  assert.equal(seventh.status, 409);
  assert.equal((await seventh.json()).code, 'tax_set_effective_from_taken');
  for (const [i, g] of garages.entries()) {
    const sets = await read(g.id);
    assert.equal(sets.length, statements[i].length);
    const loaded = await load(sets);
    assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
    assert.equal(loaded.body.tax_sets.length, sets.length, 'every set of the garage, loaded');
  }
  // CONTROL: a row the engine refuses, planted straight into the table --
  // which judges nothing -- and the same load of the same garage refuses it.
  const [g] = garages;
  await withTenant(tenant, (c) => stateTaxes(c, tenant, g.id, {
    effectiveFrom: '2027-01-01T00:00:00Z',
    rules: [{ ...CITY, label: '\u001c' }],
  }));
  const planted = await load(await read(g.id));
  assert.equal(planted.status, 400);
  assert.match(planted.body.error, /label must be a non-empty string/);
  // And the route's own proof sees it: a valid set for that garage is not
  // stored on top of a list that would not load.
  const res = await state(g.id, { effective_from: '2028-01-01T00:00:00Z', rules: [] });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'tax_set_not_storable');
  assert.equal(body.details.limit, 'load');
  assert.equal((await read(g.id)).length, 3, 'the planted row, and nothing added on top of it');
});

test('the platform holds no rule of its own on whether a tax set is valid', async () => {
  // What a validity rule here would look like: the engine's key lists, its
  // roundings, a blank test, a range on percent_bp or sequence, a parse of
  // the instant, a CHECK or a per-set UNIQUE in the table.
  const rules = [
    /['"]up['"]\s*,\s*['"]down['"]/,
    /\bTAX_ROUNDINGS\b|\bRULE_KEYS\b|\bSET_KEYS\b/,
    /\.trim\(\)|\bbtrim\(/,
    /percent_bp\s*(<|>|<=|>=)|sequence\s*(<|>|<=|>=)\s*0/,
    /Date\.parse|new Date\(\s*(raw|set|body)/,
    /(?<!WITH )\bCHECK\s*\((?!rule_count)/,
    /UNIQUE\s*\(\s*tax_set_id/,
  ];
  const sources = ['src/taxes.js', 'migrations/0022_garage_tax_sets.sql'];
  for (const path of sources) {
    const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    // Positive control: the scan is reading the file it should.
    assert.ok(text.includes('percent_bp') && text.includes('garage_tax_rules'), `${path} was read`);
    const code = path.endsWith('.sql')
      ? text.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
      : text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    for (const rule of rules) assert.ok(!rule.test(code), `${path} holds a validity rule: ${rule}`);
  }
  // CONTROL: each pattern finds the rule it is for, in the shapes the old
  // copy had.
  for (const [rule, planted] of [
    [rules[0], "const TAX_ROUNDINGS = ['up', 'down', 'nearest'];"],
    [rules[1], 'exactKeys(r, RULE_KEYS, where);'],
    [rules[2], "if (value.trim() === '') throw invalid();"],
    [rules[3], 'if (percent_bp < 1) throw invalid();'],
    [rules[4], 'Number.isNaN(Date.parse(effectiveFrom))'],
    [rules[5], "CONSTRAINT x CHECK (btrim(label) <> '')"],
    [rules[6], 'CONSTRAINT x UNIQUE (tax_set_id, sequence)'],
  ]) {
    assert.ok(rule.test(planted), `${rule} misses ${planted}`);
  }
});

// --- 3. UNSTATED is not "none" --------------------------------------------------------

test('UNSTATED is told from stated-none in the store: none is a set that SAID zero rules, not an empty list read as none', async () => {
  const unstated = await newGarage();
  const none = await newGarage();
  assert.equal((await state(none.id, { effective_from: '2000-01-01T00:00:00Z', rules: [] })).status, 201);
  assert.deepEqual(await read(unstated.id), [], 'unstated: no set at all');
  // CONTROL: stated-none reads back as STATED -- a set, rule_count 0 written.
  const [set] = await read(none.id);
  assert.equal(set.rule_count, 0);
  assert.deepEqual(set.rules, []);
  const stored = await withTenant(tenant, async (c) =>
    (await c.query('SELECT garage_id, rule_count FROM garage_tax_sets WHERE garage_id = ANY($1::uuid[])', [[unstated.id, none.id]])).rows,
  );
  assert.deepEqual(stored, [{ garage_id: none.id, rule_count: 0 }], 'a row for the statement, none for the silence');
});

test('a set holds exactly the rules it states: a short set, and a rule added later, are refused at commit', async () => {
  const g = await newGarage();
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(`INSERT INTO garage_tax_sets (tenant_id, garage_id, effective_from, rule_count) VALUES ($1,$2,'2026-03-01T00:00:00Z',1)`, [tenant, g.id]),
    ),
    (err) => err.constraint === 'garage_tax_sets_hold_their_stated_rules' && /states 1 rule\(s\) and holds 0/.test(err.message),
    'a set that states one rule and holds none: a half-written statement',
  );
  const setId = await withTenant(tenant, (c) => stateTaxes(c, tenant, g.id, { rules: [], effectiveFrom: '2026-03-01T00:00:00Z' }));
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(
        `INSERT INTO garage_tax_rules (tenant_id, tax_set_id, rule_id, label, percent_bp, rounding, sequence) VALUES ($1,$2,'late','Late',100,'up',0)`,
        [tenant, setId],
      ),
    ),
    (err) => err.constraint === 'garage_tax_sets_hold_their_stated_rules' && /states 0 rule\(s\) and holds 1/.test(err.message),
    'a "none" given a rule afterwards: a statement edited after the fact',
  );
  const [set] = await read(g.id);
  assert.equal(set.rule_count, 0);
  assert.deepEqual(set.rules, [], 'still exactly what was stated');
  // CONTROL: a set and its rules in one transaction, counted, commit.
  await withTenant(tenant, (c) => stateTaxes(c, tenant, g.id, { rules: [CITY, STATE], effectiveFrom: '2026-04-01T00:00:00Z' }));
  assert.equal((await read(g.id)).length, 2);
});

test('a statement is append-only: the application role cannot update or delete a set or a rule', async () => {
  const g = await newGarage();
  await state(g.id, { effective_from: '2026-01-01T00:00:00Z', rules: [CITY] });
  for (const sql of [
    `UPDATE garage_tax_sets SET rule_count = 0`,
    `DELETE FROM garage_tax_sets`,
    `UPDATE garage_tax_rules SET percent_bp = 1`,
    `DELETE FROM garage_tax_rules`,
  ]) {
    await assert.rejects(withTenant(tenant, (c) => c.query(sql)), (err) => err.code === '42501', sql);
  }
  const { rows } = await pool.query(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'openparking_app' AND table_name IN ('garage_tax_sets', 'garage_tax_rules')
      ORDER BY table_name, privilege_type`,
  );
  assert.deepEqual(rows.map((r) => `${r.table_name}:${r.privilege_type}`), [
    'garage_tax_rules:INSERT', 'garage_tax_rules:SELECT', 'garage_tax_sets:INSERT', 'garage_tax_sets:SELECT',
  ]);
  // CONTROL: reading is granted, and the set is there to read.
  assert.equal((await read(g.id))[0].rules[0].percent_bp, CITY.percent_bp);
});

// --- 4. two sets at one instant --------------------------------------------------------

test('two sets at one instant are refused, both named -- the instant compared as an instant', async () => {
  const g = await newGarage();
  const first = await (await state(g.id, { effective_from: '2026-06-01T15:00:00Z', rules: [CITY] })).json();
  const res = await state(g.id, { effective_from: '2026-06-01T10:00:00-05:00', rules: [] });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'tax_set_effective_from_taken');
  assert.match(body.error, new RegExp(`set ${first.tax_set.id}, stated \\S+, already takes effect at 2026-06-01T15:00:00\\.000000Z`));
  assert.match(body.error, /this set would take effect at 2026-06-01T10:00:00-05:00/);
  assert.equal(body.details.held.id, first.tax_set.id);
  assert.deepEqual(body.details.refused, { effective_from: '2026-06-01T10:00:00-05:00', rule_count: 0 });
  assert.deepEqual((await read(g.id)).map((s) => s.id), [first.tax_set.id], 'the held set is untouched, nothing added');
  // CONTROL: two sets at different instants both store, and stating the
  // later one supersedes nothing -- the earlier is still there, unchanged.
  const later = await state(g.id, { effective_from: '2026-07-01T00:00:00Z', rules: [] });
  assert.equal(later.status, 201);
  const sets = await read(g.id);
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[0], first.tax_set);
});

test('a stated set is recorded: who stated which set, and what it said', async () => {
  const g = await newGarage();
  const { tax_set: set } = await (await state(g.id, { effective_from: '2026-01-01T00:00:00Z', rules: [STATE, CITY] })).json();
  const events = await withTenant(tenant, async (c) =>
    (await c.query('SELECT * FROM events WHERE garage_id = $1 AND kind = $2', [g.id, TAX_SET_STATED_EVENT_KIND])).rows,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, `tax_set:${set.id}`);
  assert.equal(events[0].detail.actor, `operator_token:${operatorTokenId}`);
  assert.equal(events[0].detail.rule_count, 2);
  assert.deepEqual(events[0].detail.rules, [CITY, STATE]);
  // CONTROL: a refused statement records nothing.
  assert.equal((await state(g.id, { effective_from: '2026-01-01T00:00:00Z', rules: [] })).status, 409);
  const after = await withTenant(tenant, async (c) =>
    (await c.query('SELECT count(*)::int AS n FROM events WHERE garage_id = $1 AND kind = $2', [g.id, TAX_SET_STATED_EVENT_KIND])).rows[0].n,
  );
  assert.equal(after, 1);
});

// --- 5. tenant isolation, as the application role -------------------------------------

test('the connection under test is the application role, and it cannot bypass RLS', async () => {
  const { rows } = await pool.query('SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(rows[0], { who: 'openparking_app', rolsuper: false, rolbypassrls: false });
});

test('another tenant can neither read, state against, nor attach to a garage\'s taxes', async () => {
  const g = await newGarage();
  const { tax_set: set } = await (await state(g.id, { effective_from: '2026-01-01T00:00:00Z', rules: [CITY] })).json();
  const asOther = call(otherToken);
  assert.equal((await asOther('GET', `/garages/${g.id}/tax-sets`)).status, 404, 'the route: not found, not forbidden');
  assert.equal((await state(g.id, { effective_from: '2027-01-01T00:00:00Z', rules: [] }, asOther)).status, 404);
  const seen = await withTenant(other, async (c) => ({
    sets: (await c.query('SELECT id FROM garage_tax_sets WHERE id = $1', [set.id])).rows,
    rules: (await c.query('SELECT rule_id FROM garage_tax_rules WHERE tax_set_id = $1', [set.id])).rows,
  }));
  assert.deepEqual(seen, { sets: [], rules: [] }, 'the table: nothing, by id');
  // Writing a set against another tenant's garage, and a rule into another
  // tenant's set, are refused by the database -- the foreign keys alone
  // would take both, because a foreign-key check runs as the owner.
  await assert.rejects(
    withTenant(other, (c) =>
      c.query(`INSERT INTO garage_tax_sets (tenant_id, garage_id, effective_from, rule_count) VALUES ($1,$2,now(),0)`, [other, g.id]),
    ),
    (err) => err.code === '42501' && /not this tenant's/.test(err.message),
  );
  await assert.rejects(
    withTenant(other, (c) =>
      c.query(
        `INSERT INTO garage_tax_rules (tenant_id, tax_set_id, rule_id, label, percent_bp, rounding, sequence) VALUES ($1,$2,'x','X',1,'up',9)`,
        [other, set.id],
      ),
    ),
    (err) => err.constraint === 'garage_tax_rules_set_is_the_tenants',
  );
  // CONTROL: the same reads as the owning tenant succeed.
  assert.equal((await read(g.id))[0].id, set.id);
  const own = await withTenant(tenant, async (c) => ({
    sets: (await c.query('SELECT id FROM garage_tax_sets WHERE id = $1', [set.id])).rows,
    rules: (await c.query('SELECT rule_id FROM garage_tax_rules WHERE tax_set_id = $1', [set.id])).rows,
  }));
  assert.deepEqual(own, { sets: [{ id: set.id }], rules: [{ rule_id: 'city' }] });
});

test('an unknown garage is 404 on both verbs', async () => {
  assert.equal((await op('GET', `/garages/${randomUUID()}/tax-sets`)).status, 404);
  assert.equal((await state(randomUUID(), { effective_from: '2026-01-01T00:00:00Z', rules: [] })).status, 404);
});

// --- nothing is computed ----------------------------------------------------------------

test('no percentage is computed anywhere in this round: the tax store and the route hold no arithmetic on percent_bp', async () => {
  const sources = ['src/taxes.js', 'migrations/0022_garage_tax_sets.sql'];
  const arithmetic = /percent_bp\s*[*/]|[*/]\s*percent_bp|\b10_?000\b|basis_points_per/i;
  for (const path of sources) {
    const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.ok(text.includes('percent_bp'), `${path} was read`);
    assert.ok(!arithmetic.test(text), `${path} computes with percent_bp`);
  }
  // CONTROL: the pattern finds arithmetic when there is some.
  assert.ok(arithmetic.test('const tax = subtotal * rule.percent_bp / 10000;'));
  // And the close hands the engine no tax: the route's close path never
  // names the store.
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  // The import path ('./taxes.js') is not a use.
  const uses = (app.match(/taxes\.\w+/g) ?? []).filter((u) => u !== 'taxes.js');
  assert.deepEqual([...new Set(uses)].sort(), [
    'taxes.TaxSetRefused', 'taxes.assertStorable', 'taxes.judgeTaxSet', 'taxes.storeTaxSet', 'taxes.taxSetsForGarage',
  ], 'the store is reached by its two operator routes and nothing else');
});
