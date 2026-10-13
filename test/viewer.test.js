// The file viewer's handles (main's viewer.js) against real git repos in temp
// folders: what changed since a branch began, untracked files marked, diffs
// only for files on the list, and links found inside the repo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createViewer, locate, branchOf, writeWatch, MAX_HANDLES } = require('../src/main/viewer');

function repo({ commit = true } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-')));
  const dir = path.join(base, 'proj');
  fs.mkdirSync(dir);
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'core.autocrlf', 'false');
  const write = (at, f, s) => { fs.mkdirSync(path.dirname(path.join(at, f)), { recursive: true }); fs.writeFileSync(path.join(at, f), s); };
  write(dir, 'a.txt', 'one\ntwo\n');
  write(dir, 'src/keep.js', 'const k = 1;\n');
  write(dir, '.gitignore', 'ignored/\n');
  if (commit) { g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'init'); }
  return { base, dir, g, write, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// A worktree on its own branch, with one commit of its own.
function worktree(r) {
  const wt = path.join(r.base, 'wt');
  r.g(r.dir, 'worktree', 'add', '-q', '-b', 'feat', wt);
  r.write(wt, 'a.txt', 'one\nTWO\n');
  r.g(wt, 'commit', '-qam', 'feat work');
  return wt;
}

test('a worktree: changes since its branch began, committed, uncommitted and untracked', async () => {
  const r = repo();
  try {
    const wt = worktree(r);
    r.write(wt, 'src/keep.js', 'const k = 2;\n');              // uncommitted
    r.write(wt, 'docs/my notes/é.md', '# hi\n');                // untracked, spaces and non-ASCII
    r.write(wt, 'ignored/x.txt', 'never listed\n');
    const v = createViewer();
    const h = await v.open({ dir: wt });
    assert.equal(h.ok, true);
    assert.equal(h.branch, 'feat');
    assert.equal(h.base, 'main', "the main checkout's branch, since no base was given");
    assert.equal(h.git, true);
    const c = await v.changesOf(h.id);
    assert.equal(c.ok, true);
    assert.equal(c.against, 'main');
    const byPath = Object.fromEntries(c.files.map(f => [f.path, f.status]));
    assert.deepEqual(byPath, { 'a.txt': 'M', 'docs/my notes/é.md': '?', 'src/keep.js': 'M' });
    const only = await v.changesOf(h.id, { uncommittedOnly: true });
    assert.deepEqual(only.files.map(f => f.path).sort(), ['docs/my notes/é.md', 'src/keep.js']);
    assert.equal(only.against, 'HEAD');
  } finally { r.done(); }
});

test('diffs only for files on the list, and the read of an odd name works', async () => {
  const r = repo();
  try {
    const wt = worktree(r);
    r.write(wt, 'docs/my notes/é.md', '# hi\n');
    const v = createViewer();
    const h = await v.open({ dir: wt });
    await v.changesOf(h.id);
    const d = await v.diffOf(h.id, 'a.txt');
    assert.equal(d.ok, true);
    assert.match(d.patch, /^-two$/m);
    assert.match(d.patch, /^\+TWO$/m);
    const odd = await v.diffOf(h.id, 'docs/my notes/é.md');
    assert.equal(odd.ok, true);
    assert.match(odd.patch, /^\+# hi$/m);
    assert.equal((await v.diffOf(h.id, '.gitignore')).ok, false, 'unchanged: not on the list');
    assert.equal((await v.diffOf(h.id, '../proj/a.txt')).ok, false);
    assert.equal((await v.read(h.id, 'docs/my notes/é.md')).text, '# hi\n');
  } finally { r.done(); }
});

test('a base given (a Shellby copy) wins, and a plain checkout compares with HEAD', async () => {
  const r = repo();
  try {
    const wt = worktree(r);
    const v = createViewer();
    assert.equal((await v.open({ dir: wt, base: 'main' })).base, 'main');
    r.write(r.dir, 'a.txt', 'changed in the checkout\n');
    const h = await v.open({ dir: r.dir });
    assert.equal(h.base, null, 'the main checkout has no base');
    const c = await v.changesOf(h.id);
    assert.equal(c.against, 'HEAD');
    assert.deepEqual(c.files.map(f => f.path), ['a.txt']);
  } finally { r.done(); }
});

test('a base that git cannot find falls back to HEAD instead of failing', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir, base: 'no-such-branch' });
    r.write(r.dir, 'a.txt', 'x\n');
    const c = await v.changesOf(h.id);
    assert.equal(c.ok, true);
    assert.equal(c.against, 'HEAD');
    assert.deepEqual(c.files.map(f => f.path), ['a.txt']);
  } finally { r.done(); }
});

