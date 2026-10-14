// Keep warm against the real tab manager and the fake CLI: one ping, one receipt, nothing else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { SessionManager } = require('../src/main/sessions');
const { History } = require('../src/main/history');
const { createKeepWarm } = require('../src/main/keepwarm-service');

const HOUR = 60 * 60 * 1000;
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); }
  return false;
};

// A tab manager on the fake CLI with one tab that has just written a one-hour cache.
// fakePing: what the fake CLI's keep-warm ping does (SHELLBY_FAKE_PING), read when the process starts.
async function rig(fakePing) {
  const history = new History(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-keepwarm-int-')));
  if (fakePing) process.env.SHELLBY_FAKE_PING = fakePing;
  const mgr = new SessionManager({
    getExe: () => process.execPath, argsPrefix: [path.join(__dirname, 'fixtures', 'fake-claude.js')], history,
    getMode: () => 'ask', getModel: () => '',
  });
  const seen = [];
  mgr.on('item', (_tabId, item) => seen.push(item));
  const svc = createKeepWarm({
    manager: mgr, panel: {}, CAPTURE: false, send: () => {},
    log: { info: () => {}, warn: () => {} },
    powerSaveBlocker: { start: () => 1, stop: () => {} },
    leadMs: HOUR - 1, // due a millisecond after the reply
    setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  const tab = mgr.open({ tabId: 't1', cwd: os.tmpdir() });
  mgr.send('t1', 'warm1h 250000', { kind: 'user', text: 'warm1h 250000' }); // over the 200k floor
  assert.ok(await until(() => seen.some(i => i.kind === 'result') && !tab.session.busy));
  await new Promise(r => setTimeout(r, 5));
  return { mgr, seen, svc, close: () => { delete process.env.SHELLBY_FAKE_PING; mgr.closeAll({ kill: true }); } };
}

test('with the real tab manager, one due ping leaves exactly one receipt', async () => {
  const { seen, svc, close } = await rig();
  try {
    assert.equal(svc.set(true).ok, true);
    assert.ok(await until(() => seen.some(i => i.kind === 'keepwarm')), 'a receipt');
    await new Promise(r => setTimeout(r, 300));
    const receipts = seen.filter(i => i.kind === 'keepwarm');
    assert.equal(receipts.length, 1);
    assert.match(receipts[0].text, /read 250k from cache/);
    assert.equal(receipts[0].endsTurn, true);
    assert.equal(seen.filter(i => i.kind === 'result').length, 1, 'the ping\'s own result never surfaced');
    assert.equal(svc.isKept('t1'), true);
    svc.set(false);
  } finally { close(); }
});

// One cold ping keeps the tab (it wrote the cache back); keepwarm-service.test.js has the second, which drops it.
test('with the real tab manager, a first ping that finds the cache cold keeps the tab and says what it wrote', async () => {
  const { seen, svc, close } = await rig('cold');
  try {
    assert.equal(svc.set(true).ok, true);
    assert.ok(await until(() => seen.some(i => i.kind === 'keepwarm')), 'a receipt');
    await new Promise(r => setTimeout(r, 300));
    const receipts = seen.filter(i => i.kind === 'keepwarm');
    assert.equal(receipts.length, 1, 'not pinged again straight away');
    assert.match(receipts[0].text, /^Kept warm \d\d:\d\d · wrote 250k back to the cache$/);
    assert.equal(receipts[0].warm, true);
    assert.equal(receipts[0].endsTurn, true);
    assert.equal(svc.isKept('t1'), true);
    svc.set(false);
  } finally { close(); }
});
