/**
 * The plan store: a garage's rate plans, held whole, validated by the REAL
 * engine before they are stored, read back as the list the engine prices
 * from, and what a closed stay keeps of the one that priced it.
 *
 * The engine is started by this suite (test/rate-engine.js) at the pinned
 * version, because the store's central claim -- an unknown key is refused
 * and NAMED, a gap is refused and LISTED -- is the engine's sentence, and a
 * stand-in would test this platform's opinion of the engine against itself.
 *
 * Every absence claim here carries a positive control through the same
 * mechanism: a refusal is paired with the same call succeeding when the one
 * refused thing is put right, and "the purge does not touch this table" is
 * asserted in a run where the purge demonstrably touched a vehicle.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import * as ratePlans from '../src/ratePlans.js';
import * as repo from '../src/repository.js';
import { redactExpiredVehicles } from '../src/retention.js';

let engine;
let server;
let base;
let tenant;
let world;
let operatorToken;
let operatorTokenId;
let flatLot;

async function issueOperatorToken(tenantId) {
  const token = generateDeviceToken();
  const { rows } = await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2) RETURNING id`, [
      tenantId,
      hashToken(token),
    ]),
  );
  return { token, id: rows[0].id };
}

const asOperator = (token, body) => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** A whole plan under a fresh version name and effective instant, so tests do not collide. */
function plan(overrides = {}) {
  const stamp = randomUUID().slice(0, 8);
  return {
    ...structuredClone(flatLot),
    plan_version: `flat-${stamp}`,
    effective_from: new Date(Date.UTC(2026, 0, 1) - Math.floor(Math.random() * 1e10)).toISOString(),
    ...overrides,
  };
}

async function newGarage(currency = 'USD') {
  return withTenant(tenant, async (c) =>
    (await c.query(
      `INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, 'Plans', 'America/New_York', $2) RETURNING id`,
      [tenant, currency],
    )).rows[0].id,
  );
}

const store = (garageId, document) =>
  fetch(`${base}/api/v1/garages/${garageId}/rate-plans`, asOperator(operatorToken, { plan: document }));
const list = (garageId) => fetch(`${base}/api/v1/garages/${garageId}/rate-plans`, asOperator(operatorToken));

const countFor = (garageId) =>
  withTenant(tenant, async (c) =>
    Number((await c.query('SELECT count(*) FROM rate_plans WHERE garage_id = $1', [garageId])).rows[0].count),
  );

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  flatLot = JSON.parse(await readFile(new URL('./fixtures/rate-plans/flat_lot.json', import.meta.url), 'utf8'));
  tenant = await createTenant('plans');
  world = await buildWorld(tenant);
  ({ token: operatorToken, id: operatorTokenId } = await issueOperatorToken(tenant));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

// --- the engine is real -----------------------------------------------------

test('the suite is talking to the real engine, and it takes no payment', () => {
  assert.equal(engine.health.takes_payment, false);
  assert.ok(Number.isInteger(engine.health.schema_version), 'health names a schema_version');
  assert.ok(engine.health.rule_types.includes('increment'));
});

// --- store and read back ------------------------------------------------------

test('a whole plan is stored, and reads back equal to what went in', async () => {
  const document = plan();
  const res = await store(world.garage, document);
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const { rate_plan: stored } = await res.json();
  assert.deepEqual(stored.plan, document, 'the document is stored whole');
  assert.equal(stored.plan_version, document.plan_version);
  assert.equal(new Date(stored.effective_from).getTime(), new Date(document.effective_from).getTime());
  assert.equal(stored.engine_schema_version, engine.health.schema_version);
  assert.equal(stored.garage_id, world.garage);

  const back = await list(world.garage);
  assert.equal(back.status, 200);
  const { rate_plans: rows } = await back.json();
  const mine = rows.find((r) => r.id === stored.id);
  assert.deepEqual(mine.plan, document, 'the read hands back the same document');
});

