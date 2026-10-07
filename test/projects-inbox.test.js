// The Projects inbox's local half against real git in a temp folder: which
// branches are stale, merged or hold work found nowhere else, Shellby's copies
// among the worktrees, and the inbox that joins it all (projects/inbox.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const leaving = require('../src/main/leaving');
const branches = require('../src/main/projects/branches');
const inbox = require('../src/main/projects/inbox');

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-inbox-')));
  const g = (cwd, args, env = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } }).trim();
  const origin = path.join(base, 'origin.git');
  const dir = path.join(base, 'proj');
  const home = path.join(base, 'copies');
  fs.mkdirSync(dir);
  fs.mkdirSync(home);
  g(base, ['init', '-q', '--bare', '-b', 'main', origin]);
  g(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) g(dir, ['config', k, v]);
  const commit = (file, { daysAgo = 0 } = {}) => {
    fs.writeFileSync(path.join(dir, file), `${file}\n`);
    g(dir, ['add', '-A']);
    const when = new Date(Date.now() - daysAgo * DAY).toISOString();
    g(dir, ['commit', '-qm', file], { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when });
  };
  commit('a.txt', { daysAgo: 60 });
  g(dir, ['remote', 'add', 'origin', origin]);
  g(dir, ['push', '-q', '-u', 'origin', 'main']);
  return { base, dir, home, g, commit, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('parseRefs reads for-each-ref lines and skips names that read as options', () => {
  const refs = branches.parseRefs('feature\x001700000000\x00origin/feature\x00[gone]\x00\n-x\x001\x00\x00\x00\nmain\x001700000001\x00origin/main\x00\x00C:/code/proj\n');
  assert.deepEqual(refs.map(r => [r.name, r.gone, r.checkedOut]), [['feature', true, false], ['main', false, true]]);
  assert.equal(refs[0].at, 1700000000 * 1000);
});

test('stale: merged branches after a day, unmerged ones after three weeks or once their remote is gone', () => {
  const now = Date.now();
  const list = branches.stale([
    { name: 'fresh-merged', at: now - 1000, merged: true, only: 0 },
    { name: 'old-merged', at: now - 2 * DAY, merged: true, only: 0 },
    { name: 'wip', at: now - 5 * DAY, merged: false, only: 2 },
    { name: 'gone-wip', at: now - 5 * DAY, merged: false, only: 2, gone: true },
    { name: 'ancient', at: now - 40 * DAY, merged: false, only: 1 },
  ], now);
  assert.deepEqual(list.map(b => b.name), ['old-merged', 'ancient', 'gone-wip']);
});

test('read finds a merged branch, an old one with work only here, and a copy, but not main or a fresh branch', async () => {
  const r = setup();
  try {
    r.g(r.dir, ['checkout', '-q', '-b', 'merged']);
    r.commit('m.txt', { daysAgo: 30 });
    r.g(r.dir, ['checkout', '-q', 'main']);
    r.g(r.dir, ['merge', '-q', '--ff-only', 'merged']);
    r.g(r.dir, ['push', '-q', 'origin', 'main']);
    r.g(r.dir, ['checkout', '-q', '-b', 'old-wip']);
    r.commit('w.txt', { daysAgo: 30 });
    r.g(r.dir, ['checkout', '-q', 'main']);
    r.g(r.dir, ['checkout', '-q', '-b', 'fresh-wip']);
    r.commit('f.txt');
    r.g(r.dir, ['checkout', '-q', 'main']);
    const copy = path.join(r.home, 'proj-1');
    r.g(r.dir, ['worktree', 'add', '-q', '-b', 'shellby/try-abc123', copy]);

    const read = await branches.read(r.dir, { run: leaving.git, isCopy: p => p.toLowerCase().startsWith(r.home.toLowerCase()) });
    assert.equal(read.ok, true);
    assert.equal(read.main, 'main');
    assert.deepEqual(read.branches.map(b => [b.name, b.merged, b.only]), [['merged', true, 0], ['old-wip', false, 1]]);
    assert.equal(read.copies.length, 1);
    assert.equal(read.copies[0].branch, 'shellby/try-abc123');
    assert.equal(read.copies[0].only, 0, 'a fresh copy has nothing of its own');
    assert.equal(path.resolve(read.copies[0].path).toLowerCase(), path.resolve(copy).toLowerCase());

    const again = await branches.recheck(r.dir, 'old-wip', leaving.git);
    assert.deepEqual([again.ok, again.merged, again.only, again.checkedOut], [true, false, 1, false]);
    assert.equal((await branches.recheck(r.dir, 'nope', leaving.git)).gone, true);
    assert.equal((await branches.recheck(r.dir, '--all', leaving.git)).ok, false, 'never a name git would read as an option');
  } finally { r.done(); }
});

test('a squash-merged branch counts as merged only when its single commit landed by patch', async () => {
  const r = setup();
  try {
    r.g(r.dir, ['checkout', '-q', '-b', 'squashed']);
    r.commit('s.txt', { daysAgo: 10 });
    r.g(r.dir, ['checkout', '-q', 'main']);
    r.g(r.dir, ['cherry-pick', 'squashed']);
    r.g(r.dir, ['push', '-q', 'origin', 'main']);
    const read = await branches.read(r.dir, { run: leaving.git });
    assert.deepEqual(read.branches.map(b => [b.name, b.merged]), [['squashed', true]]);
  } finally { r.done(); }
});

test('inbox.build joins PRs, branches and copies, leaves out open and dismissed ones', () => {
  const now = Date.UTC(2026, 9, 6);
  const root = path.resolve('/code/crab');
  const copyA = path.resolve('/copies/crab-a');
  const copyB = path.resolve('/copies/crab-b');
  const copyC = path.resolve('/copies/crab-c');
  const old = now - 10 * DAY;
  const v = inbox.build({
    now,
    ci: {
      enabled: true, error: null, lastPollAt: now, reviewsTotal: 5,
      reviews: [{ key: 'o/r#1', repo: 'o/r', number: 1, title: 'Theirs', url: 'u', author: 'them' }],
      prs: [
        { key: 'me/crab#2', repo: 'me/crab', number: 2, title: 'Quiet', talk: { unread: 0 } },
        { key: 'me/crab#3', repo: 'me/crab', number: 3, title: 'Busy', state: 'passing', talk: { unread: 2, people: ['al'], lastAt: now, verdict: 'changes' } },
      ],
    },
    repos: [{
      project: 'crab', root,
      read: {
        branches: [{ name: 'gone-by', at: old, merged: true, only: 0 }, { name: 'kept', at: old, merged: false, only: 3 }],
        copies: [
          { path: copyA, branch: 'shellby/a-111111', at: old, merged: false, only: 0 },
          { path: copyB, branch: 'shellby/b-222222', at: old, merged: false, only: 1 },
          { path: copyC, branch: 'shellby/c-333333', at: old, merged: false, only: 0 },
        ],
      },
      git: { copyList: [{ path: copyA, changed: 0 }, { path: copyB, changed: 4 }] },
    }],
    sessions: [{ id: 's1', title: 'Try A', cwd: copyA, updatedAt: old }, { id: 's2', title: 'Recent B', cwd: copyB, updatedAt: now - DAY }],
    open: [path.join(copyC, 'src')],
    dismissed: new Set([inbox.branchId(root, 'kept', old)]),
  });
  assert.deepEqual(v.reviews.map(r => r.key), ['o/r#1']);
  assert.equal(v.reviewsMore, 4);
  assert.deepEqual(v.talk.map(t => [t.key, t.unread, t.verdict]), [['me/crab#3', 2, 'changes']]);
  assert.deepEqual(v.branches.map(b => b.name), ['gone-by'], 'kept was dismissed');
  assert.deepEqual(v.copies.map(c => [c.branch, c.empty, c.sessionId]), [['shellby/a-111111', true, 's1']],
    'B was worked on yesterday; C has a tab open in it');
  assert.equal(v.total, 1 + 4 + 1 + 1 + 1);
});

test('inbox.build with CI off still lists the local half', () => {
  const v = inbox.build({ ci: { enabled: false, prs: [{ talk: { unread: 3 } }], reviews: [{}] }, repos: [] });
  assert.deepEqual([v.reviews.length, v.talk.length, v.github.enabled, v.total], [0, 0, false, 0]);
});

// The Projects service over a real repo: what the inbox may delete, and when it must ask.
function projectsOver(r, { retireCopy = null, open = [] } = {}) {
  const { Projects } = require('../src/main/projects/service');
  let data = {};
  return new Projects({
    config: { get: k => data[k], set: patch => { data = { ...data, ...patch }; } },
    devServers: { view: () => ({ servers: [], settings: {}, running: 0 }), lastScript: () => null, forRoot: () => [] },
    known: () => [{ key: r.dir, name: 'proj' }], lastWorked: () => new Map(),
    github: () => ({ signedIn: false, can: () => false }),
    copies: () => ({ home: r.home, open }), retireCopy,
  });
}
const settle = p => new Promise(res => { const wait = () => (p.branchLoading || p.gitLoading ? setTimeout(wait, 20) : res()); wait(); });
const branchList = (r) => r.g(r.dir, ['branch', '--format=%(refname:short)']).split('\n').sort();

test('the inbox deletes a merged branch at once, asks about one with work only here, and refuses one it never listed', async () => {
  const r = setup();
  try {
    r.g(r.dir, ['checkout', '-q', '-b', 'merged']);
    r.commit('m.txt', { daysAgo: 30 });
    r.g(r.dir, ['checkout', '-q', 'main']);
    r.g(r.dir, ['merge', '-q', '--ff-only', 'merged']);
    r.g(r.dir, ['push', '-q', 'origin', 'main']);
    r.g(r.dir, ['checkout', '-q', '-b', 'old-wip']);
    r.commit('w.txt', { daysAgo: 30 });
    r.g(r.dir, ['checkout', '-q', 'main']);
    const p = projectsOver(r);
    await p.inbox();
    await settle(p);
    const v = p.inboxView();
    assert.deepEqual(v.branches.map(b => b.name), ['merged', 'old-wip']);
    const root = v.branches[0].root;

    assert.equal((await p.deleteBranch(root, 'main')).ok, false, 'not on the list');
    assert.equal((await p.deleteBranch(path.join(r.base, 'elsewhere'), 'merged')).ok, false, 'not a listed folder');
    assert.deepEqual(await p.deleteBranch(root, 'merged'), { ok: true, only: 0 });
    const asked = await p.deleteBranch(root, 'old-wip');
    assert.deepEqual([asked.ok, asked.needsConfirm, asked.only], [false, true, 1]);
    assert.deepEqual(branchList(r), ['main', 'old-wip'], 'asking deletes nothing');
    assert.equal((await p.deleteBranch(root, 'old-wip', { confirmed: 'f'.repeat(40) })).ok, false, 'not the tip it asked about');
    assert.equal((await p.deleteBranch(root, 'old-wip', { confirmed: asked.sha })).ok, true);
    assert.deepEqual(branchList(r), ['main']);
    assert.deepEqual(p.inboxView().branches, []);

    assert.equal(p.dismiss('x:not-an-id').ok, false);
  } finally { r.done(); }
});

test('the inbox removes an empty copy at once, asks about one with work, and leaves one a tab is in', async () => {
  const r = setup();
  try {
    const empty = path.join(r.home, 'proj-1');
    const busy = path.join(r.home, 'proj-2');
    r.g(r.dir, ['worktree', 'add', '-q', '-b', 'shellby/empty-aaaaaa', empty]);
    r.g(r.dir, ['worktree', 'add', '-q', '-b', 'shellby/busy-bbbbbb', busy]);
    fs.writeFileSync(path.join(busy, 'new.txt'), 'work\n');
    const retired = [];
    let open = [];
    const p = projectsOver(r, { retireCopy: async c => { retired.push(c.branch); return { ok: true }; } });
    p.deps.copies = () => ({ home: r.home, open });
    await p.list();
    await p.inbox();
    await settle(p);

    open = [path.join(empty, 'src')];
    assert.match((await p.removeCopy(empty)).error, /working in that copy/);
    open = [];
    assert.deepEqual(await p.removeCopy(empty), { ok: true });
    await settle(p);
    const asked = await p.removeCopy(busy);
    assert.deepEqual([asked.needsConfirm, asked.changed, asked.only], [true, 1, 0]);
    assert.deepEqual(retired, ['shellby/empty-aaaaaa'], 'asking removes nothing');
    assert.equal((await p.removeCopy(path.join(r.base, 'proj'))).ok, false, 'never a folder that is not a listed copy');
  } finally { r.done(); }
});

test('a copy whose only leftovers are files git ignores is asked about, unless they are dependencies', async () => {
  const r = setup();
  try {
    fs.writeFileSync(path.join(r.dir, '.gitignore'), '.env.local\nnode_modules/\n');
    r.g(r.dir, ['add', '-A']);
    r.g(r.dir, ['commit', '-qm', 'ignore']);
    r.g(r.dir, ['push', '-q', 'origin', 'main']);
    const deps = path.join(r.home, 'proj-1');
    const secrets = path.join(r.home, 'proj-2');
    r.g(r.dir, ['worktree', 'add', '-q', '-b', 'shellby/deps-aaaaaa', deps]);
    r.g(r.dir, ['worktree', 'add', '-q', '-b', 'shellby/env-bbbbbb', secrets]);
    fs.mkdirSync(path.join(deps, 'node_modules'));
    fs.writeFileSync(path.join(deps, 'node_modules', 'x.js'), '');
    fs.writeFileSync(path.join(secrets, '.env.local'), 'KEY=1\n');
    const retired = [];
    const p = projectsOver(r, { retireCopy: async c => { retired.push(c.branch); return { ok: true }; } });
    await p.list();
    await p.inbox();
    await settle(p);
    assert.deepEqual(await p.removeCopy(deps), { ok: true }, 'node_modules comes back with an install');
    await settle(p);
    const asked = await p.removeCopy(secrets);
    assert.deepEqual([asked.needsConfirm, asked.ignored], [true, ['.env.local']]);
    assert.deepEqual(retired, ['shellby/deps-aaaaaa']);
  } finally { r.done(); }
});

test('two branches at the same commit, deleted at once: the second one asks, so the commit survives', async () => {
  const r = setup();
  try {
    r.g(r.dir, ['checkout', '-q', '-b', 'twin-a']);
    r.commit('t.txt', { daysAgo: 30 });
    r.g(r.dir, ['branch', 'twin-b']);
    r.g(r.dir, ['checkout', '-q', 'main']);
    const p = projectsOver(r);
    await p.inbox();
    await settle(p);
    const v = p.inboxView();
    assert.deepEqual(v.branches.map(b => [b.name, b.only]), [['twin-a', 0], ['twin-b', 0]], 'each looks safe on its own');
    const root = v.branches[0].root;
    const [a, b] = await Promise.all([p.deleteBranch(root, 'twin-a'), p.deleteBranch(root, 'twin-b')]);
    assert.equal(a.ok, true);
    assert.deepEqual([b.ok, b.needsConfirm, b.only], [false, true, 1]);
    assert.ok(branchList(r).includes('twin-b'));
  } finally { r.done(); }
});
