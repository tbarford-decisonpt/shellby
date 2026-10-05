// Try it N ways (src/main/tries.js): reading /tries, what stops it starting,
// the cost question, and how the finished tries are ranked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tries = require('../src/main/tries');

test('parseArg reads a number and the message, defaulting to three', () => {
  assert.deepEqual(tries.parseArg('3 fix the login'), { n: 3, text: 'fix the login' });
  assert.deepEqual(tries.parseArg('2 ways: fix it'), { n: 2, text: 'fix it' });
  assert.deepEqual(tries.parseArg('4x tidy the css'), { n: 4, text: 'tidy the css' });
  assert.deepEqual(tries.parseArg('fix the login'), { n: 3, text: 'fix the login' });
  assert.deepEqual(tries.parseArg('3 line one\nline two'), { n: 3, text: 'line one\nline two' });
});

test('parseArg refuses one try, five tries, and no message', () => {
  assert.ok(tries.parseArg('1 fix it').error);
  assert.ok(tries.parseArg('5 fix it').error);
  assert.ok(tries.parseArg('3').error);
  assert.ok(tries.parseArg('').error);
});

test('problem says why it cannot start, or null', () => {
  assert.equal(tries.problem({ n: 3, text: 'fix it', tabsOpen: 2, maxTabs: 32 }), null);
  assert.match(tries.problem({ n: 3, text: 'fix it', tabsOpen: 30, maxTabs: 32 }), /room for 2/);
  assert.match(tries.problem({ n: 2, text: 'fix it', tabsOpen: 32, maxTabs: 32 }), /up to 32/);
  assert.match(tries.problem({ n: 3, text: '  ', tabsOpen: 0 }), /Type what/);
  assert.match(tries.problem({ n: 3, text: 'x', attachments: 1 }), /typed message/);
  assert.ok(tries.problem({ n: 5, text: 'x' }));
  assert.ok(tries.problem({ n: 3, text: 'x'.repeat(tries.MAX_TEXT + 1) }));
});

test('titles: the first line, shortened, numbered once', () => {
  assert.equal(tries.titleFor('  Fix the login\nand the rest'), 'Fix the login');
  assert.equal(tries.titleFor('a'.repeat(100)).length, 60);
  assert.equal(tries.tryTitle(2, 3, 'Fix it'), '⑂ 2/3 Fix it');
  assert.equal(tries.tryTitle(1, 3, '⑂ 2/3 Fix it'), '⑂ 1/3 Fix it');
  assert.equal(tries.tryTitle(1, 2, ''), '⑂ 1/2 New task');
});

const estimate = over => ({ pct: 8, low: 6, high: 10, samples: 5, basis: 'kind', nowPct: 20, left: 40, line: 75, guardOn: true, ...over });

test('the cost question gives each try, the total and what is left', () => {
  const q = tries.costQuestion({ n: 3, estimate: estimate(), mode: 'ask' });
  assert.equal(q.title, 'Try this three ways?');
  assert.match(q.message, /Each try usually takes about 8% of your window, so about 24% in all\. You've 40% left/);
  assert.match(q.detail, /Ask first/);
  assert.equal(q.over, false);
  assert.equal(q.total, 24);
  assert.equal(q.buttons[0].label, 'Try it 3 ways');
  assert.equal(q.cancelId, 1);
});

test('no estimate says so plainly, and still asks', () => {
  const q = tries.costQuestion({ n: 2, estimate: { pct: null, basis: 'none', left: null } });
  assert.match(q.message, /hasn't seen enough tasks like this to guess; each try is a full task/);
  assert.equal(q.over, false);
  assert.equal(q.buttons.length, 2);
  const none = tries.costQuestion({ n: 2, estimate: null });
  assert.match(none.message, /full task/);
});

test('crossing the guard line offers only Try anyway or Cancel, Cancel by default', () => {
  const q = tries.costQuestion({ n: 4, estimate: estimate({ nowPct: 50, left: 25 }) });
  assert.equal(q.over, true);
  assert.match(q.message, /spending guard would hold/);
  assert.deepEqual(q.buttons.map(b => b.label), ['Try anyway', 'Cancel']);
  assert.equal(q.defaultId, 1);
  const off = tries.costQuestion({ n: 4, estimate: estimate({ nowPct: 70, guardOn: false, line: 100 }) });
  assert.equal(off.over, true);
  assert.match(off.message, /5-hour limit/);
});

test('tiny tasks read as less than 1%', () => {
  const q = tries.costQuestion({ n: 2, estimate: estimate({ pct: 0.3 }) });
  assert.match(q.message, /less than 1% of your window, so less than 1% in all/);
});

const row = over => ({ tabId: 'x', title: 'x', state: 'done', files: 2, added: 10, removed: 2, durationMs: 60000, checks: 'pass', failing: 0, ...over });

test('rank: passing checks first, then fewer failing, then smaller, then faster', () => {
  const ranked = tries.rank([
    row({ tabId: 'fail3', checks: 'fail', failing: 3 }),
    row({ tabId: 'big', added: 400 }),
    row({ tabId: 'fail1', checks: 'fail', failing: 1 }),
    row({ tabId: 'small-slow', durationMs: 90000 }),
    row({ tabId: 'small-fast', durationMs: 30000 }),
    row({ tabId: 'unchecked', checks: 'none' }),
  ]);
  assert.deepEqual(ranked.map(r => r.tabId), ['small-fast', 'small-slow', 'big', 'unchecked', 'fail1', 'fail3']);
  assert.deepEqual(ranked.map(r => r.place), [1, 2, 3, 4, 5, 6]);
});

test('rank: tries that changed nothing or never finished come last', () => {
  const ranked = tries.rank([
    row({ tabId: 'stopped', state: 'stopped' }),
    row({ tabId: 'nothing', files: 0, added: 0, removed: 0 }),
    row({ tabId: 'failing', checks: 'fail', failing: 9 }),
  ]);
  assert.deepEqual(ranked.map(r => r.tabId), ['failing', 'nothing', 'stopped']);
});

test('rank leaves its input alone', () => {
  const rows = [row({ tabId: 'b', added: 50 }), row({ tabId: 'a' })];
  const copy = JSON.parse(JSON.stringify(rows));
  tries.rank(rows);
  assert.deepEqual(rows, copy);
});

test('allDone and the line once they are', () => {
  assert.equal(tries.allDone([row({ state: 'running' }), row()]), false);
  assert.equal(tries.allDone([row({ state: 'checking' })]), false);
  assert.equal(tries.allDone([]), false);
  assert.equal(tries.allDone([row(), row({ state: 'stopped' })]), true);
  const ranked = tries.rank([row({ title: '⑂ 2/2 Fix' }), row({ title: '⑂ 1/2 Fix', checks: 'fail', failing: 1 })]);
  assert.match(tries.doneLine(ranked), /All 2 tries are done\. "⑂ 2\/2 Fix" comes out on top \(checks pass\)/);
  assert.match(tries.doneLine(tries.rank([row({ files: 0 })])), /none changed anything/);
});

test('verdictOf says what each row came to', () => {
  assert.equal(tries.verdictOf(row()).text, 'checks pass');
  assert.equal(tries.verdictOf(row({ checks: 'fail', failing: 2 })).text, '2 failing');
  assert.equal(tries.verdictOf(row({ state: 'running' })).text, 'working');
  assert.equal(tries.verdictOf(row({ files: 0 })).text, 'changed nothing');
  assert.equal(tries.verdictOf(row({ checks: 'declined' })).text, 'tests not run');
});
