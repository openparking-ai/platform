#!/usr/bin/env node
/**
 * The control for the activation gate.
 *
 * A garage is not usable until its rate setup is complete and its transient
 * mode is stated, the refusal at the lane is named and recorded, and
 * activation carries no payment-processor condition. Every property is
 * broken below, one at a time, and the suite is REQUIRED to go red. A pass
 * is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 *
 *   gate_off_at_the_lane       the lane routes treat every garage as active.
 *                              An unready garage opens stays again.
 *   refusal_not_recorded       the inactive refusal answers 409 and writes
 *                              nothing. The lane drops it; nobody knows.
 *   no_plan_counts_as_setup    the route's readout calls the rate setup
 *                              complete with no plan stored.
 *   stored_counts_as_in_force  a plan stored for next month satisfies the
 *                              route: set up, but nothing prices today.
 *   unstated_counts_as_stated  an unstated transient mode satisfies the
 *                              route -- the guessed default the three-state
 *                              field exists to forbid.
 *   null_is_a_statement        the request boundary accepts
 *                              `transient_available: null` as a value.
 *   processor_surface          the processor's name appears in
 *                              activation's own source. A garage's Stripe
 *                              account exists elsewhere (0020); activation
 *                              must never be conditioned on it.
 *   rules_say_active           /lane/rules tells every lane its garage is
 *                              active.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0014, so the property genuinely never existed.
 *
 *   no_trigger                 the gate trigger never created: a direct
 *                              UPDATE activates anything, a garage can be
 *                              created active, a mode can be un-stated,
 *                              activation can be undone.
 *   trigger_ignores_in_force   the trigger counts stored plans, not plans in
 *                              force.
 *
 * Needs the same environment as the suite, plus the engine
 * (RATE_ENGINE_PYTHON). The suite starts and stops the engine itself.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.ACTIVATION_SCRATCH_DB || 'openparking_activation_control';

const SOURCE_BREAKS = [
  {
    name: 'gate_off_at_the_lane',
    why: 'the lane routes treat every garage as active',
    file: 'src/app.js',
    from: '  if (garage.activated_at !== null) return garage;',
    to: '  if (true) return garage;',
  },
  {
    name: 'refusal_not_recorded',
    why: 'the inactive refusal writes nothing before answering',
    file: 'src/app.js',
    from: '  await withTenant(tenantId, (client) =>\n    activation.recordInactiveRefusal(',
    to: '  if (false) await withTenant(tenantId, (client) =>\n    activation.recordInactiveRefusal(',
  },
  {
    name: 'no_plan_counts_as_setup',
    why: 'the readout calls the rate setup complete with no plan',
    file: 'src/activation.js',
    from: "      condition: 'rate_setup_complete',\n      met: plans.in_force > 0,",
    to: "      condition: 'rate_setup_complete',\n      met: true,",
  },
  {
    name: 'stored_counts_as_in_force',
    why: 'a plan not yet in force satisfies the readout',
    file: 'src/activation.js',
    from: "      condition: 'rate_setup_complete',\n      met: plans.in_force > 0,",
    to: "      condition: 'rate_setup_complete',\n      met: plans.stored > 0,",
  },
  {
    name: 'unstated_counts_as_stated',
    why: 'an unstated transient mode satisfies the readout',
    file: 'src/activation.js',
    from: "      condition: 'transient_mode_stated',\n      met: garage.transient_available !== null && garage.transient_available !== undefined,",
    to: "      condition: 'transient_mode_stated',\n      met: true,",
  },
  {
    name: 'null_is_a_statement',
    why: 'the request boundary accepts null as a transient mode',
    file: 'src/activation.js',
    from: '  if (raw !== true && raw !== false) {',
    to: '  if (raw === null) return null;\n  if (raw !== true && raw !== false) {',
  },
  {
    name: 'processor_surface',
    why: "the processor's name appears in activation's source",
    file: 'src/activation.js',
    from: "export const GARAGE_ACTIVATED_EVENT_KIND = 'garage_activated';",
    to: "export const GARAGE_ACTIVATED_EVENT_KIND = 'garage_activated';\nexport const STRIPE_ACCOUNT_FIELD = 'stripe_account_id';",
  },
  {
    name: 'rules_say_active',
    why: '/lane/rules tells every lane its garage is active',
    file: 'src/app.js',
    from: '        active: payload.garage.activated_at !== null,',
    to: '        active: true,',
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'no_trigger',
    why: 'the gate trigger never created',
    edits: [
      {
        file: '0014_activation_gate.sql',
        from: `CREATE TRIGGER garages_activation_gate
  BEFORE INSERT OR UPDATE OF transient_available, activated_at ON garages
  FOR EACH ROW EXECUTE FUNCTION garages_activation_gate();`,
        to: '',
      },
    ],
  },
  {
    name: 'trigger_ignores_in_force',
    why: 'the trigger counts stored plans, not plans in force',
    edits: [
      {
        file: '0014_activation_gate.sql',
        from: '    SELECT count(*), count(*) FILTER (WHERE effective_from <= now())',
        to: '    SELECT count(*), count(*)',
      },
    ],
  },
];

const SUITE = ['--test', 'test/activation.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-activation-control-'));
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

  const partial = mkdtempSync(join(tmpdir(), 'openparking-activation-migrations-'));
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
console.log('\nall controls OK — the suite fails on every property the activation gate rests on.');
