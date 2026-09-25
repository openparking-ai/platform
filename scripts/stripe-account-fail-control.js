#!/usr/bin/env node
/**
 * The control for a garage's own Stripe account (0020).
 *
 * Every property is broken below, one at a time, and the suite is REQUIRED to
 * go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 *
 *   losses_on_the_platform   the account is created with the deployment
 *                            responsible for its losses.
 *   fees_on_the_platform     ... with the deployment collecting its fees.
 *   dashboard_given          ... with a Stripe dashboard: the full signup the
 *                            garage must never be sent through.
 *   country_unchecked        a create with no country goes to Stripe.
 *   validate_after_reserve   the country is checked only after the
 *                            reservation is written: a bad country leaves
 *                            a reservation behind (the gate's F1).
 *   refusal_not_released     a create Stripe definitely refused is not
 *                            recorded: the next create re-asks with the
 *                            dead key, and after a day is locked out.
 *   unknown_released         a 5xx -- an outcome Stripe may have acted on --
 *                            is treated as a refusal and re-armed.
 *   idempotency_conflict_released
 *                            an idempotency conflict (the key already ran)
 *                            is treated as a refusal and re-armed.
 *   stale_locks_out          an unknown outcome past the key window is
 *                            refused by name instead of asking Stripe: the
 *                            garage is locked out for good (the re-gate's F2).
 *   lookup_ignores_garage    the lookup matches the tenant only, not the
 *                            garage its metadata names.
 *   lookup_first_page_only   the lookup stops at the first page.
 *   ambiguous_not_refused    two accounts naming one garage are not refused.
 *   absent_reuses_stale_key  Stripe holds none, and the create re-asks with
 *                            the key whose window has passed.
 *   lookup_inside_window     Stripe is searched even inside the key window,
 *                            where the key itself answers.
 *   no_card_payments         ... without asking for card_payments.
 *   no_idempotency_key       the create is sent without the reservation's
 *                            key: a retry can make a second account.
 *   asks_again               a garage that has an account asks Stripe again.
 *   stale_key_reused         a reservation older than Stripe keeps its key is
 *                            asked again instead of refused.
 *   connect_assumed          the routes act with no Connect configured.
 *   urls_not_sent            the onboarding link is asked for without the
 *                            deployment's return URL.
 *   read_not_stored          a read answers Stripe's facts and keeps none.
 *   form_arrays_unindexed    the form encoder writes an array without its
 *                            index.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0020, so the property genuinely never existed.
 *
 *   account_not_frozen       the guard trigger never created: a recorded
 *                            account can be swapped for another.
 *   two_per_garage           the one-per-garage constraint never created.
 *   fact_without_read_time   a fact can be stored with no read time.
 *   rearm_unguarded          the trigger lets any reservation's key be
 *                            rewritten, refused or not.
 *
 * Needs the same environment as the suite, plus the engine
 * (RATE_ENGINE_PYTHON) for the activation test beside it.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.STRIPE_ACCOUNT_SCRATCH_DB || 'openparking_stripe_account_control';

const SOURCE_BREAKS = [
  {
    name: 'losses_on_the_platform',
    why: 'the deployment is made responsible for the account\'s losses',
    file: 'src/stripeAccount.js',
    from: "      losses: { payments: 'stripe' },",
    to: "      losses: { payments: 'application' },",
  },
  {
    name: 'fees_on_the_platform',
    why: 'the deployment collects the account\'s fees',
    file: 'src/stripeAccount.js',
    from: "      fees: { payer: 'account' },",
    to: "      fees: { payer: 'application' },",
  },
  {
    name: 'dashboard_given',
    why: 'the account is given a Stripe dashboard',
    file: 'src/stripeAccount.js',
    from: "      stripe_dashboard: { type: 'none' },",
    to: "      stripe_dashboard: { type: 'full' },",
  },
  {
    name: 'validate_after_reserve',
    why: 'the country is checked after the reservation is written',
    edits: [
      { file: 'src/stripeAccount.js', from: '    const country = countryField(rawCountry);', to: '    const country = rawCountry;' },
      { file: 'src/stripeAccount.js', from: '  const { country } = reserved;', to: '  const country = countryField(reserved.country);' },
    ],
  },
  {
    name: 'refusal_not_released',
    why: 'a definite Stripe refusal is not recorded',
    file: 'src/stripeAccount.js',
    from: '    if (definiteRefusal(err)) {',
    to: '    if (false) {',
  },
  {
    name: 'unknown_released',
    why: 'a 5xx is treated as a refusal',
    file: 'src/stripeAccount.js',
    from: '    && err.status >= 400 && err.status < 500',
    to: '    && err.status >= 400',
  },
  {
    name: 'idempotency_conflict_released',
    why: 'an idempotency conflict is treated as a refusal',
    file: 'src/stripeAccount.js',
    from: "    && err.status !== 409\n    && err.type !== 'idempotency_error';",
    to: '    && err.status !== 409;',
  },
  {
    name: 'stale_locks_out',
    why: 'an unknown outcome past the window is refused instead of asking Stripe',
    file: 'src/stripeAccount.js',
    from: '    const found = await accountsNamingGarage(tenantId, garageId, config);',
    to: "    const found = []; throw new ConnectRefusal(409, 'stripe_account_create_unresolved', 'look in Stripe');",
  },
  {
    name: 'lookup_ignores_garage',
    why: 'the lookup matches the tenant only',
    file: 'src/stripeAccount.js',
    from: '      if (a?.metadata?.openparking_garage_id === garageId && a?.metadata?.openparking_tenant_id === tenantId) {',
    to: '      if (a?.metadata?.openparking_tenant_id === tenantId) {',
  },
  {
    name: 'lookup_first_page_only',
    why: 'the lookup reads one page',
    file: 'src/stripeAccount.js',
    from: '    if (!list.has_more) return found;',
    to: '    return found;',
  },
  {
    name: 'ambiguous_not_refused',
    why: 'two accounts naming one garage are not refused',
    file: 'src/stripeAccount.js',
    from: '    if (found.length > 1) {',
    to: '    if (found.length > 1 && false) {',
  },
  {
    name: 'absent_reuses_stale_key',
    why: 'with no account at Stripe the create re-asks with the stale key',
    file: 'src/stripeAccount.js',
    from: '    reserved.row = fresh;',
    to: '    void fresh;',
  },
  {
    name: 'lookup_inside_window',
    why: 'Stripe is searched inside the key window',
    file: 'src/stripeAccount.js',
    from: '  if (ageHours > IDEMPOTENCY_WINDOW_HOURS) {',
    to: '  if (ageHours > IDEMPOTENCY_WINDOW_HOURS || true) {',
  },
  {
    name: 'country_unchecked',
    why: 'a create with no country is sent to Stripe',
    file: 'src/stripeAccount.js',
    from: '    const country = countryField(rawCountry);',
    to: '    const country = rawCountry;',
  },
  {
    name: 'no_card_payments',
    why: 'card_payments is not asked for',
    file: 'src/stripeAccount.js',
    from: '    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },',
    to: '    capabilities: { transfers: { requested: true } },',
  },
  {
    name: 'no_idempotency_key',
    why: 'the create goes without the reservation\'s key',
    file: 'src/stripeAccount.js',
    from: '      idempotencyKey: reserved.row.create_idempotency_key,',
    to: '',
  },
  {
    name: 'asks_again',
    why: 'a garage with an account asks Stripe again',
    file: 'src/stripeAccount.js',
    from: '  if (reserved.row.account_id) return { account: reserved.row, created: false };',
    to: '',
  },
  {
    name: 'stale_key_reused',
    why: 'a reservation past the key window is re-asked with its stale key, Stripe never searched',
    file: 'src/stripeAccount.js',
    from: '  if (ageHours > IDEMPOTENCY_WINDOW_HOURS) {',
    to: '  if (ageHours > IDEMPOTENCY_WINDOW_HOURS && false) {',
  },
  {
    name: 'connect_assumed',
    why: 'the routes act with no Connect configured',
    file: 'src/stripeAccount.js',
    from: '  if (!config.configured) throw new ConnectRefusal(',
    to: '  if (!config.key) throw new ConnectRefusal(',
  },
  {
    name: 'urls_not_sent',
    why: 'the onboarding link goes without the return URL',
    file: 'src/stripeAccount.js',
    from: '        return_url: config.returnUrl,',
    to: '',
  },
  {
    name: 'read_not_stored',
    why: 'a read keeps nothing of what Stripe said',
    file: 'src/stripeAccount.js',
    from: '      [tenantId, garageId, facts.card_payments, facts.charges_enabled, facts.details_submitted],',
    to: "      [tenantId, garageId, 'inactive', false, false],",
  },
  {
    name: 'form_arrays_unindexed',
    why: 'the form encoder drops an array\'s index',
    file: 'src/form.js',
    from: '      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));',
    to: '      value.forEach((item) => walk(`${prefix}[]`, item));',
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'rearm_unguarded',
    why: 'the trigger lets any reservation be rewritten',
    edits: [
      {
        file: '0020_garage_stripe_accounts.sql',
        from: '     AND NOT (OLD.account_id IS NULL AND OLD.create_refused_at IS NOT NULL AND NEW.create_refused_at IS NULL) THEN',
        to: '     AND false THEN',
      },
    ],
  },
  {
    name: 'account_not_frozen',
    why: 'the guard trigger never created',
    edits: [
      {
        file: '0020_garage_stripe_accounts.sql',
        from: `CREATE TRIGGER garage_stripe_accounts_guard
  BEFORE INSERT OR UPDATE ON garage_stripe_accounts
  FOR EACH ROW EXECUTE FUNCTION garage_stripe_accounts_guard();`,
        to: '',
      },
    ],
  },
  {
    name: 'two_per_garage',
    why: 'the one-per-garage constraint never created',
    edits: [
      {
        file: '0020_garage_stripe_accounts.sql',
        from: '  CONSTRAINT garage_stripe_accounts_one_per_garage UNIQUE (garage_id),\n',
        to: '',
      },
    ],
  },
  {
    name: 'fact_without_read_time',
    why: 'a fact can be stored without its read time',
    edits: [
      {
        file: '0020_garage_stripe_accounts.sql',
        from: `  CONSTRAINT garage_stripe_accounts_card_payments_read CHECK (
    (card_payments IS NULL) = (card_payments_read_at IS NULL)
  ),
`,
        to: '',
      },
    ],
  },
];

const SUITE = ['--test', 'test/stripe-account.test.js', 'test/form.test.js', 'test/activation.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-stripe-account-control-'));
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

  const partial = mkdtempSync(join(tmpdir(), 'openparking-stripe-account-migrations-'));
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

function plant(dir, brk) {
  // A break is one edit, or several (`edits`) that together remove one property.
  for (const edit of brk.edits ?? [brk]) {
    const path = join(dir, edit.file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(edit.from)) return false;
    writeFileSync(path, source.replace(edit.from, edit.to));
  }
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
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND in ${brk.file ?? brk.edits.map((e) => e.file).join(', ')} ***`);
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
console.log("\nall controls OK — the suite fails on every property a garage's own Stripe account rests on.");
