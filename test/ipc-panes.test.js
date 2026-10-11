// The split view's layout (panes:layout, ipc/tabs.js): saved for the next
// start, cleaned on the way in, only from the panel and only while split;
// main's tab order follows it, as each pane's tabs in turn.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, fakeConfig } = require('./helpers/fake-ipc');

installFakeElectron();
const { guardIpc, windowPolicy } = require('../src/main/ipc-guard');
const { registerTabsIpc } = require('../src/main/ipc/tabs');

// open: the conversations main has open; a layout is cleaned against them.
function setup(open = ['a', 'b', 'c']) {
  const panel = { id: 1 };
  const popout = { id: 2 };
  const ons = new Map();
  const raw = { handle: () => {}, on: (c, fn) => ons.set(c, fn) };
  const ipcMain = guardIpc(raw, windowPolicy(() => ({ panel, isPopout: wc => wc === popout })));
  const config = fakeConfig();
  const orders = [];
  registerTabsIpc(ipcMain, {
    config, isStr: s => typeof s === 'string',
    manager: { tabs: new Map(open.map(id => [id, {}])), setOrder: ids => { orders.push(ids); return true; } },
    popoutTabOf: wc => (wc === popout ? 'p1' : null),
  });
  const save = (sender, layout) => ons.get('panes:layout')({ sender }, layout);
  return { panel, popout, config, save, orders };
}
const pane = (id, tabs, active = tabs[0]) => ({ id, tabs, active });

test('the panel\'s layout is saved, cleaned', () => {
  const { panel, config, save } = setup();
  save(panel, { grid: [['a', 'a', 7], [], ['b']], sizes: { w: { a: 2, b: -1 }, h: {} } });
  assert.deepEqual(config.get('paneLayout'), {
    grid: [[pane('p1', ['a'])], [pane('p2', ['b'])]],
    sizes: { w: { p1: 2, p2: 2 }, h: { p1: 1, p2: 1 } },
  }, 'an old one-tab-per-pane layout, cleaned into panes');
});

test('the same layout again writes nothing', () => {
  const { panel, config, save } = setup();
  save(panel, { grid: [['a'], ['b']] });
  const n = config.sets.length;
  save(panel, { grid: [['a'], ['b']] });
  assert.equal(config.sets.length, n);
});

test('junk saves as no layout and sets no order; a popped-out window can\'t save one', () => {
  const { panel, popout, config, save, orders } = setup();
  save(panel, 'nope');
  assert.equal(config.get('paneLayout') ?? null, null);
  save(popout, { grid: [['x'], ['y']] });
  assert.equal(config.get('paneLayout') ?? null, null);
  assert.deepEqual(orders, []);
});

test('back to one pane clears the saved layout, whether it comes as one pane or as none', () => {
  const { panel, config, save } = setup();
  save(panel, { grid: [['a'], ['b']] });
  save(panel, { grid: [[pane('p1', ['a', 'b'])]] });
  assert.equal(config.get('paneLayout'), null, 'one pane writes nothing');
  save(panel, { grid: [['a'], ['b']] });
  save(panel, null);
  assert.equal(config.get('paneLayout'), null);
});

test('main keeps its tab order as each pane\'s tabs in turn, one pane\'s included', () => {
  const { panel, save, orders } = setup();
  save(panel, { grid: [[pane('p1', ['b', 'a'], 'a')], [pane('p2', ['c'])]] });
  assert.deepEqual(orders.at(-1), ['b', 'a', 'c']);
  save(panel, { grid: [[pane('p1', ['c', 'b', 'a'])]] });
  assert.deepEqual(orders.at(-1), ['c', 'b', 'a'], 'a split closing down to one pane keeps the order it was left in');
});

test('a layout is cleaned against the conversations main has open, so it can\'t grow without end', () => {
  const { panel, config, save, orders } = setup(['a', 'b']);
  save(panel, { grid: [[pane('p1', ['a', 'zz', ...Array.from({ length: 500 }, (_, i) => `junk${i}`)])], [pane('p2', ['b', 'gone'])]] });
  assert.deepEqual(config.get('paneLayout').grid, [[pane('p1', ['a'])], [pane('p2', ['b'])]]);
  assert.deepEqual(orders.at(-1), ['a', 'b']);
});

test('ids an object already has (__proto__, constructor) never reach the saved sizes', () => {
  const { panel, config, save } = setup();
  save(panel, JSON.parse('{"grid":[["__proto__","a"],["constructor","b"]],"sizes":{"w":{"__proto__":5,"a":2,"b":3},"h":{}}}'));
  assert.deepEqual(config.get('paneLayout'), {
    grid: [[pane('p1', ['a'])], [pane('p2', ['b'])]],
    sizes: { w: { p1: 2, p2: 3 }, h: { p1: 1, p2: 1 } },
  });
});
