const { test } = require('node:test');
const assert = require('node:assert/strict');
const recap = require('../src/main/recap');

const NOW = 1_790_000_000_000;
const MIN = 60 * 1000;
const H = 60 * MIN;
const RESET = NOW + 3 * H;

// ---- watch: are you here?

test('an absence is backdated to your last input, and an hour away earns a recap', () => {
  let s = { since: null };
  ({ state: s } = recap.watch(s, { now: NOW, idleMs: 5 * MIN }));
  assert.equal(s.since, NOW - 5 * MIN);
  // Later readings keep the earliest start.
  ({ state: s } = recap.watch(s, { now: NOW + 30 * MIN, idleMs: 35 * MIN }));
  assert.equal(s.since, NOW - 5 * MIN);
  const r = recap.watch(s, { now: NOW + H, idleMs: 2000 });
  assert.deepEqual(r.back, { since: NOW - 5 * MIN, until: NOW + H });
  assert.equal(r.state.since, null);
});

test('a short absence, or a brief pause, says nothing', () => {
  const { state } = recap.watch({ since: null }, { now: NOW, idleMs: 10 * MIN });
  assert.equal(recap.watch(state, { now: NOW + 20 * MIN, idleMs: 0 }).back, null);
  assert.equal(recap.watch({ since: null }, { now: NOW, idleMs: 30 * 1000 }).state.since, null);
});

test('a locked screen counts as away even with recent input', () => {
  const { state } = recap.watch({ since: null }, { now: NOW, idleMs: 0, locked: true });
  assert.equal(state.since, NOW);
  assert.ok(recap.watch(state, { now: NOW + 2 * H, idleMs: 0 }).back);
});

// ---- the ledger

test('record keeps a day and never mutates the old ledger', () => {
  const old = [{ t: NOW - 25 * H, kind: 'run' }, { t: NOW - H, kind: 'run' }];
  const next = recap.record(old, { kind: 'run', tabId: 'a' }, NOW);
  assert.equal(old.length, 2);
  assert.deepEqual(next.map(e => e.t), [NOW - H, NOW]);
});

test('record caps the ledger', () => {
  let log = [];
  for (let i = 0; i < recap.MAX_EVENTS + 20; i++) log = recap.record(log, { kind: 'run' }, NOW + i);
  assert.equal(log.length, recap.MAX_EVENTS);
});

// ---- the digest

const at = (t, e) => ({ t, ...e });
const run = (t, tabId, title, outcome, extra) => at(t, recap.runEvent(tabId, title, outcome, extra));
const use = (t, tabId, title, pct, resetsAt = RESET) => at(t, recap.usageEvent(tabId, title, { fiveHour: { pct, resetsAt } }));

test('finished and failed runs during the absence, one row per conversation', () => {
  const log = [
    run(NOW - 2 * H, 'old', 'Before you left', 'ok'),
    run(NOW + 10 * MIN, 'a', 'Nightly tests', 'error', { routine: true, error: 'exit 1' }),
    run(NOW + 40 * MIN, 'a', 'Nightly tests', 'ok', { routine: true }),
    run(NOW + 50 * MIN, 'b', 'Fix login', 'error', { error: 'boom' }),
    run(NOW + 55 * MIN, 'c', 'Stopped one', 'stopped'),
  ];
  const d = recap.build(log, { since: NOW, until: NOW + 2 * H });
  assert.deepEqual(d.finished.items.map(r => [r.tabId, r.runs, r.routine]), [['a', 2, true]]);
  assert.deepEqual(d.failed.items.map(r => [r.tabId, r.error]), [['b', 'boom']]);
  assert.equal(d.awayMs, 2 * H);
});

test('usage is charged to whoever reported the rise', () => {
  const log = [
    use(NOW - 10 * MIN, 'a', 'Nightly tests', 20), // the baseline, from before you left
    use(NOW + 10 * MIN, 'a', 'Nightly tests', 30),
    use(NOW + 20 * MIN, 'b', 'Fix login', 33),
    use(NOW + 30 * MIN, 'a', 'Nightly tests', 41),
  ];
  const u = recap.build(log, { since: NOW, until: NOW + 2 * H }).usage;
  assert.equal(u.spent, 21);
  assert.equal(u.from, 20);
  assert.equal(u.to, 41);
  assert.deepEqual(u.by.map(b => [b.tabId, b.pct]), [['a', 18], ['b', 3]]);
});

