#!/usr/bin/env node
/**
 * The control for the ticket identity.
 *
 * A stay can now be identified by something a camera never read. Every property
 * that makes that safe rather than merely possible is broken below, one at a
 * time, and the suite is REQUIRED to go red. A pass is the failure.
 *
 * Two kinds of break, because the properties live in two places:
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 *
 *   no_exactly_one       the request boundary stops enforcing exactly one of
 *                        plate and ticket_ref, so a row could claim this
 *                        platform bound a measurement to an assertion.
 *   no_shape_check       a ticket_ref is any string at all. The value is a
 *                        lookup key that is echoed into responses and read out
 *                        over a telephone.
 *   identity_lookup_or   the exit lookup becomes `v.plate = $3 OR
 *                        v.ticket_ref = $3` -- one query matching two different
 *                        vehicles across two columns, at the moment a lane is
 *                        deciding whose stay to close.
 *   close_plate_only     the close goes back to plate-only. A ticket stay then
 *                        opens, the car gets in, and the stay can never be
 *                        closed or billed. This is the money hole, and nothing
 *                        else in the suite sees it.
 *   listing_drops_ticket the operator's open-sessions listing stops selecting
 *                        the column, so a ticket stay appears as a row with no
 *                        identity at all.
 *   retention_skips_ticket  the purge redacts the plate and leaves the ticket.
 *                        The reassuring direction: it still reports rows
 *                        redacted.
 *   retention_both       the purge writes the placeholder into BOTH columns.
 *                        This is what the CASE in retention.js exists to
 *                        prevent, and without it the whole purge fails.
 *   no_assisted_kind     the platform stops knowing the event kind the lane's
 *                        assisted vend writes BEFORE it pulses the relay.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * constraint edited out of 0007, so the constraint genuinely never existed
 * there, and run the suite against that. They are here because the two
 * constraints ARE the property -- a rule enforced only at a route is a rule one
 * direct INSERT goes around -- and a migration is not a file a source break can
 * reach.
 *
 * Dropping the constraint on the shared test database instead was tried and is
 * wrong: the suite then writes the very rows the constraint forbids, and
 * putting it back afterwards fails with `23514` on the rows the break allowed.
 * A control that cannot restore what it broke is a control that leaves the next
 * run meaningless.
 *
 *   drop_exactly_one     `vehicles_exactly_one_identity` never created.
 *   drop_ticket_unique   `vehicles_tenant_ticket_ref_key` never created.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.TICKET_SCRATCH_DB || 'openparking_ticket_identity_control';

const SOURCE_BREAKS = [
  {
    name: 'no_exactly_one',
    why: 'the route accepts both identities, or neither',
    file: 'src/app.js',
    from: `  if (Boolean(plate) === Boolean(ticketRef)) {`,
    to: `  if (!plate && !ticketRef && false) {`,
  },
  {
    name: 'no_shape_check',
    why: 'a ticket_ref may be any string at all',
    file: 'src/app.js',
    from: 'const TICKET_REF_SHAPE = /^[A-Z0-9-]{6,64}$/;',
    to: 'const TICKET_REF_SHAPE = /^[\\s\\S]*$/;',
  },
  {
    name: 'identity_lookup_or',
    why: 'one lookup matches a plate and a ticket of the same text',
    file: 'src/repository.js',
    from: "  const column = ticketRef ? 'ticket_ref' : 'plate';",
    to: "  const column = 'plate';",
  },
  {
    name: 'close_plate_only',
    why: 'a ticket stay can never be closed or billed',
    file: 'src/app.js',
    from: `      const { plate, ticketRef } = laneIdentity(req.body);
      if (!closeEventId) throw bad('event_id is required');`,
    to: `      const { plate } = laneIdentity(req.body);
      const ticketRef = null;
      if (!closeEventId) throw bad('event_id is required');`,
  },
  {
    name: 'listing_drops_ticket',
    why: 'a ticket stay appears in the listing with no identity on it',
    file: 'src/repository.js',
    from: '            v.plate, v.plate_region, v.ticket_ref, l.name AS entry_lane',
    to: '            v.plate, v.plate_region, l.name AS entry_lane',
  },
  {
    name: 'retention_skips_ticket',
    why: 'the purge redacts the plate and leaves the ticket',
    file: 'src/retention.js',
    from: `              ticket_ref   = CASE WHEN v.ticket_ref IS NULL THEN NULL
                                  ELSE 'redacted:' || v.id END,`,
    to: '              ticket_ref   = v.ticket_ref,',
  },
  {
    name: 'retention_both',
    why: 'the purge writes the placeholder into both columns',
    file: 'src/retention.js',
    from: `          SET plate        = CASE WHEN v.plate      IS NULL THEN NULL
                                  ELSE 'redacted:' || v.id END,
              ticket_ref   = CASE WHEN v.ticket_ref IS NULL THEN NULL
                                  ELSE 'redacted:' || v.id END,`,
    to: `          SET plate        = 'redacted:' || v.id,
              ticket_ref   = 'redacted:' || v.id,`,
  },
  {
    name: 'no_assisted_kind',
    why: "the platform refuses the lane's assisted-identity event",
    file: 'src/app.js',
    from: "  'assisted_identity',\n  'decision',",
    to: "  'decision',",
  },
];

const MIGRATION = '0007_vehicle_ticket_identity.sql';

const SCHEMA_BREAKS = [
  {
    name: 'drop_exactly_one',
    why: 'a vehicle row may carry both identities, or neither',
    from: `ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_exactly_one_identity
    CHECK ((plate IS NULL) <> (ticket_ref IS NULL));`,
    to: '-- the exactly-one constraint, removed by the fail-control',
  },
  {
    name: 'drop_ticket_unique',
    why: 'one ticket may identify two vehicles in one tenant',
    from: `ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_tenant_ticket_ref_key UNIQUE (tenant_id, ticket_ref);`,
    to: '-- the ticket unique constraint, removed by the fail-control',
  },
];

const SUITE = ['--test', 'test/ticket-identity.test.js', 'test/retention.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-r6-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir, extraEnv = {}) {
  return spawnSync(process.execPath, SUITE, {
    cwd: dir,
    env: { ...process.env, ...extraEnv },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  return `${line('pass')} passed, ${line('fail')} failed`;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const adminUrl = required('DATABASE_URL');
const appPassword = required('APP_DB_PASSWORD');

const host = new URL(adminUrl).host;
const scratchAdmin = new URL(adminUrl);
scratchAdmin.pathname = `/${SCRATCH}`;
const scratchApp = new URL(`postgres://openparking_app@${host}/${SCRATCH}`);
scratchApp.password = appPassword;
const maintenance = new URL(adminUrl);
maintenance.pathname = '/postgres';

const scratchEnv = {
  DATABASE_URL: scratchAdmin.toString(),
  APP_DATABASE_URL: scratchApp.toString(),
};

async function withAdmin(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * A scratch database built from `migrations/` with one statement edited out.
 *
 * The constraint is not dropped afterwards — it is never created. That is the
 * difference between a database that has the property and one that does not,
 * and it leaves the shared test database untouched either way.
 */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
    await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-r6-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  const path = join(partial, MIGRATION);
  const sql = readFileSync(path, 'utf8');
  if (!sql.includes(brk.from)) {
    rmSync(partial, { recursive: true, force: true });
    return { ok: false, partial: null };
  }
  writeFileSync(path, sql.replace(brk.from, brk.to));

  for (const [script, extra] of [
    ['scripts/migrate.js', { MIGRATIONS_DIR: partial }],
    ['scripts/ensure-app-role.js', {}],
  ]) {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, ...scratchEnv, ...extra },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(result.stdout, result.stderr);
      throw new Error(`${script} failed against the scratch database`);
    }
  }
  rmSync(partial, { recursive: true, force: true });
  return { ok: true };
}

