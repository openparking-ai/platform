/**
 * EVERY READER OF `rate_plans` (U7i fix 1, 0034): withdrawn plans are never
 * used for a price, and that holds only while ONE function selects the plans
 * that price. This sweep reads the source -- `src/`, `scripts/` (the fail
 * controls aside: their text is plants) and the migrations -- and lists every
 * statement that touches the table, by file and function.
 *
 *   - In the application, the table is touched only inside src/ratePlans.js
 *     (and by the demo's one seeding INSERT, which reads nothing),
 *     by the four functions that own it: `storeRatePlan` (the insert),
 *     `ratePlansForGarage` (the plans that price, withdrawn ones left out),
 *     `ratePlanHistory` (every plan, for the owner's history and the version
 *     name check -- never priced) and `withdrawRatePlan`.
 *   - `ratePlanHistory` is called in exactly two places: the rate-plans READ
 *     and the try's version-name check. Nothing hands it to the engine.
 *   - In the database, the latest definition of every function that reads the
 *     table leaves withdrawn plans out.
 *
 * Each list has its known-present control: the sweep must FIND the seam
 * itself, and the opening gate, or an empty list would pass for the wrong
 * reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TOUCH = /\b(?:FROM|JOIN|UPDATE|INTO)\s+rate_plans\b/gi;

function files(dir, keep) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), keep) : keep(e.name) ? [join(dir, e.name)] : [],
  );
}

/** The function a line sits in: the nearest declaration above it. */
function enclosing(text, index) {
  const before = text.slice(0, index);
  const all = [...before.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:operator|lane|app|router)\.(?:get|post|put|patch|delete)\('([^']+)'/gm)];
  const last = all.at(-1);
  return last ? last[1] ?? last[2] : '(top level)';
}

function readers() {
  const out = [];
  const sources = [...files('src', (n) => n.endsWith('.js')), ...files('scripts', (n) => n.endsWith('.js') && !n.includes('fail-control'))];
  for (const file of sources) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(TOUCH)) out.push(`${file} ${enclosing(text, m.index)} ${m[0].split(/\s+/)[0].toUpperCase()}`);
  }
  return [...new Set(out)].sort();
}

test('every statement on rate_plans in the application is inside src/ratePlans.js, in the four functions that own the table', () => {
  const found = readers();
  // CONTROL: the sweep finds the seam itself.
  assert.ok(found.includes('src/ratePlans.js ratePlansForGarage FROM'), `the sweep did not find the seam: ${found.join(', ')}`);
  assert.deepEqual(found, [
    // The demo's own garage, seeded once (an insert: it reads nothing).
    'scripts/demo.js (top level) INTO',
    'src/ratePlans.js ratePlanHistory FROM',
    'src/ratePlans.js ratePlansForGarage FROM',
    'src/ratePlans.js storeRatePlan INTO',
    'src/ratePlans.js withdrawRatePlan FROM',
    'src/ratePlans.js withdrawRatePlan UPDATE',
  ]);
});

test('the plans that price leave withdrawn plans out, and the history -- which keeps them -- is never priced', () => {
  const text = readFileSync(join(ROOT, 'src/ratePlans.js'), 'utf8');
  const seam = text.slice(text.indexOf('export async function ratePlansForGarage'), text.indexOf('export async function ratePlanHistory'));
  assert.match(seam, /WHERE tenant_id = \$1 AND garage_id = \$2 AND withdrawn_at IS NULL/);
  const calls = [];
  for (const file of files('src', (n) => n.endsWith('.js'))) {
    if (file === 'src/ratePlans.js') continue;
    const src = readFileSync(join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/ratePlanHistory\(/g)) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      calls.push(`${file} ${enclosing(src, m.index)}: ${line.trim()}`);
    }
  }
  // CONTROL: the read is found (the sweep is looking in the right place).
  assert.ok(calls.some((c) => c.includes(' /garages/:garageId/rate-plans: ')), calls.join('\n'));
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.ok(calls.every((c) => !/documents\(|quote/i.test(c)), `the history is handed on to be priced:\n${calls.join('\n')}`);
  // The try reads it for the names only: `history` goes to assertNewBeside and nowhere else.
  assert.ok(calls.some((c) => c.includes(' /garages/:garageId/rate-plans/try: ') && c.includes('const history =')), calls.join('\n'));
  const app = readFileSync(join(ROOT, 'src/app.js'), 'utf8');
  const uses = [...app.matchAll(/\bhistory\b/g)].map((m) => app.slice(app.lastIndexOf('\n', m.index) + 1, app.indexOf('\n', m.index)).trim());
  assert.deepEqual(uses.filter((u) => !u.startsWith('//') && !u.startsWith('*')), [
    'const history = await ratePlans.ratePlanHistory(client, req.tenantId, garage.id);',
    'ratePlans.assertNewBeside(staying, doc, history);',
  ]);
});

test('in the database, the latest definition of every function reading rate_plans leaves withdrawn plans out', () => {
  const latest = new Map();
  for (const file of files('migrations', (n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(ROOT, file), 'utf8');
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*\([^)]*\)[\s\S]*?\$\$([\s\S]*?)\$\$/gi)) {
      latest.set(m[1], { file, body: m[2] });
    }
  }
  const reading = [...latest].filter(([, f]) => /\bFROM\s+rate_plans\b/i.test(f.body));
  // CONTROL: the opening gate reads it.
  assert.ok(reading.some(([name]) => name === 'garages_activation_gate'), reading.map(([n]) => n).join(', '));
  for (const [name, f] of reading) {
    const stmt = f.body.slice(f.body.search(/\bFROM\s+rate_plans\b/i)).split(';')[0];
    assert.match(stmt, /withdrawn_at IS NULL/, `${name} (${f.file}) reads rate_plans with withdrawn plans in`);
  }
});
