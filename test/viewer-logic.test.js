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

test('numberDiff: a CRLF file\'s lines keep no \\r', () => {
  const patch = 'diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\n@@ -1,2 +1,2 @@\n one\r\n-two\r\n+TWO\r\n';
  const rows = V.numberDiff(patch);
  assert.deepEqual(rows.map(r => [r.cls, r.text, r.oldNo, r.newNo]), [
    ['hunk', '@@ -1,2 +1,2 @@', null, null],
    ['ctx', 'one', 1, 1],
    ['del', 'two', 2, null],
    ['add', 'TWO', null, 2],
  ]);
});

test('whereText: "(from base)", unless the list fell back to HEAD with no merge-base', () => {
  const at = { name: 'proj', branch: 'feat', base: 'main' };
  assert.equal(V.whereText({ ...at, against: null }), 'proj · feat (from main)', 'before the first look');
  assert.equal(V.whereText({ ...at, against: 'main' }), 'proj · feat (from main)');
  assert.equal(V.whereText({ ...at, against: 'HEAD' }), 'proj · feat (since the last commit)', 'no merge-base');
  assert.equal(V.whereText({ ...at, against: 'HEAD', only: true }), 'proj · feat (from main)', 'Just uncommitted is a choice, not a fallback');
  assert.equal(V.whereText({ name: 'proj', branch: 'main', base: null, against: 'HEAD' }), 'proj · main');
  assert.equal(V.whereText({ name: 'notes', branch: null }), 'notes');
});

test('whereText: a branch says so, and where it came from', () => {
  assert.equal(V.whereText({ kind: 'branch', name: 'proj', branch: 'feature-x', base: 'main', against: 'main' }), 'feature-x · branch (from main)');
  assert.equal(V.whereText({ kind: 'branch', name: 'proj', branch: 'feature-x', base: null, against: null }), 'feature-x · branch');
  assert.equal(V.whereText({ kind: 'folder', name: 'proj', branch: 'feat', base: 'main', against: 'main' }), 'proj · feat (from main)');
});

test("placeSub: a worktree's branch and count, a branch's lead and age", () => {
  const ago = t => `at ${t}`;
  assert.equal(V.placeSub({ kind: 'worktree', branch: 'feat', changed: 3 }, ago), 'feat · 3 changed');
  assert.equal(V.placeSub({ kind: 'worktree', branch: 'main', changed: 0 }, ago), 'main · 0 changed');
  assert.equal(V.placeSub({ kind: 'worktree', branch: 'detached' }, ago), 'detached', 'no count: git status timed out');
  assert.equal(V.placeSub({ kind: 'branch', branch: 'x', ahead: 2, when: 5 }, ago), '2 ahead · at 5');
  assert.equal(V.placeSub({ kind: 'branch', branch: 'x', ahead: 1, when: 0 }, ago), '1 ahead');
});

test('findPlace: the same pick in a list made since, by what the panel was shown of it', () => {
  const list = [
    { key: 'k1', kind: 'worktree', label: 'proj', branch: 'main' },
    { key: 'k2', kind: 'worktree', label: 'proj', branch: 'shellby/abc' },
    { key: 'k3', kind: 'branch', label: 'feature-x', branch: 'feature-x' },
  ];
  assert.equal(V.findPlace(list, { kind: 'worktree', label: 'proj', branch: 'shellby/abc' }).key, 'k2');
  assert.equal(V.findPlace(list, { kind: 'branch', label: 'feature-x', branch: 'feature-x' }).key, 'k3');
  assert.equal(V.findPlace(list, { kind: 'branch', label: 'gone', branch: 'gone' }), null);
  assert.equal(V.findPlace(null, { kind: 'branch', label: 'x', branch: 'x' }), null);
  assert.equal(V.findPlace(list, null), null);
});

test('placeKey: a branch and the folder it was picked from remember their files apart', () => {
  const folder = V.placeKey({ kind: 'folder', root: 'C:\\code\\proj', branch: 'main' });
  assert.equal(folder, V.placeKey({ kind: 'folder', root: 'c:\\CODE\\proj', branch: 'main' }), 'any case');
  assert.notEqual(V.placeKey({ kind: 'branch', root: 'C:\\code\\proj', branch: 'feature-x' }), folder);
  assert.notEqual(V.placeKey({ kind: 'branch', root: 'C:\\code\\proj', branch: 'feature-x' }), V.placeKey({ kind: 'branch', root: 'C:\\code\\proj', branch: 'other' }));
});

