const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const changes = require('../src/main/changes');
const { wireSurprises } = require('../src/main/wiring/surprises');

const T = c => c.repeat(40);
const A = T('a'), B = T('b'), C = T('c');
const realPatchFor = changes.patchFor;
afterEach(() => { changes.patchFor = realPatchFor; });

// What wiring/surprises.js reads from main, faked: settings, an open tab, its
// saved conversation, and everything the fanfare touches.
function setup({ settings = {}, tab = {}, items = [], patch = '' } = {}) {
  changes.patchFor = async () => ({ patch, truncated: false });
  const store = { ...settings };
  const notes = [];
  const xp = [];
  const said = [];
  const sent = [];
  const tabs = new Map([['tab1', { title: 'Fix login', ...tab }]]);
  const d = {
    config: { get: k => store[k], set: p => Object.assign(store, p) },
    manager: { tabs, note: (id, item) => notes.push([id, item]) },
    history: { load: () => items },
    awardXp: (kind, meta) => xp.push([kind, meta]),
    sayText: text => { said.push(text); return true; },
    send: (_win, channel, payload) => sent.push([channel, payload]),
    outfit: () => ({ confetti: { motion: 'burst' } }),
    log: { info: () => {} },
  };
  return { d, s: wireSurprises(d), store, notes, xp, said, sent, tabs };
}
const settle = () => new Promise(r => setImmediate(r));
const red = (tree, ...names) => ({ status: 'fail', tree, commands: [{ cmd: 'npm run test', ok: false, failed: names }] });
const turn = (before, after, files = [{ path: 'src/auth.js', status: 'M' }]) => ({ root: 'C:\\repo', before, after, files });

test('Claude takes the suite from red to green in one turn: a critical hit', async () => {
  const t = setup();
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 3 });
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: B, ok: true, failing: 0 });
  t.s.noteTurn('tab1', turn(A, B));
  await settle();
  assert.equal(t.notes.length, 1);
  assert.equal(t.notes[0][1].kind, 'surprise');
  assert.equal(t.notes[0][1].what, 'crit');
  assert.match(t.notes[0][1].text, /3 failing tests/);
  assert.deepEqual(t.xp.map(x => x[0]), ['crit']);
  assert.equal(t.said.length, 1);
  const channels = t.sent.map(s => s[0]);
  assert.ok(channels.includes('critter:surprise') && channels.includes('critter:burst'));
  assert.equal(t.sent.find(s => s[0] === 'critter:surprise')[1].badge, 'CRIT!');
  assert.equal(t.store.crits.hits.crit, 1, 'remembered, for the luck');
});

test('the green that arrives after the turn has ended still proves it', async () => {
  const t = setup();
  t.s.noteChecks('tab1', red(A, 'a', 'b'));
  t.s.noteTurn('tab1', turn(A, B));
  await settle();
  assert.equal(t.notes.length, 0, 'not yet: nothing green');
  t.s.noteChecks('tab1', { status: 'pass', tree: B });
  await settle();
  assert.equal(t.notes.length, 1);
});

test('one turn is judged once, however many greens come in', async () => {
  const t = setup();
  t.s.noteChecks('tab1', red(A, 'a'));
  t.s.noteTurn('tab1', turn(A, B));
  t.s.noteChecks('tab1', { status: 'pass', tree: B });
  t.s.noteChecks('tab1', { status: 'pass', tree: B });
  await settle();
  assert.equal(t.xp.length, 1);
});

test('a timed-out check is not red', async () => {
  const t = setup();
  t.s.noteChecks('tab1', { status: 'timeout', tree: A, commands: [] });
  t.s.noteTurn('tab1', turn(A, B));
  t.s.noteChecks('tab1', { status: 'pass', tree: B });
  await settle();
  assert.equal(t.notes.length, 0);
});

test('green by deleting a test file is no crit', async () => {
  const t = setup();
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 1 });
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: B, ok: true });
  t.s.noteTurn('tab1', turn(A, B, [{ path: 'test/auth.test.js', status: 'D' }]));
  await settle();
  assert.equal(t.notes.length, 0);
  assert.equal(t.store.crits, undefined, "it didn't even roll");
});

test('green by skipping the failing test is no crit', async () => {
  const t = setup({ patch: "--- a/test/auth.test.js\n+++ b/test/auth.test.js\n+  it.skip('logs in', async () => {" });
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 1 });
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: B, ok: true });
  t.s.noteTurn('tab1', turn(A, B, [{ path: 'test/auth.test.js', status: 'M' }]));
  await settle();
  assert.equal(t.notes.length, 0);
});

test("a routine's run, the setting off, or just-the-crab mode: no surprises", async () => {
  for (const opts of [{ tab: { routineId: 'r1' } }, { tab: { workflowRunId: 'w1' } }, { settings: { surprises: false } }, { settings: { crabOnly: true } }]) {
    const t = setup(opts);
    t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 2 });
    t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: B, ok: true });
    t.s.noteTurn('tab1', turn(A, B));
    await settle();
    assert.equal(t.notes.length, 0, JSON.stringify(opts));
  }
});

