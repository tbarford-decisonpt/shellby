// "Quiz me" (ipc/tabs.js, quiz.js): the questions come from the fake CLI, the
// answers stay in main, and XP is paid on main's count of a finished quiz.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { installFakeElectron } = require('./helpers/fake-ipc');

installFakeElectron();
const changes = require('../src/main/changes');
const { registerTabsIpc } = require('../src/main/ipc/tabs');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const ITEM = { kind: 'changes', root: 'C:\\repo', before: 'a'.repeat(40), after: 'b'.repeat(40), added: 40, removed: 5, files: [{ path: 'src/cart.js' }] };

function setup({ item = ITEM } = {}) {
  const handlers = new Map();
  const xp = [];
  const tab = { id: 't1', title: 'Cart', session: { exe: process.execPath, exePath() { return this.exe; }, argsPrefix: [FAKE], cwd: __dirname } };
  registerTabsIpc({ handle: (c, fn) => handlers.set(c, fn), on: () => {} }, {
    isStr: s => typeof s === 'string' && s.length > 0,
    manager: { tabs: new Map([['t1', tab]]) },
    history: { load: () => [item] },
    changeRef: r => (r?.tabId === 't1' && r.after === item.after ? { tabId: 't1', root: item.root, before: item.before, after: item.after } : null),
    awardXp: (kind, info) => xp.push({ kind, ...info }),
    log: { warn: () => {}, info: () => {} },
  });
  const call = (channel, arg) => handlers.get(channel)({}, arg);
  return { call, tab, xp };
}

const realPatch = changes.patchFor;
test.beforeEach(() => { changes.patchFor = async () => ({ patch: 'diff --git a/src/cart.js b/src/cart.js\n+total()', truncated: false }); });
test.afterEach(() => { changes.patchFor = realPatch; });

const ref = { tabId: 't1', root: ITEM.root, before: ITEM.before, after: ITEM.after };

test('quiz:start: three questions on the diff, and no answers sent to the panel', async () => {
  const { call } = setup();
  const r = await call('quiz:start', ref);
  assert.equal(r.ok, true);
  assert.equal(r.questions.length, 3);
  assert.equal(r.questions[0].question, 'Question 1 about src/cart.js?');
  assert.ok(r.questions.every(q => !('answer' in q) && !('why' in q)));
});

test('quiz:start: refuses a change that is not this conversation\'s, or too small', async () => {
  assert.equal((await setup().call('quiz:start', { ...ref, after: 'c'.repeat(40) })).ok, false);
  const small = setup({ item: { ...ITEM, added: 3, removed: 1 } });
  assert.match((await small.call('quiz:start', ref)).error, /too small/);
});

test('quiz:pick: main says what was right, and a passed quiz pays XP once', async () => {
  const { call, xp, tab } = setup();
  const { questions } = await call('quiz:start', ref);
  const rightOf = q => q.choices.indexOf(q.choices.find(c => c.startsWith('right')));
  let r = await call('quiz:pick', { tabId: 't1', after: ITEM.after, question: 0, choice: rightOf(questions[0]) });
  assert.deepEqual([r.right, r.done, r.score], [true, false, 1]);
  assert.equal(r.why, 'Because of src/cart.js.');
  r = await call('quiz:pick', { tabId: 't1', after: ITEM.after, question: 0, choice: 0 });
  assert.equal(r.error, 'Already answered.');
  const wrong = (rightOf(questions[1]) + 1) % questions[1].choices.length;
  r = await call('quiz:pick', { tabId: 't1', after: ITEM.after, question: 1, choice: wrong });
  assert.equal(r.right, false);
  assert.equal(r.answer, rightOf(questions[1]));
  assert.equal(xp.length, 0, 'nothing until the quiz is finished');
  r = await call('quiz:pick', { tabId: 't1', after: ITEM.after, question: 2, choice: rightOf(questions[2]) });
  assert.deepEqual([r.done, r.score], [true, 2]);
  assert.deepEqual(xp, [{ kind: 'quiz', label: 'Cart' }]);
  assert.equal(tab.quiz, null, 'a finished quiz is gone');
  assert.ok((await call('quiz:pick', { tabId: 't1', after: ITEM.after, question: 2, choice: 0 })).error);
});

test('quiz:pick: a failed quiz pays nothing, and a pick for another change is refused', async () => {
  const { call, xp } = setup();
  const { questions } = await call('quiz:start', ref);
  assert.ok((await call('quiz:pick', { tabId: 't1', after: 'c'.repeat(40), question: 0, choice: 0 })).error);
  for (const [i, q] of questions.entries()) {
    const wrong = q.choices.findIndex(c => c.startsWith('wrong'));
    await call('quiz:pick', { tabId: 't1', after: ITEM.after, question: i, choice: wrong });
  }
  assert.equal(xp.length, 0);
});