let failures = 0;

const intactDir = stage();
try {
  console.log('== control A: the suite must PASS intact ==');
  const intact = run(intactDir);
  if (intact.status === 0) {
    console.log(`  control A OK — ${summarise(intact)}`);
  } else {
    console.error(`  CONTROL A FAILED — the suite does not pass even intact: ${summarise(intact)}`);
    console.error(intact.stdout);
    console.error(intact.stderr);
    failures += 1;
  }
} finally {
  rmSync(intactDir, { recursive: true, force: true });
}

console.log('\n== control B: each SOURCE break must make it FAIL ==');
for (const brk of SOURCE_BREAKS) {
  const dir = stage();
  try {
    const path = join(dir, brk.file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(brk.from)) {
      // A break whose anchor has moved applies nothing, and the run then
      // reports a passing suite as a failed control for the wrong reason.
      console.error(`  ${brk.name.padEnd(22)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    writeFileSync(path, source.replace(brk.from, brk.to));
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(22)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(
        `  ${brk.name.padEnd(22)} fails as required when ${brk.why} — ${summarise(broken)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== control C: each SCHEMA break must make it FAIL ==');
for (const brk of SCHEMA_BREAKS) {
  const dir = stage();
  try {
    const built = await buildScratch(dir, brk);
    if (!built.ok) {
      console.error(`  ${brk.name.padEnd(22)} *** ANCHOR NOT FOUND in ${MIGRATION} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir, scratchEnv);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(22)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(
        `  ${brk.name.padEnd(22)} fails as required when ${brk.why} — ${summarise(broken)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The scratch database is a database with a property removed. It is dropped
// rather than left lying about, so nothing can later be run against it by
// accident and report a pass it did not earn.
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property the ticket identity rests on.');
