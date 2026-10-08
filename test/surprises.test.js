const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/main/surprises');

const T = c => c.repeat(40);         // a git tree id
const A = T('a'), B = T('b'), C = T('c');
const NOON = new Date(2026, 9, 6, 12, 0, 0).getTime();
const MIN = 60000;

// ------------------------------------------------------------------ critOf

test('a turn that starts red and ends green on its own trees is a crit', () => {
  const crit = s.critOf({
    turn: { before: A, after: B },
    runs: [
      { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 3, at: 1 },
      { via: 'claude', cmd: 'h1', tree: B, ok: true, failing: 0, at: 2 },
    ],
  });
  assert.deepEqual(crit, { failing: 3, via: 'claude' });
});

test("Shellby's own checks prove it too, red from a gate and green after the turn", () => {
  const crit = s.critOf({
    turn: { before: A, after: B },
    runs: [{ via: 'checks', tree: A, ok: false, failing: 2, at: 1 }, { via: 'checks', tree: B, ok: true, failing: 0, at: 5 }],
  });
  assert.deepEqual(crit, { failing: 2, via: 'checks' });
});

test("a turn that broke the suite and mended it itself isn't a crit", () => {
  const crit = s.critOf({
    turn: { before: A, after: C },
    runs: [{ via: 'claude', cmd: 'h1', tree: B, ok: false, failing: 4, at: 1 }, { via: 'claude', cmd: 'h1', tree: C, ok: true, at: 2 }],
  });
  assert.equal(crit, null, 'the red was on a tree in the middle of the turn, not where it started');
});

test('green has to be where the turn ended, with nothing changed after it', () => {
  const crit = s.critOf({
    turn: { before: A, after: C },
    runs: [{ via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 1, at: 1 }, { via: 'claude', cmd: 'h1', tree: B, ok: true, at: 2 }],
  });
  assert.equal(crit, null);
});

test('a different command going green proves nothing about the red one', () => {
  const crit = s.critOf({
    turn: { before: A, after: B },
    runs: [{ via: 'claude', cmd: 'whole-suite', tree: A, ok: false, failing: 5, at: 1 }, { via: 'claude', cmd: 'one-file', tree: B, ok: true, at: 2 }],
  });
  assert.equal(crit, null);
});

test("Claude's green doesn't stand in for Shellby's red checks", () => {
  const crit = s.critOf({
    turn: { before: A, after: B },
    runs: [{ via: 'checks', tree: A, ok: false, failing: 5, at: 1 }, { via: 'claude', cmd: 'h1', tree: B, ok: true, at: 2 }],
  });
  assert.equal(crit, null);
});

test("red with no failing test named (it wouldn't start, it timed out) is not a red suite", () => {
  const crit = s.critOf({
    turn: { before: A, after: B },
    runs: [{ via: 'checks', tree: A, ok: false, failing: 0, at: 1 }, { via: 'checks', tree: B, ok: true, at: 2 }],
  });
  assert.equal(crit, null);
});

test('a turn that changed nothing, or a run on the same tree (a flake), is never a crit', () => {
  const runs = [{ via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 1, at: 1 }, { via: 'claude', cmd: 'h1', tree: A, ok: true, at: 2 }];
  assert.equal(s.critOf({ turn: { before: A, after: A }, runs }), null);
  assert.equal(s.critOf({ turn: null, runs }), null);
  assert.equal(s.critOf({ turn: { before: 'nope', after: B }, runs }), null);
});

test('the crit counts the biggest red the turn put right', () => {
  const crit = s.critOf({
    turn: { before: A, after: B },
    runs: [
      { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 2, at: 1 },
      { via: 'checks', tree: A, ok: false, failing: 7, at: 2 },
      { via: 'checks', tree: B, ok: true, at: 3 },
    ],
  });
  assert.equal(crit.failing, 7);
});

// ------------------------------------------------------------------ shortcutIn

test('deleting a test file is a shortcut, deleting other code is not', () => {
  assert.match(s.shortcutIn({ files: [{ path: 'test/auth.test.js', status: 'D' }] }), /deleted/);
  assert.match(s.shortcutIn({ files: [{ path: 'pkg/thing_test.go', status: 'D' }] }), /deleted/);
  assert.equal(s.shortcutIn({ files: [{ path: 'src/old.js', status: 'D' }, { path: 'test/a.test.js', status: 'M' }] }), null);
});

