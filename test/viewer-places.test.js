// The file viewer's header menu (main's viewer.js placesOf/switchTo) against real git repos:
// every local worktree of the repo with what it changed, every local branch with commits main
// lacks, each under a key main issued, and a pick checked again before it opens.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createViewer, countStatus, checkoutBranch, limiter, MAX_PLACE_TREES, MAX_PLACE_BRANCHES, PLACES_MS } = require('../src/main/viewer');

// The git commands run while fn does, as GIT_TRACE logs them ("status --porcelain ...", "for-each-ref ..."):
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

function repo() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-places-')));
  const dir = path.join(base, 'proj');
  fs.mkdirSync(dir);
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'core.autocrlf', 'false');
  const write = (at, f, s) => { fs.mkdirSync(path.dirname(path.join(at, f)), { recursive: true }); fs.writeFileSync(path.join(at, f), s); };
  write(dir, 'a.txt', 'one\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  // As a repo's .gitignore would: agents' worktrees aren't the checkout's own untracked files.
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.claude/worktrees/\n');
  let n = 0;
  // A branch nothing checks out, `commits` commits ahead of main, committed at `date`.
  const branch = (name, { commits = 1, date = '2026-01-01T00:00:00Z' } = {}) => {
    const wt = path.join(base, `made-${n++}`);
    g(dir, 'worktree', 'add', '-q', '-b', name, wt, 'main');
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    for (let i = 0; i < commits; i++) {
      write(wt, `${name.replace(/\W/g, '_')}-${i}.txt`, `${i}\n`);
      execFileSync('git', ['-C', wt, 'add', '-A'], { windowsHide: true });
      execFileSync('git', ['-C', wt, 'commit', '-qm', `${name} ${i}`], { windowsHide: true, env });
    }
    g(dir, 'worktree', 'remove', '--force', wt);
  };
  return { base, dir, g, write, branch, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('worktrees: the checkout, a hand-made one and one under .claude/worktrees, with their changed files', async () => {
  const r = repo();
  try {
    const hand = path.join(r.base, 'hand');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'hand', hand);
    r.write(hand, 'a.txt', 'changed\n');          // modified
    r.write(hand, 'new/deep/x.txt', 'x\n');       // untracked, two folders down: one file
    const agent = path.join(r.dir, '.claude', 'worktrees', 'agent-1');
    r.g(r.dir, 'worktree', 'add', '-q', '--detach', agent);
    r.g(agent, 'mv', 'a.txt', 'b.txt');           // a rename: one file, in two fields of git status -z
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const p = await v.placesOf(h.id);
    assert.equal(p.ok, true);
    const rows = Object.fromEntries(p.places.filter(x => x.kind === 'worktree').map(x => [x.label, `${x.branch}|${x.changed}|${x.current}`]));
    assert.deepEqual(rows, { proj: 'main|0|true', hand: 'hand|2|false', 'agent-1': 'detached|1|false' });
    assert.ok(p.places.every(x => /^[0-9a-f]{16}$/.test(x.key) && !('path' in x) && !('ref' in x)), 'keys only: no path or ref reaches the panel');
  } finally { r.done(); }
});

test('branches: only those with commits main lacks, newest first, none a worktree has out', async () => {
  const r = repo();
  try {
    r.branch('old', { date: '2026-01-01T00:00:00Z' });
    r.branch('new', { commits: 2, date: '2026-02-01T00:00:00Z' });
    r.g(r.dir, 'branch', 'merged');                       // nothing main lacks
    r.branch('busy', { date: '2026-03-01T00:00:00Z' });
    r.g(r.dir, 'worktree', 'add', '-q', path.join(r.base, 'busy-wt'), 'busy'); // checked out: it shows under Worktrees
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const p = await v.placesOf(h.id);
    const branches = p.places.filter(x => x.kind === 'branch');
    assert.deepEqual(branches.map(x => `${x.label}:${x.ahead}`), ['new:2', 'old:1']);
    assert.equal(branches[0].branch, 'new');
    assert.equal(branches[0].when, Date.parse('2026-02-01T00:00:00Z'));
    assert.ok(p.places.some(x => x.kind === 'worktree' && x.branch === 'busy'), 'busy is listed once, as a worktree');
    assert.ok(branches.every(x => !x.current));
  } finally { r.done(); }
});

test('a branch named like an option is listed and opens: git only ever sees refs/heads/-x', async () => {
  const r = repo();
  try {
    r.branch('old');
    r.g(r.dir, 'update-ref', 'refs/heads/-x', r.g(r.dir, 'rev-parse', 'refs/heads/old').trim());
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const x = (await v.placesOf(h.id)).places.find(e => e.label === '-x');
    assert.equal(x?.ahead, 1);
    const b = await v.switchTo(h.id, x.key);
    assert.equal(b.ok, true);
    assert.equal(b.kind, 'branch');
    assert.equal(b.branch, '-x');
    assert.equal(b.base, 'main');
    assert.deepEqual((await v.changesOf(b.id)).files.map(f => f.path), ['old-0.txt']);
  } finally { r.done(); }
});

test(`caps: ${MAX_PLACE_TREES} worktrees, and the newest ${MAX_PLACE_BRANCHES} branches checked`, async () => {
  const r = repo();
  try {
    for (let i = 0; i < MAX_PLACE_TREES; i++) r.g(r.dir, 'worktree', 'add', '-q', '--detach', path.join(r.base, `wt-${i}`));
    r.branch('tip');
    const tip = r.g(r.dir, 'rev-parse', 'refs/heads/tip').trim();
    for (let i = 0; i < MAX_PLACE_BRANCHES + 2; i++) r.g(r.dir, 'update-ref', `refs/heads/b-${i}`, tip);
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const p = await v.placesOf(h.id);
    assert.equal(p.places.filter(x => x.kind === 'worktree').length, MAX_PLACE_TREES, `${MAX_PLACE_TREES + 1} worktrees exist`);
    assert.equal(p.places.filter(x => x.kind === 'branch').length, MAX_PLACE_BRANCHES, `${MAX_PLACE_BRANCHES + 3} branches have work of their own`);
  } finally { r.done(); }
});

test('the list is built when asked, then reused for 10 s', async () => {
  const r = repo();
  try {
    assert.equal(PLACES_MS, 10000);
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const first = await v.placesOf(h.id);
    r.branch('late');
    const again = await v.placesOf(h.id);
    assert.deepEqual(again.places.map(x => x.key), first.places.map(x => x.key));
    assert.equal(again.places.some(x => x.label === 'late'), false, 'built under 10 s ago: reused');
    assert.deepEqual(await v.placesOf('nope'), { ok: false, expired: true });
  } finally { r.done(); }
});

test("a pick: a made-up key, another handle's and a stale one are refused; a live one opens", async () => {
  const r = repo();
  try {
    r.branch('old');
    r.branch('new');
    const hand = path.join(r.base, 'hand');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'hand', hand);
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const other = await v.open({ dir: r.dir });
    const p = await v.placesOf(h.id);
    const key = (list, label) => list.places.find(x => x.label === label).key;
    const made = await v.switchTo(h.id, 'f00df00df00df00d');
    assert.equal(made.ok, false);
    assert.equal(made.gone, undefined, 'not stale: never one of ours');
    assert.equal(typeof made.error, 'string');
    assert.equal((await v.switchTo(other.id, key(p, 'new'))).ok, false, "another handle's key");
    assert.equal((await v.switchTo(h.id, 42)).ok, false);
    const GONE = { ok: false, gone: true, error: 'That worktree or branch is gone.' };
    r.g(r.dir, 'worktree', 'remove', '--force', hand);
    assert.deepEqual(await v.switchTo(h.id, key(p, 'hand')), GONE, 'a worktree removed since the list was made');
    // A stale pick drops the list: the menu's next open, well inside 10 s, is built afresh with new keys.
    const q = await v.placesOf(h.id);
    assert.equal(q.places.some(x => x.label === 'hand'), false, 'rebuilt without it');
    assert.equal((await v.switchTo(h.id, key(p, 'new'))).ok, false, "the dropped list's keys went with it");
    r.g(r.dir, 'branch', '-D', 'old');
    assert.deepEqual(await v.switchTo(h.id, key(q, 'old')), GONE, 'a branch deleted since');
    const b = await v.switchTo(h.id, key(await v.placesOf(h.id), 'new'));
    assert.equal(b.ok, true);
    assert.equal(b.branch, 'new');
    assert.ok((await v.placesOf(b.id)).places.find(x => x.label === 'new').current, 'the branch being viewed is the checked one');
  } finally { r.done(); }
});

