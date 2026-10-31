/**
 * Which open stay is the car at the exit (src/exitMatch.js), and what the
 * picker is sent (src/exitPicker.js). Pure: no database, no network.
 *
 * Each rule has a break in `scripts/exits-fail-control.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/exitMatch.js';
import { answerOf, requestBody, QUESTION, readPickerSettings } from '../src/exitPicker.js';

const RULE = m.PLATE_RULE;
const RED = 'opvid-colour/1:m:f000000000000000';
const RED2 = 'opvid-colour/1:m:e100000000000000';
const GREY = 'opvid-colour/1:m:000000000000f000';
const read = (pattern) => ({ state: 'read', rule: RULE, pattern });
let n = 0;
const stay = (fields) => ({ id: `s${(n += 1)}`, entry_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(), identity_kind: 'plate', plate: null, ...fields });
const withPlate = (pattern, more = {}) => stay({ entry_plate_state: 'read', entry_plate_rule: RULE, entry_plate_pattern: pattern, ...more });

test('folding makes the look-alikes one class, letters onto digits', () => {
  assert.equal(m.fold('obis-7x'), '0815' + '7X');
  assert.equal(m.fold('B8 S5 O0 I1'), '88550011');
});

test('one stay whose sure characters agree in their positions is the car', () => {
  const car = withPlate('7A8C1?3');
  const others = [withPlate('7A8C9?3'), withPlate('XY12345')];
  const got = m.match({ plate: read('7A8C123') }, [car, ...others]);
  assert.deepEqual([got.kind, got.stay], ['single', car.id]);
  assert.equal(got.excluded, 2, 'a differing sure character excludes the stay');
});

test('a whole plate an older lane read counts as every position sure, folded', () => {
  const car = stay({ plate: 'OBS7123' });
  const got = m.match({ plate: read('085712?') }, [car, withPlate('Z99Z99Z')]);
  assert.deepEqual([got.kind, got.stay], ['single', car.id]);
});

test('two sure characters pick a stay only with the colour or the size beside them', () => {
  const car = withPlate('AB?????', { entry_colour_code: RED });
  const lone = m.match({ plate: read('AB?????') }, [car]);
  assert.equal(lone.kind, 'few', 'two characters alone are not enough: the picker decides');
  const withColour = m.match({ plate: read('AB?????'), colour_code: RED2 }, [car]);
  assert.deepEqual([withColour.kind, withColour.stay], ['single', car.id]);
});

test('a winner must be clearly ahead; a close second sends both to the picker', () => {
  const a = withPlate('7A8C123');
  const b = withPlate('7A8C1?3');
  const got = m.match({ plate: read('7A8C1?3') }, [a, b]);
  assert.equal(got.kind, 'few');
  assert.deepEqual(new Set(got.candidates), new Set([a.id, b.id]));
});

test('a different colour, or a different size, excludes a stay; a colour that cannot be compared does not', () => {
  const red = withPlate('7A8C123', { entry_colour_code: RED });
  assert.equal(m.match({ plate: read('7A8C123'), colour_code: GREY }, [red]).kind, 'none');
  const small = withPlate('7A8C123', { entry_size: 'small' });
  assert.equal(m.match({ plate: read('7A8C123'), size: 'large' }, [small]).kind, 'none');
  const whole = withPlate('7A8C123', { entry_colour_code: 'opvid-colour/1:f:f000000000000000' });
  assert.equal(m.match({ plate: read('7A8C123'), colour_code: GREY }, [whole]).kind, 'single', 'a masked and a whole-frame code do not compare');
  assert.equal(m.colourDistance(RED, RED2) <= m.SAME_COLOUR_DISTANCE, true);
  assert.equal(m.colourDistance(RED, GREY) > m.SAME_COLOUR_DISTANCE, true);
});

test('an unreadable plate matches unreadable plates only, and never a not_seen against anything', () => {
  const unreadRed = stay({ identity_kind: 'unread', entry_plate_state: 'unreadable', entry_plate_rule: RULE, entry_colour_code: RED });
  const readRed = withPlate('7A8C123', { entry_colour_code: RED });
  const got = m.match({ plate: { state: 'unreadable', rule: RULE, pattern: null }, colour_code: RED }, [unreadRed, readRed]);
  assert.deepEqual([got.kind, got.stay], ['single', unreadRed.id], 'the read plate is excluded, the one unreadable red stay is the car');
  const unreadBare = stay({ identity_kind: 'unread' });
  assert.equal(m.stayPlateId(unreadBare).state, 'unreadable', 'an unread stay of 0036 is unreadable');
  const seen = m.match({ plate: { state: 'not_seen', rule: RULE, pattern: null } }, [readRed, unreadRed]);
  assert.equal(seen.kind, 'few', 'a dead camera says nothing about the plate: every stay stays a candidate');
});

test('plates of different lengths or rules say nothing either way', () => {
  const car = withPlate('7A8C12');
  assert.equal(m.match({ plate: read('7A8C123') }, [car]).kind, 'few');
  const other = stay({ entry_plate_state: 'read', entry_plate_rule: 'other-rule/2', entry_plate_pattern: '7A8C123' });
  assert.equal(m.match({ plate: read('7A8C123') }, [other]).kind, 'few');
});

test('nothing left is none; too many to show is none', () => {
  assert.equal(m.match({ plate: read('7A8C123') }, []).kind, 'none');
  const many = Array.from({ length: m.MAX_CANDIDATES + 1 }, () => stay({ identity_kind: 'unread' }));
  const got = m.match({ plate: { state: 'unreadable', rule: RULE, pattern: null } }, many);
  assert.equal(got.kind, 'none');
  assert.match(got.why, /too many/);
  const ten = many.slice(0, m.MAX_CANDIDATES);
  assert.equal(m.match({ plate: { state: 'unreadable', rule: RULE, pattern: null } }, ten).kind, 'few', 'control: ten are shown');
});

// --- the picker's request and answer ---------------------------------------

const pic = (id) => ({ id, content_type: 'image/jpeg', image: Buffer.from([0xff, 0xd8, 0xff, id.length]) });

test('the picker is sent pictures, numbers and the one question: never a plate, a colour or a time', () => {
  const body = requestBody('a-model', [pic('e1')], [
    { session_id: 's1', pictures: [pic('a1'), pic('a2')] },
    { session_id: 's2', pictures: [pic('b1')] },
  ]);
  const content = body.messages[0].content;
  const texts = content.filter((c) => c.type === 'text').map((c) => c.text);
  assert.deepEqual(texts, ['The car leaving:', 'Candidate 1:', 'Candidate 2:', QUESTION]);
  assert.equal(content.filter((c) => c.type === 'image').length, 4);
  const sent = JSON.stringify(body);
  assert.doesNotMatch(sent, /s1|s2|7A8C|opvid|entry_at|plate/i, 'no id, plate, colour code or time');
});

test('only one number in range is an answer; 0 is none', () => {
  const said = (text) => ({ content: [{ type: 'text', text }] });
  assert.equal(answerOf(said('2'), 3), 2);
  assert.equal(answerOf(said(' 0 '), 3), 0);
  assert.equal(answerOf(said('4'), 3), null, 'out of range');
  assert.equal(answerOf(said('Candidate 2'), 3), null, 'words are not an answer');
  assert.equal(answerOf(said('1 or 2'), 3), null);
  assert.equal(answerOf({ content: [{ type: 'thinking', thinking: '2' }, { type: 'text', text: '3' }] }, 3), 3, 'only the text is read');
});

test('the picker is off unless a key file is named, and refuses a relative one', () => {
  assert.equal(readPickerSettings({}).on, false);
  assert.throws(() => readPickerSettings({ EXIT_PICKER_KEY_FILE: 'key.txt' }), /absolute/);
  const on = readPickerSettings({ EXIT_PICKER_KEY_FILE: '/run/secrets/picker' });
  assert.equal(on.on, true);
  assert.equal(on.timeoutMs, 8000);
  assert.throws(() => readPickerSettings({ EXIT_PICKER_KEY_FILE: '/k', EXIT_PICKER_TIMEOUT_MS: '60000' }), /1000 to 30000/);
});
