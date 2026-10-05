/**
 * U4 check 1 -- THE CHECKLIST IS THE DATA.
 *
 * GET /api/v1/garages/:garageId/setup works every step out from the garage's
 * own rows (src/setup.js). For each step, a garage built to make it done and
 * one built to make it not done, and the read says exactly that, with the
 * facts it was decided on. Built by writing the rows directly, so what is
 * measured is the read and not the routes that write them.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant, storePlan, flatHourlyPlan, stateTaxes } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { LANE_QUIET_MINUTES, STEP_KEYS } from '../src/setup.js';
import { startServer, owner, call } from './u4-world.js';

let server;
let base;
let a;
let b;

before(async () => {
  ({ server, base } = await startServer());
  a = await owner(base, 'setup-a');
  b = await owner(base, 'setup-b');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

/** A garage written straight to the table, and its lanes; `lanes` is [[name, direction], ...]. */
async function garage({ name = 'Harbor Garage', transient = null, lanes = [] } = {}) {
  return withTenant(a.tenant, async (c) => {
    const g = (await c.query(
      `INSERT INTO garages (tenant_id, name, timezone, currency, transient_available) VALUES ($1, $2, 'America/New_York', 'USD', $3) RETURNING id`,
      [a.tenant, name, transient],
    )).rows[0].id;
    const ids = {};
    for (const [laneName, direction] of lanes) {
      ids[laneName] = (await c.query(
        `INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1, $2, $3, $4) RETURNING id`,
        [a.tenant, g, laneName, direction],
      )).rows[0].id;
    }
    return { id: g, lanes: ids };
  });
}

const computer = (laneId, { heardMinutesAgo = 0, revoked = false, never = false } = {}) =>
  withTenant(a.tenant, (c) => c.query(
    `INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash, last_seen_at, revoked_at)
     VALUES ($1, $2, 'pi', $3, ${never ? 'NULL' : `now() - make_interval(mins => $4)`}, ${revoked ? 'now()' : 'NULL'})`,
    never ? [a.tenant, laneId, hashToken(generateDeviceToken())] : [a.tenant, laneId, hashToken(generateDeviceToken()), heardMinutesAgo],
  ));

const RUN = Math.random().toString(36).slice(2, 10);
let readers = 0;
const reader = (garageId, laneId) =>
  withTenant(a.tenant, (c) => c.query(
    `INSERT INTO lane_readers (tenant_id, garage_id, lane_id, account_id, location_id, reader_id, label, bound_by)
     VALUES ($1, $2, $3, 'acct_stubSetup', 'tml_stubSetup', $4, 'Exit reader', 'test')`,
    [a.tenant, garageId, laneId, `tmr_setup${RUN}${(readers += 1)}`],
  ));

const account = (garageId, { charges = true, cards = 'active' } = {}) =>
  withTenant(a.tenant, (c) => c.query(
    `INSERT INTO garage_stripe_accounts (tenant_id, garage_id, create_idempotency_key, create_requested_by, account_id, account_recorded_at,
                                         card_payments, card_payments_read_at, charges_enabled, charges_enabled_read_at,
                                         details_submitted, details_submitted_read_at)
     VALUES ($1, $2, $3, 'test', $4, now(), $5, now(), $6, now(), true, now())`,
    [a.tenant, garageId, `k-${garageId}`, `acct_setup${garageId.slice(0, 8)}`, cards, charges],
  ));

async function read(garageId, as = a, via = 'session') {
  const r = await call(base, 'GET', `/garages/${garageId}/setup`, { as, via });
  assert.equal(r.status, 200, r.text);
  return r.json.setup;
}
const step = (setup, key) => setup.steps.find((s) => s.key === key);

