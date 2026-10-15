/**
 * The database restarts under a running platform.
 *
 * A Postgres restart ends every connection the platform holds (57P01). One
 * held by a request at that moment used to emit 'error' on its client with no
 * listener, and Node ended the whole process. The platform here is the REAL
 * entrypoint (`src/server.js`) in its own process, so an uncaught error ends
 * it as it would on a server. It reaches Postgres through a TCP pass-through
 * this test can cut and put back, and the superuser ends the platform's own
 * backends (pg_terminate_backend: what a restart sends) while its requests
 * run. The platform's connections are named (application_name), so the test's
 * own are never ended.
 *
 * Held: the process never exits; every request answers 200/201 or a plain
 * 503; a write and its change-log line land together exactly once or not at
 * all; a stay is opened once and closed once; /healthz says the database is
 * unreachable while it is and ok again with no restart. The paths are the
 * lane's session open and close and its /rules, a rate-plan save and a tax
 * save.
 *
 * Plants: scripts/db-restart-fail-control.js.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, connect as tcpConnect } from 'node:net';
import { pool, withTenant, createTenant, buildWorld, superuserClient } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { DatabaseUnavailable, internals, query, unavailableAnswer } from '../src/db.js';

const APP_NAME = 'platform-db-restart-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** What a 503 must never carry: Postgres's words, an address, a setting. */
const DB_WORDS = /terminat|administrator|ECONN|password|postgres|openparking_app|127\.0\.0\.1|relation|constraint|SQLSTATE|57P0/i;

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** A TCP pass-through to Postgres that can be cut (every connection dropped, new ones refused) and put back on the same port. */
async function cable(target) {
  const sockets = new Set();
  let server = null;
  let port = 0;
  const listen = () => new Promise((resolve) => {
    server = createServer((inbound) => {
      const outbound = tcpConnect(target.port, target.host);
      // Either side closed closes the other, as a direct connection would: a
      // reset from Postgres is an 'error', which pipe() does not pass on, and
      // a pass-through that kept the platform's side open would hold its query
      // forever.
      for (const [s, other] of [[inbound, outbound], [outbound, inbound]]) {
        sockets.add(s);
        s.on('close', () => { sockets.delete(s); other.destroy(); });
        s.on('error', () => {});
      }
      inbound.pipe(outbound).pipe(inbound);
    });
    server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
  await listen();
  return {
    get port() { return port; },
    async cut() {
      await new Promise((r) => { server.close(() => r()); for (const s of sockets) s.destroy(); });
    },
    putBack: listen,
  };
}

let engine; let link; let child; let base; let su;
let tenant; let world; let entryToken; let exitToken; let operatorToken; let flatLot;
let exited = null;
let output = '';

async function deviceToken(laneId) {
  const token = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(
    'INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)', [tenant, laneId, 'device', hashToken(token)]));
  return token;
}

async function newGarage(name) {
  return withTenant(tenant, async (c) => (await c.query(
    `INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, $2, 'America/New_York', 'USD') RETURNING id`,
    [tenant, name])).rows[0].id);
}

async function call(method, path, { token = operatorToken, body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  // A request never answered fails here, by name, rather than as the test's timeout.
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    .catch((err) => { throw new Error(`${method} ${path}: ${err.name}`); });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, text, retryAfter: res.headers.get('retry-after') };
}

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const open = (plate, eventId = randomUUID()) => call('POST', '/api/v1/lane/sessions/open', {
  token: entryToken, body: { plate, entry_confirmation: 'confirmed', entry_at: minutesAgo(90), event_id: eventId },
});
const close = (plate) => call('POST', '/api/v1/lane/sessions/close', {
  token: exitToken, body: { plate, exit_confirmation: 'confirmed', exit_at: minutesAgo(1), event_id: randomUUID() },
});
const rules = () => call('GET', '/api/v1/lane/rules', { token: entryToken });
const savePlan = (garageId) => call('POST', `/api/v1/garages/${garageId}/rate-plans`, {
  body: {
    plan: { ...structuredClone(flatLot), plan_version: `flat-${randomUUID().slice(0, 8)}`, effective_from: new Date(Date.now() - 5000).toISOString() },
    confirmed: true,
    based_on: null,
  },
});
const CITY = { id: 'city', label: 'City parking tax', percent_bp: 1850, rounding: 'nearest', sequence: 1 };
const saveTax = (garageId) => call('POST', `/api/v1/garages/${garageId}/tax-sets`, {
  body: { tax_set: { effective_from: '2026-02-01T00:00:00Z', rules: [CITY] } },
});

/** The platform's own backends, ended as a restart ends them. */
const endPlatformBackends = () => su.query(
  'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()', [APP_NAME]);

async function waitFor(what, fn, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const got = await fn().catch(() => false);
    if (got) return got;
    if (Date.now() > until) throw new Error(`waited ${ms} ms for ${what}`);
    await sleep(25);
  }
}

