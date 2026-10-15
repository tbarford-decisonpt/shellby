const { test } = require('node:test');
const assert = require('node:assert/strict');
const quests = require('../src/main/quests');
const { AWARDS } = require('../src/main/progression/xp');

const ids = quests.CHAPTERS[0].quests.map(q => q.id);
const doneAll = (order = ids) => order.reduce((s, id, i) => quests.completeQuest(s, id, 1000 + i).state, null);

test('the line is the four buried features, in the order that leads one into the next', () => {
  assert.deepEqual(ids, ['comment', 'branch', 'home', 'reset']);
  assert.deepEqual(quests.QUESTS.slice(0, 4).map(q => q.id), ids, 'Chapter 1 leads the flat list');
  assert.deepEqual(quests.CHAPTERS[0].quests.map(q => q.title), ['Comment on a diff line', 'Try it another way', 'Bring a copy home', 'Queue a routine for the reset']);
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
  assert.deepEqual(r.state, { done: {}, hidden: false, chapters: {}, seenChapter: null });
});

test('a stored value is made safe: unknown quests and bad stamps dropped', () => {
  const s = quests.normalizeQuests({ done: { comment: 12.7, branch: 'x', ghost: 5, home: -1 }, hidden: 'yes' });
  assert.deepEqual(s, { done: { comment: 12 }, hidden: true, chapters: {}, seenChapter: null });
  assert.deepEqual(quests.normalizeQuests('junk'), { done: {}, hidden: false, chapters: {}, seenChapter: null });
  assert.deepEqual(quests.normalizeQuests({ done: [] }), { done: {}, hidden: false, chapters: {}, seenChapter: null });
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

// ------------------------------------------------------------------ chapters

const ctx = (everLevel = 1, dormant = [], eventActive = false) => ({ everLevel, dormant: new Set(dormant), eventActive });
const chapter = id => quests.chapterById(id);
const finishChapter = (s, id, c = ctx(99)) => chapter(id).quests.reduce((st, q, i) => quests.completeQuest(st, q.id, 100 + i, c).state, s);

test('chapters are numbered in order, each quest id unique, each teaching how it feeds the next', () => {
  assert.deepEqual(quests.CHAPTERS.map(c => c.n), quests.CHAPTERS.map((_, i) => i + 1));
  assert.equal(quests.CHAPTERS.length, 11);
  const all = quests.QUESTS.map(q => q.id);
  assert.equal(new Set(all).size, all.length, 'no quest id twice');
  for (const c of quests.CHAPTERS) {
    assert.ok(c.title && c.icon && c.blurb && c.teaches, `${c.id} says what it teaches`);
    for (const q of c.quests) assert.ok(q.why && q.how && q.go && q.links.length, `${q.id} says why, how, where and what it feeds`);
  }
  const levels = quests.CHAPTERS.map(c => c.unlock.level).filter(Boolean);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'later chapters open at higher levels');
});

test('an old saved line (just Chapter 1 ids) loads as Chapter 1 progress', () => {
  const old = { done: { comment: 5, branch: 6 }, hidden: true };
  const v = quests.questsView(old);
  assert.equal(v.chapter.id, 'first-tide');
  assert.equal(v.doneCount, 2);
  assert.equal(v.current, 'home');
  assert.equal(v.hidden, true);
  assert.equal(v.chapters.filter(c => c.unlocked).length, 1);
});

test('chapters open by the highest level ever reached', () => {
  const v = quests.questsView(null, ctx(10));
  assert.deepEqual(v.chapters.filter(c => c.unlocked).map(c => c.id), ['first-tide', 'reef-wakes', 'bug-hunter', 'clockwork']);
  const r = quests.unlockChapters(null, ctx(10), 777);
  assert.deepEqual(r.opened.map(c => c.id), ['reef-wakes', 'bug-hunter', 'clockwork']);
  assert.equal(r.state.chapters['reef-wakes'].unlockedAt, 777);
  assert.deepEqual(quests.unlockChapters(r.state, ctx(10), 900).opened, [], 'each opens once');
  assert.equal(quests.questsView(r.state, ctx(1)).chapters[1].unlocked, true, 'an opened chapter stays open');
});

test('a never-opened screen opens its chapter early, one tutorial at a time, after the open ones are done', () => {
  const dormant = ['projects', 'bugdex', 'routines', 'council', 'tank'];
  assert.deepEqual(quests.unlockChapters(null, ctx(1, dormant), 1).opened, [], 'not while Chapter 1 is in progress');
  const s = finishChapter(null, 'first-tide', ctx(1, dormant));
  const r = quests.unlockChapters(s, ctx(1, dormant), 2);
  assert.deepEqual(r.opened.map(c => c.id), ['reef-wakes'], 'only the first tutorial');
  assert.deepEqual(quests.unlockChapters(r.state, ctx(1, dormant), 3).opened, [], 'the next waits for this one');
  const s2 = finishChapter(r.state, 'reef-wakes', ctx(1, dormant));
  assert.deepEqual(quests.unlockChapters(s2, ctx(1, dormant), 4).opened.map(c => c.id), ['bug-hunter']);
});

test('a tide event opens Tides and Friends early', () => {
  const v = quests.questsView(null, ctx(1, [], true));
  assert.equal(v.chapters.find(c => c.id === 'tides-and-friends').unlocked, true);
});

test('a quest in a locked chapter cannot complete', () => {
  const r = quests.completeQuest(null, 'routine', 5, ctx(1));
  assert.equal(r.quest, null);
  assert.deepEqual(r.state.done, {});
  const ok = quests.completeQuest(null, 'routine', 5, ctx(10));
  assert.equal(ok.quest.id, 'routine');
  assert.equal(ok.chapter.id, 'clockwork');
});

test('the last quest of a chapter finishes it, with a stamp, and suggests the next open one', () => {
  const c = ctx(10);
  let s = quests.completeQuest(null, 'routine', 1, c).state;
  s = quests.completeQuest(s, 'workflow', 2, c).state;
  const r = quests.completeQuest(s, 'away', 3, c);
  assert.equal(r.chapterDone, true);
  assert.equal(r.state.chapters.clockwork.doneAt, 3);
  assert.equal(r.next.chapter, 'first-tide', 'the first open quest elsewhere');
  assert.equal(r.finished, false);
  assert.equal(quests.questsView(r.state, c).chaptersDone, 1);
});

test('the view keeps the chat card shape for the chapter in progress, and says how locked chapters open', () => {
  const s = finishChapter(null, 'first-tide', ctx(5));
  const v = quests.questsView(s, ctx(5), { projects: 'Projects' });
  assert.equal(v.chapter.id, 'reef-wakes');
  assert.equal(v.total, 3);
  assert.equal(v.current, 'checkup');
  assert.equal(v.complete, false);
  assert.equal(v.chapter.isNew, true);
  assert.equal(quests.questsView(quests.markSeen(s, 'reef-wakes'), ctx(5)).chapter.isNew, false);
  const bug = v.chapters.find(c => c.id === 'bug-hunter');
  assert.equal(bug.unlocked, false);
  assert.match(bug.unlockText, /level 8/);
  assert.equal(v.nextLocked.id, 'bug-hunter');
});

test('molting season finishes either way: molt or stay', () => {
  const ch = chapter('molting-season');
  assert.ok(ch.quests.some(q => q.id === 'molt-or-stay'));
  assert.equal(ch.unlock.level, 90);
});

test('stored chapters are made safe', () => {
  const s = quests.normalizeQuests({ chapters: { clockwork: { unlockedAt: 9.5 }, ghost: { unlockedAt: 1 }, keeper: { unlockedAt: 'x' } }, seenChapter: 'nope' });
  assert.deepEqual(s.chapters, { clockwork: { unlockedAt: 9, doneAt: null } });
  assert.equal(s.seenChapter, null);
});

test('chapter quest ids survive the normalize sync-life merges done ids through', () => {
  const s = quests.completeQuest(null, 'routine', 50, ctx(10)).state;
  assert.deepEqual(quests.normalizeQuests({ done: s.done }).done, { routine: 50 });
});

test('the chapter award pays more than a quest', () => {
  assert.ok(AWARDS.chapter.xp > AWARDS.quest.xp && AWARDS.chapter.claude);
});

test('every quest read off a stat or an award is a real quest', () => {
  const { STAT_QUESTS, AWARD_QUESTS } = require('../src/main/wiring/quest-line');
  const known = new Set(quests.QUESTS.map(q => q.id));
  const payloads = [{}, { n: 999 }, { event: true }];
  for (const q of Object.values(STAT_QUESTS)) {
    for (const id of typeof q === 'function' ? payloads.map(q).filter(Boolean) : [q]) assert.ok(known.has(id), id);
  }
  for (const [kind, id] of Object.entries(AWARD_QUESTS)) {
    assert.ok(known.has(id), id);
    assert.ok(AWARDS[kind], `${kind} is an award`);
  }
});