test('the steps come in their order, each with key, done and facts and nothing else; the session and the key read the same', async () => {
  const g = await garage({ transient: true, lanes: [['In', 'entry'], ['Out', 'exit']] });
  const bySession = await read(g.id);
  const byKey = await read(g.id, a, 'key');
  assert.deepEqual(bySession, byKey);
  assert.deepEqual(bySession.steps.map((s) => s.key), STEP_KEYS);
  for (const s of bySession.steps) assert.deepEqual(Object.keys(s).sort(), ['done', 'facts', 'key']);
  assert.deepEqual(Object.keys(bySession).sort(), ['garage_id', 'open', 'steps', 'takes_any_driver']);
});

test('garage_details: done with a name, a time zone and money; not done with an empty name', async () => {
  const yes = step(await read((await garage()).id), 'garage_details');
  assert.deepEqual(yes, { key: 'garage_details', done: true, facts: { name: 'Harbor Garage', timezone: 'America/New_York', currency: 'USD' } });
  const no = step(await read((await garage({ name: '' })).id), 'garage_details');
  assert.equal(no.done, false);
});

test('drivers: done once answered either way; not done while unanswered', async () => {
  assert.deepEqual(step(await read((await garage({ transient: true })).id), 'drivers'), { key: 'drivers', done: true, facts: { transient_available: true } });
  assert.deepEqual(step(await read((await garage({ transient: false })).id), 'drivers'), { key: 'drivers', done: true, facts: { transient_available: false } });
  assert.deepEqual(step(await read((await garage()).id), 'drivers'), { key: 'drivers', done: false, facts: { transient_available: null } });
});

test('lanes: done with a way in and a way out; not done with only one of them, or none', async () => {
  assert.equal(step(await read((await garage({ lanes: [['In', 'entry'], ['Out', 'exit']] })).id), 'lanes').done, true);
  const onlyIn = step(await read((await garage({ lanes: [['In', 'entry'], ['In 2', 'entry']] })).id), 'lanes');
  assert.deepEqual(onlyIn, { key: 'lanes', done: false, facts: { entry_lanes: 2, exit_lanes: 0, closed_lanes: [] } });
  assert.equal(step(await read((await garage()).id), 'lanes').done, false);
});

test('lane_computers: done when every lane has a computer heard from inside the quiet minutes; each other state named', async () => {
  const good = await garage({ lanes: [['In', 'entry'], ['Out', 'exit']] });
  await computer(good.lanes.In, { heardMinutesAgo: 1 });
  await computer(good.lanes.Out, { heardMinutesAgo: LANE_QUIET_MINUTES - 1 });
  const done = step(await read(good.id), 'lane_computers');
  assert.equal(done.done, true);
  assert.deepEqual([done.facts.lanes, done.facts.working, done.facts.not_working, done.facts.quiet_minutes], [2, 2, [], LANE_QUIET_MINUTES]);

  const mixed = await garage({ lanes: [['Quiet', 'entry'], ['None', 'exit'], ['Cancelled', 'exit'], ['Never', 'entry']] });
  await computer(mixed.lanes.Quiet, { heardMinutesAgo: LANE_QUIET_MINUTES + 5 });
  await computer(mixed.lanes.Cancelled, { heardMinutesAgo: 1, revoked: true });
  await computer(mixed.lanes.Never, { never: true });
  const notDone = step(await read(mixed.id), 'lane_computers');
  assert.equal(notDone.done, false);
  assert.deepEqual(notDone.facts.not_working.map((l) => [l.name, l.state]).sort(), [['Cancelled', 'cancelled'], ['Never', 'never_heard'], ['None', 'none'], ['Quiet', 'quiet']]);
  assert.equal(notDone.facts.working, 0);
  // No lanes at all is not "every lane has one".
  assert.equal(step(await read((await garage()).id), 'lane_computers').done, false);
});

test('rates: done with a plan in force; not done with none, or with one that starts later', async () => {
  const yes = await garage();
  await withTenant(a.tenant, (c) => storePlan(c, a.tenant, yes.id, flatHourlyPlan()));
  assert.deepEqual(step(await read(yes.id), 'rates').facts, { stored: 1, in_force: 1, earliest: '2000-01-01T00:00:00.000Z' });
  assert.equal(step(await read(yes.id), 'rates').done, true);
  const later = await garage();
  await withTenant(a.tenant, (c) => storePlan(c, a.tenant, later.id, flatHourlyPlan({ effectiveFrom: '2099-01-01T00:00:00Z' })));
  assert.equal(step(await read(later.id), 'rates').done, false);
  assert.equal(step(await read((await garage()).id), 'rates').done, false);
});

