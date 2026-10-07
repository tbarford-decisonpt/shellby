const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/main/tank-layouts');
const tankShare = require('../src/main/tank-share');
const sync = require('../src/main/github/sync');

const tankWith = (...refs) => ({ size: 'nano', style: { substrate: null, backdrop: null, light: 'clock' }, placed: refs.map((ref, i) => ({ uid: i + 1, ref, x: 10 * i, row: 1, z: 0, flip: false })) });

test('normalize keeps safe layouts and drops junk, never throws', () => {
  for (const junk of [null, 3, 'x', [], { list: 'no' }, { list: [null, 5, {}, { name: '' }] }]) {
    assert.deepEqual(L.normalize(junk), { list: [], seasonal: null, editedAt: 0 });
  }
  const s = L.normalize({ list: [
    { id: 'BAD ID', name: `  Every${String.fromCharCode(0)}day${String.fromCharCode(0x202e)}  `, season: 'halloween', ...tankWith('castle-keep'), savedAt: 5 },
    { name: 'everyday', ...tankWith('rock-round') },          // the same name again: dropped
    { id: 'a', name: 'Spooky', season: 'not-a-season', placed: [{ ref: '<script>' }, { ref: 'kelp', x: 1e9 }] },
    { name: 'Reef' }, { name: 'Fourth' },
  ], editedAt: -1 });
  assert.equal(s.list.length, L.MAX);
  assert.equal(s.list[0].name, 'Everyday');
  assert.match(s.list[0].id, /^[a-z0-9]{1,12}$/);
  assert.equal(s.list[0].season, 'halloween');
  assert.equal(s.list[1].season, null);
  assert.deepEqual(s.list[1].placed.map(p => p.ref), ['kelp']);
  assert.ok(s.list[1].placed[0].x <= 240);
  assert.equal(s.editedAt, 0);
});

test('names are cleaned and capped', () => {
  assert.equal(L.cleanName('  a\n\tb  '), 'a b');
  assert.equal(L.cleanName('x'.repeat(50)).length, L.NAME_MAX);
  assert.equal(L.cleanName(7), '');
});

test('save keeps the tank under a name, replaces the same name and refuses a fourth', () => {
  let s = L.normalize(null);
  for (const name of ['Everyday', 'Spooky', 'Reef']) {
    const r = L.save(s, { name, tank: tankWith('castle-keep'), now: 10 });
    assert.ok(r.ok);
    s = r.state;
  }
  const again = L.save(s, { name: 'spooky', season: 'halloween', tank: tankWith('rock-round', 'kelp'), now: 20 });
  assert.ok(again.ok);
  assert.equal(again.state.list.length, 3);
  const spooky = again.state.list.find(l => l.name === 'spooky');
  assert.equal(spooky.placed.length, 2);
  assert.equal(spooky.season, 'halloween');
  assert.equal(again.state.editedAt, 20);
  const full = L.save(again.state, { name: 'Another', tank: tankWith() });
  assert.equal(full.ok, false);
  assert.match(full.error, /3 layouts/);
  assert.equal(L.save(s, { name: '   ', tank: tankWith() }).ok, false);
  assert.notEqual(again.state, s, 'a new object, not the old one changed');
});

test('tagging a season takes it from any other layout', () => {
  let s = L.save(null, { name: 'A', season: 'winter', tank: tankWith(), now: 1 }).state;
  s = L.save(s, { name: 'B', tank: tankWith(), now: 2 }).state;
  const b = s.list.find(l => l.name === 'B').id;
  s = L.tag(s, b, 'winter', 3);
  assert.deepEqual(s.list.map(l => l.season), [null, 'winter']);
  assert.equal(L.tag(s, b, 'nope', 4).list[1].season, null);
});

