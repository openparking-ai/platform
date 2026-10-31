/**
 * 0047 AFTER MAIN. This branch was cut from an older main; main and the open
 * branches beside it went on to 0046. 0047 rebuilds the change log's three
 * CHECKs (actor kind, actor shape, subject kind) whole, so it must allow every
 * value any migration before it allows, or applying it on a deployment that
 * already has main takes a value away from code that writes it.
 *
 * Built here as a deployment is: main's migrations first, by the superuser
 * on a scratch database, with lines in the change log written as main's exit,
 * stay and lane-computer code writes them; then 0047. Then every value the
 * exit, walk and cleanup code writes is put in, and must be taken; and one
 * that no code writes must be refused (the control).
 *
 * MAIN'S MIGRATIONS come from `migrations/` when they are there -- a pull
 * request's CI runs on its merge commit with main -- and otherwise from git's
 * `origin/main` (`git fetch origin main`). With neither, this fails by name
 * rather than prove nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import pg from 'pg';
import { LINE_SUBJECTS } from '../src/changes.js';

const ROOT = join(import.meta.dirname, '..');
const MIGRATIONS = join(ROOT, 'migrations');
const OURS = '0047_linked_accounts_and_passkeys.sql';

// The change-log migrations of main this test cannot do without.
const MAIN_CHANGE_LOG = ['0037_exit_cases.sql', '0039_stay_endings.sql', '0042_let_out_by_a_person.sql'];

/**
 * What the code beside this branch writes in the change log, read from it:
 *   main             src/app.js: an exit case (`exit`), a stay ended by a
 *                    person (`stay`), a car let out by a lane computer
 *                    (`computer` as the actor, its id and name).
 *   inventory walk   src/app.js: a walk (`walk`), feat/inventory-walk-20261027.
 *   garage cleanup   src/app.js: stuck stays cleared (`stay`), and the walk's
 *                    and main's own, feat/garage-cleanup-20261028.
 *   exit rules       0048 (#89, #90): exceptions are their own tables; their
 *                    code writes no subject or actor beyond these.
 *   this branch      a passkey (`passkey`); a linked person as the actor.
 * and every subject and actor of the code before them.
 */
const SUBJECTS_WRITTEN = [
  'garage', 'lane', 'computer', 'reader', 'payment_account', 'rate_plan', 'tax_set', 'key', 'language', 'alert_contact', 'board_message',
  'exit', 'stay', 'walk', 'passkey', 'unknown',
];
const ACTORS_WITH_ID = ['owner', 'key', 'computer', 'linked'];
const ACTORS_WITHOUT = ['outside', 'nobody'];

