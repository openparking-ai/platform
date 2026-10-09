#!/usr/bin/env node
/**
 * The control for a garage's taxes (migration 0022).
 *
 * A tax set is judged by the ENGINE and by nothing here, before anything
 * reads it; stored as the engine read it; refused as STORAGE, by that name,
 * when this platform cannot hold what the engine accepted; stored only if the
 * garage's whole list, read back, still loads; never inferred ("none" is a
 * set that SAID zero rules); never two at one instant; and a garage cannot
 * activate while its taxes are unstated. Every property is broken below, one
 * at a time, and the suite is REQUIRED to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 *
 *   one_character              the `integer` bound becomes 2^31 -- ONE
 *                              character. A number the column cannot hold
 *                              reaches the INSERT.
 *   engine_not_asked           the route stores a set nobody judged.
 *   engine_refusal_ignored     the engine's 400 is not treated as a refusal.
 *   outage_counted_as_yes      an engine that cannot be reached answers "valid".
 *   outage_not_named           no engine is an unnamed 500, not
 *                              503 rate_engine_unavailable.
 *   request_spelling_stored    the instant is stored as the request spelled it,
 *                              not as the engine read it.
 *   nul_not_refused            a NUL byte reaches PostgreSQL text.
 *   surrogate_not_refused      a lone surrogate is not refused by name.
 *   read_back_to_millisecond   a stored instant is read back to the
 *                              millisecond: not the instant the table holds.
 *   read_back_not_checked      an instant that reads back as another is stored.
 *   load_not_proved            the garage's whole list is not loaded before
 *                              commit: a set that never loads is stored.
 *   validity_rule_restated     a rule of the engine's (a blank test) is copied
 *                              back into the store.
 *   table_rule_restated        the same, as a CHECK in the table (the file the
 *                              scan reads; the database is not rebuilt).
 *   instant_not_named          two sets at one instant: the held set's id is
 *                              dropped from the refusal.
 *   read_order_by_id           the read orders rules by id, not by the
 *                              garage's stated sequence.
 *   statement_not_recorded     a stated set writes no event.
 *   unstated_taxes_pass        the readout calls UNSTATED taxes stated.
 *   stated_counts_as_in_force  a tax set stated for next month satisfies the
 *                              readout.
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with a
 * statement edited out of 0022, so the property genuinely never existed.
 *
 *   no_count_trigger           a set is not held to its `rule_count`: a
 *                              half-written set commits, a "none" can be given
 *                              a rule later.
 *   no_instant_unique          two sets at one instant: nothing refuses the
 *                              pair by name, both named.
 *   no_garage_trigger          a set can be written against another tenant's
 *                              garage (the foreign key runs as the owner).
 *   gate_ignores_taxes         the trigger activates a garage whose taxes are
 *                              unstated: a direct UPDATE goes around the
 *                              route.
 *   gate_counts_stated         the trigger counts stated sets, not sets in
 *                              force.
 *   update_granted             the application role may UPDATE a set: a
 *                              statement can be edited after the fact.
 *
 * Needs the same environment as the suite, plus the engine
 * (RATE_ENGINE_PYTHON) for the activation half.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.TAXES_SCRATCH_DB || 'openparking_taxes_control';

const SOURCE_BREAKS = [
  {
    name: 'one_character',
    why: 'the integer bound admits 2^31 (one character changed)',
    file: 'src/taxes.js',
    from: 'const INTEGER_MAX = 2_147_483_647;',
    to: 'const INTEGER_MAX = 2_147_483_648;',
  },
  {
    name: 'engine_not_asked',
    why: 'the route stores a set nobody judged',
    file: 'src/taxes.js',
    from: '  const answer = await askEngine([raw ?? null], engine);',
    to: '  const answer = { loaded: [{ effective_from: raw?.effective_from }] };',
  },
  {
    name: 'engine_refusal_ignored',
    why: "the engine's refusal is not a refusal",
    file: 'src/taxes.js',
    from: "  if (answer.refused !== undefined) {\n    throw new TaxSetRefused('tax_set_invalid'",
    to: "  if (false) {\n    throw new TaxSetRefused('tax_set_invalid'",
  },
  {
    name: 'outage_counted_as_yes',
    why: 'an engine that cannot be reached answers valid',
    file: 'src/taxes.js',
    from: '    throw new EngineUnavailable(`the rate engine at ${url} could not be reached (${err?.cause?.code ?? err?.name ?? err})`);',
    to: '    return { loaded: taxSets.map((s) => ({ effective_from: s?.effective_from, rule_count: s?.rules?.length })) };',
  },
  {
    name: 'outage_not_named',
    why: 'no engine is an unnamed 500',
    file: 'src/app.js',
    from: '  if (err instanceof ratePlans.EngineUnavailable) {',
    to: '  if (false) {',
  },
  {
    name: 'request_spelling_stored',
    why: 'the instant is stored as spelled, not as the engine read it',
    file: 'src/taxes.js',
    from: '  return { given: raw, effectiveFrom: answer.loaded[0].effective_from, rules: raw.rules };',
    to: '  return { given: raw, effectiveFrom: raw.effective_from, rules: raw.rules };',
  },
  {
    name: 'nul_not_refused',
    why: 'a NUL byte reaches PostgreSQL text',
    file: 'src/taxes.js',
    from: "      if (rule[key].includes('\\u0000')) {",
    to: '      if (false) {',
  },
  {
    name: 'surrogate_not_refused',
    why: 'a lone surrogate is not refused by name',
    file: 'src/taxes.js',
    from: '      if (!rule[key].isWellFormed()) {',
    to: '      if (false) {',
  },
  {
    name: 'read_back_to_millisecond',
    why: 'a stored instant is read back to the millisecond',
    file: 'src/taxes.js',
    from: `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`,
    to: `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`,
  },
  {
    name: 'read_back_not_checked',
    why: 'an instant that reads back as another is stored',
    file: 'src/taxes.js',
    from: '  if (!faithful.instant) {',
    to: '  if (false) {',
  },
  {
    name: 'load_not_proved',
    why: "the garage's whole list is not loaded before commit",
    file: 'src/taxes.js',
    from: '  if (load.refused !== undefined) {',
    to: '  if (false) {',
  },
  {
    name: 'validity_rule_restated',
    why: 'the store copies a rule of the engine back (a blank test)',
    file: 'src/taxes.js',
    from: '  const answer = await askEngine([raw ?? null], engine);',
    to:
      "  if (raw?.rules?.some?.((r) => String(r.label).trim() === '')) throw new TaxSetRefused('tax_set_invalid', 'blank');\n" +
      '  const answer = await askEngine([raw ?? null], engine);',
  },
  {
    name: 'table_rule_restated',
    why: 'the table copies a rule of the engine back (a CHECK)',
    file: 'migrations/0022_garage_tax_sets.sql',
    from: '    FOREIGN KEY (tax_set_id, tenant_id) REFERENCES garage_tax_sets (id, tenant_id) ON DELETE CASCADE\n);',
    to:
      '    FOREIGN KEY (tax_set_id, tenant_id) REFERENCES garage_tax_sets (id, tenant_id) ON DELETE CASCADE,\n' +
      "  CONSTRAINT garage_tax_rules_label_not_blank CHECK (btrim(label) <> '')\n);",
  },
  {
    name: 'instant_not_named',
    why: 'the refusal no longer names the held set',
    file: 'src/taxes.js',
    from: "        `two tax sets would be in force from one instant: set ${held?.id ?? '(stated concurrently)'}, stated ` +",
    to: "        `two tax sets would be in force from one instant: a set, stated ` +",
  },
  {
    name: 'read_order_by_id',
    why: "the read orders rules by id, not the garage's sequence",
    file: 'src/taxes.js',
    from: '      ORDER BY sequence`,',
    to: '      ORDER BY rule_id`,',
  },
  {
    name: 'statement_not_recorded',
    why: 'a stated set writes no event',
    file: 'src/taxes.js',
    from: "  // `detail`, the convention every operator act here follows.\n  await repo.appendEvents(",
    to: "  // `detail`, the convention every operator act here follows.\n  if (false) await repo.appendEvents(",
  },
  {
    name: 'unstated_taxes_pass',
    why: 'unstated taxes satisfy the readout',
    file: 'src/activation.js',
    from: "      condition: 'taxes_stated',\n      met: taxes.in_force > 0,",
    to: "      condition: 'taxes_stated',\n      met: true,",
  },
  {
    name: 'stated_counts_as_in_force',
    why: 'a tax set not yet in force satisfies the readout',
    file: 'src/activation.js',
    from: "      condition: 'taxes_stated',\n      met: taxes.in_force > 0,",
    to: "      condition: 'taxes_stated',\n      met: taxes.stated > 0,",
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'no_count_trigger',
    why: 'a set is not held to its rule_count',
    edits: [
      {
        file: '0022_garage_tax_sets.sql',
        from: `CREATE CONSTRAINT TRIGGER garage_tax_sets_hold_their_stated_rules
  AFTER INSERT ON garage_tax_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION garage_tax_sets_hold_their_stated_rules();

CREATE CONSTRAINT TRIGGER garage_tax_rules_hold_their_stated_rules
  AFTER INSERT ON garage_tax_rules
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION garage_tax_sets_hold_their_stated_rules();`,
        to: '',
      },
    ],
  },
  {
    name: 'no_instant_unique',
    why: 'two sets at one instant store',
    edits: [
      {
        file: '0022_garage_tax_sets.sql',
        from: '  CONSTRAINT garage_tax_sets_one_set_per_instant UNIQUE (tenant_id, garage_id, effective_from),\n',
        to: '',
      },
    ],
  },
  {
    name: 'no_garage_trigger',
    why: "a set can be written against another tenant's garage",
    edits: [
      {
        file: '0022_garage_tax_sets.sql',
        from: `CREATE TRIGGER garage_tax_sets_garage_is_the_tenants
  BEFORE INSERT ON garage_tax_sets
  FOR EACH ROW EXECUTE FUNCTION garage_tax_sets_garage_is_the_tenants();`,
        to: '',
      },
    ],
  },
  {
    name: 'gate_ignores_taxes',
    why: 'the trigger activates a garage whose taxes are unstated',
    edits: [
      {
        file: '0022_garage_tax_sets.sql',
        from: "    IF tax_sets_stated = 0 THEN\n      RAISE EXCEPTION 'garages: cannot activate % -- its taxes are unstated', NEW.id",
        to: "    IF false THEN\n      RAISE EXCEPTION 'garages: cannot activate % -- its taxes are unstated', NEW.id",
      },
      {
        file: '0022_garage_tax_sets.sql',
        from: '    IF tax_sets_in_force = 0 THEN',
        to: '    IF false THEN',
      },
    ],
  },
  {
    name: 'gate_counts_stated',
    why: 'the trigger counts stated tax sets, not sets in force',
    edits: [
      {
        file: '0022_garage_tax_sets.sql',
        from: '    SELECT count(*), count(*) FILTER (WHERE effective_from <= now())\n      INTO tax_sets_stated, tax_sets_in_force',
        to: '    SELECT count(*), count(*)\n      INTO tax_sets_stated, tax_sets_in_force',
      },
    ],
  },
  {
    name: 'update_granted',
    why: 'the application role may UPDATE a set',
    edits: [
      {
        file: '0022_garage_tax_sets.sql',
        from: 'GRANT SELECT, INSERT ON garage_tax_sets  TO openparking_app;',
        to: 'GRANT SELECT, INSERT, UPDATE ON garage_tax_sets  TO openparking_app;',
      },
    ],
  },
];

const SUITE = ['--test', 'test/taxes.test.js', 'test/activation.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-taxes-control-'));
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

/** A scratch database built from `migrations/` with one statement edited out. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-taxes-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  for (const edit of brk.edits) {
    const path = join(partial, edit.file);
    const sql = readFileSync(path, 'utf8');
    if (!once(sql, edit.from)) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, where: edit.file };
    }
    writeFileSync(path, sql.replace(edit.from, edit.to));
  }

  for (const [script, extra] of [
    ['scripts/prepare-database.js', { MIGRATIONS_DIR: partial }],
    ['scripts/migrate.js', { MIGRATIONS_DIR: partial }],
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

/** Exactly once: an anchor that matches twice would plant the first and leave the other standing. */
const once = (text, from) => text.split(from).length === 2;

function plant(dir, edit) {
  const path = join(dir, edit.file);
  const source = readFileSync(path, 'utf8');
  if (!once(source, edit.from)) return false;
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
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${brk.file} ***`);
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
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${built.where} ***`);
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
console.log('\nall controls OK — the suite fails on every property a garage’s stated taxes rest on.');