test('the read returns EVERY plan of the garage, oldest effective date first, and none of another garage', async () => {
  const garage = await newGarage();
  const other = await newGarage();
  const docs = [
    plan({ effective_from: '2026-03-01T00:00:00-05:00' }),
    plan({ effective_from: '2026-01-01T00:00:00-05:00' }),
    plan({ effective_from: '2026-02-01T00:00:00-05:00' }),
  ];
  for (const d of docs) assert.equal((await store(garage, d)).status, 201);
  assert.equal((await store(other, plan())).status, 201);

  const { rate_plans: rows } = await (await list(garage)).json();
  assert.equal(rows.length, 3, 'every plan, not the latest one');
  assert.deepEqual(
    rows.map((r) => r.plan_version),
    [docs[1], docs[2], docs[0]].map((d) => d.plan_version),
    'oldest effective date first',
  );
  assert.ok(rows.every((r) => r.garage_id === garage));

  // The projection the engine takes: documents, whole, nothing of ours.
  const documents = await withTenant(tenant, async (c) =>
    ratePlans.documents(await ratePlans.ratePlansForGarage(c, tenant, garage)),
  );
  assert.deepEqual(
    documents,
    [docs[1], docs[2], docs[0]],
    'documents() is exactly the stored plans and nothing else',
  );
  assert.ok(documents.every((d) => !('id' in d) && !('garage_id' in d)));
});

test('a garage with no plans reads an empty list; an unknown garage is 404 on both routes', async () => {
  const garage = await newGarage();
  assert.deepEqual(await (await list(garage)).json(), { rate_plans: [] });
  assert.equal((await list(randomUUID())).status, 404);
  assert.equal((await store(randomUUID(), plan())).status, 404);
});

// --- validated by the engine, before it is stored ---------------------------------

test('a plan with a key this engine does not know is refused, and the refusal NAMES the key', async () => {
  const garage = await newGarage();
  const res = await store(garage, plan({ weekend_rate: { saturday_minor: 500 } }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /weekend_rate/, 'the engine names the key; this platform passes its sentence through');
  assert.equal(await countFor(garage), 0, 'nothing was stored');
  // CONTROL: the same plan without the key is stored by the same call.
  assert.equal((await store(garage, plan())).status, 201);
});

test('a plan with a gap is refused with every finding listed, and nothing is stored', async () => {
  const garage = await newGarage();
  // The fixture's one rule is unbounded; bounding it opens the gap the engine
  // calls GAP_STAY_EXCEEDS_MAX_DURATION: a stay longer than the bound has no
  // price.
  const gapped = plan();
  gapped.rules[0].max_duration_minutes = 1440;
  const res = await store(garage, gapped);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'plan_has_findings');
  assert.match(body.error, /GAP_STAY_EXCEEDS_MAX_DURATION/);
  assert.ok(Array.isArray(body.details?.findings) && body.details.findings.length === 1);
  assert.equal(body.details.findings[0].code, 'GAP_STAY_EXCEEDS_MAX_DURATION');
  assert.equal(body.details.findings[0].decided, false);
  assert.equal(await countFor(garage), 0);
});

test('a SETTLED finding still refuses: a decision is an acknowledgement, not a price', async () => {
  const garage = await newGarage();
  const gapped = plan();
  gapped.rules[0].max_duration_minutes = 1440;
  gapped.decisions = [
    { code: 'GAP_STAY_EXCEEDS_MAX_DURATION', note: 'we will deal with it', decided_by: 'owner', decided_at: '2026-01-01T00:00:00-05:00' },
  ];
  const res = await store(garage, gapped);
  assert.equal(res.status, 409, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.equal(body.code, 'plan_has_findings');
  assert.equal(body.details.findings[0].decided, true, 'the engine says it is settled');
  assert.match(body.error, /1 settled/);
  assert.equal(await countFor(garage), 0, 'and it is still not stored');
});

test('a body that is not a plan document at all is refused before the engine is asked', async () => {
  const garage = await newGarage();
  for (const body of [{}, { plan: 'flat' }, { plan: [1] }, { plan: null }]) {
    const res = await fetch(`${base}/api/v1/garages/${garage}/rate-plans`, asOperator(operatorToken, body));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(await countFor(garage), 0);
});

// --- currency: the garage's, in one place ------------------------------------------

test('a plan whose currency is not the garage\'s is refused by name; the garage does not take it', async () => {
  const garage = await newGarage('EUR');
  const res = await store(garage, plan({ currency: 'USD' }));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'plan_currency_disagrees_with_garage');
  assert.match(body.error, /USD/);
  assert.match(body.error, /EUR/);
  assert.equal(await countFor(garage), 0);
  // CONTROL: restating the garage's currency, the same document is stored.
  assert.equal((await store(garage, plan({ currency: 'EUR' }))).status, 201);
});

test('the database itself refuses a plan in the wrong currency: a direct INSERT does not go around the route', async () => {
  const garage = await newGarage('USD');
  const document = plan({ currency: 'EUR' });
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(
        `INSERT INTO rate_plans (tenant_id, garage_id, plan_version, effective_from, document, engine_schema_version)
         VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, 1)`,
        [tenant, garage, document.plan_version, document.effective_from, JSON.stringify(document)],
      ),
    ),
    (err) => err.constraint === 'rate_plans_currency_is_the_garages' && /EUR.*USD/.test(err.message),
  );
  // CONTROL: the same INSERT in the garage's currency lands.
  const ok = plan({ currency: 'USD' });
  await withTenant(tenant, (c) =>
    c.query(
      `INSERT INTO rate_plans (tenant_id, garage_id, plan_version, effective_from, document, engine_schema_version)
       VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, 1)`,
      [tenant, garage, ok.plan_version, ok.effective_from, JSON.stringify(ok)],
    ),
  );
  assert.equal(await countFor(garage), 1);
});

