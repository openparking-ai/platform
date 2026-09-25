/**
 * The nested form encoding Stripe's v1 API takes.
 *
 * Stripe's v1 endpoints take `application/x-www-form-urlencoded` bodies, not
 * JSON, and nest with brackets: `address[line1]=...`,
 * `payment_method_types[0]=card_present`. This platform talks to Stripe with
 * plain `fetch` rather than an SDK (one dependency fewer in a public repo, and
 * the path is a handful of calls), so the encoding is ours and is tested on
 * its own (test/form.test.js).
 *
 * Rules, each one a place an encoder goes quietly wrong:
 *   - an object nests as key[child];
 *   - an array nests by index, key[0], key[1] -- Stripe accepts indexed and
 *     empty brackets alike, and an index keeps an array of objects
 *     unambiguous;
 *   - `undefined` is left out; `null` is sent as an empty value, which is how
 *     Stripe's v1 API is told to unset a field;
 *   - a boolean is `true`/`false`, a number its decimal form;
 *   - anything else -- a function, a symbol, a Date, a bigint -- is refused,
 *     because a guessed encoding of money is worse than an error.
 */
export function encodeForm(params) {
  const pairs = [];
  const walk = (prefix, value) => {
    if (value === undefined) return;
    if (value === null) {
      pairs.push([prefix, '']);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
      return;
    }
    switch (typeof value) {
      case 'object':
        if (Object.getPrototypeOf(value) !== Object.prototype) {
          throw new TypeError(`${prefix}: only plain objects, arrays, strings, numbers and booleans encode`);
        }
        for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}[${k}]` : k, v);
        return;
      case 'string':
        pairs.push([prefix, value]);
        return;
      case 'number':
        if (!Number.isFinite(value)) throw new TypeError(`${prefix}: ${value} is not a finite number`);
        pairs.push([prefix, String(value)]);
        return;
      case 'boolean':
        pairs.push([prefix, value ? 'true' : 'false']);
        return;
      default:
        throw new TypeError(`${prefix || 'the body'}: a ${typeof value} does not encode`);
    }
  };
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('the body is an object of named parameters');
  }
  walk('', params);
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}
