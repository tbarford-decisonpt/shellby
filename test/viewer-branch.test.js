// The file viewer's branch handles (main's viewer.js) against real git repos: a branch
// nothing has checked out, read from git alone. Its own commits since it left main, each
// diff, its tree and its files, with nothing run or written while looking.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createViewer, MAX_BYTES, TREE_MAX } = require('../src/main/viewer');

const FEAT = 'refs/heads/feat';

// The git commands run while fn does, as GIT_TRACE logs them ("ls-tree -r -z ...", "status ..."):
// git() hands the viewer's calls process.env as it is at the call.
async function gitRuns(dir, fn) {
  const log = path.join(dir, `trace-${process.hrtime.bigint()}.log`);
  const had = process.env.GIT_TRACE;
  process.env.GIT_TRACE = log;
  try { await fn(); } finally { if (had === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = had; }
  const said = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return said.split('\n').map(l => /trace: built-in: git (.*?)\r?$/.exec(l)?.[1]).filter(Boolean);
}

// A worktree record made by hand, as a hostile repo could: git lists `folder` as one of its worktrees
// (its gitdir names folder/.git, which must exist for git not to call it prunable).
function plant(r, name, folder) {
  const rec = path.join(r.dir, '.git', 'worktrees', name);
  fs.mkdirSync(rec, { recursive: true });
  fs.writeFileSync(path.join(rec, 'gitdir'), `${path.join(folder, '.git').split(path.sep).join('/')}\n`);
  fs.writeFileSync(path.join(rec, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(rec, 'commondir'), '../..\n');
}

// A loose object deleted, as a damaged repo or a partial clone lacks it. spec: anything rev-parse takes.
function dropObject(r, spec) {
  const sha = r.g(r.dir, 'rev-parse', spec).trim();
  fs.rmSync(path.join(r.dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)));
}

function repo() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-branch-')));
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
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  let n = 0;
  // Commits made in a worktree that then goes, so nothing has the branch checked out.
  const commitIn = (wt, files) => {
    for (const [f, s] of Object.entries(files)) write(wt, f, s);
    g(wt, 'add', '-A');
    g(wt, 'commit', '-qm', 'work');
    g(dir, 'worktree', 'remove', '--force', wt);
  };
  const branch = (name, files, { orphan = false } = {}) => {
    const wt = path.join(base, `made-${n++}`);
    if (orphan) {
      g(dir, 'worktree', 'add', '-q', '--detach', wt);
      g(wt, 'checkout', '-q', '--orphan', name);
      g(wt, 'rm', '-rqf', '.');
    } else {
      g(dir, 'worktree', 'add', '-q', '-b', name, wt, 'main');
    }
    commitIn(wt, files);
  };
  const commitOn = (name, files) => {
    const wt = path.join(base, `made-${n++}`);
    g(dir, 'worktree', 'add', '-q', wt, name);
    commitIn(wt, files);
  };
  return { base, dir, g, write, branch, commitOn, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('a branch: its own commits since it left main, each diff, and nothing else', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'a.txt': 'one\nTWO\n', 'docs/new.md': '# new\n' });
    r.write(r.dir, 'src/keep.js', 'const k = 2;\n');           // main moves on after the branch left
    r.g(r.dir, 'commit', '-qam', 'main moves on');
    r.write(r.dir, 'a.txt', 'uncommitted in the checkout\n');  // and has work of its own on disk
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    assert.equal(b.ok, true);
    assert.equal(b.kind, 'branch');
    assert.equal(b.branch, 'feat');
    assert.equal(b.base, 'main');
    assert.equal(b.name, 'proj');
    assert.equal(b.git, true);
    assert.equal(b.root.toLowerCase(), r.dir.toLowerCase());
    const c = await v.changesOf(b.id);
    assert.equal(c.ok, true);
    assert.equal(c.against, 'main');
    assert.deepEqual(Object.fromEntries(c.files.map(f => [f.path, f.status])), { 'a.txt': 'M', 'docs/new.md': 'A' });
    const only = await v.changesOf(b.id, { uncommittedOnly: true });
    assert.deepEqual(only.files.map(f => f.path).sort(), ['a.txt', 'docs/new.md'], 'Just uncommitted does not apply to a branch');
    const d = await v.diffOf(b.id, 'a.txt');
    assert.equal(d.ok, true);
    assert.match(d.patch, /^-two$/m);
    assert.match(d.patch, /^\+TWO$/m);
    assert.equal((await v.diffOf(b.id, 'src/keep.js')).ok, false, "main's own change is not the branch's");
    assert.equal((await v.diffOf(b.id, 'A.TXT')).ok, false, "a branch's paths are git's, case and all");
  } finally { r.done(); }
});

