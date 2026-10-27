#!/usr/bin/env node
/**
 * The control for the unread identity (0036): a car whose plate nobody could
 * read is a stay too.
 *
 * Every property that makes that safe rather than merely possible is broken
 * below, one at a time, and `test/unread-identity.test.js` is REQUIRED to go
 * red -- with at least one of its tests still green, so a break that stops the
 * file running is not mistaken for one the tests caught. A pass is the failure.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 *
 *   unread_refused         the open stops reading `plate_unreadable`: the car
 *                          the loops saw go in is refused, and is in no record
 *   unread_shared_row      every unread car is one vehicle: the second car's
 *                          stay is folded into the first one's
 *   unread_beside_plate    `plate_unreadable` is taken beside a plate or a
 *                          ticket: a plate both read and not read
 *   unread_any_truthy      any truthy value is `true`: a string, a number
 *   unread_not_redacted    the purge leaves the unread key behind
 *   unread_called_plate    the candidate set names an unread stay `plate`
 *   unread_not_counted     the count of cars inside leaves unread cars out, so
 *                          the next car is priced on an emptier garage
 *   unread_left_off_feed   the open stays the lane is sent leave unread cars
 *                          out, so the lane's count of cars inside is short
 *   unread_ban_listed      an unread car marked a tailgater is put on the
 *                          banned list: a monthly with a dirty plate locked out
 *   no_open_command_dropped
 *                          the open's no_open_command is not stored
 *   unsure_plate_dropped   what was read below the confidence is not stored
 *   unsure_beside_plate    an unsure plate is taken beside a read plate
 *   unsure_not_purged      the purge leaves what was read of the plate behind
 *   event_id_any_shape     the lane routes take any event_id: an object, `redacted:...`
 *   event_id_uuid_only     a UUID only: another lane's own ids (`tp-0001`) refused
 *   close_event_id_unchecked
 *                          the close takes any event_id
 *   unread_tailgater_stored
 *                          an unread open that says tailgater is stored as one
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * statement of 0036 edited, so the property genuinely never existed there, and
 * run the suite against that.
 *
 *   no_unread_unique       `vehicles_tenant_unread_ref_key` never created
 *   unread_beside_plate_in_the_database
 *                          0036's constraint lets an unread key sit beside a
 *                          plate or a ticket
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
const SCRATCH = process.env.UNREAD_SCRATCH_DB || 'openparking_unread_identity_control';

const SOURCE_BREAKS = [
  {
    name: 'unread_refused',
    why: 'the open stops reading plate_unreadable',
    file: 'src/app.js',
    from: '  const plateUnreadable = unreadable ? (source?.plate_unreadable ?? null) : null;',
    to: '  const plateUnreadable = null;',
  },
  {
    name: 'unread_shared_row',
    why: 'every unread car is one vehicle',
    file: 'src/app.js',
    from: '          unreadRef: plateUnreadable ? String(openEventId) : null,',
    to: "          unreadRef: plateUnreadable ? 'unreadable' : null,",
  },
  {
    name: 'unread_beside_plate',
    why: 'plate_unreadable is taken beside a plate or a ticket',
    file: 'src/app.js',
    from: '    if (plate !== null || ticketRef !== null) {',
    to: '    if (false) {',
  },
  {
    name: 'unread_any_truthy',
    why: 'any truthy value is true',
    file: 'src/app.js',
    from: '    if (plateUnreadable !== true) {',
    to: '    if (!plateUnreadable) {',
  },
  {
    name: 'unread_not_redacted',
    why: 'the purge leaves the unread key behind',
    file: 'src/retention.js',
    from: `              unread_ref   = CASE WHEN v.unread_ref IS NULL THEN NULL
                                  ELSE 'redacted:' || v.id END,`,
    to: '              unread_ref   = v.unread_ref,',
  },
  {
    name: 'unread_called_plate',
    why: 'the candidate set names an unread stay plate',
    file: 'src/candidates.js',
    from: "    identity_kind: r.ticket_ref ? 'ticket' : r.plate ? 'plate' : 'unread',",
    to: "    identity_kind: r.ticket_ref ? 'ticket' : 'plate',",
  },
  {
    name: 'unread_not_counted',
    why: 'the count of cars inside leaves unread cars out',
    file: 'src/repository.js',
    from: '                AND (s.exit_at IS NULL OR s.exit_at > $3)) AS inside',
    to:
      '                AND (s.exit_at IS NULL OR s.exit_at > $3)' +
      ' AND s.vehicle_id NOT IN (SELECT id FROM vehicles WHERE unread_ref IS NOT NULL)) AS inside',
  },
  {
    name: 'unread_left_off_feed',
    why: 'the open stays the lane is sent leave unread cars out',
    file: 'src/repository.js',
    from: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL\n      ORDER BY s.change_seq`,',
    to: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL AND v.unread_ref IS NULL\n      ORDER BY s.change_seq`,',
  },
  {
    name: 'unread_ban_listed',
    why: 'an unread car marked a tailgater is ban-listed',
    file: 'src/bans.js',
    from: '  if (!vehicle?.plate) return false;\n',
    to: '',
  },
  {
    name: 'no_open_command_dropped',
    why: "the open's no_open_command is not stored",
    file: 'src/app.js',
    from: '          noOpenCommand,\n',
    to: '          noOpenCommand: false,\n',
  },
  {
    name: 'unsure_plate_dropped',
    why: 'what was read below the confidence is not stored',
    file: 'src/app.js',
    from: '          entryUnsurePlate: unsure.plate,\n          entryUnsurePlateConfidence: unsure.confidence,\n',
    to: '',
  },
  {
    name: 'unsure_beside_plate',
    why: 'an unsure plate is taken beside a read plate',
    file: 'src/app.js',
    from: '  if (!plateUnreadable) {\n    throw bad(',
    to: '  if (false) {\n    throw bad(',
  },
  {
    name: 'unsure_not_purged',
    why: 'the purge leaves what was read of the plate behind',
    file: 'src/retention.js',
    from: "WHERE tenant_id = $1 AND entry_unsure_plate IS NOT NULL AND vehicle_id = ANY($2::uuid[])",
    to: "WHERE false AND tenant_id = $1 AND vehicle_id = ANY($2::uuid[])",
  },
  {
    name: 'event_id_any_shape',
    why: 'the lane routes take any event_id',
    file: 'src/app.js',
    from: "  if (typeof value !== 'string' || !LANE_EVENT_ID_SHAPE.test(value)) {",
    to: '  if (false) {',
  },
  {
    name: 'event_id_uuid_only',
    why: "the routes take a UUID only, and another lane's ids are refused",
    file: 'src/app.js',
    from: 'const LANE_EVENT_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;',
    to: 'const LANE_EVENT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;',
  },
  {
    name: 'close_event_id_unchecked',
    why: "the close takes any event_id",
    file: 'src/app.js',
    from: '      laneEventId(closeEventId);\n',
    to: '',
  },
  {
    name: 'unread_tailgater_stored',
    why: 'an unread open that says tailgater is stored as one',
    file: 'src/app.js',
    from: '      const tailgater = tailgaterSaid && !plateUnreadable;',
    to: '      const tailgater = tailgaterSaid;',
  },
];

const ADDED_0036 = '0036_vehicle_unread_identity.sql';

const SCHEMA_BREAKS = [
  {
    name: 'no_unread_unique',
    why: 'one unread key may name two vehicles',
    edits: [
      {
        file: ADDED_0036,
        from: `ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_tenant_unread_ref_key UNIQUE (tenant_id, unread_ref);`,
        to: '-- the unread unique constraint, removed by the fail-control',
      },
    ],
  },
  {
    name: 'unread_beside_plate_in_the_database',
    why: 'the database lets an unread key sit beside a plate or a ticket',
    edits: [
      {
        file: ADDED_0036,
        from: '      num_nonnulls(plate, ticket_ref, unread_ref) = 1',
        to: '      num_nonnulls(plate, ticket_ref, unread_ref) >= 1',
      },
    ],
  },
];

const SUITE = ['--test', 'test/unread-identity.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-unread-control-'));
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

function counts(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return { pass: line('pass'), fail: line('fail') };
}

/**
 * A break is a control only when the suite RAN and went red: at least one test
 * failed AND at least one passed. All failed is a file that could not run --
 * an anchor that moved, a scratch database that did not build -- and it is
 * reported as not a control, never as "fails as required".
 */