test('a worktree at or above the home folder is never listed, nor opened from a stored entry', async () => {
  const r = repo();
  try {
    const hand = path.join(r.base, 'hand');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'hand', hand);
    const v = createViewer({ home: hand });
    const h = await v.open({ dir: r.dir });
    const p = await v.placesOf(h.id);
    assert.equal(p.places.some(x => x.label === 'hand'), false);
    // A stored entry whose folder is too wide (edited here to stand in for one) is checked again on a pick:
    // hand is still listed by git and shares the repo, so only the home rule refuses it.
    const entry = v.get(h.id).places.list.find(x => x.label === 'proj');
    entry.path = hand;
    assert.equal((await v.switchTo(h.id, entry.key)).ok, false);
  } finally { r.done(); }
});

test("a pick back to the conversation's own folder belongs to its tab again, with its base", async () => {
  const r = repo();
  try {
    r.branch('new');
    const hand = path.join(r.base, 'hand');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'hand', hand);
    const v = createViewer();
    const h = await v.open({ dir: hand, tabId: 't', base: 'main' });
    const b = await v.switchTo(h.id, (await v.placesOf(h.id)).places.find(x => x.label === 'new').key);
    assert.equal(v.get(b.id).tabId, null, 'a branch belongs to no tab');
    const q = await v.placesOf(b.id);
    const checkout = await v.switchTo(b.id, q.places.find(x => x.label === 'proj').key);
    assert.equal(v.get(checkout.id).tabId, null, "the main checkout isn't the conversation's folder");
    const back = await v.switchTo(b.id, q.places.find(x => x.label === 'hand').key);
    assert.equal(v.get(back.id).tabId, 't');
    assert.equal(back.base, 'main');
    v.keepTabs(new Set());
    assert.equal(v.get(back.id), null, 'closing the conversation takes it');
    assert.ok(v.get(b.id), 'the branch stays');
  } finally { r.done(); }
});

