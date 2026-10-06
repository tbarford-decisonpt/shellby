const { test } = require('node:test');
const assert = require('node:assert/strict');
const quests = require('../src/main/quests');
const { AWARDS } = require('../src/main/xp');

const ids = quests.QUESTS.map(q => q.id);
const doneAll = (order = ids) => order.reduce((s, id, i) => quests.completeQuest(s, id, 1000 + i).state, null);

test('the line is the four buried features, in the order that leads one into the next', () => {
  assert.deepEqual(ids, ['comment', 'branch', 'home', 'reset']);
  assert.deepEqual(quests.QUESTS.map(q => q.title), ['Comment on a diff line', 'Try it another way', 'Bring a copy home', 'Queue a routine for the reset']);
  for (const q of quests.QUESTS) assert.ok(q.icon && q.why && q.how && q.go, `${q.id} says why, how and where`);
});

test('someone new has every quest ahead and the first one suggested', () => {
  const v = quests.questsView(null);
  assert.equal(v.current, 'comment');
  assert.equal(v.doneCount, 0);
  assert.equal(v.total, 4);
  assert.equal(v.complete, false);
  assert.equal(v.hidden, false);
  assert.ok(v.list.every(q => !q.done && q.at === null));
});

test('finishing a quest reports it once, with the next one to suggest', () => {
  const r = quests.completeQuest(null, 'comment', 5000);
  assert.equal(r.quest.id, 'comment');
  assert.equal(r.next.id, 'branch');
  assert.equal(r.finished, false);
  assert.equal(r.state.done.comment, 5000);
  const again = quests.completeQuest(r.state, 'comment', 9000);
  assert.equal(again.quest, null, 'only the first time counts');
  assert.equal(again.state.done.comment, 5000);
});

test('quests can be done in any order: the next one suggested is the first still open', () => {
  const s = quests.completeQuest(null, 'home', 1).state;
  const r = quests.completeQuest(s, 'comment', 2);
  assert.equal(r.next.id, 'branch');
  assert.equal(quests.questsView(r.state).current, 'branch');
  assert.equal(quests.questsView(r.state).doneCount, 2);
});

test('the last quest finishes the line, whichever one it is', () => {
  const s = doneAll(['reset', 'home', 'branch']);
  const r = quests.completeQuest(s, 'comment', 7);
  assert.equal(r.finished, true);
  assert.equal(r.next, null);
  const v = quests.questsView(r.state);
  assert.equal(v.complete, true);
  assert.equal(v.current, null);
  assert.equal(v.doneCount, 4);
});

test('something that is not a quest changes nothing', () => {
  const r = quests.completeQuest(null, 'nope', 1);
  assert.equal(r.quest, null);
  assert.deepEqual(r.state, { done: {}, hidden: false });
});

test('a stored value is made safe: unknown quests and bad stamps dropped', () => {
  const s = quests.normalizeQuests({ done: { comment: 12.7, branch: 'x', ghost: 5, home: -1 }, hidden: 'yes' });
  assert.deepEqual(s, { done: { comment: 12 }, hidden: true });
  assert.deepEqual(quests.normalizeQuests('junk'), { done: {}, hidden: false });
  assert.deepEqual(quests.normalizeQuests({ done: [] }), { done: {}, hidden: false });
});

test('hiding the card keeps progress, and it can come back', () => {
  const s = quests.setHidden(quests.completeQuest(null, 'branch', 3).state, true);
  assert.equal(quests.questsView(s).hidden, true);
  assert.equal(quests.questsView(s).doneCount, 1);
  assert.equal(quests.questsView(quests.setHidden(s, false)).hidden, false);
});

test('completing never mutates the value it was given', () => {
  const s = Object.freeze({ done: Object.freeze({}), hidden: false });
  assert.doesNotThrow(() => quests.completeQuest(s, 'reset', 1));
  assert.deepEqual(s.done, {});
});

test('each quest pays XP, and the whole line pays a bonus, for Claude Code work only', () => {
  assert.ok(AWARDS.quest.xp > 0 && AWARDS.quest.claude);
  assert.ok(AWARDS.questline.xp > AWARDS.quest.xp && AWARDS.questline.claude);
});
