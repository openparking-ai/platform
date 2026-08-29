#!/usr/bin/env node
/**
 * The control for this round's two additions: the devices route and the name
 * every conflict carries.
 *
 * Both exist so something OUTSIDE this platform can tell two situations apart
 * that used to look identical -- a lane that has gone quiet from one that is
 * merely idle, and a clock skew dead-lettering every session from an ordinary
 * refusal. A test that has never been observed failing is not evidence that it
 * separates them, so each break below removes exactly one of the properties and
 * REQUIRES the suite to go red. A pass is the failure.
 *
 * Every break is applied to a COPY of the source in a temporary directory, and
 * no tracked file is edited by this script. `node_modules` is symlinked rather
 * than reinstalled.
 *
 *   devices_no_last_seen   the route stops selecting the column it exists to
 *                          publish. The list still looks like a list.
 *   devices_no_garage_check  another tenant's garage answers 200 with an empty
 *                          list instead of 404 -- a monitor pointed at the
 *                          wrong tenant would report no devices and therefore
 *                          nothing wrong.
 *   devices_token_hash     the credential's hash rides along in the listing.
 *   touch_not_wired        `touch_lane_device` is no longer called on the lane
 *                          request path, so the column the route publishes is
 *                          one nothing sets. This is the break the route tests
 *                          alone cannot see, and it is why the suite bumps the
 *                          value through a real authenticated request.
 *   one_code_for_conflicts every conflict answers `clock_skew`, so the field
 *                          exists and distinguishes nothing.
 *   no_code_on_the_wire    the error handler stops publishing the field.
 *   bare_conflict          a conflict raised directly, bypassing `conflict()`,
 *                          so it reaches a lane unnamed -- indistinguishable
 *                          from a platform too old to have the field at all.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** Each break names the file, the exact text it replaces, and what to put there. */
const BREAKS = [
  {
    name: 'devices_no_last_seen',
    why: 'the devices route stops publishing last_seen_at',
    file: 'src/repository.js',
    from: 'SELECT d.id, d.lane_id, d.name, d.created_at, d.last_seen_at, d.revoked_at',
    to: 'SELECT d.id, d.lane_id, d.name, d.created_at, d.revoked_at',
  },
  {
    name: 'devices_no_garage_check',
    why: "another tenant's garage answers with an empty list instead of 404",
    file: 'src/app.js',
    from: `        const garage = await repo.getGarage(client, req.tenantId, req.params.garageId);
        if (!garage) throw new HttpError(404, 'garage not found');
        return repo.devicesForGarage(client, req.tenantId, req.params.garageId);`,
    to: '        return repo.devicesForGarage(client, req.tenantId, req.params.garageId);',
  },
  {
    name: 'devices_token_hash',
    why: "the listing carries the credential's hash",
    file: 'src/repository.js',
    from: 'SELECT d.id, d.lane_id, d.name, d.created_at, d.last_seen_at, d.revoked_at',
    to: 'SELECT d.id, d.lane_id, d.name, d.created_at, d.last_seen_at, d.revoked_at, d.token_hash',
  },
  {
    name: 'touch_not_wired',
    why: 'the column the route publishes is one nothing sets',
    file: 'src/app.js',
    from: "      pool.query('SELECT touch_lane_device($1)', [req.device.deviceId]).catch(() => {});",
    to: '      // touch removed by the fail-control',
  },
  {
    name: 'one_code_for_conflicts',
    why: 'every conflict answers clock_skew, so the field distinguishes nothing',
    file: 'src/app.js',
    from: 'const conflict = (code, message) => new HttpError(CONFLICT_STATUS, message, code);',
    to: "const conflict = (code, message) => new HttpError(CONFLICT_STATUS, message, CLOCK_SKEW);",
  },
  {
    name: 'no_code_on_the_wire',
    why: 'the error handler stops publishing the name',
    file: 'src/app.js',
    from: '    const named = err instanceof HttpError && err.code;',
    to: '    const named = false;',
  },
  {
    name: 'bare_conflict',
    why: 'a conflict is raised directly and reaches a lane unnamed',
    file: 'src/app.js',
    from: "        if (!rate) throw conflict('no_rate_configured', 'garage has no rate configured');",
    to: "        if (!rate) throw new HttpError(409, 'garage has no rate configured');",
  },
];

const SUITE = ['--test', 'test/api.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-r3-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, SUITE, {
    cwd: dir,
    env: process.env,
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
      // A break whose anchor has moved silently applies nothing, and the run
      // then reports a passing suite as a failed control -- for the wrong
      // reason. Named here so the two cannot be confused.
      console.error(`  ${brk.name.padEnd(23)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    writeFileSync(path, source.replace(brk.from, brk.to));
    const broken = run(dir);
    if (broken.status === 0) {
      console.error(
        `  ${brk.name.padEnd(23)} *** PASSED WHEN ${brk.why.toUpperCase()} —` +
          ' the suite is not measuring this ***',
      );
      failures += 1;
    } else {
      console.log(`  ${brk.name.padEnd(23)} fails as required when ${brk.why} — ${summarise(broken)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's platform tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property this round added.');
