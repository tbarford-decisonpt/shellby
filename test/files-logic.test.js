// All files' pure parts (shared/files-logic.js): which rows light, in what tone and for how
// long; the folders a flash opens and closes again; pinned rows; folder totals; a shell
// command's changes; and @path in the box.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/renderer/shared/files-logic');

const ROOT = 'C:/code/app';
const tool = (id, name, filePath, extra = {}) => ({ kind: 'tool', id, name, filePath, ...extra });
const done = id => ({ kind: 'tool_result', id });
const tones = s => Object.fromEntries([...s.lit.values()].map(l => [l.rel, l.tone]));

test('a burst shares one timer: lit while anything runs, dark 2.7 s after the last step', () => {
  const s = F.create();
  const at = { root: ROOT, now: 0 };
  assert.equal(F.take(s, tool('1', 'Read', `${ROOT}/a.js`), at), true);
  F.take(s, tool('2', 'Edit', `${ROOT}/src/b.js`), at);
  F.take(s, done('1'), { ...at, now: 500 });
  assert.equal(s.until, Infinity, 'one still runs');
  F.take(s, done('2'), { ...at, now: 1000 });
  assert.equal(s.until, 1000 + F.AFTERGLOW_MS);
  assert.equal(F.expire(s, 3699), null);
  assert.deepEqual(F.expire(s, 3700), []);
  assert.equal(s.lit.size, 0);
});

test('new activity restarts the afterglow and adds to what is lit', () => {
  const s = F.create();
  F.take(s, tool('1', 'Read', `${ROOT}/a.js`), { root: ROOT, now: 0 });
  F.take(s, done('1'), { root: ROOT, now: 0 });
  F.take(s, tool('2', 'Read', `${ROOT}/b.js`), { root: ROOT, now: 2000 });
  F.take(s, done('2'), { root: ROOT, now: 2100 });
  assert.equal(F.expire(s, 2800), null);
  assert.deepEqual(Object.keys(tones(s)).sort(), ['a.js', 'b.js']);
  assert.deepEqual(F.expire(s, 4800), []);
});

test('a turn that ends stops the wait for a step that never answered', () => {
  const s = F.create();
  F.take(s, tool('1', 'Edit', `${ROOT}/a.js`), { root: ROOT, now: 0 });
  assert.equal(F.take(s, { kind: 'result' }, { root: ROOT, now: 100 }), true);
  assert.equal(s.until, 100 + F.AFTERGLOW_MS);
});

test('a write beats a read on the same file, and a commit beats both', () => {
  const s = F.create();
  F.take(s, tool('1', 'Read', `${ROOT}/a.js`), { root: ROOT, now: 0 });
  F.take(s, tool('2', 'Write', `${ROOT}/a.js`), { root: ROOT, now: 0 });
  F.take(s, tool('3', 'Read', `${ROOT}/a.js`), { root: ROOT, now: 0 });
  assert.equal(tones(s)['a.js'], 'write');
  F.light(s, ['a.js'], 'commit', 0);
  assert.equal(tones(s)['a.js'], 'commit');
});

test('paths from tool calls meet the tree\'s in lower case', () => {
  const s = F.create();
  F.take(s, tool('1', 'Edit', 'C:\\code\\APP\\Src\\App.js'), { root: ROOT, now: 0 });
  F.take(s, tool('2', 'Read', 'lib/x.js'), { root: ROOT, cwd: `${ROOT}/pkg`, now: 0 });
  assert.deepEqual([...s.lit.keys()].sort(), ['pkg/lib/x.js', 'src/app.js']);
  assert.equal(F.relOf('C:/elsewhere/a.js', ROOT), null, 'outside the root');
  assert.equal(F.relOf('C:/code/application/a.js', ROOT), null, 'a sibling that only starts the same');
  assert.equal(F.relOf(ROOT, ROOT), null, 'the root itself is no row');
});

test('outside the root, replayed items, helpers\' launches and shell commands light nothing at once', () => {
  const s = F.create();
  assert.equal(F.take(s, tool('1', 'Read', 'D:/other/a.js'), { root: ROOT, now: 0 }), false);
  assert.equal(F.take(s, tool('2', 'Read', `${ROOT}/a.js`), { root: ROOT, now: 0, replay: true }), false);
  assert.equal(F.take(s, { kind: 'tool', id: '3', name: 'Agent', agent: { type: 'x' } }, { root: ROOT, now: 0 }), false);
  assert.equal(F.take(s, { kind: 'tool', id: '4', name: 'Bash', detail: 'npm test' }, { root: ROOT, now: 0 }), false);
  assert.equal(s.lit.size, 0);
  assert.equal(F.take(s, done('4'), { root: ROOT, now: 10 }), false);
  assert.equal(s.ranShell, true, 'its result asks for the next status read to be compared');
});

