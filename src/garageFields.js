/**
 * What a new garage's name, time zone and money must be (POST /garages), each
 * refused in one plain sentence by name -- never left to the database, whose
 * refusal was a bare 500 ("usd"), nor taken because nothing looked ("XYZ",
 * "Mars/Olympus" and a name that was a number were each stored with a 201).
 *
 * Each is frozen onto the garage's stays and money once made, so a wrong one
 * is not a thing to find out later.
 */
import { HttpError } from './errors.js';
import { isCurrency } from './currencies.js';

//: The most a garage's name may be: what the column allows (0032), and what
//: the admin screen's form takes.
export const GARAGE_NAME_MAX = 100;

const bad = (message, code) => new HttpError(400, message, code);

/** The name, as sent: text of 1 to GARAGE_NAME_MAX characters, not only spaces. */
export function garageName(raw) {
  if (typeof raw !== 'string' || raw.trim() === '' || [...raw].length > GARAGE_NAME_MAX) {
    throw bad(`name must be text of 1 to ${GARAGE_NAME_MAX} characters`, 'garage_name_refused');
  }
  return raw;
}

/** The currency: a code of the list, written as the list writes it. */
export function garageCurrency(raw) {
  if (isCurrency(raw)) return raw;
  if (typeof raw === 'string' && isCurrency(raw.toUpperCase())) {
    throw bad(`currency is written in capital letters: "${raw.toUpperCase()}"`, 'garage_currency_refused');
  }
  throw bad('currency must be an ISO 4217 currency code in use today, such as "USD"', 'garage_currency_refused');
}

/**
 * The time zone: a name this database knows (`pg_timezone_names`), exactly as
 * it spells it. The database is asked, not a list kept here: it is what turns
 * the name into a local time for every stay.
 */
export async function garageTimezone(db, raw) {
  if (typeof raw === 'string' && raw.length <= 64) {
    const { rows } = await db.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [raw]);
    if (rows.length === 1) return raw;
  }
  throw bad('timezone must be a time zone name this platform knows, such as "America/New_York"', 'garage_timezone_refused');
}
