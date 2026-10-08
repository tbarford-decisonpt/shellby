// Try it N ways' wiring (src/main/wiring/tries.js) with fake tabs, History and
// confirmation: it never starts without the question being answered yes, the
// tries are grouped as one family, and once each has run its checks the card
// ranks them. Nothing is kept or thrown away.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { wireTries } = require('../src/main/wiring/tries');
const branch = require('../src/main/branch');

function fake({ answer = 0, estimate = null, root = 'C:\\code\\app', settings = {}, filesDir = path.join(os.tmpdir(), 'shellby-test-try-files') } = {}) {
  const tabs = new Map();
  const entries = new Map();
  const items = new Map();
  const asked = [];
  const started = [];
  const checked = [];
  const pushes = [];
  let n = 0;
  const manager = Object.assign(new EventEmitter(), {
    tabs,
    note: (id, item) => { items.set(id, [...(items.get(id) || []), item]); },
    changed: () => {},
    interrupt: id => { tabs.get(id).interrupted = true; },
  });
  const d = {
    config: { get: k => ({ crabOnly: false, ...settings })[k] },
    claudeStatus: { installed: true, loggedIn: true },
    manager,
    panel: null,
    history: {
      get: id => entries.get(id) || null,
      update: (id, patch) => entries.set(id, { ...(entries.get(id) || { id }), ...patch }),
      load: id => items.get(id) || [],
      append: (id, item) => items.set(id, [...(items.get(id) || []), item]),
      list: () => [...entries.values()],
    },
    worktreeHome: () => 'C:\\Users\\me\\AppData\\Roaming\\Shellby\\worktrees',
    randomUUID: () => `run-${++n}`,
    usagePlan: { estimateFor: () => estimate },
    startTaskInCopy: async (dir, title, promptFor, opts) => {
      const tabId = `try-${started.length + 1}`;
      started.push({ dir, title, prompt: promptFor({ branch: 'b', base: 'main' }), opts });
      tabs.set(tabId, { id: tabId, title, turnId: `turn-${tabId}`, session: { cwd: dir, mode: opts.mode } });
      entries.set(tabId, { id: tabId, title, createdAt: started.length });
      return { ok: true, tabId };
    },
    changeRef: r => ({ ...r }),
    checkTry: async ref => { checked.push(ref.tabId); return ref.tabId === 'try-1' ? { status: 'fail', failing: 2 } : { status: 'pass', failing: 0 }; },
    cancelChecks: () => {},
    send: (_win, channel, payload) => pushes.push({ channel, payload }),
    notify: () => {},
    showPanel: () => {},
    stat: () => {},
    wake: () => {},
    log: { info: () => {} },
  };
  tabs.set('src', { id: 'src', title: 'Mine', session: { cwd: 'C:\\code\\app', mode: 'ask' } });
  const wired = wireTries(d, { ask: async spec => { asked.push(spec); return answer; }, rootOf: async () => root, maxTabs: 32, filesDir: () => filesDir });
  return { d, wired, tabs, entries, items, asked, started, checked, pushes };
}

const changesFor = (id, files = 2, added = 10, removed = 1) => ({ kind: 'changes', turnId: `turn-${id}`, root: 'C:\\x', before: 'a'.repeat(40), after: 'b'.repeat(40), files: Array.from({ length: files }, (_, i) => ({ path: `f${i}` })), added, removed });

test('it always asks first, and a no starts nothing', async () => {
  const f = fake({ answer: 1 });
  const r = await f.wired.start({ tabId: 'src', n: 3, text: 'fix the login' });
  assert.deepEqual(r, { ok: false, cancelled: true });
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0].title, 'Try this three ways?');
  assert.equal(f.started.length, 0);
});

test('closing the question (no answer) starts nothing either', async () => {
  const f = fake({ answer: null });
  const r = await f.wired.start({ tabId: 'src', n: 2, text: 'fix it' });
  assert.equal(r.ok, false);
  assert.equal(f.started.length, 0);
});

test('not a git project: says why without asking', async () => {
  const f = fake({ root: null });
  const r = await f.wired.start({ tabId: 'src', n: 2, text: 'fix it' });
  assert.match(r.error, /git project/);
  assert.equal(f.asked.length, 0);
});

