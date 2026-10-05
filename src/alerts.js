/**
 * ALERTS (U4b): who gets which alert, and how -- set per garage by the owner.
 *
 * THE LIST of alerts is HERE and nowhere else: the setup read, the alerts
 * read and every check read it from this file, and the admin reads it from
 * the alerts read. Adding an alert later is one entry below (and its words
 * in the admin's dictionaries).
 *
 * The people are contacts, not accounts: a name, a phone number and/or an
 * email address, and a language. They never sign in. For each alert each
 * person gets it by text, by email, both or neither.
 *
 * NOTHING IS SENT HERE. There is no provider, no key and no network call in
 * this file: sending is the alert module's, which also decides how each
 * alert is detected. Until it lands, nobody is confirmed (0029 holds it so).
 *
 * A PERSON'S DETAILS NEVER ENTER A LOG. A change-log line names the person
 * and says what changed ("phone number changed", "by text: Card payments
 * stopped"); the number and the address themselves are never in it. Every
 * value the request or the row holds is handed to the line's guard
 * (`ctx.private`, src/changes.js), which refuses -- by throwing, so the
 * change rolls back -- a line that holds one. A database refusal is passed on
 * without its detail, which would quote the row.
 */
import { HttpError } from './errors.js';
import * as changes from './changes.js';
import { quietMinutes } from './setup.js';
import { digitsOf, NAME_DIGITS_MAX } from './digits.js';

/**
 * The alerts, in the order the owner reads them. `needs`: what each alert's
 * description depends on, read from the platform at the time of the read,
 * never a copy: `quiet_minutes` is the U4 quiet setting.
 */
export const ALERTS = Object.freeze([
  Object.freeze({ key: 'lane_problem', needs: Object.freeze([]) }),
  Object.freeze({ key: 'lane_not_answering', needs: Object.freeze(['quiet_minutes']) }),
  Object.freeze({ key: 'garage_not_answering', needs: Object.freeze([]) }),
  Object.freeze({ key: 'card_payments_stopped', needs: Object.freeze([]) }),
  Object.freeze({ key: 'attendant_link_dropped', needs: Object.freeze([]) }),
]);

export const ALERT_KEYS = Object.freeze(ALERTS.map((a) => a.key));

export const MAX_CONTACTS = 25;
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const LANGUAGES = Object.freeze(['en', 'es']);

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// Anything that is not a plain space between visible characters.
const ODD_SPACE = /[\p{Z}\s]/u;

const bad = (message, code, details) => Object.assign(new HttpError(400, message, code), details ? { details } : {});
const conflict = (code, message, details) => Object.assign(new HttpError(409, message, code), details ? { details } : {});

/**
 * A person's name: a lane name's rule, and never a phone number or an email
 * address. A name is written into the change log, which can only be added
 * to, so a number must not get through however it is written: 7 or more
 * digits of any script in all, whatever stands between them, are refused, and
 * so is an `@` of any width (src/digits.js; 0029 holds the same).
 */
export function nameField(raw) {
  const rule = `name must be text of 1 to ${NAME_MAX} characters, with no control or invisible formatting characters, and no phone number or email address in it`;
  if (typeof raw !== 'string') throw bad(rule, 'alert_contact_name_refused', { reason: 'not_text' });
  const name = raw.trim();
  if (name === '' || name.length > NAME_MAX || CONTROL.test(name)) throw bad(rule, 'alert_contact_name_refused', { reason: 'shape' });
  if (name.normalize('NFKC').includes('@')) throw bad(rule, 'alert_contact_name_refused', { reason: 'at' });
  if (digitsOf(name).length > NAME_DIGITS_MAX) {
    throw bad(`name holds ${NAME_DIGITS_MAX + 1} or more digits, which could be a phone number; ${rule}`, 'alert_contact_name_refused', { reason: 'digits' });
  }
  return name;
}

/**
 * A phone number as it is kept: `+` and 8 to 15 digits. Spaces, dashes,
 * dots and brackets between the digits are dropped. With no `+`, it is a US
 * number: 10 digits, or 11 starting with 1, kept as +1 and the 10. Anything
 * else is refused, saying why -- never quoting what was sent.
 */