test("All files is the commit's tree; Whole file reads only a path in it", async () => {
  const r = repo();
  try {
    r.branch('feat', { 'docs/new.md': '﻿# new\n' });
    r.write(r.dir, 'loose.txt', 'untracked in the checkout\n');
    r.write(r.dir, 'ignored/x.txt', 'ignored in the checkout\n');
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    const t = await v.treeOf(b.id);
    assert.equal(t.ok, true);
    assert.deepEqual(t.entries.slice().sort(), ['.gitignore', 'a.txt', 'docs/', 'docs/new.md', 'src/', 'src/keep.js']);
    assert.deepEqual(await v.read(b.id, 'docs/new.md'), { ok: true, text: '# new\n', size: 9 }, 'BOM stripped, size as stored');
    // cat-file -s answers for a folder too (a tree's size): only the tree's own file paths get that far.
    for (const rel of ['src', 'docs/', 'A.TXT', '../proj/a.txt', 'HEAD:a.txt', 'docs\\new.md', 'loose.txt', 'ignored/x.txt', '', 42]) {
      assert.deepEqual(await v.read(b.id, rel), { ok: false, missing: true }, String(rel));
    }
  } finally { r.done(); }
});

test('a blob over 2 MB and a binary one say so', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'big.log': Buffer.alloc(MAX_BYTES + 1, 0x61), 'img.png': Buffer.from([0x89, 0x50, 0x00, 0x47]) });
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    assert.deepEqual(await v.read(b.id, 'big.log'), { ok: false, tooBig: true, size: MAX_BYTES + 1 });
    assert.deepEqual(await v.read(b.id, 'img.png'), { ok: false, binary: true, size: 4 });
  } finally { r.done(); }
});

test('a branch with no history in common with main is compared with the empty tree', async () => {
  const r = repo();
  try {
    r.branch('lonely', { 'z.txt': 'z\n' }, { orphan: true });
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: 'refs/heads/lonely', base: 'main' });
    const c = await v.changesOf(b.id);
    assert.deepEqual(c.files.map(f => `${f.path}:${f.status}`), ['z.txt:A']);
    assert.match((await v.diffOf(b.id, 'z.txt')).patch, /^\+z$/m);
  } finally { r.done(); }
});

test('new commits show once a turn ends, and a deleted branch answers branchGone', async t => {
  const r = repo();
  try {
    r.branch('feat', { 'one.txt': '1\n' });
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    // The clock stands still from here, so "within 2 s" holds however long the commit below takes on a busy runner.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    assert.deepEqual((await v.changesOf(b.id)).files.map(f => f.path), ['one.txt']);
    r.commitOn('feat', { 'two.txt': '2\n' });
    assert.deepEqual(v.staleFor(r.dir), [], "a tool's result never nudges a branch");
    assert.deepEqual((await v.changesOf(b.id)).files.map(f => f.path), ['one.txt'], 'within 2 s the last look answers');
    assert.deepEqual(v.staleFor(r.base, { commits: true }), [], 'a folder above the repo is none of its worktrees');
    assert.deepEqual(v.staleFor(path.join(r.dir, 'src'), { commits: true }), [b.id], 'a turn end in the repo does');
    // Asked together, as Refresh asks: All files is read at the tip as it is now, not where the last look left it.
    const [c, tree] = await Promise.all([v.changesOf(b.id), v.treeOf(b.id)]);
    assert.deepEqual(c.files.map(f => f.path).sort(), ['one.txt', 'two.txt']);
    assert.ok(tree.entries.includes('two.txt'), 'and its tree is read at the new tip');
    assert.equal((await v.read(b.id, 'two.txt')).text, '2\n');
    r.g(r.dir, 'branch', '-D', 'feat');
    v.staleFor(r.dir, { commits: true });
    assert.deepEqual(await v.changesOf(b.id), { ok: false, branchGone: true, error: 'This branch is gone.' });
  } finally { r.done(); }
});

test('looking at a branch runs none of its hooks and writes no index', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'a.txt': 'one\nTWO\n' });
    // Pinned here, so a core.hooksPath in the machine's own config can't make this pass by itself
    // (changes.test.js shows the same hook does run for a turn's snapshot).
    r.g(r.dir, 'config', 'core.hooksPath', '.git/hooks');
    const marker = path.join(r.base, 'HOOK_RAN').split(path.sep).join('/');
    fs.writeFileSync(path.join(r.dir, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    const index = path.join(r.dir, '.git', 'index');
    const before = fs.statSync(index).mtimeMs;
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    assert.equal((await v.changesOf(b.id)).ok, true);
    assert.equal((await v.diffOf(b.id, 'a.txt')).ok, true);
    assert.equal((await v.treeOf(b.id)).ok, true);
    assert.equal((await v.read(b.id, 'a.txt')).ok, true);
    assert.equal(fs.existsSync(marker), false, 'post-index-change never ran');
    assert.equal(fs.statSync(index).mtimeMs, before, '.git/index was not written');
  } finally { r.done(); }
});

