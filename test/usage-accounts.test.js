// Whose plan a conversation spends (src/main/usage/accounts.js): another
// computer signed in to another Claude account keeps a meter of its own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/main/usage/accounts');

const local = { loggedIn: true, email: 'me@example.com' };
const place = { host: 'devbox', dir: '~/app', anchor: 'C:\\anchor' };
const computer = email => ({ alias: 'devbox', check: { ok: true, loggedIn: true, email, subscriptionType: 'max' } });

test('a folder on this PC, or a computer on the same account, spends your own plan', () => {
  assert.equal(A.accountFor({ place: null, computer: null, local }), null);
  assert.equal(A.accountFor({ place, computer: computer('ME@example.com '), local }), null);
});

test('a computer signed in to another account is that account, named by its email and plan', () => {
  assert.deepEqual(A.accountFor({ place, computer: computer('work@corp.com'), local }), { host: 'devbox', email: 'work@corp.com', plan: 'max' });
  assert.equal(A.accountFor({ place, computer: { alias: 'devbox' }, local }), null, 'not checked yet: nothing says it is anyone else');
  assert.equal(A.accountFor({ place, computer: { alias: 'devbox', check: { ok: false } }, local }), null);
});

test('with Claude Code only over there, its plan is the one you use', () => {
  assert.equal(A.accountFor({ place, computer: computer('work@corp.com'), local: { loggedIn: false } }), null);
  assert.equal(A.accountFor({ place, computer: computer('work@corp.com'), local: null }), null);
});

test("a reading is kept per computer, and a window it doesn't mention keeps its last value", () => {
  const acct = { host: 'DevBox', email: 'work@corp.com', plan: 'max' };
  const first = A.withReading({}, acct, { kind: 'usage', status: 'allowed', fiveHour: { pct: 40, resetsAt: 1 }, sevenDay: { pct: 10, resetsAt: 2 } }, 100);
  const bare = A.withReading(first, acct, { kind: 'usage', status: 'allowed', fiveHour: { pct: 55, resetsAt: 1 }, sevenDay: null }, 200);
  assert.notEqual(bare, first, 'a new map');
  assert.equal(first.devbox.fiveHour.pct, 40, 'the old one is untouched');
  assert.deepEqual(A.readingFor(bare, { host: 'devbox', email: 'WORK@corp.com' }), {
    host: 'DevBox', email: 'work@corp.com', plan: 'max', status: 'allowed',
    fiveHour: { pct: 55, resetsAt: 1 }, sevenDay: { pct: 10, resetsAt: 2 }, at: 200,
  });
  assert.equal(A.readingFor(bare, null), null);
  assert.equal(A.readingFor(bare, { host: 'devbox', email: 'someone-else@corp.com' }), null, 'signed in there as someone else since');
  assert.equal(A.readingFor(null, acct), null);
  const newcomer = A.withReading(bare, { host: 'devbox', email: 'new@corp.com', plan: null }, { status: null, fiveHour: { pct: 3, resetsAt: null }, sevenDay: null }, 300);
  assert.equal(newcomer.devbox.sevenDay, null, "a new sign-in there doesn't inherit the last account's week");
});

test("the panel's view: only computers on another account, with a reading when there is one", () => {
  const computers = [computer('work@corp.com'), { alias: 'mine', check: { email: 'me@example.com' } }, { alias: 'fresh', check: { email: 'x@y.z' } }, { alias: 'unchecked' }];
  const byHost = A.withReading({}, { host: 'devbox', email: 'work@corp.com', plan: 'max' }, { status: null, fiveHour: { pct: 12, resetsAt: null }, sevenDay: null }, 5);
  const view = A.othersView(computers, byHost, local);
  assert.deepEqual(view.map(v => v.host), ['devbox', 'fresh']);
  assert.equal(view[0].fiveHour.pct, 12);
  assert.deepEqual([view[1].fiveHour, view[1].at], [null, null]);
  assert.deepEqual(A.othersView(computers, byHost, { loggedIn: false }), []);
});
