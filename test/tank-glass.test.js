const { test } = require('node:test');
const assert = require('node:assert/strict');
const tank = require('../src/main/tank');
const tankShare = require('../src/main/tank-share');
const glass = require('../src/main/tank-glass');
const L = require('../src/main/tank-layouts');
const sync = require('../src/main/github/sync');

const A = 'aaaaaaaaaaaa', B = 'bbbbbbbbbbbb';
const stickerState = {
  projects: {
    [A]: { name: 'shellby', lang: 'JavaScript', firstShipAt: 1000, ships: 3 },
    [B]: { name: 'secret-client', firstShipAt: 1000, hidden: true },
  },
};
const libWith = () => glass.withStickers(tank.library({}), stickerState);

test('every sticker he has can go on the glass, once; hidden ones stay out of the tray', () => {
  const lib = libWith();
  const e = lib.get(`sticker:${A}`);
  assert.equal(e.kind, 'sticker');
  assert.equal(e.category, 'sticker');
  assert.equal(e.max, 1);
  assert.ok(e.w > 0 && e.h > 0 && e.pixels.length === e.h);
  assert.equal(lib.has(`sticker:${B}`), false);
  assert.equal(glass.withStickers(new Map(), null).size, 0, 'no Sticker Book, no stickers');
});

test('withStickers returns a new library and leaves the old one alone', () => {
  const base = tank.library({});
  const before = base.size;
  const out = glass.withStickers(base, stickerState);
  assert.notEqual(out, base);
  assert.equal(base.size, before);
});

test('a sticker ref is a valid piece, and a malformed one is not', () => {
  const s = tank.normalize({ placed: [{ ref: `sticker:${A}`, x: 5, row: 0 }, { ref: 'sticker:NOPE', x: 1 }, { ref: 'sticker:../x' }] });
  assert.deepEqual(s.placed.map(p => p.ref), [`sticker:${A}`]);
});

test('sanitize puts a sticker on the glass once and paints it over everything', () => {
  const lib = libWith();
  const draft = { size: 'nano', placed: [{ ref: `sticker:${A}`, x: 10, row: 1 }, { ref: `sticker:${A}`, x: 30, row: 1 }, { ref: `sticker:${B}`, x: 50, row: 1 }] };
  const { state, dropped } = tank.sanitize(draft, { lib, now: 5 });
  assert.equal(state.placed.length, 1);
  assert.deepEqual(dropped.map(d => d.reason).sort(), ['not-enough', 'unknown']);
  const v = tank.view({ state, lib });
  assert.equal(v.pieces.at(-1).ref, `sticker:${A}`);
  assert.ok(v.categories.some(c => c.id === 'sticker'));
});

test('stickers on the glass never reach the calling card or a friend’s peek', () => {
  const st = { shareCard: true, placed: [{ ref: `sticker:${A}`, x: 5, row: 1 }, { ref: 'castle-keep', x: 20, row: 0 }] };
  const card = tankShare.forCard(st);
  assert.deepEqual(card.placed.map(p => p.ref), ['castle-keep']);
  assert.doesNotMatch(JSON.stringify(card), /sticker/);
  const forged = tankShare.cleanCardTank({ size: 'nano', placed: [{ ref: `sticker:${A}`, x: 1, row: 1 }] });
  assert.equal(forged, null);
});

test('stickers on the glass sync with the tank and saved layouts', () => {
  const st = { placed: [{ uid: 1, ref: `sticker:${A}`, x: 5, row: 1 }], editedAt: 9 };
  assert.equal(tankShare.syncable(st).placed[0].ref, `sticker:${A}`);
  const merged = sync.merge(sync.clean({}), { tank: st, tankLayouts: L.save(null, { name: 'Glassy', tank: st, now: 3 }).state });
  assert.equal(merged.tank.placed[0].ref, `sticker:${A}`);
  assert.equal(merged.tankLayouts.list[0].placed[0].ref, `sticker:${A}`);
});
