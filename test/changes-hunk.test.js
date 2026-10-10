// Taking back one hunk of a turn's file, against a real git repo, like
// changes.test.js: git apply and the temp index are what's being relied on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { snapshot, summarize, patchFor, undo, undoHunk, splitHunks } = require('../src/main/changes');
const { effectiveAfter, planStep } = require('../src/main/step-undo');

const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const text = ls => `${ls.join('\n')}\n`;

function repo(eol = '\n') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-hunk-')));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), text(LINES).replace(/\n/g, eol));
  g('add', '-A');
  g('commit', '-qm', 'init');
  const write = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  return { dir, g, write, read, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A turn that changes line 2 and line 25: two hunks, far apart.
async function twoHunkTurn(r, eol = '\n') {
  const before = await snapshot(r.dir);
  const changed = LINES.slice();
  changed[1] = 'line 2, changed';
  changed[24] = 'line 25, changed';
  r.write('a.txt', text(changed).replace(/\n/g, eol));
  const s = await summarize(before, await snapshot(r.dir));
  return { ...s, file: 'a.txt' };
}

const headerOf = async (ref, i) => splitHunks((await patchFor(ref)).patch).hunks[i].split('\n')[0];

test('splitHunks keeps the file header and splits at each @@', () => {
  const p = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n';
  const { head, hunks } = splitHunks(p);
  assert.deepEqual(head, ['diff --git a/x b/x', '--- a/x', '+++ b/x']);
  assert.deepEqual(hunks, ['@@ -1 +1 @@\n-a\n+b', '@@ -9 +9 @@\n-c\n+d']);
  assert.deepEqual(splitHunks('').hunks, []);
});

test('one hunk goes back, the other stays, and the turn now stands at a new tree', async () => {
  const r = repo();
  try {
    const ref = await twoHunkTurn(r);
    const u = await undoHunk(ref, { hunk: 1, header: await headerOf(ref, 1) });
    assert.equal(u.ok, true, u.error);
    const now = r.read('a.txt');
    assert.match(now, /line 2, changed/);
    assert.doesNotMatch(now, /line 25, changed/);
    assert.match(now, /^line 25$/m);
    // The new tree is the turn's after with only that file moved on: its diff has one hunk left.
    const left = await patchFor({ ...ref, after: u.to });
    assert.equal(splitHunks(left.patch).hunks.length, 1);
    assert.match(left.patch, /line 2, changed/);
  } finally { r.done(); }
});

test('a second hunk can go back too, and the whole-turn Undo still works after one', async () => {
  const r = repo();
  try {
    const ref = await twoHunkTurn(r);
    const first = await undoHunk(ref, { hunk: 0, header: await headerOf(ref, 0) });
    assert.equal(first.ok, true, first.error);
    const moved = { ...ref, after: first.to };
    // Undo of what's left: against the new tree, the file hasn't "changed since".
    assert.deepEqual(await undo(moved), { ok: true, restored: 1 });
    assert.equal(r.read('a.txt'), text(LINES));
  } finally { r.done(); }
});

test('a stale header, a hunk past the end, or a file changed since are all refused, and nothing moves', async () => {
  const r = repo();
  try {
    const ref = await twoHunkTurn(r);
    const turn = r.read('a.txt');
    assert.match((await undoHunk(ref, { hunk: 0, header: '@@ -1,1 +1,1 @@' })).error, /changed since/);
    assert.equal((await undoHunk(ref, { hunk: 5, header: await headerOf(ref, 0) })).ok, false);
    assert.equal((await undoHunk(ref, { hunk: -1, header: '@@' })).ok, false);
    assert.equal((await undoHunk({ ...ref, file: undefined }, { hunk: 0, header: await headerOf(ref, 0) })).ok, false);
    assert.equal(r.read('a.txt'), turn);

    r.write('a.txt', `${turn}yours, later\n`);
    const u = await undoHunk(ref, { hunk: 0, header: await headerOf(ref, 0) });
    assert.equal(u.ok, false);
    assert.deepEqual(u.changedSince, ['a.txt']);
    assert.equal(r.read('a.txt'), `${turn}yours, later\n`);
  } finally { r.done(); }
});

test('a new file is refused: taking it back is the whole Undo', async () => {
  const r = repo();
  try {
    const before = await snapshot(r.dir);
    r.write('new.txt', 'x\ny\n');
    const s = await summarize(before, await snapshot(r.dir));
    const ref = { ...s, file: 'new.txt' };
    const u = await undoHunk(ref, { hunk: 0, header: await headerOf(ref, 0) });
    assert.equal(u.ok, false);
    assert.ok(fs.existsSync(path.join(r.dir, 'new.txt')));
  } finally { r.done(); }
});

test('Windows line endings stay as they were', async () => {
  const r = repo('\r\n');
  try {
    const ref = await twoHunkTurn(r, '\r\n');
    const u = await undoHunk(ref, { hunk: 0, header: await headerOf(ref, 0) });
    assert.equal(u.ok, true, u.error);
    const now = r.read('a.txt');
    assert.doesNotMatch(now, /line 2, changed/);
    assert.match(now, /line 25, changed/);
    assert.equal(now.split('\r\n').length, LINES.length + 1, 'every line still ends in CRLF');
  } finally { r.done(); }
});

test('effectiveAfter follows the newest undone step or hunk of that turn', () => {
  const ref = { root: 'C:\\r', before: 'b'.repeat(40), after: 'a'.repeat(40) };
  const changes = { kind: 'changes', ...ref, turnId: 't1', files: [] };
  assert.equal(effectiveAfter([changes], ref).after, ref.after);
  const hunk = { kind: 'undone-hunk', turnId: 't1', before: ref.before, after: ref.after, file: 'x', to: 'c'.repeat(40) };
  assert.equal(effectiveAfter([changes, hunk], ref).after, 'c'.repeat(40));
  const step = { kind: 'undone-step', turnId: 't1', toolId: 'u1', after: ref.after, to: 'd'.repeat(40) };
  assert.equal(effectiveAfter([changes, hunk, step], ref).after, 'd'.repeat(40));
  assert.equal(effectiveAfter([changes, step, hunk], ref).after, 'c'.repeat(40));
  // Another turn's hunk doesn't count.
  assert.equal(effectiveAfter([changes, { ...hunk, after: 'e'.repeat(40) }], ref).after, ref.after);
});

test('Undo to here after a hunk went back starts from where the hunk left the turn', () => {
  const root = 'C:\\r';
  const items = [
    { kind: 'step-point', turnId: 't1', toolId: 'u1', root, tree: '1'.repeat(40) },
    { kind: 'checkpoint', turnId: 't1', root, end: '2'.repeat(40) },
    { kind: 'changes', turnId: 't1', root, before: '0'.repeat(40), after: '2'.repeat(40), files: [] },
    { kind: 'undone-hunk', turnId: 't1', before: '0'.repeat(40), after: '2'.repeat(40), file: 'x', to: '3'.repeat(40) },
  ];
  const p = planStep(items, 't1', 'u1');
  assert.equal(p.ok, true);
  assert.equal(p.from, '3'.repeat(40));
});
