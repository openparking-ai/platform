/**
 * THE GATE AGENT'S RECORDS, READ FOR AN EXCEPTION (0048).
 *
 * A site's gate agent keeps every message its monitor sent and every call
 * its intercom agent handled (gate-agent `docs/CONTRACT.md`, contract
 * version 2):
 *
 *   GET /v1/monitor/messages?lane=&from=&to=&since=&limit=   the monitor
 *   GET /v1/agent/calls?lane=&from=&to=&since=&limit=        the agent
 *
 * When a person lets a car out, the platform copies both for the lane, over
 * the exception's window, and keeps the copy as it was at that moment, with
 * the records' own ids (`record_id`, `call_id`) and revisions.
 *
 * WHERE THEY ARE is the deployment's, not an account's: `GATE_AGENTS_FILE`
 * names a JSON file on this server, re-read at every copy --
 *
 *   {"garages": {"<garage id>": {
 *     "monitor": {"url": "http://127.0.0.1:8093", "token_file": "/path"},
 *     "agent":   {"url": "http://127.0.0.1:8094", "token_file": "/path"},
 *     "lanes":   {"<lane id>": {"monitor_lane": "<the lane's own lane_id>",
 *                               "agent_lane":   "<the agent's [lanes.<name>]>"}}}}}
 *
 * -- so no request can point this platform at an address or a file. A lane
 * is named to the monitor by its own `lane_id` (what the lane publishes on
 * `GET /v1/lane`) and to the agent by the agent's own lane name, which is not
 * the lane's id: the site maps each platform lane to both, once, here.
 *
 *   * A URL is http or https with no user, query or fragment. Off loopback it
 *     must be https and name a token file: a bearer token never crosses a
 *     network in the clear.
 *   * A token is read from its FILE at each request (an absolute path) and is
 *     never logged, stored or answered.
 *   * A redirect is never followed: the token would travel with it.
 *   * Each request has REQUEST_TIMEOUT_MS; an answer is read to at most
 *     MAX_BYTES; at most MAX_PAGES pages of PAGE_LIMIT are copied.
 *
 * NOTHING HERE BLOCKS A LET-OUT. Not configured, not reachable, refused or
 * unreadable is an outcome (`state` and `detail`), never an exception.
 *
 * WHAT IS COPIED is the record as served, but for one field: a call's
 * `keyed` -- the call-back number a person keyed, a driver's phone -- is kept
 * as its last two digits (`keyed_last2`), as a text receipt keeps its number.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const WINDOW_MINUTES = 15;
export const REQUEST_TIMEOUT_MS = 3000;
export const PAGE_LIMIT = 500;
export const MAX_PAGES = 10;
export const MAX_BYTES = 4 * 1024 * 1024;

export const SOURCES = Object.freeze({
  gate_agent_messages: {
    target: 'monitor', path: '/v1/monitor/messages', list: 'messages', id: 'record_id', idShape: /^m-[0-9a-f]{32}$/, laneKey: 'monitor_lane',
  },
  gate_agent_calls: {
    target: 'agent', path: '/v1/agent/calls', list: 'calls', id: 'call_id', idShape: /^c-[0-9a-f]{32}$/, laneKey: 'agent_lane',
  },
});

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a copy could not be made, with the state it is recorded in. */
export class NotCopied extends Error {
  constructor(state, detail) {
    super(detail);
    this.state = state;
  }
}

const notConfigured = (why) => new NotCopied('not_configured', `gate agent not configured: ${why}`);

/** One target's settings, checked; throws `not_configured` naming what is wrong. */
function target(raw, name) {
  if (!raw || typeof raw !== 'object') throw notConfigured(`no ${name} is named for this garage`);
  let url;
  try {
    url = new URL(String(raw.url));
  } catch {
    throw notConfigured(`the ${name}'s url is not a URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw notConfigured(`the ${name}'s url must be http or https, with no user, query or fragment`);
  }
  const tokenFile = raw.token_file ?? null;
  if (tokenFile !== null && (typeof tokenFile !== 'string' || !isAbsolute(tokenFile))) {
    throw notConfigured(`the ${name}'s token_file must be an absolute path`);
  }
  if (!LOOPBACK.has(url.hostname)) {
    if (url.protocol !== 'https:') throw notConfigured(`the ${name} is off loopback, so its url must be https`);
    if (!tokenFile) throw notConfigured(`the ${name} is off loopback, so it needs a token_file`);
  }
  return { url, tokenFile };
}

/**
 * What the deployment says about this garage's gate agent, for one source
 * and lane: `{url, tokenFile, lane}`, or a `NotCopied` thrown saying why
 * not -- no file named, a file that cannot be read, no entry for the garage
 * or the lane.
 */
export function configFor(garageId, laneId, source, env = process.env) {
  const file = env.GATE_AGENTS_FILE;
  if (!file) throw notConfigured('GATE_AGENTS_FILE is not set');
  if (!isAbsolute(file)) throw notConfigured('GATE_AGENTS_FILE must be an absolute path');
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw notConfigured('GATE_AGENTS_FILE cannot be read as JSON');
  }
  if (!UUID.test(String(garageId))) throw notConfigured('no garage');
  const garage = doc?.garages?.[String(garageId).toLowerCase()];
  if (!garage || typeof garage !== 'object') throw notConfigured('this garage is not in GATE_AGENTS_FILE');
  const spec = SOURCES[source];
  const t = target(garage[spec.target], spec.target);
  const lane = garage.lanes?.[String(laneId).toLowerCase()]?.[spec.laneKey];
  if (typeof lane !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(lane)) {
    throw notConfigured(`this lane has no ${spec.laneKey} in GATE_AGENTS_FILE`);
  }
  return { ...t, lane };
}

