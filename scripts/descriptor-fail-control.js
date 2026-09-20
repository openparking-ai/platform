#!/usr/bin/env node
/**
 * The control for the descriptors on a session (migrations 0009 and 0010).
 *
 * A session carries the appearance descriptor its entry read produced and the
 * one its exit read produced, and the exit's search compares the second
 * against the first of every open stay. Every property that makes holding
 * them safe rather than merely possible is broken below, one at a time, and
 * the suite is REQUIRED to go red. A pass is the failure.
 *
 * Every break is applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 *
 *   silently_dropped     the route goes back to ignoring the field. This is the
 *                        defect the round exists for: a lane sending a
 *                        descriptor gets 201 and nothing reports the loss. The
 *                        echo is what makes it visible, so the echo is what
 *                        this break must turn red.
 *   not_stored           the route reads and echoes nothing false, but the
 *                        INSERT writes null. The lane is satisfied and the exit
 *                        has nothing to search.
 *   not_echoed           stored, and stripped from the response. To the lane
 *                        that is a platform older than the column, and it
 *                        treats the open as not delivered -- correctly, which
 *                        is why the echo is a contract term.
 *   unbounded            any value is a descriptor: a number, an array, a blank,
 *                        a megabyte. It is stored per stay and compared against
 *                        every open stay at the exit.
 *   retention_keeps_it   the purge redacts the vehicle and leaves the descriptor
 *                        on its sessions. The reassuring direction: it still
 *                        reports rows redacted, and one specific car's
 *                        appearance outlives every other piece of its identity.
 *
 * THE EXIT END (0010). The close reaches this platform on one of two channels
 * that arrive in no specified order, and the shadow search snapshots inside
 * the close transaction -- so the descriptor has to be IN the close. Each
 * break below is the entry end's, at the other end of the stay.
 *
 *   close_silently_dropped
 *                        the close ignores the descriptor again.
 *   close_not_stored     the UPDATE writes null for the descriptor the route
 *                        accepted.
 *   close_not_echoed     stored, and stripped from the response.
 *   retention_keeps_exit the purge nulls the entry descriptor and leaves the
 *                        exit one -- which is the same car, read a second time.
 *
 * THE CANDIDATE SET (`src/candidates.js`): the open stays of one garage, keyed
 * on the session, with what identifies each and its descriptor -- what the
 * search is given. A set that is wrong in the reassuring direction is a
 * search over the wrong cars that still returns an answer.
 *
 *   closed_stays_in_set  a stay that has exited is still a candidate, so the
 *                        search can match an exit to a car that already left.
 *   other_garage_in_set  the set is the tenant's, not the garage's: a car at
 *                        this exit is matched against stays across town.
 *   set_drops_descriptor the set carries every identity and no descriptor, so
 *                        nothing is comparable and every exit reads as such.
 *   search_gets_the_plate
 *                        the projection sent to the identity service carries
 *                        the plate. Its contract says no plate is involved.
 *
 * SCHEMA break: `sessions_exit_descriptor_needs_exit` never created, so an open
 * stay may carry an exit descriptor -- a claim about an exit that has not
 * happened. A rule enforced only at a route is a rule one direct INSERT goes
 * around, so the constraint IS the property, and it is broken the way the
 * ticket-identity control breaks one: a scratch database built from a copy of
 * `migrations/` with the statement edited out.
 *
 *   drop_exit_needs_exit
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
const SCRATCH = process.env.DESCRIPTOR_SCRATCH_DB || 'openparking_descriptor_control';

const BREAKS = [
  {
    name: 'silently_dropped',
    why: 'the open ignores the descriptor again, as it did before 0009',
    file: 'src/app.js',
    from: '      const entryDescriptor = descriptorField(req.body?.descriptor);',
    to: '      const entryDescriptor = null;',
  },
  {
    name: 'not_stored',
    why: 'the INSERT writes null for the descriptor the route accepted',
    file: 'src/repository.js',
    from: `      [tenantId, garageId, vehicleId, laneId, entryAt, currency, openEventId, entryConfirmation,
       entryDescriptor],`,
    to: `      [tenantId, garageId, vehicleId, laneId, entryAt, currency, openEventId, entryConfirmation,
       null],`,
  },
  {
    name: 'not_echoed',
    why: 'the response strips the descriptor the row carries',
    file: 'src/app.js',
    from: `function presentSession(s) {
  return {
    ...s,`,
    to: `function presentSession(s) {
  return {
    ...s,
    entry_descriptor: undefined,`,
  },
  {
    name: 'unbounded',
    why: 'any value at all is accepted as a descriptor',
    file: 'src/app.js',
    from: "  if (typeof value !== 'string' || value.trim() === '' || value.length > DESCRIPTOR_MAX) {",
    to: '  if (false) {',
  },
  {
    name: 'retention_keeps_it',
    why: 'the purge redacts the vehicle and leaves its sessions\' descriptors',
    file: 'src/retention.js',
    from: '    if (rows.length) {',
    to: '    if (false) {',
  },
  {
    name: 'close_silently_dropped',
    why: 'the close ignores the descriptor again',
    file: 'src/app.js',
    from: '      const exitDescriptor = descriptorField(req.body?.descriptor);',
    to: '      const exitDescriptor = null;',
  },
  {
    name: 'close_not_stored',
    why: 'the UPDATE writes null for the descriptor the close accepted',
    file: 'src/repository.js',
    from: `    [tenantId, sessionId, exitAt, laneId, rateId, hourlyMinor, feeMinor, closeEventId,
     exitConfirmation, exitDescriptor, planVersion,`,
    to: `    [tenantId, sessionId, exitAt, laneId, rateId, hourlyMinor, feeMinor, closeEventId,
     exitConfirmation, null, planVersion,`,
  },
  {
    name: 'close_not_echoed',
    why: 'the close response strips the descriptor the row carries',
    file: 'src/app.js',
    from: `function presentSession(s) {
  return {
    ...s,`,
    to: `function presentSession(s) {
  return {
    ...s,
    exit_descriptor: undefined,`,
  },
  {
    name: 'retention_keeps_exit',
    why: 'the purge nulls the entry descriptor and leaves the exit one',
    file: 'src/retention.js',
    from: '        `UPDATE sessions SET entry_descriptor = NULL, exit_descriptor = NULL',
    to: '        `UPDATE sessions SET entry_descriptor = NULL',
  },
  {
    name: 'closed_stays_in_set',
    why: 'a stay that has exited is still a candidate',
    file: 'src/candidates.js',
    from: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL',
    to: '      WHERE s.tenant_id = $1 AND s.garage_id = $2',
  },
  {
    name: 'other_garage_in_set',
    why: 'the candidate set is the tenant\'s, not the garage\'s',
    file: 'src/candidates.js',
    from: '      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.exit_at IS NULL',
    to: '      WHERE s.tenant_id = $1 AND ($2::uuid IS NOT NULL) AND s.exit_at IS NULL',
  },
  {
    name: 'set_drops_descriptor',
    why: 'the candidate set carries no descriptor',
    file: 'src/candidates.js',
    from: '    `SELECT s.id, s.entry_at, s.entry_confirmation, s.entry_descriptor AS descriptor,',
    to: '    `SELECT s.id, s.entry_at, s.entry_confirmation, NULL::text AS descriptor,',
  },
  {
    name: 'search_gets_the_plate',
    why: 'the projection sent to the identity service carries the plate',
    file: 'src/candidates.js',
    from: '    .map((c) => ({ id: c.id, descriptor: c.descriptor }));',
    to: '    .map((c) => ({ id: c.id, descriptor: c.descriptor, plate: c.plate }));',
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'drop_exit_needs_exit',
    why: 'an open stay may carry an exit descriptor',
    edits: [
      {
        file: '0010_session_exit_descriptor.sql',
        from: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_exit_descriptor_needs_exit CHECK (
    exit_at IS NOT NULL OR exit_descriptor IS NULL
  );`,
        to: '-- the exit-needs-exit constraint, removed by the fail-control',
      },
    ],
  },
];

const SUITE = [
  '--test',
  'test/entry-descriptor.test.js',
  'test/exit-descriptor.test.js',
  'test/candidate-set.test.js',
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-e1-descriptor-control-'));
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
 * A scratch database built from `migrations/` with one statement edited out --
 * the ticket-identity control's mechanism, for the same reason: the
 * constraint is never created rather than dropped afterwards, and the shared
 * test database is untouched either way.
 */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
    await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-descriptor-migrations-'));
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

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  return `${line('pass')} passed, ${line('fail')} failed`;
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

console.log('\n== control B: each break must make it FAIL ==');
for (const brk of BREAKS) {
  const dir = stage();
  try {
    const path = join(dir, brk.file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(brk.from)) {
      // A break whose anchor has moved applies nothing, and the run then
      // reports a passing suite as a failed control for the wrong reason.
      console.error(`  ${brk.name.padEnd(20)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    writeFileSync(path, source.replace(brk.from, brk.to));
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(20)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(20)} fails as required when ${brk.why} — ${summarise(broken)}`);
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
      console.error(`  ${brk.name.padEnd(20)} *** ANCHOR NOT FOUND in ${built.where} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir, scratchEnv);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(20)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(20)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A database with a property removed is dropped rather than left lying about.
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log(
  '\nall controls OK — the suite fails on every property the two descriptors and the candidate set rest on.',
);
