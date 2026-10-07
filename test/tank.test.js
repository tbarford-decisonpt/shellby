const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/main/tank');

// A small library: two pieces, a back-glass plant, a floater, a substrate, a
// locked piece and one find he has twice.
const deco = (key, extra = {}) => ({
  key, name: key, category: 'structure', layer: 'floor', palette: { a: '#ffffff' },
  pixels: ['aaaa', 'aaaa'], frames: [], fps: 0, spots: [], locked: null, isNew: false, ...extra,
});
const decor = [
  deco('castle-keep', { pixels: ['aaaaaaaaaaaaaaaa'] }),
  deco('rock-round', { category: 'rock' }),
  deco('kelp', { category: 'plant', layer: 'back' }),
  deco('jelly-lamp', { category: 'bubbler', layer: 'float' }),
  deco('soft-sand', { category: 'substrate', layer: null }),
  deco('plain-water', { category: 'backdrop', layer: null }),
  deco('gravel', { category: 'substrate', layer: null }),
  deco('sunken-chest', { category: 'treasure', locked: { reason: 'achievement', text: 'Moving In' }, isNew: true }),
  deco('my-pack/arch', { isNew: true }),
];
const finds = [
  { id: 'pebble', name: 'Smooth pebble', rarity: 'common', blurb: 'Round.', palette: { a: '#888888' }, pixels: ['aa'] },
  { id: 'pearl', name: 'Pearl', rarity: 'rare', blurb: 'Shiny.', palette: { a: '#eeeeee' }, pixels: ['a'] },
];
const findState = { items: { pebble: { n: 2, first: 1, last: 2 } }, unseen: ['pebble'] };
const lib = T.library({ decor, findState, finds });
const piece = (ref, extra = {}) => ({ ref, x: 10, row: 1, z: 0, flip: false, ...extra });

test('normalize turns junk into an empty nano tank and never throws', () => {
  for (const raw of [undefined, null, 42, 'tank', [], { placed: 'lots' }, { size: 'ocean', style: 7 }]) {
    const s = T.normalize(raw);
    assert.equal(s.size, 'nano');
    assert.deepEqual(s.placed, []);
    assert.deepEqual(s.style, { substrate: null, backdrop: null, light: 'clock' });
  }
});

test('normalize drops bad pieces, clamps numbers and keeps uids unique', () => {
  const s = T.normalize({ placed: [
    piece('castle-keep', { uid: 3, x: -5, row: 9, z: 5000, flip: 'yes' }),
    piece('rock-round', { uid: 3 }),
    piece('../../evil'),
    { ref: '__proto__' },
    null,
    piece('find:pebble'),
  ] });
  assert.deepEqual(s.placed.map(p => p.ref), ['castle-keep', 'rock-round', 'find:pebble']);
  assert.deepEqual(s.placed[0], { uid: 3, ref: 'castle-keep', x: 0, row: 1, z: 999, flip: false });
  assert.equal(new Set(s.placed.map(p => p.uid)).size, 3, 'every piece has its own uid');
});

test('normalize caps a damaged file at the hard limit', () => {
  const s = T.normalize({ placed: Array.from({ length: 500 }, () => piece('rock-round')) });
  assert.equal(s.placed.length, T.HARD_CAP);
});

test('library has the decor and only the finds he has dug up, as many as he has', () => {
  assert.ok(lib.get('castle-keep'));
  assert.equal(lib.get('find:pebble').max, 2);
  assert.equal(lib.get('find:pebble').isNew, true);
  assert.equal(lib.has('find:pearl'), false, 'not dug up yet');
  assert.equal(lib.get('castle-keep').w, 16);
});

test('sanitize keeps what he can place and says why the rest was left out', () => {
  const draft = { placed: [
    piece('castle-keep'), piece('sunken-chest'), piece('soft-sand'), piece('no-such-thing'),
    piece('find:pebble'), piece('find:pebble'), piece('find:pebble'),
  ] };
  const { state, dropped } = T.sanitize(draft, { lib, now: 1234 });
  assert.deepEqual(state.placed.map(p => p.ref), ['castle-keep', 'find:pebble', 'find:pebble']);
  assert.deepEqual(dropped.map(d => `${d.ref}:${d.reason}`), ['sunken-chest:locked', 'soft-sand:not-a-piece', 'no-such-thing:unknown', 'find:pebble:not-enough']);
  assert.equal(state.editedAt, 1234);
});

test('sanitize holds a tank to its room', () => {
  const draft = { placed: Array.from({ length: 30 }, (_, i) => piece('rock-round', { x: i })) };
  const { state, dropped } = T.sanitize(draft, { lib });
  assert.equal(state.placed.length, T.SIZES[0].cap);
  assert.equal(dropped.length, 30 - T.SIZES[0].cap);
  assert.ok(dropped.every(d => d.reason === 'full'));
});