test('skips and onlys added to a test file are shortcuts', () => {
  const diff = (file, line) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-  it('x', () => {})\n+${line}\n`;
  for (const line of ["  it.skip('logs in', () => {", "  test.only('one', () => {", "  xit('logs in', () => {", '@pytest.mark.skip(reason="later")', '#[ignore]', '\tt.Skip("flaky")', "test('a', { skip: true }, () => {})"]) {
    const file = line.startsWith('@') ? 'tests/test_auth.py' : line.startsWith('#') ? 'src/lib_test.rs' : line.startsWith('\t') ? 'auth_test.go' : 'test/auth.test.js';
    assert.equal(s.shortcutIn({ patch: diff(file, line) }), 'skipped tests', line);
  }
});

test("the same words outside a test file, or taken away, aren't a shortcut", () => {
  const patch = [
    '--- a/src/terminal.js', '+++ b/src/terminal.js', '+  fitAddon.fit();', '+  const opts = { skip: true };',
    '--- a/test/auth.test.js', '+++ b/test/auth.test.js', "-  it.skip('logs in', () => {", "+  it('logs in', () => {",
  ].join('\n');
  assert.equal(s.shortcutIn({ patch }), null, 'un-skipping a test is the opposite of a shortcut');
});

test('telling the runner to leave tests out is a shortcut anywhere', () => {
  assert.equal(s.shortcutIn({ patch: '+++ b/jest.config.js\n+  testPathIgnorePatterns: ["auth"],' }), 'left tests out');
  assert.equal(s.shortcutIn({ patch: '+++ b/package.json\n+    "test": "pytest --deselect tests/test_a.py::x"' }), 'left tests out');
});

test('taking test cases away is a shortcut, swapping one for another is not', () => {
  const file = (lines) => ['--- a/test/auth.test.js', '+++ b/test/auth.test.js', '@@ -1,3 +1,3 @@', ...lines].join('\n');
  assert.equal(s.shortcutIn({ patch: file(["-it('logs in', () => {", '-  expect(x).toBe(1);', '-});']) }), 'removed tests');
  assert.equal(s.shortcutIn({ patch: file(["-it('logs in', () => {", "+it('logs in with a token', () => {"]) }), null);
  assert.equal(s.shortcutIn({ patch: ['--- a/pkg/auth_test.go', '+++ b/pkg/auth_test.go', '-func TestLogin(t *testing.T) {'].join('\n') }), 'removed tests');
});

test("an added line that starts with ++ isn't a file header", () => {
  const patch = ['--- a/test/auth.test.js', '+++ b/test/auth.test.js', '@@ -1 +1,2 @@', '+++ b/src/not-a-test.js', "+it.only('x', () => {})"].join('\n');
  assert.equal(s.shortcutIn({ patch }), 'skipped tests', 'still in the test file');
});

test('a test script told to pass no matter what is a shortcut; `|| true` in other shell is not', () => {
  assert.equal(s.shortcutIn({ patch: '--- a/package.json\n+++ b/package.json\n+    "test": "jest || true",' }), 'left tests out');
  assert.equal(s.shortcutIn({ patch: '--- a/package.json\n+++ b/package.json\n+    "test": "jest --passWithNoTests",' }), 'left tests out');
  assert.equal(s.shortcutIn({ patch: '--- a/Makefile\n+++ b/Makefile\n+\trm -f build.log || true' }), null);
});

test('a red the previous turn made from green, or only known-flaky tests, is no crit', () => {
  const runs = [
    { via: 'claude', cmd: 'h1', tree: C, ok: true, at: 1 },
    { via: 'claude', cmd: 'h1', tree: A, ok: false, failing: 2, names: ['a', 'b'], at: 2 },
    { via: 'claude', cmd: 'h1', tree: B, ok: true, at: 3 },
  ];
  assert.equal(s.critOf({ turn: { before: A, after: B }, runs, prev: { before: C, after: A } }), null, 'it broke it itself');
  assert.ok(s.critOf({ turn: { before: A, after: B }, runs, prev: { before: T('d'), after: A } }), 'red before the last turn too: fair');
  assert.equal(s.critOf({ turn: { before: A, after: B }, runs, flaky: () => true }), null);
  assert.ok(s.critOf({ turn: { before: A, after: B }, runs, flaky: n => n === 'a' }), 'one real failure is enough');
  assert.equal(s.critOf({ turn: { before: A, after: B }, runs, since: 3 }), null, 'a green from before this turn');
});

// ------------------------------------------------------------------ firstTry

test('a copy comes home on the first try when its checks never went red', () => {
  const green = { status: 'pass' };
  assert.equal(s.firstTry(green, [{ kind: 'checks', status: 'pass' }, { kind: 'text' }]), true);
  assert.equal(s.firstTry(green, []), true);
  assert.equal(s.firstTry(green, [{ kind: 'checks', status: 'fail' }, { kind: 'checks', status: 'pass' }]), false, 'red along the way');
  assert.equal(s.firstTry(green, [{ kind: 'checks', status: 'timeout' }]), false);
  assert.equal(s.firstTry(green, [{ kind: 'home' }]), false, 'brought home before');
  assert.equal(s.firstTry({ status: 'fail' }, []), false);
  assert.equal(s.firstTry(null, []), false, 'no checks ran: nothing to say it was clean');
});

// ------------------------------------------------------------------ roll

test('the first of each kind always lands', () => {
  const r = s.roll(null, 'crit', { now: NOON, rng: () => 0.999 });
  assert.equal(r.hit, true);
  assert.equal(r.state.hits.crit, 1);
  const l = s.roll(null, 'landing', { now: NOON, rng: () => 0.999 });
  assert.equal(l.hit, true);
});

test('after the first it is a roll, and a miss makes the next likelier', () => {
  let state = s.roll(null, 'crit', { now: NOON, rng: () => 0 }).state;
  const at = NOON + 2 * s.COOLDOWN;
  const miss = s.roll(state, 'crit', { now: at, rng: () => 0.99 });
  assert.equal(miss.hit, false);
  assert.equal(miss.state.misses.crit, 1);
  assert.ok(s.chanceOf('crit', miss.state) > s.chanceOf('crit', state), 'pity');
  state = miss.state;
  const hit = s.roll(state, 'crit', { now: at + 1, rng: () => 0 });
  assert.equal(hit.hit, true);
  assert.equal(hit.state.misses.crit, 0, 'a hit resets the luck');
});

test('a bigger mess put right is likelier to crit, and nothing is ever certain', () => {
  const seen = { hits: { crit: 1, landing: 1 } };
  assert.ok(s.chanceOf('crit', seen, { failing: 12 }) > s.chanceOf('crit', seen, { failing: 1 }));
  assert.ok(s.chanceOf('crit', { ...seen, misses: { crit: 10 } }, { failing: 999 }) <= s.MAX_CHANCE);
  assert.ok(s.MAX_CHANCE < 1);
});

test("the chance never reads anything about speed", () => {
  const seen = { hits: { crit: 1 } };
  const plain = s.chanceOf('crit', seen, { failing: 3 });
  assert.equal(s.chanceOf('crit', seen, { failing: 3, durationMs: 1, turns: 1, fast: true }), plain);
});

test('a cooldown between surprises, which is not a miss', () => {
  const first = s.roll(null, 'crit', { now: NOON, rng: () => 0 }).state;
  const r = s.roll(first, 'landing', { now: NOON + 5 * MIN, rng: () => 0 });
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'cooldown');
  assert.equal(r.state.misses.landing, 0);
});

test('only a few in a day, and a new day starts over', () => {
  let state = null;
  let at = NOON - 3 * 60 * MIN;
  for (let i = 0; i < s.A_DAY; i++) {
    const r = s.roll(state, 'crit', { now: at, rng: () => 0 });
    assert.equal(r.hit, true, `surprise ${i + 1}`);
    state = r.state;
    at += s.COOLDOWN + MIN;
  }
  assert.equal(s.roll(state, 'crit', { now: at, rng: () => 0 }).reason, 'daily');
  const tomorrow = at + 24 * 60 * MIN;
  assert.equal(s.roll(state, 'crit', { now: tomorrow, rng: () => 0 }).hit, true);
});

test('state that was tampered with or is missing comes back sane', () => {
  const n = s.normalize({ lastAt: 'x', today: -4, misses: { crit: 99, nope: 3 }, hits: null, day: 'garbage', lines: { crit: 2.5 } });
  assert.deepEqual(n, { lastAt: 0, day: '', today: 0, misses: { crit: 10, landing: 0 }, hits: { crit: 0, landing: 0 }, lines: { crit: -1, landing: -1 } });
  assert.equal(s.roll(null, 'nope', { now: NOON }).hit, false);
});

// ------------------------------------------------------------------ fanfare

test('the fanfare says what happened, and not the same line twice running', () => {
  const f = s.fanfare('crit', { failing: 3 }, { rng: () => 0 });
  assert.equal(f.title, 'Critical hit!');
  assert.match(f.note, /3 failing tests to green/);
  const g = s.fanfare('crit', { failing: 3 }, { rng: () => 0, state: f.state });
  assert.notEqual(g.line, f.line);
  for (let i = 0; i < 20; i++) assert.ok(s.fanfare('crit', { failing: 2 }, { rng: Math.random }).line.length <= 120);
});

test('a huge red put right is the big crit', () => {
  const f = s.fanfare('crit', { failing: 14 }, { rng: () => 0 });
  assert.equal(f.big, true);
  assert.equal(f.title, 'Critical hit ×14!');
  assert.equal(s.fanfare('crit', { failing: 2 }, { rng: () => 0 }).big, false);
});

test('a clean landing names the branch, or the copies when several came home', () => {
  const one = s.fanfare('landing', { branch: 'shellby/fix-login', base: 'main' }, { rng: () => 0 });
  assert.equal(one.title, 'Clean landing');
  assert.match(one.line, /shellby\/fix-login/);
  assert.match(one.note, /to main/);
  const many = s.fanfare('landing', { copies: 3 }, { rng: () => 0 });
  assert.match(many.note, /3 copies/);
});
