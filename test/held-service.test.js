// held-service.js: holding work for the reset, the keep-awake request, and
// sending what's due, with fakes for the panel, the tabs and the limit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHeldQueue } = require('../src/main/held-service');

const NOW = 1_790_000_000_000;
const H = 60 * 60 * 1000;
const GRACE = 60 * 1000;

function setup(over = {}) {
  const data = { ...over.data };
  const calls = { send: [], notify: [], sent: [], blocker: [], outlook: 0, runs: [] };
  const tabs = new Map(Object.entries(over.tabs || {}));
  const d = {
    config: { get: k => data[k], set: patch => Object.assign(data, patch) },
    panel: {},
    manager: { tabs, isBusy: () => false },
    history: { get: () => null, load: () => [] },
    claudeStatus: { installed: true, loggedIn: true },
    CAPTURE: false,
    graceMs: GRACE,
    log: { info: () => {}, warn: () => {} },
    send: (_win, channel, payload) => calls.send.push({ channel, payload }),
    notify: (title, body) => calls.notify.push({ title, body }),
    showPanel: () => {},
    tellChannel: () => {},
    wake: () => {},
    openTab: () => {},
    sendToTab: (tabId, text) => { calls.sent.push({ tabId, text }); return { ok: true, item: { kind: 'user', text } }; },
    currentCwd: () => 'C:\\code',
    isFolder: dir => dir === 'C:\\code',
    isStr: s => typeof s === 'string' && s.length > 0,
    dialogLook: () => ({}),
    confirm: { ask: async () => over.answer ?? 1 },
    randomUUID: () => 'new-tab',
    powerSaveBlocker: { start: what => { calls.blocker.push(['start', what]); return 7; }, stop: id => calls.blocker.push(['stop', id]) },
    limitWait: () => over.limit || null,
    resetTarget: () => (over.resetAt === undefined ? NOW + H : over.resetAt),
    clockTime: t => `at ${t}`,
    sendOutlook: () => { calls.outlook++; },
    routines: () => over.routines || [],
    routinesView: () => [],
    runRoutine: r => { calls.runs.push(r.id); return { ok: true }; },
    makeRoomForRoutine: () => {},
    ...over.d,
  };
  return { q: createHeldQueue(d), data, calls };
}

test('with no reset known yet, nothing is held', () => {
  const { q, data } = setup({ resetAt: null });

  const res = q.holdForReset({ kind: 'routine', routineId: 'r1', name: 'Nightly' });

  assert.equal(res.ok, false);
  assert.match(res.error, /doesn't know when your window resets/);
  assert.equal(data.held, undefined);
});

test('a held routine waits until a grace period after the reset, and the panel hears of it', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { q, data, calls } = setup();

  const res = q.holdForReset({ kind: 'routine', routineId: 'r1', name: 'Nightly' });

  assert.equal(res.ok, true);
  assert.equal(res.added, true);
  assert.equal(res.at, NOW + H + GRACE);
  assert.equal(data.held.length, 1);
  assert.ok(calls.send.some(s => s.channel === 'routines'));
  assert.ok(calls.outlook > 0);
});

test('a queued task needs words and a folder that exists', async () => {
  const { q } = setup();

  assert.match((await q.queueTask({ prompt: '   ' })).error, /Say what/);
  assert.match((await q.queueTask({ prompt: 'tidy up', cwd: 'C:\\gone' })).error, /doesn't exist/);
});

test('an Autonomous task is refused until Autonomous has been acknowledged', async () => {
  const { q } = setup();

  const res = await q.queueTask({ prompt: 'tidy up', mode: 'autonomous' });

  assert.match(res.error, /Turn on Autonomous/);
});

test('an Autonomous task turned down in the dialog is not queued', async () => {
  const { q, data } = setup({ data: { autonomousAcknowledged: true }, answer: 1 });

  const res = await q.queueTask({ prompt: 'tidy up', mode: 'autonomous' });

  assert.deepEqual(res, { ok: false, cancelled: true });
  assert.equal(data.held, undefined);
});

test('the PC is kept awake while a task is queued, and let sleep once the queue is empty', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { q, data, calls } = setup();

  q.holdForReset({ kind: 'task', prompt: 'tidy up', cwd: 'C:\\code' });
  assert.deepEqual(calls.blocker, [['start', 'prevent-app-suspension']]);

  q.saveHeld([]);
  assert.deepEqual(calls.blocker.at(-1), ['stop', 7]);
  assert.deepEqual(data.held, []);
});

