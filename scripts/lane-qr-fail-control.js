#!/usr/bin/env node
/**
 * The control for test/lane-qr.test.js: each property of a QR shown at a
 * lane, taken out of a COPY of the tree, must turn that file red. A test that
 * stays green with the property gone does not measure it.
 *
 * THE POSITIVE CONTROL comes first: the copy with nothing planted must be
 * green, or a red below could be the copy, not the plant.
 *
 * Needs the same environment as the suite: garage-pass on the path and a
 * checkout of it for its migrations.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LIMIT_MS = Number(process.env.LANE_QR_LIMIT_MS || 300_000);

const PLANTS = [
  {
    name: 'the gate opens on any answer, not only covered',
    file: 'src/enrolments.js',
    from: "    open: outcome === 'covered',",
    to: "    open: outcome !== 'refused_to_answer',",
  },
  {
    name: 'nothing read keeps a valid QR shut (the rule before "similar enough gets a pass")',
    file: 'src/enrolments.js',
    from: "    open: outcome === 'covered',",
    to: "    open: outcome === 'covered' && printed.enrolment.passed_by !== 'nothing_read',",
  },
  {
    name: 'a look-alike or one-difference read keeps a valid QR shut',
    file: 'src/enrolments.js',
    from: "    open: outcome === 'covered',",
    to: "    open: outcome === 'covered' && !['look_alike', 'one_difference'].includes(printed.enrolment.passed_by),",
  },
  {
    name: 'a refused QR keeps a covered car shut (a QR refusal read as a car refusal)',
    file: 'src/enrolments.js',
    from: "    open: outcome === 'covered',",
    to: "    open: outcome === 'covered' && typeof printed.enrolment.refused !== 'string',",
  },
  {
    name: 'could-not-answer relayed as an answer (shut, 200) instead of the offline case',
    file: 'src/app.js',
    from: "        throw new HttpError(503, `${err.message}; the QR could not be checked`, 'qr_unanswered');",
    to: "        return res.json({ open: false, outcome: 'refused_to_answer', enrolment: {}, answer: {} });",
  },
  {
    name: 'the token written into the event',
    file: 'src/enrolments.js',
    from: "  const detail = { lane_id: laneId, direction, read_identity: vehicle !== '' };",
    to: "  const detail = { lane_id: laneId, direction, read_identity: vehicle !== '', token: globalThis.__qrToken };",
    also: {
      from: "  const argv = [\n    'redeem-enrolment',",
      to: "  globalThis.__qrToken = token;\n  const argv = [\n    'redeem-enrolment',",
    },
  },
  {
    name: 'the plate written into the event',
    file: 'src/enrolments.js',
    from: "  const detail = { lane_id: laneId, direction, read_identity: vehicle !== '' };",
    to: "  const detail = { lane_id: laneId, direction, read_identity: vehicle !== '', vehicle };",
  },
  {
    name: "the QR's plate written into the event",
    file: 'src/enrolments.js',
    from: '    passed_by: PASSED_BY.includes(e.passed_by) ? e.passed_by : null,\n',
    to: '    passed_by: PASSED_BY.includes(e.passed_by) ? e.passed_by : null,\n    qr_plate: e.qr_plate ?? null,\n',
  },
  {
    name: 'the event does not say how the car passed for the QR (no passed_by)',
    file: 'src/enrolments.js',
    from: '    passed_by: PASSED_BY.includes(e.passed_by) ? e.passed_by : null,\n',
    to: '',
  },
  {
    name: "the event does not name the QR (no enrolment id)",
    file: 'src/enrolments.js',
    from: "    enrolment: typeof e.enrolment === 'string' ? e.enrolment : null,\n",
    to: '    enrolment: null,\n',
  },
  {
    name: 'the plate written into a log line',
    file: 'src/app.js',
    from: '      await record(enrolments.presentedDetail({ laneId, direction, vehicle, result }));',
    to: '      console.log(`qr presented at ${laneId}: ${vehicle}`);\n      await record(enrolments.presentedDetail({ laneId, direction, vehicle, result }));',
  },
  {
    name: "the door's error quotes the argv (and with it the token)",
    file: 'src/entitlement.js',
    from: "    throw new EntitlementUnavailable(module, `${script} could not be run (${err.code ?? err.signal ?? 'no exit status'})`);",
    to: "    throw new EntitlementUnavailable(module, `${script} could not be run: ${argv.join(' ')}`);",
  },
  {
    name: 'no event for a presentation',
    file: 'src/app.js',
    from: '      await record(enrolments.presentedDetail({ laneId, direction, vehicle, result }));',
    to: '',
  },
  {
    name: 'no rate limit',
    file: 'src/app.js',
    from: '      if (!qrLimiter.take(deviceId)) {',
    to: '      if (false) {',
  },
  {
    name: 'one limit for every device',
    file: 'src/app.js',
    from: '      if (!qrLimiter.take(deviceId)) {',
    to: "      if (!qrLimiter.take('every-lane')) {",
  },
  {
    name: 'a stale presentation taken',
    file: 'src/app.js',
    from: '      if ((Date.now() - at.getTime()) / 1000 > enrolments.PRESENTED_MAX_AGE_SECONDS) {',
    to: '      if (false) {',
  },
  {
    name: "the direction taken from the body, not the device's lane",
    file: 'src/app.js',
    from: '        result = await enrolments.redeem({ link, token, vehicle, laneId, direction, at });',
    to: "        result = await enrolments.redeem({ link, token, vehicle, laneId, direction: req.body?.direction ?? 'entry', at });",
  },
  {
    name: "a lane's qr_presented taken with any detail",
    file: 'src/app.js',
    from: '          if (extra.length || detail.answered !== false) {',
    to: '          if (false) {',
  },
  {
    name: 'a control character in the token reaches the module',
    file: 'src/enrolments.js',
    from: "  if (/[\\u0000-\\u001f\\u007f]/.test(raw)) throw new TypeError('token carries a control character');",
    to: '',
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-lane-qr-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Exactly once, or the plant measures nothing. */
function plant(path, from, to) {
  const text = readFileSync(path, 'utf8');
  if (text.split(from).length !== 2) return false;
  writeFileSync(path, text.replace(from, to));
  return true;
}

function runFile(dir) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--test', 'test/lane-qr.test.js'], {
      cwd: dir, env: process.env, stdio: 'ignore', detached: true,
    });
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, LIMIT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* none left */ }
      done({ code, hung });
    });
  });
}

let failed = 0;

const control = stage();
try {
  const { code, hung } = await runFile(control);
  if (code !== 0 || hung) {
    console.error(`POSITIVE CONTROL: the unplanted copy is not green (exit ${code}${hung ? ', hung' : ''}); nothing below can be read`);
    process.exit(1);
  }
  console.log('control: the unplanted copy is green');
} finally {
  rmSync(control, { recursive: true, force: true });
}

for (const p of PLANTS) {
  const dir = stage();
  try {
    const path = join(dir, p.file);
    if (!plant(path, p.from, p.to) || (p.also && !plant(path, p.also.from, p.also.to))) {
      console.error(`NOT PLANTED: ${p.name} -- its text is not in ${p.file} exactly once`);
      failed += 1;
      continue;
    }
    const { code, hung } = await runFile(dir);
    const caught = code !== 0 && !hung;
    console.log(`${caught ? 'caught' : 'MISSED'}: ${p.name}${hung ? ' (hung)' : ''}`);
    if (!caught) failed += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failed) {
  console.error(`${failed} of ${PLANTS.length} plants not caught`);
  process.exit(1);
}
console.log(`all ${PLANTS.length} plants caught`);
