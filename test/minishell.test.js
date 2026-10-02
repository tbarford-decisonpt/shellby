const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HOME, SHELLS } = require('../src/main/shells');
const { SIZE, MARKS, markUrl } = require('../src/renderer/shared/minishell');

test('every home he can live in has a gutter mark, and no mark is spare', () => {
  const ids = [HOME, ...SHELLS.map(s => s.id)];
  assert.deepEqual(Object.keys(MARKS).sort(), [...ids].sort());
});

test('marks are square grids of coloured pixels', () => {
  for (const [id, mark] of Object.entries(MARKS)) {
    assert.equal(mark.pixels.length, SIZE, `${id}: ${SIZE} rows`);
    for (const row of mark.pixels) {
      assert.equal(row.length, SIZE, `${id}: ${SIZE} columns`);
      for (const ch of row) assert.ok(ch === '.' || mark.palette[ch], `${id}: '${ch}' has a colour`);
    }
    for (const ch of Object.keys(mark.palette)) {
      assert.ok(mark.pixels.some(r => r.includes(ch)), `${id}: '${ch}' is used`);
    }
  }
});

test('markUrl is a CSS url() that survives living in a custom property', () => {
  const url = markUrl('teacup');
  assert.match(url, /^url\("data:image\/svg\+xml,%3Csvg /);
  assert.match(url, /%3C\/svg%3E"\)$/);
  // Anything that would end the url() early or be read as a fragment must be escaped.
  const payload = url.slice('url("'.length, -'")'.length);
  for (const ch of ['<', '>', '#', '"']) assert.ok(!payload.includes(ch), `escapes ${ch}`);
});

test('an unknown shell falls back to his own, so a new home never blanks the mark', () => {
  assert.equal(markUrl('a-shell-we-have-not-drawn-yet'), markUrl(HOME));
});

test('his own shell wears the chosen skin\'s shell colours, not a fixed coral', () => {
  const { skinPalette } = require('../src/renderer/shared/minishell');
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of fs.readdirSync(path.join(__dirname, '../src/skins')).filter(f => f.endsWith('.json'))) {
    const skin = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/skins', f), 'utf8'));
    const shellTones = Object.entries(skin.parts).filter(([, p]) => p === 'shell').map(([ch]) => skin.palette[ch].toLowerCase());
    const pal = skinPalette(skin);
    assert.ok(pal, `${f}: has a shell palette`);
    assert.ok(shellTones.includes(pal.l), `${f}: body of the mark is one of the skin's shell colours`);
    assert.notEqual(markUrl(HOME, skin), markUrl(HOME), `${f}: mark changes with the skin`);
  }
});

test('found homes keep their own art whatever the skin', () => {
  const skin = { palette: { S: '#1d5f5a' }, parts: { S: 'shell' } };
  assert.equal(markUrl('teacup', skin), markUrl('teacup'));
});

test('a skin with no usable shell colours keeps the coral mark', () => {
  const { skinPalette } = require('../src/renderer/shared/minishell');
  assert.equal(skinPalette(null), null);
  assert.equal(skinPalette({ palette: { S: 'red\'/><script>' }, parts: { S: 'shell' } }), null);
  assert.equal(markUrl(HOME, { palette: {}, parts: {} }), markUrl(HOME));
});
