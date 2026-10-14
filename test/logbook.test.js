const { test } = require('node:test');
const assert = require('node:assert/strict');
const logbook = require('../src/main/logbook');
const quests = require('../src/main/quests');
const featureUse = require('../src/main/feature-use');
const fixtures = require('./fixtures/game-views.json');

const NOW = new Date(2026, 9, 5, 12).getTime();
const DAY = 86400000;

const xp = {
  level: 12, title: 'Tidewalker',
  unlock: { level: 15, kind: 'decor', name: 'Kelp Arch', xpToGo: 420 },
  streak: { days: 4, multiplier: 1.2 },
  bounties: { list: [{ id: 'a', text: 'Push code twice', xp: 40, goal: 2, count: 1, done: false }, { id: 'b', text: 'Pass tests', xp: 30, goal: 1, count: 1, done: true }], cleared: false, bonus: 50 },
};
const event = {
  active: {
    id: 'harvest', name: 'Harvest Moon', emoji: '🌾', twist: 'Every catch pays half again in XP.', startsAt: NOW - 3 * DAY, endsAt: NOW + 2 * DAY, left: '2 days left', lastDay: false,
    goals: [{ id: 'tasks', text: 'Finish 10 tasks', n: 4, goal: 10, done: false }, { id: 'mouse', text: 'Catch the Harvest Mouse', n: 0, goal: 1, done: false }],
    done: false, bug: { id: 'harvest-mouse', name: 'Harvest Mouse' },
  },
  next: null,
};
const battle = (over = {}) => ({ id: 'b1', species: 'null-crab', name: 'Null Crab', hp: 30, max: 60, over: false, project: 'shellby', ...over });
const full = (extra = {}) => ({
  xp, event, quests: quests.questsView(null), battles: [battle()], nests: fixtures.nests, reef: fixtures.reef, review: fixtures.review,
  unlocks: fixtures.unlocks, week: { headline: 'Shipped 3 times', xp: 300, days: [{ day: '2026-10-04', xp: 100 }, { day: '2026-10-05', xp: 200 }], counts: { awayRuns: 2 } },
  streak: { current: 4 }, molt: fixtures.molt, wrapped: fixtures.wrapped, activeProject: 'shellby', state: null, ...extra,
});
const ids = v => v.cards.map(c => c.id);
const byId = (v, id) => v.cards.find(c => c.id === id);

test('every part missing still renders a card for each system, each saying "not yet" where it has nothing', () => {
  const v = logbook.logbookView({}, NOW);
  for (const id of ['today', 'quest', 'loose', 'next-unlock', 'reef', 'review', 'week', 'streak']) {
    const c = byId(v, id);
    assert.ok(c, `${id} is there`);
    assert.equal(c.missing, true, `${id} says not yet`);
    assert.ok(c.text, `${id} has words`);
  }
  assert.ok(byId(v, 'tide'), 'no event is a quiet card, not a gap');
  assert.equal(byId(v, 'molt'), undefined, 'molt only at 99');
  assert.equal(byId(v, 'wrapped'), undefined, 'wrapped only when due');
  assert.doesNotThrow(() => logbook.logbookView(null, NOW));
  assert.doesNotThrow(() => logbook.logbookView({ xp: 'junk', reef: 7, review: [], battles: 'x', quests: {} }, NOW));
});

test('each other package missing on its own leaves the rest whole', () => {
  for (const name of ['nests', 'reef', 'review', 'unlocks', 'molt', 'wrapped', 'battles', 'event', 'week', 'streak']) {
    const v = logbook.logbookView(full({ [name]: null }), NOW);
    assert.ok(v.cards.length >= 9, `${name} null`);
    assert.equal(byId(v, 'today').missing, false);
  }
});

test('things that need action now come first: a bug loose here, then a tide ending, then bounties nearly done, then the quest', () => {
  const v = logbook.logbookView(full(), NOW);
  assert.deepEqual(ids(v).slice(0, 4), ['loose', 'tide', 'today', 'quest']);
  const elsewhere = logbook.logbookView(full({ activeProject: 'other' }), NOW);
  assert.equal(ids(elsewhere)[0], 'tide', 'a bug in another project waits behind a tide event');
  const calm = logbook.logbookView(full({ battles: [], event: null }), NOW);
  assert.equal(ids(calm)[0], 'today');
});

test('a tide event on its last day outranks one with days to go', () => {
  const last = { active: { ...event.active, lastDay: true, endsAt: NOW + 3600000 } };
  assert.ok(byId(logbook.logbookView(full({ event: last }), NOW), 'tide').urgency > byId(logbook.logbookView(full(), NOW), 'tide').urgency);
});