test('the index keys cannot disagree with the document they were lifted from', async () => {
  const garage = await newGarage();
  const document = plan();
  for (const [column, value, constraint] of [
    ['plan_version', 'not-the-documents', 'rate_plans_version_is_the_documents'],
    ['effective_from', '2020-01-01T00:00:00Z', 'rate_plans_effective_from_is_the_documents'],
  ]) {
    await assert.rejects(
      withTenant(tenant, (c) =>
        c.query(
          `INSERT INTO rate_plans (tenant_id, garage_id, plan_version, effective_from, document, engine_schema_version)
           VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, 1)`,
          [
            tenant, garage,
            column === 'plan_version' ? value : document.plan_version,
            column === 'effective_from' ? value : document.effective_from,
            JSON.stringify(document),
          ],
        ),
      ),
      (err) => err.constraint === constraint,
      `${column} drifted from the document and nothing refused it`,
    );
  }
});

// --- one version name, one instant, per garage ------------------------------------

test('a version name already used by the garage is refused by name', async () => {
  const garage = await newGarage();
  const first = plan();
  assert.equal((await store(garage, first)).status, 201);
  const res = await store(garage, plan({ plan_version: first.plan_version }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'plan_version_exists');
  assert.equal(await countFor(garage), 1);
  // Another garage may use the same name: the key is per garage.
  assert.equal((await store(await newGarage(), plan({ plan_version: first.plan_version }))).status, 201);
});

test('two versions taking effect at one instant are refused at write time, the ambiguity the engine refuses at quote time', async () => {
  const garage = await newGarage();
  const at = '2026-06-01T00:00:00-04:00';
  assert.equal((await store(garage, plan({ effective_from: at }))).status, 201);
  // The same instant, written differently: the key is the instant, not the text.
  const res = await store(garage, plan({ effective_from: '2026-06-01T04:00:00Z' }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'plan_effective_from_taken');
  assert.equal(await countFor(garage), 1);
  // CONTROL: a later instant is a new version and lands.
  assert.equal((await store(garage, plan({ effective_from: '2026-06-02T00:00:00-04:00' }))).status, 201);
});

// --- no engine is a refusal, never an acceptance --------------------------------------

test('an engine that cannot be reached refuses by name and stores nothing', async () => {
  const garage = await newGarage();
  const live = process.env.RATE_ENGINE_URL;
  try {
    // A closed loopback port: connection refused, not a timeout.
    process.env.RATE_ENGINE_URL = 'http://127.0.0.1:1';
    const res = await store(garage, plan());
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'rate_engine_unavailable');
    assert.match(body.error, /not stored/);
    assert.equal(await countFor(garage), 0);

    delete process.env.RATE_ENGINE_URL;
    const unset = await store(garage, plan());
    assert.equal(unset.status, 409);
    assert.equal((await unset.json()).code, 'rate_engine_unavailable');
    assert.match((await store(garage, plan()).then((r) => r.json())).error, /RATE_ENGINE_URL/);
    assert.equal(await countFor(garage), 0);
  } finally {
    process.env.RATE_ENGINE_URL = live;
  }
  // CONTROL: with the engine back, the same call stores.
  assert.equal((await store(garage, plan())).status, 201);
});

test('an engine answering something this platform does not recognise is a refusal too', async () => {
  const garage = await newGarage();
  // The health route answers GET only; a POST there is the engine's 404, a
  // JSON body with no `findings` and no `invalid`.
  const live = process.env.RATE_ENGINE_URL;
  try {
    process.env.RATE_ENGINE_URL = `${live}/v1/health`;
    const res = await store(garage, plan());
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'rate_engine_unavailable');
    assert.equal(await countFor(garage), 0);
  } finally {
    process.env.RATE_ENGINE_URL = live;
  }
});

