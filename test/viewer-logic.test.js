// The file viewer's pure parts (shared/viewer-logic.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/renderer/shared/viewer-logic');

test('buildTree: folders first, case-blind order, change marks carried up', () => {
  const tree = V.buildTree(['src/', 'src/b.js', 'src/A.js', 'README.md', 'docs/', 'docs/x/', 'docs/x/y.md'], [
    { path: 'docs/x/y.md', status: 'M' }, { path: 'src/gone.js', status: 'D' },
  ]);
  assert.deepEqual(tree.children.map(c => c.name), ['docs', 'src', 'README.md']);
  const [docs, src] = tree.children;
  assert.equal(docs.status, 'M', 'a change two folders down marks the top one');
  assert.equal(docs.children[0].status, 'M');
  assert.deepEqual(src.children.map(c => `${c.name}:${c.status}`), ['A.js:null', 'b.js:null', 'gone.js:D']);
  assert.equal(src.status, 'M');
  assert.equal(tree.children[2].status, null);
});

test('buildTree: a deleted file still in the index is listed once', () => {
  const tree = V.buildTree(['a.txt'], [{ path: 'a.txt', status: 'D' }]);
  assert.deepEqual(tree.children.map(c => `${c.name}:${c.status}`), ['a.txt:D']);
});

test('buildTree: a new file the (older) index lacks is listed once, with its status', () => {
  const tree = V.buildTree(['a.txt'], [{ path: 'b.txt', status: '?' }, { path: 'src/c.js', status: 'A' }, { path: 'a.txt', status: 'M' }]);
  assert.deepEqual(tree.children.map(c => `${c.name}:${c.status}`), ['src:M', 'a.txt:M', 'b.txt:?']);
  assert.deepEqual(tree.children[0].children.map(c => `${c.name}:${c.status}`), ['c.js:A']);
});

test('visibleRows: open folders only, or every match and its folders when filtered', () => {
  const tree = V.buildTree(['src/', 'src/main/', 'src/main/app.js', 'src/b.js', 'top.md'], []);
  assert.deepEqual(V.visibleRows(tree, new Set()).map(r => r.node.path), ['src', 'top.md']);
  const open = V.visibleRows(tree, new Set(['src']));
  assert.deepEqual(open.map(r => `${r.depth}:${r.node.path}`), ['0:src', '1:src/main', '1:src/b.js', '0:top.md']);
  assert.deepEqual(V.visibleRows(tree, new Set(), 'APP').map(r => r.node.path), ['src', 'src/main', 'src/main/app.js']);
  assert.deepEqual(V.visibleRows(tree, new Set(), 'zzz'), []);
});

test('numberDiff numbers both sides from each hunk', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt', 'index 1..2 100644', '--- a/a.txt', '+++ b/a.txt',
    '@@ -3,3 +3,3 @@ head', ' keep', '-old', '+new', ' end', '\\ No newline at end of file',
  ].join('\n');
  const rows = V.numberDiff(patch);
  assert.deepEqual(rows.map(r => [r.cls, r.text, r.oldNo, r.newNo]), [
    ['hunk', '@@ -3,3 +3,3 @@ head', null, null],
    ['ctx', 'keep', 3, 3],
    ['del', 'old', 4, null],
    ['add', 'new', null, 4],
    ['ctx', 'end', 5, 5],
    ['meta', '\\ No newline at end of file', null, null],
  ]);
});

test('numberDiff: a new file starts its side at 1, and a removed "-- x" line is code', () => {
  const rows = V.numberDiff('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+one\n+--- two\n');
  assert.deepEqual(rows.slice(1).map(r => [r.text, r.newNo]), [['one', 1], ['--- two', 2]]);
  assert.deepEqual(V.numberDiff(''), []);
});

test('splitLines drops CRLF and the empty line after a final newline', () => {
  assert.deepEqual(V.splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(V.splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(V.splitLines(''), ['']);
});

test('liveState: waiting on you beats working, and no tab means no state', () => {
  assert.deepEqual(V.liveState({ busy: true, pending: 1 }), { word: 'Needs you', cls: 'needs' });
  assert.deepEqual(V.liveState({ busy: true, pending: 0 }), { word: 'Working', cls: 'busy' });
  assert.deepEqual(V.liveState({ busy: false }), { word: 'Done', cls: 'done' });
  assert.equal(V.liveState(null), null);
});

test('status words and classes', () => {
  assert.equal(V.statusWord('?'), 'New, not tracked yet');
  assert.equal(V.statusWord('M'), 'Modified');
  assert.equal(V.statusClass('?'), 'u');
  assert.equal(V.statusClass('D'), 'd');
});
