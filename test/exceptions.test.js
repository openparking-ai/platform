/**
 * THE EXCEPTIONS (0048): the record of a car a person let out.
 *
 * What this file measures, each with a break in
 * `scripts/exit-rules-fail-control.js`:
 *
 *   * an attendant's let-out of a car that owes is an exception, written with
 *     the decision: garage, lane, stay and case; who and when; the reason;
 *     what it owed and had paid; every payment of the stay (no card data);
 *     the lane's events before it, cut to their codes -- never a plate;
 *   * what is learned after is appended: the payment once the let-out
 *     canceled it, and the gate agent's messages and calls for the lane over
 *     [case opened - 15 min, let-out + 15 min], copied with their own ids,
 *     asked with the token from its file and the lane's own names for the
 *     monitor and the agent; a keyed call-back number kept as its last two
 *     digits only;
 *   * a gate agent not configured, or not reachable, or answering a
 *     redirect, still leaves the exception, saying so, and never holds the
 *     let-out up;
 *   * a person at the lane (`let_out_by`) is an exception from the lane, by
 *     the lane computer, with the authority; a barrier opened for a car that
 *     owed nothing is kept too; one case, one exception;
 *   * after the window the sweep copies the gate agent's whole window again,
 *     complete, and the lane's events after the let-out; a let-out whose own
 *     write failed gets its exception from the record;
 *   * the reads are the garage's own (A01); the day's list counts them, and
 *     the reconciliation does;
 *   * the database holds the record: written once, never updated or deleted
 *     by the application, about a case of its own garage at that case's lane
 *     and stay.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { pool, withTenant, superuserClient } from './helpers.js';
import * as exceptions from '../src/exceptions.js';
import { startGateAgentStub, message, callRecord } from './gate-agent-stub.js';
import {
  startHarness, cardGarage, enter, caseAt, pay, caseOf, payAndPresent, close, rows, ago,
} from './exit-harness.js';

let h;
let gate;
let dir;
const TOKEN = 'gate-agent-test-token-0001';

before(async () => {
  h = await startHarness();
  gate = await startGateAgentStub({ token: TOKEN });
  dir = mkdtempSync(join(tmpdir(), 'exceptions-'));
  writeFileSync(join(dir, 'token'), `${TOKEN}\n`);
});
after(async () => {
  delete process.env.GATE_AGENTS_FILE;
  await gate?.close();
  await h?.stop();
  rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

/** The deployment's file naming this garage's gate agent, both halves on the stand-in. */
function configureGate(g, { url = gate.url, lanes = { [g.world.exitLane]: { monitor_lane: 'lane-1', agent_lane: 'exit' } } } = {}) {
  const file = join(dir, `gate-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({
    garages: {
      [g.world.garage]: {
        monitor: { url, token_file: join(dir, 'token') },
        agent: { url, token_file: join(dir, 'token') },
        lanes,
      },
    },
  }));
  process.env.GATE_AGENTS_FILE = file;
}

/** An attendant's let-out, answered; then the gate agent's copy it started after the answer, finished. */
const letOut = async (g, exitId, reason = 'reader broken, driver had cash') => {
  const res = await h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exitId}/let-out`, { reason });
  assert.equal(res.status, 200, await res.clone().text());
  await exceptions.copiesSettled();
  return (await res.json()).exit;
};
/** A lane's close, answered; then its copy finished. */
const closeThen = async (g, exitId, extra) => {
  const res = await close(h, g, exitId, extra);
  await exceptions.copiesSettled();
  return res;
};
const listOf = async (g, query = '') => {
  const res = await h.call(g.op, 'GET', `/garages/${g.world.garage}/exceptions${query}`);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};
const oneOf = async (g, id) => {
  const res = await h.call(g.op, 'GET', `/garages/${g.world.garage}/exceptions/${id}`);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).exception;
};
const exceptionOfCase = async (g, exitId) => (await rows(g, 'SELECT * FROM exceptions WHERE exit_id = $1', [exitId]))[0];

