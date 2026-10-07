// Quitting (wiring/quit.js): closing his last window isn't quitting, a quit
// before boot finished doesn't throw, and what he started is stopped.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { installFakeElectron, recorder } = require('./helpers/fake-ipc');

const electron = installFakeElectron();
const appEvents = new EventEmitter();
electron.app.on = (event, fn) => appEvents.on(event, fn);
electron.globalShortcut = { unregisterAll: () => {} };
const { wireQuit } = require('../src/main/wiring/quit');

// What exists before boot has made anything: the services and the module-level areas.
function bareShared(rec) {
  return {
    CAPTURE: true, PRIMARY: false, LOG_DIR: null, config: null, repeating: [],
    statusFile: () => require('path').join(require('os').tmpdir(), 'shellby-quit-test-status.txt'),
    routineService: { stop: rec.fn('routines.stop') },
    usageService: { stop: rec.fn('usage.stop') },
    saveSpend: rec.fn('saveSpend'),
    usagePlan: { save: rec.fn('usagePlan.save') },
    journal: { savePending: rec.fn('journal.savePending') },
    cancelAllChecks: rec.fn('cancelAllChecks'),
    log: { warn: rec.fn('log.warn') },
  };
}

function quit(d) {
  appEvents.removeAllListeners();
  wireQuit(d);
  appEvents.emit('before-quit');
  appEvents.emit('will-quit');
}

test('closing every window is not quitting', () => {
  appEvents.removeAllListeners();
  wireQuit(bareShared(recorder()));
  let prevented = false;
  appEvents.emit('window-all-closed', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test('a quit before boot finished stops what exists and skips the rest', () => {
  const rec = recorder();
  assert.doesNotThrow(() => quit(bareShared(rec)));
  assert.equal(electron.app.isQuitting, true);
  assert.deepEqual(rec.calls.map(c => c.name), ['journal.savePending', 'cancelAllChecks', 'routines.stop', 'usage.stop']);
});

test('after boot: tabs are killed, spending saved, timers cleared', () => {
  const rec = recorder();
  const d = bareShared(rec);
  const timer = setInterval(() => assert.fail('still ticking after quit'), 5);
  Object.assign(d, {
    config: {}, repeating: [timer],
    manager: { closeAll: rec.fn('manager.closeAll') },
    workflows: { shutdown: rec.fn('workflows.shutdown') },
    remote: { shutdown: rec.fn('remote.shutdown') },
  });
  quit(d);
  assert.deepEqual(rec.of('manager.closeAll'), [[{ kill: true }]]);
  assert.equal(rec.of('saveSpend').length, 1);
  assert.equal(rec.of('usagePlan.save').length, 1);
  assert.equal(rec.of('remote.shutdown').length, 2, 'before quitting starts, and again at the end');
  const order = rec.calls.map(c => c.name);
  assert.ok(order.indexOf('workflows.shutdown') < order.indexOf('manager.closeAll'), 'workflows freeze before their tabs close');
});

test('"Stop them" stops the dev servers, detached, on any quit', () => {
  const rec = recorder();
  const d = bareShared(rec);
  d.devServers = {
    view: () => ({ settings: { onQuit: 'stop' } }),
    stopAll: rec.fn('devServers.stopAll', async () => {}),
    shutdown: rec.fn('devServers.shutdown'),
  };
  quit(d);
  assert.deepEqual(rec.of('devServers.stopAll'), [[{ detached: true }]]);
  assert.equal(rec.of('devServers.shutdown').length, 1);
  d.devServers.view = () => ({ settings: { onQuit: 'leave' } });
  quit(d);
  assert.equal(rec.of('devServers.stopAll').length, 1, 'left running when you said so');
});
