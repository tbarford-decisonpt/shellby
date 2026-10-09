// Undo to here (src/main/step-undo.js): which steps get a checkpoint, what an
// undo to one would do, and putting files back against a real git repo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { snapshot, restoreTo, undo } = require('../src/main/changes');
const { classify, readOnlyCommand, createTracker, planStep, effectiveAfter, MAX_POINTS } = require('../src/main/step-undo');

const tool = (id, name, extra = {}) => ({ kind: 'tool', id, name, ...extra });
const result = id => ({ kind: 'tool_result', id });
const flush = () => new Promise(r => setImmediate(r));

function tracker({ start = { root: 'R', tree: 't0', turnId: 'T' } } = {}) {
  const notes = [];
  let n = 0;
  const pending = [];
  const t = createTracker({
    // Each snapshot resolves when the test says so, so timing can be tested.
    snapshot: root => new Promise(resolve => pending.push(() => resolve({ root, tree: `t${++n}` }))),
    start: () => start,
    note: item => notes.push(item),
  });
  return { t, notes, settle: async () => { while (pending.length) pending.shift()(); await flush(); }, pending };
}

test('classify: edits and commands are steps, reads and helpers are not', () => {
  assert.equal(classify(tool('a', 'Edit')), 'step');
  assert.equal(classify(tool('a', 'Bash', { detail: 'npm install' })), 'step');
  assert.equal(classify(tool('a', 'Bash', { detail: 'git status' })), 'read');
  assert.equal(classify(tool('a', 'Read')), 'read');
  assert.equal(classify(tool('a', 'Edit', { parent: 'x' })), 'read', "a helper's own steps are not on the turn's rows");
  assert.equal(classify(tool('a', 'Agent')), 'other');
  assert.equal(classify(tool('a', 'mcp__x__write')), 'other');
});

test('readOnlyCommand only passes one plain looking command', () => {
  assert.equal(readOnlyCommand('ls -la'), true);
  assert.equal(readOnlyCommand('git diff HEAD'), true);
  assert.equal(readOnlyCommand('cat a > b'), false);
  assert.equal(readOnlyCommand('git status && rm -rf x'), false);
  assert.equal(readOnlyCommand('echo $(rm x)'), false);
  assert.equal(readOnlyCommand('git commit -m x'), false);
});

test('tracker: the first step gets the turn start, the next one the snapshot after it', async () => {
  const { t, notes, settle } = tracker();
  t.onItem(tool('e1', 'Edit'), 'T');
  t.onItem(result('e1'), 'T');
  await settle();
  t.onItem(tool('r1', 'Read'), 'T'); // reads in between change nothing
  t.onItem(result('r1'), 'T');
  t.onItem(tool('e2', 'Write'), 'T');
  assert.deepEqual(notes.map(n => [n.toolId, n.tree]), [['e1', 't0'], ['e2', 't1']]);
  assert.equal(notes[0].kind, 'step-point');
  assert.equal(notes[0].turnId, 'T');
});

test('tracker: parallel steps and a step asked for mid-snapshot get no checkpoint', async () => {
  const { t, notes, settle } = tracker();
  t.onItem(tool('e1', 'Edit'), 'T');
  t.onItem(tool('e2', 'Edit'), 'T'); // asked while e1 hadn't finished
  t.onItem(result('e1'), 'T');
  t.onItem(result('e2'), 'T');
  t.onItem(tool('e3', 'Edit'), 'T'); // the snapshot after e2 isn't in yet
  await settle();
  t.onItem(result('e3'), 'T');
  await settle();
  t.onItem(tool('e4', 'Edit'), 'T');
  assert.deepEqual(notes.map(n => n.toolId), ['e1', 'e4']);
});

test('tracker: a command left running in the background ends checkpoints for the turn', async () => {
  const { t, notes, settle } = tracker();
  t.onItem(tool('b1', 'Bash', { detail: 'npm run dev', background: true }), 'T');
  t.onItem(result('b1'), 'T');
  await settle();
  t.onItem(tool('e1', 'Edit'), 'T');
  assert.deepEqual(notes.map(n => n.toolId), ['b1']);
});

test('tracker: a new turn starts over, and a turn without a start snapshot gets none', async () => {
  const { t, notes } = tracker({ start: { root: 'R', tree: 't0', turnId: 'OTHER' } });
  t.onItem(tool('e1', 'Edit'), 'T');
  assert.equal(notes.length, 0);
});

test('tracker: at most MAX_POINTS a turn', async () => {
  const { t, notes, settle } = tracker();
  for (let i = 0; i < MAX_POINTS + 5; i++) {
    t.onItem(tool(`e${i}`, 'Edit'), 'T');
    t.onItem(result(`e${i}`), 'T');
    await settle();
  }
  assert.equal(notes.length, MAX_POINTS);
});

