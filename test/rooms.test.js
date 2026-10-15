const { test } = require('node:test');
const assert = require('node:assert/strict');
const rooms = require('../src/main/rooms');

const newcomer = () => rooms.initialRooms(false);
// The core loop done (first-run.js), so tasks alone decide: the order tests.
const fresh = () => rooms.reachCore(newcomer()).state;
const after = (n, start = fresh()) => { let s = start; for (let i = 0; i < n; i++) s = rooms.taskDone(s).state; return s; };

test('someone new starts with no rooms open beyond Shellby, Chat and the Logbook', () => {
  assert.deepEqual(rooms.openRooms(fresh()), ['logbook'], 'the Logbook says what to do next, so it is open from the start');
  assert.deepEqual(rooms.roomsView(fresh()).next, { id: 'history', name: 'History', tasksToGo: 1 });
});

test('someone who was here before rooms keeps every door open', () => {
  const s = rooms.initialRooms(true);
  assert.deepEqual(rooms.openRooms(s), rooms.ROOMS.map(r => r.id));
  assert.equal(rooms.roomsView(s).all, true);
  assert.equal(rooms.roomsView(s).next, null);
});

test('an undecided value (null) shows everything rather than hiding screens', () => {
  assert.deepEqual(rooms.openRooms(null), rooms.ROOMS.map(r => r.id));
  assert.deepEqual(rooms.taskDone(null), { state: null, opened: [] });
});

test('finished tasks open rooms in order and report each one once', () => {
  let s = fresh();
  const opened = [];
  for (let i = 0; i < 7; i++) {
    const r = rooms.taskDone(s);
    s = r.state;
    opened.push(r.opened.map(x => x.id));
  }
  assert.deepEqual(opened, [['history', 'projects', 'notes', 'trophies'], ['finds', 'stickers'], ['health', 'toolbox', 'crew', 'reef'], ['bugdex', 'council', 'mastery'], ['workflows', 'us'], ['tank'], []]);
  assert.equal(rooms.roomsView(s).all, true);
});

test('a room opened by hand stays open and is not announced again later', () => {
  const s = rooms.openRoom(fresh(), 'workflows');
  assert.deepEqual(rooms.openRooms(s), ['logbook', 'workflows']);
  let t = s;
  const opened = [];
  for (let i = 0; i < 8; i++) { const r = rooms.taskDone(t); t = r.state; opened.push(...r.opened.map(x => x.id)); }
  assert.ok(!opened.includes('workflows'));
});

test('openRoom ignores unknown ids and rooms already open', () => {
  const s = after(1);
  assert.deepEqual(rooms.openRoom(s, 'history'), s);
  assert.deepEqual(rooms.openRoom(s, 'chat'), s);
  assert.deepEqual(rooms.openRoom(s, '__proto__'), s);
});

test('openAll opens everything and stops counting toward rooms', () => {
  const s = rooms.openAll(after(2));
  assert.equal(rooms.roomsView(s).all, true);
  assert.deepEqual(rooms.taskDone(s).opened, []);
});

test('the next room counts down the tasks still to go', () => {
  assert.deepEqual(rooms.roomsView(after(1)).next, { id: 'finds', name: 'Finds', tasksToGo: 1, in: 'wardrobe' });
  assert.deepEqual(rooms.roomsView(after(4)).next, { id: 'workflows', name: 'Automate', tasksToGo: 1 });
  assert.deepEqual(rooms.roomsView(after(5)).next, { id: 'tank', name: 'Tank', tasksToGo: 1, in: 'wardrobe' });
  assert.equal(rooms.roomsView(after(6)).next, null);
});

test('the beach is part of Us, not a room of its own', () => {
  assert.ok(!rooms.ROOMS.some(r => r.id === 'beach'));
  assert.deepEqual(rooms.normalizeRooms({ tasks: 3, open: ['beach', 'us'], core: true }).open, ['us'],'a stored Beach door is dropped');
});

test('rooms open in the order they are listed, so "next" is always the soonest', () => {
  const tasks = rooms.ROOMS.map(r => r.tasks);
  assert.deepEqual(tasks, [...tasks].sort((a, b) => a - b));
});

test('a corrupt stored value is cleaned up, not trusted', () => {
  const s = rooms.normalizeRooms({ tasks: -4.7, open: ['toolbox', 'nope', 'toolbox', 7], all: 'yes', core: 1, fresh: ['tank', 'tank', 'x'] });
  assert.deepEqual(s, { tasks: 0, open: ['toolbox'], all: true, core: true, fresh: ['tank'] });
  assert.equal(rooms.normalizeRooms('garbage'), null);
});

// ---- the core loop (first-run.js): the game's deeper rooms wait for it

