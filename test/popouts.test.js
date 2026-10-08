const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/fake-ipc').installFakeElectron();
const { cleanCarry } = require('../src/main/wiring/popouts');

test('what was typed travels between windows, with the ids steering knows queued messages by', () => {
  const c = cleanCarry({
    draft: 'half a thought', attachments: ['C:\\a.png'], turnId: 't1',
    queue: [{ id: 'qab-1', text: 'also add tests', attachments: [], taken: true }, { id: 'qab-2', text: 'then push', attachments: ['C:\\b.txt'] }],
  });
  assert.deepEqual(c, {
    draft: 'half a thought', attachments: ['C:\\a.png'], turnId: 't1',
    queue: [{ id: 'qab-1', text: 'also add tests', attachments: [], taken: true }, { id: 'qab-2', text: 'then push', attachments: ['C:\\b.txt'] }],
  });
});

test('anything else a window sends is dropped, and nothing is nothing', () => {
  assert.equal(cleanCarry(null), null);
  assert.equal(cleanCarry('words'), null);
  const c = cleanCarry({
    draft: 42, attachments: ['', 7, 'C:\\ok'], turnId: 'x'.repeat(65), extra: 'no',
    queue: [{ text: 'no id' }, { id: 'q1' }, { id: 'q2', text: 'kept', attachments: 'not a list', taken: 'yes' }, null],
  });
  assert.deepEqual(c, { draft: '', attachments: ['C:\\ok'], turnId: null, queue: [{ id: 'q2', text: 'kept', attachments: [] }] });
});

test('long text is cut to what the box can send, and the queue to twenty', () => {
  const c = cleanCarry({ draft: 'x'.repeat(30), queue: Array.from({ length: 25 }, (_, i) => ({ id: `q${i}`, text: 'y'.repeat(30) })) }, { maxText: 10 });
  assert.equal(c.draft.length, 10);
  assert.equal(c.queue.length, 20);
  assert.equal(c.queue[0].text.length, 10);
});

// A wirePopouts with just enough of main around it to open a window.
function wired(config = {}) {
  const { FakeBrowserWindow, fakeConfig } = require('./helpers/fake-ipc');
  const { wirePopouts } = require('../src/main/wiring/popouts');
  const panel = new FakeBrowserWindow({ width: 460, height: 700 });
  panel.getPosition = () => [100, 100];
  const sent = [];
  const d = {
    panel, config: fakeConfig(config), RENDERER: 'C:\r', ICON: null, webPreferences: {},
    manager: { tabs: new Map([['t1', { title: 'one' }], ['t2', { title: 'two' }]]), summary: [] },
    workAreas: () => [{ x: 0, y: 0, width: 1920, height: 1040 }], secureWindow: () => {},
    send: (win, channel, payload) => sent.push({ win, channel, payload }),
  };
  const p = wirePopouts(d);
  // The fake's pages can't zoom: each new one gets a factor of its own to set.
  const popOut = p.popOut;
  p.popOut = (...a) => {
    const r = popOut(...a);
    for (const w of FakeBrowserWindow.all) w.webContents.setZoomFactor ||= z => { w.webContents.zoom = z; };
    return r;
  };
  return { d, panel, sent, p, FakeBrowserWindow };
}

test('a popped-out conversation opens at the zoom the panel is saved at', async () => {
  const { p, FakeBrowserWindow } = wired({ panelZoom: 1.25 });
  p.popOut('t1');
  const win = FakeBrowserWindow.all.at(-1);
  await new Promise(r => setImmediate(r)); // did-finish-load
  assert.equal(win.webContents.zoom, 1.25);
});

test('what is not one tab\'s (the usage meter, the outlook) reaches the panel and every popped-out window', () => {
  const { p, panel, sent } = wired();
  p.popOut('t1');
  p.popOut('t2');
  assert.equal(p.everyWindow().length, 3);
  p.sendEveryWindow('usage', { pct: 80 });
  const got = sent.filter(s => s.channel === 'usage');
  assert.equal(got.length, 3);
  assert.equal(got[0].win, panel);
  assert.deepEqual(new Set(got.map(s => s.win)).size, 3, 'each window once');
  // A window that has gone is skipped.
  p.tabWindow('t2').destroyed = true;
  sent.length = 0;
  p.sendEveryWindow('outlook', {});
  assert.equal(sent.length, 2);
});
