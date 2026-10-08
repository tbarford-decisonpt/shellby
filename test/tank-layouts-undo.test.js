// Taking back a layout going up, a save over a name and a remove
// (src/main/ipc/tank-layouts.js tank:layout-undo, tank-layouts.js restore).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/main/tank-layouts');
const { registerTankLayoutsIpc } = require('../src/main/ipc/tank-layouts');

const tankWith = (...refs) => ({ size: 'nano', style: { substrate: null, backdrop: null, light: 'clock' }, placed: refs.map((ref, i) => ({ uid: i + 1, ref, x: 10 * i, row: 1, z: 0, flip: false })) });
const refs = t => t.placed.map(p => p.ref);

function rig(tank = tankWith('castle-keep')) {
  const store = { tank, tankLayouts: null };
  const config = { get: k => store[k], set: patch => Object.assign(store, patch) };
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  let clock = 1000;
  const keep = draft => { store.tank = { ...L.shapeOf(draft), editedAt: clock }; return { ok: true, dropped: [], view: { pieces: draft.placed } }; };
  registerTankLayoutsIpc(ipcMain, { config, tank: { keep, view: () => ({}) }, ready: () => true, where: () => ({}), now: () => ++clock });
  const call = (ch, arg) => handlers[ch](null, arg);
  return { store, call, keep };
}

test('restore puts a removed layout back where it was, and refuses a full list or a taken name', () => {
  let s = L.normalize(null);
  for (const name of ['A', 'B', 'C']) s = L.save(s, { name, tank: tankWith(), now: 1 }).state;
  const b = s.list[1];
  const gone = L.remove(s, b.id, 2);
  const back = L.restore(gone, b, { at: 1, now: 3 });
  assert.ok(back.ok);
  assert.deepEqual(back.state.list.map(l => l.name), ['A', 'B', 'C']);
  assert.equal(back.state.editedAt, 3, 'an undo is a change like any other, so it syncs');
  const taken = L.normalize({ ...gone, list: [...gone.list, { ...b, id: 'q9', name: 'b' }] });
  assert.equal(L.restore(taken, b, { at: 1 }).ok, false, 'the name is someone else’s now');
  const reused = L.save(gone, { name: 'X', tank: tankWith(), now: 4 }).state;
  assert.equal(reused.list.find(l => l.id === b.id)?.name, 'X');
  assert.equal(L.restore(reused, b).ok, false, 'its id went to another layout: that one stays');
  assert.equal(L.restore(s, { ...b, id: 'zz', name: 'D' }).ok, false, 'he keeps three');
});

test('restore swaps a replaced layout back in, and puts a season’s one back up', () => {
  let s = L.save(null, { name: 'Spooky', season: 'halloween', tank: tankWith('rock-round'), now: 1 }).state;
  const r = L.save(s, { name: 'spooky', tank: tankWith('kelp', 'kelp'), now: 2 });
  assert.equal(r.replaced.name, 'Spooky');
  assert.equal(L.save(s, { name: 'New', tank: tankWith(), now: 2 }).replaced, null);
  const back = L.restore(r.state, r.replaced, { now: 3 });
  assert.deepEqual(refs(back.state.list[0]), ['rock-round']);
  s = { ...back.state, seasonal: { id: s.list[0].id, season: 'halloween', before: tankWith('castle-keep') } };
  const removed = L.remove(s, s.list[0].id, 4);
  assert.equal(removed.seasonal, null);
  const again = L.restore(removed, s.list[0], { at: 0, seasonal: s.seasonal, now: 5 });
  assert.equal(again.state.seasonal.id, s.list[0].id, 'it’s still up for the season');
});

test('putting one up keeps the tank from before, and undo puts it back', () => {
  const { store, call } = rig(tankWith('castle-keep'));
  call('tank:layout-save', { name: 'Reef' });
  store.tank = tankWith('kelp');
  const id = store.tankLayouts.list[0].id;
  assert.ok(call('tank:layout-use', id).ok);
  assert.deepEqual(refs(store.tank), ['castle-keep']);
  const r = call('tank:layout-undo');
  assert.ok(r.ok);
  assert.equal(r.undid, 'use');
  assert.deepEqual(refs(store.tank), ['kelp']);
  assert.equal(call('tank:layout-undo').ok, false, 'one step, taken once');
});

test('undo won’t throw away decorating done since the layout went up', () => {
  const { store, call, keep } = rig(tankWith('castle-keep'));
  call('tank:layout-save', { name: 'Reef' });
  store.tank = tankWith('kelp');
  call('tank:layout-use', store.tankLayouts.list[0].id);
  keep(tankWith('castle-keep', 'rock-round'));
  const r = call('tank:layout-undo');
  assert.equal(r.ok, false);
  assert.match(r.error, /changed since/);
  assert.deepEqual(refs(store.tank), ['castle-keep', 'rock-round']);
});

test('removing one, or saving over its name, can be taken back', () => {
  const { store, call } = rig(tankWith('castle-keep'));
  call('tank:layout-save', { name: 'Everyday' });
  call('tank:layout-save', { name: 'Reef' });
  const id = store.tankLayouts.list[0].id;
  call('tank:layout-remove', id);
  assert.deepEqual(store.tankLayouts.list.map(l => l.name), ['Reef']);
  const r = call('tank:layout-undo');
  assert.ok(r.ok);
  assert.equal(r.name, 'Everyday');
  assert.deepEqual(store.tankLayouts.list.map(l => l.name), ['Everyday', 'Reef'], 'back where it was');

  store.tank = tankWith('kelp');
  const saved = call('tank:layout-save', { name: 'reef' });
  assert.equal(saved.replaced, true);
  assert.deepEqual(refs(store.tankLayouts.list[1]), ['kelp']);
  const before = store.tankLayouts.editedAt;
  const u = call('tank:layout-undo');
  assert.equal(u.undid, 'replace');
  assert.deepEqual(refs(store.tankLayouts.list[1]), ['castle-keep']);
  assert.equal(store.tankLayouts.list[1].name, 'Reef');
  assert.ok(store.tankLayouts.editedAt > before, 'the undo syncs as a newer change');
});

test('a layout list changed since (here or by sync) isn’t undone over', () => {
  const { store, call } = rig();
  call('tank:layout-save', { name: 'A' });
  call('tank:layout-remove', store.tankLayouts.list[0].id);
  store.tankLayouts = { ...store.tankLayouts, editedAt: store.tankLayouts.editedAt + 50 }; // another PC's change came in
  assert.equal(call('tank:layout-undo').ok, false);
  assert.equal(store.tankLayouts.list.length, 0);
  call('tank:layout-save', { name: 'B' });
  call('tank:layout-remove', store.tankLayouts.list[0].id);
  call('tank:layout-save', { name: 'C' }); // a new save moves the list on
  assert.equal(call('tank:layout-undo').ok, false);
});
