const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/main/review-mastery');

const T0 = new Date(2026, 9, 1, 12).getTime();
const turn = (n, tab = 'tab-1') => `${tab}:${String(n).padStart(40, '0')}`;
const REAL = 'This drops the error from the fetch: handle the rejection.';
const comment = (over = {}) => ({ file: 'src/app.js', body: REAL, start: 10, end: 12, side: 'new', ...over });

test('the stoplist and the 12-character rule', () => {
  for (const body of ['lgtm', 'LGTM!', 'looks good to me', '+1', 'ok', 'Nice.', 'ship it', 'aaaaaaaaaaaaaaaa', '   short one ']) {
    assert.equal(m.substantive(body), false, body);
  }
  assert.equal(m.substantive('Rename this to fetchUser'), true);
  assert.equal(m.substantive(REAL), true);
});

test('comments pay once per turn, only when one says something on a big enough diff', () => {
  const said = m.onComments(null, { turnId: turn(1), tabId: 'tab-1', comments: [comment(), comment({ body: 'lgtm' })], diffLines: 40 }, T0);
  assert.equal(said.points, 1);
  assert.equal(said.state.points, 1);
  assert.equal(said.state.comments.turns[turn(1)].n, 1, 'only the real one is counted');
  assert.equal(m.onComments(said.state, { turnId: turn(1), tabId: 'tab-1', comments: [comment()], diffLines: 40 }, T0 + 1).reason, 'same-turn');
  assert.equal(m.onComments(null, { turnId: turn(2), comments: [comment({ body: 'nice' })], diffLines: 40 }, T0).reason, 'says-nothing');
  assert.equal(m.onComments(null, { turnId: turn(3), comments: [comment()], diffLines: 9 }, T0).reason, 'small-diff');
  assert.equal(m.onComments(null, { turnId: 'nope', comments: [comment()], diffLines: 40 }, T0).reason, 'no-turn');
});

function commented(at = T0, lines = { start: 10, end: 12 }) {
  return m.onComments(null, { turnId: turn(1), tabId: 'tab-1', comments: [comment(lines)], diffLines: 40 }, at).state;
}

test('caught needs the next turn to touch the commented lines', () => {
  const s = commented();
  assert.deepEqual(m.openTurns(s, 'tab-1', T0 + 1000).map(t => t.turnId), [turn(1)]);
  const hit = m.onNextTurn(s, { forTurn: turn(1), turnId: turn(2), edits: [['src/app.js', 14, 15]] }, T0 + 60000);
  assert.equal(hit.caught, true);
  assert.equal(hit.points, 5);
  assert.equal(hit.state.caught, 1);
  assert.equal(hit.state.points, 6);
  assert.equal(m.openTurns(hit.state, 'tab-1', T0 + 70000).length, 0, 'one chance per reviewed turn');
  const again = m.onNextTurn(hit.state, { forTurn: turn(1), turnId: turn(3), edits: [['src/app.js', 10, 10]] }, T0 + 80000);
  assert.equal(again.caught, false);
});

test('an edit elsewhere, or in another file, is not a catch, and closes the turn', () => {
  const s = commented();
  const far = m.onNextTurn(s, { forTurn: turn(1), turnId: turn(2), edits: [['src/app.js', 30, 31], ['src/other.js', 10, 12]] }, T0 + 1000);
  assert.equal(far.caught, false);
  assert.equal(far.reason, 'missed');
  assert.equal(far.state.points, 1);
  assert.equal(m.openTurns(far.state, 'tab-1', T0 + 2000).length, 0);
});

test('caught needs no push or merge in between', () => {
  const r = m.onNextTurn(commented(), { forTurn: turn(1), turnId: turn(2), edits: [['src/app.js', 11, 11]], shipped: true }, T0 + 1000);
  assert.equal(r.caught, false);
  assert.equal(r.reason, 'shipped');
});

test('caught has to come soon, from another turn, on the same tab', () => {
  const s = commented();
  assert.equal(m.onNextTurn(s, { forTurn: turn(1), turnId: turn(2), edits: [['src/app.js', 11, 11]] }, T0 + m.CAUGHT_WINDOW + 1).reason, 'too-late');
  assert.equal(m.onNextTurn(s, { forTurn: turn(1), turnId: turn(1), edits: [['src/app.js', 11, 11]] }, T0 + 1).reason, 'same-turn');
  assert.equal(m.openTurns(s, 'tab-2', T0 + 1).length, 0);
  // Paths match whichever slashes they're written with.
  assert.equal(m.onNextTurn(s, { forTurn: turn(1), turnId: turn(2), edits: [['src\\app.js', 9, 9]] }, T0 + 1).caught, true);
});