function readToken(path) {
  let token;
  try {
    token = readFileSync(path, 'utf8').trim();
  } catch {
    throw notConfigured('the token file cannot be read');
  }
  if (!token || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw notConfigured('the token file holds no usable token');
  return token;
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new NotCopied('refused', `the gate agent's answer is larger than ${MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One page, or a `NotCopied`. */
async function page(t, spec, params) {
  const url = new URL(spec.path, t.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const headers = { accept: 'application/json' };
  if (t.tokenFile) headers.authorization = `Bearer ${readToken(t.tokenFile)}`;
  let res;
  try {
    res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const why = err?.name === 'TimeoutError' ? `no answer within ${REQUEST_TIMEOUT_MS} ms` : 'it could not be reached';
    throw new NotCopied('not_reachable', `gate agent not reachable: ${why}`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new NotCopied('refused', `the gate agent answered a redirect (${res.status}), which is never followed`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const state = res.status >= 500 ? 'not_reachable' : 'refused';
    throw new NotCopied(state, `the gate agent answered ${res.status}`);
  }
  let body;
  try {
    body = JSON.parse(await readCapped(res));
  } catch (err) {
    if (err instanceof NotCopied) throw err;
    throw new NotCopied('refused', 'the gate agent answered something that is not JSON');
  }
  const list = body?.[spec.list];
  if (!body || typeof body !== 'object' || !Array.isArray(list)
    || list.some((r) => !r || typeof r !== 'object' || !spec.idShape.test(String(r[spec.id])))) {
    throw new NotCopied('refused', `the gate agent's answer is not a page of ${spec.list} this build can read`);
  }
  return { list, more: body.more === true, cursor: body.cursor, gap: body.gap === true };
}

/** A call-back number keyed by a person is kept as its last two digits, nowhere whole. */
function reduceKeyed(o) {
  if (!o || typeof o !== 'object' || !Object.hasOwn(o, 'keyed')) return o;
  const { keyed, ...rest } = o;
  const digits = typeof keyed === 'string' ? keyed.replace(/[^0-9]/g, '') : '';
  return { ...rest, keyed_last2: digits ? digits.slice(-2) : null };
}

function copyOf(source, record) {
  if (source !== 'gate_agent_calls') return record;
  const call = reduceKeyed(record);
  return Array.isArray(call.events) ? { ...call, events: call.events.map(reduceKeyed) } : call;
}

/**
 * COPY ONE SOURCE for a lane over `[from, to)`: every page, newest revision
 * of each record kept once. Answers `{state: 'copied', lane, records, gap}`
 * or `{state, detail}` -- never throws.
 */
export async function copy(source, { garageId, laneId, from, to }, env = process.env) {
  const spec = SOURCES[source];
  let t;
  try {
    t = configFor(garageId, laneId, source, env);
  } catch (err) {
    if (err instanceof NotCopied) return { state: err.state, detail: err.message.slice(0, 300) };
    throw err;
  }
  try {
    const byId = new Map();
    let since = 0;
    let gap = false;
    for (let n = 0; n < MAX_PAGES; n += 1) {
      const p = await page(t, spec, { lane: t.lane, from: from.toISOString(), to: to.toISOString(), since, limit: PAGE_LIMIT });
      gap ||= p.gap;
      for (const r of p.list) {
        const was = byId.get(r[spec.id]);
        if (!was || Number(r.revision) >= Number(was.revision)) byId.set(r[spec.id], copyOf(source, r));
      }
      if (!p.more || !/^[0-9]{1,19}$/.test(String(p.cursor))) break;
      since = p.cursor;
    }
    return { state: 'copied', lane: t.lane, records: [...byId.values()], gap };
  } catch (err) {
    if (err instanceof NotCopied) return { state: err.state, lane: t.lane, detail: err.message.slice(0, 300) };
    return { state: 'not_reachable', lane: t.lane, detail: 'gate agent not reachable: the request failed' };
  }
}
