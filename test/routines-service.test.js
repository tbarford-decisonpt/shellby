// routines-service.js: starting a routine's run, making room for it, holding
// it at the limit, and asking before Claude adds one, with fakes for the tabs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoutines, ROUTINE_TABS_KEPT, ROUTINE_COOLDOWN_MS } = require('../src/main/routines-service');

const NOW = 1_790_000_000_000;
const H = 60 * 60 * 1000;

function fakeManager() {
  const tabs = new Map();
  const busy = new Set();
  return {
    tabs, busy,
    isBusy: id => busy.has(id),
    send: () => 'turn-1',
    close: id => tabs.delete(id),
  };
}

function setup(over = {}) {
  const data = { routines: over.routines || [], ...over.data };
  const calls = { opened: [], notify: [], held: [], asked: 0, stats: [] };
  const manager = fakeManager();
  let ids = 0;
  const d = {
    config: { get: k => data[k], set: patch => Object.assign(data, patch) },
    panel: {},
    manager,
    history: { get: () => null, load: () => [], list: () => [] },
    claudeStatus: over.claudeStatus === undefined ? { loggedIn: true } : over.claudeStatus,
    remote: null,
    log: { info: () => {}, warn: () => {} },
    send: () => {},
    notify: (title, body) => calls.notify.push({ title, body }),
    showPanel: () => {},
    sayText: () => {},
    wake: () => {},
    openTab: opts => { calls.opened.push(opts); manager.tabs.set(opts.tabId, { id: opts.tabId }); },
    currentCwd: () => 'C:\\code',
    stat: what => calls.stats.push(what),
    dialogLook: () => ({}),
    confirm: { ask: async () => { calls.asked++; return over.answer ?? 1; } },
    runClaudeOnce: async () => ({ stdout: '', stderr: '' }),
    knownProjects: () => [],
    isFolder: () => true,
    randomUUID: () => `tab-${++ids}`,
    limitWait: () => over.limit || null,
    guardSettings: () => ({ on: true, reserve: 25, maxMinutes: 60 }),
    clockTime: t => `at ${t}`,
    heldList: () => [],
    holdForReset: raw => { calls.held.push(raw); return { ok: true, added: calls.held.length === 1, atText: 'soon' }; },
    scheduleHeld: () => {},
    syncKeepAwake: () => {},
    queueTabs: new Map(),
  };
  return { svc: createRoutines(d), data, calls, manager };
}

const nightly = { id: 'r1', name: 'Nightly', prompt: 'tidy up', mode: 'ask', enabled: true, schedule: { kind: 'daily', time: '03:00' } };

test('a routine does not start while Claude Code is signed out', () => {
  const { svc, calls } = setup({ claudeStatus: { loggedIn: false } });

  const res = svc.runRoutine(nightly);

  assert.equal(res.skipped, true);
  assert.deepEqual(calls.opened, []);
});

test('a run opens its own tab, sends the prompt and notes when it ran', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { svc, data, calls } = setup({ routines: [nightly] });

  const res = svc.runRoutine(nightly);

  assert.equal(res.ok, true);
  assert.equal(calls.opened[0].routineId, 'r1');
  assert.equal(calls.opened[0].title, '⟳ Nightly');
  assert.equal(svc.routineTabs.get(res.tabId), 'r1');
  assert.equal(data.routines[0].lastRunAt, NOW);
  assert.deepEqual(calls.stats, ['routine-run']);
});

test('a routine still running from last time is skipped, not started twice', () => {
  const { svc, manager } = setup({ routines: [nightly] });
  const first = svc.runRoutine(nightly);
  manager.busy.add(first.tabId);

  const second = svc.runRoutine(nightly);

  assert.equal(second.skipped, true);
  assert.match(second.error, /still running/);
});

test('past the kept number of finished routine tabs, the oldest closes', () => {
  const { svc, manager } = setup({ routines: [nightly] });
  const opened = [];
  for (let i = 0; i < ROUTINE_TABS_KEPT; i++) opened.push(svc.runRoutine(nightly).tabId);

  svc.makeRoomForRoutine();

  assert.equal(manager.tabs.has(opened[0]), false);
  assert.equal(svc.routineTabs.has(opened[0]), false);
  assert.equal(manager.tabs.size, ROUTINE_TABS_KEPT - 1);
});

test('a routine due at the limit is held for the reset, and you are told once', () => {
  const limit = { window: 'fiveHour', resetsAt: NOW + H };
  const { svc, calls } = setup({ routines: [nightly], limit });

  const first = svc.runOrHoldRoutine(nightly, 'scheduled');
  const again = svc.runOrHoldRoutine(nightly, 'scheduled');

  assert.deepEqual(first, { ok: true, held: true });
  assert.deepEqual(again, { ok: true, held: true });
  assert.equal(calls.held[0].auto, true);
  assert.equal(calls.notify.length, 1);
  assert.deepEqual(calls.opened, []);
});

test('after a routine is turned down, Claude must wait before proposing another', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { svc, calls } = setup({ answer: 1 });

  const first = await svc.proposeRoutine({ ...nightly, id: 'new' });
  const second = await svc.proposeRoutine({ ...nightly, id: 'new' });
  t.mock.timers.setTime(NOW + ROUTINE_COOLDOWN_MS + 1);
  await svc.proposeRoutine({ ...nightly, id: 'new' });

  assert.ok(first.text, 'the decline is reported back to Claude');
  assert.equal(second.status, 429);
  assert.equal(calls.asked, 2, 'asked again once the quiet spell is over');
});

test('a yes saves the proposed routine', async () => {
  const { svc, data } = setup({ answer: 0 });

  await svc.proposeRoutine({ ...nightly, id: 'new' });

  assert.equal(data.routines.length, 1);
  assert.equal(data.routines[0].name, 'Nightly');
});

test('the scheduler starts once, and stopping it is safe either side of that', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate', 'Date'], now: NOW });
  const { svc } = setup();

  svc.stop();
  assert.equal(svc.isScheduling(), false);
  svc.startScheduler();
  assert.equal(svc.isScheduling(), true);
  svc.stop();
});