test('asked at once, or from a second handle on the repo, the list is built once', async () => {
  const r = repo();
  try {
    r.branch('new');
    const hand = path.join(r.base, 'hand');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'hand', hand);
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const other = await v.open({ dir: hand });
    let a, b, c;
    const runs = await gitRuns(r.base, async () => {
      [a, b] = await Promise.all([v.placesOf(h.id), v.placesOf(h.id)]);
      c = await v.placesOf(other.id);
    });
    assert.equal(runs.filter(l => l.startsWith('for-each-ref')).length, 1, 'one build for three asks on two handles');
    assert.equal(runs.filter(l => l.startsWith('status')).length, 2, 'one git status in proj, one in hand');
    assert.deepEqual(b.places.map(x => x.key), a.places.map(x => x.key), 'two asks at once hold the same keys');
    assert.deepEqual(c.places.map(x => x.label), a.places.map(x => x.label), 'the second handle reuses the list');
    assert.ok(c.places.every(x => !a.places.some(y => y.key === x.key)), 'under keys of its own');
    assert.equal(a.places.find(x => x.label === 'proj').current, true);
    assert.equal(c.places.find(x => x.label === 'hand').current, true, 'and its own current place');
    assert.equal(c.places.find(x => x.label === 'proj').current, false);
  } finally { r.done(); }
});