test('sanitize keeps pieces inside the glass and back-glass plants on the back row', () => {
  const { state } = T.sanitize({ placed: [piece('castle-keep', { x: 500 }), piece('kelp', { row: 2 })] }, { lib });
  assert.equal(state.placed[0].x, T.SIZES[0].w - 16);
  assert.equal(state.placed[1].row, 0);
});

test('sanitize only lets him into a tank size he has grown into', () => {
  assert.equal(T.sanitize({ size: 'grand' }, { lib, level: 4 }).state.size, 'nano');
  assert.equal(T.sanitize({ size: 'ten-gallon' }, { lib, level: 5 }).state.size, 'ten-gallon');
  assert.equal(T.sanitize({ size: 'reef' }, { lib, level: 30, shipped: 9 }).state.size, 'nano', 'the reef needs projects shipped too');
  assert.equal(T.sanitize({ size: 'reef' }, { lib, level: 30, shipped: 10 }).state.size, 'reef');
  // A size he already lives in stays if the new one isn't his yet.
  assert.equal(T.sanitize({ size: 'grand' }, { lib, level: 6, previous: { size: 'ten-gallon' } }).state.size, 'ten-gallon');
});

test('sanitize keeps pieces that are already in the tank even when their decor is gone', () => {
  const previous = { placed: [{ uid: 7, ref: 'old-pack/statue', x: 20, row: 2, z: 1, flip: true }] };
  const kept = T.sanitize({ placed: [{ uid: 7, ref: 'old-pack/statue', x: 0, row: 0 }] }, { lib, previous });
  assert.deepEqual(kept.state.placed, previous.placed, 'kept exactly where it was');
  const sneaked = T.sanitize({ placed: [{ uid: 8, ref: 'old-pack/statue' }] }, { lib, previous });
  assert.deepEqual(sneaked.state.placed, [], 'but a new copy of it can’t be added');
});

test('sanitize accepts a floor and back glass he has, and nothing else', () => {
  const ok = T.sanitize({ style: { substrate: 'gravel', backdrop: 'plain-water', light: 'night' } }, { lib }).state.style;
  assert.deepEqual(ok, { substrate: 'gravel', backdrop: 'plain-water', light: 'night' });
  const bad = T.sanitize({ style: { substrate: 'castle-keep', backdrop: 'nope', light: 'disco' } }, { lib }).state.style;
  assert.deepEqual(bad, { substrate: null, backdrop: null, light: 'clock' });
});

test('view paints back to front with him between the middle and front rows', () => {
  const state = { placed: [
    { uid: 1, ref: 'jelly-lamp', x: 5, row: 0 },
    { uid: 2, ref: 'rock-round', x: 5, row: 2 },
    { uid: 3, ref: 'castle-keep', x: 5, row: 0 },
    { uid: 4, ref: 'kelp', x: 5, row: 1 },
  ] };
  const v = T.view({ state, lib });
  assert.deepEqual(v.pieces.map(p => p.ref), ['kelp', 'castle-keep', 'rock-round', 'jelly-lamp']);
  const [, back, front] = v.pieces;
  assert.ok(back.y < v.world.crabY && front.y > v.world.crabY, 'the back row stands behind him and the front row in front');
  assert.ok(v.pieces[3].y < v.world.sandTop, 'floating pieces hang in the water');
});

test('view lists what it can’t show instead of losing it', () => {
  const v = T.view({ state: { placed: [{ uid: 1, ref: 'sunken-chest' }, { uid: 2, ref: 'gone/thing' }] }, lib });
  assert.deepEqual(v.pieces, []);
  assert.deepEqual(v.missing.map(m => m.reason), ['locked', 'gone']);
  assert.equal(v.count, 2, 'they still take up room');
});

test('view falls back to the default floor and back glass', () => {
  const v = T.view({ state: {}, lib });
  assert.equal(v.style.substrate.ref, 'soft-sand');
  assert.equal(v.style.backdrop.ref, 'plain-water');
  assert.equal(T.view({ state: { style: { substrate: 'gravel' } }, lib }).style.substrate.ref, 'gravel');
});

test('view orders the tray by shelf, locked last, and counts what is in use', () => {
  const v = T.view({ state: { placed: [{ uid: 1, ref: 'find:pebble' }] }, lib });
  const cats = v.tray.map(t => t.category);
  assert.deepEqual(cats, [...cats].sort((a, b) => T.CATEGORIES.findIndex(c => c[0] === a) - T.CATEGORIES.findIndex(c => c[0] === b)));
  assert.equal(v.tray.find(t => t.ref === 'find:pebble').placed, 1);
  assert.deepEqual(v.news, ['my-pack/arch'], 'locked pieces and finds don’t light the badge');
});