test('a repo with no commits lists every file as new', async () => {
  const r = repo({ commit: false });
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const c = await v.changesOf(h.id);
    assert.equal(c.ok, true);
    assert.deepEqual(c.files.map(f => f.path).sort(), ['.gitignore', 'a.txt', 'src/keep.js']);
    assert.ok(c.files.every(f => f.status === '?'));
  } finally { r.done(); }
});

test('a repo with no commits: a staged file shows as added, as it is on disk now', async () => {
  const r = repo({ commit: false });
  try {
    r.g(r.dir, 'add', 'a.txt');
    r.write(r.dir, 'a.txt', 'one\ntwo\nthree\n');
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const c = await v.changesOf(h.id);
    assert.equal(c.ok, true);
    assert.equal(c.files.find(f => f.path === 'a.txt').status, 'A');
    assert.equal(c.files.find(f => f.path === 'a.txt').added, 3);
    assert.equal(c.files.find(f => f.path === 'src/keep.js').status, '?');
  } finally { r.done(); }
});

test('a folder that is not a repo has no changes, and a vanished one is gone', async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-plain-')));
  try {
    fs.writeFileSync(path.join(base, 'notes.txt'), 'hi\n');
    const v = createViewer();
    const h = await v.open({ dir: base });
    assert.equal(h.git, false);
    assert.deepEqual(await v.changesOf(h.id), { ok: true, noGit: true, files: [], more: 0, against: null });
    const r = repo();
    const wt = worktree(r);
    const w = await v.open({ dir: wt });
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    assert.equal((await v.changesOf(w.id)).gone, true);
    assert.equal((await v.read(w.id, 'a.txt')).gone, true);
    r.done();
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a subfolder opens the whole repo, and handles are capped', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: path.join(r.dir, 'src') });
    assert.equal(h.root.toLowerCase(), r.dir.toLowerCase());
    const ids = [h.id];
    for (let i = 0; i < MAX_HANDLES; i++) ids.push((await v.open({ dir: r.dir })).id);
    assert.equal(v.get(ids[0]), null, 'the oldest goes first');
    assert.deepEqual(await v.changesOf(ids[0]), { ok: false, expired: true });
    assert.ok(v.get(ids.at(-1)));
    v.close(ids.at(-1));
    assert.equal(v.get(ids.at(-1)), null);
  } finally { r.done(); }
});

test('staleFor finds the handles a changed folder belongs to', async () => {
  const r = repo();
  try {
    const wt = worktree(r);
    const v = createViewer();
    const main = await v.open({ dir: r.dir });
    const copy = await v.open({ dir: wt });
    assert.deepEqual(v.staleFor(path.join(r.dir, 'src')), [main.id]);
    assert.deepEqual(v.staleFor(wt.toUpperCase()), [copy.id]);
    assert.deepEqual(v.staleFor(os.homedir()), []);
    assert.deepEqual(v.staleFor(42), []);
  } finally { r.done(); }
});

test('staleFor: a worktree inside the changed folder too, but never everything under a folder too wide', async () => {
  const r = repo();
  try {
    const agent = path.join(r.dir, '.claude', 'worktrees', 'agent-1');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'agent-1', agent);
    const v = createViewer({ home: r.base });
    const a = await v.open({ dir: agent });
    assert.deepEqual(v.staleFor(r.dir), [a.id], "a write in the conversation's folder nudges the agent's worktree under it");
    assert.deepEqual(v.staleFor(r.base), [], 'the home folder (r.base here) is too wide to nudge all it holds');
  } finally { r.done(); }
});

test('a base named like an option reaches merge-base as refs/heads/--fork-point, never as an option', async () => {
  const r = repo();
  try {
    // git branch refuses such a name; update-ref and symbolic-ref make it anyway, as a hostile repo could.
    const init = r.g(r.dir, 'rev-parse', 'HEAD').trim();
    r.g(r.dir, 'update-ref', 'refs/heads/--fork-point', init);
    r.g(r.dir, 'symbolic-ref', 'HEAD', 'refs/heads/--fork-point');
    const copy = path.join(r.base, 'copy');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'copy', copy, init);
    r.write(copy, 'mine.txt', 'mine\n');
    r.g(copy, 'add', '-A');
    r.g(copy, 'commit', '-qm', 'mine');
    const v = createViewer();
    const h = await v.open({ dir: copy });
    assert.equal(h.base, '--fork-point', "the main checkout's branch, as git lists it");
    const c = await v.changesOf(h.id);
    assert.equal(c.against, '--fork-point');
    // As an option, `merge-base --fork-point HEAD` answers the copy's own HEAD and its commit drops off.
    assert.deepEqual(c.files.map(f => f.path), ['mine.txt'], "the copy's own commit, since it left the checkout's branch");
  } finally { r.done(); }
});