// --- recorded ------------------------------------------------------------------------

test('storing a plan is recorded: who, which version, which garage, which engine contract', async () => {
  const garage = await newGarage();
  const document = plan();
  const { rate_plan: stored } = await (await store(garage, document)).json();
  const events = await withTenant(tenant, async (c) =>
    (await c.query(`SELECT * FROM events WHERE tenant_id = $1 AND kind = $2 AND detail->>'rate_plan_id' = $3`, [
      tenant, ratePlans.RATE_PLAN_EVENT_KIND, stored.id,
    ])).rows,
  );
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.garage_id, garage);
  assert.equal(e.lane_id, null, 'no lane did this');
  assert.equal(e.event_id, `rate_plan:${stored.id}`);
  assert.equal(e.detail.actor, `operator_token:${operatorTokenId}`);
  assert.equal(e.detail.plan_version, document.plan_version);
  assert.equal(e.detail.currency, 'USD');
  assert.equal(e.detail.engine_schema_version, engine.health.schema_version);
  assert.equal(e.detail.findings, 0);
});

test('a refused plan leaves no record of a plan stored', async () => {
  const garage = await newGarage();
  const before = await withTenant(tenant, async (c) =>
    Number((await c.query(`SELECT count(*) FROM events WHERE tenant_id = $1 AND kind = $2`, [tenant, ratePlans.RATE_PLAN_EVENT_KIND])).rows[0].count),
  );
  assert.equal((await store(garage, plan({ weekend_rate: 1 }))).status, 400);
  assert.equal((await store(garage, plan({ currency: 'EUR' }))).status, 409);
  const after = await withTenant(tenant, async (c) =>
    Number((await c.query(`SELECT count(*) FROM events WHERE tenant_id = $1 AND kind = $2`, [tenant, ratePlans.RATE_PLAN_EVENT_KIND])).rows[0].count),
  );
  assert.equal(after, before);
});

// --- append-only, no personal data, outside the purge ------------------------------------

