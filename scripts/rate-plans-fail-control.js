#!/usr/bin/env node
/**
 * The control for the plan store.
 *
 * A garage's rate plans are held whole, validated by the engine before they
 * are stored, read back as the whole list the engine prices from, and a
 * closed stay keeps the version and the breakdown that priced it. Every
 * property that makes that TRUE rather than merely stated is broken below,
 * one at a time, and the suite is REQUIRED to go red. A pass is the failure.
 *
 * Two kinds of break, because the properties live in two places.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory;
 * no tracked file is edited. `node_modules` is symlinked rather than
 * reinstalled.
 *
 *   store_unvalidated      the route stops asking the engine and stores
 *                          whatever arrived. An unknown key, a gap -- every
 *                          refusal the round exists for -- is accepted.
 *   findings_ignored       the engine's findings are read and not acted on:
 *                          a plan that cannot price every stay it covers is
 *                          stored, and the gap is found at the barrier.
 *   document_shredded      the INSERT stores the document with `rules` cut
 *                          off: what reads back is not what went in.
 *   read_returns_one       the read answers with the latest plan only. The
 *                          engine is handed one version and can never
 *                          demonstrate it chose by entry time.
 *   currency_unchecked     the route stops comparing the plan's currency to
 *                          the garage's. (The trigger still refuses -- as a
 *                          500 with no name, which is the wrong answer to an
 *                          operator and what the test sees.)
 *   engine_absence_accepted
 *                          an engine that cannot be reached is treated as
 *                          having said yes. The silent-accept the store must
 *                          never do.
 *   not_recorded           the store writes the row and no event. Who stored
 *                          which version of what is then nowhere.
 *   breakdown_dropped      the close writes the plan_version and not the
 *                          breakdown: a fee with a version and no
 *                          explanation.
 *   retention_rewrites_plans
 *                          the purge reaches into the plan store, with the
 *                          grant widened so it can (a schema edit and a
 *                          source edit together). A rate card is not personal
 *                          data and the purge has no business in it.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with
 * one statement edited out of 0012, so the property genuinely never existed
 * there, and run the suite against that. A rule enforced only at a route is a
 * rule one direct INSERT goes around, and a migration is not a file a source
 * break can reach.
 *
 *   no_currency_trigger    the database stops refusing a plan in the wrong
 *                          currency; only the route does.
 *   no_pricing_pair        `sessions_plan_pricing_is_complete` never created:
 *                          a closed stay may carry a breakdown with no
 *                          version, or a version with no breakdown, or a
 *                          pricing while still open.
 *   keys_unchecked         the CHECKs tying `plan_version` and
 *                          `effective_from` to the document never created:
 *                          the index key and the contract can disagree.
 *   grant_widened          the application role can UPDATE and DELETE plans.
 *                          A commercial contract that priced stays becomes
 *                          editable in place.
 *
 * Needs the same environment as the suite, plus the engine: RATE_ENGINE_PYTHON
 * (an interpreter with the pinned `rate_engine` installed; `python3` by
 * default). The suite starts and stops the engine itself.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.RATE_PLANS_SCRATCH_DB || 'openparking_rate_plans_control';

const SOURCE_BREAKS = [
  {
    name: 'store_unvalidated',
    why: 'the route stores a plan the engine never saw',
    file: 'src/app.js',
    from: '        const validated = await ratePlans.validateWithEngine(document);',
    to: '        const validated = { schemaVersion: 1 };',
  },
  {
    name: 'findings_ignored',
    why: "the engine's findings are read and not acted on",
    file: 'src/ratePlans.js',
    from: '    if (body.findings.length > 0) {',
    to: '    if (false) {',
  },
  {
    name: 'document_shredded',
    why: 'what is stored is not the document that arrived',
    file: 'src/ratePlans.js',
    from: "       VALUES ($1, $2, $3::jsonb->>'plan_version', ($3::jsonb->>'effective_from')::timestamptz, $3::jsonb, $4)",
    to: "       VALUES ($1, $2, $3::jsonb->>'plan_version', ($3::jsonb->>'effective_from')::timestamptz, $3::jsonb - 'rules', $4)",
  },
  {
    name: 'read_returns_one',
    why: 'the read returns one plan where the garage has several',
    file: 'src/ratePlans.js',
    from: `      WHERE tenant_id = $1 AND garage_id = $2
      ORDER BY effective_from, plan_version\`,`,
    to: `      WHERE tenant_id = $1 AND garage_id = $2
      ORDER BY effective_from DESC, plan_version LIMIT 1\`,`,
  },
  {
    name: 'currency_unchecked',
    why: "the route stops comparing the plan's currency to the garage's",
    file: 'src/ratePlans.js',
    from: '  if (document.currency !== garage.currency) {',
    to: '  if (false) {',
  },
  {
    name: 'engine_absence_accepted',
    why: 'an engine that cannot be reached counts as a yes',
    file: 'src/ratePlans.js',
    from: `  } catch (err) {
    throw new RatePlanRefused(
      'rate_engine_unavailable',
      \`the rate engine at \${url} could not be reached`,
    to: `  } catch (err) {
    if (err) return { schemaVersion: 1 };
    throw new RatePlanRefused(
      'rate_engine_unavailable',
      \`the rate engine at \${url} could not be reached`,
  },
  {
    name: 'not_recorded',
    why: 'the store writes the row and no event',
    file: 'src/ratePlans.js',
    from: '  await repo.appendEvents(client, tenantId, [',
    to: '  if (false) await repo.appendEvents(client, tenantId, [',
  },
  {
    name: 'breakdown_dropped',
    why: 'the close keeps the version and drops the breakdown',
    file: 'src/repository.js',
    from: `     breakdown === null ? null : JSON.stringify(breakdown)],`,
    to: `     breakdown === null ? null : JSON.stringify(breakdown.slice(0, 1))],`,
  },
];

const GRANT_LINE = 'GRANT SELECT, INSERT ON rate_plans TO openparking_app;';
const GRANT_WIDENED = 'GRANT SELECT, INSERT, UPDATE, DELETE ON rate_plans TO openparking_app;';

const SCHEMA_BREAKS = [
  {
    name: 'no_currency_trigger',
    why: 'the database accepts a plan in the wrong currency',
    edits: [
      {
        file: '0012_rate_plans.sql',
        from: `CREATE TRIGGER rate_plans_currency_is_the_garages
  BEFORE INSERT ON rate_plans
  FOR EACH ROW EXECUTE FUNCTION rate_plans_currency_is_the_garages();`,
        to: '',
      },
    ],
  },
  {
    name: 'no_pricing_pair',
    why: 'a closed stay may carry a version without a breakdown, or the reverse',
    edits: [
      {
        file: '0012_rate_plans.sql',
        from: `ALTER TABLE sessions
  ADD CONSTRAINT sessions_plan_pricing_is_complete CHECK (
    (plan_version IS NULL AND breakdown IS NULL)
    OR
    (plan_version IS NOT NULL AND breakdown IS NOT NULL AND exit_at IS NOT NULL)
  );`,
        to: '',
      },
    ],
  },
  {
    name: 'keys_unchecked',
    why: 'the index keys may disagree with the document',
    edits: [
      {
        file: '0012_rate_plans.sql',
        from: `  CONSTRAINT rate_plans_version_is_the_documents CHECK (
    document->>'plan_version' = plan_version
  ),
  CONSTRAINT rate_plans_effective_from_is_the_documents CHECK (
    (document->>'effective_from')::timestamptz = effective_from
  ),`,
        to: '',
      },
    ],
  },
  {
    name: 'grant_widened',
    why: 'the application role can rewrite and delete plans',
    edits: [{ file: '0012_rate_plans.sql', from: GRANT_LINE, to: GRANT_WIDENED }],
  },
  {
    // A schema edit AND a source edit: with the grant as shipped the purge
    // cannot touch the table at all and would fail loudly, which is the
    // grant's doing, not the retention test's. Widened, the purge can, and
    // the test must be the thing that notices.
    name: 'retention_rewrites_plans',
    why: 'the purge reaches into the plan store',
    edits: [{ file: '0012_rate_plans.sql', from: GRANT_LINE, to: GRANT_WIDENED }],
    source: {
      file: 'src/retention.js',
      from: `    if (rows.length) {
      await client.query(
        \`UPDATE sessions SET entry_descriptor = NULL, exit_descriptor = NULL`,
      to: `    if (rows.length) {
      await client.query(\`UPDATE rate_plans SET document = document - 'rules' WHERE tenant_id = $1\`, [tenantId]);
      await client.query(
        \`UPDATE sessions SET entry_descriptor = NULL, exit_descriptor = NULL`,
    },
  },
];

const SUITE = ['--test', 'test/rate-plans.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-rate-plans-control-'));
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

  const partial = mkdtempSync(join(tmpdir(), 'openparking-rate-plans-migrations-'));
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
console.log('\nall controls OK — the suite fails on every property the plan store rests on.');
