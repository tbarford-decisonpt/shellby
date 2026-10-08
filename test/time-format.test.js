// The Time tab's words and numbers (src/renderer/shared/time-format.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/renderer/shared/time-format');

test('dur rounds to the minute and shows hours past sixty minutes', () => {
  assert.equal(F.dur(0), '0m');
  assert.equal(F.dur(29), '0m');
  assert.equal(F.dur(30), '1m');
  assert.equal(F.dur(59 * 60), '59m');
  assert.equal(F.dur(3600), '1h 00m');
  assert.equal(F.dur(3600 + 5 * 60), '1h 05m');
  assert.equal(F.dur(26 * 3600), '26h 00m');
});

test('dur treats missing and negative time as none', () => {
  assert.equal(F.dur(undefined), '0m');
  assert.equal(F.dur(null), '0m');
  assert.equal(F.dur(-500), '0m');
});

test('decimal gives hours to two places for invoices', () => {
  assert.equal(F.decimal(5400), '1.50');
  assert.equal(F.decimal(60), '0.02');
  assert.equal(F.decimal(0), '0.00');
  assert.equal(F.decimal(undefined), '0.00');
});

test('money formats a known currency and falls back for a made-up code', () => {
  assert.match(F.money(12.5, 'USD'), /12\.50/);
  assert.equal(F.money(12.5, 'not-a-currency'), '12.50 not-a-currency');
});

test('dateOf and dayKey round-trip a local day', () => {
  const d = F.dateOf('2026-03-09');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 9);
  assert.equal(F.dayKey(d), '2026-03-09');
  assert.match(F.dayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test('barPercent: nothing is 0, a sliver is at least the minimum, the biggest is 100', () => {
  assert.equal(F.barPercent(0, 3600, 4), 0);
  assert.equal(F.barPercent(10, 3600, 4), 4);
  assert.equal(F.barPercent(3600, 3600, 4), 100);
  assert.equal(F.barPercent(1800, 3600, 2), 50);
  assert.ok(Number.isFinite(F.barPercent(1, 0, 2)), 'a zero max never divides by zero');
});

test('chartLabel: weekdays for a short range, only the 1st and Mondays for a long one', () => {
  assert.equal(F.chartLabel('2026-10-01', true), '1');  // a Thursday, the 1st
  assert.equal(F.chartLabel('2026-10-05', true), '5');  // a Monday
  assert.equal(F.chartLabel('2026-10-07', true), '');   // a Wednesday
  assert.equal(F.chartLabel('2026-10-07', false), F.dateOf('2026-10-07').toLocaleDateString(undefined, { weekday: 'short' }));
});

test('dayParts lists tracked and by-hand time, and the commit estimate only when there is neither', () => {
  assert.deepEqual(F.dayParts({ tracked: 3600, manual: 900 }), ['1h 00m tracked', '+15m by hand']);
  assert.deepEqual(F.dayParts({ tracked: 0, manual: -900 }), ['−15m by hand']);
  assert.deepEqual(F.dayParts({ tracked: 0, manual: 0, estimate: 1800 }), ['~30m from commits']);
  assert.deepEqual(F.dayParts({ tracked: 60, manual: 0, estimate: 1800 }), ['1m tracked']);
  assert.deepEqual(F.dayParts({}), []);
});

test('commitsTip bullets the commits and counts the ones not listed', () => {
  const r = { commits: [{ subject: 'Fix login' }, { subject: 'Add tests' }], commitCount: 5 };
  assert.equal(F.commitsTip(r), '• Fix login\n• Add tests\n…and 3 more');
  assert.equal(F.commitsTip({ commits: [{ subject: 'One' }], commitCount: 1 }), '• One');
  assert.equal(F.commitsTip({ commits: [], commitCount: 0 }), '');
});

test('plural says 1 commit and 2 commits', () => {
  assert.equal(F.plural(1, 'commit'), '1 commit');
  assert.equal(F.plural(0, 'commit'), '0 commits');
  assert.equal(F.plural(2, 'commit'), '2 commits');
});

test('payLabel: an amount when billable with a rate, nothing without a rate, "not billable" otherwise', () => {
  assert.match(F.payLabel({ billable: true, rate: 50, amount: 75 }, 'USD'), /75\.00/);
  assert.equal(F.payLabel({ billable: true, rate: 0, amount: 0 }, 'USD'), '');
  assert.equal(F.payLabel({ billable: false, rate: 50, amount: 75 }, 'USD'), 'not billable');
});

test('roundValues and roundLabel: no rounding once, then each step in each mode', () => {
  const values = F.roundValues([0, 15], ['nearest', 'up']);
  assert.deepEqual(values, ['0|nearest', '15|nearest', '15|up']);
  assert.deepEqual(values.map(F.roundLabel), ["Don't round", 'To the nearest 15 min', 'Up 15 min']);
});

test('currencyCode takes three letters in any case and refuses anything else', () => {
  assert.equal(F.currencyCode(' eur '), 'EUR');
  assert.equal(F.currencyCode('USD'), 'USD');
  for (const bad of ['US', 'EURO', 'U$D', '', null, undefined, 123]) assert.equal(F.currencyCode(bad), null, String(bad));
});

test('addTimeProblem says what is missing, in order, and null when the entry is fine', () => {
  const ok = { key: 'p', day: '2026-10-05', minutes: 30, note: '' };
  assert.equal(F.addTimeProblem(ok), null);
  assert.equal(F.addTimeProblem({ ...ok, key: '' }), 'Pick a project.');
  assert.equal(F.addTimeProblem({ ...ok, day: '' }), 'Pick a day.');
  assert.equal(F.addTimeProblem({ ...ok, minutes: 0 }), 'How much time?');
  assert.equal(F.addTimeProblem({ ...ok, minutes: 0, note: 'call' }), null, 'a note alone is enough');
  assert.equal(F.addTimeProblem({ ...ok, minutes: 24 * 60 + 1 }), "That's more than a day.");
  assert.equal(F.addTimeProblem({ ...ok, minutes: 24 * 60 }), null);
});
