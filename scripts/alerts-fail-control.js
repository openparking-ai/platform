#!/usr/bin/env node
/**
 * The controls for U4b: who gets which alert, and how. Every property is
 * broken below, one at a time, in a COPY of the tree, and the suite that
 * measures it is REQUIRED to go red -- and to go red in the test that names
 * the property. A pass is the failure; so is a red in some other test.
 *
 * Source breaks:
 *   garage_from_body          a person is added to the garage the body names       (check 1)
 *   seven_digit_phone         a 7-digit number is kept as a phone number            (check 2)
 *   email_two_at              an address with two @ is kept                         (check 2)
 *   texts_kept_without_phone  taking a phone away leaves its text choices          (check 3)
 *   text_choice_unchecked     a text choice is taken for a person with no phone     (check 3)
 *   phone_in_line             the guard is off and the number put in the line       (check 5)
 *   contact_guard_off         the line's guard lets a person's details through      (check 5)
 *   name_in_line              a person's name is stored in their line again        (fix 2, check 1)
 *   line_words_off            a line about a person may hold any text               (fix 2, check 1)
 *   request_as_sent           a refused attempt on a person names the path as sent  (fix 2, check 1)
 *   contact_path_case_only    a person's address is known in lower case only        (fix 3, G1)
 *   removed_still_said_named  a removed person's lines are not said to be removed   (fix 2, check 2)
 *   name_as_written           the log's read names a person as the line holds them  (fix 2, check 2)
 *   line_outside_transaction  a person's line is written on its own transaction    (check 6)
 *   alert_line_skipped        a person's change commits without its line            (check 6)
 *   step_counts_texts_only    the checklist step ignores email choices              (check 7)
 *   alerts_hold_open          the alerts step changes the open step                 (check 7)
 *   send_planted              the round's code makes a network call                 (check 8)
 *   provider_planted          a text and email provider is a dependency             (check 8)
 *   person_by_account_only    a person is looked up by account and id, not garage   (fix N1)
 *   ascii_digits_only         only 0-9 count as digits in the line guard            (fix F3)
 *   scan_keeps_separators     the log scan reads numbers with what stands between   (fix F3)
 *   scan_raw_text_off         the log scan does not read text as it was typed       (fix 2, check 1)
 *   scan_decimal_only         the log scan reads only decimal digits                (fix 2, check 1)
 *
 * Schema breaks (the copy's migrations edited; a scratch database built from
 * them):
 *   contacts_bound_dropped    the database takes a 26th person                      (check 4)
 *   name_bound_dropped        the database takes an over-long name                  (check 4)
 *   policy_dropped            a garage's people are readable by every account       (check 1)
 *   other_garage_taken        the database takes a person on another account's garage (check 1)
 *   person_named_in_database  the database takes a name on a line about a person    (fix 2, check 1)
 *
 * Plants that would write a person's details into the append-only log run
 * on a scratch database, so nothing they write stays in the suite's own.
 *
 * Needs the same environment as the suite (a Postgres it may make a scratch
 * database on).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = 'openparking_alerts_control';

const ALERTS = 'test/alerts.test.js';
const LOG = 'test/change-log.test.js';
const ISOLATION = 'test/tenant-isolation.test.js';

const SOURCE_BREAKS = [
  {
    name: 'garage_from_body',
    why: 'a person is added to the garage the body names',
    suite: ALERTS,
    scratch: true,
    red: ['YOUR GARAGE ONLY'],
    edits: [
      { file: 'src/alerts.js', from: "export async function add(client, tenantId, garageId, body, ctx) {\n  onlyKeys(body, ['name', 'phone', 'email', 'language']);", to: "export async function add(client, tenantId, garageId, body, ctx) {\n  onlyKeys(body, ['name', 'phone', 'email', 'language', 'garage_id']);" },
      { file: 'src/alerts.js', from: '      [tenantId, garageId, name, phone, email, language],', to: '      [tenantId, body.garage_id ?? garageId, name, phone, email, language],' },
    ],
  },
  {
    name: 'seven_digit_phone',
    why: 'a 7-digit number is kept as a phone number',
    suite: ALERTS,
    red: ['PHONE AND EMAIL'],
    edits: [{ file: 'src/alerts.js', from: '  if (digits.length === 10) return `+1${digits}`;', to: '  if (digits.length === 10 || digits.length === 7) return `+1${digits}`;' }],
  },
  {
    name: 'email_two_at',
    why: 'an address with two @ is kept',
    suite: ALERTS,
    red: ['PHONE AND EMAIL'],
    edits: [{ file: 'src/alerts.js', from: "  if (parts.length !== 2) refuse(", to: "  if (parts.length < 2) refuse(" }],
  },
  {
    name: 'texts_kept_without_phone',
    why: 'taking a phone away leaves its text choices',
    suite: ALERTS,
    red: ['THE CHOICES HOLD TOGETHER'],
    edits: [{ file: 'src/alerts.js', from: '    const byText = phone === null ? [] : row.by_text;', to: '    const byText = row.by_text;' }],
  },
  {
    name: 'text_choice_unchecked',
    why: 'a text choice is taken for a person with no phone',
    suite: ALERTS,
    red: ['THE CHOICES HOLD TOGETHER'],
    edits: [{ file: 'src/alerts.js', from: '    if (byText.length && row.phone === null) {', to: '    if (false) {' }],
  },
  {
    name: 'phone_in_line',
    why: "the guard is off and a person's number is put in their line",
    suite: ALERTS,
    scratch: true,
    red: ['NO TYPED CONTACT TEXT IN ANY STORED LINE'],
    edits: [
      { file: 'src/alerts.js', from: "    if (phone !== row.phone) { before.phone = kept(row.phone); after.phone = row.phone !== null && phone !== null ? 'changed' : kept(phone); }", to: '    if (phone !== row.phone) { before.phone = kept(row.phone); after.phone = phone; }' },
      { file: 'src/changes.js', from: "  assertNoContactDetail({ action, subject: { kind: subject.kind, name: subject.name }, before, after }, ctx.private ?? []);\n  if (subject.kind === 'alert_contact') assertContactLineWords({ subject, before, after });", to: '' },
    ],
  },
  {
    name: 'contact_guard_off',
    why: "the line's guard lets a person's details through",
    suite: ALERTS,
    scratch: true,
    red: ['the guard itself'],
    edits: [{ file: 'src/changes.js', from: 'export function assertNoContactDetail(line, details = []) {', to: 'export function assertNoContactDetail(line, details = []) {\n  return;' }],
  },
  {
    name: 'name_in_line',
    why: "a person's name is stored in their line again, the word check off",
    suite: ALERTS,
    scratch: true,
    red: ['NO TYPED CONTACT TEXT IN ANY STORED LINE', 'REMOVAL REMOVES'],
    edits: [
      { file: 'src/alerts.js', from: "    if (name !== row.name) after.name = 'changed';", to: '    if (name !== row.name) { before.name = row.name; after.name = name; }' },
      { file: 'src/changes.js', from: "  if (subject.kind === 'alert_contact') assertContactLineWords({ subject, before, after });", to: '' },
    ],
  },
  {
    name: 'line_words_off',
    why: 'a line about a person may hold any text',
    suite: ALERTS,
    scratch: true,
    red: ['the guard itself'],
    edits: [{ file: 'src/changes.js', from: 'export function assertContactLineWords({ subject, before, after }) {', to: 'export function assertContactLineWords({ subject, before, after }) {\n  return;' }],
  },
  {
    name: 'request_as_sent',
    why: 'a refused attempt on a person names the path as it was sent',
    suite: ALERTS,
    scratch: true,
    red: ['NO TYPED CONTACT TEXT IN ANY STORED LINE'],
    edits: [{ file: 'src/app.js', from: '        request: requestFor(req),', to: '' }],
  },
  {
    name: 'contact_path_case_only',
    why: "a person's address is known in lower case only, as the second re-gate's plant had it",
    suite: ALERTS,
    scratch: true,
    red: ['NO TYPED CONTACT TEXT IN ANY STORED LINE'],
    // Red by the spelling it came through, not only by the test's name.
    says: 'typed text sent through PATCH /api/v1/garages/G/Alert-Contacts/{id} is in a log',
    edits: [{ file: 'src/app.js', from: 'const CONTACT_PATH = /\\/alert-contacts(\\/|$)/i;', to: 'const CONTACT_PATH = /\\/alert-contacts(\\/|$)/;' }],
  },
  {
    name: 'removed_still_said_named',
    why: "a removed person's lines are not said to be removed",
    suite: ALERTS,
    red: ['REMOVAL REMOVES'],
    edits: [{ file: 'src/changes.js', from: "            (gc.subject_kind = 'alert_contact' AND ac.id IS NULL) AS subject_removed,", to: '            false AS subject_removed,' }],
  },
  {
    name: 'name_as_written',
    why: 'the log reads a person as the line holds them, not as they are named now',
    suite: ALERTS,
    red: ['REMOVAL REMOVES'],
    edits: [{ file: 'src/changes.js', from: "            CASE WHEN gc.subject_kind = 'alert_contact' THEN ac.name ELSE gc.subject_name END AS subject_name,", to: '            gc.subject_name,' }],
  },
  {
    name: 'line_outside_transaction',
    why: "a person's line is written on its own transaction",
    suite: ALERTS,
    red: ['ONE TRANSACTION'],
    edits: [
      { file: 'src/alerts.js', from: "    await changes.record(client, ctx, { garageId, action: 'alert_contact.change', subject: subjectOf(rows[0]), before, after });", to: "    await withTenant(tenantId, (own) => changes.record(own, ctx, { garageId, action: 'alert_contact.change', subject: subjectOf(rows[0]), before, after }));" },
      { file: 'src/alerts.js', from: "import { HttpError } from './errors.js';", to: "import { HttpError } from './errors.js';\nimport { withTenant } from './db.js';" },
    ],
  },
  {
    name: 'alert_line_skipped',
    why: "a person's change commits without its line",
    suite: LOG,
    red: ['EVERY WRITE'],
    edits: [
      { file: 'src/alerts.js', from: "    await changes.record(client, ctx, { garageId, action: 'alert_contact.choices', subject: subjectOf(rows[0]), before, after });", to: '' },
      { file: 'src/app.js', from: '      if (lines !== 1 && !(lines === 0 && req.change.unchanged)) {', to: '      if (false) {' },
    ],
  },
  {
    name: 'step_counts_texts_only',
    why: 'the checklist step ignores email choices',
    suite: ALERTS,
    red: ['THE CHECKLIST STEP IS THE DATA'],
    edits: [{ file: 'src/setup.js', from: '    done: told.alerts.every((a) => a.by_text + a.by_email > 0),', to: '    done: told.alerts.every((a) => a.by_text > 0),' }],
  },
  {
    name: 'alerts_hold_open',
    why: 'the alerts step changes the open step',
    suite: ALERTS,
    red: ['THE CHECKLIST STEP IS THE DATA'],
    edits: [{ file: 'src/setup.js', from: '      not_done: notDone,', to: "      not_done: steps.filter((s) => !s.done).map((s) => s.key)," }],
  },
  {
    name: 'send_planted',
    why: "the round's code makes a network call",
    suite: ALERTS,
    red: ['NOTHING IS SENT'],
    edits: [{ file: 'src/alerts.js', from: 'export const MAX_CONTACTS = 25;', to: "export const MAX_CONTACTS = 25;\nexport const notify = (to) => fetch('https://messages.example.com/send', { method: 'POST', body: to });" }],
  },
  {
    name: 'provider_planted',
    why: 'a text and email provider is a dependency',
    suite: ALERTS,
    red: ['NOTHING IS SENT'],
    edits: [{ file: 'package.json', from: '"express": "^4.21.2",', to: '"express": "^4.21.2",\n    "twilio": "^5.0.0",' }],
  },
  {
    name: 'person_by_account_only',
    why: 'a person is looked up by account and id, not by the garage in the path',
    suite: ALERTS,
    red: ['YOUR GARAGE ONLY, within the account'],
    edits: [{ file: 'src/alerts.js', from: "    'SELECT * FROM alert_contacts WHERE tenant_id = $1 AND garage_id = $2 AND id = $3 FOR UPDATE',", to: "    'SELECT * FROM alert_contacts WHERE tenant_id = $1 AND $2::uuid IS NOT NULL AND id = $3 FOR UPDATE'," }],
  },
  {
    name: 'ascii_digits_only',
    why: 'only 0-9 count as digits in the line guard',
    suite: ALERTS,
    red: ['the guard itself'],
    edits: [{ file: 'src/digits.js', from: '  for (const zero of DIGIT_ZEROS) if (cp >= zero && cp <= zero + 9) return cp - zero;', to: '  for (const zero of [0x30]) if (cp >= zero && cp <= zero + 9) return cp - zero;' }],
  },
  {
    name: 'scan_keeps_separators',
    why: "the log scan reads a number with what stands between its digits",
    suite: ALERTS,
    red: ['THE SCAN finds what was typed'],
    edits: [{ file: ALERTS, from: "    const digits = scanDigits(text.replace(UUIDS, ' ').replace(TIMES, ' '));", to: "    const digits = text.replace(UUIDS, ' ').replace(TIMES, ' ').normalize('NFKC').replace(/[\\s().+-]/g, '');" }],
  },
  {
    name: 'scan_raw_text_off',
    why: 'the log scan does not read text as it was typed',
    suite: ALERTS,
    red: ['THE SCAN finds what was typed'],
    edits: [{ file: ALERTS, from: '    for (const t of wanted) if (text.includes(t) || text.normalize(\'NFKC\').includes(t)) found.add(t);', to: '' }],
  },
  {
    name: 'scan_decimal_only',
    why: 'the log scan reads only decimal digits',
    suite: ALERTS,
    red: ['THE SCAN finds what was typed'],
    edits: [{ file: ALERTS, from: '  if (OTHER_DIGITS.has(ch)) return OTHER_DIGITS.get(ch);', to: '' }],
  },
];

const SCHEMA_BREAKS = [
  {
    name: 'contacts_bound_dropped',
    why: 'the database takes a 26th person',
    suite: ALERTS,
    red: ['BOUNDS'],
    edits: [{ file: '0029_alert_contacts.sql', from: '    IF v_people >= 25 THEN', to: '    IF false THEN' }],
  },
  {
    name: 'name_bound_dropped',
    why: 'the database takes an over-long name',
    suite: ALERTS,
    red: ['BOUNDS'],
    edits: [{ file: '0029_alert_contacts.sql', from: '    length(name) BETWEEN 1 AND 80\n    AND name = btrim(name)', to: '    name = btrim(name)' }],
  },
  {
    name: 'other_garage_taken',
    why: "the database takes a person on another account's garage",
    suite: ALERTS,
    red: ['YOUR GARAGE ONLY'],
    edits: [{ file: '0029_alert_contacts.sql', from: '    IF NOT EXISTS (SELECT 1 FROM garages WHERE id = NEW.garage_id AND tenant_id = NEW.tenant_id) THEN', to: '    IF false THEN' }],
  },
  {
    name: 'person_named_in_database',
    why: 'the database takes a name on a line about a person',
    suite: ALERTS,
    red: ['the guard itself'],
    edits: [{ file: '0029_alert_contacts.sql', from: "ALTER TABLE garage_changes ADD CONSTRAINT garage_changes_person_unnamed\n  CHECK (subject_kind <> 'alert_contact' OR subject_name IS NULL);", to: '' }],
  },
  {
    name: 'policy_dropped',
    why: "a garage's people are readable by every account",
    suite: ISOLATION,
    red: ['alert_contacts: a tenant reads only its own rows'],
    edits: [{ file: '0029_alert_contacts.sql', from: "CREATE POLICY alert_contacts_tenant_isolation ON alert_contacts\n  USING      (tenant_id = current_tenant_id())", to: "CREATE POLICY alert_contacts_tenant_isolation ON alert_contacts\n  USING      (true)" }],
  },
];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-alerts-control-'));
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

const required = (name) => process.env[name] || (console.error(`${name} is required`), process.exit(1));
const adminUrl = required('DATABASE_URL');
const appPassword = required('APP_DB_PASSWORD');
const scratchAdmin = new URL(adminUrl);
scratchAdmin.pathname = `/${SCRATCH}`;
const scratchApp = new URL(`postgres://openparking_app@${new URL(adminUrl).host}/${SCRATCH}`);
scratchApp.password = appPassword;
const maintenance = new URL(adminUrl);
maintenance.pathname = '/postgres';
const scratchEnv = { DATABASE_URL: scratchAdmin.toString(), APP_DATABASE_URL: scratchApp.toString() };

async function withAdmin(fn) {
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A scratch database from the migrations, with the break's edits made to a copy of them. */
async function buildScratch(dir, edits) {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
    await c.query(`CREATE DATABASE ${pg.escapeIdentifier(SCRATCH)}`);
  });
  const partial = mkdtempSync(join(tmpdir(), 'openparking-alerts-migrations-'));
  try {
    for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
    const missing = plant(partial, edits);
    if (missing) return missing;
    for (const [script, extra] of [['scripts/migrate.js', { MIGRATIONS_DIR: partial }], ['scripts/ensure-app-role.js', {}]]) {
      const r = spawnSync(process.execPath, [script], { cwd: dir, env: { ...process.env, ...scratchEnv, ...extra }, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${script} failed against the scratch database:\n${r.stdout}${r.stderr}`);
    }
    return null;
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

let failures = 0;

console.log('== control A: each suite must PASS intact ==');
for (const suite of [ALERTS, LOG, ISOLATION]) {
  const dir = stage();
  try {
    const intact = run(dir, suite);
    if (intact.status === 0) console.log(`  ${suite.padEnd(26)} OK — ${summarise(intact)}`);
    else {
      console.error(`  CONTROL A FAILED — ${suite} does not pass intact: ${summarise(intact)}\n${intact.stdout}\n${intact.stderr}`);
      failures += 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function judge(brk, broken) {
  const red = redTests(broken);
  const named = brk.red.every((want) => red.some((t) => t.includes(want))) && (!brk.says || broken.stdout.includes(brk.says));
  if (broken.status === 0) {
    console.error(`  ${brk.name.padEnd(26)} *** PASSED WHEN ${brk.why.toUpperCase()} — the suite is not measuring this ***`);
    failures += 1;
  } else if (!named) {
    console.error(`  ${brk.name.padEnd(26)} *** RED, BUT NOT IN "${brk.red.join('", "')}"${brk.says ? ` SAYING "${brk.says}"` : ''} — red: ${red.join(' | ')} ***`);
    failures += 1;
  } else {
    console.log(`  ${brk.name.padEnd(26)} fails as required when ${brk.why} — ${summarise(broken)}; named: ${brk.red.join(', ')}`);
  }
}

console.log('\n== control B: each source break must make its suite FAIL, in the test that names it ==');
for (const brk of SOURCE_BREAKS) {
  const dir = stage();
  try {
    const missing = plant(dir, brk.edits);
    if (missing) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing} ***`);
      failures += 1;
      continue;
    }
    if (brk.scratch) await buildScratch(dir, []);
    judge(brk, run(dir, brk.suite, brk.scratch ? scratchEnv : {}));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== control C: each schema break must make its suite FAIL, in the test that names it ==');
for (const brk of SCHEMA_BREAKS) {
  const dir = stage();
  try {
    const missing = await buildScratch(dir, brk.edits);
    if (missing) {
      console.error(`  ${brk.name.padEnd(26)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${missing} ***`);
      failures += 1;
      continue;
    }
    judge(brk, run(dir, brk.suite, scratchEnv));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A database with a property removed is dropped, so nothing later runs against it by accident.
await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`));

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust this round's alerts tests.`);
  process.exit(1);
}
console.log(`\nall controls OK — the suites fail, by name, on every one of the ${SOURCE_BREAKS.length + SCHEMA_BREAKS.length} properties U4b rests on.`);
