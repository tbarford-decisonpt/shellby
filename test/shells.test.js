const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { HOME, SHELLS, unlockedAt, unlockedBetween, wornShell, normalizeHome, homesView, tierShell, shellById, moltOf, withMolts, renderShell } = require('../src/main/progression/shells');

const SKINS_DIR = path.join(__dirname, '..', 'src', 'skins');
const skins = fs.readdirSync(SKINS_DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(SKINS_DIR, f), 'utf8')));

/** Every picture of a shell (its frames too) fits the skins' shell space and uses only its palette. */
function assertFits(s) {
  for (const [i, pixels] of [s.pixels, ...(s.frames || [])].entries()) {
    assert.equal(pixels.length, 12, `${s.id} frame ${i}: 12 rows`);
    for (const row of pixels) assert.equal(row.length, 13, `${s.id} frame ${i}: 13 columns`);
    for (const skin of skins) {
      pixels.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === '.') return;
        assert.ok(s.palette[ch], `${s.id}: '${ch}' has a colour`);
        const under = (skin.pixels[y] || '')[x] || '.';
        const part = skin.parts[under];
        assert.ok(under === '.' || part === 'shell', `${s.id} covers the ${part} of ${skin.id} at ${x},${y}`);
      }));
    }
  }
  for (const k of s.cycle?.keys || []) assert.ok(s.palette[k], `${s.id}: cycle key '${k}' has a colour`);
  if (s.frames) assert.ok(s.frames.length <= 3 && s.fps >= 1 && s.fps <= 8, `${s.id}: 1-3 frames at 1-8 fps`);
  if (s.aura) assert.match(s.aura, /^#[0-9a-f]{6}$/i);
  if (s.sparkle !== undefined) assert.ok(s.sparkle >= 0 && s.sparkle <= 6);
}

test('every shell fits in the shell space of every built-in skin', () => {
  assert.ok(skins.length >= 4);
  for (const s of SHELLS) assertFits(s);
});

test('the twelve hand-made tier shells fit too, each with something moving or glowing', () => {
  for (let k = 1; k <= 12; k++) {
    const s = tierShell(k);
    assert.equal(s.id, `molt-${k}`);
    assertFits(s);
    assert.ok(s.frames || s.cycle || s.aura || s.sparkle, `${s.id} has an effect`);
  }
  assert.equal(new Set(Array.from({ length: 12 }, (_, i) => tierShell(i + 1).name)).size, 12, 'twelve names');
});

test('tier shells are his once home.molts reaches them, and can be worn', () => {
  assert.equal(unlockedAt('molt-1', 99, null), false);
  assert.equal(unlockedAt('molt-1', 1, { molts: 1 }), true, 'a molt keeps them whatever his level');
  assert.equal(unlockedAt('molt-2', 99, { molts: 1 }), false);
  assert.equal(wornShell({ worn: 'molt-1', molts: 1 }, 1).id, 'molt-1');
  assert.equal(wornShell({ worn: 'molt-3', molts: 1 }, 99), null);
  assert.equal(shellById('molt-40').molt, 40);
  assert.equal(moltOf('molt-0'), 0);
  assert.deepEqual(withMolts({ molts: 3 }, 2).molts, 3, 'never fewer');
  const v = homesView({ molts: 2 }, 99);
  assert.deepEqual(v.shells.filter(s => s.molt).map(s => [s.id, s.locked]), [['molt-1', false], ['molt-2', false], ['molt-3', true]]);
  assert.ok(renderShell(tierShell(5)).frames, 'renderShell passes frames on');
  assert.equal(homesView(null, 50).shells.some(s => s.molt), false, 'no tier teaser before level 90');
});

test('shells unlock at rising levels, and a level-up reports the ones it crosses', () => {
  const levels = SHELLS.map(s => s.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
  assert.equal(unlockedAt(HOME, 1), true);
  assert.equal(unlockedAt('snail', 2), false);
  assert.equal(unlockedAt('snail', 3), true);
  assert.equal(unlockedAt('nope', 99), false);
  assert.deepEqual(unlockedBetween(2, 3).map(s => s.id), ['snail']);
  assert.deepEqual(unlockedBetween(3, 4), []);
  assert.deepEqual(unlockedBetween(1, 9).map(s => s.id), ['snail', 'tin-can', 'teacup']);
});

test('the worn shell falls back to his own when it is locked or unknown', () => {
  assert.equal(wornShell({ worn: 'teacup' }, 8).id, 'teacup');
  assert.equal(wornShell({ worn: 'teacup' }, 7), null);
  assert.equal(wornShell({ worn: 'banana' }, 50), null);
  assert.equal(wornShell(null, 50), null);
});

test('normalizeHome tolerates junk', () => {
  assert.deepEqual(normalizeHome(null), { worn: HOME, seen: [], molts: 0 });
  assert.deepEqual(normalizeHome({ worn: 42, seen: ['snail', 'snail', 'x', 7] }), { worn: HOME, seen: ['snail'], molts: 0 });
  assert.equal(normalizeHome({ worn: 'molt-2', molts: 1 }).worn, HOME, 'a tier shell not earned yet');
});

test('homesView marks locked and new shells', () => {
  const v = homesView({ worn: 'snail', seen: [] }, 5);
  assert.equal(v.worn, 'snail');
  const by = Object.fromEntries(v.shells.map(s => [s.id, s]));
  assert.deepEqual([by.snail.locked, by.snail.isNew], [false, true]);
  assert.deepEqual([by['tin-can'].locked, by['tin-can'].isNew], [false, true]);
  assert.deepEqual([by.teacup.locked, by.teacup.isNew], [true, false]);
  assert.equal(homesView({ worn: 'snail', seen: ['snail'] }, 5).shells[0].isNew, false);
});