test('comments on removed lines pay but can never catch', () => {
  const s = m.onComments(null, { turnId: turn(1), tabId: 'tab-1', comments: [comment({ side: 'old' })], diffLines: 40 }, T0).state;
  assert.equal(s.points, 1);
  assert.equal(m.openTurns(s, 'tab-1', T0 + 1).length, 0);
});

test('the quiz streak needs distinct turns, and a fail never lowers the best', () => {
  let s = null;
  const r = m.onQuiz(s, { turnId: turn(1), lines: 40, passed: true }, T0);
  assert.equal(r.points, 3);
  s = r.state;
  assert.equal(m.onQuiz(s, { turnId: turn(1), lines: 40, passed: true }, T0).reason, 'same-turn');
  assert.equal(m.onQuiz(s, { turnId: turn(9), lines: 10, passed: true }, T0).reason, 'too-small');
  s = m.onQuiz(s, { turnId: turn(2), lines: 40, passed: true }, T0).state;
  s = m.onQuiz(s, { turnId: turn(3), lines: 40, passed: true }, T0).state;
  assert.equal(s.quiz.streak, 3);
  assert.equal(s.quiz.best, 3);
  s = m.onQuiz(s, { turnId: turn(4), lines: 40, passed: false }, T0).state;
  assert.equal(s.quiz.streak, 0);
  assert.equal(s.quiz.best, 3);
  assert.equal(s.points, 9);
});

test('tier thresholds: points, then catches and a quiz run', () => {
  const at = (points, caught, best) => m.tierOf({ points, caught, quiz: { streak: 0, best } });
  assert.equal(at(9, 0, 0), 0);
  assert.equal(at(10, 0, 0), 1);
  assert.equal(at(30, 0, 2), 1);
  assert.equal(at(30, 0, 3), 2);
  assert.equal(at(75, 4, 3), 2);
  assert.equal(at(75, 5, 3), 3);
  assert.equal(at(150, 15, 4), 3);
  assert.equal(at(150, 15, 5), 4);
  assert.equal(at(300, 40, 5), 5);
  assert.equal(m.tierOf({ points: 0, caught: 0, tier: 3 }), 3, 'a tier reached is never lost');
});

test('reaching a tier reports it once', () => {
  let s = { points: 9, caught: 0, quiz: { streak: 0, best: 0 } };
  const r = m.onComments(s, { turnId: turn(1), tabId: 'tab-1', comments: [comment()], diffLines: 40 }, T0);
  assert.equal(r.tierUp.n, 1);
  assert.equal(r.state.tier, 1);
  s = r.state;
  assert.equal(m.onComments(s, { turnId: turn(2), tabId: 'tab-1', comments: [comment()], diffLines: 40 }, T0).tierUp, null);
});

test('editsOf finds the changed lines in the numbering before the turn, and skips whitespace-only hunks', () => {
  const patch = [
    'diff --git a/src/app.js b/src/app.js',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -8,6 +8,6 @@ function x() {',
    ' a',
    ' b',
    ' c',
    '-  return fetch(u);',
    '+  return fetch(u).catch(report);',
    ' d',
    ' e',
    '@@ -40,3 +40,4 @@',
    ' x',
    '+   ',
    ' y',
    ' z',
    'diff --git a/new.js b/new.js',
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
  ].join('\n');
  assert.deepEqual(m.editsOf(patch), [['src/app.js', 11, 11], ['new.js', 1, 1]]);
});

test('normalize survives junk; the view says what the next tier needs', () => {
  assert.equal(m.normalize('x').points, 0);
  assert.equal(m.normalize({ points: -3, tier: 99 }).tier, 5);
  const v = m.masteryView({ points: 12, caught: 1, quiz: { streak: 1, best: 2 } }, T0);
  assert.equal(v.tier, 1);
  assert.equal(v.tierName, 'Tide-pool Reader');
  assert.equal(v.next.name, 'Diff Diver');
  assert.deepEqual(v.next.need, { points: 18, caught: 0, quizBest: 1 });
  assert.equal(v.tiers.length, 5);
  assert.equal(v.flair, null);
  assert.equal(m.masteryView({ points: 150, caught: 15, quiz: { best: 5 } }).flair, 'Guardian');
});
