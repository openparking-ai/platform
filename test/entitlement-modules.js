/**
 * The two entitlement modules, real, for the tests that consult them.
 *
 * `garage-pass` and `monthly-billing` are their own systems with their own
 * databases and their own tenants. A stand-in that printed COVERED would be
 * this platform's opinion of what the modules say, tested against itself --
 * so the suite builds a database for each from the module's own migrations
 * (a checkout at the pinned commit: GARAGE_PASS_SRC / MONTHLY_BILLING_SRC,
 * which CI clones), seeds through the module's own command line where one
 * exists and its store API where none does (an agreement has no create verb;
 * `seed-monthly-billing.py` is the pass-billing connector's harness's way),
 * and points the platform at them through the environment the two scripts
 * read their DSNs from.
 *
 * ENTITLEMENT_BIN_DIR names the directory holding the two console scripts;
 * unset, they are found on PATH (CI installs them there). ENTITLEMENT_PYTHON
 * (or RATE_ENGINE_PYTHON) is the interpreter with `monthly_billing` on it,
 * for the seed script.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const run = promisify(execFile);

const MODULES = {
  garage_pass: { srcEnv: 'GARAGE_PASS_SRC', dsnEnv: 'GARAGE_PASS_DSN', role: 'garage_pass_app', script: 'garage-pass' },
  monthly_billing: { srcEnv: 'MONTHLY_BILLING_SRC', dsnEnv: 'MONTHLY_BILLING_DSN', role: 'monthly_billing_app', script: 'monthly-billing' },
};
const PASSWORD = 'test-only-password';
//: One key, one meaning: "a module database is being built in this cluster".
const MODULE_BUILD_LOCK_KEY = 0x6d6f64756c6573; // 'modules', as a bigint

function python() {
  return process.env.ENTITLEMENT_PYTHON || process.env.RATE_ENGINE_PYTHON || 'python3';
}
function binDir() {
  if (process.env.ENTITLEMENT_BIN_DIR) return process.env.ENTITLEMENT_BIN_DIR;
  const py = process.env.ENTITLEMENT_PYTHON || process.env.RATE_ENGINE_PYTHON;
  return py && py.includes('/') ? dirname(py) : null;
}
function script(name) {
  const dir = binDir();
  return dir ? join(dir, name) : name;
}

async function withAdmin(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function startEntitlementModules() {
  const admin = process.env.DATABASE_URL;
  if (!admin) throw new Error('DATABASE_URL (the owner connection) is required to build the module databases');
  const maintenance = new URL(admin);
  maintenance.pathname = '/postgres';
  const suffix = randomUUID().slice(0, 8);
  const built = {};
  const dropAll = async () => {
    for (const spec of Object.values(MODULES)) delete process.env[spec.dsnEnv];
    await withAdmin(maintenance.toString(), async (c) => {
      for (const { name } of Object.values(built)) {
        await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
        await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`);
      }
    });
  };
  // ONE BUILD AT A TIME IN THE CLUSTER. Each module's migration ALTERs its
  // application ROLE, and a role is cluster-global: two test files building
  // module databases at once -- node --test runs files in parallel -- collide
  // on it ("tuple concurrently updated"). The lock is a cluster-wide advisory
  // lock on the maintenance database, held for the length of the build, the
  // same shape the modules' own harnesses use.
  const gate = new pg.Client({ connectionString: maintenance.toString() });
  await gate.connect();
  try {
    await gate.query('SELECT pg_advisory_lock($1)', [MODULE_BUILD_LOCK_KEY]);
    try {
      await build();
    } catch (err) {
      await dropAll();
      throw err;
    } finally {
      await gate.query('SELECT pg_advisory_unlock($1)', [MODULE_BUILD_LOCK_KEY]);
    }
  } finally {
    await gate.end();
  }
  async function build() {
  for (const [module, spec] of Object.entries(MODULES)) {
    // Stated, never guessed: a checkout of the module at its pinned commit.
    const src = process.env[spec.srcEnv];
    if (!src) throw new Error(`${spec.srcEnv} is required: a checkout of ${spec.script} at the commit in ${spec.script}.pin`);
    const name = `op_${module}_${suffix}`;
    await withAdmin(maintenance.toString(), (c) => c.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`));
    built[module] = { name };
    const ownerUrl = new URL(admin);
    ownerUrl.pathname = `/${name}`;
    await withAdmin(ownerUrl.toString(), async (c) => {
      await c.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      const files = (await readdir(join(src, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
      if (files.length === 0) throw new Error(`no migrations under ${src}; set ${spec.srcEnv}`);
      for (const f of files) await c.query(await readFile(join(src, 'migrations', f), 'utf8'));
      await c.query(`ALTER ROLE ${spec.role} LOGIN PASSWORD '${PASSWORD}'`);
    });
    const tenant = await withAdmin(ownerUrl.toString(), async (c) =>
      (await c.query(`INSERT INTO tenants (slug, name) VALUES ($1, $1) RETURNING id`, [`t-${suffix}`])).rows[0].id,
    );
    const host = ownerUrl.hostname;
    const port = ownerUrl.port || '5432';
    const dsn = `host=${host} port=${port} dbname=${name} user=${spec.role} password=${PASSWORD}`;
    process.env[spec.dsnEnv] = dsn;
    built[module] = { name, tenant, dsn, ownerUrl: ownerUrl.toString() };
  }
  }
  // The platform finds the two scripts the same way this harness does.
  if (!process.env.ENTITLEMENT_BIN_DIR && binDir()) process.env.ENTITLEMENT_BIN_DIR = binDir();
  const env = () => ({ ...process.env });

  return {
    ...built,
    /** garage-pass, through its command line, under the harness tenant. */
    async gp(...argv) {
      try {
        const { stdout } = await run(script('garage-pass'), [...argv, '--tenant', built.garage_pass.tenant], { env: env() });
        return stdout;
      } catch (err) {
        throw new Error(`garage-pass ${argv[0]} exited ${err.code}: ${err.stdout}\n${err.stderr}`);
      }
    },
    async gpGarage(id, timezone = 'America/New_York') {
      const file = join(process.env.TMPDIR || '/tmp', `gp-garage-${randomUUID()}.json`);
      await (await import('node:fs/promises')).writeFile(file, JSON.stringify({ id, timezone, transient_available: true }));
      return this.gp('create-garage', '--garage', file);
    },
    async gpPass(passId, garages, { validFrom = '2026-01-01', validTo = '2026-12-31', state = 'active' } = {}) {
      const file = join(process.env.TMPDIR || '/tmp', `gp-pass-${randomUUID()}.json`);
      await (await import('node:fs/promises')).writeFile(file, JSON.stringify({
        id: passId, garage_ids: garages, label: 'Fleet',
        holder: { email: 'holder@example.com', name: 'A Holder', phone: null },
        terms: { valid_from: validFrom, valid_to: validTo, windows: [], max_stay_minutes: null, visit_allowance: null, directions: ['entry', 'exit'], allowed_lanes: null },
        state,
      }));
      return this.gp('create-pass', '--garage', garages[0], '--pass', file, '--by', 'the harness', '--at', '2026-01-01T00:00:00+00:00');
    },
    async gpRegister(passId, garage, identity, effectiveDay = '2026-01-01') {
      return this.gp('register-vehicle', '--garage', garage, '--pass-id', passId, '--vehicle', identity, '--effective-day', effectiveDay);
    },
    /** monthly-billing: a garage, a payer and an agreement, through the store API. */
    async mbSeed({ garage, timezone = 'America/New_York', currency = 'USD', agreement, payer = 'payer-1', registrar = 'this_module', vehicles = [] }) {
      const { stdout } = await run(
        python(),
        [new URL('./seed-monthly-billing.py', import.meta.url).pathname, built.monthly_billing.tenant, garage, timezone, currency, agreement, payer, registrar, vehicles.length ? vehicles.join(',') : '-'],
        { env: env() },
      );
      return stdout;
    },
    async stop() {
      await dropAll();
    },
  };
}