test('a helper\'s steps count the same', () => {
  const s = F.create();
  assert.equal(F.take(s, tool('1', 'Write', `${ROOT}/h.js`, { sub: true, parent: 'p' }), { root: ROOT, now: 0 }), true);
});

test('Grep and Glob light the folder they name', () => {
  const s = F.create();
  F.take(s, { kind: 'tool', id: '1', name: 'Grep', target: { path: `${ROOT}/src`, pattern: 'x' } }, { root: ROOT, now: 0 });
  F.take(s, { kind: 'tool', id: '2', name: 'Glob', target: { pattern: '*.js' } }, { root: ROOT, now: 0 });
  assert.deepEqual(tones(s), { src: 'read' });
});

test('a flash opens at most 12 files\' folders, and closes the ones you never touched', () => {
  const s = F.create();
  const open = new Set();
  const isOpen = k => open.has(k);
  for (let i = 0; i < 13; i++) for (const k of F.reveal(s, `d${i}/sub/f.js`, isOpen)) open.add(k);
  assert.equal(open.has('d11/sub'), true);
  assert.equal(open.has('d12'), false, 'the 13th waits');
  assert.deepEqual(F.reveal(s, 'd0/sub/g.js', isOpen), [], 'already showing: nothing to open, and not counted');
  F.touch(s, 'd3');
  F.light(s, ['x.js'], 'read', 0);
  const close = F.expire(s, F.AFTERGLOW_MS);
  assert.equal(close.includes('d3'), false, 'you opened or closed it yourself');
  assert.equal(close.includes('d3/sub'), true);
  assert.equal(close.length, 23);
});

test('folder totals: lines and marks rolled up, an untracked folder counted once in its parents', () => {
  const t = F.totals([
    { path: 'src/a.js', status: 'M', added: 3, removed: 1 },
    { path: 'src/ui/b.js', status: 'A', added: 5, removed: 0 },
    { path: 'src/new/', status: '?', added: null, removed: null },
    { path: 'README.md', status: 'D', added: 0, removed: 9 },
  ]);
  assert.equal(F.totalsText(t.get('')), '+8 −10 M:1 A:1 ?:1 D:1');
  assert.equal(F.totalsText(t.get('src')), '+8 −1 M:1 A:1 ?:1');
  assert.equal(F.totalsText(t.get('src/ui')), '+5 −0 A:1');
  assert.equal(t.has('src/new'), false);
  assert.equal(F.totalsText(undefined), '');
});

test('an untracked folder: it and everything in it is ?', () => {
  const marks = new Map([['src/new/', '?'], ['src/a.js', 'M']]);
  assert.equal(F.markOf(marks, 'src/a.js'), 'M');
  assert.equal(F.markOf(marks, 'src/New'), '?');
  assert.equal(F.markOf(marks, 'src/new/deep/x.js'), '?');
  assert.equal(F.markOf(marks, 'src/other.js'), null);
});

test('a shell command\'s doing: whatever changed between two reads, at most 200', () => {
  const before = [{ path: 'a.js', status: 'M', added: 1, removed: 0 }, { path: 'b.js', status: 'M', added: 1, removed: 1 }];
  const after = [{ path: 'a.js', status: 'M', added: 2, removed: 0 }, { path: 'new/', status: '?', added: null, removed: null }];
  assert.deepEqual(F.changedBetween(before, after).sort(), ['a.js', 'b.js', 'new']);
  const many = Array.from({ length: 300 }, (_, i) => ({ path: `f${i}`, status: '?' }));
  assert.equal(F.changedBetween([], many).length, F.MAX_FLASH);
});

test('pinned rows: the lit ones above the view, newest last, a third of it at most', () => {
  assert.deepEqual(F.pins([2, 5, 9, 40], 20, 2), [5, 9]);
  assert.deepEqual(F.pins([30], 20, 2), []);
  assert.deepEqual(F.pins([1], 20, 0), []);
});

test('@path in the box: the one the caret is in or just after', () => {
  assert.equal(F.mentionAt('look at @src/a.js', 17), 'src/a.js');
  assert.equal(F.mentionAt('look at @src/a.js ', 18), 'src/a.js', 'just picked from the menu, with its space');
  assert.equal(F.mentionAt('see @"my docs/x.md" ok', 19), 'my docs/x.md');
  assert.equal(F.mentionAt('me@example.com', 14), null, 'an address');
  assert.equal(F.mentionAt('plain words ', 12), null);
});
