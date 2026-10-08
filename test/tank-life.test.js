const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/main/tank/life');
const T = require('../src/main/tank');
const gifts = require('../src/main/gifts');
const A = require('../src/main/wardrobe/achievements');
const voice = require('../src/main/voice');
const bond = require('../src/main/bond');

const deco = (key, extra = {}) => ({
  key, name: key, category: 'structure', layer: 'floor', palette: { a: '#ffffff' },
  pixels: ['aaaa', 'aaaa'], frames: [], fps: 0, spots: [], locked: null, isNew: false, ...extra,
});
const lib = T.library({
  decor: [
    deco('castle-keep', { name: 'Sandcastle Keep', spots: [{ kind: 'hide', at: [1, 1] }] }),
    deco('kelp', { name: 'Kelp', category: 'plant', layer: 'back' }),
    deco('java-fern', { name: 'Java Fern', category: 'plant' }),
  ],
  findState: { items: Object.fromEntries(gifts.SETS[0].members.map(id => [id, { n: 1 }])) },
  finds: gifts.FINDS,
});
const tankOf = (placed, size = 'nano') => T.normalize({ size, placed: placed.map((ref, i) => ({ uid: i + 1, ref, x: 0, row: 1 })) });

test('normalize turns junk into an empty life and never throws', () => {
  for (const junk of [null, 7, 'x', [], { uses: [], seen: 'no', biggest: -3, shown: [1, 'ok', '../x'] }]) {
    const s = L.normalize(junk);
    assert.deepEqual(s.uses, {});
    assert.equal(s.biggest, 0);
    assert.ok(s.shown.every(x => /^[a-z0-9-]+$/.test(x)));
  }
  assert.deepEqual(L.normalize({ uses: { 3: 2, x: 4, 5: -1, 6: 1.5 } }).uses, { 3: 2 });
});

test('addUses only counts pieces still in the tank and caps each', () => {
  const placed = [{ uid: 1 }, { uid: 2 }];
  const s = L.addUses({ uses: { 1: 2, 9: 5 } }, { 1: 3, 2: 1000, 7: 4 }, placed);
  assert.deepEqual(s.uses, { 1: 5, 2: 50 });
  const capped = L.addUses({ uses: { 1: L.MAX_USES } }, { 1: 5 }, placed);
  assert.equal(capped.uses[1], L.MAX_USES);
});

test('the favourite is the piece he uses most, once he has used it a few times', () => {
  const placed = [{ uid: 1 }, { uid: 2 }, { uid: 3 }];
  assert.equal(L.favourite({ uses: { 1: L.FAVOURITE_AFTER - 1 } }, placed), null);
  assert.equal(L.favourite({ uses: { 1: 4, 2: 9, 3: 9 } }, placed), 2, 'ties go to the older piece');
  assert.equal(L.favourite({ uses: { 4: 50 } }, placed), null, 'a piece put away is no favourite');
});

test('a set is on display only with every one of its finds in the tank', () => {
  const beach = gifts.SETS[0];
  const all = beach.members.map(id => ({ ref: `find:${id}` }));
  assert.deepEqual(L.setsOnDisplay(all, gifts.SETS), [beach.id]);
  assert.deepEqual(L.setsOnDisplay(all.slice(1), gifts.SETS), []);
});

test('afterSave notices new pieces, moving day and new sets, once each', () => {
  const before = tankOf(['castle-keep']);
  const finds = gifts.SETS[0].members.map(id => `find:${id}`);
  const after = tankOf(['castle-keep', 'kelp', 'java-fern', ...finds], 'thirty-gallon');
  const r = L.afterSave(null, { before, after, lib, sizes: T.SIZES, sets: gifts.SETS });
  assert.deepEqual(r.news.map(n => n.ref).slice(0, 2), ['kelp', 'java-fern']);
  assert.equal(r.movedTo.id, 'thirty-gallon');
  assert.deepEqual(r.newSets.map(s => s.id), [gifts.SETS[0].id]);
  assert.equal(r.shownCount, 1);
  assert.equal(r.plants, 2);
  // Saved again as it is: nothing new, no moving day, the set already counted.
  const again = L.afterSave(r.state, { before: after, after, lib, sizes: T.SIZES, sets: gifts.SETS });
  assert.equal(again.news.length, 0);
  assert.equal(again.movedTo, null);
  assert.equal(again.newSets.length, 0);
  assert.equal(again.shownCount, 1, 'a set shown stays counted');
  // Put away and back in later: not new again.
  const back = L.afterSave(again.state, { before: tankOf(['castle-keep']), after, lib, sizes: T.SIZES, sets: gifts.SETS });
  assert.equal(back.news.length, 0);
});

test('a tank he was already in before is no moving day; a smaller one never is', () => {
  const big = tankOf([], 'reef');
  assert.equal(L.afterSave(null, { before: big, after: big, lib, sizes: T.SIZES, sets: [] }).movedTo, null);
  const r = L.afterSave(null, { before: tankOf([]), after: tankOf([], 'ten-gallon'), lib, sizes: T.SIZES, sets: [] });
  assert.equal(r.movedTo.id, 'ten-gallon');
  assert.equal(L.afterSave(r.state, { before: tankOf([], 'ten-gallon'), after: tankOf([]), lib, sizes: T.SIZES, sets: [] }).movedTo, null);
});

test('his lines fit the bubble', () => {
  for (const e of [...lib.values(), { name: 'A Really Very Long Name For A Piece', category: 'treasure' }, null]) {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const line = L.reactionLine(e, () => r);
      assert.ok(line && line.length <= voice.MAX_LINE, line);
    }
  }
  for (const s of T.SIZES) assert.ok(L.movingLine(s).length <= voice.MAX_LINE);
  const pieces = [...lib.values()];
  for (const r of [0, 0.2, 0.5, 0.8, 0.99]) {
    const line = L.remark({ pieces, fav: pieces[0], rand: () => r });
    assert.ok(line && line.length <= voice.MAX_LINE, line);
  }
  assert.equal(L.remark({ pieces: [] }), null);
});

test('the voice knows the tank occasions and the journal its moments', () => {
  assert.ok(voice.OCCASIONS.tank && voice.OCCASIONS.tankNew);
  const s = voice.say({}, 'tank', 1e12, { text: 'my tank is cosy' });
  assert.equal(s.text, 'my tank is cosy');
  assert.equal(voice.say({}, 'tank', 1e12, { chatter: 'quiet', text: 'x' }), null, 'quiet means quiet');
  for (const kind of ['tank-gift', 'moving-day', 'set-shown']) {
    assert.equal(bond.remember(null, kind, 1e12, { item: 'Kelp', size: '30 gallon', set: 'Beach' }).added, true);
  }
});

test('the tank achievements count from their stats', () => {
  let s = A.recordStat({}, 'tank-plants', { n: 5 });
  s = A.recordStat(s, 'sets-shown', { n: 3 });
  s = A.recordStat(s, 'tank-size', { n: T.SIZES.findIndex(x => x.id === 'thirty-gallon') + 1 });
  s = A.recordStat(s, 'tank-nap');
  for (const id of ['aquascaper', 'on-display', 'upsized', 'night-light']) {
    const a = A.ACHIEVEMENTS.find(x => x.id === id);
    assert.ok(a, id);
    assert.ok(A.statValue(s, a.stat) >= a.goal, id);
  }
  assert.ok(A.recordStat({}, 'tank-size', { n: 2 }).tankSize < A.ACHIEVEMENTS.find(x => x.id === 'upsized').goal);
});
