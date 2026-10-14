// branching.js against a real repository and a worktree of it: which try
// changed each file since they split, and taking one file across.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const branching = require('../src/main/branching');
const changes = require('../src/main/changes');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

async function setup() {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-branching-')));
  const repo = path.join(top, 'repo');
  const copy = path.join(top, 'copy');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'core.autocrlf', 'false'); // files come back byte for byte, whatever this PC's git says
  for (const f of ['a.js', 'b.js', 'c.js']) write(repo, f, `${f} at the start\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  git(repo, 'worktree', 'add', '-q', '-b', 'try', copy);
  const base = (await changes.snapshot(repo)).tree;

  write(repo, 'a.js', 'a.js changed here\n');
  write(copy, 'b.js', 'b.js changed there\n');
  write(repo, 'c.js', 'c.js changed here\n');
  write(copy, 'c.js', 'c.js changed there\n');

  const entries = {
    A: { id: 'A', title: 'Original', cwd: repo },
    B: { id: 'B', title: 'Branch', cwd: copy, branchOf: { id: 'A', title: 'Original', tree: base } },
  };
  const transcripts = {
    A: [{ kind: 'user', turnId: 't1', text: 'go' }, { kind: 'result', durationMs: 2000 }, { kind: 'branched-off', to: 'B', turnId: 't1', at: 'after' }],
    B: [{ kind: 'branched' }, { kind: 'user', turnId: 't2', text: 'again' }, { kind: 'text', text: 'Did it.' }, { kind: 'result', durationMs: 3000 }, { kind: 'checks', status: 'pass', commands: [{ ok: true }] }],
  };
  const handlers = new Map();
  branching.register({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    manager: { tabs: new Map() },
    history: { list: () => Object.values(entries), get: id => entries[id], load: id => transcripts[id] || [] },
    worktreeHome: () => path.join(top, 'home'),
    stat: () => {},
    log: { info: () => {} },
  });
  const call = (name, arg) => handlers.get(name)(null, arg);
  return { top, repo, copy, call };
}

test('compare says which try changed each file since they split, and how each went', async (t) => {
  const { top, call } = await setup();
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const r = await call('branch:compare', { tabId: 'A', otherId: 'B' });
  assert.equal(r.ok, true);
  assert.equal(r.split, true);
  const who = Object.fromEntries(r.files.map(f => [f.path, f.who]));
  assert.deepEqual(who, { 'a.js': 'mine', 'b.js': 'theirs', 'c.js': 'both' });
  assert.deepEqual(r.mine, { turns: 0, ms: 0, checks: null, said: '' }, 'nothing since it branched off after t1');
  assert.deepEqual(r.theirs, { turns: 1, ms: 3000, checks: { status: 'pass', failing: 0 }, said: 'Did it.' });
  assert.ok(r.theirPath);
});

test('take brings one file across, and never over a change made since the comparison', async (t) => {
  const { top, repo, copy, call } = await setup();
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  assert.equal((await call('branch:take', { tabId: 'A', otherId: 'B', file: 'b.js' })).ok, false, 'compare first');
  await call('branch:compare', { tabId: 'A', otherId: 'B' });

  assert.deepEqual(await call('branch:take', { tabId: 'A', otherId: 'B', file: 'b.js' }), { ok: true });
  assert.equal(read(repo, 'b.js'), read(copy, 'b.js'));
  assert.equal(read(repo, 'a.js'), 'a.js changed here\n', 'the other files are left alone');

  write(repo, 'c.js', 'changed again after comparing\n');
  const late = await call('branch:take', { tabId: 'A', otherId: 'B', file: 'c.js' });
  assert.equal(late.ok, false);
  assert.match(late.error, /changed here since you compared/);
  assert.equal(read(repo, 'c.js'), 'changed again after comparing\n');

  assert.equal((await call('branch:take', { tabId: 'A', otherId: 'B', file: 'nope.js' })).ok, false);
});