test('too few free tabs: says why without asking', async () => {
  const f = fake();
  for (let i = 0; i < 30; i++) f.tabs.set(`t${i}`, { id: `t${i}` });
  const r = await f.wired.start({ tabId: 'src', n: 3, text: 'fix it' });
  assert.match(r.error, /room for 1/);
  assert.equal(f.asked.length, 0);
});

test('yes: N copies, the same prompt and mode, grouped as one family', async () => {
  const f = fake({ estimate: { pct: 8, basis: 'kind', left: 40, nowPct: 20, line: 75, guardOn: true } });
  const r = await f.wired.start({ tabId: 'src', n: 3, text: 'fix the login' });
  assert.equal(r.ok, true);
  assert.equal(r.started, 3);
  assert.equal(r.firstId, 'try-1');
  assert.match(f.asked[0].message, /about 24% in all/);
  assert.deepEqual(f.started.map(s => s.title), ['⑂ 1/3 fix the login', '⑂ 2/3 fix the login', '⑂ 3/3 fix the login']);
  assert.ok(f.started.every(s => s.prompt === 'fix the login' && s.opts.mode === 'ask' && s.dir === 'C:\\code\\app'));
  assert.deepEqual(branch.family(f.d.history.list(), 'try-3').map(e => e.id), ['try-1', 'try-2', 'try-3']);
  const card = f.items.get('try-1').at(-1);
  assert.equal(card.kind, 'tries');
  assert.equal(card.final, false);
  assert.equal(card.rows.length, 3);
});

test('as each ends its checks run; once all have, the card ranks them and nothing is kept', async () => {
  const f = fake();
  const r = await f.wired.start({ tabId: 'src', n: 2, text: 'fix it' });
  f.items.set('try-1', [...f.items.get('try-1'), changesFor('try-1', 1, 3, 1)]);
  f.items.set('try-2', [changesFor('try-2', 3, 40, 2)]);
  await f.wired.turnEnded('try-1', { kind: 'result', ok: true, durationMs: 1000 });
  assert.equal(f.items.get('try-1').at(-1).final, false);
  await f.wired.turnEnded('try-2', { kind: 'result', ok: true, durationMs: 2000 });
  assert.deepEqual(f.checked, ['try-1', 'try-2']);
  const card = f.items.get('try-1').at(-1);
  assert.equal(card.final, true);
  assert.equal(card.runId, r.runId);
  assert.deepEqual(card.rows.map(x => [x.tabId, x.checks, x.place]), [['try-2', 'pass', 1], ['try-1', 'fail', 2]]);
  assert.equal(card.rows[0].files, 3);
  assert.equal(card.rows[1].failing, 2);
  assert.equal(f.pushes.find(p => p.channel === 'tries:done').payload.firstId, 'try-1');
  assert.equal(f.wired.stop(r.runId).ok, false, 'a finished run has nothing to stop');
});

test('Stop all tries stops the ones still working; they rank last', async () => {
  const f = fake();
  const r = await f.wired.start({ tabId: 'src', n: 2, text: 'fix it' });
  f.items.set('try-2', [changesFor('try-2')]);
  await f.wired.turnEnded('try-2', { kind: 'result', ok: true, durationMs: 500 });
  const s = f.wired.stop(r.runId);
  assert.deepEqual(s, { ok: true, stopped: 1 });
  assert.equal(f.tabs.get('try-1').interrupted, true);
  await f.wired.turnEnded('try-1', { kind: 'result', ok: false, interrupted: true });
  const card = f.wired.status(r.runId);
  assert.equal(card.final, true);
  assert.deepEqual(card.rows.map(x => [x.tabId, x.state]), [['try-2', 'done'], ['try-1', 'stopped']]);
});