const alive = () => assert.deepEqual(
  { exited, output: exited ? output.slice(-3000) : null }, { exited: null, output: null }, 'the platform process exited');

/** Plans (or tax sets) of a garage, and their change-log lines: one each, or none of either. */
async function writesOf(garageId, table, action) {
  const rows = (await su.query(`SELECT count(*)::int AS n FROM ${table} WHERE garage_id = $1`, [garageId])).rows[0].n;
  const lines = (await su.query(
    "SELECT count(*)::int AS n FROM garage_changes WHERE garage_id = $1 AND outcome = 'done' AND action = $2", [garageId, action])).rows[0].n;
  return { rows, lines };
}
/** The stays of a plate: how many, and how many closed. */
async function staysOf(plate) {
  return (await su.query(
    `SELECT count(*)::int AS stays, count(s.exit_at)::int AS closed
       FROM sessions s JOIN vehicles v ON v.id = s.vehicle_id AND v.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND v.plate = $2`, [tenant, plate])).rows[0];
}

/** A 503 as the platform says it: its own code, plain words, a time to wait. */
function plain503(a, label) {
  assert.equal(a.status, 503, label);
  assert.match(a.body?.code ?? '', /^database_unavailable(_saving)?$/, `${label}: ${a.text}`);
  assert.equal(typeof a.body.error, 'string');
  assert.deepEqual(Object.keys(a.body).sort(), ['code', 'error']);
  assert.doesNotMatch(a.text, DB_WORDS, label);
  assert.equal(a.retryAfter, '5', label);
}

before(async () => {
  engine = await startRateEngine();
  tenant = await createTenant('restart');
  world = await buildWorld(tenant, { hourlyMinor: 250 });
  entryToken = await deviceToken(world.entryLane);
  exitToken = await deviceToken(world.exitLane);
  operatorToken = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(
    "INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)", [tenant, hashToken(operatorToken)]));
  flatLot = JSON.parse(await readFile(new URL('./fixtures/rate-plans/flat_lot.json', import.meta.url), 'utf8'));
  su = superuserClient();
  await su.connect();

  const direct = new URL(process.env.APP_DATABASE_URL);
  link = await cable({ host: direct.hostname, port: Number(direct.port || 5432) });
  const through = new URL(direct.href);
  through.hostname = '127.0.0.1';
  through.port = String(link.port);
  through.searchParams.set('application_name', APP_NAME);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), APP_DATABASE_URL: through.href, RATE_ENGINE_URL: engine.url };
  child = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  await waitFor('the platform to answer /healthz', async () => (await fetch(`${base}/healthz`)).status === 200);
});

after(async () => {
  if (child && exited === null) {
    child.kill('SIGTERM');
    await waitFor('the platform to stop', async () => exited !== null, 5000).catch(() => {});
  }
  await link?.cut().catch(() => {});
  await engine?.stop();
  await su?.end().catch(() => {});
  await pool.end();
});

