#!/usr/bin/env node
/**
 * The controls for U7g: the try, the owner's confirmation, a plan never
 * starting in the past, and opening waiting for the whole setup. Every
 * property is broken below, one at a time, in a COPY of the tree, and its
 * suite is REQUIRED to go red -- in the test that names the property. A pass
 * is the failure; so is a red in some other test.
 *
 *   try_own_tax            the try takes its tax by its own call, at the entry
 *                          instead of the exit (check 8)
 *   try_writes             the try writes an event, and its transaction is no
 *                          longer read-only (check 9)
 *   try_unlimited          the 20-a-minute limit is gone
 *   draft_alone            the draft is priced alone, without the stored plans
 *                          (check 10)
 *   past_start_allowed     the store takes a plan dated back (check 2)
 *   confirmation_ignored   the store saves without confirmed: true (check 12)
 *   open_step_dropped      opening no longer waits for the lane computers
 *                          (check 3: one condition dropped)
 *   alerts_required        opening waits for alerts too (check 3)
 *
 * Needs the same environment as the suite (the rate engine, the database).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TRY = 'test/rate-plans-try.test.js';
const START = 'test/rate-plan-start.test.js';
const OPEN = 'test/activation.test.js';
const SUITES = [TRY, START, OPEN];

const BREAKS = [
  {
    name: 'try_own_tax',
    why: 'the try takes its tax by its own call, at the entry',
    suite: TRY,
    red: ['THE SAME ANSWER'],
    edits: [{
      file: 'src/app.js',
      from: "    ? await taxedPricing({ outcome: entitlement.EXIT_OUTCOMES.TRANSIENT, ...priced }, { client, tenantId, garage, currency: garage.currency, at: stay.exitAt })\n",
      to: "    ? await (async () => { const { lines } = await taxes.taxOn(client, tenantId, garage, { subtotalMinor: priced.feeMinor, currency: garage.currency, at: stay.entryAt }); return { ...priced, subtotalMinor: priced.feeMinor, feeMinor: priced.feeMinor + taxes.taxDelta(lines), breakdown: [...priced.breakdown, ...lines] }; })()\n",
    }],
  },
  {
    name: 'try_writes',
    why: 'the try writes an event',
    suite: TRY,
    red: ['NOTHING STORED'],
    edits: [
      { file: 'src/app.js', from: "        await client.query('SET TRANSACTION READ ONLY');\n", to: '' },
      {
        file: 'src/app.js',
        from: '        for (const stay of stays) answers.push(await tryOne(client, req.tenantId, garage, documents, stay));\n',
        to: '        for (const stay of stays) answers.push(await tryOne(client, req.tenantId, garage, documents, stay));\n'
          + "        await repo.appendEvents(client, req.tenantId, [{ garageId: garage.id, laneId: null, eventId: `try:${randomUUID()}`, kind: 'rate_plan_tried', occurredAt: new Date(), detail: {} }]);\n",
      },
    ],
  },
  {
    name: 'try_unlimited',
    why: 'the 20-a-minute limit is gone',
    suite: TRY,
    red: ['NOTHING STORED'],
    edits: [{ file: 'src/app.js', from: "      if (!tryLimiter.take(`${req.actor.kind}:${req.actor.id}`)) {", to: '      if (false) {' }],
  },
  {
    name: 'draft_alone',
    why: 'the draft is priced alone, without the stored plans',
    suite: TRY,
    red: ['THE DRAFT BESIDE THE STORED PLANS'],
    edits: [{
      file: 'src/app.js',
      from: '        const documents = [...ratePlans.documents(stored), ...(draft === null ? [] : [draft])];',
      to: '        const documents = draft === null ? ratePlans.documents(stored) : [draft];',
    }],
  },
  {
    name: 'past_start_allowed',
    why: 'the store takes a plan dated back',
    suite: START,
    red: ['THE MEASUREMENT', 'a plan dated 2 minutes back is refused'],
    edits: [{ file: 'src/ratePlans.js', from: "  assertStartsNow(document, { now: now ? new Date(now).getTime() : Date.now() });\n", to: '' }],
  },
  {
    name: 'confirmation_ignored',
    why: 'the store saves without confirmed: true',
    suite: TRY,
    red: ['saving needs confirmed: true'],
    edits: [{ file: 'src/ratePlans.js', from: '  if (body?.confirmed !== true) {', to: '  if (false) {' }],
  },
  {
    name: 'open_step_dropped',
    why: 'opening no longer waits for the lane computers',
    suite: OPEN,
    red: ['opening is refused with each setup step missing'],
    edits: [{ file: 'src/activation.js', from: '  if (notDone.length) throw new NotActivatable(notDone);', to: "  if (notDone.filter((k) => k !== 'lane_computers').length) throw new NotActivatable(notDone.filter((k) => k !== 'lane_computers'));" }],
  },
  {
    name: 'alerts_required',
    why: 'opening waits for alerts too',
    suite: OPEN,
    red: ['alerts never hold opening back'],
    edits: [{ file: 'src/activation.js', from: '  if (notDone.length) throw new NotActivatable(notDone);', to: "  const told = (await import('./setup.js')).checklist;\n  const all = (await told(client, tenantId, garage)).steps.filter((s) => s.key !== 'open' && !s.done).map((s) => s.key);\n  if (all.length) throw new NotActivatable(all);" }],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-rates-open-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

const run = (dir, suite, extraEnv = {}) =>
  // The spec reporter, named: Node's default without a terminal is TAP on some
  // versions, and the red test's name is read from the spec lines.
  spawnSync(process.execPath, ['--test', '--test-reporter=spec', suite], { cwd: dir, env: { ...process.env, ...extraEnv }, stdio: 'pipe', encoding: 'utf8' });

const redTests = (result) => [...new Set([...result.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))];

function summarise(result) {
  const line = (label) => result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'))?.[1] ?? '?';
  return `${line('pass')} passed, ${line('fail')} failed`;
}

/** Every edit's anchor exactly once, or nothing is planted. */
function plant(base, edits) {
  const texts = new Map();
  for (const e of edits) {
    const path = join(base, e.file);
    const source = texts.get(path) ?? readFileSync(path, 'utf8');
    if (source.split(e.from).length !== 2) return e.file;
    texts.set(path, source.replace(e.from, e.to));
  }
  for (const [path, text] of texts) writeFileSync(path, text);
  return null;
}

