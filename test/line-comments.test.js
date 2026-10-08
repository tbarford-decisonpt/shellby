// Line comments on a turn's diff (src/renderer/panel/line-comments.js): numbering a
// diff's lines, anchoring a picked run of them, and writing the follow-up.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/renderer/panel/line-comments');

const PATCH = [
  'diff --git a/src/a.js b/src/a.js',
  'index 1111111..2222222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -10,4 +10,5 @@ function top() {',
  ' const a = 1;',
  '-let b = 2;',
  '+const b = 2;',
  '+const c = 3;',
  ' return a + b;',
  '@@ -40,2 +41,1 @@',
  '-old();',
  ' done();',
  '\\ No newline at end of file',
  '',
].join('\n');

const comment = (over = {}) => ({
  id: 'c1', file: 'src/a.js', root: 'C:\\repo', before: 'a'.repeat(40), after: 'b'.repeat(40),
  side: 'new', start: 11, end: 11, quote: ['+const b = 2;'], body: 'keep this let', at: Date.now(), ...over,
});

test('every line gets its number on each side it exists on, headers dropped', () => {
  const rows = R.numberLines(PATCH);
  assert.deepEqual(rows.map(r => [r.kind, r.old, r.new]), [
    ['hunk', null, null],
    ['ctx', 10, 10],
    ['del', 11, null],
    ['add', null, 11],
    ['add', null, 12],
    ['ctx', 12, 13],
    ['hunk', null, null],
    ['del', 40, null],
    ['ctx', 41, 41],
    ['meta', null, null],
  ]);
});

test('a hunk header without counts still numbers its lines', () => {
  const rows = R.numberLines('@@ -1 +1 @@\n-x\n+y\n');
  assert.deepEqual(rows.map(r => [r.kind, r.old, r.new]), [['hunk', null, null], ['del', 1, null], ['add', null, 1]]);
});

test('a removed "-- comment" or added "++ x" line is code, not a file header', () => {
  const rows = R.numberLines('--- a/q.sql\n+++ b/q.sql\n@@ -1,3 +1,3 @@\n--- old note\n+++ x\n select 1;\n');
  assert.deepEqual(rows.map(r => [r.kind, r.old, r.new]), [['hunk', null, null], ['del', 1, null], ['add', null, 1], ['ctx', 2, 2]]);
});

test('an anchor counts lines as the turn left the file, in either pick order', () => {
  const rows = R.numberLines(PATCH);
  const a = R.anchor(rows, 4, 1);
  assert.equal(a.side, 'new');
  assert.equal(a.start, 10);
  assert.equal(a.end, 12);
  assert.deepEqual(a.quote, [' const a = 1;', '-let b = 2;', '+const b = 2;', '+const c = 3;']);
});

test('only removed lines picked: numbered as the file was before', () => {
  const rows = R.numberLines(PATCH);
  assert.deepEqual(R.anchor(rows, 7, 7), { side: 'old', start: 40, end: 40, quote: ['-old();'] });
});

test('hunk headers and notes are nothing to comment on', () => {
  const rows = R.numberLines(PATCH);
  assert.equal(R.anchor(rows, 0, 0), null);
  assert.equal(R.anchor(rows, 9, 9), null);
});

test('a long pick is quoted with its middle left out', () => {
  const patch = '@@ -1,0 +1,20 @@\n' + Array.from({ length: 20 }, (_, i) => `+line ${i + 1}`).join('\n');
  const a = R.anchor(R.numberLines(patch), 1, 20);
  assert.equal(a.start, 1);
  assert.equal(a.end, 20);
  assert.equal(a.quote.length, 8);
  assert.equal(a.quote[6], '…');
  assert.equal(a.quote[7], '+line 20');
});

test('a stored comment finds its rows again, or says it no longer lines up', () => {
  const rows = R.numberLines(PATCH);
  assert.deepEqual(R.rowsFor(rows, comment({ start: 10, end: 12 })), { first: 1, last: 4 });
  assert.deepEqual(R.rowsFor(rows, comment({ side: 'old', start: 40, end: 40 })), { first: 7, last: 7 });
  assert.equal(R.rowsFor(rows, comment({ start: 99, end: 99 })), null);
});

test('the follow-up groups comments by file, in line order, with the code quoted', () => {
  const text = R.compose([
    comment({ id: 'b', start: 13, end: 13, quote: [' return a + b;'], body: 'and here' }),
    comment({ id: 'x', file: 'src/b.js', start: 3, end: 5, quote: ['+x'], body: 'rename this' }),
    comment({ id: 'a', body: '  no, keep this function pure  ' }),
    comment({ id: 'd', side: 'old', start: 40, end: 40, quote: ['-old();'], body: 'why did this go?' }),
  ]);
  assert.match(text, /left 4 comments across 2 files/);
  const a = text.indexOf('### src/a.js'), b = text.indexOf('### src/b.js');
  assert.ok(a > 0 && b > a, 'files in the order they were first commented on');
  const order = ['**Line 11**', '**Line 13**', '**Line 40 (removed)**', '**Lines 3–5**'].map(s => text.indexOf(s));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), order.join());
  assert.match(text, /```diff\n\+const b = 2;\n```\nno, keep this function pure/);
});

test('one comment reads as one, and what you typed in the box comes first', () => {
  const text = R.compose([comment()], '  Mostly good.  ');
  assert.match(text, /left 1 comment\. /);
  assert.doesNotMatch(text, /across/);
  assert.ok(text.indexOf('Mostly good.') < text.indexOf('### src/a.js'));
});

test('quoted code with backticks gets a longer fence', () => {
  const text = R.compose([comment({ quote: ['+const s = ```;'] })]);
  assert.match(text, /````diff\n\+const s = ```;\n````/);
});

test('nothing to say: no message', () => {
  assert.equal(R.compose([]), '');
  assert.equal(R.compose([comment({ body: '   ' })]), '');
});

test('only well-formed, recent comments survive a reload', () => {
  const now = Date.now();
  const kept = R.sanitize([
    comment(),
    comment({ id: 'old', at: now - 31 * 864e5 }),
    comment({ id: 'backwards', start: 5, end: 2 }),
    comment({ id: 'side', side: 'left' }),
    comment({ id: 'empty', body: ' ' }),
    { id: 'junk' },
    null,
    comment({ id: 'long', body: 'x'.repeat(R.MAX_BODY + 10) }),
  ], now);
  assert.deepEqual(kept.map(c => c.id), ['c1', 'long']);
  assert.equal(kept[1].body.length, R.MAX_BODY);
  assert.deepEqual(R.sanitize('nope'), []);
  assert.equal(R.sanitize(Array.from({ length: R.MAX_COMMENTS + 5 }, (_, i) => comment({ id: `n${i}` }))).length, R.MAX_COMMENTS);
});
