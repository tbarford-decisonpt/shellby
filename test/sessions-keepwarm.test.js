// Keep warm's ping through a tab (src/main/sessions.js ping): one message
// through the process already running, and none of what a turn of yours
// does: nothing saved, shown, unread or steered in. And idle stop spares a
// tab that's being kept warm.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { SessionManager } = require('../src/main/sessions');
const { History } = require('../src/main/history');
const { PING_TEXT } = require('../src/main/keepwarm');

const HOUR = 60 * 60 * 1000;

function makeManager(env = {}) {
  const history = new History(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-keepwarm-')));
  // What reaches History. A 'usage' item (the fake CLI sends a rate-limit reading
  // with every message) goes through onItem even during a ping, but History drops it (PERSISTED).
  const appended = [];
  const append = history.append.bind(history);
  history.append = (id, item) => { if (item.kind !== 'usage') appended.push(item.kind); return append(id, item); };
  const mgr = new SessionManager({
    getExe: () => process.execPath, argsPrefix: [path.join(__dirname, 'fixtures', 'fake-claude.js')], history,
    getMode: () => 'ask', getModel: () => '', getEnv: () => env,
  });
  const seen = [];
  mgr.on('item', (_tabId, item) => seen.push(item));
  return { mgr, seen, appended, history };
}
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); }
  return false;
};

// A conversation the fake CLI has cached for an hour, as a plan session's is.
async function warmTab(mgr, seen) {
  const tab = mgr.open({ tabId: 't1', cwd: os.tmpdir() });
  mgr.send('t1', 'warm1h 40000', { kind: 'user', text: 'warm1h 40000' });
  assert.ok(await until(() => seen.some(i => i.kind === 'result') && !tab.session.busy), 'the first turn ends');
  assert.equal(tab.session.cache?.ttlMs, HOUR);
  mgr.markRead('t1');
  return tab;
}

test('a ping goes through the running process and leaves the conversation as it was', async () => {
  const { mgr, seen, appended } = makeManager();
  try {
    const tab = await warmTab(mgr, seen);
    const pid = tab.session.proc.pid;
    const shown = seen.length;
    const saved = appended.length;
    const r = await mgr.ping('t1', PING_TEXT);
    assert.deepEqual([r.ok, r.denied, r.tokens.cacheRead], [true, false, 40000]);
    assert.equal(tab.session.proc.pid, pid, 'the same process, so the same cached prompt');
    assert.deepEqual(seen.slice(shown).filter(i => i.kind !== 'usage'), [], 'nothing of its turn reached the panel');
    assert.equal(appended.length, saved, 'nothing of its turn went into History');
    assert.equal(tab.unread, false);
    assert.equal(tab.pinging, null);
    assert.equal(tab.session.cache.ttlMs, HOUR, 'still an hour');
    assert.ok(await until(() => !tab.session.busy));
  } finally { mgr.closeAll({ kill: true }); }
});

test('a ping that asks for a tool is denied, and its result says so', async () => {
  const { mgr, seen } = makeManager({ SHELLBY_FAKE_PING: 'tool' });
  try {
    await warmTab(mgr, seen);
    const shown = seen.length;
    const r = await mgr.ping('t1', PING_TEXT);
    assert.deepEqual([r.ok, r.denied], [false, true]);
    assert.equal(seen.slice(shown).filter(i => i.kind === 'permission').length, 0, 'no permission card for you to find later');
  } finally { mgr.closeAll({ kill: true }); }
});

test('a tab with no process yet cannot be pinged', async () => {
  const { mgr } = makeManager();
  try {
    mgr.open({ tabId: 't1', cwd: os.tmpdir() });
    await assert.rejects(mgr.ping('t1', PING_TEXT), /can't take a ping now/);
  } finally { mgr.closeAll({ kill: true }); }
});

test('while a ping runs, nothing you queue is steered into it', () => {
  const { mgr } = makeManager();
  try {
    const tab = mgr.open({ tabId: 't1', cwd: os.tmpdir() });
    tab.steers = [{ id: 's1', text: 'hello', attachments: [] }];
    tab.pinging = { resolve() {}, denied: false };
    assert.deepEqual(mgr.takeSteers(tab), []);
    assert.equal(tab.steers.length, 1, 'still queued, for after the ping');
  } finally { mgr.closeAll({ kill: true }); }
});

test('idle stop spares a tab Keep warm still keeps', async () => {
  const { mgr, seen } = makeManager();
  try {
    const tab = await warmTab(mgr, seen);
    tab.activeAt = Date.now() - 2 * HOUR;
    assert.deepEqual(mgr.stopIdle(30 * 60 * 1000, Date.now(), id => id === 't1'), []);
    assert.deepEqual(mgr.stopIdle(30 * 60 * 1000), ['t1']);
  } finally { mgr.closeAll({ kill: true }); }
});

test('a receipt is shown, and saved so a reopened conversation still has it', async () => {
  const { mgr, seen, history } = makeManager();
  try {
    await warmTab(mgr, seen);
    mgr.note('t1', { kind: 'keepwarm', warm: true, endsTurn: true, at: Date.now(), read: 40000, text: 'Kept warm 12:55 · read 40k from cache' });
    assert.ok(seen.some(i => i.kind === 'keepwarm'));
    history.flush('t1');
    assert.ok(history.load('t1').some(i => i.kind === 'keepwarm' && i.text === 'Kept warm 12:55 · read 40k from cache'), 'in the real History, not just handed to it');
  } finally { mgr.closeAll({ kill: true }); }
});

test('a tab being pinged is nobody\'s work: the crab, the tray and the trophies do not count it', async () => {
  const { mgr, seen } = makeManager();
  try {
    const tab = await warmTab(mgr, seen);
    const growths = tab.session.growths;
    const pinged = mgr.ping('t1', PING_TEXT);
    assert.equal(mgr.aggregate.busy, 0);
    assert.equal(mgr.aggregate.state, 'idle');
    await pinged;
    assert.equal(tab.session.growths, growths, "the ping doesn't count towards the context's growth pace");
  } finally { mgr.closeAll({ kill: true }); }
});