const GAME = rooms.ROOMS.filter(r => r.game).map(r => r.id);

test('someone new opens only the working rooms however many tasks go by, until the core loop', () => {
  const s = after(10, newcomer());
  const open = rooms.openRooms(s);
  assert.ok(GAME.every(id => !open.includes(id)), `no game room yet (${open})`);
  assert.deepEqual(open, ['logbook', 'history', 'projects', 'notes', 'trophies', 'health', 'toolbox', 'workflows']);
  assert.deepEqual(rooms.roomsView(s).next, { id: 'finds', name: 'Finds', core: true, in: 'wardrobe' }, 'next says the game waits on the core loop');
});

test('the core loop opens every game room tasks have already earned, once, each marked new', () => {
  const s = after(4, newcomer());
  const r = rooms.reachCore(s);
  assert.deepEqual(r.opened.map(x => x.id), ['finds', 'stickers', 'crew', 'reef', 'bugdex', 'council', 'mastery']);
  assert.deepEqual(rooms.roomsView(r.state).fresh, ['history', 'projects', 'notes', 'trophies', 'health', 'toolbox', 'finds', 'stickers', 'crew', 'reef', 'bugdex', 'council', 'mastery']);
  assert.deepEqual(rooms.reachCore(r.state).opened, [], 'reached is reached: not announced twice');
  assert.equal(rooms.reachCore(r.state).state.core, true);
});

test('the core loop before any task opens nothing yet; tasks open the game rooms after', () => {
  const r = rooms.reachCore(newcomer());
  assert.deepEqual(r.opened, []);
  assert.deepEqual(rooms.taskDone(after(1, r.state)).opened.map(x => x.id), ['finds', 'stickers']);
});

test('a game room opened by hand (Ctrl+K) stays open before the core loop', () => {
  const s = rooms.openRoom(after(1, newcomer()), 'tank');
  assert.ok(rooms.openRooms(s).includes('tank'));
});

test('a visit takes a room off the new list, and only that room', () => {
  const s = after(1, newcomer());
  assert.deepEqual(rooms.roomsView(s).fresh, ['history', 'projects', 'notes', 'trophies']);
  const seen = rooms.seeRoom(s, 'history');
  assert.deepEqual(rooms.roomsView(seen).fresh, ['projects', 'notes', 'trophies']);
  assert.deepEqual(rooms.seeRoom(seen, 'history'), seen, 'seeing it again changes nothing');
});

test('locked lists every shut room, doors and cards alike', () => {
  const v = rooms.roomsView(after(3, newcomer()));
  assert.ok(v.locked.includes('reef') && v.locked.includes('mastery'));
  assert.equal(v.core, false);
  assert.deepEqual([...v.open, ...v.locked].sort(), rooms.ROOMS.map(r => r.id).sort());
});

test('Show every screen opens the game rooms too, with nothing marked new', () => {
  const v = rooms.roomsView(rooms.openAll(after(1, newcomer())));
  assert.equal(v.all, true);
  assert.deepEqual(v.locked, []);
  assert.deepEqual(v.fresh, []);
});

// ---- existing users: nothing they had changes

test('a rooms value saved before the core loop existed keeps opening game rooms by tasks alone', () => {
  const old = { tasks: 2, open: [], all: false }; // as 0.85 saved it
  assert.equal(rooms.normalizeRooms(old).core, true);
  assert.ok(rooms.openRooms(old).includes('finds') && rooms.openRooms(old).includes('stickers'));
  assert.deepEqual(rooms.taskDone(old).opened.map(x => x.id), ['health', 'toolbox', 'crew']);
});

test('the Reef and Review mastery cards they could already see stay open for them', () => {
  const old = { tasks: 1, open: ['toolbox'], all: false };
  const open = rooms.openRooms(old);
  assert.ok(open.includes('reef') && open.includes('mastery'), `${open}`);
  assert.ok(!rooms.roomsView(old).locked.includes('reef'));
  assert.deepEqual(rooms.roomsView(old).fresh, [], 'and nothing is announced as new');
});

test('someone who was here before rooms still has every door, cards included', () => {
  const v = rooms.roomsView(rooms.initialRooms(true));
  assert.equal(v.all, true);
  assert.deepEqual(v.locked, []);
  assert.equal(v.next, null);
});

test('every room that names a quest chapter names a real one', () => {
  const { CHAPTERS } = require('../src/main/quests/chapters');
  const ids = new Set(CHAPTERS.map(c => c.id));
  for (const r of rooms.ROOMS.filter(x => x.chapter)) assert.ok(ids.has(r.chapter), `${r.id} → ${r.chapter}`);
});