export function phoneField(raw) {
  const refuse = (why, reason) => {
    throw bad(`phone ${why}. A US number is 10 digits, or 11 starting with 1; any other starts with + and holds 8 to 15 digits`, 'alert_contact_phone_refused', { reason });
  };
  if (typeof raw !== 'string') refuse('must be text', 'not_text');
  const typed = raw.trim();
  if (typed === '') refuse('is empty', 'empty');
  if (CONTROL.test(typed)) refuse('holds an invisible character', 'invisible');
  if (/\p{L}/u.test(typed)) refuse('holds letters', 'letters');
  if (!/^\+?[0-9 ().-]+$/.test(typed)) refuse('holds a character a phone number does not have', 'character');
  const digits = typed.replace(/[^0-9]/g, '');
  if (typed.startsWith('+')) {
    if (digits.length < 8) refuse('is too short', 'too_short');
    if (digits.length > 15) refuse('is too long', 'too_long');
    return `+${digits}`;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length < 10) refuse('is too short for a US number, and has no + for another country', 'too_short');
  refuse('is not a US number, and has no + for another country', 'not_us');
  return null;
}

/** An email address as it is kept: trimmed, one `@`, no space or invisible character, at most 254 characters. */
export function emailField(raw) {
  const refuse = (why, reason) => {
    throw bad(`email ${why}. An email address has one @, no spaces and at most ${EMAIL_MAX} characters`, 'alert_contact_email_refused', { reason });
  };
  if (typeof raw !== 'string') refuse('must be text', 'not_text');
  const email = raw.trim();
  if (email === '') refuse('is empty', 'empty');
  if (CONTROL.test(email)) refuse('holds an invisible character', 'invisible');
  if (ODD_SPACE.test(email)) refuse('holds a space', 'space');
  if (email.length > EMAIL_MAX) refuse('is too long', 'too_long');
  const parts = email.split('@');
  if (parts.length !== 2) refuse(parts.length < 2 ? 'has no @' : 'has more than one @', parts.length < 2 ? 'no_at' : 'two_at');
  if (parts[0] === '' || parts[1] === '') refuse('needs something before and after the @', 'empty_side');
  return email;
}

function languageField(raw) {
  if (!LANGUAGES.includes(raw)) throw bad(`language must be one of ${LANGUAGES.join(', ')}`, 'alert_contact_language_refused');
  return raw;
}

/** Alert keys from a request: known, each once, put in the list's order. */
function choiceField(raw, name) {
  if (!Array.isArray(raw) || raw.some((k) => typeof k !== 'string')) {
    throw bad(`${name} must be a list of alerts: ${ALERT_KEYS.join(', ')}`, 'alert_choice_refused');
  }
  const unknown = raw.filter((k) => !ALERT_KEYS.includes(k));
  if (unknown.length) throw bad(`${name} names an alert there is none of; the alerts are ${ALERT_KEYS.join(', ')}`, 'alert_choice_refused');
  if (new Set(raw).size !== raw.length) throw bad(`${name} names an alert twice`, 'alert_choice_refused');
  return ALERT_KEYS.filter((k) => raw.includes(k));
}

function onlyKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad(`the body is JSON: {${keys.join(', ')}}`);
  for (const key of Object.keys(body)) {
    if (!keys.includes(key)) throw bad(`unknown field ${JSON.stringify(key)}; the body is {${keys.join(', ')}}`);
  }
}

/** A database refusal, passed on as what it is and nothing more: its detail would quote the row. */
function scrubbed(err) {
  if (err instanceof HttpError) return err;
  if (err?.code === '23514' && String(err.message).startsWith('alert_contacts_full')) {
    return conflict('alert_contacts_full', `a garage has at most ${MAX_CONTACTS} people to tell`);
  }
  const plain = new Error(`an alert contact could not be written (${err?.code ?? err?.name ?? 'error'}${err?.constraint ? `: ${err.constraint}` : ''})`);
  plain.code = err?.code;
  return plain;
}

/** The fields of a row the owner's screens read. */
const present = (row) => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  email: row.email,
  language: row.language,
  confirmed: row.confirmed,
  by_text: ALERT_KEYS.filter((k) => row.by_text.includes(k)),
  by_email: ALERT_KEYS.filter((k) => row.by_email.includes(k)),
});

/** What a line may say about a person's phone or email: whether there is one, never what it is. */
const kept = (value) => (value === null ? 'none' : 'given');

