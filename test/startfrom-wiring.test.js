// "Fix this build", "Address the review" and loose ends, wired up, against real
// git: a bare repository stands in for GitHub (the clone's origin says
// github.com; fetches go to the bare one through the env), with a pretend API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const worktrees = require('../src/main/worktrees');
const { wireStartFrom } = require('../src/main/wiring/startfrom');

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-sf-')));
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const bare = path.join(base, 'origin.git');
  const dir = path.join(base, 'crab');
  const home = path.join(base, 'home');
  fs.mkdirSync(dir);
  g(base, 'init', '-q', '--bare', '-b', 'main', bare);
  g(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) g(dir, 'config', k, v);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), ['one', 'two', 'three', '  // TODO: handle the empty list', 'five', 'six', 'seven', 'eight'].join('\n'));
  fs.writeFileSync(path.join(dir, 'notes.md'), 'A todo app. const TODO = 1;\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.js\n');
  fs.writeFileSync(path.join(dir, 'secret.js'), '// FIXME ignored by git\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  g(dir, 'push', '-q', bare.replace(/\\/g, '/'), 'main');
  // The pull request's head, as GitHub keeps it: refs/pull/3/head.
  g(dir, 'checkout', '-q', '-b', 'fix/it');
  fs.writeFileSync(path.join(dir, 'b.js'), 'pr work\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'pr');
  const sha = g(dir, 'rev-parse', 'HEAD');
  g(dir, 'push', '-q', bare.replace(/\\/g, '/'), 'fix/it:refs/pull/3/head');
  g(dir, 'checkout', '-q', 'main');
  g(dir, 'branch', '-q', '-D', 'fix/it');
  fs.writeFileSync(path.join(dir, 'untracked.js'), '// HACK not tracked\n');
  g(dir, 'remote', 'add', 'origin', 'https://github.com/me/crab.git');
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${bare.replace(/\\/g, '/')}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/me/crab.git' };
  return { base, dir, home, env, sha, g, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function shared(s, {
  log = 'line\n##[group]Run npm test\nboom\n##[error]Process completed with exit code 1.\n',
  files = [{ filename: 'b.js' }],
  commits = [{ sha: s.sha, author: { login: 'me' } }],
} = {}) {
  const pr = { key: 'me/crab#3', repo: 'me/crab', number: 3, title: 'Fix it', url: 'https://github.com/me/crab/pull/3', state: 'failing', failing: ['test'] };
  const started = [];
  const gh = {
    get: async p => {
      if (p.startsWith('/repos/me/crab/pulls/3/files?')) return files;
      if (p.startsWith('/repos/me/crab/pulls/3/commits?')) return commits;
      if (p === '/repos/me/crab/pulls/3') return { title: 'Fix it', head: { sha: s.sha, ref: 'fix/it', repo: { full_name: 'me/crab' } } };
      if (p.includes('/check-runs')) return { check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' }, html_url: 'https://github.com/me/crab/actions/runs/1/job/9' }] };
      if (p.endsWith('/status')) return { statuses: [] };
      if (p === '/repos/me/crab/actions/jobs/9') return { steps: [{ name: 'Run npm test', conclusion: 'failure' }] };
      throw Object.assign(new Error('nope'), { status: 404 });
    },
    text: async () => log,
    post: async () => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
      { isResolved: false, path: 'src/a.js', line: 4, comments: { nodes: [{ author: { login: 'alice' }, body: 'Please do this' }] } },
    ] } } } } }),
  };
  const d = {
    config: { get: () => false },
    claudeStatus: { installed: true, loggedIn: true },
    githubEndpoints: () => ({ web: 'https://github.com' }),
    github: { signedIn: true, gh: () => gh, claudeEnv: () => s.env, view: () => ({ login: 'me' }) },
    ci: { view: () => ({ prs: [pr] }) },
    projects: {
      localRepos: async () => [{ root: s.dir, remote: 'me/crab' }],
      knowsRoot: r => (path.resolve(r).toLowerCase() === s.dir.toLowerCase() ? { root: s.dir } : null),
      nameFor: () => 'crab',
    },
    // The copy as wiring/projects.js makes it, without a Claude tab.
    startTaskInCopy: async (dir, title, promptFor, { start }) => {
      const made = await worktrees.create(dir, { home: s.home, title, start });
      started.push({ dir, title, start, made, prompt: promptFor(made.worktree) });
      return { ok: true, tabId: 'tab-1' };
    },
  };
  return { d, pr, started };
}