test('view says which sizes are his', () => {
  const v = T.view({ state: { size: 'ten-gallon' }, lib, level: 12 });
  assert.deepEqual(v.sizes.filter(s => s.unlocked).map(s => s.id), ['nano', 'ten-gallon']);
  assert.equal(v.sizes.find(s => s.current).id, 'ten-gallon');
  assert.equal(v.capacity, 18);
});

test('every size fits a crab and a tall piece between the sand and the top', () => {
  for (const s of T.SIZES) {
    const g = T.geometry(s);
    assert.ok(g.crabY - 13 > 8, `${s.id}: room above him`);
    assert.ok(g.rows[0] < g.rows[1] && g.rows[1] < g.rows[2] && g.rows[2] < s.h);
  }
});

test('sharing on your cards is off unless exactly true, and saving the tank keeps it as it was', () => {
  assert.equal(T.normalize({}).shareCard, false);
  assert.equal(T.normalize({ shareCard: 'yes' }).shareCard, false);
  assert.equal(T.normalize({ shareCard: true }).shareCard, true);
  const previous = { placed: [piece('castle-keep')], shareCard: true };
  assert.equal(T.sanitize({ placed: [], shareCard: false }, { lib, previous }).state.shareCard, true, 'the editor can\'t change it');
  assert.equal(T.sanitize({ placed: [], shareCard: true }, { lib, previous: {} }).state.shareCard, false, 'nor turn it on');
  assert.equal(T.view({ state: previous, lib }).shareCard, true);
});

test('a sanitized tank compares equal to the same tank read back from disk', () => {
  const previous = { size: 'nano', style: { substrate: 'gravel', backdrop: null, light: 'night' }, placed: [{ uid: 1, ref: 'castle-keep', x: 3, row: 0, z: 0, flip: false }] };
  const { state } = T.sanitize(previous, { lib, previous, now: 5 });
  assert.equal(JSON.stringify({ ...state, editedAt: 0 }), JSON.stringify({ ...T.normalize(previous), editedAt: 0 }));
});

test('pieces already in the tank keep their room before anything new goes in', () => {
  const previous = { placed: [{ uid: 50, ref: 'gone-pack/statue', x: 4, row: 1, z: 0, flip: false }] };
  const draft = { placed: [...Array.from({ length: 12 }, (_, i) => piece('rock-round', { uid: i + 1 })), { uid: 50, ref: 'gone-pack/statue', x: 4, row: 1 }] };
  const { state, dropped } = T.sanitize(draft, { lib, previous });
  assert.equal(state.placed.length, T.SIZES[0].cap);
  assert.ok(state.placed.some(p => p.ref === 'gone-pack/statue'), 'the kept piece is never the one squeezed out');
  assert.equal(dropped.length, 3);
});

test('caught bugs can go in the tank as jars, as many as times caught', () => {
  const bugState = { species: { nullfish: { byDevice: { local: 2 }, first: 1, last: 2, forms: ['golden'] } } };
  const withBugs = T.library({ decor, findState, finds, bugState });
  const jar = withBugs.get('jar:nullfish');
  assert.ok(jar, 'a jar for the nullfish');
  assert.equal(jar.category, 'jar');
  assert.equal(jar.max, 2);
  assert.ok(jar.pixels.every(r => r.length === jar.w) && jar.h === jar.pixels.length);
  assert.ok(T.CATEGORIES.some(([id]) => id === 'jar'), 'the tray has a shelf for them');
  const { state, dropped } = T.sanitize({ placed: [piece('jar:nullfish'), piece('jar:nullfish'), piece('jar:nullfish')] }, { lib: withBugs });
  assert.deepEqual(state.placed.map(p => p.ref), ['jar:nullfish', 'jar:nullfish']);
  assert.deepEqual(dropped.map(d => d.reason), ['not-enough']);
});

test('uncaught bugs cannot go in the tank', () => {
  const seenOnly = { species: { nullfish: { byDevice: {}, seen: 3 }, 'no-such-bug': { byDevice: { local: 9 } } } };
  const l = T.library({ decor, findState, finds, bugState: seenOnly });
  assert.equal(l.has('jar:nullfish'), false, 'seen is not caught');
  assert.equal(l.has('jar:no-such-bug'), false);
  assert.equal(T.library({ decor }).has('jar:nullfish'), false, 'no Bugdex at all');
  const { dropped } = T.sanitize({ placed: [piece('jar:nullfish')] }, { lib: l });
  assert.deepEqual(dropped.map(d => `${d.ref}:${d.reason}`), ['jar:nullfish:unknown']);
});