test('pinned cards go first, and folded ones say so', () => {
  let s = logbook.setPinned(null, 'week', true);
  s = logbook.setCollapsed(s, 'reef', true);
  const v = logbook.logbookView(full({ state: s }), NOW);
  assert.equal(ids(v)[0], 'week');
  assert.equal(byId(v, 'week').pinned, true);
  assert.equal(byId(v, 'reef').collapsed, true);
  assert.deepEqual(logbook.setPinned(s, 'nope', true), s, 'unknown cards change nothing');
  assert.deepEqual(logbook.setPinned(s, 'week', false).pinned, []);
});

test('feeds: a loose bug in a nest says catching it clears the nest and grows the coral', () => {
  const v = logbook.logbookView(full(), NOW);
  const f = byId(v, 'loose').feeds.map(x => x.text).join(' ');
  assert.match(f, /nest clears in 14 days/);
  assert.match(f, /coral in shellby grows/);
  assert.ok(byId(v, 'loose').rows[0].nest, 'the row is marked as nested');
});

test('feeds: the tide event names its bug and twist, and an event bug on the loose says so', () => {
  const v = logbook.logbookView(full({ battles: [battle({ species: 'harvest-mouse', name: 'Harvest Mouse' })] }), NOW);
  assert.match(byId(v, 'tide').feeds[0].text, /Harvest Mouse is this event’s bug: every catch pays half again/);
  assert.ok(byId(v, 'loose').feeds.some(x => x.to === 'us' && /Harvest Mouse/.test(x.text)));
});

test('feeds: a decor unlock goes in the tank; the reef names its worst signal; review says how far to the next tier', () => {
  const v = logbook.logbookView(full({ unlocks: null }), NOW);
  assert.deepEqual(byId(v, 'next-unlock').feeds[0], { to: 'tank', text: 'Goes in your tank.' });
  const reef = { projects: [{ project: 'shellby', stage: 4, signals: {} }, { project: 'site', stage: 1, signals: { flaky: 2, lint: 1 } }] };
  const r = byId(logbook.logbookView(full({ reef }), NOW), 'reef');
  assert.match(r.text, /Needs care: site/);
  assert.match(r.feeds[0].text, /site: Fixing a flaky test pays Fixed a flaky test/);
  assert.match(byId(v, 'review').feeds[0].text, /^18 more points, a quiz run 1 longer → Diff Diver → Diver's Goggles Stand/);
});

test('the quest card shows the chapter in progress and links each screen the quest feeds', () => {
  const s = ['comment', 'branch', 'home', 'reset'].reduce((st, id, i) => quests.completeQuest(st, id, i + 1).state, null);
  const q = quests.questsView(s, { everLevel: 5 });
  const c = byId(logbook.logbookView(full({ quests: q }), NOW), 'quest');
  assert.equal(c.title, 'Chapter 2: The Reef Wakes');
  assert.equal(c.go.view, 'projects');
  assert.ok(c.feeds.some(f => f.to === 'bugdex'));
  assert.deepEqual(c.progress, { n: 0, of: 3 });
});

test('molt shows at 99 and Wrapped when due', () => {
  const v = logbook.logbookView(full({ molt: { ...fixtures.molt, canMolt: true, level: 99 }, wrapped: { due: true, year: 2026 } }), NOW);
  assert.ok(byId(v, 'molt'));
  assert.equal(byId(v, 'wrapped').title, 'Your 2026, wrapped');
});

test('every card and feed points at a screen the panel knows', () => {
  const screens = new Set(featureUse.SCREENS.map(s => s.id));
  for (const v of [logbook.logbookView({}, NOW), logbook.logbookView(full({ molt: { canMolt: true }, wrapped: { due: true } }), NOW)]) {
    for (const c of v.cards) {
      assert.ok(logbook.KNOWN_VIEWS.includes(c.go.view), `${c.id} goes to ${c.go.view}`);
      assert.ok(screens.has(c.go.view), `${c.go.view} is a screen`);
      for (const f of c.feeds) assert.ok(screens.has(f.to), `${c.id} feeds ${f.to}`);
    }
    for (const l of v.links) assert.ok(screens.has(l.to) && logbook.CARD_IDS.includes(l.from));
  }
});

test('links gather every feed once, from the card it starts at', () => {
  const v = logbook.logbookView(full(), NOW);
  const keys = v.links.map(l => `${l.from}>${l.to}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(v.links.some(l => l.from === 'reef' && l.to === 'tank'));
});

test('a stored value is made safe, and opening stamps it', () => {
  assert.deepEqual(logbook.normalizeLogbook({ pinned: ['reef', 'reef', 'x', 3], collapsed: 'no', lastOpenAt: -1 }), { pinned: ['reef'], collapsed: [], lastOpenAt: null });
  assert.equal(logbook.opened(null, 1234.9).lastOpenAt, 1234);
  const frozen = Object.freeze({ pinned: Object.freeze([]), collapsed: Object.freeze([]) });
  assert.doesNotThrow(() => logbook.setPinned(frozen, 'reef', true));
});
