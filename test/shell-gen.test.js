const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { shellGen, mulberry32, PATTERNS } = require('../src/main/progression/shell-gen');
const { tierShell } = require('../src/main/progression/shells');

const SKINS_DIR = path.join(__dirname, '..', 'src', 'skins');
const skins = fs.readdirSync(SKINS_DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(SKINS_DIR, f), 'utf8')));
const fitsSkins = (pixels, palette) => pixels.every((row, y) => [...row].every((ch, x) => {
  if (ch === '.') return true;
  if (!palette[ch]) return false;
  return skins.every(skin => { const under = (skin.pixels[y] || '')[x] || '.'; return under === '.' || skin.parts[under] === 'shell'; });
}));

test('molts 13 to 1000: the mask, only palette keys, and the same shell every time', () => {
  for (let k = 13; k <= 1000; k++) {
    const s = shellGen(k);
    assert.equal(s.pixels.length, 12);
    assert.ok(s.pixels.every(r => r.length === 13), `molt ${k}: 13 columns`);
    assert.ok(fitsSkins(s.pixels, s.palette), `molt ${k} fits every skin and uses its palette`);
    for (const key of s.cycle?.keys || []) assert.ok(s.palette[key], `molt ${k}: cycle key ${key}`);
    assert.deepEqual(shellGen(k), s, `molt ${k} is the same every time`);
    assert.equal(s.id, `molt-${k}`);
  }
});

test('patterns, palettes and names vary; from 50 every effect is on', () => {
  assert.equal(new Set([13, 25, 37, 49, 61, 73].map(k => shellGen(k).pattern)).size, PATTERNS.length);
  assert.notEqual(shellGen(13).palette.m, shellGen(14).palette.m);
  assert.ok(new Set(Array.from({ length: 50 }, (_, i) => shellGen(13 + i).name)).size > 40, 'names rarely repeat');
  const s = shellGen(50);
  assert.ok(s.cycle && s.sparkle && s.aura);
  assert.equal(tierShell(13).name, shellGen(13).name, 'shells.tierShell hands over past twelve');
});

test('mulberry32 is seeded', () => {
  const a = mulberry32(7), b = mulberry32(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});