test('taxes: done once stated, charging none included; not done while unstated', async () => {
  const none = await garage();
  await withTenant(a.tenant, (c) => stateTaxes(c, a.tenant, none.id));
  const s = step(await read(none.id), 'taxes');
  assert.equal(s.done, true);
  assert.equal(s.facts.rules_in_force, 0);
  assert.equal(step(await read((await garage()).id), 'taxes').done, false);
});

test('getting_paid and card_readers: only for a garage that takes any driver; done with an account that takes cards and a reader on every way out', async () => {
  assert.deepEqual((await read((await garage({ transient: false })).id)).steps.map((s) => s.key).filter((k) => k === 'getting_paid' || k === 'card_readers'), []);
  assert.deepEqual((await read((await garage()).id)).steps.map((s) => s.key).filter((k) => k === 'getting_paid' || k === 'card_readers'), []);

  const yes = await garage({ transient: true, lanes: [['In', 'entry'], ['Out', 'exit'], ['Out 2', 'exit']] });
  await account(yes.id);
  await reader(yes.id, yes.lanes.Out);
  await reader(yes.id, yes.lanes['Out 2']);
  const setup = await read(yes.id);
  assert.equal(step(setup, 'getting_paid').done, true);
  assert.equal(step(setup, 'getting_paid').facts.can_be_set_up_here, false, 'this suite runs with no Connect configured');
  assert.deepEqual(step(setup, 'card_readers'), { key: 'card_readers', done: true, facts: { exit_lanes: 2, with_reader: 2, without_reader: [] } });

  const no = await garage({ transient: true, lanes: [['Out', 'exit'], ['Out 2', 'exit']] });
  await account(no.id, { charges: false, cards: 'inactive' });
  await reader(no.id, no.lanes.Out);
  const notYet = await read(no.id);
  assert.equal(step(notYet, 'getting_paid').done, false);
  assert.deepEqual(step(notYet, 'card_readers').facts.without_reader.map((l) => l.name), ['Out 2']);
  assert.equal(step(notYet, 'card_readers').done, false);
  const noAccount = await read((await garage({ transient: true })).id);
  assert.deepEqual([step(noAccount, 'getting_paid').done, step(noAccount, 'getting_paid').facts.account], [false, false]);
});

test('open: done when the garage is open; otherwise what the platform still needs and every step not done', async () => {
  const shut = await read((await garage({ lanes: [['In', 'entry']] })).id);
  assert.deepEqual(step(shut, 'open'), {
    key: 'open', done: false,
    facts: { open: false, opened_at: null, required_missing: ['rates', 'drivers', 'taxes'], not_done: ['drivers', 'lanes', 'lane_computers', 'rates', 'taxes'] },
  });
  const live = await garage({ transient: false });
  await withTenant(a.tenant, async (c) => {
    await storePlan(c, a.tenant, live.id, flatHourlyPlan());
    await stateTaxes(c, a.tenant, live.id);
    await c.query('UPDATE garages SET activated_at = now() WHERE id = $1', [live.id]);
  });
  const opened = await read(live.id);
  assert.equal(opened.open, true);
  assert.equal(step(opened, 'open').done, true);
  assert.deepEqual(step(opened, 'open').facts.required_missing, []);
});

test("another owner's garage is not found, and the read writes nothing", async () => {
  const g = await garage();
  const r = await call(base, 'GET', `/garages/${g.id}/setup`, { as: b });
  assert.deepEqual([r.status, r.json], [404, { error: 'garage not found' }]);
  const unsigned = await call(base, 'GET', `/garages/${g.id}/setup`);
  assert.equal(unsigned.status, 401);
});
