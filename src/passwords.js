/**
 * The owner's password: node:crypto scrypt, no dependency.
 *
 * THE PARAMETERS ARE MEASURED, NOT CHOSEN. `npm run measure-scrypt` times one
 * hash over candidate cost factors on the machine it runs on and picks the
 * largest N under a 250 ms budget; the value below is what it printed, and the
 * receipt that shipped it names the machine. They are STORED beside every hash
 * (`scrypt$N=…,r=…,p=…,keylen=…$salt$hash`), and verification reads the row's,
 * not these: raising them later invalidates no row.
 *
 * A stored string in a format this code does not know is REFUSED BY NAME
 * (`PasswordHashUnrecognised`) -- never compared, so never a wrong password.
 * The comparison is constant-time. The one rule on a password is its length.
 *
 * Every scrypt run here is counted (`hashCount`), so a test can say how much
 * work a sign-in did without timing it.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

//: Measured 2026-10-01 by `npm run measure-scrypt` (Apple M5, macOS 25.6,
//: node 24.14): one hash at N=2**17 took 156.9 ms median, the largest
//: candidate under the 250 ms budget. r and p held at 8 and 1. 128*r*N bytes
//: (128 MiB) per hash; Node runs at most its thread pool's worth at once.
export const SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1, keylen: 64 });

//: Length only, no composition rules. Twelve because the lock is per caller
//: address, not account-wide (RE-BRIEF 1), so the password carries the weight.
export const MIN_PASSWORD_LENGTH = 12;
//: An upper bound so a sign-in body cannot ask for unbounded work.
export const MAX_PASSWORD_LENGTH = 1024;

//: The most this code will ever ask scrypt to spend on one stored string. A
//: row naming more is not a format this code knows.
const MAX_N = 2 ** 20;

/** A stored password hash this code does not know how to check. */
export class PasswordHashUnrecognised extends Error {
  constructor() {
    super('the stored password hash is in a format this platform does not know; it was not compared');
  }
}

let hashes = 0;
/** How many scrypt hashes this process has run. */
export const hashCount = () => hashes;

function scrypt(password, salt, { N, r, p, keylen }) {
  hashes += 1;
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, { N, r, p, maxmem: 128 * r * N * 2 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Length in code points, the way a person counts what they typed. */
export const passwordLength = (password) => [...password].length;

/** The length rule, as the one sentence a refusal gives. Null when it holds. */
export function passwordRuleBroken(password) {
  if (typeof password !== 'string') return 'a password is text';
  const length = passwordLength(password);
  if (length < MIN_PASSWORD_LENGTH) return `a password is at least ${MIN_PASSWORD_LENGTH} characters`;
  if (length > MAX_PASSWORD_LENGTH) return `a password is at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

/** Hash a password under the stated parameters, the parameters written into the result. */
export async function hashPassword(password, parameters = SCRYPT) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, parameters);
  const { N, r, p, keylen } = parameters;
  return `scrypt$N=${N},r=${r},p=${p},keylen=${keylen}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const FORMAT = /^scrypt\$N=(\d+),r=(\d+),p=(\d+),keylen=(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

/** The parameters, salt and key a stored string names. Throws `PasswordHashUnrecognised`. */
export function parseStored(stored) {
  const m = typeof stored === 'string' ? FORMAT.exec(stored) : null;
  if (!m) throw new PasswordHashUnrecognised();
  const [N, r, p, keylen] = m.slice(1, 5).map(Number);
  const salt = Buffer.from(m[5], 'base64');
  const key = Buffer.from(m[6], 'base64');
  const sane = N >= 2 && N <= MAX_N && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && p >= 1 && p <= 16
    && keylen >= 16 && keylen <= 128 && key.length === keylen && salt.length >= 16;
  if (!sane) throw new PasswordHashUnrecognised();
  return { parameters: { N, r, p, keylen }, salt, key };
}

/**
 * Whether `password` is the one `stored` was made from. One scrypt run, under
 * the row's own parameters, compared in constant time. Throws
 * `PasswordHashUnrecognised` before any hash is run when the row is not one
 * this code knows.
 */
export async function verifyPassword(password, stored) {
  const { parameters, salt, key } = parseStored(stored);
  const derived = await scrypt(password, salt, parameters);
  return timingSafeEqual(derived, key);
}

/**
 * A hash of nothing anyone knows, under the current parameters, made once per
 * process. An unknown email is checked against it, so it costs the same one
 * hash a known one does.
 */
let dummy = null;
export function dummyHash() {
  dummy ??= hashPassword(randomBytes(32).toString('base64'));
  return dummy;
}
