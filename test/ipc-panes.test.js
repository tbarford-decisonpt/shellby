// The split view's layout (panes:layout, ipc/tabs.js): saved for the next
// start, cleaned on the way in, and only from the panel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, fakeConfig } = require('./helpers/fake-ipc');

installFakeElectron();
const { guardIpc, windowPolicy } = require('../src/main/ipc-guard');
const { registerTabsIpc } = require('../src/main/ipc/tabs');

function setup() {
  const panel = { id: 1 };
  const popout = { id: 2 };
  const ons = new Map();
  const raw = { handle: () => {}, on: (c, fn) => ons.set(c, fn) };
  const ipcMain = guardIpc(raw, windowPolicy(() => ({ panel, isPopout: wc => wc === popout })));
  const config = fakeConfig();
  registerTabsIpc(ipcMain, {
    config, isStr: s => typeof s === 'string', manager: { tabs: new Map() },
    popoutTabOf: wc => (wc === popout ? 'p1' : null),
  });
  const save = (sender, layout) => ons.get('panes:layout')({ sender }, layout);
  return { panel, popout, config, save };
}

test('the panel\'s layout is saved, cleaned', () => {
  const { panel, config, save } = setup();
  save(panel, { grid: [['a', 'a', 7], [], ['b']], sizes: { w: { a: 2, b: -1 }, h: {} } });
  assert.deepEqual(config.get('paneLayout'), { grid: [['a'], ['b']], sizes: { w: { a: 2, b: 2 }, h: { a: 1, b: 1 } } });
});

test('the same layout again writes nothing', () => {
  const { panel, config, save } = setup();
  save(panel, { grid: [['a']] });
  const n = config.sets.length;
  save(panel, { grid: [['a']] });
  assert.equal(config.sets.length, n);
});

test('junk saves as no layout; a popped-out window can\'t save one', () => {
  const { panel, popout, config, save } = setup();
  save(panel, 'nope');
  assert.equal(config.get('paneLayout') ?? null, null);
  save(popout, { grid: [['x']] });
  assert.equal(config.get('paneLayout') ?? null, null);
});

test('back to one pane clears the saved layout', () => {
  const { panel, config, save } = setup();
  save(panel, { grid: [['a'], ['b']] });
  save(panel, null);
  assert.equal(config.get('paneLayout'), null);
});

test('ids an object already has (__proto__, constructor) never reach the saved sizes', () => {
  const { panel, config, save } = setup();
  save(panel, JSON.parse('{"grid":[["__proto__","a"],["constructor","b"]],"sizes":{"w":{"__proto__":5,"a":2,"b":3},"h":{}}}'));
  assert.deepEqual(config.get('paneLayout'), { grid: [['a'], ['b']], sizes: { w: { a: 2, b: 3 }, h: { a: 1, b: 1 } } });
});