test("AN ATTENDANT'S LET-OUT OF A CAR THAT OWES is an exception: who, when, why, owed and paid, the case, the stay, every payment and the lane's events -- and the gate agent's messages and calls for the lane, copied with their ids", async () => {
  const g = await cardGarage(h, 'exc-attendant');
  configureGate(g);
  const { plate } = await enter(h, g, { inMin: 90 });
  const exit = await caseAt(h, g, plate);
  const started = await pay(h, g, exit.id);
  h.stub.presentCard(started.payment.payment_intent_id, { decline: 'generic_decline' });
  await caseOf(h, g, exit.id);
  // The reader goes offline when the card is to be tried again.
  h.stub.behaviour.failNext = { status: 400, code: 'terminal_reader_offline', message: 'offline', path: /process_payment_intent/ };
  const offline = await h.call(g.exit, 'POST', `/lane/exits/${exit.id}/pay`);
  assert.deepEqual([offline.status, (await offline.json()).code], [503, 'reader_offline']);
  // The lane tells of the reader: its detail carries what it read of the car.
  const ev = await h.call(g.exit, 'POST', '/lane/events', { events: [
    { event_id: randomUUID(), kind: 'fallback_needs_human', occurred_at: ago(0.3), detail: { cause: 'reader_declined', plate, read: plate } },
  ] });
  assert.equal(ev.status, 202, await ev.clone().text());
  // The gate agent: a message for this lane, one about no lane, one for another
  // lane, one long before; a call for this lane's intercom with a call-back keyed.
  const inWindow = message({ lane: 'lane-1', at: ago(2), revision: 1 });
  const siteWide = message({ lane: null, at: ago(1), code: 'platform_unreachable', revision: 2 });
  gate.store.messages.push(inWindow, siteWide,
    message({ lane: 'lane-2', at: ago(1), revision: 3 }), message({ lane: 'lane-1', at: ago(300), revision: 4 }));
  const theCall = callRecord({ lane: 'exit', startedAt: ago(1), keyed: '2025550100', revision: 1 });
  gate.store.calls.push(theCall, callRecord({ lane: 'entry', startedAt: ago(1), revision: 2 }));
  const asked = gate.requests.length;

  await letOut(g, exit.id);

  const list = await listOf(g);
  assert.deepEqual([list.count, list.let_out_unpaid], [1, 1]);
  const x = list.exceptions[0];
  assert.deepEqual([x.kind, x.source, x.lane_id, x.exit_id, x.stay_id, x.reason, x.owed_minor, x.paid_minor, x.currency],
    ['let_out_unpaid', 'attendant', g.world.exitLane, exit.id, exit.session_id, 'reader broken, driver had cash', 500, 0, 'USD']);
  assert.match(x.by, /^key:/, 'who pressed it: the key as the change log names it');

  const whole = await oneOf(g, x.id);
  assert.equal(whole.story.case.id, exit.id);
  assert.deepEqual([whole.story.case.settled_before.needs, whole.story.case.fee.due_minor], ['payment', 500]);
  assert.deepEqual([whole.story.stay.id, whole.story.stay.identified_by], [exit.session_id, 'plate']);
  assert.deepEqual(whole.story.payments.map((p) => [p.exit_id, p.status, p.last_failure, p.amount_minor]),
    [[exit.id, 'open', 'card_declined:generic_decline', 500]], 'every attempt as it stood: open, after a decline');
  const fallback = whole.story.lane_events.find((e) => e.kind === 'fallback_needs_human');
  assert.deepEqual(fallback.detail, { cause: 'reader_declined' }, "the lane's event cut to its codes");
  const refusedAt = whole.story.lane_events.find((e) => e.kind === 'exit_reader_refused');
  assert.deepEqual([refusedAt.detail.exit_id, refusedAt.detail.code], [exit.id, 'reader_offline'], "the reader's error around it");
  assert.ok(whole.story.lane_events.some((e) => e.kind === 'exit_payment_started'), 'the payment started, as the platform recorded it');
  assert.deepEqual([whole.payment_after_let_out.status, whole.payment_after_let_out.exit_id], ['canceled', exit.id], 'the let-out canceled it');
  const opened = Date.parse(whole.window.from) + 15 * 60_000;
  assert.ok(opened <= Date.parse(exit.exit_at) + 1 && Date.parse(whole.window.to) - Date.parse(x.let_out_at) === 15 * 60_000, 'the window: case opened - 15 min to let-out + 15 min');

  const [messages] = whole.gate_agent.messages;
  assert.deepEqual([messages.state, messages.asked_lane, messages.complete], ['copied', 'lane-1', false]);
  assert.deepEqual(messages.records.map((r) => r.record_id).sort(), [inWindow.record_id, siteWide.record_id].sort(),
    "this lane's and the site's, in the window, with their own ids");
  assert.deepEqual(messages.records.find((r) => r.record_id === inWindow.record_id).deliveries[0].recipients, ['night-desk@example.com'], 'who received');
  const [calls] = whole.gate_agent.calls;
  assert.deepEqual([calls.state, calls.asked_lane], ['copied', 'exit']);
  assert.deepEqual(calls.records.map((r) => r.call_id), [theCall.call_id]);
  assert.equal(calls.records[0].keyed_last2, '00');
  assert.equal(calls.records[0].events[0].keyed_last2, '00');
  assert.ok(!JSON.stringify(whole).includes('2025550100'), 'the call-back number is kept nowhere whole');

  const made = gate.requests.slice(asked);
  assert.deepEqual(made.map((r) => r.path).sort(), ['/v1/agent/calls', '/v1/monitor/messages']);
  for (const r of made) {
    assert.equal(r.authorization, `Bearer ${TOKEN}`, 'the token from its file');
    assert.equal(r.query.from, new Date(whole.window.from).toISOString(), 'from the window\'s start');
  }
  assert.deepEqual(made.map((r) => r.query.lane).sort(), ['exit', 'lane-1'], "each asked by its own name for the lane");
  assert.ok(!JSON.stringify(whole).includes(plate), 'no plate anywhere in the exception');
  assert.ok(!JSON.stringify(list).includes(plate));
});

