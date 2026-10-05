/**
 * The operator and lane surfaces' refusal: a status, a sentence, and -- for
 * the refusals that carry one -- a machine-readable `code`. Its own module so
 * the route files beside src/app.js raise the same class the error handler
 * there recognises.
 */
export class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    // A MACHINE-READABLE name for the refusal, published beside the message.
    // Null for the statuses that do not carry one; see `conflict` in src/app.js.
    this.code = code;
    // Structured detail beside the message, published only when set and only
    // with a code. The plan store attaches the engine's findings here: a list
    // an operator works through is data, not a sentence.
    this.details = null;
  }
}
