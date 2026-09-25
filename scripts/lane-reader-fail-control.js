#!/usr/bin/env node
/**
 * The control for a garage's Location and its lanes' readers (0021).
 *
 * Every property is broken below, one at a time, and the suite is REQUIRED to
 * go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 *
 *   location_on_the_platform   the Location is made without the
 *                              Stripe-Account header: on the deployment's
 *                              own account, not the garage's.
 *   reader_on_the_platform     ... and so is the reader.
 *   card_payments_ignored      a Location and a reader are made on an account
 *                              that cannot take a card.
 *   card_payments_stale        card_payments is taken from the last stored
 *                              read instead of read from Stripe now.
 *   lane_takes_two             a lane with a reader bound asks Stripe to
 *                              register another.
 *   unbinding_deletes          ending a binding deletes its row.
 *   history_hidden             the listing shows only current bindings.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0021.
 *
 *   two_readers_per_lane       the one-reader-per-lane index never created.
 *   two_lanes_per_reader       the one-lane-per-reader index never created.
 *   binding_rewritable         the guard trigger never created.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.LANE_READER_SCRATCH_DB || 'openparking_lane_reader_control';

const SOURCE_BREAKS = [
  {
    name: 'location_on_the_platform',
    why: 'the Location is made on the deployment\'s account',
    file: 'src/terminal.js',
    from: "      path: '/v1/terminal/locations',\n      account: account.account_id,",
    to: "      path: '/v1/terminal/locations',",
  },
  {
    name: 'reader_on_the_platform',
    why: 'the reader is made on the deployment\'s account',
    file: 'src/terminal.js',
    from: "      path: '/v1/terminal/readers',\n      account: account.account_id,",
    to: "      path: '/v1/terminal/readers',",
  },
  {
    name: 'card_payments_ignored',
    why: 'an account that cannot take a card gets a Location and a reader',
    file: 'src/terminal.js',
    from: "  if (account.card_payments !== 'active') {",
    to: "  if (account.card_payments !== 'active' && false) {",
  },
  {
    name: 'card_payments_stale',
    why: 'card_payments comes from the last stored read, not from Stripe now',
    file: 'src/terminal.js',
    from: '  const account = await refreshAccount(tenantId, garageId, { actor });',
    to: "  void actor; void refreshAccount;\n  const account = await (await import('./stripeAccount.js')).getAccount(tenantId, garageId);",
  },
  {
    name: 'lane_takes_two',
    why: 'a lane with a reader asks Stripe for another',
    file: 'src/terminal.js',
    from: '  if (held) {',
    to: '  if (held && false) {',
  },
  {
    name: 'unbinding_deletes',
    why: 'ending a binding deletes its row',
    file: 'src/terminal.js',
    from: `      \`UPDATE lane_readers SET unbound_at = now(), unbound_by = $3
        WHERE tenant_id = $1 AND lane_id = $2 AND unbound_at IS NULL
        RETURNING *\`,
      [tenantId, laneId, actor],`,
    to: `      \`DELETE FROM lane_readers WHERE tenant_id = $1 AND lane_id = $2 AND unbound_at IS NULL
        RETURNING *, now() AS unbound_at\`,
      [tenantId, laneId],`,
  },
  {
    name: 'history_hidden',
    why: 'the listing shows only current bindings',
    file: 'src/terminal.js',
    from: '`SELECT * FROM lane_readers WHERE tenant_id = $1 AND garage_id = $2\n',
    to: '`SELECT * FROM lane_readers WHERE tenant_id = $1 AND garage_id = $2 AND unbound_at IS NULL\n',
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'two_readers_per_lane',
    why: 'the one-reader-per-lane index never created',
    edits: [{
      file: '0021_lane_readers.sql',
      from: 'CREATE UNIQUE INDEX lane_readers_one_per_lane ON lane_readers (lane_id) WHERE unbound_at IS NULL;',
      to: '',
    }],
  },
  {
    name: 'two_lanes_per_reader',
    why: 'the one-lane-per-reader index never created',
    edits: [{
      file: '0021_lane_readers.sql',
      from: 'CREATE UNIQUE INDEX lane_readers_one_lane_per_reader ON lane_readers (reader_id) WHERE unbound_at IS NULL;',
      to: '',
    }],
  },
  {
    name: 'binding_rewritable',
    why: 'the guard trigger never created',
    edits: [{
      file: '0021_lane_readers.sql',
      from: `CREATE TRIGGER lane_readers_guard
  BEFORE INSERT OR UPDATE ON lane_readers
  FOR EACH ROW EXECUTE FUNCTION lane_readers_guard();`,
      to: '',
    }],
  },
];

const SUITE = ['--test', 'test/lane-reader.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-lane-reader-control-'));
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

/** A scratch database built from `migrations/` with one statement edited out. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
    await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-lane-reader-migrations-'));
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

function plant(dir, edit) {
  const path = join(dir, edit.file);
  const source = readFileSync(path, 'utf8');
  if (!source.includes(edit.from)) return false;
  writeFileSync(path, source.replace(edit.from, edit.to));
  return true;
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
    if (!plant(dir, brk)) {
      // A break whose anchor has moved applies nothing, and the run then
      // reports a passing suite as a failed control for the wrong reason.
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}`);
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
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND in ${built.where} ***`);
      failures += 1;
      continue;
    }
    if (brk.source && !plant(dir, brk.source)) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND in ${brk.source.file} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir, scratchEnv);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The scratch database is a database with a property removed. Dropped, so
// nothing can later be run against it by accident and report a pass it did
// not earn.
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log("\nall controls OK — the suite fails on every property a lane's reader rests on.");