test('a ref is only ever a full refs/heads/ name: a branch called -x opens, a short or odd name is refused', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'x.txt': 'x\n' });
    // git branch refuses "-x"; update-ref makes it anyway, as a hand edit or another tool could.
    r.g(r.dir, 'update-ref', 'refs/heads/-x', r.g(r.dir, 'rev-parse', FEAT).trim());
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: 'refs/heads/-x', base: 'main' });
    assert.equal(b.ok, true);
    assert.equal(b.branch, '-x');
    assert.deepEqual((await v.changesOf(b.id)).files.map(f => f.path), ['x.txt']);
    for (const ref of ['-x', 'feat', 'refs/tags/v1', 'refs/heads/feat\nx', 'HEAD', null]) {
      assert.equal((await v.openBranch({ root: r.dir, ref, base: 'main' })).ok, false, String(ref));
    }
    assert.deepEqual(await v.openBranch({ root: r.dir, ref: 'refs/heads/nope', base: 'main' }), { ok: false, gone: true, error: 'That worktree or branch is gone.' });
  } finally { r.done(); }
});

test('a path with spaces and é: in the changes, its diff, All files and Whole file', async () => {
  const r = repo();
  try {
    const odd = 'd/sp ace/é.md';
    r.branch('feat', { [odd]: '# é\n', 'a.txt': 'one\nTWO\n' });
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    const c = await v.changesOf(b.id);
    assert.deepEqual(Object.fromEntries(c.files.map(f => [f.path, f.status])), { 'a.txt': 'M', [odd]: 'A' });
    const d = await v.diffOf(b.id, odd);
    assert.equal(d.ok, true);
    assert.match(d.patch, /^\+# é$/m);
    const t = await v.treeOf(b.id);
    assert.ok(t.entries.includes(odd) && t.entries.includes('d/sp ace/'), 'listed, with its folders');
    assert.deepEqual(await v.read(b.id, odd), { ok: true, text: '# é\n', size: Buffer.byteLength('# é\n') });
  } finally { r.done(); }
});

test("no shared history compares with the empty tree; a base git can't find, or a diff it can't make, says so", async () => {
  const r = repo();
  try {
    r.branch('feat', { 'x.txt': 'x\n' });
    r.g(r.dir, 'branch', 'same'); // at main: nothing of its own
    const v = createViewer();
    const same = await v.openBranch({ root: r.dir, ref: 'refs/heads/same', base: 'main' });
    assert.deepEqual(await v.changesOf(same.id), { ok: true, files: [], more: 0, against: 'main' }, 'nothing changed is no error');
    // merge-base exits 128 here, not 1: the branch isn't shown as all of it added "from no-such-base".
    const lost = await v.openBranch({ root: r.dir, ref: FEAT, base: 'no-such-base' });
    assert.deepEqual(await v.changesOf(lost.id), { ok: false, error: "Couldn't read changes." });
    dropObject(r, `${FEAT}:x.txt`); // --numstat needs the blob
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    assert.deepEqual(await v.changesOf(b.id), { ok: false, error: "Couldn't read changes." }, 'a diff git could not make is not "nothing changed"');
  } finally { r.done(); }
});

test("a branch's tree is listed once per commit, and a listing git couldn't make isn't run again on each read", async () => {
  const r = repo();
  try {
    r.branch('feat', { 'docs/new.md': '# new\n' });
    r.branch('broken', { 'deep/x.txt': 'x\n' });
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    let at;
    const once = await gitRuns(r.base, async () => { at = await Promise.all([v.treeOf(b.id), v.treeOf(b.id), v.read(b.id, 'a.txt')]); });
    assert.ok(at[0].entries.includes('docs/new.md') && at[1].entries.includes('docs/new.md'));
    assert.equal(at[2].text, 'one\ntwo\n');
    assert.equal(once.filter(l => l.startsWith('ls-tree')).length, 1, 'three asks at once, one ls-tree');
    // A tree object git can't read (a damaged repo): ls-tree -r exits 1, and that is kept for the commit.
    dropObject(r, 'refs/heads/broken:deep');
    const k = await v.openBranch({ root: r.dir, ref: 'refs/heads/broken', base: 'main' });
    const failed = await gitRuns(r.base, async () => {
      assert.deepEqual(await v.treeOf(k.id), { ok: true, entries: [] });
      assert.deepEqual(await v.treeOf(k.id), { ok: true, entries: [] });
      assert.deepEqual(await v.read(k.id, 'a.txt'), { ok: false, error: "Couldn't read that." });
    });
    assert.equal(failed.filter(l => l.startsWith('ls-tree')).length, 1, 'tried once for that commit');
  } finally { r.done(); }
});

test('a branch is never nudged from a folder too wide to browse, even one a planted worktree record names', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'x.txt': 'x\n' });
    const home = path.join(r.base, 'home');
    fs.mkdirSync(path.join(home, '.git'), { recursive: true });
    plant(r, 'h', home);
    assert.match(r.g(r.dir, 'worktree', 'list', '--porcelain'), /^worktree .*\/home$/m, 'git lists it as a worktree');
    const v = createViewer({ home });
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    // What fileIndex.forget(home) asks when a turn ends in a conversation left in the home folder.
    assert.deepEqual(v.staleFor(home, { commits: true }), [], 'a turn end in the home folder nudges nothing');
    assert.deepEqual(v.staleFor(path.join(home, 'code'), { commits: true }), [], 'nor one in a folder under it: the record is no worktree of ours');
    assert.deepEqual(v.staleFor(r.dir, { commits: true }), [b.id], "a turn end in the repo's own checkout still does");
  } finally { r.done(); }
});

