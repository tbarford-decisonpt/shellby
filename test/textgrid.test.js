// Drawings in box characters (src/renderer/shared/textgrid.js): which code
// blocks are drawings, and the columns each character takes on the grid.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/renderer/shared/textgrid');

const BOX = [
  '┌─ Where he\'s been ──── ⤢ ✕ ┐',
  '│ feed.js   ◂ 🦀📖 reading │',
  '└──────────────────────────┘',
].join('\n');

test('a box drawn in an unlabelled or text fence is a drawing', () => {
  assert.equal(G.isDrawing(BOX, ''), true);
  assert.equal(G.isDrawing(BOX, 'text'), true);
  assert.equal(G.isDrawing(BOX, ' TXT '), true);
  assert.equal(G.isDrawing(BOX, undefined), true);
});

test('code, a single rule, or a huge block is not a drawing', () => {
  assert.equal(G.isDrawing(BOX, 'js'), false, 'a fence that names a language stays code');
  assert.equal(G.isDrawing('Title\n────────\nbody', ''), false, 'one box line is a rule, not a drawing');
  assert.equal(G.isDrawing('plain words\nno boxes', ''), false);
  assert.equal(G.isDrawing(`${BOX}\n${'x'.repeat(50000)}`, ''), false);
});

test('a terminal gives an emoji or a CJK character two columns, a combining mark none', () => {
  assert.equal(G.width('🦀'), 2);
  assert.equal(G.width('❤️'), 2, 'a symbol with the emoji selector is drawn as an emoji');
  assert.equal(G.width('漢'), 2);
  assert.equal(G.width('✦'), 1);
  assert.equal(G.width('◂'), 1);
  assert.equal(G.width('́'), 0);
});

test('a line keeps ASCII and box runs whole and puts every other character in its own cell', () => {
  assert.deepEqual(G.cells('│ a ◂ 🦀📖 b │'), [
    { s: '│ a ' }, { s: '◂', w: 1 }, { s: ' ' }, { s: '🦀', w: 2 }, { s: '📖', w: 2 }, { s: ' b │' },
  ]);
  // An emoji built from several code points is one cell.
  assert.deepEqual(G.cells('x👩‍💻y'), [{ s: 'x' }, { s: '👩‍💻', w: 2 }, { s: 'y' }]);
  assert.deepEqual(G.cells(''), []);
});

test('the cells give back exactly the line they came from', () => {
  for (const line of BOX.split('\n')) assert.equal(G.cells(line).map(c => c.s).join(''), line);
});