function judge(name, why, result) {
  const { pass, fail } = counts(result);
  const label = name.padEnd(36);
  if (result.status === 0 || !fail) {
    console.error(`  ${label} *** PASSED WHEN ${why.toUpperCase()} — the suite is not measuring this ***`);
    return false;
  }
  if (!pass) {
    console.error(`  ${label} *** NOT A CONTROL — ${pass} passed, ${fail} failed: the break fails everything ***`);
    return false;
  }
  console.log(`  ${label} fails as required when ${why} — ${pass} passed, ${fail} failed`);
  return true;
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
const maintenance = new URL(required('SUPERUSER_URL'));
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

/** A scratch database built from `migrations/` with one statement of 0036 edited. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-unread-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  for (const edit of brk.edits) {
    const path = join(partial, edit.file);
    const sql = readFileSync(path, 'utf8');
    if (!sql.includes(edit.from)) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, where: edit.file };
    }
    writeFileSync(path, sql.replace(edit.from, edit.to));
  }

  for (const script of ['scripts/prepare-database.js', 'scripts/migrate.js']) {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, ...scratchEnv, MIGRATIONS_DIR: partial },
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
  const { pass, fail } = counts(intact);
  if (intact.status === 0 && pass > 0 && fail === 0) {
    console.log(`  control A OK — ${pass} passed`);
  } else {
    console.error(`  CONTROL A FAILED — the suite does not pass even intact: ${pass} passed, ${fail} failed`);
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
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    writeFileSync(path, source.replace(brk.from, brk.to));
    if (!judge(brk.name, brk.why, run(dir))) failures += 1;
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
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND in ${built.where} ***`);
      failures += 1;
      continue;
    }
    if (!judge(brk.name, brk.why, run(dir, scratchEnv))) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The scratch database is a database with a property removed: dropped, so
// nothing is later run against it by accident.
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust the unread-identity tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property the unread identity rests on.');
