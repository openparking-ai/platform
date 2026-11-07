/**
 * A car at the barrier gets 3 seconds of Stripe's charge read, not 30
 * (exitPayments.REFUND_READ_TIMEOUT_MS). These tests wait that time out, so they
 * stand apart from test/exit-payment-sweep.test.js; each has a break in
 * `scripts/exit-payments-fail-control.js`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './helpers.js';
import {
  startHarness, cardGarage, enter, caseAt, pay, close, plateNo, rows,
} from './exit-harness.js';

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.stop();
  await pool.end();
});

async function paid(g) {
  const { plate } = await enter(h, g, { plate: plateNo('TIM') });
  const exit = await caseAt(h, g, plate);
  const paying = await pay(h, g, exit.id);
  h.stub.presentCard(paying.payment.payment_intent_id);
  return exit;
}

test('Control: a charge read that answers at once holds nothing up', async () => {
  const g = await cardGarage(h, 'time-control');
  const exit = await paid(g);
  const t = Date.now();
  assert.equal((await close(h, g, exit.id)).status, 200);
  assert.ok(Date.now() - t < 2000);
});

test('A SLOW CHARGE READ AT A CLOSE is cut at 3 seconds, and the close goes on', async () => {
  const g = await cardGarage(h, 'time-close');
  const exit = await paid(g);
  h.stub.behaviour.delayRefundReadMs = 6000;
  const t = Date.now();
  try {
    const res = await close(h, g, exit.id);
    assert.equal(res.status, 200);
  } finally {
    h.stub.behaviour.delayRefundReadMs = 0;
  }
  assert.ok(Date.now() - t < 4500, `took ${Date.now() - t} ms`);
  assert.equal((await rows(g, 'SELECT status FROM exit_payments WHERE exit_id = $1', [exit.id]))[0].status, 'succeeded');
});

test('A SLOW CHARGE READ AT A LET-OUT is waited for once, not twice', async () => {
  const g = await cardGarage(h, 'time-let-out');
  const exit = await paid(g);
  h.stub.behaviour.delayRefundReadMs = 5000;
  const t = Date.now();
  try {
    const res = await h.call(g.op, 'POST', `/garages/${g.world.garage}/exits/${exit.id}/let-out`, { reason: 'gate jammed' });
    assert.equal(res.status, 200);
  } finally {
    h.stub.behaviour.delayRefundReadMs = 0;
  }
  assert.ok(Date.now() - t < 4500, `took ${Date.now() - t} ms`);
});
