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

export async function startStripeStub() {
  const requests = [];
  const accounts = new Map(); // id -> account
  const byIdempotencyKey = new Map(); // key -> account id
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
      return send(404, { error: { code: 'resource_missing', message: `stub has no ${req.method} ${url.pathname}` } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    accounts,
    behaviour,
    /** Stripe's side moves: onboarding done, capability granted. */
    setState(id, v1) {
      Object.assign(accounts.get(id).v1, v1);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