test('Fix this build: the draft shows the failing step, and Send sends exactly it in a copy from the pull request', async () => {
  const s = setup();
  try {
    const { d, started } = shared(s);
    const sf = wireStartFrom(d);
    const r = await sf.startFromDraft({ kind: 'build', key: 'me/crab#3' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.logShown, true);
    assert.equal(r.step, 'Run npm test');
    assert.match(r.prompt, /<ci-log>\nRun npm test\nboom\nerror: Process completed with exit code 1\.\n<\/ci-log>/);
    assert.doesNotMatch(r.prompt, /^line$/m, 'only the failing step');

    const stale = await sf.startFromSend({ kind: 'build', key: 'me/crab#3', hash: r.hash, note: 'something new' });
    assert.equal(stale.stale, true, 'a note you haven\'t seen in the draft makes it stale');
    assert.equal(started.length, 0);

    const sent = await sf.startFromSend({ kind: 'build', key: 'me/crab#3', hash: r.hash });
    assert.equal(sent.ok, true, sent.error);
    assert.equal(started[0].prompt, r.prompt);
    assert.equal(r.risk, null, 'only your own commits, no Claude Code files: nothing to tick');
    assert.equal(started[0].start, s.sha, 'pinned to the commit the sheet was checked against');
    assert.equal(s.g(started[0].made.worktree.path, 'rev-parse', 'HEAD'), s.sha, 'the copy starts at the pull request\'s head');
    assert.ok(fs.existsSync(path.join(started[0].made.worktree.path, 'b.js')));
  } finally { s.done(); }
});

test('a pull request touching Claude Code\'s files or with someone else\'s commits needs the tick, and main enforces it', async () => {
  const s = setup();
  try {
    const { d, started } = shared(s, {
      files: [{ filename: 'b.js' }, { filename: '.claude/settings.json' }, { filename: 'docs/CLAUDE.md' }],
      commits: [{ sha: 'f'.repeat(40), author: { login: 'mallory' } }, { sha: s.sha, author: { login: 'me' } }],
    });
    const sf = wireStartFrom(d);
    const r = await sf.startFromDraft({ kind: 'build', key: 'me/crab#3' });
    assert.deepEqual(r.risk.files, ['.claude/settings.json', 'docs/CLAUDE.md']);
    assert.deepEqual(r.risk.authors, ['@mallory']);
    const unticked = await sf.startFromSend({ kind: 'build', key: 'me/crab#3', hash: r.hash });
    assert.equal(unticked.needsAck, true);
    assert.equal(started.length, 0, 'nothing made or sent without the tick');
    const ticked = await sf.startFromSend({ kind: 'build', key: 'me/crab#3', hash: r.hash, ack: true });
    assert.equal(ticked.ok, true, ticked.error);

    // The same prompt without anything to check hashes differently: the list is part of what you agreed to.
    const clean = await wireStartFrom(shared(s).d).startFromDraft({ kind: 'build', key: 'me/crab#3' });
    assert.equal(clean.prompt, r.prompt);
    assert.notEqual(clean.hash, r.hash);
  } finally { s.done(); }
});

test('when GitHub won\'t list the files or commits, the tick is still asked for', async () => {
  const s = setup();
  try {
    const sf = wireStartFrom(shared(s, { files: null, commits: null }).d);
    const r = await sf.startFromDraft({ kind: 'review', key: 'me/crab#3' });
    assert.deepEqual(r.risk.unknown, ['which files it changes', 'who made its commits']);
  } finally { s.done(); }
});

test('Fix this build without a readable log says so, and an unknown pull request is refused', async () => {
  const s = setup();
  try {
    const { d } = shared(s, { log: '' });
    const sf = wireStartFrom(d);
    const r = await sf.startFromDraft({ kind: 'build', key: 'me/crab#3' });
    assert.equal(r.logShown, false);
    assert.match(r.prompt, /couldn't read that job's log \(it was empty\)/);
    assert.match((await sf.startFromDraft({ kind: 'build', key: 'me/crab#4' })).error, /isn't watching/);
  } finally { s.done(); }
});

test('Address the review quotes the unresolved comments', async () => {
  const s = setup();
  try {
    const sf = wireStartFrom(shared(s).d);
    const r = await sf.startFromDraft({ kind: 'review', key: 'me/crab#3' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.comments, 1);
    assert.match(r.prompt, /1\. src\/a\.js:4, from @alice:\n {3}> Please do this/);
  } finally { s.done(); }
});

test('a repository not cloned here asks for a clone first', async () => {
  const s = setup();
  try {
    const { d } = shared(s);
    d.projects.localRepos = async () => [];
    const r = await wireStartFrom(d).startFromDraft({ kind: 'build', key: 'me/crab#3' });
    assert.equal(r.needsClone, true);
    assert.match(r.error, /isn't cloned on this PC/);
  } finally { s.done(); }
});

test('loose ends: tracked TODO comments only, and "Do this" quotes the lines around one', async () => {
  const s = setup();
  try {
    const sf = wireStartFrom(shared(s).d);
    const r = await sf.looseEnds(s.dir);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.items, [{ file: 'src/a.js', line: 4, tag: 'TODO', text: 'handle the empty list', ref: null }], 'not ignored, untracked or prose');
    const draft = sf.looseEndDraft({ root: s.dir, file: 'src/a.js', line: 4 });
    assert.equal(draft.ok, true, draft.error);
    assert.equal(draft.cwd, s.dir);
    assert.match(draft.draft, /^In crab, there's a TODO at src\/a\.js:4:/);
    assert.match(draft.draft, /1 \| one\n2 \| two\n3 \| three\n4 > {3}\/\/ TODO: handle the empty list\n5 \| five\n6 \| six\n7 \| seven/);
    assert.equal(sf.looseEndDraft({ root: s.dir, file: '../outside.js', line: 4 }).ok, false, 'only what the scan found');
    assert.equal(sf.looseEndDraft({ root: s.base, file: 'src/a.js', line: 4 }).ok, false, 'only a project the page listed');
    assert.equal((await sf.looseEnds(s.base)).ok, false);
    // Edited since the scan: refused rather than quoting the wrong line.
    fs.writeFileSync(path.join(s.dir, 'src', 'a.js'), 'one\ntwo\nthree\nfour\n');
    assert.equal(sf.looseEndDraft({ root: s.dir, file: 'src/a.js', line: 4 }).stale, true);
    assert.equal(sf.looseEndDraft({ root: s.dir, file: 'src/a.js', line: 4 }).ok, false, 'and the list is read again');
  } finally { s.done(); }
});
