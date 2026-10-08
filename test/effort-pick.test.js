// Each conversation's effort, sized from its first message (src/main/effort-pick.js),
// and kept per conversation by the manager (src/main/sessions.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pickEffort } = require('../src/main/effort-pick');
const { SessionManager } = require('../src/main/sessions');
const { History } = require('../src/main/history');

test('a quick question is low, a big job high, the rest medium', () => {
  assert.equal(pickEffort('what does useMemo do?'), 'low');
  assert.equal(pickEffort('Where is the hotkey registered'), 'low');
  assert.equal(pickEffort('rename foo to bar in config.js'), 'low');
  assert.equal(pickEffort('the save button is grey after login, fix it'), 'medium');
  assert.equal(pickEffort('refactor the session manager into smaller modules'), 'high');
  assert.equal(pickEffort('Implement dark mode'), 'high');
  assert.equal(pickEffort(Array(130).fill('word').join(' ')), 'high');
});

test('a question with a file attached is not a quick one', () => {
  assert.equal(pickEffort('what is wrong here?', 1), 'medium');
});

test('nothing to go on: a /command or no words picks nothing', () => {
  assert.equal(pickEffort('/compact'), null);
  assert.equal(pickEffort('   '), null);
  assert.equal(pickEffort(undefined), null);
});

test('it never picks xhigh or max', () => {
  for (const t of ['debug the whole app end to end and audit every file', 'max effort please, think as hard as you can']) {
    assert.ok(['low', 'medium', 'high'].includes(pickEffort(t)));
  }
});

function makeManager({ effort = '', pick = true } = {}) {
  const history = new History(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-effort-')));
  const conf = { effort, pick };
  const mgr = new SessionManager({
    getExe: () => process.execPath, argsPrefix: [path.join(__dirname, 'fixtures', 'fake-claude.js')], history,
    getMode: () => 'ask', getModel: () => '', getEffort: () => conf.effort, getEffortPick: () => conf.pick,
  });
  return { mgr, history, conf };
}

test('on Auto with picking on, the first real message sizes the conversation, once', () => {
  const { mgr, history } = makeManager();
  try {
    const tab = mgr.open({ tabId: 't1', cwd: os.tmpdir() });
    assert.equal(tab.session.effort, '');
    mgr.send('t1', '/compact', { kind: 'user', text: '/compact' });
    assert.equal(tab.effortBy, null); // a /command waits for a real message
    tab.session.busy = false;
    mgr.send('t1', 'what does this repo do?', { kind: 'user', text: 'what does this repo do?' });
    assert.equal(tab.session.effort, 'low');
    assert.equal(tab.effortBy, 'picked');
    assert.deepEqual([history.get('t1').effort, history.get('t1').effortBy], ['low', 'picked']);
    tab.session.busy = false;
    mgr.send('t1', 'now refactor all of it', { kind: 'user', text: 'now refactor all of it' });
    assert.equal(tab.session.effort, 'low'); // picked once; the chip changes it after that
    assert.equal(mgr.summary[0].effort, 'low');
  } finally { mgr.closeAll({ kill: true }); }
});

test('a fixed default or picking off leaves it on the default', () => {
  for (const conf of [{ effort: 'high', pick: true }, { effort: '', pick: false }]) {
    const { mgr } = makeManager(conf);
    try {
      const tab = mgr.open({ tabId: 't1', cwd: os.tmpdir() });
      mgr.send('t1', 'what is this?', { kind: 'user', text: 'what is this?' });
      assert.equal(tab.session.effort, conf.effort);
      assert.equal(tab.effortBy, null);
    } finally { mgr.closeAll({ kill: true }); }
  }
});

test('the chip sets one conversation, the default only those following it, and reopening keeps it', () => {
  const { mgr, history } = makeManager({ effort: 'medium', pick: false });
  try {
    const a = mgr.open({ tabId: 'a', cwd: os.tmpdir() });
    const b = mgr.open({ tabId: 'b', cwd: os.tmpdir() });
    mgr.setTabEffort('a', 'max');
    assert.throws(() => mgr.setTabEffort('a', 'ludicrous'));
    mgr.setEffort('low');
    assert.equal(a.session.effort, 'max');
    assert.equal(b.session.effort, 'low');
    mgr.send('a', 'hi', { kind: 'user', text: 'hi' });
    assert.deepEqual([history.get('a').effort, history.get('a').effortBy], ['max', 'you']);
    mgr.close('a', { kill: true });
    const again = mgr.open({ tabId: 'a', cwd: os.tmpdir(), historyEntry: history.get('a') });
    assert.equal(again.session.effort, 'max');
    assert.equal(again.effortBy, 'you');
  } finally { mgr.closeAll({ kill: true }); }
});