test('nothing is fetched while looking: a repo that says it is a partial clone runs no program and gains no pack', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'a.txt': 'one\nTWO\n', 'far.txt': 'far\n' });
    const side = path.join(r.base, 'side');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'side', side, 'main');
    r.write(side, 'a.txt', 'changed in side\n');
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    assert.equal((await v.changesOf(b.id)).ok, true, 'read while every object is here');
    // Then two blobs go missing, and the repo's own config names a promisor remote whose "ssh" is a
    // program of its choosing: a lazy fetch would run it. Each read of a missing blob must fail instead.
    dropObject(r, 'main:a.txt');
    dropObject(r, `${FEAT}:far.txt`);
    const marker = path.join(r.base, 'FETCHED').split(path.sep).join('/');
    for (const [key, value] of [
      ['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'],
      ['remote.origin.url', 'ssh://evil.invalid/x'], ['remote.origin.promisor', 'true'],
      ['core.sshCommand', `echo ran > "${marker}"; exit 1`],
    ]) r.g(r.dir, 'config', key, value);
    const packs = () => fs.readdirSync(path.join(r.dir, '.git', 'objects', 'pack')).sort();
    const before = packs();
    assert.deepEqual(await v.diffOf(b.id, 'a.txt'), { ok: false, error: "Couldn't read that." }, "a diff that needs main's a.txt: never git's own words");
    assert.deepEqual(await v.read(b.id, 'far.txt'), { ok: false, error: "Couldn't read that." }, 'Whole file of a blob it lacks');
    v.staleFor(r.dir, { commits: true });
    assert.deepEqual(await v.changesOf(b.id), { ok: false, error: "Couldn't read changes." }, "the branch's changes, told apart from nothing changed");
    const f = await v.open({ dir: side });
    assert.deepEqual(await v.changesOf(f.id), { ok: false, error: "Couldn't read changes." }, "a worktree's changes since main (snapshot, merge-base, diff)");
    assert.equal(fs.existsSync(marker), false, "the repo's program never ran");
    assert.deepEqual(packs(), before, 'and no pack was fetched');
  } finally { r.done(); }
});

test('a branch with more paths than All files lists still reads every one of them in Whole file', async () => {
  const r = repo();
  try {
    // A tree of TREE_MAX + 1 paths under p/ and one after them (zz/), made without writing files: one blob per
    // content, an index fed to update-index, write-tree, commit-tree and update-ref.
    const run = (args, input, env) => execFileSync('git', ['-C', r.dir, ...args], { encoding: 'utf8', input, env: { ...process.env, ...env }, timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
    const filler = run(['hash-object', '-w', '--stdin'], 'filler\n');
    const last = run(['hash-object', '-w', '--stdin'], 'the last one\n');
    const lines = [];
    for (let i = 0; i <= TREE_MAX; i++) lines.push(`100644 ${filler}\tp/${String(i).padStart(6, '0')}.txt`);
    lines.push(`100644 ${last}\tzz/last.txt`);
    const env = { GIT_INDEX_FILE: path.join(r.base, 'big-index') };
    run(['update-index', '--add', '--index-info'], `${lines.join('\n')}\n`, env);
    const tree = run(['write-tree'], undefined, env);
    const commit = run(['commit-tree', tree, '-p', 'main', '-m', 'big']);
    run(['update-ref', 'refs/heads/big', commit]);
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: 'refs/heads/big', base: 'main' });
    assert.equal(b.ok, true);
    const t = await v.treeOf(b.id);
    assert.ok(t.entries.includes('p/000000.txt'), 'All files lists the first paths');
    assert.ok(!t.entries.includes('zz/last.txt'), 'and stops at the cap: the path past it is not listed');
    assert.deepEqual(await v.read(b.id, 'zz/last.txt'), { ok: true, text: 'the last one\n', size: 13 }, 'but Whole file reads it');
  } finally { r.done(); }
});