let failures = 0;

console.log('== control A: the suite must PASS intact ==');
{
  const dir = stage();
  try {
    for (const suite of SUITES) {
      const intact = run(dir, suite);
      if (intact.status === 0) console.log(`  ${suite.padEnd(34)} OK — ${summarise(intact)}`);
      else {
        console.error(`  CONTROL A FAILED — ${suite} does not pass intact: ${summarise(intact)}\n${intact.stdout}\n${intact.stderr}`);
        failures += 1;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function judge(brk, broken) {
  const red = redTests(broken);
  const named = brk.red.every((want) => red.some((t) => t.includes(want)));
  if (broken.status === 0) {
    console.error(`  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
    failures += 1;
  } else if (!named) {
    console.error(`  ${brk.name.padEnd(26)} *** RED, BUT NOT IN "${brk.red.join('", "')}" — red: ${red.join(' | ')} ***`);
    failures += 1;
  } else {
    console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}; named: ${brk.red.join(', ')}`);
  }
}

console.log('\n== control B: each break must make the suite FAIL, in the test that names it ==');
for (const brk of BREAKS) {
  const dir = stage();
  try {
    const missing = plant(dir, brk.edits);
    if (missing) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing} ***`);
      failures += 1;
      continue;
    }
    judge(brk, run(dir, brk.suite));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust the U7g tests.`);
  process.exit(1);
}
console.log(`\nall controls OK — the suite fails, by name, on every one of the ${BREAKS.length} properties U7g rests on.`);