test('locate: a link relative to a subfolder, absolute inside, outside, and missing', async () => {
  const r = repo();
  try {
    const sub = path.join(r.dir, 'src');
    assert.deepEqual(await locate(sub, 'keep.js:3'), { inside: true, rel: 'src/keep.js', line: 3 });
    assert.deepEqual(await locate(sub, path.join(r.dir, 'a.txt')), { inside: true, rel: 'a.txt', line: null });
    assert.deepEqual(await locate(sub, os.homedir()), { inside: false });
    assert.deepEqual(await locate(sub, 'nope.js'), { inside: false });
    assert.deepEqual(await locate(sub, '\\\\server\\share\\x.js'), { inside: false });
  } finally { r.done(); }
});

test('branchOf names the branch, and nothing outside a repo', async () => {
  const r = repo();
  try {
    assert.equal(await branchOf(r.dir), 'main');
    assert.equal(await branchOf(os.tmpdir()), null);
  } finally { r.done(); }
});

test("looking at a repo never runs its hooks", async () => {
  const r = repo();
  try {
    // Pinned here, so a core.hooksPath in the machine's own config can't make this pass by itself
    // (changes.test.js shows the same hook does run for a turn's snapshot).
    r.g(r.dir, 'config', 'core.hooksPath', '.git/hooks');
    const marker = path.join(r.base, 'HOOK_RAN').split(path.sep).join('/');
    fs.writeFileSync(path.join(r.dir, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    r.write(r.dir, 'new.txt', 'x\n');
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    assert.equal((await v.changesOf(h.id)).ok, true);
    assert.equal(fs.existsSync(marker), false);
  } finally { r.done(); }
});

test('a repeat within 2 s is answered from the last look; a different mode looks again', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    r.write(r.dir, 'a.txt', 'x\n');
    const first = await v.changesOf(h.id);
    r.write(r.dir, 'b.txt', 'y\n');
    assert.deepEqual((await v.changesOf(h.id)).files.map(f => f.path), first.files.map(f => f.path), 'b.txt waits for the next look');
    assert.deepEqual((await v.changesOf(h.id, { uncommittedOnly: true })).files.map(f => f.path).sort(), ['a.txt', 'b.txt']);
    r.write(r.dir, 'c.txt', 'z\n');
    v.staleFor(r.dir); // a nudge: something there changed
    // Same mode as the call just before, inside 2 s: only the nudge can make it look again.
    assert.deepEqual((await v.changesOf(h.id, { uncommittedOnly: true })).files.map(f => f.path).sort(), ['a.txt', 'b.txt', 'c.txt'], 'a nudge always looks again');
  } finally { r.done(); }
});

test('a nudge while a look is running: the next call looks again, and the old look answers nothing later', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const first = v.changesOf(h.id);        // running...
    r.write(r.dir, 'late.txt', 'x\n');       // ...a write lands...
    v.staleFor(r.dir);                       // ...and the folder is nudged
    const second = await v.changesOf(h.id);
    assert.ok(second.files.some(f => f.path === 'late.txt'), 'the call after a nudge is not absorbed by the running look');
    await first;
    // A look that was running when the nudge came must not be kept as the 2 s answer.
    const running = v.changesOf(h.id, { uncommittedOnly: true });
    v.staleFor(r.dir);
    await running;
    r.write(r.dir, 'later.txt', 'y\n');
    const again = await v.changesOf(h.id, { uncommittedOnly: true });
    assert.ok(again.files.some(f => f.path === 'later.txt'), 'looks again, since a nudge came while the last one ran');
  } finally { r.done(); }
});