test('rate_plans is append-only: an UPDATE and a DELETE as the app role actually fail', async () => {
  const garage = await newGarage();
  const { rate_plan: stored } = await (await store(garage, plan())).json();
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE rate_plans SET document = '{}'::jsonb WHERE id = $1`, [stored.id])),
    /permission denied/i,
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`DELETE FROM rate_plans WHERE id = $1`, [stored.id])),
    /permission denied/i,
  );
  // CONTROL: the same connection can still read and insert.
  const { rows } = await pool.query(
    `SELECT has_table_privilege('openparking_app', 'rate_plans', 'SELECT') AS can_select,
            has_table_privilege('openparking_app', 'rate_plans', 'INSERT') AS can_insert,
            has_table_privilege('openparking_app', 'rate_plans', 'UPDATE') AS can_update,
            has_table_privilege('openparking_app', 'rate_plans', 'DELETE') AS can_delete`,
  );
  assert.deepEqual(rows[0], { can_select: true, can_insert: true, can_update: false, can_delete: false });
});

test('the store holds no personal data, and the purge that redacts a vehicle leaves it byte-identical', async () => {
  const { rows: columns } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'rate_plans' ORDER BY ordinal_position`,
  );
  const names = columns.map((c) => c.column_name);
  assert.deepEqual(names, [
    'id', 'tenant_id', 'garage_id', 'plan_version', 'effective_from', 'document', 'engine_schema_version', 'created_at',
  ]);
  const identity = /plate|ticket|vehicle|email|phone|descriptor|owner|driver/i;
  assert.deepEqual(names.filter((n) => identity.test(n)), [], 'a column that names a person or a car');

  const garage = await newGarage();
  assert.equal((await store(garage, plan())).status, 201);
  const snapshot = () =>
    withTenant(tenant, async (c) =>
      (await c.query(`SELECT id, document::text AS document, plan_version, effective_from FROM rate_plans WHERE garage_id = $1 ORDER BY id`, [garage])).rows,
    );
  const before = await snapshot();
  assert.equal(before.length, 1);

  // A vehicle old enough to redact, so the purge does work in this run.
  const DAY = 86_400_000;
  const vehicle = await withTenant(tenant, async (c) => {
    const v = (
      await c.query(
        `INSERT INTO vehicles (tenant_id, plate, make, last_seen_at) VALUES ($1,$2,'Toyota',$3) RETURNING id`,
        [tenant, `PURGE-${randomUUID().slice(0, 8)}`, new Date(Date.now() - 40 * DAY)],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, exit_lane_id, entry_at, exit_at, currency,
                             fee_minor, hourly_minor_applied, open_event_id, close_event_id, entry_confirmation, exit_confirmation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',250,250,$8,$9,'confirmed','confirmed')`,
      [tenant, world.garage, v, world.entryLane, world.exitLane,
       new Date(Date.now() - 41 * DAY), new Date(Date.now() - 40 * DAY), randomUUID(), randomUUID()],
    );
    return v;
  });
  const result = await redactExpiredVehicles(tenant);
  assert.ok(result.redacted >= 1, 'the control: the purge redacted something this run');
  const redacted = await withTenant(tenant, async (c) =>
    (await c.query('SELECT redacted_at, make FROM vehicles WHERE id = $1', [vehicle])).rows[0],
  );
  assert.ok(redacted.redacted_at, 'the planted vehicle was the thing redacted');
  assert.equal(redacted.make, null);

  assert.deepEqual(await snapshot(), before, 'the purge did not touch the plan');
});

// --- what a closed stay keeps ------------------------------------------------------------

