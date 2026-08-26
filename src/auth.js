/**
 * Lane device credentials.
 *
 * The token is shown once, at registration, and never stored -- only its
 * SHA-256. A leaked database gives an attacker hashes, not working lane
 * credentials.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function generateDeviceToken() {
  // 32 bytes, url-safe. Prefixed so a leaked token is greppable and obvious.
  return `opl_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time compare, for anywhere two hashes are compared in JS. */
export function hashesEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extracts the bearer token from an Authorization header, or null. */
export function bearerFrom(header) {
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