test('NOT CONFIGURED, NOT REACHABLE, A REDIRECT: the exception is still written and says why, and the let-out is never held up', async () => {
  const g = await cardGarage(h, 'exc-unconfigured');
  delete process.env.GATE_AGENTS_FILE;
  const a = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, a.id);
  let x = await oneOf(g, (await exceptionOfCase(g, a.id)).id);
  for (const r of [...x.gate_agent.messages, ...x.gate_agent.calls]) {
    assert.deepEqual([r.state, r.records], ['not_configured', []]);
    assert.match(r.detail, /^gate agent not configured: GATE_AGENTS_FILE is not set/);
  }

  configureGate(g, { url: 'http://127.0.0.1:9' });
  const b = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, b.id);
  x = await oneOf(g, (await exceptionOfCase(g, b.id)).id);
  assert.deepEqual(x.gate_agent.messages.map((r) => r.state), ['not_reachable']);
  assert.match(x.gate_agent.messages[0].detail, /^gate agent not reachable/);

  // A lane with no name in the file is not configured for that lane.
  configureGate(g, { lanes: {} });
  const c = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, c.id);
  x = await oneOf(g, (await exceptionOfCase(g, c.id)).id);
  assert.match(x.gate_agent.calls[0].detail, /this lane has no agent_lane/);

  // A redirect is never followed: the token would go with it.
  configureGate(g);
  gate.behaviour.redirect = true;
  try {
    const d = await caseAt(h, g, (await enter(h, g)).plate);
    await letOut(g, d.id);
    x = await oneOf(g, (await exceptionOfCase(g, d.id)).id);
    assert.deepEqual([x.gate_agent.messages[0].state, x.gate_agent.messages[0].detail.includes('redirect')], ['refused', true]);
  } finally {
    gate.behaviour.redirect = false;
  }

  // Off loopback, plain http is refused before anything is sent.
  configureGate(g, { url: 'http://gate.example.com:8093' });
  const e = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, e.id);
  x = await oneOf(g, (await exceptionOfCase(g, e.id)).id);
  assert.match(x.gate_agent.messages[0].detail, /off loopback, so its url must be https/);
});

test('A PERSON AT THE LANE is an exception from the lane, by the lane computer, with the authority; a barrier opened for a car that owed nothing is kept too; one case, one exception', async () => {
  const g = await cardGarage(h, 'exc-lane');
  configureGate(g);
  const owing = await caseAt(h, g, (await enter(h, g)).plate);
  const res = await closeThen(g, owing.id, { let_out_by: 'human_open_and_flag' });
  assert.equal(res.status, 200, await res.clone().text());
  const x = await exceptionOfCase(g, owing.id);
  assert.deepEqual([x.kind, x.source, x.done_by, x.authority, x.owed_minor], ['let_out_unpaid', 'lane', `lane_device:${g.exitDeviceId} (Exit 1 computer)`, 'human_open_and_flag', 500]);
  const whole = await oneOf(g, x.id);
  assert.equal(whole.gate_agent.messages[0].state, 'copied');

  // Paid, then a person opened anyway: a barrier opened, owing nothing.
  const paid = await caseAt(h, g, (await enter(h, g)).plate);
  await payAndPresent(h, g, paid.id);
  assert.equal((await closeThen(g, paid.id, { let_out_by: 'human_open_now' })).status, 200);
  const opened = await exceptionOfCase(g, paid.id);
  assert.deepEqual([opened.kind, opened.owed_minor, opened.paid_minor], ['barrier_opened', 0, 500]);

  // An attendant's let-out, then the lane's close: the one exception, the attendant's.
  const both = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, both.id);
  assert.equal((await close(h, g, both.id)).status, 200);
  const one = await rows(g, 'SELECT source FROM exceptions WHERE exit_id = $1', [both.id]);
  assert.deepEqual(one.map((r) => r.source), ['attendant']);

  // A car that paid and left with nobody opening for it is no exception.
  const plain = await caseAt(h, g, (await enter(h, g)).plate);
  await payAndPresent(h, g, plain.id);
  assert.equal((await close(h, g, plain.id)).status, 200);
  assert.equal(await exceptionOfCase(g, plain.id), undefined);
});

