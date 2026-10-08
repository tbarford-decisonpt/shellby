// Issue -> copy -> pull request, against real git: a bare repository stands in
// for GitHub (the clone's origin says github.com; only fetch and push are sent
// to the bare one, through the env the steps are given), and a pretend API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const worktrees = require('../src/main/worktrees');
const secretscan = require('../src/main/secretscan');
const { makeCopy, openPullRequest, insideHome } = require('../src/main/github/pullrequest');

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-pr-')));
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const bare = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const dir = path.join(base, 'crab');
  const home = path.join(base, 'home');
  fs.mkdirSync(seed);
  g(base, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) g(seed, 'config', k, v);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  g(seed, 'add', '-A');
  g(seed, 'commit', '-qm', 'init');
  g(seed, 'push', '-q', bare.replace(/\\/g, '/'), 'main');
  g(base, 'clone', '-q', bare.replace(/\\/g, '/'), dir);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) g(dir, 'config', k, v);
  g(dir, 'remote', 'set-url', 'origin', 'https://github.com/me/crab.git');
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${bare.replace(/\\/g, '/')}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/me/crab.git' };
  return { base, bare, dir, home, env, g, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// What api.js throws for a 422: GitHub's message says only "Validation Failed".
const invalid = detail => Object.assign(new Error('Validation Failed'), { status: 422, detail });

// A pretend GitHub: the repository's default branch, and the pull requests it was asked for.
function fakeGh({ fail = null } = {}) {
  const posted = [];
  return {
    posted,
    get: async p => {
      if (p === '/repos/me/crab') return { default_branch: 'main' };
      if (p.startsWith('/repos/me/crab/pulls?')) return posted.filter(x => x.ok).map(x => ({ number: 7, draft: x.body.draft }));
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
    post: async (p, body) => {
      const err = fail?.(body, posted);
      posted.push({ path: p, body, ok: !err });
      if (err) throw err;
      return { number: 7, draft: body.draft };
    },
  };
}

const copyDeps = (s, gh, roots = { 'me/crab': s.dir }) => ({
  findRoot: async r => roots[r] || null, gh, git: worktrees.git, create: worktrees.create, home: s.home, env: s.env,
});
const prDeps = (s, gh) => ({ gh, git: worktrees.git, home: s.home, env: s.env, web: 'https://github.com' });

test('a copy starts from the default branch on GitHub, not from what your checkout is doing', async () => {
  const s = setup();
  try {
    s.g(s.dir, 'checkout', '-q', '-b', 'half-done');
    fs.writeFileSync(path.join(s.dir, 'wip.txt'), 'mine\n');
    s.g(s.dir, 'add', '-A');
    s.g(s.dir, 'commit', '-qm', 'wip');
    const r = await makeCopy({ repo: 'me/crab', slug: 'issue-42' }, copyDeps(s, fakeGh()));
    assert.equal(r.ok, true, r.error);
    assert.match(r.branch, /^shellby\/issue-42-[0-9a-f]{6}$/);
    assert.equal(r.base, 'main');
    assert.equal(r.repo, 'me/crab');
    assert.ok(insideHome(r.path, s.home));
    assert.equal(fs.existsSync(path.join(r.path, 'wip.txt')), false, 'your half-done work stays out of it');
    assert.equal(s.g(s.dir, 'symbolic-ref', '--short', 'HEAD'), 'half-done', 'your checkout is untouched');
  } finally { s.done(); }
});

test('a copy needs the repository cloned here, and a real repository name', async () => {
  const s = setup();
  try {
    assert.match((await makeCopy({ repo: 'pal/other', slug: 'x' }, copyDeps(s, fakeGh()))).error, /isn't cloned on this PC/);
    assert.match((await makeCopy({ repo: '../../etc', slug: 'x' }, copyDeps(s, fakeGh()))).error, /isn't a GitHub repository/);
    assert.equal(fs.existsSync(s.home), false, 'nothing was made');
  } finally { s.done(); }
});

test('the pull request step commits what is left, pushes only its branch, and opens a draft', async () => {
  const s = setup();
  try {
    const gh = fakeGh();
    const copy = await makeCopy({ repo: 'me/crab', slug: 'issue-42' }, copyDeps(s, gh));
    // Claude committed one thing and left another uncommitted; a hook that would refuse both never runs.
    fs.writeFileSync(path.join(copy.path, 'fix.txt'), 'fixed\n');
    s.g(copy.path, 'add', '-A');
    s.g(copy.path, 'commit', '-qm', 'Fix it');
    fs.writeFileSync(path.join(copy.path, 'also.txt'), 'and this\n');
    const hooks = path.join(s.base, 'hooks');
    fs.mkdirSync(hooks);
    for (const h of ['pre-commit', 'pre-push']) fs.writeFileSync(path.join(hooks, h), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    s.g(s.dir, 'config', 'core.hooksPath', hooks.replace(/\\/g, '/'));

    const r = await openPullRequest({ folder: copy.path, title: 'Crab falls off the window', body: 'Closes #42', draft: true }, prDeps(s, gh));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r, { ok: true, url: 'https://github.com/me/crab/pull/7', number: 7, branch: copy.branch, repo: 'me/crab', base: 'main', draft: true, existing: false });
    assert.deepEqual(gh.posted[0], { path: '/repos/me/crab/pulls', ok: true, body: { title: 'Crab falls off the window', head: copy.branch, base: 'main', body: 'Closes #42', draft: true } });
    assert.equal(s.g(copy.path, 'status', '--porcelain'), '', 'the leftover was committed');
    assert.equal(s.g(s.bare, 'rev-parse', `refs/heads/${copy.branch}`), s.g(copy.path, 'rev-parse', 'HEAD'), 'the branch is on GitHub');
    assert.equal(s.g(s.bare, 'log', '--format=%s', '-1', 'main'), 'init', 'main is untouched');

    // Retried after it had already gone through: the same pull request, not an error.
    const again = await openPullRequest({ folder: copy.path, title: 'Crab falls off the window', draft: true },
      prDeps(s, { ...gh, post: async () => { throw invalid('A pull request already exists for me:x.'); } }));
    assert.equal(again.ok, true, again.error);
    assert.equal(again.number, 7);
    assert.equal(again.existing, true, 'so it is not paid for twice');
  } finally { s.done(); }
});

test('no changes, no pull request', async () => {
  const s = setup();
  try {
    const gh = fakeGh();
    const copy = await makeCopy({ repo: 'me/crab', slug: 'nothing' }, copyDeps(s, gh));
    const r = await openPullRequest({ folder: copy.path, title: 'Nothing', draft: true }, prDeps(s, gh));
    assert.match(r.error, /nothing to propose/);
    assert.equal(gh.posted.length, 0);
  } finally { s.done(); }
});

test('where drafts aren\'t allowed, it opens an ordinary pull request', async () => {
  const s = setup();
  try {
    const gh = fakeGh({ fail: body => (body.draft ? invalid('Draft pull requests are not supported in this repository.') : null) });
    const copy = await makeCopy({ repo: 'me/crab', slug: 'free-plan' }, copyDeps(s, gh));
    fs.writeFileSync(path.join(copy.path, 'x.txt'), 'x\n');
    const r = await openPullRequest({ folder: copy.path, title: 'X', draft: true }, prDeps(s, gh));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.draft, false);
    assert.deepEqual(gh.posted.map(p => p.body.draft), [true, false]);
  } finally { s.done(); }
});

test('the pull request step refuses anything but one of Shellby\'s copies', async () => {
  const s = setup();
  try {
    const gh = fakeGh();
    fs.writeFileSync(path.join(s.dir, 'x.txt'), 'x\n');
    assert.match((await openPullRequest({ folder: s.dir, title: 'X' }, prDeps(s, gh))).error, /only be opened from a copy Shellby made/);
    // Inside the folder of copies, but not on a shellby/ branch.
    const other = path.join(s.home, 'zzz', 'crab');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    s.g(s.dir, 'worktree', 'add', '-q', '-b', 'mine', other);
    fs.writeFileSync(path.join(other, 'y.txt'), 'y\n');
    assert.match((await openPullRequest({ folder: other, title: 'Y' }, prDeps(s, gh))).error, /one of Shellby's branches/);
    assert.equal(gh.posted.length, 0);
    assert.throws(() => s.g(s.bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/mine'), 'nothing was pushed');
  } finally { s.done(); }
});

test('what `git add -A` swept into the commit is scanned for secrets, and a no pushes nothing', async () => {
  const s = setup();
  try {
    const gh = fakeGh();
    const copy = await makeCopy({ repo: 'me/crab', slug: 'leaky' }, copyDeps(s, gh));
    fs.writeFileSync(path.join(copy.path, 'config.js'), `module.exports = "${'AKIA' + 'IOSFODNN7EXAMPLE'}";\n`);
    const seen = [];
    const gate = async (root, o) => { seen.push({ root, ...o, files: (await secretscan.outgoing(root, undefined, o)).findings.map(f => f.file) }); return { ok: false, cancelled: true, secrets: 1, error: 'Not pushed: it had something that looks like a secret.' }; };
    const r = await openPullRequest({ folder: copy.path, title: 'Leak', draft: true }, { ...prDeps(s, gh), gate });
    assert.deepEqual(r, { ok: false, cancelled: true, secrets: 1, error: 'Not pushed: it had something that looks like a secret.' });
    assert.deepEqual(seen.map(x => [x.rev, x.remote, x.files]), [[`refs/heads/${copy.branch}`, 'origin', ['config.js']]]);
    assert.equal(gh.posted.length, 0, 'no pull request');
    assert.throws(() => s.g(s.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${copy.branch}`), 'nothing was pushed');
  } finally { s.done(); }
});

test('a refusal from GitHub says what it was, not just "Validation Failed"', async () => {
  const s = setup();
  try {
    const gh = fakeGh({ fail: () => invalid('No commits between main and shellby/x.') });
    const copy = await makeCopy({ repo: 'me/crab', slug: 'refused' }, copyDeps(s, gh));
    fs.writeFileSync(path.join(copy.path, 'x.txt'), 'x\n');
    const r = await openPullRequest({ folder: copy.path, title: 'X', draft: false }, prDeps(s, gh));
    assert.equal(r.error, 'GitHub didn\'t open the pull request: No commits between main and shellby/x.');
  } finally { s.done(); }
});