const turn = [
  { kind: 'user', turnId: 'T' },
  { kind: 'step-point', turnId: 'T', toolId: 's1', root: 'R', tree: 'c1' },
  { kind: 'step-point', turnId: 'T', toolId: 's2', root: 'R', tree: 'c2' },
  { kind: 'step-point', turnId: 'T', toolId: 's3', root: 'R', tree: 'c3' },
  { kind: 'result', ok: true },
  { kind: 'changes', turnId: 'T', root: 'R', before: 'c1', after: 'END' },
  { kind: 'checkpoint', turnId: 'T', root: 'R', start: 'c1', end: 'END' },
];

test('planStep goes from the turn end back to the step, then from where the last undo left it', () => {
  const p = planStep(turn, 'T', 's2');
  assert.deepEqual([p.ok, p.to, p.from, p.after], [true, 'c2', 'END', 'END']);
  const after = [...turn, { kind: 'undone-step', turnId: 'T', toolId: 's3', to: 'c3', after: 'END' }];
  assert.equal(planStep(after, 'T', 's2').from, 'c3');
  assert.equal(planStep(after, 'T', 's3').ok, false, 'already undone');
});

test('planStep refuses a step whose turn has no end yet, or was undone whole', () => {
  assert.equal(planStep(turn.slice(0, 5), 'T', 's1').ok, false);
  assert.equal(planStep([...turn, { kind: 'undone', after: 'END' }], 'T', 's1').ok, false);
  assert.equal(planStep(turn, 'T', 'nope').ok, false);
});

test('effectiveAfter moves a turn undo to start from where Undo to here left it', () => {
  const ref = { root: 'R', before: 'c1', after: 'END' };
  assert.deepEqual(effectiveAfter(turn, ref), ref);
  const after = [...turn, { kind: 'undone-step', turnId: 'T', toolId: 's2', to: 'c2', after: 'END' }];
  assert.equal(effectiveAfter(after, ref).after, 'c2');
});

function repo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-steps-')));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  const write = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  return { dir, write, read, exists: f => fs.existsSync(path.join(dir, f)), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('restoreTo takes later steps back, then the turn undo finishes the job', async () => {
  const r = repo();
  try {
    const start = await snapshot(r.dir);
    r.write('a.txt', 'two\n');                  // step 1
    const c2 = await snapshot(r.dir);
    r.write('a.txt', 'three\n');                // step 2
    r.write('new.txt', 'made\n');
    const end = await snapshot(r.dir);
    const back = await restoreTo({ root: r.dir, to: c2.tree, from: end.tree });
    assert.deepEqual(back, { ok: true, restored: 2 });
    assert.equal(r.read('a.txt'), 'two\n');
    assert.equal(r.exists('new.txt'), false);
    // The turn's own Undo, from where the step undo left it.
    const items = [
      { kind: 'changes', turnId: 'T', root: r.dir, before: start.tree, after: end.tree },
      { kind: 'undone-step', turnId: 'T', toolId: 's2', to: c2.tree, after: end.tree },
    ];
    const u = await undo(effectiveAfter(items, { root: r.dir, before: start.tree, after: end.tree }));
    assert.equal(u.ok, true);
    assert.equal(r.read('a.txt'), 'one\n');
  } finally { r.done(); }
});

test('restoreTo asks before overwriting a file changed after the turn', async () => {
  const r = repo();
  try {
    const c1 = await snapshot(r.dir);
    r.write('a.txt', 'claude\n');
    const end = await snapshot(r.dir);
    r.write('a.txt', 'mine\n');                 // you, after the turn
    const first = await restoreTo({ root: r.dir, to: c1.tree, from: end.tree });
    assert.equal(first.ok, false);
    assert.deepEqual(first.changedSince, ['a.txt']);
    assert.equal(r.read('a.txt'), 'mine\n', 'nothing touched until you say so');
    const forced = await restoreTo({ root: r.dir, to: c1.tree, from: end.tree }, { force: true });
    assert.equal(forced.ok, true);
    assert.equal(r.read('a.txt'), 'one\n');
  } finally { r.done(); }
});

test('readOnlyCommand treats a looking command that writes a file as a step', () => {
  assert.equal(readOnlyCommand('git diff --output=patch.diff'), false);
  assert.equal(readOnlyCommand('rg --pre ./x.sh foo'), false);
  assert.equal(readOnlyCommand('git log -o out.txt'), false);
  assert.equal(readOnlyCommand('git diff --stat'), true);
});

test("planStep keeps a scoped turn to its own files, never another conversation's", () => {
  assert.equal(planStep(turn, 'T', 's2').paths, undefined);
  const scoped = turn.map(i => (i.kind === 'changes' ? { ...i, scoped: true, files: [{ path: 'mine.js' }] } : i));
  if (!scoped.some(i => i.kind === 'changes')) scoped.push({ kind: 'changes', turnId: 'T', root: 'R', before: 'c1', after: 'END', scoped: true, files: [{ path: 'mine.js' }] });
  assert.deepEqual(planStep(scoped, 'T', 's2').paths, ['mine.js']);
});