test("a worktree record naming another repo's folder, or the home folder, is never listed or looked in", async () => {
  const r = repo();
  try {
    const home = path.join(r.base, 'home');
    fs.mkdirSync(path.join(home, '.git'), { recursive: true });
    const other = path.join(r.base, 'other');
    fs.mkdirSync(other);
    r.g(other, 'init', '-q', '-b', 'main');
    plant(r, 'h', home);
    plant(r, 'o', other);
    const listed = r.g(r.dir, 'worktree', 'list', '--porcelain');
    assert.match(listed, /^worktree .*\/home$/m, 'git lists the home folder');
    assert.match(listed, /^worktree .*\/other$/m, 'and the other repo');
    const v = createViewer({ home });
    const h = await v.open({ dir: r.dir });
    let p;
    const runs = await gitRuns(r.base, async () => { p = await v.placesOf(h.id); });
    assert.deepEqual(p.places.filter(x => x.kind === 'worktree').map(x => x.label), ['proj']);
    assert.equal(runs.filter(l => l.startsWith('status')).length, 1, 'git status ran in the checkout alone, never in the other repo, whose filters it would run');
  } finally { r.done(); }
});

test('limiter: at most n at once across callers, each answered, a failure giving its slot back', async () => {
  const slot = limiter(2);
  let now = 0;
  let most = 0;
  const job = v => slot(async () => {
    now++;
    most = Math.max(most, now);
    await new Promise(res => setTimeout(res, 5));
    now--;
    return v;
  });
  const first = Promise.all([1, 2, 3].map(job));
  const second = Promise.all([4, 5, 6].map(job)); // another caller, sharing the same two slots
  assert.deepEqual(await first, [1, 2, 3]);
  assert.deepEqual(await second, [4, 5, 6]);
  assert.equal(most, 2);
  await assert.rejects(slot(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await job(7), 7, 'the failed one gave its slot back');
  assert.equal(now, 0);
});

test('countStatus: one per file, a rename or copy counted once', () => {
  assert.equal(countStatus(''), 0);
  assert.equal(countStatus(null), 0);
  assert.equal(countStatus(' M a.txt\0?? new/deep/x.txt\0'), 2);
  assert.equal(countStatus('R  b.txt\0a.txt\0?? n.txt\0'), 2);
  assert.equal(countStatus('C  c.txt\0a.txt\0'), 1);
  assert.equal(countStatus('?? a\0'), 1, 'a one-letter name');
});

test("countStatus: an untracked entry that is another worktree's folder, or inside one, isn't counted", () => {
  const out = '?? .claude/worktrees/agent-1/\0?? .Claude/Worktrees/agent-2/x.txt\0?? .claude/worktrees/agent-10\0 M .claude/worktrees/agent-1/t.txt\0?? n.txt\0';
  assert.equal(countStatus(out), 5);
  assert.equal(countStatus(out, ['.claude/worktrees/agent-1', '.claude/worktrees/agent-2']), 3, 'agent-10 is no folder of agent-1; a tracked change still counts');
  assert.equal(countStatus(out, []), 5);
});

test("a worktree nested in the checkout isn't one of the checkout's changes, in a repo that doesn't ignore it", async () => {
  const r = repo();
  try {
    const exclude = path.join(r.dir, '.git', 'info', 'exclude');
    fs.writeFileSync(exclude, fs.readFileSync(exclude, 'utf8').replace('.claude/worktrees/\n', ''));
    const nested = path.join(r.dir, '.claude', 'worktrees', 'x');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'x', nested);
    assert.match(r.g(r.dir, 'status', '--porcelain', '--untracked-files=all'), /^\?\? \.claude\/worktrees\/x\/$/m, 'git status names it in the checkout');
    const v = createViewer();
    const p = await v.placesOf((await v.open({ dir: r.dir })).id);
    const rows = Object.fromEntries(p.places.filter(x => x.kind === 'worktree').map(x => [x.label, x.changed]));
    assert.deepEqual(rows, { proj: 0, x: 0 });
  } finally { r.done(); }
});

