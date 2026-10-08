// What a tab does with a mod's words (src/main/sessions.js): each plugin gets a
// budget of lines a minute, and a conversation that ends takes its status lines with it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { SessionManager } = require('../src/main/sessions');
const { History } = require('../src/main/history');

function makeManager() {
  const history = new History(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-sessions-mods-')));
  const mgr = new SessionManager({
    getExe: () => process.execPath, argsPrefix: [path.join(__dirname, 'fixtures', 'fake-claude.js')], history, getMode: () => 'ask', getModel: () => '',
  });
  const seen = [];
  mgr.on('item', (tabId, item) => seen.push({ tabId, item }));
  return { mgr, seen };
}
const items = (seen, kind) => seen.map(s => s.item).filter(i => i.kind === kind);

test('a mod saying more than 20 lines a minute gets one "saying a lot" note, then is dropped', () => {
  const { mgr, seen } = makeManager();
  try {
    const tab = mgr.open({ tabId: 't1', cwd: os.tmpdir() });
    for (let i = 0; i < 25; i++) tab.session.emit('item', { kind: 'modlog', plugin: 'noisy', text: `line ${i}` });
    const logs = items(seen, 'modlog');
    assert.equal(logs.length, 21);
    assert.equal(logs[0].text, 'line 0');
    assert.equal(logs[19].text, 'line 19');
    assert.equal(logs[20].plugin, 'noisy');
    assert.match(logs[20].text, /saying a lot/);
  } finally { mgr.closeAll({ kill: true }); }
});

test('toasts share the line budget, and the note that replaces one is a modlog', () => {
  const { mgr, seen } = makeManager();
  try {
    const tab = mgr.open({ tabId: 't1', cwd: os.tmpdir() });
    for (let i = 0; i < 22; i++) tab.session.emit('item', { kind: 'modtoast', plugin: 'noisy', text: `toast ${i}`, ms: 4000 });
    assert.equal(items(seen, 'modtoast').length, 20);
    const notes = items(seen, 'modlog');
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /saying a lot/);
  } finally { mgr.closeAll({ kill: true }); }
});

test('one noisy mod does not use up another one\'s budget, and each tab has its own', () => {
  const { mgr, seen } = makeManager();
  try {
    const a = mgr.open({ tabId: 'a', cwd: os.tmpdir() });
    const b = mgr.open({ tabId: 'b', cwd: os.tmpdir() });
    for (let i = 0; i < 30; i++) a.session.emit('item', { kind: 'modlog', plugin: 'noisy', text: 'x' });
    a.session.emit('item', { kind: 'modlog', plugin: 'quiet', text: 'hello' });
    b.session.emit('item', { kind: 'modlog', plugin: 'noisy', text: 'fresh tab' });
    const texts = seen.map(s => s.item.text);
    assert.ok(texts.includes('hello'));
    assert.ok(texts.includes('fresh tab'));
  } finally { mgr.closeAll({ kill: true }); }
});

test('other items are never counted against a mod\'s budget', () => {
  const { mgr, seen } = makeManager();
  try {
    const tab = mgr.open({ tabId: 't1', cwd: os.tmpdir() });
    for (let i = 0; i < 40; i++) tab.session.emit('item', { kind: 'modstatus', plugin: 'p', text: `s${i}` });
    assert.equal(items(seen, 'modstatus').length, 40);
  } finally { mgr.closeAll({ kill: true }); }
});

test('when a conversation ends, an item clears every mod status line in its tab', () => {
  const { mgr, seen } = makeManager();
  try {
    const tab = mgr.open({ tabId: 't1', cwd: os.tmpdir() });
    tab.session.emit('exit', 0);
    const clears = seen.filter(s => s.item.kind === 'modstatus');
    assert.deepEqual(clears, [{ tabId: 't1', item: { kind: 'modstatus', plugin: null, text: null } }]);
  } finally { mgr.closeAll({ kill: true }); }
});