test('tabAt: a conversation in the place or holding it, never one left in the home folder', () => {
  const home = 'C:\\Users\\Me';
  const inHome = { id: 'h', cwd: 'C:\\Users\\Me' };
  const copy = { id: 'c', cwd: 'C:\\Users\\Me\\AppData\\Roaming\\Shellby\\worktrees\\1\\proj' };
  const sub = { id: 's', cwd: 'C:\\code\\proj\\src' };
  const tabs = [inHome, copy, sub];
  assert.equal(V.tabAt(tabs, 'c:/users/me/appdata/roaming/shellby/worktrees/1/proj/', home), copy, 'its own folder, any case or slash');
  assert.equal(V.tabAt(tabs, `${copy.cwd}\\.claude\\worktrees\\agent-x`, home), copy, 'a worktree inside a conversation\'s folder');
  assert.equal(V.tabAt(tabs, 'C:\\code\\proj', home), sub, 'a conversation started in a subfolder of the place');
  assert.equal(V.tabAt(tabs, 'C:\\Users\\Me\\code\\other', home), null, 'the home folder holds it, but that tab is too wide to count');
  assert.equal(V.tabAt(tabs, 'C:\\code\\proj2', home), null, 'a name that only starts the same');
  assert.equal(V.tabAt(new Map([['c', copy]]).values(), copy.cwd, home), copy, 'any iterable, as state.tabs.values()');
  assert.equal(V.tabAt(tabs, '', home), null);
});

test('keepFile: a pick keeps the file you were on if the new place has it, else opens the one last open there', () => {
  const has = rel => ['a.txt', 'src/b.js'].includes(rel);
  assert.equal(V.keepFile('a.txt', 'src/b.js', has), 'a.txt', 'the file you were on wins');
  assert.equal(V.keepFile('feature.txt', 'src/b.js', has), 'src/b.js', 'the place remembers its own');
  assert.equal(V.keepFile('feature.txt', 'gone.txt', has), null, 'neither is there: the placeholder');
  assert.equal(V.keepFile(null, 'a.txt', has), 'a.txt');
  assert.equal(V.keepFile('', null, has), null);
  assert.equal(V.keepFile(null, null, has), null);
});

test('tooWide: the home folder and a whole drive, any case or trailing slash; a folder in home is fine', () => {
  const home = 'C:\\Users\\Me';
  assert.equal(V.tooWide('C:\\Users\\Me', home), true);
  assert.equal(V.tooWide('c:\\users\\me\\', home), true);
  assert.equal(V.tooWide('C:\\', home), true);
  assert.equal(V.tooWide('D:/', home), true);
  assert.equal(V.tooWide('', home), true);
  assert.equal(V.tooWide('C:\\Users\\Me\\code\\app', home), false);
  assert.equal(V.tooWide('C:\\Users\\Me\\code\\app', null), false, 'no home known: main still refuses it');
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

test('totals and totalsText: files, lines added and removed; a binary file counts as a file only', () => {
  const files = [
    { path: 'a.js', status: 'M', added: 20, removed: 50 },
    { path: 'b.js', status: '?', added: 10, removed: 0 },
    { path: 'logo.png', status: 'M', binary: true, added: 0, removed: 0 },
    { path: 'gone.js', status: 'D', added: 0, removed: 2 },
  ];
  assert.deepEqual(V.totals(files), { files: 4, added: 30, removed: 52 });
  assert.equal(V.totalsText(files), '4 files · +30 −52');
  assert.equal(V.totalsText([files[1]]), '1 file · +10', 'one file, and no −0');
  assert.equal(V.totalsText([files[2]]), '1 file', 'binary: no lines to count');
  assert.deepEqual(V.totals(null), { files: 0, added: 0, removed: 0 });
  assert.equal(V.totalsText([]), '', 'nothing changed: nothing to say');
  assert.equal(V.totalsText(files, 8), '4 of 12 files · +30 −52', 'a capped list says how many it shows, and the sums are of those');
  assert.equal(V.totalsText(files, 0), '4 files · +30 −52');
});
