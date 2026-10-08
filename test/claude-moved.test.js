// Claude Code moved while a conversation was open: its installer took the npm
// copy away and left the native one, say. A tab's process is started again
// after an idle stop, and that start must use where Claude Code is now, not
// where it was when the tab opened — or every turn fails with "can't find
// Claude Code" until Shellby itself is restarted.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { ClaudeSession } = require('../src/main/session');
const { SessionManager } = require('../src/main/sessions');
const { History } = require('../src/main/history');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const GONE = path.join(os.tmpdir(), 'shellby-gone', 'claude.exe'); // never existed
const live = new Set();
after(() => { for (const s of live) s.close(); });
const track = s => (live.add(s), s);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-moved-'));

function waitFor(emitter, event, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    emitter.on(event, function h(...args) {
      if (pred(...args)) { clearTimeout(t); emitter.off(event, h); resolve(args); }
    });
  });
}

test('a session asks where Claude Code is each time it starts', async () => {
  let where = GONE;
  const s = track(new ClaudeSession({ exe: () => where, argsPrefix: [FAKE], cwd: os.tmpdir(), mode: 'ask' }));
  const items = [];
  s.on('item', i => items.push(i));

  s.send('first');
  const [missing] = await waitFor(s, 'item', i => i.kind === 'error');
  assert.equal(missing.trouble.kind, 'cli-missing', 'the usual card, with Set up Claude Code');
  await waitFor(s, 'exit', () => true);
  assert.equal(s.busy, false, 'the tab is free to try again');

  where = process.execPath; // found again, somewhere else
  s.send('second');
  const [result] = await waitFor(s, 'item', i => i.kind === 'result');
  assert.equal(result.ok, true);
  assert.ok(items.some(i => i.kind === 'text' && i.text.startsWith('echo: second')));
  s.close();
});

test('an open tab follows Claude Code when it moves between turns', async () => {
  let where = GONE;
  const history = new History(tmp());
  const mgr = new SessionManager({ getExe: () => where, argsPrefix: [FAKE], history, getMode: () => 'ask', getModel: () => '' });
  try {
    mgr.open({ tabId: 'tab-moved', cwd: os.tmpdir() });
    // Opened while Claude Code was one place; by the first turn it's elsewhere.
    // (The same as a tab that was open overnight when the installer moved it.)
    where = process.execPath;
    const results = [];
    mgr.on('item', (_tabId, item) => { if (item.kind === 'result' || item.kind === 'error') results.push(item); });
    mgr.send('tab-moved', 'hello', { kind: 'user', text: 'hello' });
    await waitFor(mgr, 'item', (_t, i) => i.kind === 'result' || i.kind === 'error');
    assert.equal(results[0].kind, 'result');
    assert.equal(results[0].ok, true);
  } finally {
    mgr.closeAll();
  }
});