test('a try whose tab closes stops being waited for', async () => {
  const f = fake();
  const r = await f.wired.start({ tabId: 'src', n: 2, text: 'fix it' });
  f.items.set('try-1', [...f.items.get('try-1'), changesFor('try-1')]);
  await f.wired.turnEnded('try-1', { kind: 'result', ok: true });
  f.d.manager.emit('tabs', [{ id: 'src' }, { id: 'try-1' }]);
  const card = f.wired.status(r.runId);
  assert.equal(card.final, true);
  assert.equal(card.rows.find(x => x.tabId === 'try-2').state, 'gone');
});

test('turns in other tabs, and later turns in a try, are not counted', async () => {
  const f = fake();
  await f.wired.start({ tabId: 'src', n: 2, text: 'fix it' });
  await f.wired.turnEnded('src', { kind: 'result', ok: true });
  await f.wired.turnEnded('try-1', { kind: 'result', ok: false });
  await f.wired.turnEnded('try-1', { kind: 'result', ok: true });
  assert.deepEqual(f.checked, []);
});

test('attachments go to every try: project files point at its own copy, the rest as they are', async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tries-attach-')));
  try {
    const repo = path.join(base, 'repo');
    const copy = i => path.join(base, 'worktrees', `c${i}`, 'repo');
    for (const dir of [repo, copy(1), copy(2)]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'login.js'), ''); }
    fs.writeFileSync(path.join(repo, 'notes.md'), 'not committed');
    const shot = path.join(base, 'screenshot-1.png');
    fs.writeFileSync(shot, 'png');
    const f = fake({ root: repo, filesDir: path.join(base, 'try-files') });
    f.tabs.get('src').session.cwd = repo;
    const files = [path.join(repo, 'login.js'), path.join(repo, 'notes.md'), shot];
    const r = await f.wired.start({ tabId: 'src', n: 2, text: 'fix the login', attachments: files });
    assert.equal(r.ok, true);
    assert.match(f.asked[0].detail, /and all 3 attachments/);
    const got = f.started.map((s, i) => s.opts.attachments({ path: copy(i + 1) }));
    assert.equal(got[0][0], path.join(copy(1), 'login.js'));
    assert.equal(got[1][0], path.join(copy(2), 'login.js'));
    assert.equal(fs.readFileSync(got[0][1], 'utf8'), 'not committed');
    assert.notEqual(got[0][1], got[1][1], 'a snapshot each');
    assert.ok(got.every(g => !g[1].startsWith(repo)), 'never your checkout\'s file');
    assert.deepEqual(got.map(g => g[2]), [shot, shot]);
    assert.ok(f.started.every(s => s.prompt === 'fix the login'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('no attachments: the tries are sent as before; too many: refused before asking', async () => {
  const f = fake();
  await f.wired.start({ tabId: 'src', n: 2, text: 'fix it' });
  assert.ok(f.started.every(s => s.opts.attachments === undefined));
  const g = fake();
  const many = Array.from({ length: 21 }, (_, i) => `C:\\code\\app\\f${i}.txt`);
  const r = await g.wired.start({ tabId: 'src', n: 2, text: 'fix it', attachments: many });
  assert.match(r.error, /20 attachments at most/);
  assert.equal(g.asked.length, 0);
});

test('a try that finishes while the next is still being copied counts, and the run still finishes', async () => {
  const f = fake();
  const realStart = f.d.startTaskInCopy;
  // The first try is done before the second copy exists.
  f.d.startTaskInCopy = async (...args) => {
    const r = await realStart(...args);
    if (r.tabId === 'try-2') {
      f.items.set('try-1', [...(f.items.get('try-1') || []), changesFor('try-1', 1, 3, 1)]);
      await f.wired.turnEnded('try-1', { kind: 'result', ok: true, durationMs: 500 });
    }
    return r;
  };
  const r = await f.wired.start({ tabId: 'src', n: 2, text: 'fix it' });
  assert.equal(r.ok, true);
  assert.deepEqual(f.checked, ['try-1'], 'its checks ran, though the run was still starting');
  assert.equal(f.items.get('try-1').at(-1).final, false, 'not finished with one still to go');
  f.items.set('try-2', [changesFor('try-2', 2, 5, 0)]);
  await f.wired.turnEnded('try-2', { kind: 'result', ok: true, durationMs: 900 });
  assert.equal(f.items.get('try-1').at(-1).final, true);
});