test('a window that resets while you are out starts again from zero', () => {
  const log = [
    use(NOW - MIN, 'a', 'A', 80),
    use(NOW + 10 * MIN, 'a', 'A', 90),
    use(NOW + 70 * MIN, 'b', 'B', 12, RESET + 5 * H), // the next window
  ];
  const u = recap.build(log, { since: NOW, until: NOW + 2 * H }).usage;
  assert.equal(u.rolledOver, true);
  assert.equal(u.spent, 22);
  assert.equal(u.resetsAt, RESET + 5 * H);
});

test('a late, lower reading in the same window is not a new baseline', () => {
  const log = [
    use(NOW - MIN, 'a', 'A', 30),
    use(NOW + 10 * MIN, 'a', 'A', 40),
    use(NOW + 11 * MIN, 'b', 'B', 35), // older news, arriving late
    use(NOW + 20 * MIN, 'a', 'A', 42),
    use(NOW + 21 * MIN, 'b', 'B', 39), // and another, last of all
  ];
  const u = recap.build(log, { since: NOW, until: NOW + H }).usage;
  assert.equal(u.spent, 12);
  assert.equal(u.to, 42);
  assert.deepEqual(u.by.map(b => [b.tabId, b.pct]), [['a', 12]]);
});

test('conversations stay separate rows even with the same title', () => {
  const d = recap.build([run(NOW + MIN, 'x', 'New task', 'ok'), run(NOW + 2 * MIN, 'y', 'New task', 'ok')], { since: NOW, until: NOW + H });
  assert.equal(d.finished.items.length, 2);
});

test('without a baseline, the first reading is not charged to anyone', () => {
  const log = [use(NOW + 10 * MIN, 'a', 'A', 50), use(NOW + 20 * MIN, 'a', 'A', 55)];
  const u = recap.build(log, { since: NOW, until: NOW + H }).usage;
  assert.equal(u.spent, 5);
  assert.equal(u.from, 50);
});

test('a falling number with no reset time reads as a new window', () => {
  const u = recap.usageDuring([
    at(NOW - MIN, { kind: 'usage', tabId: 'a', title: 'A', pct: 90, resetsAt: null }),
    at(NOW + MIN, { kind: 'usage', tabId: 'a', title: 'A', pct: 4, resetsAt: null }),
  ], NOW, NOW + H);
  assert.equal(u.rolledOver, true);
  assert.equal(u.spent, 4);
});

test('waiting items alone are worth a recap; a quiet absence is not', () => {
  assert.equal(recap.build([], { since: NOW, until: NOW + H }), null);
  assert.equal(recap.build([use(NOW - MIN, 'a', 'A', 10), use(NOW + MIN, 'a', 'A', 10)], { since: NOW, until: NOW + H }), null);
  const d = recap.build([], { since: NOW, until: NOW + H, waiting: [{ tabId: 'a', title: 'A', what: 'question' }] });
  assert.equal(d.waiting.items.length, 1);
});

test('long lists are capped with a count of the rest', () => {
  const log = Array.from({ length: 9 }, (_, i) => run(NOW + i * MIN, `t${i}`, `Task ${i}`, 'ok'));
  const d = recap.build(log, { since: NOW, until: NOW + H });
  assert.equal(d.finished.items.length, recap.MAX_LISTED);
  assert.equal(d.finished.more, 9 - recap.MAX_LISTED);
  assert.match(recap.headline(d), /^9 finished$/);
});

test('headline and awayFor read naturally', () => {
  const d = recap.build([
    use(NOW - MIN, 'a', 'A', 10), run(NOW + MIN, 'a', 'A', 'ok'), use(NOW + 2 * MIN, 'a', 'A', 17),
    run(NOW + 3 * MIN, 'b', 'B', 'error'),
  ], { since: NOW, until: NOW + H, waiting: [{ tabId: 'c', title: 'C', what: 'approval' }] });
  assert.equal(recap.headline(d), '1 finished · 1 failed · 1 waiting on you · about 7% of your 5-hour window used');
  assert.equal(recap.headline(recap.build([], { since: NOW, until: NOW + H, limit: { window: 'fiveHour', resetsAt: RESET } })), 'Paused at your usage limit');
  assert.equal(recap.awayFor(H), '1h');
  assert.equal(recap.awayFor(H + 5 * MIN), '1h 05m');
  assert.equal(recap.awayFor(50 * H), '2 days');
  assert.equal(recap.awayFor(40 * MIN), '40m');
});

test('usageEvent ignores reports without a 5-hour reading', () => {
  assert.equal(recap.usageEvent('a', 'A', { sevenDay: { pct: 3 } }), null);
  assert.equal(recap.usageEvent('a', 'A', null), null);
});
