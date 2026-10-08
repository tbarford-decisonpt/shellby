// The tab list and the usage meter (wiring/sessions.js): settings.json is
// written only when the open tabs really change, a closed conversation's
// transcript is flushed, and the meter reaches popped-out windows too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, fakeConfig } = require('./helpers/fake-ipc');

installFakeElectron();
const { wireSessions } = require('../src/main/wiring/sessions');

function setup(initial = {}) {
  const config = fakeConfig(initial);
  const flushed = [];
  const everywhere = [];
  const d = {
    config, CAPTURE: false, FAKE_CLI: null, TAB_IDLE_STOP_MS: 1e9, TAB_IDLE_CHECK_MS: 1e9,
    history: { load: () => [], flush: id => flushed.push(id) },
    log: { info: () => {}, warn: () => {} },
    sendTabs: () => {},
    sendEveryWindow: (channel, payload) => everywhere.push({ channel, payload }),
    send: () => {},
    noteRecap: () => {}, onUsage: () => {}, refreshOutlook: () => {},
    usageService: { checkGuards: () => {} },
  };
  wireSessions(d).createManager();
  return { d, config, flushed, everywhere };
}

const tab = (id, more = {}) => ({ id, saved: true, ...more });

test('a busy flag or a token count changing is not a reason to rewrite settings', () => {
  const { d, config } = setup();
  d.manager.emit('tabs', [tab('a')]);
  d.manager.emit('tabs', [tab('a', { busy: true })]);
  d.manager.emit('tabs', [tab('a', { busy: false, tokens: 900 })]);
  assert.deepEqual(config.sets.filter(s => 'openTabs' in s), [{ openTabs: ['a'] }]);

  d.manager.emit('tabs', [tab('a'), tab('b')]);
  d.manager.emit('tabs', [tab('b')]);
  assert.deepEqual(config.sets.filter(s => 'openTabs' in s).map(s => s.openTabs), [['a'], ['a', 'b'], ['b']]);
});

test('the tabs restored at startup, already in settings, write nothing', () => {
  const { d, config } = setup({ openTabs: ['a', 'b'] });
  d.manager.emit('tabs', [tab('a'), tab('b'), tab('r', { routineId: 'x' })]);
  assert.deepEqual(config.sets, []);
});

test('a conversation closing has its waiting transcript lines written', () => {
  const { d, flushed } = setup();
  d.manager.emit('tabs', [tab('a'), tab('b')]);
  d.manager.emit('tabs', [tab('a', { busy: true }), tab('b')]);
  assert.deepEqual(flushed, []);
  d.manager.emit('tabs', [tab('b')]);
  assert.deepEqual(flushed, ['a']);
});

test('a usage reading goes to every window, popped-out conversations too', () => {
  const { d, everywhere } = setup();
  d.manager.emit('item', 'a', { kind: 'usage', fiveHour: { pct: 40 } }, { title: 'one' });
  assert.deepEqual(everywhere.map(s => s.channel), ['usage']);
});