/** Every value a line about this person must never hold, as typed and as kept. */
function guard(ctx, ...values) {
  ctx.private = ctx.private ?? [];
  for (const v of values) {
    if (typeof v !== 'string' || v.trim() === '') continue;
    ctx.private.push(v, v.trim());
    const digits = digitsOf(v);
    if (digits.length >= 7) ctx.private.push(digits, digits.slice(-10), `+${digits}`);
  }
}

const subjectOf = (row) => ({ kind: 'alert_contact', id: row.id, name: row.name });

const lockGarage = (client, garageId) =>
  client.query("SELECT pg_advisory_xact_lock(hashtextextended('alert-contacts|' || $1::text, 0))", [garageId]);

async function lockedContact(client, tenantId, garageId, contactId) {
  const { rows } = await client.query(
    'SELECT * FROM alert_contacts WHERE tenant_id = $1 AND garage_id = $2 AND id = $3 FOR UPDATE',
    [tenantId, garageId, contactId],
  );
  if (!rows[0]) throw new HttpError(404, 'alert contact not found', 'alert_contact_not_found');
  return rows[0];
}

/** The alerts and the garage's people, as the owner's screens read them. */
export async function read(client, tenantId, garageId) {
  const { rows } = await client.query(
    'SELECT * FROM alert_contacts WHERE tenant_id = $1 AND garage_id = $2 ORDER BY created_at, id',
    [tenantId, garageId],
  );
  return {
    alerts: ALERTS.map((a) => ({ key: a.key, needs: [...a.needs] })),
    quiet_minutes: quietMinutes(),
    max_contacts: MAX_CONTACTS,
    sending: false,
    contacts: rows.map(present),
  };
}

/** Who gets each alert, by text and by email: for the setup read. */
export async function coverage(client, tenantId, garageId) {
  const { rows } = await client.query(
    'SELECT by_text, by_email FROM alert_contacts WHERE tenant_id = $1 AND garage_id = $2',
    [tenantId, garageId],
  );
  return {
    people: rows.length,
    alerts: ALERT_KEYS.map((key) => ({
      key,
      by_text: rows.filter((r) => r.by_text.includes(key)).length,
      by_email: rows.filter((r) => r.by_email.includes(key)).length,
    })),
  };
}

