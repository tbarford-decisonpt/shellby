// Releases against real git in a temp folder (src/main/projects/release-git.js):
// what's unreleased since the last tag, and Cut release (bump, CHANGELOG,
// commit, tag, push), including every reason it stops before touching anything.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rg = require('../src/main/projects/release-git');
const { git } = require('../src/main/worktrees');

const PKG = { name: 'demo', version: '0.1.0', private: true };

function setup({ changelog = '# Changelog\n\n## 0.1.0: First\n\n### New\n- It exists.\n' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-release-')));
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const origin = path.join(base, 'origin.git');
  const dir = path.join(base, 'proj');
  fs.mkdirSync(dir);
  g(base, 'init', '-q', '--bare', '-b', 'main', origin);
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'config', 'tag.gpgSign', 'false');
  g(dir, 'config', 'commit.gpgSign', 'false');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(PKG, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'demo', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'demo', version: '0.1.0' } } }, null, 2) + '\n');
  if (changelog !== null) fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', '0.1.0: First');
  g(dir, 'tag', '-a', 'v0.1.0', '-m', '0.1.0');
  g(dir, 'remote', 'add', 'origin', origin);
  g(dir, 'push', '-q', '-u', 'origin', 'main', '--tags');
  const work = (file, subject) => {
    fs.appendFileSync(path.join(dir, file), `${subject}\n`);
    g(dir, 'add', '-A');
    g(dir, 'commit', '-qm', subject);
  };
  return { base, dir, origin, g, work, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const deps = { git, now: () => Date.parse('2026-10-06T12:00:00') };

test('reads the commits since the last tag, grouped, and suggests the version they call for', async () => {
  const t = setup();
  try {
    t.work('a.txt', 'feat: a releases card');
    t.work('a.txt', 'fix: crash on boot');
    t.work('a.txt', 'chore: tidy');
    t.g(t.dir, 'push', '-q');
    const s = await rg.readRelease(t.dir, deps);
    assert.equal(s.ok, true);
    assert.equal(s.last.tag, 'v0.1.0');
    assert.equal(s.total, 3);
    assert.deepEqual(s.groups.map(g => g.id), ['feat', 'fix', 'chore']);
    assert.equal(s.next.suggested, '0.2.0');
    assert.equal(s.next.bump, 'minor');
    assert.equal(s.branch, 'main');
    assert.equal(s.defaultBranch, 'main');
    assert.equal(s.changelog.style, 'titled');
    assert.deepEqual(s.upstream, { name: 'origin/main', behind: 0, ahead: 0 });
    assert.equal(rg.blocker(s), null);
    assert.match(s.draft.notes, /### New\n- A releases card\.\n\n### Fixed\n- Crash on boot\./);
  } finally { t.done(); }
});

test('Cut release bumps, writes the CHANGELOG, commits, tags and pushes both together', async () => {
  const t = setup();
  try {
    t.work('a.txt', 'feat: a releases card');
    const s = await rg.readRelease(t.dir, deps);
    const r = await rg.cutRelease(t.dir, { version: '0.2.0', title: 'Releases', notes: '### New\n- **Releases.** A card.', head: s.head, push: true }, deps);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.tag, 'v0.2.0');
    assert.equal(r.pushed, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'package.json'), 'utf8')).version, '0.2.0');
    const lock = JSON.parse(fs.readFileSync(path.join(t.dir, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, '0.2.0');
    assert.equal(lock.packages[''].version, '0.2.0');
    assert.match(fs.readFileSync(path.join(t.dir, 'CHANGELOG.md'), 'utf8'), /^# Changelog\n\n## 0\.2\.0: Releases\n\n### New\n- \*\*Releases\.\*\* A card\.\n\n## 0\.1\.0: First/);
    assert.equal(t.g(t.dir, 'log', '-1', '--format=%s'), '0.2.0: Releases');
    assert.equal(t.g(t.dir, 'status', '--porcelain'), '');
    assert.equal(t.g(t.dir, 'cat-file', '-t', 'v0.2.0'), 'tag'); // annotated
    // Both reached the remote.
    assert.equal(t.g(t.origin, 'rev-parse', 'refs/tags/v0.2.0^{commit}'), r.commit);
    assert.equal(t.g(t.origin, 'rev-parse', 'main'), r.commit);
    const after = await rg.readRelease(t.dir, deps);
    assert.equal(after.total, 0);
    assert.equal(after.last.tag, 'v0.2.0');
    assert.equal(after.unpushedTag, null);
  } finally { t.done(); }
});

test('without push it stays on this PC, says so, and Push sends it later', async () => {
  const t = setup();
  try {
    t.work('a.txt', 'fix: one');
    const s = await rg.readRelease(t.dir, deps);
    const r = await rg.cutRelease(t.dir, { version: '0.1.1', title: '', notes: '- One.', head: s.head, push: false }, deps);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.pushed, false);
    assert.equal(t.g(t.dir, 'log', '-1', '--format=%s'), 'chore: release v0.1.1');
    const waiting = await rg.readRelease(t.dir, deps);
    assert.equal(waiting.unpushedTag, 'v0.1.1');
    assert.match(rg.blocker(waiting), /v0\.1\.1 is tagged on this PC but not pushed/);
    const p = await rg.pushRelease(t.dir, { tag: 'v0.1.1' }, deps);
    assert.equal(p.ok, true, p.error);
    assert.equal(t.g(t.origin, 'rev-parse', 'refs/tags/v0.1.1^{commit}'), r.commit);
    assert.equal((await rg.readRelease(t.dir, deps)).unpushedTag, null);
  } finally { t.done(); }
});