test('a diff is cut from the list last handed out, whichever mode it was', async () => {
  const r = repo();
  try {
    const wt = worktree(r);                  // a.txt committed on the branch
    r.write(wt, 'src/keep.js', 'const k = 2;\n'); // keep.js uncommitted
    const v = createViewer();
    const h = await v.open({ dir: wt });
    assert.ok((await v.changesOf(h.id)).files.some(f => f.path === 'a.txt'));
    assert.equal((await v.changesOf(h.id, { uncommittedOnly: true })).files.some(f => f.path === 'a.txt'), false);
    assert.equal((await v.diffOf(h.id, 'a.txt')).ok, false, 'the list shown is the uncommitted one: a.txt is not on it');
    r.write(wt, 'extra.txt', 'z\n');
    const again = await v.changesOf(h.id);   // within 2 s: the last base look, reused
    assert.equal(again.files.some(f => f.path === 'extra.txt'), false, 'answered from the earlier base look');
    assert.equal((await v.diffOf(h.id, 'a.txt')).ok, true, 'now the base list is the one shown');
    assert.equal((await v.diffOf(h.id, 'extra.txt')).ok, false);
  } finally { r.done(); }
});

test('a non-local folder is refused, and a closed tab takes its handles with it', async () => {
  const r = repo();
  try {
    const v = createViewer();
    assert.equal((await v.open({ dir: '\\\\attacker.example\\share' })).ok, false);
    const a = await v.open({ dir: r.dir, tabId: 'keep' });
    const b = await v.open({ dir: r.dir, tabId: 'gone' });
    const c = await v.open({ dir: r.dir });
    v.keepTabs(new Set(['keep']));
    assert.ok(v.get(a.id));
    assert.equal(v.get(b.id), null);
    assert.ok(v.get(c.id), 'a handle from the Project page belongs to no tab');
  } finally { r.done(); }
});

test('the home folder, a folder above it and a whole drive are refused; a repo inside home opens', async () => {
  const r = repo();                       // r.base stands in for home; r.dir (base/proj) is a repo in it
  const dotfiles = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-home-')));
  try {
    const home = r.base;
    const v = createViewer({ home });
    const HOME = /whole home folder/;
    const said = async dir => { const o = await v.open({ dir }); assert.equal(o.ok, false, dir); return o.error; };
    assert.match(await said(home), HOME);
    assert.match(await said(home.toUpperCase()), HOME, 'case-blind');
    assert.match(await said(path.dirname(home)), HOME, 'a folder above home');
    const drive = path.parse(home).root;
    assert.match(await said(drive), /whole drive/);
    // A drive root is refused for being one, not only for being above home.
    assert.match((await createViewer({ home: 'Q:\\nobody' }).open({ dir: drive })).error, /whole drive/);
    const proj = await v.open({ dir: r.dir, tabId: 't' });
    assert.equal(proj.ok, true, 'a repo of its own inside home still opens');
    assert.equal(await branchOf(r.dir, { home }), 'main');
    // Home is a dotfiles repo, and the conversation is in a plain folder of it: the root would be home.
    const g = (...a) => execFileSync('git', ['-C', dotfiles, ...a], { encoding: 'utf8', windowsHide: true });
    g('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(dotfiles, 'notes'));
    fs.writeFileSync(path.join(dotfiles, 'notes', 'todo.txt'), 'x\n');
    const notes = path.join(dotfiles, 'notes');
    assert.match((await createViewer({ home: dotfiles }).open({ dir: notes })).error, HOME);
    // A file link and the branch chip answer as for a conversation with no folder.
    assert.deepEqual(await locate(notes, path.join(notes, 'todo.txt'), { home: dotfiles }), { inside: false });
    assert.equal(await branchOf(notes, { home: dotfiles }), null);
    assert.deepEqual(await locate(home, path.join(r.dir, 'a.txt'), { home }), { inside: false });
    assert.equal((await locate(r.dir, path.join(r.dir, 'a.txt'), { home })).inside, true);
  } finally {
    r.done();
    fs.rmSync(dotfiles, { recursive: true, force: true });
  }
});

test('writeWatch nudges once a writing tool has finished, and never for a read', () => {
  const seen = [];
  const watch = writeWatch(cwd => seen.push(cwd));
  watch({ kind: 'tool', id: 't1', name: 'Write' }, 'C:\\p');
  watch({ kind: 'tool', id: 't2', name: 'Read' }, 'C:\\p');
  assert.deepEqual(seen, [], 'nothing until the result is in');
  watch({ kind: 'tool_result', id: 't2' }, 'C:\\p');
  watch({ kind: 'tool_result', id: 't1' }, 'C:\\p');
  watch({ kind: 'tool_result', id: 't1' }, 'C:\\p');
  assert.deepEqual(seen, ['C:\\p']);
});
