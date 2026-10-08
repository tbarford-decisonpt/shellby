const { test } = require('node:test');
const assert = require('node:assert/strict');
const line = require('../src/main/crab-line');
const { badgeBlock } = require('../src/main/github/pr-badge');

const NOW = new Date(2026, 9, 8, 12).getTime();
const DAY = 24 * 3600e3;

test('the badge line: level and title, class, the week\'s bugs, the event', () => {
  assert.equal(line.badgeText({ level: 12, title: 'Abyssal Admin', cls: 'Tester', bugs: 3, event: { emoji: '🎃' } }), 'Lv 12 Abyssal Admin · Tester · 3 bugs jarred this week · 🎃');
  assert.equal(line.badgeText({ level: 3 }), 'Lv 3');
  assert.equal(line.badgeText({ level: 3, bugs: 1 }), 'Lv 3 · 1 bug jarred this week');
});

test('only words go in: nothing that could be markup or a path', () => {
  assert.equal(line.badgeText({ level: 500, title: '<img src=x>', cls: 'C:\repo' }), 'Lv 99');
  assert.equal(line.trailer({ level: 12, title: 'Abyssal Admin\nSigned-off-by: x' }), 'Shipped-with: Shellby (Lv 12)');
});

test('the commit trailer is one plain line', () => {
  assert.equal(line.trailer({ level: 12, title: 'Abyssal Admin', cls: 'Tester', bugs: 4 }), 'Shipped-with: Shellby (Lv 12 Abyssal Admin)');
});

test('bugs this week, from the Bugdex\'s log', () => {
  const log = [{ at: NOW - DAY }, { at: NOW - 6 * DAY }, { at: NOW - 8 * DAY }, { at: NOW + DAY }, null];
  assert.equal(line.bugsThisWeek(log, NOW), 2);
  assert.equal(line.bugsThisWeek(undefined, NOW), 0);
});

test('the PR badge carries the line, escaped', () => {
  const b = badgeBlock({ login: 'crabfan', commit: 'a'.repeat(40), level: 12, summary: { title: 'Abyssal Admin', cls: 'Tester', bugs: 2 } });
  assert.match(b, /🦀 Built with <a href="[^"]+">Shellby<\/a> · Lv 12 Abyssal Admin · Tester · 2 bugs jarred this week/);
});