test('a second one straight after is held back by the cooldown', async () => {
  const t = setup();
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 2 });
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: B, ok: true });
  t.s.noteTurn('tab1', turn(A, B));
  await settle();
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: B, ok: false, failing: 1 });
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: C, ok: true });
  t.s.noteTurn('tab1', turn(B, C));
  await settle();
  assert.equal(t.notes.length, 1);
  assert.equal(t.store.crits.misses.crit, 0, "held back isn't a miss");
});

test("on a call (or guarding your focus) it doesn't roll: the guaranteed first one waits for a moment you'll see", async () => {
  const t = setup();
  t.d.life = { hushed: () => true };
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 2 });
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: B, ok: true });
  t.s.noteTurn('tab1', turn(A, B));
  await settle();
  assert.equal(t.notes.length + t.xp.length + t.sent.length, 0);
  assert.equal(t.store.crits, undefined, 'the luck is untouched');
});

test('a fixed typecheck or build is not a red test suite put right', async () => {
  const t = setup();
  t.s.noteChecks('tab1', { status: 'fail', tree: A, commands: [{ cmd: 'npm run typecheck', ok: false, failed: [] }] });
  t.s.noteTurn('tab1', turn(A, B));
  t.s.noteChecks('tab1', { status: 'pass', tree: B });
  await settle();
  assert.equal(t.notes.length, 0);
});

test('tests the flaky detective knows flake going green is luck, not a crit', async () => {
  // The detective's own way of learning it: failed, then passed, on the same code.
  const flaky = require('../src/main/flaky');
  const project = { key: 'aaaaaaaaaaaa', name: 'p', root: 'C:\\p' };
  const run = { cmd: 'bbbbbbbbbbbb', tree: C, parsed: true, complete: true, framework: 'jest' };
  let state = flaky.recordRun(null, project, { ...run, ok: false, failed: ['auth › signs in'] }, Date.now() - 2000).state;
  state = flaky.recordRun(state, project, { ...run, ok: true, failed: [] }, Date.now() - 1000).state;
  const t = setup({ settings: { flaky: state } });
  const known = flaky.flakyView(state, Date.now()).length;
  assert.ok(known >= 1, 'the detective knows it flakes');
  t.s.noteChecks('tab1', red(A, 'auth › signs in'));
  t.s.noteTurn('tab1', turn(A, B));
  t.s.noteChecks('tab1', { status: 'pass', tree: B });
  await settle();
  assert.equal(t.notes.length, 0, `known flaky: ${known}`);
});

test("Claude breaking it one turn and fixing it the next is no crit", async () => {
  const t = setup();
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: A, ok: true });
  t.s.noteTurn('tab1', turn(A, B));
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: B, ok: false, failing: 3 });
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: C, ok: true });
  t.s.noteTurn('tab1', turn(B, C));
  await settle();
  assert.equal(t.notes.length, 0);
});

test('an old green replayed by a later turn (an undo, the same prompt again) counts for nothing', async () => {
  const t = setup();
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 1 });
  t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: B, ok: true });
  t.s.noteTurn('tab1', turn(C, A));        // some other turn, judged first
  await new Promise(r => setTimeout(r, 5));
  t.s.noteTurn('tab1', turn(A, B));        // lands on trees that already have runs, from before it
  await settle();
  assert.equal(t.notes.length, 0);
});

test("a diff that can't be read in full can't vouch for the turn", async () => {
  for (const read of [{ error: 'gone' }, { patch: '', truncated: true }]) {
    const t = setup();
    changes.patchFor = async () => read;
    t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 1 });
    t.s.noteRun('tab1', { via: 'claude', cmd: 'h1', tree: B, ok: true });
    t.s.noteTurn('tab1', turn(A, B));
    await settle();
    assert.equal(t.notes.length, 0, JSON.stringify(read));
  }
});

test('a copy green on its first try comes in for a clean landing', () => {
  const t = setup({ items: [{ kind: 'user' }, { kind: 'checks', status: 'pass' }] });
  assert.equal(t.s.firstLanding('tab1', { status: 'pass' }), true);
  const f = t.s.landed('tab1', { branch: 'shellby/fix-login', base: 'main' });
  assert.equal(f.kind, 'landing');
  assert.equal(t.notes[0][1].what, 'landing');
  assert.equal(t.sent.find(s => s[0] === 'critter:surprise')[1].badge, 'CLEAN LANDING');
});

test('red along the way, or brought home before, is not a first try', () => {
  assert.equal(setup({ items: [{ kind: 'checks', status: 'fail' }] }).s.firstLanding('tab1', { status: 'pass' }), false);
  assert.equal(setup({ items: [{ kind: 'home' }] }).s.firstLanding('tab1', { status: 'pass' }), false);
  assert.equal(setup().s.firstLanding('tab1', undefined), false, 'no checks: no landing to judge');
  assert.equal(setup({ tab: { routineId: 'r' } }).s.firstLanding('tab1', { status: 'pass' }), false);
});
