// Turn checkpoints pinned under refs/shellby/turns (src/main/changes.js pin),
// against a real git repo: they must survive gc, stay out of branches and the
// stash, and still undo a turn.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { snapshot, summarize, undo, pin, pins, prunePins, pinRef, PIN_PREFIX } = require('../src/main/changes');

function repo() {
  // Long names: git reports the long path, CI's temp dir is an 8.3 short one.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-pin-')));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { dir, g, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('pin: a turn survives gc --prune=now and still undoes', async () => {
  const r = repo();
  try {
    const start = await snapshot(r.dir);
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(r.dir, 'new.txt'), 'made by the turn\n');
    const end = await snapshot(r.dir);
    const ref = await pin(r.dir, start.tree, end.tree, 'turn-1');
    assert.equal(ref, `${PIN_PREFIX}turn-1`);

    r.g('reflog', 'expire', '--expire=now', '--all');
    r.g('gc', '-q', '--prune=now');
    assert.equal(r.g('cat-file', '-t', start.tree).trim(), 'tree');
    assert.equal(r.g('cat-file', '-t', end.tree).trim(), 'tree');
    // Not a branch, and nothing in the stash.
    assert.equal(r.g('branch', '--list').trim().split('\n').length, 1);
    assert.equal(r.g('stash', 'list').trim(), '');

    const summary = await summarize(start, end);
    const back = await undo({ root: r.dir, before: summary.before, after: summary.after });
    assert.equal(back.ok, true);
    assert.equal(fs.readFileSync(path.join(r.dir, 'a.txt'), 'utf8'), 'one\n');
    assert.equal(fs.existsSync(path.join(r.dir, 'new.txt')), false);
  } finally { r.done(); }
});

test('pins: newest first; prunePins keeps only the newest few', async () => {
  const r = repo();
  try {
    const s = await snapshot(r.dir);
    for (const name of ['t1', 't2', 't3']) assert.ok(await pin(r.dir, s.tree, s.tree, name));
    assert.deepEqual(new Set((await pins(r.dir)).map(p => p.name)), new Set(['t1', 't2', 't3']));
    assert.equal(await prunePins(r.dir, 1), 2);
    assert.equal((await pins(r.dir)).length, 1);
  } finally { r.done(); }
});

test('pin refuses names and trees that are not ones', async () => {
  assert.equal(pinRef('../../HEAD'), null);
  assert.equal(pinRef('a b'), null);
  assert.equal(pinRef('0f3c-uuid_1'), `${PIN_PREFIX}0f3c-uuid_1`);
  assert.equal(await pin(os.tmpdir(), 'nope', 'a'.repeat(40), 't'), null);
  assert.equal(await pin(os.tmpdir(), 'a'.repeat(40), 'a'.repeat(40), '../x'), null);
});
