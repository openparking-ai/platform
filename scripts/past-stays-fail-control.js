#!/usr/bin/env node
/**
 * The control for a garage's past stays: GET /garages/:garageId/stays/closed
 * (src/pastStays.js).
 *
 * Every property is broken below, one at a time, and the suite is REQUIRED
 * to go red. A pass is the failure.
 *
 * SOURCE breaks, applied to a COPY of the tree; no tracked file is edited.
 * Each anchor must occur exactly once in its file, or the break is reported as
 * not planted rather than run:
 *   garage_not_404         another tenant's garage answers an empty list, not 404.
 *   plate_joined           the vehicle's plate rides along with each stay.
 *   descriptor_selected    the entry descriptor rides along with each stay.
 *   stay_id_shown          each stay carries its own id.
 *   range_unbounded        a range of any length is read.
 *   page_unbounded         a page of any size is read.
 *   to_inclusive           a stay leaving exactly on `to` is in.
 *   tie_unbroken           the cursor ignores the id, so a tie at one instant loses a stay.
 *   offset_optional        a time without its offset is read in the server's zone.
 *   cursor_unchecked       a cursor is handed to the database unread.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SOURCE_BREAKS = [
  {
    name: 'garage_not_404',
    why: "another tenant's garage answers an empty list",
    file: 'src/app.js',
    from: "        if (!garage) throw new HttpError(404, 'garage not found');\n        return pastStays.closedStays(",
    to: '        return pastStays.closedStays(',
  },
  {
    name: 'plate_joined',
    why: "the vehicle's plate rides along with each stay",
    file: 'src/pastStays.js',
    from: "    `SELECT s.id, to_json(s.exit_at) #>> '{}' AS exit_key,\n",
    to: "    `SELECT s.id, to_json(s.exit_at) #>> '{}' AS exit_key, (SELECT v.plate FROM vehicles v WHERE v.id = s.vehicle_id) AS plate,\n",
    also: [{ file: 'src/pastStays.js', from: '    entry_at: row.entry_at,\n', to: '    plate: row.plate,\n    entry_at: row.entry_at,\n' }],
  },
  {
    name: 'descriptor_selected',
    why: 'the entry descriptor rides along with each stay',
    file: 'src/pastStays.js',
    from: '            s.entry_at, s.exit_at, s.fee_minor,',
    to: '            s.entry_descriptor, s.entry_at, s.exit_at, s.fee_minor,',
    also: [{ file: 'src/pastStays.js', from: '    entry_at: row.entry_at,\n', to: '    seen_as: row.entry_descriptor,\n    entry_at: row.entry_at,\n' }],
  },
  {
    name: 'stay_id_shown',
    why: 'each stay carries its own id',
    file: 'src/pastStays.js',
    from: '    entry_at: row.entry_at,\n',
    to: '    stay: row.id,\n    entry_at: row.entry_at,\n',
  },
  {
    name: 'range_unbounded',
    why: 'a range of any length is read',
    file: 'src/pastStays.js',
    from: '  if (to - from > RANGE_MAX_DAYS * 24 * 3600 * 1000) {',
    to: '  if (false) {',
  },
  {
    name: 'page_unbounded',
    why: 'a page of any size is read',
    file: 'src/pastStays.js',
    from: '|| Number(query.limit) > PAGE_MAX) {',
    to: ') {',
  },
  {
    name: 'to_inclusive',
    why: 'a stay leaving exactly on `to` is in',
    file: 'src/pastStays.js',
    from: 'AND s.exit_at < $4',
    to: 'AND s.exit_at <= $4',
  },
  {
    name: 'tie_unbroken',
    why: 'the cursor ignores the id, so a tie at one instant loses a stay',
    file: 'src/pastStays.js',
    from: 'OR (s.exit_at, s.id) > ($5::timestamptz, $6::uuid))',
    to: 'OR (s.exit_at > $5::timestamptz AND $6::uuid IS NOT NULL))',
  },
  {
    name: 'offset_optional',
    why: "a time without its offset is read in the server's zone",
    file: 'src/pastStays.js',
    from: '(Z|[+-]\\d{2}:\\d{2})$/;\n\nfunction instant',
    to: '(Z|[+-]\\d{2}:\\d{2})?$/;\n\nfunction instant',
  },
  {
    name: 'cursor_unchecked',
    why: 'a cursor is handed to the database unread',
    file: 'src/pastStays.js',
    from: "  if (typeof id !== 'string' || !UUID.test(id)) throw refused();\n",
    to: '',
  },
];

const SUITE = ['--test', 'test/past-stays.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-past-stays-control-'));
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
console.log("\nall controls OK — the suite fails on every property the past-stays read rests on.");
