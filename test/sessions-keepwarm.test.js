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

test('a kept tab Keep warm lets go of counts as just used, so idle stop spares it for a while', async () => {
  const { mgr, seen } = makeManager();
  try {
    const tab = await warmTab(mgr, seen);
    tab.activeAt = Date.now() - 55 * 60 * 1000; // last bumped by a ping
    mgr.touch('t1');
    assert.ok(Date.now() - tab.activeAt < 1000);
    assert.deepEqual(mgr.stopIdle(30 * 60 * 1000), []);
    mgr.touch('gone'); // closed meanwhile: nothing to do
  } finally { mgr.closeAll({ kill: true }); }
});

test('a process on its way out cannot take a ping: it would never answer', async () => {
  const { mgr, seen } = makeManager();
  try {
    const tab = await warmTab(mgr, seen);
    tab.session.stopping = true;
    await assert.rejects(mgr.ping('t1', PING_TEXT), /can't take a ping now/);
    tab.session.stopping = false;
    const proc = tab.session.proc;
    proc.exitCode = 0; // exited, its 'close' still to come
    await assert.rejects(mgr.ping('t1', PING_TEXT), /can't take a ping now/);
    proc.exitCode = null;
    assert.equal(tab.pinging ?? null, null);
  } finally { mgr.closeAll({ kill: true }); }
});

test('a ping whose process ends with no result (a stop asked for) is settled when it exits', async () => {
  const { mgr, seen } = makeManager();
  try {
    const tab = await warmTab(mgr, seen);
    const growths = tab.session.growths;
    let r = null;
    tab.pinging = { resolve: v => { r = v; }, denied: false, growths };
    tab.session.growths = growths + 1;
    tab.session.emit('exit', null); // ended() while stopping: no stand-in result, only 'exit'
    assert.deepEqual(r, { ok: false, error: 'its Claude Code process ended', tokens: null, denied: false });
    assert.equal(tab.pinging, null);
    assert.equal(tab.session.growths, growths, 'put back, as a ping that ends does');
  } finally { mgr.closeAll({ kill: true }); }
});

test("a note during a ping is not the ping's: it is saved and shown as ever", async () => {
  const { mgr, seen, appended } = makeManager();
  try {
    const tab = await warmTab(mgr, seen);
    tab.pinging = { resolve() {}, denied: false, growths: tab.session.growths };
    const shown = seen.length;
    const saved = appended.length;
    mgr.note('t1', { kind: 'suggest', id: 'x1', feature: 'lean', text: 'Try Lean' });
    assert.deepEqual(seen.slice(shown).map(i => i.kind), ['suggest']);
    assert.deepEqual(appended.slice(saved), ['suggest']);
    // What the process itself says during the ping is still the ping's.
    tab.session.emit('item', { kind: 'text', text: 'warm' });
    assert.deepEqual(seen.slice(shown).map(i => i.kind), ['suggest']);
    tab.pinging = null;
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
    // A helper of its last turn that has just finished still walks home in the crab window.
    tab.session.tasks.set('h1', { taskId: 'h1', status: 'completed', startedAt: Date.now() - 5000, endedAt: Date.now() });
    const pinged = mgr.ping('t1', PING_TEXT);
    assert.equal(mgr.aggregate.busy, 0);
    assert.equal(mgr.aggregate.state, 'idle');
    assert.deepEqual(mgr.aggregate.crewEnded, [{ id: 'h1', ok: true }], 'only the ping is hidden, not the rest of the tab');
    await pinged;
    assert.equal(tab.session.growths, growths, "the ping doesn't count towards the context's growth pace");
  } finally { mgr.closeAll({ kill: true }); }
});

test('closing a tab while its ping is out settles the ping, so nothing waits on it forever', async () => {
  const { mgr, seen } = makeManager();
  try {
    const tab = await warmTab(mgr, seen);
    const pinged = mgr.ping('t1', PING_TEXT);
    mgr.close('t1');
    const r = await Promise.race([pinged, new Promise(res => setTimeout(() => res('hung'), 3000))]);
    assert.notEqual(r, 'hung', 'the ping settled');
    assert.deepEqual([r.ok, r.denied, r.error], [false, false, 'the conversation was closed']);
    assert.equal(tab.pinging, null);
  } finally { mgr.closeAll({ kill: true }); }
});
