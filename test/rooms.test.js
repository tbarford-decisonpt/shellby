const { test } = require('node:test');
const assert = require('node:assert/strict');
const rooms = require('../src/main/rooms');

const fresh = () => rooms.initialRooms(false);
const after = n => { let s = fresh(); for (let i = 0; i < n; i++) s = rooms.taskDone(s).state; return s; };

test('someone new starts with no rooms open beyond Shellby and Chat', () => {
  assert.deepEqual(rooms.openRooms(fresh()), []);
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
  for (let i = 0; i < 6; i++) {
    const r = rooms.taskDone(s);
    s = r.state;
    opened.push(r.opened.map(x => x.id));
  }
  assert.deepEqual(opened, [['history', 'projects'], [], ['health', 'toolbox'], [], ['workflows'], []]);
  assert.equal(rooms.roomsView(s).all, true);
});

test('a room opened by hand stays open and is not announced again later', () => {
  const s = rooms.openRoom(fresh(), 'workflows');
  assert.deepEqual(rooms.openRooms(s), ['workflows']);
  let t = s;
  const opened = [];
  for (let i = 0; i < 5; i++) { const r = rooms.taskDone(t); t = r.state; opened.push(...r.opened.map(x => x.id)); }
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
  assert.deepEqual(rooms.roomsView(after(1)).next, { id: 'health', name: 'Health', tasksToGo: 2 });
  assert.deepEqual(rooms.roomsView(after(4)).next, { id: 'workflows', name: 'Automate', tasksToGo: 1 });
});

test('a corrupt stored value is cleaned up, not trusted', () => {
  const s = rooms.normalizeRooms({ tasks: -4.7, open: ['toolbox', 'nope', 'toolbox', 7], all: 'yes' });
  assert.deepEqual(s, { tasks: 0, open: ['toolbox'], all: true });
  assert.equal(rooms.normalizeRooms('garbage'), null);
});