export async function add(client, tenantId, garageId, body, ctx) {
  onlyKeys(body, ['name', 'phone', 'email', 'language']);
  guard(ctx, body.phone, body.email);
  const name = nameField(body.name);
  const phone = body.phone === undefined || body.phone === null ? null : phoneField(body.phone);
  const email = body.email === undefined || body.email === null ? null : emailField(body.email);
  const language = body.language === undefined ? 'en' : languageField(body.language);
  if (phone === null && email === null) throw bad('a person needs a phone number, an email address, or both', 'alert_contact_unreachable');
  guard(ctx, phone, email);
  try {
    await lockGarage(client, garageId);
    const { rows: [{ n }] } = await client.query(
      'SELECT count(*)::int AS n FROM alert_contacts WHERE tenant_id = $1 AND garage_id = $2',
      [tenantId, garageId],
    );
    if (n >= MAX_CONTACTS) throw conflict('alert_contacts_full', `a garage has at most ${MAX_CONTACTS} people to tell`, { max: MAX_CONTACTS });
    const { rows } = await client.query(
      `INSERT INTO alert_contacts (tenant_id, garage_id, name, phone, email, language)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tenantId, garageId, name, phone, email, language],
    );
    const row = rows[0];
    await changes.record(client, ctx, {
      garageId, action: 'alert_contact.add', subject: subjectOf(row),
      before: null, after: { name, language, phone: kept(phone), email: kept(email) },
    });
    return { contact: present(row) };
  } catch (err) {
    throw scrubbed(err);
  }
}

/**
 * Change a person: any of name, phone, email, language. `phone: null` or
 * `email: null` takes it away -- and with it every choice that needed it, in
 * the same change; the answer says which (`turned_off`).
 */
export async function change(client, tenantId, garageId, contactId, body, ctx) {
  onlyKeys(body, ['name', 'phone', 'email', 'language']);
  guard(ctx, body.phone, body.email);
  const next = {};
  if (body.name !== undefined) next.name = nameField(body.name);
  if (body.phone !== undefined) next.phone = body.phone === null ? null : phoneField(body.phone);
  if (body.email !== undefined) next.email = body.email === null ? null : emailField(body.email);
  if (body.language !== undefined) next.language = languageField(body.language);
  guard(ctx, next.phone, next.email);
  try {
    const row = await lockedContact(client, tenantId, garageId, contactId);
    guard(ctx, row.phone, row.email);
    const phone = 'phone' in next ? next.phone : row.phone;
    const email = 'email' in next ? next.email : row.email;
    if (phone === null && email === null) throw bad('a person needs a phone number, an email address, or both', 'alert_contact_unreachable');
    const byText = phone === null ? [] : row.by_text;
    const byEmail = email === null ? [] : row.by_email;
    const name = next.name ?? row.name;
    const language = next.language ?? row.language;

    const before = {};
    const after = {};
    if (name !== row.name) { before.name = row.name; after.name = name; }
    if (language !== row.language) { before.language = row.language; after.language = language; }
    if (phone !== row.phone) { before.phone = kept(row.phone); after.phone = row.phone !== null && phone !== null ? 'changed' : kept(phone); }
    if (email !== row.email) { before.email = kept(row.email); after.email = row.email !== null && email !== null ? 'changed' : kept(email); }
    const turnedOff = { by_text: row.by_text.length && !byText.length ? present(row).by_text : [], by_email: row.by_email.length && !byEmail.length ? present(row).by_email : [] };
    if (turnedOff.by_text.length) { before.by_text = present(row).by_text; after.by_text = []; }
    if (turnedOff.by_email.length) { before.by_email = present(row).by_email; after.by_email = []; }

    const { rows } = await client.query(
      `UPDATE alert_contacts SET name = $4, phone = $5, email = $6, language = $7, by_text = $8, by_email = $9
        WHERE tenant_id = $1 AND garage_id = $2 AND id = $3 RETURNING *`,
      [tenantId, garageId, contactId, name, phone, email, language, byText, byEmail],
    );
    await changes.record(client, ctx, { garageId, action: 'alert_contact.change', subject: subjectOf(rows[0]), before, after });
    return { contact: present(rows[0]), turned_off: turnedOff };
  } catch (err) {
    throw scrubbed(err);
  }
}

export async function remove(client, tenantId, garageId, contactId, ctx) {
  try {
    const row = await lockedContact(client, tenantId, garageId, contactId);
    guard(ctx, row.phone, row.email);
    await client.query('DELETE FROM alert_contacts WHERE tenant_id = $1 AND garage_id = $2 AND id = $3', [tenantId, garageId, contactId]);
    const p = present(row);
    await changes.record(client, ctx, {
      garageId, action: 'alert_contact.remove', subject: subjectOf(row),
      before: { name: row.name, language: row.language, phone: kept(row.phone), email: kept(row.email), by_text: p.by_text, by_email: p.by_email },
      after: null,
    });
    return p;
  } catch (err) {
    throw scrubbed(err);
  }
}

/**
 * Which alerts a person gets, by text and by email: the whole of both lists.
 * A text choice for a person with no phone, or an email choice for one with
 * no address, is refused by name, and nothing is changed.
 */
export async function setChoices(client, tenantId, garageId, contactId, body, ctx) {
  onlyKeys(body, ['by_text', 'by_email']);
  const byText = choiceField(body.by_text, 'by_text');
  const byEmail = choiceField(body.by_email, 'by_email');
  try {
    const row = await lockedContact(client, tenantId, garageId, contactId);
    guard(ctx, row.phone, row.email);
    if (byText.length && row.phone === null) {
      throw conflict('alert_text_needs_phone', 'this person has no phone number, so they cannot get an alert by text');
    }
    if (byEmail.length && row.email === null) {
      throw conflict('alert_email_needs_email', 'this person has no email address, so they cannot get an alert by email');
    }
    const was = present(row);
    const before = {};
    const after = {};
    if (was.by_text.join() !== byText.join()) { before.by_text = was.by_text; after.by_text = byText; }
    if (was.by_email.join() !== byEmail.join()) { before.by_email = was.by_email; after.by_email = byEmail; }
    const { rows } = await client.query(
      'UPDATE alert_contacts SET by_text = $4, by_email = $5 WHERE tenant_id = $1 AND garage_id = $2 AND id = $3 RETURNING *',
      [tenantId, garageId, contactId, byText, byEmail],
    );
    await changes.record(client, ctx, { garageId, action: 'alert_contact.choices', subject: subjectOf(rows[0]), before, after });
    return { contact: present(rows[0]) };
  } catch (err) {
    throw scrubbed(err);
  }
}
