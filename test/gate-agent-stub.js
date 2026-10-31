/**
 * A stand-in for a site's gate agent: its two record routes, as its
 * contract (gate-agent `docs/CONTRACT.md`, contract version 2) serves them --
 *
 *   GET /v1/monitor/messages?lane=&from=&to=&since=&limit=
 *   GET /v1/agent/calls?lane=&from=&to=&since=&limit=
 *
 * -- a lane's records AND every record about no lane, `from` inclusive and
 * `to` exclusive on the record's time (`at`, a call's `started_at`), paged
 * by revision. A bearer token, when it is given one, is required on every
 * request. Every request is kept, for the tests to read what was asked.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const hex32 = () => randomBytes(16).toString('hex');

/** A message record as the monitor keeps it, with what the test names. */
export function message({ lane = 'lane-1', at, code = 'reader_unreachable', recipients = ['night-desk@example.com'], revision = 1 }) {
  return {
    record_id: `m-${hex32()}`,
    revision,
    kind: 'transition',
    site_id: 'site-1',
    monitor_id: 'monitor-1',
    lane_id: lane,
    target: 'lane',
    target_kind: 'lane',
    code,
    subject: 'reader-1',
    origin: 'target',
    transition: 'raised',
    at,
    first_seen_at: at,
    cleared_at: null,
    source: 'measured',
    caveat: null,
    status: null,
    paged: recipients.length > 0,
    deliveries: [{
      sink: 'email', kind: 'email', recipients, recipient_configured: recipients.length > 0, state: 'delivered',
      sent_at: at, delivered_at: at, next_attempt_at: null,
      attempts: [{ at, result: 'accepted', reply_code: 250, reply: '2.0.0 Ok: queued', http_status: null, reason: null, refused_recipients: [], transient: null }],
      acknowledgement: 'not_acknowledged', acknowledged_at: null, acknowledged_by: null, superseded_by: null,
    }],
  };
}

/** A call record as the agent keeps it. */
export function callRecord({ lane = 'exit', startedAt, keyed = null, revision = 1 }) {
  return {
    call_id: `c-${hex32()}`,
    revision,
    site_id: 'site-1',
    agent_id: 'agent-1',
    disposition: 'answered',
    intercom: 'sip:door1@10.0.0.9',
    lane,
    caller_stated_identity: 'sip:door1@10.0.0.9',
    started_at: startedAt,
    case: 'payment_failed',
    case_spoken_at: startedAt,
    person_called: 'sip:duty@10.0.0.5',
    rang_person_at: startedAt,
    person_answered_at: startedAt,
    person_answered_as: 'sip:duty@10.0.0.5',
    authorisation: keyed ? 'call_back' : 'open_now',
    authorisation_at: startedAt,
    keyed,
    ticket_id: null,
    ended_at: startedAt,
    outcome: 'authorisation_received',
    recording: null,
    events: [{ kind: 'authorisation_keyed', lane, at: startedAt, keyed, authorised_by: null, code: null, reason: null }],
  };
}

export async function startGateAgentStub({ token = null } = {}) {
  const requests = [];
  const store = { messages: [], calls: [] };
  const behaviour = { status: null, redirect: false, hang: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization ?? null });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (behaviour.hang) return undefined;
    if (behaviour.redirect) {
      res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' });
      return res.end();
    }
    if (behaviour.status) return send(behaviour.status, { error: 'refused' });
    if (token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorised' });
    const route = url.pathname === '/v1/monitor/messages' ? 'messages' : url.pathname === '/v1/agent/calls' ? 'calls' : null;
    if (!route) return send(404, { error: 'no such route' });
    const lane = url.searchParams.get('lane');
    const from = Date.parse(url.searchParams.get('from'));
    const to = Date.parse(url.searchParams.get('to'));
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const timeOf = (r) => Date.parse(route === 'messages' ? r.at : r.started_at);
    const laneOf = (r) => (route === 'messages' ? r.lane_id : r.lane);
    const matching = store[route]
      .filter((r) => (laneOf(r) === lane || laneOf(r) === null) && timeOf(r) >= from && timeOf(r) < to && r.revision > since)
      .sort((a, b) => a.revision - b.revision);
    const pageOf = matching.slice(0, limit);
    const more = matching.length > limit;
    const head = Math.max(0, ...store[route].map((r) => r.revision));
    return send(200, {
      contract_version: 2,
      cursor: more ? pageOf[pageOf.length - 1].revision : head,
      more,
      reset: false,
      gap: false,
      query: Object.fromEntries(url.searchParams),
      [route]: pageOf,
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    store,
    behaviour,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