async function openStay() {
  return withTenant(tenant, async (c) => {
    const v = (
      await c.query(`INSERT INTO vehicles (tenant_id, plate) VALUES ($1, $2) RETURNING id`, [
        tenant, `KEEP-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    const s = (
      await c.query(
        `INSERT INTO sessions (tenant_id, garage_id, vehicle_id, entry_lane_id, entry_at, currency, open_event_id, entry_confirmation)
         VALUES ($1,$2,$3,$4, now() - interval '2 hours', 'USD', $5, 'confirmed') RETURNING id`,
        [tenant, world.garage, v, world.entryLane, randomUUID()],
      )
    ).rows[0].id;
    return s;
  });
}

const closing = () => ({
  exitAt: new Date(),
  laneId: world.exitLane,
  closeEventId: randomUUID(),
  exitConfirmation: 'confirmed',
});

const ledger = [
  { code: 'increment.first_period', rule_id: 'hourly', text: 'first hour 3.00', delta_minor: 300 },
  { code: 'increment.repeat_periods', rule_id: 'hourly', text: 'one more hour at 3.00', delta_minor: 300 },
];
const priced = { outcome: 'transient', feeMinor: 600, planVersion: 'flat-lot-2026-01', breakdown: ledger, spaceClass: 'standard' };
const unlinked = { garage_pass: { consulted: false }, monthly_billing: { consulted: false }, covered_by: [] };

test('a close priced by a plan keeps the fee, the plan_version, the breakdown and the space class, and reads them back equal', async () => {
  const id = await openStay();
  const closed = await withTenant(tenant, (c) => repo.closeSession(c, tenant, id, { ...closing(), pricing: priced, entitlement: unlinked }));
  assert.equal(Number(closed.fee_minor), 600);
  assert.equal(closed.plan_version, 'flat-lot-2026-01');
  assert.deepEqual(closed.breakdown, ledger);
  assert.equal(closed.space_class, 'standard');
  assert.equal(closed.pricing_refusal, null);
  const back = await withTenant(tenant, (c) => repo.getSession(c, tenant, id));
  assert.deepEqual(back.breakdown, ledger, 'the ledger survives the round trip');
  assert.equal(back.plan_version, 'flat-lot-2026-01');
});

test('a close the engine refused keeps the refusal and no fee', async () => {
  const id = await openStay();
  const refusal = [{ code: 'GAP_NO_PLAN_IN_FORCE_AT_ENTRY', kind: 'gap', text: 'no plan version was in force at entry', rule_ids: [] }];
  const closed = await withTenant(tenant, (c) => repo.closeSession(c, tenant, id, { ...closing(), pricing: { outcome: 'transient', refusal }, entitlement: unlinked }));
  assert.equal(closed.fee_minor, null);
  assert.equal(closed.plan_version, null);
  assert.equal(closed.breakdown, null);
  assert.deepEqual(closed.pricing_refusal, refusal);
  assert.ok(closed.exit_at, 'and the stay IS closed');
});

test('a closed stay is priced whole, or refused whole: every partial shape is refused by the database', async () => {
  for (const partial of [
    { ...priced, planVersion: null },
    { ...priced, breakdown: null },
    { ...priced, spaceClass: null },
    { ...priced, feeMinor: null },
  ]) {
    const id = await openStay();
    await assert.rejects(
      withTenant(tenant, (c) => repo.closeSession(c, tenant, id, { ...closing(), pricing: partial, entitlement: unlinked })),
      (err) => err.constraint === 'sessions_closed_is_covered_priced_or_refused',
      `${JSON.stringify(partial)} was accepted`,
    );
  }
  // A fee AND a refusal on one row is neither shape.
  const id = await openStay();
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(
        `UPDATE sessions SET exit_at = now(), exit_lane_id = $2, close_event_id = $3, exit_confirmation = 'confirmed',
                exit_outcome = 'transient', fee_minor = 600, plan_version = 'v', breakdown = '[]'::jsonb, space_class = 'standard',
                pricing_refusal = '[{"code":"X"}]'::jsonb
          WHERE id = $1`,
        [id, world.exitLane, randomUUID()],
      ),
    ),
    (err) => err.constraint === 'sessions_closed_is_covered_priced_or_refused',
  );
});

test('an OPEN stay cannot carry a pricing or a refusal, and a breakdown must be a ledger', async () => {
  const id = await openStay();
  await assert.rejects(
    withTenant(tenant, (c) =>
      c.query(`UPDATE sessions SET plan_version = 'v', breakdown = '[]'::jsonb, space_class = 'standard', fee_minor = 1 WHERE id = $1`, [id]),
    ),
    (err) => err.constraint === 'sessions_closed_is_covered_priced_or_refused',
  );
  await assert.rejects(
    withTenant(tenant, (c) => c.query(`UPDATE sessions SET pricing_refusal = '[]'::jsonb WHERE id = $1`, [id])),
    (err) => err.constraint === 'sessions_closed_is_covered_priced_or_refused',
  );
  const other = await openStay();
  await assert.rejects(
    withTenant(tenant, (c) =>
      repo.closeSession(c, tenant, other, { ...closing(), pricing: { ...priced, breakdown: { not: 'a ledger' } }, entitlement: unlinked }),
    ),
    (err) => err.constraint === 'sessions_breakdown_is_a_ledger',
  );
});

test('the rows the old hourly path wrote are still a valid closed stay, and nothing here writes that shape', async () => {
  const id = await openStay();
  await withTenant(tenant, (c) =>
    c.query(
      `UPDATE sessions SET exit_at = now(), exit_lane_id = $2, close_event_id = $3, exit_confirmation = 'confirmed',
              fee_minor = 250, hourly_minor_applied = 250 WHERE id = $1`,
      [id, world.exitLane, randomUUID()],
    ),
  );
  const row = await withTenant(tenant, (c) => repo.getSession(c, tenant, id));
  assert.equal(Number(row.fee_minor), 250);
  assert.equal(row.plan_version, null);
  const source = await readFile(new URL('../src/repository.js', import.meta.url), 'utf8');
  assert.ok(!/hourly_minor_applied\s*=/.test(source), 'closeSession no longer writes hourly_minor_applied');
});
