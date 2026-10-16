#!/usr/bin/env node
/**
 * Ends the open stays nothing closed (0035). An operator's tool, run by hand:
 *
 *   node scripts/abandon-stays.js <tenant-id> <garage-id> --older-than-hours <n> [--session <id>]... [--apply]
 *
 * Lists every open stay of the garage that came in more than <n> hours ago
 * -- or only the --session ones among them -- by id and entry time, never by
 * plate. Nothing changes without --apply. With it, each is ENDED as
 * abandoned: closed unpriced at this moment, with its event and a line in the
 * garage's change log, by the platform. A late close whose exit falls inside
 * the stay still closes and prices it -- and so does an exit after this
 * moment, before the car's next entry: a stay abandoned while its car was in
 * fact still inside is priced by the car's real exit.
 *
 * There is no default for <n>: how long is too long is the operator's call
 * for the garage in front of them.
 *
 * Until a stay closes it is a car inside, however long ago it came in: the
 * fill rule's "how full at entry" counts it, and so do the checks on the
 * garage's number of spaces. Nothing ages it out. Ending it here takes it out
 * of that count from this moment, with a line in the change log.
 */
import { pool } from '../src/db.js';
import { abandonStays } from '../src/stays.js';

const USAGE = 'usage: abandon-stays.js <tenant-id> <garage-id> --older-than-hours <n> [--session <id>]... [--apply]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

const args = process.argv.slice(2);
const [tenantId, garageId] = args;
if (!UUID.test(tenantId ?? '') || !UUID.test(garageId ?? '')) refuse('a tenant id and a garage id are required');
let olderThanHours = null;
const sessionIds = [];
let apply = false;
for (let i = 2; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--apply') apply = true;
  else if (arg === '--older-than-hours') olderThanHours = Number(args[(i += 1)]);
  else if (arg === '--session') {
    const id = args[(i += 1)];
    if (!UUID.test(id ?? '')) refuse(`--session takes a stay id, not ${JSON.stringify(id ?? null)}`);
    sessionIds.push(id);
  } else refuse(`unknown argument ${JSON.stringify(arg)}`);
}
if (!Number.isFinite(olderThanHours) || olderThanHours <= 0) refuse('--older-than-hours is required: a positive number of hours');

try {
  const { found, ended } = await abandonStays(tenantId, garageId, {
    olderThanHours, sessionIds: sessionIds.length ? sessionIds : null, apply,
  });
  for (const stay of found) console.log(`${stay.id}  came in ${stay.entry_at.toISOString()}`);
  console.log(
    apply
      ? `${ended.length} open stay(s) older than ${olderThanHours} h ended as abandoned.`
      : `${found.length} open stay(s) older than ${olderThanHours} h; nothing changed (--apply ends them).`,
  );
} catch (err) {
  console.error(`abandon-stays: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
