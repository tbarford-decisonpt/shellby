const { test } = require('node:test');
const assert = require('node:assert/strict');
const { board, settle, ordinal } = require('../src/main/board');

const month = (key, jars, extra = {}) => ({ key, jars, shinies: 0, habitats: {}, ...extra });
const friend = (login, m) => ({ login, bugdex: { caught: [], badges: 0, hall: false, month: m } });

test('you and friends, ranked by this month\'s jars, medals for the top three', () => {
  const b = board({
    me: { login: 'me', month: month('2026-10', 5) },
    friends: [friend('ana', month('2026-10', 9)), friend('bo', month('2026-10', 5)), friend('cy', month('2026-10', 1)), friend('di', month('2026-10', 0))],
    key: '2026-10',
  });
  assert.equal(b.month, 'October');
  assert.deepEqual(b.rows.all.map(r => [r.login, r.place, r.medal]), [['ana', 1, '🥇'], ['me', 2, '🥈'], ['bo', 2, '🥈'], ['cy', 4, null], ['di', 5, null]]);
  assert.equal(b.mine.all, 2);
});

test('a card from last month counts as nothing', () => {
  const b = board({ me: { login: 'me', month: month('2026-10', 1) }, friends: [friend('ana', month('2026-09', 40))], key: '2026-10' });
  assert.deepEqual(b.rows.all.map(r => [r.login, r.value]), [['me', 1], ['ana', 0]]);
});

test('a tab for each habitat anyone caught in, and one for sparklies', () => {
  const b = board({
    me: { login: 'me', month: month('2026-10', 2, { habitats: { nets: 2 } }) },
    friends: [friend('ana', month('2026-10', 3, { habitats: { nets: 1, wreck: 2 }, shinies: 1 }))],
    key: '2026-10',
  });
  assert.deepEqual(b.tabs.map(t => t.id), ['all', 'nets', 'wreck', 'sparkles']);
  assert.deepEqual(b.rows.nets.map(r => r.login), ['me', 'ana']);
  assert.equal(b.rows.sparkles[0].login, 'ana');
});

test('friends who don\'t share their Bugdex, or a card that names you, aren\'t on it', () => {
  const b = board({ me: { login: 'Me', month: null }, friends: [{ login: 'ana', bugdex: null }, friend('me', month('2026-10', 99)), friend('<x>', month('2026-10', 3))], key: '2026-10' });
  assert.deepEqual(b.rows.all.map(r => r.login), ['Me']);
  assert.equal(board({ key: 'nope' }), null);
});

test('the month\'s result is noticed once the month moves on, with someone to beat', () => {
  const oct = board({ me: { login: 'me', month: month('2026-10', 4) }, friends: [friend('ana', month('2026-10', 2))], key: '2026-10' });
  let r = settle(null, oct);
  assert.equal(r.ended, null);
  const nov = board({ me: { login: 'me', month: null }, friends: [friend('ana', month('2026-10', 2))], key: '2026-11' });
  r = settle(r.state, nov);
  assert.deepEqual(r.ended, { key: '2026-10', month: 'October', place: 1, of: 2 });
  assert.equal(settle(r.state, nov).ended, null, 'once');
  const alone = settle({ key: '2026-09', place: 1, of: 1, jars: 3 }, oct);
  assert.equal(alone.ended, null, 'first of one is no race');
});

test('ordinals', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
});
