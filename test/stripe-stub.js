/**
 * A stand-in for the few Stripe endpoints this platform calls, for the suite.
 *
 * CI holds no Stripe key and never will: this repository's workflows reference
 * no secrets. So the suite measures what THIS code sends and what it does with
 * an answer, against a local server that records every request whole --
 * method, path, headers, raw body -- and answers in the shapes Stripe's API
 * reference gives. That the shapes ARE Stripe's is established separately, by
 * execution against Stripe's test mode (scripts/stripe-test-mode-check.js),
 * not by this file.
 *
 * Ids are invented (`acct_stub...`), as the commercial-values guard requires.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

/** `metadata[k]=v` form keys, as the object Stripe returns. */
function metadataOf(form) {
  const out = {};
  for (const [k, v] of Object.entries(form)) {
    const m = k.match(/^metadata\[(.+)\]$/);
    if (m) out[m[1]] = v;
  }
  return out;
}

export async function startStripeStub() {
  const requests = [];
  const accounts = new Map(); // id -> account
  const byIdempotencyKey = new Map(); // key -> account id
  const terminal = []; // locations and readers, as created
  const terminalByKey = new Map();
  const intents = new Map(); // id -> payment intent
  const intentByKey = new Map();
  const readerActions = []; // every process_payment_intent the stub accepted
  const cancelByKey = new Map(); // idempotency key -> the first answer, replayed as Stripe does
  const cancels = []; // every cancel the stub carried out (not replays)
  let seq = 0;
  /** The reader action working on this intent, ended as Stripe ends it: succeeded, or failed with a code. */
  const finishAction = (intentId, outcome) => {
    for (const t of terminal) {
      if (t.action?.status === 'in_progress' && t.action.process_payment_intent?.payment_intent === intentId) {
        t.action = { ...t.action, ...outcome };
      }
    }
  };
  /**
   * What the next request meets. `failNext` fails the next request (or the
   * next whose path matches `failNext.path`). For a cancel: `beforeCancel`
   * runs first (a card paying in the same instant); `delayCancelMs` holds the
   * answer; `dropNextCancel` carries the cancel out and never answers, as a
   * connection lost on the way back. `readerBusyNextClear`: the card is being
   * authorised, and the reader's action cannot be cleared. `holdCreate`, a
   * promise: a new intent is made and answered only once it settles.
   */
  const behaviour = { failNext: null, beforeCancel: null, delayCancelMs: 0, dropNextCancel: false, readerBusyNextClear: false, holdCreate: null };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const entry = { method: req.method, path: req.url, headers: req.headers, raw };
      requests.push(entry);
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (behaviour.failNext && (!behaviour.failNext.path || behaviour.failNext.path.test(req.url))) {
        const f = behaviour.failNext;
        behaviour.failNext = null;
        return send(f.status, { error: { type: f.type ?? 'invalid_request_error', code: f.code, message: f.message } });
      }
      if (!/^Bearer .+/.test(req.headers.authorization ?? '')) {
        return send(401, { error: { type: 'invalid_request_error', message: 'no key' } });
      }
      const url = new URL(req.url, 'http://stub');

      if (req.method === 'POST' && url.pathname === '/v1/accounts') {
        const key = req.headers['idempotency-key'];
        if (key && byIdempotencyKey.has(key)) return send(200, accounts.get(byIdempotencyKey.get(key)).created);
        const form = Object.fromEntries(new URLSearchParams(raw));
        seq += 1;
        // Unique across runs: the database outlives any one stub.
        const id = `acct_stub${randomBytes(6).toString('hex')}${seq}`;
        const account = {
          id,
          form,
          seq,
          metadata: metadataOf(form),
          garage: form['metadata[openparking_garage_id]'],
          created: { id, object: 'account' },
          // What a read reports, kept here so the test can move it.
          v1: { card_payments: 'inactive', charges_enabled: false, details_submitted: false },
        };
        accounts.set(id, account);
        if (key) byIdempotencyKey.set(key, id);
        return send(200, account.created);
      }
      if (req.method === 'POST' && url.pathname === '/v1/account_links') {
        const form = Object.fromEntries(new URLSearchParams(raw));
        if (!accounts.has(form.account)) return send(404, { error: { code: 'resource_missing', message: 'no such account' } });
        return send(200, {
          object: 'account_link',
          url: `https://connect.stripe.com/setup/s/stub/${form.account}`,
          created: 1767225600,
          expires_at: 1767225900,
        });
      }
      // Terminal, on a connected account: the Stripe-Account header names it.
      if (req.method === 'POST' && (url.pathname === '/v1/terminal/locations' || url.pathname === '/v1/terminal/readers')) {
        const on = req.headers['stripe-account'];
        if (!on || !accounts.has(on)) {
          return send(400, { error: { type: 'invalid_request_error', code: 'account_invalid', message: 'no such connected account' } });
        }
        const key = req.headers['idempotency-key'];
        if (key && terminalByKey.has(key)) return send(200, terminalByKey.get(key));
        const form = Object.fromEntries(new URLSearchParams(raw));
        let object;
        if (url.pathname === '/v1/terminal/locations') {
          object = { id: `tml_stub${randomBytes(6).toString('hex')}`, object: 'terminal.location', display_name: form.display_name, form, on };
        } else {
          if (!String(form.registration_code).startsWith('simulated')) {
            return send(400, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'registration code is not valid' } });
          }
          object = { id: `tmr_stub${randomBytes(6).toString('hex')}`, object: 'terminal.reader', label: form.label, location: form.location, form, on };
        }
        if (key) terminalByKey.set(key, object);
        terminal.push(object);
        return send(200, object);
      }
      // PaymentIntents and reader actions (0038), on a connected account.
      if (url.pathname.startsWith('/v1/payment_intents') || /^\/v1\/terminal\/readers\/[^/]+(\/(process_payment_intent|cancel_action))?$/.test(url.pathname)) {
        const on = req.headers['stripe-account'];
        if (!on || !accounts.has(on)) {
          return send(400, { error: { type: 'invalid_request_error', code: 'account_invalid', message: 'no such connected account' } });
        }
        const form = Object.fromEntries(new URLSearchParams(raw));
        if (req.method === 'POST' && url.pathname === '/v1/payment_intents') {
          if (behaviour.holdCreate) await behaviour.holdCreate;
          const key = req.headers['idempotency-key'];
          if (key && intentByKey.has(key)) return send(200, intents.get(intentByKey.get(key)));
          const id = `pi_stub${randomBytes(6).toString('hex')}`;
          const types = Object.keys(form).filter((k) => k.startsWith('payment_method_types[')).map((k) => form[k]);
          const intent = {
            id, object: 'payment_intent', amount: Number(form.amount), currency: form.currency, status: 'requires_payment_method',
            payment_method_types: types, capture_method: form.capture_method, client_secret: `${id}_secret_stub`,
            last_payment_error: null, metadata: metadataOf(form), on,
          };
          intents.set(id, intent);
          if (key) intentByKey.set(key, id);
          return send(200, intent);
        }
        const pi = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/);
        if (pi) {
          const intent = intents.get(decodeURIComponent(pi[1]));
          if (!intent || intent.on !== on) return send(404, { error: { code: 'resource_missing', message: 'no such payment_intent' } });
          if (req.method === 'GET' && !pi[2]) {
            // `expand[]=latest_charge`: the charge, with what was refunded of it.
            if (!url.searchParams.getAll('expand[]').includes('latest_charge')) return send(200, intent);
            const charge = intent.status === 'succeeded'
              ? { id: `ch_${intent.id.slice(3)}`, object: 'charge', amount: intent.amount, amount_refunded: intent.refunded ?? 0 }
              : null;
            return send(200, { ...intent, latest_charge: charge });
          }
          if (req.method === 'POST' && pi[2]) {
            const key = req.headers['idempotency-key'];
            if (key && cancelByKey.has(key)) {
              const first = cancelByKey.get(key);
              return send(first.status, first.body);
            }
            if (behaviour.beforeCancel) {
              const before = behaviour.beforeCancel;
              behaviour.beforeCancel = null;
              before(intent);
            }
            let answer;
            if (intent.status === 'succeeded' || intent.status === 'canceled') {
              answer = { status: 400, body: { error: { type: 'invalid_request_error', code: 'payment_intent_unexpected_state', message: `cannot cancel a ${intent.status} intent` } } };
            } else {
              intent.status = 'canceled';
              cancels.push(intent.id);
              finishAction(intent.id, { status: 'failed', failure_code: 'payment_intent_canceled' });
              answer = { status: 200, body: { ...intent } };
            }
            if (key) cancelByKey.set(key, answer);
            if (behaviour.dropNextCancel) {
              behaviour.dropNextCancel = false;
              return req.socket.destroy();
            }
            if (behaviour.delayCancelMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayCancelMs));
            return send(answer.status, answer.body);
          }
        }
        const readerRead = url.pathname.match(/^\/v1\/terminal\/readers\/([^/]+)$/);
        if (readerRead && req.method === 'GET') {
          const reader = terminal.find((t) => t.id === decodeURIComponent(readerRead[1]) && t.object === 'terminal.reader');
          if (!reader || reader.on !== on) return send(404, { error: { code: 'resource_missing', message: 'no such reader' } });
          return send(200, { id: reader.id, object: 'terminal.reader', action: reader.action ?? null });
        }
        const action = url.pathname.match(/^\/v1\/terminal\/readers\/([^/]+)\/(process_payment_intent|cancel_action)$/);
        if (action && req.method === 'POST') {
          const reader = terminal.find((t) => t.id === decodeURIComponent(action[1]) && t.object === 'terminal.reader');
          if (!reader || reader.on !== on) return send(404, { error: { code: 'resource_missing', message: 'no such reader' } });
          if (action[2] === 'cancel_action') {
            if (behaviour.readerBusyNextClear) {
              behaviour.readerBusyNextClear = false;
              return send(400, { error: { type: 'invalid_request_error', code: 'terminal_reader_busy', message: 'the reader is busy' } });
            }
            reader.action = null;
            return send(200, { id: reader.id, object: 'terminal.reader', action: null });
          }
          // As Stripe: a reader with an action still in progress -- a payment
          // waiting for its card, or being authorised -- refuses a new one;
          // it never replaces it. A finished action (succeeded, failed) is
          // replaced.
          if (reader.action?.status === 'in_progress') {
            return send(400, { error: { type: 'invalid_request_error', code: 'terminal_reader_busy', message: 'Reader is currently busy processing another request.' } });
          }
          const intent = intents.get(form.payment_intent);
          if (!intent || intent.on !== on) return send(404, { error: { code: 'resource_missing', message: 'no such payment_intent' } });
          if (intent.status !== 'requires_payment_method') {
            return send(400, { error: { type: 'invalid_request_error', code: 'intent_invalid_state', message: 'Payment intent must be in the requires_payment_method state to be processed by a reader.' } });
          }
          reader.action = { type: 'process_payment_intent', status: 'in_progress', process_payment_intent: { payment_intent: intent.id } };
          readerActions.push({ reader: reader.id, intent: intent.id });
          return send(200, { id: reader.id, object: 'terminal.reader', action: reader.action });
        }
      }
      const read = url.pathname.match(/^\/v1\/accounts\/([^/]+)$/);
      if (req.method === 'GET' && read) {
        const a = accounts.get(decodeURIComponent(read[1]));
        if (!a) return send(404, { error: { code: 'resource_missing', message: 'no such account' } });
        return send(200, {
          id: a.id,
          object: 'account',
          capabilities: { card_payments: a.v1.card_payments },
          charges_enabled: a.v1.charges_enabled,
          details_submitted: a.v1.details_submitted,
        });
      }
      // The account list, newest first, paged the way Stripe pages it.
      if (req.method === 'GET' && url.pathname === '/v1/accounts') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 10), 100);
        const after = url.searchParams.get('starting_after');
        const all = [...accounts.values()].sort((a, b) => b.seq - a.seq);
        const start = after ? all.findIndex((a) => a.id === after) + 1 : 0;
        const page = all.slice(start, start + limit);
        return send(200, {
          object: 'list',
          data: page.map((a) => ({ id: a.id, object: 'account', metadata: a.metadata })),
          has_more: start + limit < all.length,
        });
      }
      return send(404, { error: { code: 'resource_missing', message: `stub has no ${req.method} ${url.pathname}` } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    accounts,
    terminal,
    behaviour,
    /**
     * An account Stripe made on a request whose answer never came back: it
     * exists at Stripe, names its garage in its metadata, and no reservation
     * recorded it.
     */
    plantAccount(metadata) {
      seq += 1;
      const id = `acct_stub${randomBytes(6).toString('hex')}${seq}`;
      accounts.set(id, {
        id, seq, metadata, garage: metadata.openparking_garage_id, form: {},
        created: { id, object: 'account' },
        v1: { card_payments: 'inactive', charges_enabled: false, details_submitted: false },
      });
      return id;
    },
    /** Stripe's side moves: onboarding done, capability granted. */
    setState(id, v1) {
      Object.assign(accounts.get(id).v1, v1);
    },
    intents,
    readerActions,
    cancels,
    /**
     * A card at the reader or the phone: paid, or declined -- the intent back
     * to waiting for a card, as Stripe leaves it, with the decline on it.
     */
    presentCard(intentId, { decline = null } = {}) {
      const intent = intents.get(intentId);
      if (decline) {
        intent.status = 'requires_payment_method';
        intent.last_payment_error = { code: 'card_declined', decline_code: decline };
        finishAction(intentId, { status: 'failed', failure_code: 'card_declined' });
      } else {
        intent.status = 'succeeded';
        intent.last_payment_error = null;
        finishAction(intentId, { status: 'succeeded' });
      }
    },
    /** A refund made at Stripe's dashboard: this platform is told nothing. */
    refund(intentId, amountMinor) {
      const intent = intents.get(intentId);
      intent.refunded = (intent.refunded ?? 0) + amountMinor;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