test('a removed worktree: a branch picked from it reads on from a live folder of the repo, and its gone screen still lists', async () => {
  const r = repo();
  try {
    r.branch('feat');
    const wt = path.join(r.base, 'wt');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'wt', wt);
    const v = createViewer();
    const key = (list, label) => list.places.find(x => x.label === label).key;
    const h = await v.open({ dir: r.dir, tabId: 't' });
    const w = await v.switchTo(h.id, key(await v.placesOf(h.id), 'wt'));
    assert.equal(w.ok, true);
    const b = await v.switchTo(w.id, key(await v.placesOf(w.id), 'feat'));
    assert.equal(b.ok, true);
    assert.equal(b.root.toLowerCase(), wt.toLowerCase(), 'picked from the worktree');
    assert.deepEqual((await v.changesOf(b.id)).files.map(f => f.path), ['feat-0.txt']);
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    assert.equal(fs.existsSync(wt), false);
    // The diff of a list taken while the worktree was there.
    assert.match((await v.diffOf(b.id, 'feat-0.txt')).patch || '', /^\+0$/m, 'a diff from the list taken before');
    v.staleFor(r.dir, { commits: true });
    const c = await v.changesOf(b.id);
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.deepEqual(c.files.map(f => f.path), ['feat-0.txt'], 'a look after it went');
    assert.match((await v.diffOf(b.id, 'feat-0.txt')).patch || '', /^\+0$/m);
    assert.deepEqual(await v.read(b.id, 'feat-0.txt'), { ok: true, text: '0\n', size: 2 });
    assert.ok((await v.treeOf(b.id)).entries.includes('feat-0.txt'));
    const q = await v.placesOf(b.id);
    assert.equal(q.ok, true, JSON.stringify(q));
    assert.ok(q.places.find(x => x.label === 'feat').current);
    // The worktree's own handle shows the gone screen; its menu lists from the conversation's checkout.
    assert.equal((await v.changesOf(w.id)).gone, true);
    const g = await v.placesOf(w.id);
    assert.equal(g.ok, true, JSON.stringify(g));
    const back = await v.switchTo(w.id, key(g, 'proj'));
    assert.equal(back.ok, true);
    assert.equal(v.get(back.id).tabId, 't', "back in the conversation's own folder");
    assert.equal((await v.switchTo(w.id, key(g, 'feat'))).ok, true, 'and a branch opens from there too');
  } finally { r.done(); }
});

test("a removed worktree with no live folder of its repo to fall back on doesn't list from another repo's", async () => {
  const r = repo();
  try {
    const wt = path.join(r.base, 'wt');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'wt', wt);
    const other = path.join(r.base, 'other');
    fs.mkdirSync(other);
    r.g(other, 'init', '-q', '-b', 'main');
    const v = createViewer();
    // A handle carried from a conversation in another repo (as no pick makes, but open() takes one).
    const w = await v.open({ dir: wt, origin: { tabId: 't', root: other, base: null } });
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    assert.deepEqual(await v.placesOf(w.id), { ok: false, error: "Couldn't list worktrees." });
  } finally { r.done(); }
});

test("checkoutBranch: the main checkout's branch, or none when it is bare or detached", () => {
  assert.equal(checkoutBranch('worktree C:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/w\nHEAD abc\nbranch refs/heads/x\n'), 'main');
  assert.equal(checkoutBranch('worktree C:/r\r\nHEAD abc\r\nbranch refs/heads/-x\r\n'), '-x');
  assert.equal(checkoutBranch('worktree C:/r\nbare\n\nworktree C:/w\nHEAD abc\nbranch refs/heads/x\n'), null);
  assert.equal(checkoutBranch('worktree C:/r\nHEAD abc\ndetached\n'), null);
  assert.equal(checkoutBranch(null), null);
});