test('due work still at a limit moves to that limit\'s reset instead of going', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const limit = { window: 'sevenDay', resetsAt: NOW + 30 * H };
  const { q, data, calls } = setup({ limit, data: { held: [{ id: 'h1', kind: 'routine', routineId: 'r1', name: 'Nightly', at: NOW - 1, createdAt: NOW - H }] } });

  await q.releaseHeld();

  assert.equal(data.held[0].at, limit.resetsAt + GRACE);
  assert.deepEqual(calls.runs, []);
});

test('a due message goes to its open tab, leaves the list, and you are told', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const tabs = { 'tab-1': { session: { busy: false } } };
  const { q, data, calls } = setup({ tabs, data: { held: [{ id: 'h1', kind: 'message', tabId: 'tab-1', text: 'carry on', at: NOW - 1, createdAt: NOW - H }] } });

  await q.releaseHeld();

  assert.deepEqual(calls.sent, [{ tabId: 'tab-1', text: 'carry on' }]);
  assert.deepEqual(data.held, []);
  assert.equal(calls.notify.at(-1).title, 'Your usage window reset');
});

test('a due message whose conversation is busy is retried shortly, not dropped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const tabs = { 'tab-1': { session: { busy: true } } };
  const { q, data, calls } = setup({ tabs, data: { held: [{ id: 'h1', kind: 'message', tabId: 'tab-1', text: 'carry on', at: NOW - 1, createdAt: NOW - H }] } });

  await q.releaseHeld();

  assert.equal(data.held.length, 1);
  assert.ok(data.held[0].at > NOW);
  assert.deepEqual(calls.sent, []);
});

test('a held message that fails to send for a popped-out conversation goes back to that window, not the panel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const tabs = { 'tab-1': { session: { busy: false } } };
  const popout = { name: 'popout' };
  const to = [];
  const { q, calls } = setup({
    tabs, data: { held: [{ id: 'h1', kind: 'message', tabId: 'tab-1', text: 'carry on', attachments: [], at: NOW - 1, createdAt: NOW - H }] },
    d: {
      tabWindow: id => (id === 'tab-1' ? popout : null),
      send: (win, channel, payload) => to.push({ win, channel, payload }),
      sendToTab: () => ({ ok: false, error: 'It stopped.' }),
    },
  });

  await q.releaseHeld();

  const back = to.find(s => s.channel === 'held:returned');
  assert.equal(back?.win, popout);
  assert.equal(back.payload.text, 'carry on');
  assert.match(calls.notify.at(-1).body, /back in its conversation's box/);
});

test('a queued task in a folder on another computer goes without Claude Code on this PC', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const task = { id: 'h1', kind: 'task', name: 'Tidy', prompt: 'tidy up', cwd: 'C:\\code', at: NOW - 1, createdAt: NOW - H };
  const opened = [];
  // It gets as far as opening its tab (which stops it here: the rest waits for the turn to end).
  const openTab = o => { opened.push(o.cwd); throw new Error('stop here'); };
  const { q, calls } = setup({ data: { held: [task] }, d: { claudeStatus: { installed: false, loggedIn: false }, remoteService: { placeOf: cwd => (cwd === 'C:\\code' ? { host: 'box', dir: '~/code' } : null) }, openTab } });
  await q.releaseHeld();
  assert.deepEqual(opened, ['C:\\code']);
  assert.equal(calls.notify.at(-1).body, 'stop here');
});

test('a queued task here still needs Claude Code on this PC', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const task = { id: 'h1', kind: 'task', name: 'Tidy', prompt: 'tidy up', cwd: 'C:\\code', at: NOW - 1, createdAt: NOW - H };
  const opened = [];
  const { q, calls } = setup({ data: { held: [task] }, d: { claudeStatus: { installed: false, loggedIn: false }, remoteService: { placeOf: () => null }, openTab: o => opened.push(o) } });
  await q.releaseHeld();
  assert.deepEqual(opened, []);
  assert.match(calls.notify.at(-1).body, /isn't set up and signed in/);
});
