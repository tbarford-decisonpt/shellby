// The review inbox, main's half (src/main/review-inbox.js): what a tab's latest
// changes were and whether you've reviewed them, kept on the tab and in History.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../src/main/review-inbox');
const { SessionManager } = require('../src/main/sessions');
const { History } = require('../src/main/history');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const file = (p, added = 1, removed = 0) => ({ path: p, added, removed });
const changes = (after, files, o = {}) => ({
  kind: 'changes', root: 'C:\\code\\app', before: '0'.repeat(40), after, files,
  added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), ...o,
});

test('a turn that changed files makes a fresh, unreviewed entry with the first five paths', () => {
  const files = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'].map(p => file(p, 2, 1));
  const r = R.fromChanges(changes(A, files, { more: 4, turnId: 't1' }), 1000);
  assert.deepEqual(r, {
    after: A, turnId: 't1', root: 'C:\\code\\app', files: 10, added: 12, removed: 6,
    paths: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'], at: 1000, reviewed: false,
  });
  assert.equal(R.fromChanges(changes(A, [])), null);
  assert.equal(R.fromChanges(null), null);
});

test('new changes put a reviewed tab back in the inbox; other items leave it be', () => {
  const first = R.next(null, changes(A, [file('x.js')]), 1);
  const seen = R.setReviewed(first, true);
  assert.equal(seen.reviewed, true);
  assert.equal(R.next(seen, { kind: 'text', text: 'done' }), seen);
  assert.equal(R.next(seen, { kind: 'result', ok: true }), seen);
  const again = R.next(seen, changes(B, [file('y.js')]), 2);
  assert.equal(again.reviewed, false);
  assert.equal(again.after, B);
  // A turn that changed nothing keeps what was there.
  assert.equal(R.next(again, changes(B, [])), again);
});

test('bringing it home counts as reviewed; undoing that very turn leaves nothing to review', () => {
  const r = R.next(null, changes(A, [file('x.js')]));
  assert.equal(R.next(r, { kind: 'home', base: 'main', commits: 1 }).reviewed, true);
  assert.equal(R.next(r, { kind: 'undone', after: B }), r);
  assert.equal(R.next(r, { kind: 'undone', after: A }), null);
  assert.equal(R.next(null, { kind: 'home' }), null);
});

test('marking reviewed twice is no change, so nothing is saved twice', () => {
  const r = R.fromChanges(changes(A, [file('x.js')]));
  assert.equal(R.setReviewed(r, false), r);
  const seen = R.setReviewed(r, true);
  assert.equal(R.setReviewed(seen, true), seen);
  assert.equal(R.setReviewed(null, true), null);
});

test('restore only trusts a well-formed entry from History', () => {
  assert.equal(R.restore(null), null);
  assert.equal(R.restore({ after: 'not a tree' }), null);
  const r = R.restore({ after: A, files: '3', added: -2, removed: 4.7, paths: ['a', 7, '', 'b'], at: 'x', reviewed: 'yes', extra: 1 });
  assert.deepEqual(r, { after: A, turnId: null, root: null, files: 3, added: 0, removed: 4, paths: ['a', 'b'], at: 0, reviewed: false });
});

// ---- on the tab, through the manager

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-review-'));
const manager = history => new SessionManager({ getExe: () => process.execPath, history, getMode: () => 'ask', getModel: () => '' });
const settle = () => new Promise(r => setImmediate(r));

test('the tab summary carries its review, History keeps it, and a reopened tab still has it', async () => {
  const history = new History(tmp());
  const mgr = manager(history);
  const tab = mgr.open({ tabId: 'rv-1', cwd: os.tmpdir() });
  history.create({ id: 'rv-1', title: 'Fix login', cwd: os.tmpdir(), mode: 'ask' });
  tab.saved = true;
  const updatedAt = history.get('rv-1').updatedAt;

  mgr.note('rv-1', changes(A, [file('src/login.js', 5, 2)], { turnId: 't1' }));
  const summary = mgr.summary.find(t => t.id === 'rv-1');
  assert.equal(summary.ready.after, A);
  assert.equal(summary.ready.reviewed, false);
  assert.deepEqual(summary.ready.paths, ['src/login.js']);
  assert.equal(history.get('rv-1').ready.after, A);

  assert.equal(mgr.setReviewed('rv-1', true), true);
  assert.equal(mgr.setReviewed('rv-1', true), false);
  assert.equal(history.get('rv-1').ready.reviewed, true);
  assert.equal(history.get('rv-1').updatedAt, updatedAt, 'reviewing is not work on the conversation');

  const tabs = [];
  mgr.on('tabs', s => tabs.push(s));
  mgr.note('rv-1', changes(B, [file('src/login.test.js', 9, 0)]));
  await settle();
  assert.equal(tabs.at(-1).find(t => t.id === 'rv-1').ready.reviewed, false);

  mgr.close('rv-1');
  const back = mgr.open({ tabId: 'rv-1', cwd: os.tmpdir(), historyEntry: history.get('rv-1') });
  assert.equal(back.ready.after, B);
  assert.equal(back.ready.reviewed, false);
  mgr.closeAll();
});

test('an unsaved tab tracks its review without touching History', () => {
  const history = new History(tmp());
  const mgr = manager(history);
  mgr.open({ tabId: 'rv-2', cwd: os.tmpdir() });
  mgr.note('rv-2', changes(A, [file('a.js')]));
  assert.equal(mgr.summary[0].ready.after, A);
  assert.equal(history.get('rv-2'), null);
  assert.equal(mgr.setReviewed('nope', true), false);
  mgr.closeAll();
});
