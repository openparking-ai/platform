/**
 * Whether `text` holds `secret` in any of the ways it could be written out:
 * as it is, JSON-escaped, or URL-encoded. Shared by the sign-in suite (every
 * response body) and its output check (everything the suite printed).
 */
export function holdsSecret(text, secret) {
  return text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)) || text.includes(encodeURIComponent(secret));
}
