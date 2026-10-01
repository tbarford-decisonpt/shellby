const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { HOME, SHELLS, unlockedAt, unlockedBetween, wornShell, normalizeHome, homesView } = require('../src/main/shells');

const SKINS_DIR = path.join(__dirname, '..', 'src', 'skins');
const skins = fs.readdirSync(SKINS_DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(SKINS_DIR, f), 'utf8')));

test('every shell fits in the shell space of every built-in skin', () => {
  assert.ok(skins.length >= 4);
  for (const s of SHELLS) {
    assert.equal(s.pixels.length, 12, `${s.id}: 12 rows`);
    for (const row of s.pixels) assert.equal(row.length, 13, `${s.id}: 13 columns`);
    for (const skin of skins) {
      s.pixels.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === '.') return;
        assert.ok(s.palette[ch], `${s.id}: '${ch}' has a colour`);
        const under = (skin.pixels[y] || '')[x] || '.';
        const part = skin.parts[under];
        assert.ok(under === '.' || part === 'shell', `${s.id} covers the ${part} of ${skin.id} at ${x},${y}`);
      }));
    }
  }
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
  assert.deepEqual(normalizeHome(null), { worn: HOME, seen: [] });
  assert.deepEqual(normalizeHome({ worn: 42, seen: ['snail', 'snail', 'x', 7] }), { worn: HOME, seen: ['snail'] });
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
