// The panel making room for a workflow map (wiring/panel.js): which way it
// grows, when it can't, and the size it goes back to after being moved. And
// growing to fit more panes (fitPanel, panel:fit), which never shrinks it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, createFakeIpc, FakeBrowserWindow } = require('./helpers/fake-ipc');

const electron = installFakeElectron();
electron.app.on = () => {}; // registerPanelIpc listens for the app's own events too
const { grownBounds, shrunkBounds, wirePanel, ROOMY } = require('../src/main/wiring/panel');
const { registerPanelIpc } = require('../src/main/ipc/panel');

const WA = { x: 0, y: 0, width: 1920, height: 1040 };

test('a panel in the bottom right grows up and to the left, keeping that corner', () => {
  const b = { x: 1400, y: 300, width: 460, height: 700 };
  const g = grownBounds(b, WA);
  assert.equal(g.right, true);
  assert.equal(g.low, true);
  assert.equal(g.set.width, ROOMY.width);
  assert.equal(g.set.height, ROOMY.height);
  assert.equal(g.set.x + g.set.width, b.x + b.width, 'right edge stays put');
  assert.equal(g.set.y + g.set.height, b.y + b.height, 'bottom edge stays put');
});

test('a panel in the top left grows down and to the right', () => {
  const b = { x: 20, y: 20, width: 460, height: 700 };
  const g = grownBounds(b, WA);
  assert.equal(g.right, false);
  assert.equal(g.low, false);
  assert.deepEqual({ x: g.set.x, y: g.set.y }, { x: 20, y: 20 });
});

test('growing never leaves the work area, gap included', () => {
  const wa = { x: 1920, y: 0, width: 1280, height: 1000 };
  const g = grownBounds({ x: 1930, y: 10, width: 460, height: 700 }, wa);
  assert.equal(g.set.width, Math.min(ROOMY.width, wa.width - ROOMY.gap * 2));
  assert.ok(g.set.x >= wa.x + ROOMY.gap);
  assert.ok(g.set.x + g.set.width <= wa.x + wa.width - ROOMY.gap);
  assert.ok(g.set.y >= wa.y + ROOMY.gap);
  assert.ok(g.set.y + g.set.height <= wa.y + wa.height - ROOMY.gap);
});

test('a taller panel keeps its height when it grows wider', () => {
  const g = grownBounds({ x: 100, y: 50, width: 460, height: 900 }, WA);
  assert.equal(g.set.height, 900);
});

test('no room to make on a small screen, or on a panel already that big', () => {
  assert.equal(grownBounds({ x: 0, y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: 800, height: 600 }), null);
  assert.equal(grownBounds({ x: 0, y: 0, width: 1200, height: 800 }, WA), null);
});

test('moved since it grew: back to its old size, from the corner it grew from', () => {
  const from = { x: 1400, y: 300, width: 460, height: 700 };
  const moved = { x: 500, y: 100, width: ROOMY.width, height: ROOMY.height };
  const back = shrunkBounds({ from, right: true, low: true }, moved, WA);
  assert.equal(back.width, from.width);
  assert.equal(back.height, from.height);
  assert.equal(back.x + back.width, moved.x + moved.width);
  assert.equal(back.y + back.height, moved.y + moved.height);
  const topLeft = shrunkBounds({ from, right: false, low: false }, moved, WA);
  assert.deepEqual({ x: topLeft.x, y: topLeft.y }, { x: 500, y: 100 });
});

test('put back inside the work area when it was moved half off screen', () => {
  const from = { x: 0, y: 0, width: 460, height: 700 };
  const back = shrunkBounds({ from, right: false, low: false }, { x: 1800, y: 900, width: 1180, height: 780 }, WA);
  assert.equal(back.x, WA.width - from.width - ROOMY.gap);
  assert.equal(back.y, WA.height - from.height - ROOMY.gap);
});

// ---- room for more panes (tab-panes.js asks over panel:fit)

test('grown to a wanted size for the panes, toward the middle of the screen', () => {
  const b = { x: 1400, y: 300, width: 460, height: 700 };
  const g = grownBounds(b, WA, { width: 1300, height: 700 });
  assert.equal(g.set.width, 1300);
  assert.equal(g.set.height, 700, 'never shorter than it is');
  assert.equal(g.set.x + g.set.width, b.x + b.width, 'right edge stays put');
});

test('a wanted size bigger than the screen stops at the work area', () => {
  const g = grownBounds({ x: 0, y: 0, width: 460, height: 700 }, WA, { width: 5000, height: 700 });
  assert.equal(g.set.width, WA.width - ROOMY.gap * 2);
});