test('a season puts its layout up, keeps the tank from before, and puts it back when it ends', () => {
  let s = L.save(null, { name: 'Spooky', season: 'halloween', tank: tankWith('carved-pumpkin'), now: 1 }).state;
  const everyday = tankWith('castle-keep', 'kelp');
  const up = L.seasonStep(s, { tank: everyday, active: ['halloween', 'autumn'] });
  assert.deepEqual(up.put.placed.map(p => p.ref), ['carved-pumpkin']);
  assert.equal(up.state.seasonal.season, 'halloween');
  s = up.state;
  // Still Halloween, and you've redecorated: nothing happens.
  assert.equal(L.seasonStep(s, { tank: tankWith('rock-round'), active: ['halloween'] }).put, null);
  const down = L.seasonStep(s, { tank: tankWith('carved-pumpkin'), active: ['autumn'] });
  assert.deepEqual(down.put.placed.map(p => p.ref), ['castle-keep', 'kelp']);
  assert.equal(down.state.seasonal, null);
  assert.equal(L.seasonStep(down.state, { tank: everyday, active: [] }).put, null);
});

test('removing the season’s layout leaves the tank as it is', () => {
  let s = L.save(null, { name: 'Spooky', season: 'halloween', tank: tankWith(), now: 1 }).state;
  s = L.seasonStep(s, { tank: tankWith('kelp'), active: ['halloween'] }).state;
  s = L.remove(s, s.list[0].id, 5);
  assert.deepEqual(s, { list: [], seasonal: null, editedAt: 5 });
  assert.equal(L.seasonStep(s, { tank: tankWith(), active: [] }).put, null);
});

test('sync: the newer list wins whole, and this PC keeps what its season put up', () => {
  const a = L.save(null, { name: 'Old', tank: tankWith(), now: 1 }).state;
  const b = L.save(null, { name: 'New', tank: tankWith('kelp'), now: 9 }).state;
  assert.equal(L.merge(a, b).list[0].name, 'New');
  assert.equal(L.merge(b, a).list[0].name, 'New');
  assert.equal(L.syncable({ ...b, seasonal: { id: 'l1', season: 'winter', before: tankWith() } }).seasonal, undefined);
  const local = L.seasonStep(L.save(null, { name: 'New', season: 'winter', tank: tankWith(), now: 2 }).state, { tank: tankWith('kelp'), active: ['winter'] }).state;
  const applied = L.applySync(local, L.syncable(b));
  assert.equal(applied.list[0].name, 'New');
  assert.equal(applied.seasonal?.season, 'winter');
});

test('layouts round-trip through the sync gist', () => {
  const layouts = L.save(null, { name: 'Reef', season: 'summer', tank: tankWith('coral-fan'), now: 42 }).state;
  const settings = { tankLayouts: layouts, tank: tankWith('kelp') };
  const merged = sync.merge(sync.clean({}), { tankLayouts: L.syncable(layouts) });
  assert.equal(merged.tankLayouts.list[0].name, 'Reef');
  const patch = sync.patchFor(merged, k => (k === 'tankLayouts' ? null : settings[k] ?? null));
  assert.equal(patch.tankLayouts.list[0].placed[0].ref, 'coral-fan');
  // Already up to date: no patch for them.
  assert.equal(sync.patchFor(merged, k => settings[k] ?? null).tankLayouts, undefined);
});

test('layouts never reach the calling card', () => {
  const card = tankShare.forCard({ ...tankWith('kelp'), shareCard: true, tankLayouts: { list: [{ name: 'Secret plans', ...tankWith('rock-round') }] }, layouts: { x: 1 } });
  assert.doesNotMatch(JSON.stringify(card), /Secret|layouts|rock-round/);
});

test('the panel view names them without any art', () => {
  const s = L.save(null, { name: 'Everyday', tank: tankWith('kelp', 'castle-keep'), now: 1 }).state;
  const v = L.view(s);
  assert.equal(v.max, 3);
  assert.deepEqual(v.list.map(l => [l.name, l.pieces, l.up]), [['Everyday', 2, false]]);
  assert.ok(v.seasons.some(x => x.id === 'halloween'));
});