test('a CHANGELOG entry already written (by you or Claude) goes in as it is', async () => {
  const t = setup();
  try {
    t.work('a.txt', 'feat: thing');
    const cl = path.join(t.dir, 'CHANGELOG.md');
    fs.writeFileSync(cl, fs.readFileSync(cl, 'utf8').replace('## 0.1.0', '## 0.2.0: Hand-written\n\nWords from Claude.\n\n## 0.1.0'));
    const s = await rg.readRelease(t.dir, deps);
    assert.equal(s.changelog.hasEntry, true);
    assert.deepEqual(s.changes, { release: ['CHANGELOG.md'], other: [] });
    assert.equal(rg.blocker(s), null);
    const r = await rg.cutRelease(t.dir, { version: '0.2.0', title: 'Hand-written', notes: '', head: s.head, push: false }, deps);
    assert.equal(r.ok, true, r.error);
    const text = fs.readFileSync(cl, 'utf8');
    assert.equal(text.match(/## 0\.2\.0/g).length, 1);
    assert.match(text, /Words from Claude\./);
    assert.equal(t.g(t.dir, 'status', '--porcelain'), '');
  } finally { t.done(); }
});

test('a release already prepared and committed (package.json ahead of the tag) is just tagged', async () => {
  const t = setup();
  try {
    t.work('a.txt', 'fix: one');
    fs.writeFileSync(path.join(t.dir, 'package.json'), JSON.stringify({ ...PKG, version: '0.1.1' }, null, 2) + '\n');
    const cl = path.join(t.dir, 'CHANGELOG.md');
    fs.writeFileSync(cl, fs.readFileSync(cl, 'utf8').replace('## 0.1.0', '## 0.1.1: Prepared\n\n- One.\n\n## 0.1.0'));
    t.g(t.dir, 'commit', '-qam', '0.1.1: Prepared');
    const head = t.g(t.dir, 'rev-parse', 'HEAD');
    const s = await rg.readRelease(t.dir, deps);
    assert.equal(s.next.suggested, '0.1.1');
    assert.equal(s.next.prepared, true);
    const r = await rg.cutRelease(t.dir, { version: '0.1.1', title: 'Prepared', notes: '', head: s.head, push: false }, deps);
    assert.equal(r.ok, true, r.error);
    // Only the lock file still said 0.1.0, so that's all the commit holds.
    assert.equal(t.g(t.dir, 'diff', '--name-only', head, 'HEAD'), 'package-lock.json');
    assert.equal(t.g(t.dir, 'rev-parse', 'v0.1.1^{commit}'), r.commit);
  } finally { t.done(); }
});

test('it stops, touching nothing, on another branch, with other changes, behind, or moved since the draft', async () => {
  const t = setup();
  try {
    t.work('a.txt', 'feat: one');
    t.g(t.dir, 'push', '-q');
    const s = await rg.readRelease(t.dir, deps);
    const cut = (o = {}) => rg.cutRelease(t.dir, { version: '0.2.0', title: 'x', notes: '- x', head: s.head, push: false, ...o }, deps);
    const untouched = () => assert.equal(t.g(t.dir, 'status', '--porcelain'), '') || assert.equal(t.g(t.dir, 'tag', '--list', 'v0.2.0'), '');

    fs.writeFileSync(path.join(t.dir, 'a.txt'), 'edited\n');
    assert.match((await cut()).error, /uncommitted changes that aren't part of a release \(a\.txt\)/);
    t.g(t.dir, 'checkout', '-q', '--', 'a.txt');
    untouched();

    t.g(t.dir, 'checkout', '-q', '-b', 'topic');
    assert.match((await cut()).error, /Releases are cut from main, and this clone is on topic/);
    t.g(t.dir, 'checkout', '-q', 'main');

    assert.match((await cut({ version: '0.1.0' })).error, /after 0\.1\.0/);
    assert.match((await cut({ version: 'next' })).error, /version number/);
    assert.equal((await cut({ head: 'b'.repeat(40) })).stale, true);
    untouched();

    // Someone else pushed: behind origin/main.
    const other = path.join(t.base, 'other');
    execFileSync('git', ['clone', '-q', t.origin, other], { windowsHide: true });
    execFileSync('git', ['-C', other, '-c', 'user.email=o@example.com', '-c', 'user.name=O', 'commit', '-q', '--allow-empty', '-m', 'fix: theirs'], { windowsHide: true });
    execFileSync('git', ['-C', other, 'push', '-q'], { windowsHide: true });
    // Not fetched yet: the card can't know, but Cut release fetches first.
    assert.equal(rg.blocker(await rg.readRelease(t.dir, deps)), null);
    assert.match((await cut()).error, /1 commit behind origin\/main/);
    untouched();
  } finally { t.done(); }
});

test('a project with no CHANGELOG gets a Keep a Changelog one; no tags yet is a first release', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-release-')));
  const dir = path.join(base, 'p');
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  try {
    fs.mkdirSync(dir);
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'T');
    g('config', 'tag.gpgSign', 'false');
    g('config', 'commit.gpgSign', 'false');
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
    g('add', '-A');
    g('commit', '-qm', 'feat: first');
    const s = await rg.readRelease(dir, deps);
    assert.equal(s.last, null);
    assert.equal(s.file, null);
    assert.equal(s.next.suggested, '0.1.0');
    assert.equal(s.changelog.exists, false);
    assert.equal(s.remote, null);
    const r = await rg.cutRelease(dir, { version: '0.1.0', title: '', notes: '### Added\n- First.', head: s.head, push: true }, deps);
    assert.equal(r.ok, true, r.error);
    assert.match(r.pushError, /no remote/);
    assert.equal(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), '# Changelog\n\n## [0.1.0] - 2026-10-06\n\n### Added\n- First.\n');
    assert.equal(g('tag', '--list'), 'v0.1.0');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the repository\'s own hooks never run', async () => {
  const t = setup();
  try {
    t.work('a.txt', 'fix: one');
    const hooks = path.join(t.dir, '.git', 'hooks');
    const marker = path.join(t.base, 'hook-ran');
    for (const name of ['pre-commit', 'commit-msg', 'pre-push']) fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\nexit 1\n`, { mode: 0o755 });
    const s = await rg.readRelease(t.dir, deps);
    const r = await rg.cutRelease(t.dir, { version: '0.1.1', title: 'x', notes: '- x', head: s.head, push: true }, deps);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.pushed, true);
    assert.equal(fs.existsSync(marker), false);
  } finally { t.done(); }
});

test('a CHANGELOG that is a link is never written through, and nothing is left half-done', async t0 => {
  const t = setup({ changelog: null });
  try {
    const outside = path.join(t.base, 'outside.md');
    fs.writeFileSync(outside, '# Not yours\n');
    try { fs.symlinkSync(outside, path.join(t.dir, 'CHANGELOG.md'), 'file'); } catch { return t0.skip('symlinks need Developer Mode here'); }
    t.g(t.dir, 'add', '-A');
    t.g(t.dir, 'commit', '-qm', 'docs: link');
    t.work('a.txt', 'fix: one');
    const s = await rg.readRelease(t.dir, deps);
    const r = await rg.cutRelease(t.dir, { version: '0.1.1', title: 'x', notes: '- x', head: s.head, push: false }, deps);
    assert.equal(r.ok, false);
    assert.match(r.error, /CHANGELOG\.md is a link/);
    assert.equal(fs.readFileSync(outside, 'utf8'), '# Not yours\n');
    assert.equal(t.g(t.dir, 'status', '--porcelain'), '');
    assert.equal(t.g(t.dir, 'tag', '--list', 'v0.1.1'), '');
  } finally { t.done(); }
});

test('parsers: status -z with renames, and log records', () => {
  assert.deepEqual(rg.parseChanged(' M package.json\0R  new.md\0old.md\0M  CHANGELOG.md\0'), ['package.json', 'new.md', 'CHANGELOG.md']);
  const sha = 'c'.repeat(40);
  assert.deepEqual(rg.parseLog(`${sha}\x1fT\x1f1700000000\x1ffeat: x\x1fbody\n\x1e\n`), [{ sha, author: 'T', at: 1700000000000, subject: 'feat: x', body: 'body\n' }]);
});
