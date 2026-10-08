// Searching Settings (src/renderer/panel/settings-search-logic.js): which
// sections and rows a search keeps, and the line under the box.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/renderer/panel/settings-search-logic');

test('terms: lowercased, each word once, curly apostrophes made plain', () => {
  assert.deepEqual(S.terms('  Discord  discord PROFILE '), ['discord', 'profile']);
  assert.deepEqual(S.terms('he’s'), ["he's"]);
  assert.deepEqual(S.terms('   '), []);
});

test('no search keeps everything', () => {
  assert.deepEqual(S.plan({ head: 'Look', units: ['Size', 'Find Shellby'] }, []), { show: true, units: [true, true] });
});

test('a section whose name matches keeps all of its rows', () => {
  const r = S.plan({ head: 'Moving around Moving around', units: ['Let him stroll', 'Keep him on top'] }, S.terms('moving'));
  assert.deepEqual(r, { show: true, units: [true, true] });
});

test('otherwise only the rows that match, and the section only if one does', () => {
  const section = { head: 'Moving around', units: ['Let him stroll around a little', 'Keep him on top of your apps'] };
  assert.deepEqual(S.plan(section, S.terms('top apps')), { show: true, units: [false, true] });
  assert.deepEqual(S.plan(section, S.terms('discord')), { show: false, units: [false, false] });
});

test('every word must be there, but they can be split between heading and row', () => {
  const section = { head: 'Discord', units: ['Show the task title', 'Visit my crab button'] };
  assert.deepEqual(S.plan(section, S.terms('discord title')), { show: true, units: [true, false] });
  assert.deepEqual(S.plan(section, S.terms('title button')), { show: false, units: [false, false] });
});

test('summary says what was found, or points at Ctrl+K', () => {
  assert.equal(S.summary(0, ''), '');
  assert.equal(S.summary(1, 'mic'), '1 section matches “mic”.');
  assert.equal(S.summary(3, ' sound '), '3 sections match “sound”.');
  assert.match(S.summary(0, 'zzz'), /Nothing in Settings matches “zzz”.*Ctrl\+K/);
});