describe('the database restarts under a running platform', () => {
  test('requests whose connections are ended mid-query are tried once on fresh ones: answered, written once, the platform still running', async () => {
    const planGarage = await newGarage('Held plan');
    const taxGarage = await newGarage('Held tax');
    const plate = `HELD-${randomUUID().slice(0, 6)}`;
    // Every request held inside its transaction by the superuser's lock on
    // garages, so the platform's connections are checked out, mid-query, when
    // their backends are ended.
    const lock = superuserClient();
    await lock.connect();
    let answers;
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE garages IN ACCESS EXCLUSIVE MODE');
      answers = Promise.all([rules(), open(plate), savePlan(planGarage), saveTax(taxGarage)]);
      await waitFor('the four requests to wait on the lock', async () => (await su.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [APP_NAME])).rows[0].n >= 4);
      await endPlatformBackends();
      // The second try may land on the lock again; it is let go a moment later.
      await sleep(200);
      alive();
    } finally {
      await lock.query('COMMIT').catch(() => {});
      await lock.end();
    }
    const [r, o, p, t] = await answers;
    alive();
    assert.deepEqual([r.status, o.status, p.status, t.status], [200, 201, 201, 201], JSON.stringify([r.text, o.text, p.text, t.text]));
    assert.deepEqual(await writesOf(planGarage, 'rate_plans', 'rate_plan.add'), { rows: 1, lines: 1 });
    assert.deepEqual(await writesOf(taxGarage, 'garage_tax_sets', 'tax_set.add'), { rows: 1, lines: 1 });
    assert.deepEqual(await staysOf(plate), { stays: 1, closed: 0 });
    // And it leaves: closed once, under the same kind of loss.
    const closed = await close(plate);
    assert.equal(closed.status, 200, closed.text);
    assert.deepEqual(await staysOf(plate), { stays: 1, closed: 1 });
  });

  test("requests while the platform's backends are ended again and again: each 200/201 or a plain 503, every write whole", async (t) => {
    const ROUNDS = 8;
    const planGarages = [];
    const taxGarages = [];
    for (let i = 0; i < ROUNDS * 2; i += 1) {
      planGarages.push(await newGarage(`Churn plan ${i}`));
      taxGarages.push(await newGarage(`Churn tax ${i}`));
    }
    // Cars already inside, to leave under the churn.
    const inside = [];
    for (let i = 0; i < ROUNDS * 2; i += 1) {
      const plate = `OUT-${i}-${randomUUID().slice(0, 6)}`;
      assert.equal((await open(plate)).status, 201);
      inside.push(plate);
    }

    const answers = [];
    let stop = false;
    let ended = 0;
    const killer = (async () => {
      while (!stop) {
        ended += (await endPlatformBackends().catch(() => ({ rowCount: 0 }))).rowCount;
        await sleep(15);
      }
    })();
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        const batch = [];
        for (let i = 0; i < 2; i += 1) {
          const n = round * 2 + i;
          const plate = `IN-${n}-${randomUUID().slice(0, 6)}`;
          batch.push(open(plate).then((a) => ({ ...a, kind: 'open', plate })));
          batch.push(close(inside[n]).then((a) => ({ ...a, kind: 'close', plate: inside[n] })));
          batch.push(savePlan(planGarages[n]).then((a) => ({ ...a, kind: 'plan', garage: planGarages[n] })));
          batch.push(saveTax(taxGarages[n]).then((a) => ({ ...a, kind: 'tax', garage: taxGarages[n] })));
          batch.push(rules().then((a) => ({ ...a, kind: 'rules' })));
          batch.push(call('GET', `/api/v1/garages/${world.garage}`).then((a) => ({ ...a, kind: 'read' })));
        }
        answers.push(...await Promise.all(batch));
      }
    } finally {
      stop = true;
      await killer;
    }
    alive();
    assert.ok(ended > 0, 'the churn ended none of the platform\'s connections: it measured nothing');
    const counts = {};
    for (const a of answers) {
      const key = `${a.kind} ${a.status}${a.status === 503 ? ` ${a.body?.code}` : ''}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    t.diagnostic(`${ended} backends ended; answers: ${JSON.stringify(counts)}`);

    for (const a of answers) {
      assert.ok([200, 201, 503].includes(a.status), `${a.kind}: ${a.status} ${a.text}`);
      if (a.status === 503) plain503(a, a.kind);
      // A read saves nothing: never told "it may have been saved".
      if (a.kind === 'read' || a.kind === 'rules') assert.notEqual(a.body?.code, 'database_unavailable_saving', a.kind);
    }
    // Whole: each plan and tax set has exactly one line, or neither exists.
    for (const a of answers.filter((x) => x.kind === 'plan' || x.kind === 'tax')) {
      const w = a.kind === 'plan'
        ? await writesOf(a.garage, 'rate_plans', 'rate_plan.add')
        : await writesOf(a.garage, 'garage_tax_sets', 'tax_set.add');
      assert.equal(w.rows, w.lines, `${a.kind}: a write without its line, or a line without its write`);
      assert.ok(w.rows <= 1, `${a.kind}: written twice`);
      if (a.status === 201) assert.equal(w.rows, 1, `${a.kind}: answered 201 and not there`);
      if (a.status === 503 && a.body.code === 'database_unavailable') assert.equal(w.rows, 0, `${a.kind}: "nothing was changed" and something was`);
    }
    // A stay opened once (never twice), closed once.
    for (const a of answers.filter((x) => x.kind === 'open')) {
      const s = await staysOf(a.plate);
      assert.ok(s.stays <= 1, `open: ${s.stays} stays for one car`);
      if (a.status === 201) assert.equal(s.stays, 1, 'open: answered 201 and not there');
      if (a.status === 503 && a.body.code === 'database_unavailable') assert.equal(s.stays, 0);
    }
    for (const a of answers.filter((x) => x.kind === 'close')) {
      const s = await staysOf(a.plate);
      assert.equal(s.stays, 1, 'close: the stay is still one stay');
      if (a.status === 200) assert.equal(s.closed, 1, 'close: answered 200 and still open');
      if (a.status === 503 && a.body.code === 'database_unavailable') assert.equal(s.closed, 0);
    }
  });

  test('/healthz says the database is unreachable while it is, and ok again with no restart; the doors answer a plain 503 meanwhile', async () => {
    const pid = child.pid;
    const taxGarage = await newGarage('While down');
    await link.cut();
    const health = await call('GET', '/healthz');
    assert.equal(health.status, 503);
    assert.deepEqual(health.body, { ok: false, db: 'unreachable' });
    plain503(await rules(), 'rules while down');
    plain503(await call('GET', `/api/v1/garages/${world.garage}`), 'read while down');
    const tax = await saveTax(taxGarage);
    plain503(tax, 'tax while down');
    assert.equal(tax.body.code, 'database_unavailable');
    alive();

    await link.putBack();
    await waitFor('/healthz ok again', async () => (await call('GET', '/healthz')).status === 200);
    assert.deepEqual((await call('GET', '/healthz')).body, { ok: true, db: 'connected' });
    assert.equal((await rules()).status, 200);
    assert.equal(child.pid, pid);
    alive();
    assert.deepEqual(await writesOf(taxGarage, 'garage_tax_sets', 'tax_set.add'), { rows: 0, lines: 0 });
  });

  test("the platform's log names codes only: never the password, the address or a Postgres message", async () => {
    assert.match(output, /\[db\] connection lost \(/);
    assert.doesNotMatch(output, /terminating connection|administrator command|postgres:\/\//i);
    const password = decodeURIComponent(new URL(process.env.APP_DATABASE_URL).password);
    assert.ok(!output.includes(password), 'the log carries the database password');
    assert.doesNotMatch(output, /\[api\]/, 'an internal error was logged: a loss reached the 500 path');
    alive();
  });
});

// A connection that answers each statement as the test says: the moment a
// COMMIT is lost cannot be timed against a real backend, so it is held here.
describe('what is tried again, and what is not', () => {
  const realConnect = internals.connect;
  let sent;
  const fake = (answer) => {
    sent = [];
    internals.connect = async () => ({
      query: async (text) => { sent.push(text); return answer(text, sent); },
      release: () => {},
    });
  };
  const ended = () => Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
  const TENANT = '00000000-0000-4000-8000-00000000abcd';
  after(() => { internals.connect = realConnect; });

  test('lost while the COMMIT is on its way: not tried again (it may have been saved), answered as "saving"', async () => {
    fake((text) => { if (text === 'COMMIT') throw ended(); return { rows: [] }; });
    let runs = 0;
    const err = await withTenant(TENANT, async () => { runs += 1; }).catch((e) => e);
    assert.ok(err instanceof DatabaseUnavailable);
    assert.equal(err.saving, true);
    assert.equal(err.code, 'database_unavailable_saving');
    assert.equal(runs, 1);
    assert.equal(sent.filter((t) => t === 'COMMIT').length, 1);
  });

  test('lost before the COMMIT: tried once more, then a plain "unavailable" (nothing saved)', async () => {
    fake((text) => { if (text === 'BEGIN') throw ended(); return { rows: [] }; });
    const err = await withTenant(TENANT, async () => {}).catch((e) => e);
    assert.ok(err instanceof DatabaseUnavailable);
    assert.equal(err.saving, false);
    assert.equal(sent.filter((t) => t === 'BEGIN').length, 2);
    assert.ok(!sent.includes('COMMIT'));
  });

  test('lost before the COMMIT where a second try would repeat something outside: not tried again', async () => {
    fake((text) => { if (text === 'BEGIN') throw ended(); return { rows: [] }; });
    const err = await withTenant(TENANT, async () => {}, { retry: false }).catch((e) => e);
    assert.ok(err instanceof DatabaseUnavailable);
    assert.equal(sent.filter((t) => t === 'BEGIN').length, 1);
  });

  test('a connection that cannot be opened: tried once more, then unavailable', async () => {
    let tries = 0;
    internals.connect = async () => { tries += 1; throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
    const err = await query('SELECT 1').catch((e) => e);
    assert.ok(err instanceof DatabaseUnavailable);
    assert.equal(tries, 2);
  });

  test('a read lost at its COMMIT is told "unavailable", never "it may have been saved"; a change is told "saving"', () => {
    const saving = new DatabaseUnavailable(true);
    for (const m of ['GET', 'HEAD']) assert.equal(unavailableAnswer(saving, m).code, 'database_unavailable', m);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(unavailableAnswer(saving, m).code, 'database_unavailable_saving', m);
    assert.equal(unavailableAnswer(new DatabaseUnavailable(false), 'POST').code, 'database_unavailable');
  });

  test('an ordinary refusal of the database is not a lost connection: not tried again, handed back as it is', async () => {
    fake((text) => { if (/INSERT/.test(text)) throw Object.assign(new Error('dup'), { code: '23505' }); return { rows: [] }; });
    let runs = 0;
    const err = await withTenant(TENANT, async (c) => { runs += 1; await c.query('INSERT x'); }).catch((e) => e);
    assert.equal(err.code, '23505');
    assert.equal(runs, 1);
    assert.ok(sent.includes('ROLLBACK'));
  });
});
