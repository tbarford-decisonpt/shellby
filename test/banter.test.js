const { test } = require('node:test');
const assert = require('node:assert/strict');
const b = require('../src/main/banter');

const T = b.TEMPERAMENTS;
const rands = [0, 0.3, 0.6, 0.99];

test('every pair has a hello, and every line fits the bubble', () => {
  for (const me of T) {
    for (const them of T) {
      assert.ok(b.HELLO[`${me}:${them}`], `${me} meeting ${them}`);
      for (const r of rands) {
        for (const phase of ['hello', 'chat', 'bye']) {
          const lines = b.conversation(phase, { me, them }, { myFind: 'Black pearl', theirFind: 'Mermaid\'s comb', music: true, hour: 23, seasons: ['halloween'], myStickers: 9, theirStickers: 1 }, () => r);
          assert.ok(lines.length >= 2, `${phase} for ${me}/${them}`);
          for (const l of lines) {
            assert.ok(l.who === 'me' || l.who === 'them');
            assert.ok(l.text.length <= b.MAX_LINE, `"${l.text}"`);
          }
        }
      }
    }
  }
});

test('a first visit gets its own welcome; goodbye has both of them', () => {
  const hello = b.conversation('hello', { me: 'cocky', them: 'fussy' }, { firstVisit: true }, () => 0);
  assert.deepEqual(hello.map(l => l.text), ['welcome!', 'nice desk!']);
  const bye = b.conversation('bye', { me: 'sleepy', them: 'chipper' }, {}, () => 0);
  assert.deepEqual(bye.map(l => l.who), ['them', 'me']);
});

test('they talk about what is actually there', () => {
  const stickers = b.conversation('chat', { me: 'chipper', them: 'chipper' }, { theirStickers: 10, myStickers: 0 }, () => 0);
  assert.equal(stickers[0].text, 'so many stickers!');
  const find = b.conversation('chat', { me: 'chipper', them: 'chipper' }, { myFind: 'Pearl' }, () => 0);
  assert.deepEqual(find.map(l => l.text), ['look what I found', 'ooh, pearl!', 'mine though']);
  const long = b.conversation('chat', { me: 'chipper', them: 'chipper' }, { myFind: 'An extremely long find name' }, () => 0);
  assert.equal(long[1].text, 'ooh, shiny!');
});

test('a visit does not repeat a topic, and runs out gracefully', () => {
  const used = [];
  for (let i = 0; i < 30; i++) {
    const lines = b.conversation('chat', { me: 'fussy', them: 'fussy' }, {}, () => 0, used);
    if (!lines.length) break;
    assert.ok(!used.includes(lines[0].text));
    used.push(lines[0].text);
  }
  assert.deepEqual(b.conversation('chat', { me: 'fussy', them: 'fussy' }, {}, () => 0, used), []);
});

test('an unknown temperament is treated as chipper', () => {
  assert.ok(b.conversation('hello', { me: 'grumpy', them: undefined }, {}, () => 0).length);
  assert.ok(b.lineMs('hi') < b.lineMs('a much longer line here'));
});
