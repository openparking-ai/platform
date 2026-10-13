/**
 * A request body's BYTES, judged as UTF-8 before anything decodes them.
 *
 * Express's JSON parser decodes lossily: a byte that is not UTF-8 becomes
 * U+FFFD, and the route is handed text the caller never sent -- stored, and
 * judged, as if they had. `verifyUtf8` is the parser's `verify` hook, which
 * the parser calls with the raw bytes BEFORE it decodes; a throw here fails
 * the read, and each parser's own refusal answers it, in its own sentence.
 *
 * One function, every JSON parser this platform has (the app's two and the
 * auth doors' three), so no door is left to be assumed.
 *
 * UTF-8 only, on purpose: a body that declares another charset is refused
 * too. The parser accepts `charset=utf-16`, and bytes that are valid UTF-8
 * can still decode as UTF-16 to a lone surrogate -- the same U+FFFD once
 * stored. Judging one encoding keeps the decision about encoding in one place.
 *
 * A U+FFFD the caller actually sent is valid UTF-8 and passes: it is their
 * text. This judges the encoding, never what the text says.
 */
const decoder = new TextDecoder('utf-8', { fatal: true });

/** `express.json({ verify })`: throws when the body is not UTF-8. `charset` is the one the parser would decode with. */
export function verifyUtf8(_req, _res, bytes, charset) {
  if (charset !== 'utf-8') throw new Error(`the body declares ${charset}, not utf-8`);
  decoder.decode(bytes);
}
