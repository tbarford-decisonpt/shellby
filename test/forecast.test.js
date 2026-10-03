const { test } = require('node:test');
const assert = require('node:assert/strict');
const forecast = require('../src/main/forecast');

const MIN = 60 * 1000;
const H = 60 * MIN;
const NOW = Math.floor(1_790_000_000_000 / (5 * MIN)) * (5 * MIN); // on a five-minute mark
const RESET = NOW + 3 * H;

const reading = (minsAgo, pct, resetsAt = RESET, tabId = 'a') => ({ t: NOW - minsAgo * MIN, kind: 'usage', tabId, title: 'Tab', pct, resetsAt });
const clock = t => `${new Date(t).getUTCHours()}:${String(new Date(t).getUTCMinutes()).padStart(2, '0')}`;

test('a steady climb forecasts when the window fills, rounded down to five minutes', () => {
  // 40% -> 60% over the last 40 minutes: 30 points an hour, 40 to go.
  const o = forecast.outlook([reading(40, 40), reading(20, 50), reading(0, 60)], NOW);
  assert.equal(o.pct, 60);
  assert.equal(o.perHour, 30);
  assert.equal(o.hitAt, NOW + 80 * MIN);
  assert.equal(o.resetsAt, RESET);
  assert.equal(o.warn, true);
});

test('a hit after the reset, or barely before it, is no warning', () => {
  // 10 points an hour from 60%: four hours to fill, the reset is in three.
  assert.equal(forecast.outlook([reading(60, 50), reading(0, 60)], NOW).warn, false);
  // Fills five minutes before the reset: not worth saying.
  const soon = NOW + 65 * MIN;
  const near = forecast.outlook([reading(60, 60, soon), reading(0, 80, soon)], NOW);
  assert.equal(near.hitAt, NOW + 60 * MIN);
  assert.equal(near.warn, false);
});

test('a hit more than two hours out is too uncertain to warn about', () => {
  const o = forecast.outlook([reading(60, 10), reading(0, 25)], NOW); // 15/h, 75 to go: 5h
  assert.ok(o.hitAt - NOW > forecast.HORIZON_MS);
  assert.equal(o.warn, false);
});

test('too short a span or too small a rise is no pace at all', () => {
  assert.equal(forecast.outlook([reading(5, 40), reading(0, 60)], NOW), null);
  assert.equal(forecast.outlook([reading(50, 40), reading(0, 42)], NOW), null);
  assert.equal(forecast.outlook([reading(0, 60)], NOW), null);
  assert.equal(forecast.outlook([], NOW), null);
  assert.equal(forecast.outlook(null, NOW), null);
});

test('no reading for a while means nothing is running: no forecast', () => {
  const log = [reading(60, 40), reading(25, 60)];
  assert.equal(forecast.outlook(log, NOW), null);
  assert.ok(forecast.outlook(log, NOW - 10 * MIN));
});

test('only the last hour of the current window counts', () => {
  // A previous window and readings older than an hour are ignored.
  const log = [reading(200, 90, NOW - 30 * MIN), reading(90, 5), reading(60, 30), reading(0, 50)];
  const o = forecast.outlook(log, NOW);
  assert.equal(o.perHour, 20);
  // Just after a reset, the new window has no history yet.
  assert.equal(forecast.outlook([reading(30, 95, NOW - 10 * MIN), reading(0, 2)], NOW), null);
});

test('a late reading from another tab with an older level does not slow the pace', () => {
  const log = [reading(40, 40), reading(10, 60, RESET, 'b'), reading(0, 55, RESET, 'a')];
  const o = forecast.outlook(log, NOW);
  assert.equal(o.pct, 60);
  assert.equal(o.perHour, 30);
});

test('a full window, or one already reset, is left to limits.js', () => {
  assert.equal(forecast.outlook([reading(40, 60), reading(0, 100)], NOW), null);
  assert.equal(forecast.outlook([reading(40, 60, NOW - MIN), reading(0, 80, NOW - MIN)], NOW), null);
  // Readings with no reset time can't be placed in a window.
  assert.equal(forecast.outlook([reading(40, 60, null), reading(0, 80, null)], NOW), null);
});

test('a pace that should already have filled it says now, not the past', () => {
  // 3 points a minute, 15 minutes ago at 85%: should have hit 10 minutes ago.
  const log = [reading(25, 55), reading(15, 85)];
  assert.equal(forecast.outlook(log, NOW).hitAt, NOW);
});

test('the warning reads like a person', () => {
  const o = forecast.outlook([reading(40, 40), reading(0, 60)], NOW);
  assert.equal(forecast.message(o, NOW, clock), `At this pace you'll hit your 5-hour limit around ${clock(NOW + 80 * MIN)}. It resets at ${clock(RESET)}.`);
  assert.match(forecast.message({ ...o, hitAt: NOW + 3 * MIN }, NOW, clock), /in the next few minutes/);
});
