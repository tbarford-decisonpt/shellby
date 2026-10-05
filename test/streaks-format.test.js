// The streak card's and badge's words (src/renderer/shared/streaks-format.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/renderer/shared/streaks-format');

test('quiet says how long since a commit, or that there has been none', () => {
  assert.equal(W.quiet({ quietDays: null }), 'no commits yet');
  assert.equal(W.quiet({}), 'no commits yet');
  assert.equal(W.quiet({ quietDays: 0 }), 'committed today');
  assert.equal(W.quiet({ quietDays: 1 }), '1 day since a commit');
  assert.equal(W.quiet({ quietDays: 4 }), '4 days since a commit');
});

test('isLate once quiet for the nudge delay or longer, never for a project with no commits', () => {
  assert.equal(W.isLate({ quietDays: 3 }, 3), true);
  assert.equal(W.isLate({ quietDays: 5 }, 3), true);
  assert.equal(W.isLate({ quietDays: 2 }, 3), false);
  assert.equal(W.isLate({ quietDays: null }, 0), false);
});

test('card for a running streak kept today', () => {
  assert.deepEqual(W.card({ current: 4, longest: 9, today: true }), {
    on: true, title: '4-day streak', best: 'best 9d', sub: "You've kept it going today.",
  });
});

test('card for a running streak not yet kept today asks for a task', () => {
  assert.equal(W.card({ current: 2, longest: 2, today: false }).sub, 'Finish a task today to keep it going.');
});

test('card with no streak and no best', () => {
  assert.deepEqual(W.card({ current: 0, longest: 0 }), {
    on: false, title: 'No streak yet', best: '', sub: 'Finish a Claude task on consecutive days to build one.',
  });
});

test('badge hides with no streak and names the best when there is one', () => {
  assert.equal(W.badge({ current: 0, longest: 3 }).hidden, true);
  const b = W.badge({ current: 5, longest: 7 });
  assert.equal(b.hidden, false);
  assert.equal(b.text, '🔥 5');
  assert.equal(b.title, '5-day streak, best 7. See your projects on Time');
  assert.equal(b.label, '5-day streak. Open it on Time');
  assert.equal(W.badge({ current: 2, longest: 0 }).title, '2-day streak. See your projects on Time');
});
