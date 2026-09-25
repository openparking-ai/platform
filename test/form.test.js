/**
 * The nested form encoder Stripe's v1 API needs (src/form.js). Each rule is a
 * place an encoder goes quietly wrong, so each has its own case, and the
 * expected strings are written out whole rather than re-derived.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeForm } from '../src/form.js';

const decoded = (s) => decodeURIComponent(s);

test('flat parameters encode as key=value, in order', () => {
  assert.equal(decoded(encodeForm({ amount: 1000, currency: 'usd' })), 'amount=1000&currency=usd');
});

test('an object nests with brackets, to any depth', () => {
  assert.equal(
    decoded(encodeForm({ address: { line1: '1 Main St', country: 'US' }, a: { b: { c: 'd' } } })),
    'address[line1]=1 Main St&address[country]=US&a[b][c]=d',
  );
});

test('an array nests by index, and an array of objects stays unambiguous', () => {
  assert.equal(decoded(encodeForm({ payment_method_types: ['card_present'] })), 'payment_method_types[0]=card_present');
  assert.equal(
    decoded(encodeForm({ line_items: [{ amount: 300, description: 'Parking' }, { amount: -50, description: 'Validation' }] })),
    'line_items[0][amount]=300&line_items[0][description]=Parking&line_items[1][amount]=-50&line_items[1][description]=Validation',
  );
});

test('undefined is left out; null is an empty value (Stripe v1 unsets a field that way)', () => {
  assert.equal(decoded(encodeForm({ a: undefined, b: null, c: 'x' })), 'b=&c=x');
});

test('booleans are words, and reserved characters are escaped on the wire', () => {
  assert.equal(encodeForm({ flag: true, off: false }), 'flag=true&off=false');
  assert.equal(encodeForm({ label: "Alice's reader & co=1" }), "label=Alice's%20reader%20%26%20co%3D1");
  assert.equal(encodeForm({ a: { b: 'c' } }), 'a%5Bb%5D=c');
});

test('what has no honest encoding is refused, not guessed', () => {
  assert.throws(() => encodeForm({ at: new Date(0) }), /only plain objects/);
  assert.throws(() => encodeForm({ n: Number.NaN }), /not a finite number/);
  assert.throws(() => encodeForm({ big: 1n }), /bigint does not encode/);
  assert.throws(() => encodeForm(['x']), /object of named parameters/);
  assert.throws(() => encodeForm(null), /object of named parameters/);
});
