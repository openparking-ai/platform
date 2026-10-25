/**
 * The validations door's stand-in (test/fixtures/validations-door) keeps its
 * state in a file the suite reads while a door call is writing it:
 * test/validations.test.js polls it during a late release (A3). A read must
 * meet the file whole, before the write or after it, never cut short: one
 * that met it half-written failed that test as "Unexpected end of JSON input"
 * (platform CI run 40127260753, attempt 1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStandInState } from './fixtures/validations-door/state.js';

const STAND_IN = new URL('./fixtures/validations-door/stand-in.mjs', import.meta.url).pathname;

test("the stand-in's state file is never read half-written while a release writes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'validations-stand-in-'));
  const state = join(dir, 'state.json');
  try {
    // Large enough that a write takes long enough to be met halfway.
    const garages = {};
    for (let i = 0; i < 3000; i += 1) {
      garages[`t/g${i}`] = [{ phone: '2025550143', validator_name: 'Validator '.repeat(4), discount_type: 'flat', discount_value: 5, discount_minor: 500, claimed_ref: null }];
    }
    let reads = 0;
    let torn = 0;
    for (let round = 0; round < 25; round += 1) {
      garages['t/g'] = [{ phone: '2025550143', validator_name: 'V', discount_minor: 500, claimed_ref: 'ref', claim_id: 'c1' }];
      // A delay makes the release write twice: once to take the delay, once to release.
      writeStandInState(state, { mode: 'normal', garages, release_delay_once_ms: 1 });
      const child = spawn(process.execPath, [STAND_IN, 'release-in-store', '--tenant', 't', '--garage', 'g', '--ref', 'ref', '--claim', 'c1'], {
        env: { ...process.env, VALIDATIONS_STANDIN_STATE: state },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      child.stdin.end();
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const exited = new Promise((resolve) => child.on('exit', resolve));
      let done = false;
      exited.then(() => { done = true; });
      while (!done) {
        reads += 1;
        try {
          JSON.parse(readFileSync(state, 'utf8'));
        } catch {
          torn += 1;
        }
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(await exited, 0, out);
      assert.equal(JSON.parse(out).outcome, 'released');
    }
    assert.ok(reads > 100, `the file was read while it was written (${reads} reads)`);
    assert.equal(torn, 0, `${torn} of ${reads} reads met the file cut short`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