test("THE WINDOW FINISHED: the sweep copies the gate agent's whole window again, complete, and the lane's events after the let-out; one not configured is not asked again", async () => {
  const g = await cardGarage(h, 'exc-finish');
  configureGate(g);
  const exit = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, exit.id);
  const x = await exceptionOfCase(g, exit.id);
  // Something said after the let-out, inside the window.
  const later = message({ lane: 'lane-1', at: new Date(x.let_out_at.getTime() + 5 * 60_000).toISOString(), code: 'reader_recovered', revision: 50 });
  gate.store.messages.push(later);
  await withTenant(g.tenant, (c) => c.query(
    `INSERT INTO events (tenant_id, garage_id, lane_id, event_id, kind, occurred_at, detail) VALUES ($1, $2, $3, $4, 'exit_confirmed', $5, $6)`,
    [g.tenant, g.world.garage, g.world.exitLane, randomUUID(), new Date(x.let_out_at.getTime() + 60_000), JSON.stringify({ state: 'crossed', plate: 'NOTKEPT1' })]));

  const now = new Date(x.window_to.getTime() + 60_000);
  const write = (fn) => withTenant(g.tenant, fn);
  const due = await withTenant(g.tenant, (c) => exceptions.toFinish(c, g.tenant, now));
  assert.ok(due.some((d) => d.id === x.id), 'due once its window has passed');
  await exceptions.finish(write, g.tenant, x, { now });
  const whole = await oneOf(g, x.id);
  const final = whole.gate_agent.messages.at(-1);
  assert.deepEqual([final.complete, Date.parse(final.asked_to)], [true, x.window_to.getTime()]);
  assert.ok(final.records.some((r) => r.record_id === later.record_id), 'what the gate agent said after the let-out');
  assert.equal(whole.gate_agent.calls.at(-1).complete, true);
  assert.deepEqual(whole.lane_events_after.find((e) => e.kind === 'exit_confirmed').detail, { state: 'crossed' }, "the lane's events after the let-out, cut to their codes");
  assert.ok(!JSON.stringify(whole).includes('NOTKEPT1'));
  const again = await withTenant(g.tenant, (c) => exceptions.toFinish(c, g.tenant, now));
  assert.ok(!again.some((d) => d.id === x.id), 'finished: not asked again');

  // Not configured is final; not reachable is asked again, a bounded number of times.
  delete process.env.GATE_AGENTS_FILE;
  const lone = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, lone.id);
  const y = await exceptionOfCase(g, lone.id);
  const yNow = new Date(y.window_to.getTime() + 60_000);
  await exceptions.finish(write, g.tenant, y, { now: yNow });
  const after = await withTenant(g.tenant, (c) => exceptions.toFinish(c, g.tenant, yNow));
  assert.ok(!after.some((d) => d.id === y.id), 'not configured: not asked again');
  configureGate(g, { url: 'http://127.0.0.1:9' });
  const gone = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, gone.id);
  const z = await exceptionOfCase(g, gone.id);
  const zNow = new Date(z.window_to.getTime() + 60_000);
  for (let i = 0; i < exceptions.MAX_COPIES + 2; i += 1) await exceptions.finish(write, g.tenant, z, { now: zNow });
  const tries = await rows(g, `SELECT count(*)::int AS n FROM exception_records WHERE exception_id = $1 AND source = 'gate_agent_messages'`, [z.id]);
  assert.equal(tries[0].n, exceptions.MAX_COPIES, 'asked again, at most MAX_COPIES times in all');
});

test('A LET-OUT WHOSE OWN WRITE FAILED gets its exception from the sweep, marked so; and the sweep runs clean, saying counts only', async () => {
  const g = await cardGarage(h, 'exc-recover');
  delete process.env.GATE_AGENTS_FILE;
  const exit = await caseAt(h, g, (await enter(h, g)).plate);
  // A person's decision on record with no exception beside it.
  await withTenant(g.tenant, (c) => c.query(`UPDATE exits SET person = $2 WHERE id = $1`,
    [exit.id, JSON.stringify({ by: 'owner:desk', reason: 'barrier stuck', at: new Date().toISOString() })]));
  const out = spawnSync(process.execPath, [resolve(import.meta.dirname, '..', 'scripts', 'complete-exceptions.js')], { env: process.env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout.trim(), /^exceptions: [0-9]+ tenant\(s\); [0-9]+ written from the record, [0-9]+ finished, 0 tenant\(s\) left for the next run\.$/);
  const x = await exceptionOfCase(g, exit.id);
  assert.deepEqual([x.kind, x.source, x.done_by, x.reason, x.story.recovered], ['let_out_unpaid', 'attendant', 'owner:desk', 'barrier stuck', true]);
});

test("A LET-OUT-UNPAID STAYS AN EXCEPTION ON THE OLD STAY when the car comes back in: a new stay, the old one's record untouched", async () => {
  const g = await cardGarage(h, 'exc-return');
  delete process.env.GATE_AGENTS_FILE;
  const { plate, res: opened } = await enter(h, g, { inMin: 60 });
  const exit = await caseAt(h, g, plate, { exitMin: 40 });
  await letOut(g, exit.id);
  // The lane's close never came; the car is back.
  const { res: again } = await enter(h, g, { plate, inMin: 5 });
  assert.notEqual(again.session.id, opened.session.id);
  const x = await exceptionOfCase(g, exit.id);
  assert.deepEqual([x.session_id, x.kind], [opened.session.id, 'let_out_unpaid']);
  const closedCase = (await rows(g, 'SELECT ended FROM exits WHERE id = $1', [exit.id]))[0];
  assert.deepEqual([closedCase.ended.why, closedCase.ended.by_session], ['stay_ended', again.session.id]);
});

test("THE READS ARE THE GARAGE'S OWN: another account's garage, another garage of the account, another garage's exception -- 404; a day that is not a date -- 400; the day is the garage's own", async () => {
  const g = await cardGarage(h, 'exc-reads');
  delete process.env.GATE_AGENTS_FILE;
  const exit = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, exit.id);
  const x = await exceptionOfCase(g, exit.id);
  const other = await cardGarage(h, 'exc-reads-other');
  // Another account: its key on this garage, and on this exception through its own garage.
  for (const path of [`/garages/${g.world.garage}/exceptions`, `/garages/${g.world.garage}/exceptions/${x.id}`, `/garages/${other.world.garage}/exceptions/${x.id}`]) {
    const res = await h.call(other.op, 'GET', path);
    assert.equal(res.status, 404, `${path} from another account`);
  }
  // Another garage of the same account.
  const second = await withTenant(g.tenant, async (c) => (await c.query(
    `INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, 'Second', 'America/New_York', 'USD') RETURNING id`, [g.tenant])).rows[0].id);
  const through = await h.call(g.op, 'GET', `/garages/${second}/exceptions/${x.id}`);
  assert.deepEqual([through.status, (await through.json()).code], [404, 'exception_not_found']);
  assert.equal((await listOf(g, `?day=2001-01-01`)).count, 0, 'another day: none');
  const bad = await h.call(g.op, 'GET', `/garages/${g.world.garage}/exceptions?day=2026-02-30`);
  assert.deepEqual([bad.status, (await bad.json()).code], [400, 'day_invalid']);
  const malformed = await h.call(g.op, 'GET', `/garages/${g.world.garage}/exceptions/not-an-id`);
  assert.equal(malformed.status, 404);
  const report = await (await h.call(g.op, 'GET', `/garages/${g.world.garage}/reconciliation?max_stay_hours=48`)).json();
  assert.deepEqual([report.exceptions.let_out_unpaid, report.exceptions.total], [1, 1], 'the reconciliation counts them');
});

