// What you use (src/main/feature-use.js): visits counted per screen, on this PC.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/main/feature-use');

const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 8);

test('a visit counts once, and the first one starts the clock', () => {
  let s = F.record(null, 'projects', T0);
  s = F.record(s, 'projects', T0 + 1000);
  s = F.record(s, 'chat', T0 + 2000);
  assert.deepEqual(s, { since: T0, views: { projects: { n: 2, last: T0 + 1000 }, chat: { n: 1, last: T0 + 2000 } } });
});

test('only known screens count', () => {
  assert.deepEqual(F.record(null, 'settings', T0), { since: 0, views: {} });
  assert.deepEqual(F.record(null, '__proto__', T0), { since: 0, views: {} });
  assert.deepEqual(F.record(null, 'onboarding', T0).views, {});
});

test('the rooms and the Shellby screen tabs are all counted', () => {
  const ids = F.SCREENS.map(s => s.id);
  for (const id of ['history', 'bugdex', 'tank', 'beach', 'shop', 'routines', 'time', 'wardrobe', 'chat']) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length, 'no screen twice');
  assert.ok(F.SCREENS.every(s => s.name && s.text), 'each has a name and a line on what it is for');
});

test('a corrupt stored value is cleaned, not trusted', () => {
  const s = F.normalize({ since: 'yesterday', views: { chat: { n: -3 }, tank: { n: 2.9, last: 'x' }, nope: { n: 5 } } });
  assert.deepEqual(s, { since: 0, views: { tank: { n: 2, last: 0 } } });
  assert.deepEqual(F.normalize('garbage'), { since: 0, views: {} });
});

test('report: most used first, quiet after 30 days, and what was never opened', () => {
  let s = null;
  for (let i = 0; i < 5; i++) s = F.record(s, 'chat', T0);
  for (let i = 0; i < 2; i++) s = F.record(s, 'projects', T0 + DAY);
  s = F.record(s, 'tank', T0 - 40 * DAY);
  const r = F.report(s, T0 + 2 * DAY);
  assert.deepEqual(r.used.map(x => [x.id, x.n]), [['chat', 5], ['projects', 2]]);
  assert.deepEqual(r.quiet.map(x => x.id), ['tank']);
  assert.ok(r.never.some(x => x.id === 'beach'));
  assert.ok(!r.never.some(x => ['chat', 'projects', 'tank'].includes(x.id)));
  assert.equal(r.since, T0, 'counting began with the first visit recorded');
});

test('report on nothing yet: no date, every screen not opened', () => {
  const r = F.report(null, T0);
  assert.equal(r.since, null);
  assert.equal(r.never.length, F.SCREENS.length);
});
