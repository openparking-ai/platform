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
  let seq = 0;
  const behaviour = { failNext: null };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const entry = { method: req.method, path: req.url, headers: req.headers, raw };
      requests.push(entry);
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (behaviour.failNext) {
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
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