test('THE DATABASE HOLDS THE RECORD: never updated or deleted by the application; about a case of its own garage, at its lane and stay; a barrier opened owes nothing; a record not copied says why', async () => {
  const g = await cardGarage(h, 'exc-db');
  delete process.env.GATE_AGENTS_FILE;
  const exit = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, exit.id);
  const x = await exceptionOfCase(g, exit.id);
  const refused = (sql, params, re) => assert.rejects(withTenant(g.tenant, (c) => c.query(sql, params)), re);
  await refused('UPDATE exceptions SET reason = $2 WHERE id = $1', [x.id, 'changed'], /permission denied/);
  await refused('DELETE FROM exceptions WHERE id = $1', [x.id], /permission denied/);
  await refused('UPDATE exception_records SET state = state WHERE exception_id = $1', [x.id], /never edited/);
  await refused(`UPDATE exception_records SET records = '[{"x":1}]', purged_at = now() WHERE exception_id = $1`, [x.id], /never edited|exception_records_purged_copies_only/);
  await refused('DELETE FROM exception_records WHERE exception_id = $1', [x.id], /permission denied/);
  const insert = (over) => {
    const v = {
      lane: g.world.exitLane, exit: exit.id, stay: exit.session_id, kind: 'let_out_unpaid', owed: 100, ...over,
    };
    return withTenant(g.tenant, (c) => c.query(
      `INSERT INTO exceptions (tenant_id, garage_id, lane_id, exit_id, session_id, kind, source, done_by, let_out_at, case_opened_at,
                               window_from, window_to, owed_minor, story)
       VALUES ($1, $2, $3, $4, $5, $6, 'attendant', 'test', now(), now(), now() - interval '15 minutes', now() + interval '15 minutes', $7, '{}')`,
      [g.tenant, g.world.garage, v.lane, v.exit, v.stay, v.kind, v.owed]));
  };
  const fresh = await caseAt(h, g, (await enter(h, g)).plate);
  await assert.rejects(insert({ exit: fresh.id, lane: g.world.entryLane, stay: fresh.session_id }), /at that case's lane and stay/);
  await assert.rejects(insert({ exit: fresh.id, stay: exit.session_id }), /at that case's lane and stay/);
  await assert.rejects(insert({ exit: fresh.id, stay: fresh.session_id, kind: 'barrier_opened', owed: 100 }), /exceptions_opened_owing_nothing/);
  await assert.rejects(insert({ exit: exit.id }), /exceptions_one_per_case/);
  await assert.rejects(withTenant(g.tenant, (c) => c.query(
    `INSERT INTO exception_records (tenant_id, exception_id, source, state) VALUES ($1, $2, 'gate_agent_calls', 'not_reachable')`,
    [g.tenant, x.id])), /exception_records_copied_or_why/);
});

test('A SLOW GATE AGENT NEVER HOLDS THE LET-OUT OR THE CLOSE: both are answered at once, the exception already written; the copy lands after, saying what it met', async () => {
  const g = await cardGarage(h, 'exc-slow');
  configureGate(g);
  gate.behaviour.delayMs = 5000;
  try {
    const a = await caseAt(h, g, (await enter(h, g)).plate);
    let t0 = Date.now();
    const res = await h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${a.id}/let-out`, { reason: 'reader broken' });
    const attendantMs = Date.now() - t0;
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(attendantMs < 1500, `the let-out is answered at once, not after the gate agent (${attendantMs} ms)`);
    assert.ok(await exceptionOfCase(g, a.id), 'the exception is written before the answer');

    const b = await caseAt(h, g, (await enter(h, g)).plate);
    t0 = Date.now();
    const closed = await close(h, g, b.id, { let_out_by: 'human_open_now' });
    const laneMs = Date.now() - t0;
    assert.equal(closed.status, 200, await closed.clone().text());
    assert.ok(laneMs < 1500, `the lane's close is answered at once (${laneMs} ms)`);
    assert.ok(await exceptionOfCase(g, b.id));

    await exceptions.copiesSettled();
    const whole = await oneOf(g, (await exceptionOfCase(g, a.id)).id);
    assert.deepEqual(whole.gate_agent.messages.map((r) => [r.state, r.detail]), [['not_reachable', 'gate agent not reachable: no answer within 3000 ms']]);
  } finally {
    gate.behaviour.delayMs = 0;
  }
});

test("THE EXCEPTION'S OWN WRITE FAILING NEVER TAKES THE LET-OUT BACK: the car stays let out, the failure is logged, and the sweep writes the exception from the record", async () => {
  const g = await cardGarage(h, 'exc-write-fails');
  delete process.env.GATE_AGENTS_FILE;
  const su = superuserClient();
  await su.connect();
  const name = `test_refuse_exception_${g.tenant.replace(/-/g, '').slice(0, 12)}`;
  // The database refuses this account's exceptions, as an outage or a defect would.
  await su.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.tenant_id = '${g.tenant}' THEN RAISE EXCEPTION 'exceptions refused for this test'; END IF; RETURN NEW; END $$`);
  await su.query(`CREATE TRIGGER ${name} BEFORE INSERT ON exceptions FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  let attendant;
  let lane;
  try {
    attendant = await caseAt(h, g, (await enter(h, g)).plate);
    const res = await h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${attendant.id}/let-out`, { reason: 'barrier stuck' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await rows(g, 'SELECT person FROM exits WHERE id = $1', [attendant.id]))[0].person.reason, 'barrier stuck', 'the let-out stands');
    lane = await caseAt(h, g, (await enter(h, g)).plate);
    const closed = await close(h, g, lane.id, { let_out_by: 'human_open_now' });
    assert.equal(closed.status, 200, await closed.clone().text());
    assert.equal((await closed.json()).session.let_out.owed_minor, 500, 'the stay is let out, owing');
    assert.equal(await exceptionOfCase(g, attendant.id), undefined);
    assert.equal(await exceptionOfCase(g, lane.id), undefined);
  } finally {
    await su.query(`DROP TRIGGER IF EXISTS ${name} ON exceptions`);
    await su.query(`DROP FUNCTION IF EXISTS ${name}()`);
    await su.end();
  }
  const out = spawnSync(process.execPath, [resolve(import.meta.dirname, '..', 'scripts', 'complete-exceptions.js')], { env: process.env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const a = await exceptionOfCase(g, attendant.id);
  const b = await exceptionOfCase(g, lane.id);
  assert.deepEqual([a.source, a.reason, a.story.recovered], ['attendant', 'barrier stuck', true]);
  assert.deepEqual([b.source, b.authority, b.owed_minor, b.story.recovered], ['lane', 'human_open_now', 500, true]);
});

test("A COPY OF THE GATE AGENT'S RECORDS IS BLANKED PAST THE ACCOUNT'S WINDOW -- 400 days unless it sets another; the exception and the rest stay", async () => {
  const g = await cardGarage(h, 'exc-retention');
  configureGate(g);
  gate.store.messages.push(message({ lane: 'lane-1', at: ago(1), revision: 900 }));
  const exit = await caseAt(h, g, (await enter(h, g)).plate);
  await pay(h, g, exit.id);
  await letOut(g, exit.id);
  const x = await exceptionOfCase(g, exit.id);
  const blank = (days) => withTenant(g.tenant, (c) => exceptions.blankExpiredCopies(c, g.tenant, new Date(Date.now() + days * 86_400_000)));
  assert.equal(await blank(399), 0, 'inside the 400 days: kept');
  assert.equal(await blank(401), 2, 'past them: the messages and the calls');
  const whole = await oneOf(g, x.id);
  for (const r of [...whole.gate_agent.messages, ...whole.gate_agent.calls]) {
    assert.deepEqual([r.records, Boolean(r.purged_at), r.state], [[], true, 'copied']);
  }
  assert.equal(whole.payment_after_let_out.exit_id, exit.id, 'what else was appended stays');
  assert.equal(whole.story.case.id, exit.id, 'the exception stays');
  assert.equal(await blank(800), 0, 'blanked once');

  // An account that keeps them a day.
  await withTenant(g.tenant, (c) => c.query(
    `INSERT INTO tenant_settings (tenant_id, exception_copy_retention_days) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET exception_copy_retention_days = 1`, [g.tenant]));
  const other = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, other.id);
  assert.equal(await blank(2), 2);
  await assert.rejects(withTenant(g.tenant, (c) => c.query(`UPDATE tenant_settings SET exception_copy_retention_days = 0 WHERE tenant_id = $1`, [g.tenant])), /check constraint/);
});

const JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 30, g: 90, b: 200 } } }).jpeg().toBuffer();
/** A picture the lane keeps under an event id (0033): its id, as stored. */
async function picture(g, device, eventId, takenAt) {
  const ref = randomUUID().slice(0, 30);
  const res = await h.call(device, 'POST', '/lane/pictures', { picture_ref: ref, event_id: eventId, taken_at: takenAt, image: JPEG.toString('base64') });
  assert.ok([200, 201].includes(res.status), await res.clone().text());
  return (await rows(g, 'SELECT id FROM entry_pictures WHERE picture_ref = $1', [ref]))[0].id;
}

test('THE PICTURES OF AN EXCEPTION, BY ID: its stay\'s entry, its case\'s exit, the lane\'s in its window -- each served through the exception and its garage only, and gone with the retention', async () => {
  const g = await cardGarage(h, 'exc-pictures');
  delete process.env.GATE_AGENTS_FILE;
  const openEvent = randomUUID();
  const { plate } = await enter(h, g, { inMin: 40, eventId: openEvent });
  const exitEvent = randomUUID();
  const exit = await caseAt(h, g, plate, { eventId: exitEvent });
  const entryPic = await picture(g, g.entry, openEvent, ago(40));
  const exitPic = await picture(g, g.exit, exitEvent, ago(0.4));
  const lanePic = await picture(g, g.exit, randomUUID(), ago(2));
  const oldPic = await picture(g, g.exit, randomUUID(), ago(300));
  const otherLane = await picture(g, g.entry, randomUUID(), ago(1));
  await letOut(g, exit.id);
  const x = await exceptionOfCase(g, exit.id);
  const whole = await oneOf(g, x.id);
  assert.deepEqual(whole.pictures.entry.map((p) => p.id), [entryPic]);
  assert.deepEqual(whole.pictures.exit.map((p) => [p.id, p.exit_id]), [[exitPic, exit.id]]);
  assert.deepEqual(whole.pictures.lane.map((p) => [p.id, p.lane_id]), [[lanePic, g.world.exitLane]], "the lane's in the window, not before it nor another lane's");
  assert.ok(!JSON.stringify(whole.pictures).includes('image'), 'ids and times only');

  const get = (op, garage, pictureId) => h.call(op, 'GET', `/garages/${garage}/exceptions/${x.id}/pictures/${pictureId}`);
  for (const id of [entryPic, exitPic, lanePic]) {
    const res = await get(g.op, g.world.garage, id);
    assert.equal(res.status, 200);
    assert.deepEqual([res.headers.get('content-type'), res.headers.get('cache-control'), res.headers.get('x-content-type-options')], ['image/jpeg', 'private, no-store', 'nosniff']);
    assert.ok((await res.arrayBuffer()).byteLength > 0);
  }
  for (const id of [oldPic, otherLane]) assert.equal((await get(g.op, g.world.garage, id)).status, 404, 'a picture the exception does not list');
  const other = await cardGarage(h, 'exc-pictures-other');
  assert.equal((await get(other.op, g.world.garage, entryPic)).status, 404, "another account's key");
  assert.equal((await get(other.op, other.world.garage, entryPic)).status, 404, 'through another garage');
  // The retention job deletes a picture: it is listed no more, and not served.
  await withTenant(g.tenant, (c) => c.query('DELETE FROM entry_pictures WHERE id = $1', [lanePic]));
  assert.deepEqual((await oneOf(g, x.id)).pictures.lane, []);
  assert.equal((await get(g.op, g.world.garage, lanePic)).status, 404);
});

test("THE DAY'S LIST SAYS THE GATE AGENT IN SHORT: messages, failed deliveries, calls, answered calls and the copy's state -- and the day may be named in the path", async () => {
  const g = await cardGarage(h, 'exc-summary');
  configureGate(g);
  const failing = message({ lane: 'lane-1', at: ago(1), revision: 700 });
  failing.deliveries[0].state = 'failed';
  gate.store.messages.push(failing, message({ lane: 'lane-1', at: ago(1), revision: 701 }));
  const answered = callRecord({ lane: 'exit', startedAt: ago(1), revision: 700 });
  const unanswered = { ...callRecord({ lane: 'exit', startedAt: ago(1), revision: 701 }), person_answered_at: null, person_answered_as: null };
  gate.store.calls.push(answered, unanswered);
  const a = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, a.id);
  delete process.env.GATE_AGENTS_FILE;
  const b = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, b.id);
  configureGate(g, { url: 'http://127.0.0.1:9' });
  const c = await caseAt(h, g, (await enter(h, g)).plate);
  await letOut(g, c.id);

  const list = await listOf(g);
  const byCase = (exitId) => list.exceptions.find((x) => x.exit_id === exitId).gate_agent;
  const summaryA = byCase(a.id);
  assert.ok(summaryA.messages >= 2 && summaryA.failed_deliveries >= 1 && summaryA.calls >= 2 && summaryA.calls_answered >= 1, JSON.stringify(summaryA));
  assert.equal(summaryA.calls - summaryA.calls_answered >= 1, true);
  assert.deepEqual([summaryA.copy, summaryA.copies, summaryA.purged], ['pending', { messages: 'pending', calls: 'pending' }, false], 'copied, the window still open');
  assert.deepEqual(byCase(b.id), { messages: 0, failed_deliveries: 0, calls: 0, calls_answered: 0, copy: 'not_configured', copies: { messages: 'not_configured', calls: 'not_configured' }, purged: false });
  assert.equal(byCase(c.id).copy, 'not_reachable');
  // The sweep after the window: complete.
  const x = await exceptionOfCase(g, a.id);
  configureGate(g);
  await exceptions.finish((fn) => withTenant(g.tenant, fn), g.tenant, x, { now: new Date(x.window_to.getTime() + 60_000) });
  assert.equal((await listOf(g)).exceptions.find((e) => e.exit_id === a.id).gate_agent.copy, 'complete');

  // The day in the path: the same answer as ?day=.
  const today = list.day;
  const byPath = await h.call(g.op, 'GET', `/garages/${g.world.garage}/exceptions/day/${today}`);
  assert.equal(byPath.status, 200, await byPath.clone().text());
  const pathList = await byPath.json();
  assert.deepEqual([pathList.day, pathList.count, pathList.from, pathList.to], [today, list.count, list.from, list.to]);
  for (const bad of ['2026-02-30', '2026-13-01', '31-10-2026', 'today', '0000-01-01', '1969-12-31']) {
    const res = await h.call(g.op, 'GET', `/garages/${g.world.garage}/exceptions/day/${bad}`);
    assert.deepEqual([res.status, (await res.json()).code], [400, 'day_invalid'], bad);
  }
  for (const bad of ['0000-01-01', '9999-12-31']) {
    const res = await h.call(g.op, 'GET', `/garages/${g.world.garage}/exceptions?day=${bad}`);
    assert.deepEqual([res.status, (await res.json()).code], [400, 'day_invalid'], `?day=${bad}`);
  }
  const other = await cardGarage(h, 'exc-summary-other');
  assert.equal((await h.call(other.op, 'GET', `/garages/${g.world.garage}/exceptions/day/${today}`)).status, 404, "another account's garage");
});

test("THE STORY KEEPS THE CREDIT: each payment less its refunds, the ones Stripe could not be asked about, and a price lower than paid marked for a manager", async () => {
  const g = await cardGarage(h, 'exc-credit');
  delete process.env.GATE_AGENTS_FILE;
  // Paid three hours; then, at another lane's clock behind, priced at two --
  // with Stripe silent on refunds.
  const { plate } = await enter(h, g, { inMin: 150 });
  const first = await caseAt(h, g, plate, { exitMin: 0.5 });
  await payAndPresent(h, g, first.id);
  h.stub.behaviour.failNext = { status: 500, type: 'api_error', code: 'api_error', message: 'down', path: /latest_charge/ };
  const lower = await caseAt(h, g, plate, { exitMin: 50 });
  await letOut(g, lower.id, 'priced lower, opened by hand');
  let fee = (await oneOf(g, (await exceptionOfCase(g, lower.id)).id)).story.case.fee;
  const paymentId = (await rows(g, 'SELECT id FROM exit_payments WHERE exit_id = $1', [first.id]))[0].id;
  assert.deepEqual(fee.credit.refunds_unread, [paymentId], 'Stripe silent: said so');
  assert.deepEqual(fee.repriced_lower, { paid_minor: 750, repriced_minor: 500, outcome: 'transient' });

  // Paid 500, 200 of it refunded at Stripe, read at the next exit.
  const { plate: other } = await enter(h, g, { inMin: 90 });
  const paid = await caseAt(h, g, other, { exitMin: 1 });
  const started = await payAndPresent(h, g, paid.id);
  h.stub.refund(started.payment.payment_intent_id, 200);
  const back = await caseAt(h, g, other);
  await letOut(g, back.id);
  const whole = await oneOf(g, (await exceptionOfCase(g, back.id)).id);
  fee = whole.story.case.fee;
  assert.deepEqual([fee.credit_minor, fee.credit.paid_minor, fee.credit.payments.map((p) => [p.amount_minor, p.refunded_minor]), fee.credit.refunds_unread, fee.repriced_lower],
    [300, 300, [[500, 200]], [], null]);
  assert.deepEqual(whole.story.payments.filter((p) => p.exit_id === paid.id).map((p) => p.refunded_minor), [200], "the payment's refund, in the story's payments too");
});