test('already that big: nothing to grow', () => {
  assert.equal(grownBounds({ x: 0, y: 0, width: 1400, height: 800 }, WA, { width: 1300, height: 700 }), null);
});

// A panel window and the little of main's `shared` that fitPanel and Make room touch.
function panelHarness(bounds = { x: 1400, y: 300, width: 460, height: 700 }) {
  const panel = new FakeBrowserWindow(bounds);
  const sent = [];
  const d = { panel, send: (_win, channel, payload) => sent.push({ channel, payload }) };
  return { panel, sent, d, ...wirePanel(d) };
}

test('fitPanel grows the panel to the size asked for, in DIP as given', () => {
  const { panel, fitPanel } = panelHarness();
  assert.deepEqual(fitPanel({ width: 1300, height: 760 }), { ok: true, grew: true });
  const b = panel.getBounds();
  assert.equal(b.width, 1300, 'used as is: no zoom applied in main');
  assert.equal(b.height, 760);
  assert.equal(b.x + b.width, 1400 + 460, 'toward the middle: the right edge stays put');
});

test('fitPanel never shrinks the panel, either way', () => {
  const { panel, fitPanel } = panelHarness({ x: 100, y: 100, width: 900, height: 800 });
  assert.deepEqual(fitPanel({ width: 600, height: 500 }), { ok: true, grew: false });
  assert.deepEqual(fitPanel({ width: 1000, height: 500 }), { ok: true, grew: true });
  assert.deepEqual(panel.getBounds(), { x: 100, y: 100, width: 1000, height: 800 }, 'wider, and just as tall');
});

test('fitPanel leaves a maximized or closed panel alone', () => {
  const h = panelHarness();
  h.panel.maximized = true;
  assert.deepEqual(h.fitPanel({ width: 1300, height: 760 }), { ok: false, grew: false });
  assert.equal(h.panel.getBounds().width, 460);
  h.panel.maximized = false;
  h.panel.destroyed = true;
  assert.deepEqual(h.fitPanel({ width: 1300, height: 760 }), { ok: false, grew: false });
});

test('growing for the panes ends Make room, so turning it off doesn\'t squash them', () => {
  const { panel, sent, fitPanel, setPanelRoomy } = panelHarness();
  setPanelRoomy(true);
  assert.equal(panel.getBounds().width, ROOMY.width);
  assert.deepEqual(fitPanel({ width: 1500, height: 780 }), { ok: true, grew: true });
  assert.ok(sent.some(s => s.channel === 'panel:roomy-lost'), 'the map hears it no longer has room made');
  setPanelRoomy(false);
  assert.equal(panel.getBounds().width, 1500, 'still the size the panes needed');
});

test('panel:fit: only the panel, only a sensible size, passed through untouched', async () => {
  const ipc = createFakeIpc();
  const asked = [];
  const d = { panel: { webContents: ipc.senders.panel }, fitPanel: want => { asked.push(want); return { ok: true, grew: true }; } };
  registerPanelIpc(ipc.ipcMain, d);
  assert.deepEqual(await ipc.invoke('panel:fit', { width: 1300.5, height: 760, extra: 1 }), { ok: true, grew: true });
  assert.deepEqual(asked, [{ width: 1300.5, height: 760 }]);
  for (const bad of [null, {}, { width: 0, height: 700 }, { width: 900, height: -1 }, { width: NaN, height: 700 }, { width: 900, height: 99999 }, { width: '900', height: 700 }]) {
    assert.deepEqual(await ipc.invoke('panel:fit', bad), { ok: false, grew: false }, JSON.stringify(bad));
  }
  d.panel = { webContents: { id: 99 } }; // a popped-out conversation's window shares the bridge, not the panel
  assert.deepEqual(await ipc.invoke('panel:fit', { width: 1300, height: 760 }), { ok: false, grew: false });
  await assert.rejects(ipc.invokeAs(ipc.senders.critter, 'panel:fit', { width: 1300, height: 760 }));
  assert.equal(asked.length, 1);
});

test('giving the room back says the size it went back to, so the page can wait for it', () => {
  const { setPanelRoomy } = panelHarness();
  setPanelRoomy(true);
  assert.deepEqual(setPanelRoomy(false), { ok: true, roomy: false, size: { width: 460, height: 700 } });
  assert.deepEqual(setPanelRoomy(false), { ok: true, roomy: false }, 'nothing to give back: no size to wait for');
});