/** Main's migrations and this branch's, by file name: from disk, and from git's origin/main for any not on disk. */
function migrationFiles() {
  const files = new Map(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).map((f) => [f, readFileSync(join(MIGRATIONS, f), 'utf8')]));
  const listed = spawnSync('git', ['ls-tree', '--name-only', 'origin/main', 'migrations/'], { cwd: ROOT, encoding: 'utf8' });
  if (listed.status === 0) {
    for (const path of listed.stdout.split('\n').filter((p) => p.endsWith('.sql'))) {
      if (files.has(basename(path))) continue;
      const shown = spawnSync('git', ['show', `origin/main:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (shown.status === 0) files.set(basename(path), shown.stdout);
    }
  }
  return files;
}

/** A scratch database made by the superuser; `fn` gets its URL; dropped after. */
async function scratch(fn) {
  const su = new URL(process.env.SUPERUSER_URL);
  const maintenance = new URL(su);
  maintenance.pathname = '/postgres';
  const name = `op_order_${randomUUID().slice(0, 8)}`;
  const url = new URL(su);
  url.pathname = `/${name}`;
  const m = new pg.Client({ connectionString: maintenance.toString() });
  await m.connect();
  await m.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
  try {
    return await fn(url.toString());
  } finally {
    await m.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
    await m.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`);
    await m.end();
  }
}

/** scripts/migrate.js, the runner a deployment uses, over exactly `names`, as `url`'s role; what it printed. */
function migrate(url, files, names) {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-order-'));
  try {
    for (const f of names) writeFileSync(join(dir, f), files.get(f));
    const run = spawnSync(process.execPath, ['scripts/migrate.js'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, MIGRATIONS_DIR: dir },
    });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The order a database's migrations were applied in. */
const appliedOrder = async (c) => (await c.query('SELECT filename FROM schema_migrations ORDER BY applied_at, filename')).rows.map((r) => r.filename);

/** The values a CHECK's IN list names, read from the database. */
async function listed(c, constraint) {
  const def = (await c.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND conrelid = 'garage_changes'::regclass", [constraint])).rows[0].def;
  return [...new Set([...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]))].sort();
}

test('0047 COMES AFTER main\'s change-log migrations, and shares its number with none', () => {
  const files = [...migrationFiles().keys()].sort();
  for (const f of MAIN_CHANGE_LOG) {
    assert.ok(files.includes(f), `main's ${f} is not here: in CI a pull request's merge commit carries it; locally, git fetch origin main`);
    assert.ok(f < OURS, `${f} sorts after ${OURS}`);
  }
  const numbers = files.map((f) => f.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, `two migrations share a number: ${numbers.filter((n, i) => numbers.indexOf(n) !== i).join(', ')}`);
});

test('0047 ON A DATABASE THAT HAS MAIN: the runner applies it last, after 0048; lines main\'s code wrote stay valid, every value the exit, walk, cleanup and passkey code writes is taken, one no code writes is refused', async () => {
  const files = migrationFiles();
  // Every other migration, 0048 included, as a deployment that has main has them; then 0047.
  const others = [...files.keys()].sort().filter((f) => f !== OURS);
  assert.ok(others.some((f) => f > OURS), 'no migration after 0047 to apply before it: this test no longer shows the runner taking 0047 late');
  await scratch(async (url) => {
    migrate(url, files, others);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      // Lines as main's code writes them, before 0047: an exit case, a stay,
      // a lane computer letting a car out. 0047's VALIDATE reads them.
      const tenant = (await c.query("INSERT INTO tenants (slug, name) VALUES ('order', 'order') RETURNING id")).rows[0].id;
      const line = (actorKind, actorId, subjectKind, actorName = null) => c.query(
        `INSERT INTO garage_changes (tenant_id, outcome, actor_kind, actor_id, actor_name, action, subject_kind, subject_id)
         VALUES ($1, 'done', $2, $3, $4, 'order.check', $5, gen_random_uuid())`,
        [tenant, actorKind, actorId, actorName, subjectKind],
      );
      await line('owner', randomUUID(), 'exit', 'owner@example.com');
      await line('owner', randomUUID(), 'stay', 'owner@example.com');
      await line('computer', randomUUID(), 'exit', 'Exit computer');

      // The runner, given 0047 beside what it has applied, applies 0047 alone, last.
      const said = migrate(url, files, [...others, OURS]);
      assert.deepEqual(said.split('\n').filter((l) => l.startsWith('apply ')), [`apply ${OURS}`]);
      assert.equal((await appliedOrder(c)).at(-1), OURS);

      for (const subject of SUBJECTS_WRITTEN) await line('owner', randomUUID(), subject, 'owner@example.com');
      for (const actor of ACTORS_WITH_ID) await line(actor, randomUUID(), 'garage', 'a name');
      for (const actor of ACTORS_WITHOUT) await line(actor, null, 'garage');
      // A key's line may say who acted through it.
      await c.query(
        `INSERT INTO garage_changes (tenant_id, outcome, actor_kind, actor_id, action, subject_kind, done_by)
         VALUES ($1, 'done', 'key', gen_random_uuid(), 'order.check', 'lane', 'Front desk')`, [tenant],
      );

      // The controls: a value no code writes, and each shape broken, are refused.
      await assert.rejects(line('owner', randomUUID(), 'invoice'), (e) => e.constraint === 'garage_changes_subject_kind_check');
      await assert.rejects(line('robot', randomUUID(), 'garage'), (e) => e.constraint === 'garage_changes_actor_kind_check');
      await assert.rejects(line('computer', null, 'garage'), (e) => e.constraint === 'garage_changes_actor_shape');
      await assert.rejects(line('nobody', randomUUID(), 'garage'), (e) => e.constraint === 'garage_changes_actor_shape');

      // The lists themselves: exactly the values written, nothing more and nothing lost.
      assert.deepEqual(await listed(c, 'garage_changes_subject_kind_check'), [...SUBJECTS_WRITTEN].sort());
      assert.deepEqual(await listed(c, 'garage_changes_actor_kind_check'), [...ACTORS_WITH_ID, ...ACTORS_WITHOUT].sort());
      const valid = (await c.query(
        "SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'garage_changes'::regclass AND conname IN ('garage_changes_actor_kind_check', 'garage_changes_actor_shape', 'garage_changes_subject_kind_check', 'garage_changes_done_by_shape') ORDER BY conname",
      )).rows;
      assert.deepEqual(valid.map((r) => [r.conname, r.convalidated]), [
        ['garage_changes_actor_kind_check', true], ['garage_changes_actor_shape', true], ['garage_changes_done_by_shape', true], ['garage_changes_subject_kind_check', true],
      ]);
    } finally {
      await c.end();
    }
  });
});

test('THE CODE\'S LIST IS THE TABLE\'S: every subject src/changes.js lets a line name is one the change log takes, and the other way round', async () => {
  const c = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
  await c.connect();
  try {
    assert.deepEqual(await listed(c, 'garage_changes_subject_kind_check'), [...LINE_SUBJECTS].sort());
  } finally {
    await c.end();
  }
});

test('0047 ON A FRESH DATABASE: the runner applies every migration in file order, 0047 before 0048, and ends with the same lists', async () => {
  const files = migrationFiles();
  const all = [...files.keys()].sort();
  await scratch(async (url) => {
    migrate(url, files, all);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const order = await appliedOrder(c);
      assert.deepEqual([...order].sort(), all);
      const at = (f) => order.indexOf(f);
      for (const later of all.filter((f) => f > OURS)) assert.ok(at(OURS) < at(later), `${later} was applied before ${OURS}`);
      assert.deepEqual(await listed(c, 'garage_changes_subject_kind_check'), [...SUBJECTS_WRITTEN].sort());
      assert.deepEqual(await listed(c, 'garage_changes_actor_kind_check'), [...ACTORS_WITH_ID, ...ACTORS_WITHOUT].sort());
    } finally {
      await c.end();
    }
  });
});
