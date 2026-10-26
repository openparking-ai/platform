import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStandInState } from './fixtures/validations-door/state.js';

export const DOOR_DIR = fileURLToPath(new URL('./fixtures/accounts-door/', import.meta.url));
export const DOOR_NAME = 'accounts-stand-in';

/**
 * The linked accounts door's stand-in (test/fixtures/accounts-door), named for
 * this test process: ACCOUNTS_DOOR, where to find it, and its state and log in
 * a scratch folder. `name(false)` unsets the door for the code under test, as
 * a deployment with none. Every change reads the state first: the door itself
 * writes it (a passkey's counter).
 */
export function accountsStandIn() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-accounts-door-'));
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'calls.jsonl');
  const name = (on = true) => {
    if (on) process.env.ACCOUNTS_DOOR = DOOR_NAME;
    else delete process.env.ACCOUNTS_DOOR;
  };
  process.env.ENTITLEMENT_BIN_DIR = DOOR_DIR;
  process.env.ACCOUNTS_STANDIN_STATE = statePath;
  process.env.ACCOUNTS_STANDIN_LOG = logPath;
  name(true);
  writeStandInState(statePath, { mode: 'normal', people: [], passkeys: {} });
  const read = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const edit = (fn) => {
    const s = read();
    fn(s);
    writeStandInState(statePath, s);
  };
  return {
    name,
    read,
    edit,
    /** Every call since the last `forget`, as {argv, stdin}. */
    calls: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    forget: () => writeFileSync(logPath, ''),
    /** One more person the door knows; `over` replaces any field. */
    person(tenant, over = {}) {
      const p = {
        person: randomUUID(), tenant, email: `p-${randomUUID().slice(0, 8)}@example.com`, password: 'linked person password one',
        name: 'Pat Example', language: 'en', garages: 'all', permissions: ['garages:read'], version: 'v1', ...over,
      };
      edit((s) => s.people.push(p));
      return p;
    },
    /** Change what the door now says of `person`. */
    change(person, over) {
      edit((s) => Object.assign(s.people.find((p) => p.person === person), over));
    },
    setMode(mode, only) {
      edit((s) => {
        s.mode = mode;
        if (only) s.only = only;
        else delete s.only;
      });
    },
    end: () => rmSync(dir, { recursive: true, force: true }),
  };
}
