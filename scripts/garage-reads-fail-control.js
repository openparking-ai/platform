#!/usr/bin/env node
/**
 * The control for the owner's three reads (U2a): GET /garages,
 * GET /garages/:garageId and GET /garages/:garageId/lanes.
 *
 * Every property is broken below, one at a time, and the suites are REQUIRED
 * to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported as
 * not planted rather than run:
 *   list_predicate_removed    the garage list reads every tenant's garages.
 *   garage_predicate_removed  one garage is read by id alone.
 *   lanes_predicate_removed   a garage's lanes are read by garage id alone.
 *   lanes_not_404             another tenant's garage answers an empty lane list, not 404.
 *   live_wrong                every garage is said to be live.
 *   garage_extra_fields       the garage carries every column, not the five.
 *   revoked_at_dropped        a revoked device is shown without saying it is revoked.
 *   unbound_reader_shown      an unbound reader is shown as the lane's.
 *   token_hash_shown          a device's credential hash is published.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SOURCE_BREAKS = [
  {
    name: 'list_predicate_removed',
    why: "the garage list reads every tenant's garages",
    file: 'src/repository.js',
    from: "'SELECT id, name, timezone, currency, activated_at FROM garages WHERE tenant_id = $1 ORDER BY created_at, id'",
    to: "'SELECT id, name, timezone, currency, activated_at FROM garages WHERE $1::uuid IS NOT NULL ORDER BY created_at, id'",
  },
  {
    name: 'garage_predicate_removed',
    why: 'one garage is read by id alone',
    file: 'src/repository.js',
    from: "client.query('SELECT * FROM garages WHERE tenant_id = $1 AND id = $2', [",
    to: "client.query('SELECT * FROM garages WHERE $1::uuid IS NOT NULL AND id = $2', [",
  },
  {
    name: 'lanes_predicate_removed',
    why: 'a garage\'s lanes are read by garage id alone',
    file: 'src/repository.js',
    from: "'SELECT id, name, direction FROM lanes WHERE tenant_id = $1 AND garage_id = $2 ORDER BY created_at, id'",
    to: "'SELECT id, name, direction FROM lanes WHERE $1::uuid IS NOT NULL AND garage_id = $2 ORDER BY created_at, id'",
  },
  {
    name: 'lanes_not_404',
    why: "another tenant's garage answers an empty lane list",
    file: 'src/app.js',
    from: "        if (!garage) throw new HttpError(404, 'garage not found');\n        return repo.lanesForGarage(client, req.tenantId, req.params.garageId);",
    to: '        return repo.lanesForGarage(client, req.tenantId, req.params.garageId);',
  },
  {
    name: 'live_wrong',
    why: 'every garage is said to be live',
    file: 'src/repository.js',
    from: 'live: row.activated_at !== null };',
    to: 'live: true };',
  },
  {
    name: 'garage_extra_fields',
    why: 'the garage carries every column',
    file: 'src/repository.js',
    from: '  return { id: row.id, name: row.name,',
    to: '  return { ...row, id: row.id, name: row.name,',
  },
  {
    name: 'revoked_at_dropped',
    why: 'a revoked device is shown without saying it is revoked',
    file: 'src/repository.js',
    from: '.map(({ id, name, last_seen_at, revoked_at }) => ({ id, name, last_seen_at, revoked_at }))',
    to: '.map(({ id, name, last_seen_at }) => ({ id, name, last_seen_at, revoked_at: null }))',
  },
  {
    name: 'unbound_reader_shown',
    why: "an unbound reader is shown as the lane's",
    file: 'src/repository.js',
    from: '      WHERE tenant_id = $1 AND garage_id = $2 AND unbound_at IS NULL`,',
    to: '      WHERE tenant_id = $1 AND garage_id = $2 ORDER BY bound_at`,',
  },
  {
    name: 'token_hash_shown',
    why: "a device's credential hash is published",
    file: 'src/repository.js',
    from: '.map(({ id, name, last_seen_at, revoked_at }) => ({ id, name, last_seen_at, revoked_at }))',
    to: '.map(({ id, name, last_seen_at, revoked_at, token_hash }) => ({ id, name, last_seen_at, revoked_at, token_hash }))',
    also: [{ file: 'src/repository.js', from: '    `SELECT d.id, d.lane_id, d.name, d.last_seen_at, d.revoked_at\n', to: '    `SELECT d.id, d.lane_id, d.name, d.last_seen_at, d.revoked_at, d.token_hash\n' }],
  },
];

const SUITE = ['--test', 'test/garage-reads.test.js', 'test/tenant-isolation.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-garage-reads-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, SUITE, { cwd: dir, env: process.env, stdio: 'pipe', encoding: 'utf8' });
}

function summarise(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? match[1] : '?';
  };
  return `${line('pass')} passed, ${line('fail')} failed`;
}

/** A break and its `also` edits, every one or none: each anchor exactly once. */
function plant(dir, edit) {
  const planned = [];
  for (const e of [edit, ...(edit.also ?? [])]) {
    const path = join(dir, e.file);
    const source = planned.find((p) => p.path === path)?.text ?? readFileSync(path, 'utf8');
    if (source.split(e.from).length !== 2) return false;
    const text = source.replace(e.from, e.to);
    const at = planned.findIndex((p) => p.path === path);
    if (at === -1) planned.push({ path, text });
    else planned[at].text = text;
  }
  for (const p of planned) writeFileSync(p.path, p.text);
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
      console.error(`  ${brk.name.padEnd(24)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(`  ${brk.name.padEnd(24)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(24)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log("\nall controls OK — the suites fail on every property the owner's reads rest on.");
