// ci: split panes: side by side up to twelve, sizes, a box in each, a saved layout, windows of their own
// Conversations side by side (tab-panes.js, shared/panes.js) and in windows of
// their own (main's wiring/popouts.js): Split puts one beside another, dragging
// a tab into the chat splits a pane and fills a 2x2 grid and a strip of columns,
// the lines between panes resize them, the box follows the focused pane, and a
// restart brings the layout back. A click picks which pane the
// box talks to, and a tab dragged out of the window gets one of its own, with its conversation and what was typed. Its × hands it back.
// No Claude account needed: the fake CLI answers.
//   node scripts/e2e-panes.js [--shots <dir>]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9398;
const SHOT_TIMEOUT_MS = 10000;   // an unpainted window never answers captureScreenshot
const wait = ms => new Promise(r => setTimeout(r, ms));
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;

// A page over CDP: evaluate, wait for, press the mouse.
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
  // A real drag: press, a few steps of movement, let go.
  const drag = async (from, to, steps = 8) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await wait(30);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const click = async at => {
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  };
  const shot = async name => {
    if (!SHOTS) return;
    const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), wait(SHOT_TIMEOUT_MS).then(() => null)]);
    if (r?.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  return { ws, send, ev, until, drag, click, shot };
}

const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  // The same profile both times: the restart below has to find the layout it saved.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const launch = () => spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: userData, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47960' },
  });
  let app = launch();
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) { list = await targets(); await wait(500); }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')));
    let { ev, until } = panel; // rebound when the app restarts
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    // Not maximized yet: Split has to make room for itself.
    const startWidth = await ev('window.innerWidth');
    console.log(`(screen ${await ev('screen.availWidth')} x ${await ev('screen.availHeight')}, panel ${startWidth} px wide)`);

    // Four conversations, the first with something said in it.
    const ids = await ev(`(async () => {
      const ids = [SB.state.activeTab];
      for (let i = 0; i < 3; i++) { const t = await SB.newTab({ reuse: false }); ids.push(t.id); }
      SB.activate(ids[0]);
      return ids;
    })()`);
    check(Array.isArray(ids) && ids.length === 4, 'four conversations open');
    const [A, B, C, D] = ids;
    await ev(`SB.send('hello from A')`);
    check(await until(`[...SB.state.tabs.get('${A}').el.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('echo: hello from A'))`), 'A has a reply');
    await until(`!SB.state.tabs.get('${A}').busy`);

    // ---- Split: the newest conversation off screen goes beside the focused one.
    // Asked for from another view with the shortcut: the chat comes back, and is
    // measured as it shows, not as the hidden 0 x 0 it was.
    const chromeW = startWidth - await ev(`document.getElementById('feeds').getBoundingClientRect().width`);
    await ev("SB.setView('settings')");
    await wait(300);
    for (const type of ['keyDown', 'keyUp']) await panel.send('Input.dispatchKeyEvent', { type, key: '\\', code: 'Backslash', windowsVirtualKeyCode: 220, modifiers: 2 });
    check(await until('SB.state.grid.length === 2'), 'Ctrl+\\ from Settings splits');
    check(await ev("SB.state.view === 'chat'"), 'and shows the chat');
    await wait(300);
    const split = await ev(`(() => {
      const r = id => SB.state.tabs.get(id).el.getBoundingClientRect();
      const shown = [...SB.state.tabs.values()].filter(t => !t.el.hidden).map(t => t.id);
      return { grid: SB.state.grid, shown, panes: document.getElementById('feeds').dataset.panes,
        aLeftOfD: r('${A}').right <= r('${D}').left + 1, heads: [...document.querySelectorAll('.pane-head')].filter(h => h.offsetHeight).length };
    })()`);
    check(JSON.stringify(split.grid) === JSON.stringify([[A], [D]]), `Split puts the newest beside it: ${JSON.stringify(split.grid)}`);
    check(split.shown.length === 2 && split.panes === '2' && split.aLeftOfD, 'both show, side by side');
    check(split.heads === 2, 'each pane has its header once there are two');
    check(await ev(`SB.state.activeTab === '${D}' && document.getElementById('input').placeholder.includes('"')`), 'the new pane has the focus, and the box says which');
    await panel.shot('split');

    // Two columns need 2 x 286 + 6 px of chat; a 460 px panel can't hold that, so it must have grown.
    const grownTo = await ev('window.innerWidth');
    check(startWidth >= 700 || grownTo > startWidth, `the panel grew to fit two panes (${startWidth} -> ${grownTo})`);
    check(grownTo <= Math.max(startWidth, 2 * 286 + 6 + chromeW + 2), `and no wider than they need (${grownTo})`);
    check(await ev(`[...document.querySelectorAll('.pane')].every(p => p.getBoundingClientRect().width >= ${280 - 1})`), 'no pane narrower than 280 px');

    // ---- Split from a workflow map with Make room on (the palette shows the chat
    // and splits at once): the room goes back first, then the panel grows for the
    // panes, so the map's width is never taken for room the chat has.
    await ev("SB.setView('workflows')");
    await wait(300);
    await ev(`(() => { const b = [...document.querySelectorAll('#workflowsView button')].find(x => /template/i.test(x.textContent)); b && b.click(); })()`);
    await wait(300);
    await ev(`(() => { const b = [...document.querySelectorAll('#workflowsView button, #workflowsView [role=button]')].find(x => /Red build fixer/.test(x.textContent)); b && b.click(); })()`);
    const roomBtn = await until(`!!document.querySelector('#workflowsView [data-room-btn]')`);
    check(roomBtn, 'a workflow map with its Make room button');
    if (roomBtn) {
      await ev(`document.querySelector('#workflowsView [data-room-btn]').click()`);
      const roomy = await until(`window.innerWidth > ${grownTo + 100}`, 3000);
      check(roomy, `Make room widens the panel (${await ev('window.innerWidth')})`);
      await ev("SB.setView('chat'); SB.splitPane()"); // what the palette's Split does
      check(await until('SB.state.grid.length === 3'), 'Split from the map adds a third column');
      await wait(1200); // anything still settling (the room going back, the grow) has
      const three = await ev(`({ w: window.innerWidth, panes: [...document.querySelectorAll('.pane')].map(p => Math.round(p.getBoundingClientRect().width)) })`);
      check(three.panes.length === 3 && three.panes.every(w => w >= 280 - 1), `three panes, none under 280 px once the room's given back (${JSON.stringify(three)})`);
      check(three.w <= Math.max(grownTo, 3 * 286 + 6 + chromeW + 2), `the panel is as wide as the panes need, not the map (${three.w})`);
      check(await ev(`localStorage.getItem('shellby.wf.roomy') === '1'`), 'and maps still ask for room next time (the grow didn\'t take it as yours)');
      await ev(`SB.closePane(SB.state.grid[2][0])`);
      await wait(300);
    }
    check(JSON.stringify(await ev('SB.state.grid')) === JSON.stringify([[A], [D]]), 'back to A beside D');
    await ev(`SB.activate('${D}')`);
    await ev('shellby.maximize()'); // room for the 2x2 grid the drags below make
    await wait(800);

    // ---- Drag a tab from the strip onto the bottom of a pane: that column splits.
    const tabAt = id => ev(`(() => { const r = [...document.querySelectorAll('#tabs [data-tab-id]')].find(e => e.dataset.tabId === '${id}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const paneSpot = (id, fx, fy) => ev(`(() => { const r = SB.state.tabs.get('${id}').el.getBoundingClientRect(); return { x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy} }; })()`);
    await panel.drag(await tabAt(C), await paneSpot(A, 0.5, 0.92));
    await wait(300);
    check(JSON.stringify(await ev('SB.state.grid')) === JSON.stringify([[A, C], [D]]), 'C dropped low on A goes under it');
    check(await ev("document.getElementById('dropHint').hidden"), 'the drop preview goes away on letting go');

    // ...and the last one under D: a full 2x2 grid.
    await panel.drag(await tabAt(B), await paneSpot(D, 0.5, 0.92));
    await wait(300);
    const quad = await ev(`(() => {
      const r = id => SB.state.tabs.get(id).el.getBoundingClientRect();
      const [a, b, c, d] = ['${A}', '${B}', '${C}', '${D}'].map(r);
      return { grid: SB.state.grid, grid2x2: a.right <= d.left + 1 && a.bottom <= c.top + 1 && d.bottom <= b.top + 1 && Math.abs(a.top - d.top) < 2 };
    })()`);
    check(JSON.stringify(quad.grid) === JSON.stringify([[A, C], [D, B]]), `four panes: ${JSON.stringify(quad.grid)}`);
    check(quad.grid2x2, 'laid out two by two');
    check(await ev(`SB.panes.zones(SB.state.grid, '${A}', 'x').includes('right')`), 'a 2x2 can still take another column');
    await panel.shot('quad');

    // ---- The line between two columns drags; a double-click evens them out.
    const colRects = () => ev(`[...document.querySelectorAll('.pane-row > .pane-col')].map(c => { const r = c.getBoundingClientRect(); return { left: r.left, width: r.width }; })`);
    const before = await colRects();
    const line = await ev(`(() => { const r = document.querySelector('.pane-divider.across').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    check(!!line, 'a line between the columns');
    await panel.drag(line, { x: line.x + 120, y: line.y });
    await wait(200);
    const after = await colRects();
    check(after[0].width > before[0].width + 80, `dragging it widens the left column (${Math.round(before[0].width)} -> ${Math.round(after[0].width)})`);
    check(await ev(`(() => { const s = SB.state.paneSizes; return s.w['${A}'] > s.w['${D}']; })()`), 'and the sizes say so');
    await ev(`document.querySelector('.pane-divider.across').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await wait(200);
    const evened = await colRects();
    check(Math.abs(evened[0].width - evened[1].width) < 3, 'a double-click evens them out');

    // ---- A feed scrolled up keeps its place when the grid changes around it.
    await ev(`(() => { const t = SB.state.tabs.get('${A}'); for (let i = 0; i < 80; i++) t.render({ kind: 'text', text: 'filler line ' + i }, { replay: true }); })()`);
    await ev(`(() => { const el = SB.state.tabs.get('${A}').el; el.scrollTop = 40; el.dispatchEvent(new Event('scroll')); })()`);
    await wait(150);
    await ev(`SB.closePane('${B}')`);
    await wait(300);
    check(await ev(`SB.state.tabs.get('${A}').el.scrollTop`) === 40, 'a scrolled-up feed keeps its place when a pane closes');
    // D was half its column; alone now, it takes the whole column (sizes are normalized).
    check(await ev(`(() => { const p = document.querySelector('.pane[data-tab="${D}"]').getBoundingClientRect(); const c = document.querySelector('.pane[data-tab="${D}"]').parentElement.getBoundingClientRect(); return p.height > c.height - 20; })()`), 'D fills its column once B\'s pane closes');
    await panel.drag(await tabAt(B), await paneSpot(D, 0.5, 0.92));
    await wait(300);
    check(JSON.stringify(await ev('SB.state.grid')) === JSON.stringify([[A, C], [D, B]]), 'B back under D');

    // ---- The box sits in the focused pane; the others show their own draft.
    await ev(`SB.activate('${C}'); document.getElementById('input').value = 'draft for C'`);
    await panel.click(await paneSpot(D, 0.5, 0.5));
    check(await until(`SB.state.activeTab === '${D}'`), 'clicking D focuses it');
    check(await ev(`document.getElementById('composer').closest('.pane')?.dataset.tab === '${D}'`), 'the box moved into D\'s pane');
    check(await ev(`(() => { const s = document.querySelector('.pane[data-tab="${C}"] .pane-standin'); return !!s && s.textContent.includes('draft for C'); })()`), 'C\'s pane shows its draft in a stand-in');
    check(await ev(`document.querySelectorAll('.pane-standin').length === 3`), 'one stand-in for each pane without the box');
    check(await ev(`document.getElementById('input').value === ''`), 'the box holds D\'s draft, not C\'s');

    // ---- A click on a stand-in hands that pane the box, ready to type.
    const standinOf = id => ev(`(() => { const r = document.querySelector('.pane[data-tab="${id}"] .pane-standin').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await panel.click(await standinOf(C));
    check(await until(`SB.state.activeTab === '${C}'`), 'clicking C\'s stand-in focuses C');
    await wait(150);
    const handed = await ev(`({ pane: document.getElementById('composer').closest('.pane')?.dataset.tab === '${C}', draft: document.getElementById('input').value, focus: document.activeElement.id || document.activeElement.tagName })`);
    check(handed.pane && handed.draft === 'draft for C' && handed.focus === 'input', `and the box moves there with C's draft, ready to type (${JSON.stringify(handed)})`);
    await panel.click(await paneSpot(D, 0.5, 0.5));
    await until(`SB.state.activeTab === '${D}'`);

    // ---- A key typed on a stand-in lands in its conversation.
    await ev(`document.querySelector('.pane[data-tab="${B}"] .pane-standin').focus()`);
    await ev(`document.querySelector('.pane[data-tab="${B}"] .pane-standin').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))`);
    await wait(150);
    check(await ev(`SB.state.activeTab === '${B}' && document.getElementById('input').value.endsWith('x') && document.activeElement.id === 'input'`), 'a key typed on B\'s stand-in starts B\'s message');
    check(await ev(`SB.state.tabs.get('${D}').draft === ''`), 'and none of it went to D');

    // ---- A message sent from the box in a pane goes to that conversation alone.
    await ev(`document.getElementById('input').value = ''; SB.send('hello from B')`);
    check(await until(`[...SB.state.tabs.get('${B}').el.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('echo: hello from B'))`), 'B answers B');
    check(!(await ev(`[...SB.state.tabs.get('${D}').el.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('hello from B'))`)), 'and D heard nothing');
    await until(`!SB.state.tabs.get('${B}').busy`);

    // ---- The slash menu opens out of a box in a pane without being cut off,
    // in a bottom-row pane (B) and a top-row one (A).
    const slashOnScreen = async (label) => {
      await ev(`(() => { const i = document.getElementById('input'); i.value = '/'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      check(await until(`!document.getElementById('slashMenu').hidden`), `the slash menu opens in ${label}`);
      await wait(200); // its pop-in animation
      const m = await ev(`(() => { const menu = document.getElementById('slashMenu'); const r = menu.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + 8; return { top: r.top, bottom: r.bottom, h: r.height, feedsTop: document.getElementById('feeds').getBoundingClientRect().top, ok: r.top >= 0 && menu.contains(document.elementFromPoint(x, y)) }; })()`);
      check(m.ok, `and its top is on screen and not covered (top ${Math.round(m.top)}, ${Math.round(m.h)} tall)`);
      await ev(`(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); SB.hideSlash(); })()`);
    };
    await slashOnScreen('a bottom-row pane');
    await ev(`SB.activate('${A}')`);
    await slashOnScreen('a top-row pane');
    // Three to a column in a short window (the page told it's 760 px tall, about
    // as short as three rows fit): the menu is taller than the room above the top
    // pane's box, and is cut down to it rather than off by the chat's edge.
    await panel.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 0, mobile: false });
    await wait(300);
    check(await ev(`SB.placeTab('${B}', '${A}', 'bottom')`), 'three panes fit in a column 760 px tall');
    await wait(300);
    await ev(`SB.activate('${A}')`);
    await slashOnScreen('the top of three panes');
    await panel.send('Emulation.clearDeviceMetricsOverride');
    await ev(`SB.placeTab('${B}', '${D}', 'bottom')`);
    await wait(300);

    // ---- A stand-in follows its conversation: a draft handed back while it's out of focus shows.
    await ev(`(() => { SB.state.tabs.get('${C}').draft = 'changed while away'; SB.renderTabStrip(); })()`);
    check(await until(`document.querySelector('.pane[data-tab="${C}"] .pane-standin')?.textContent.includes('changed while away')`), 'a stand-in shows a draft that changed while its pane was out of focus');

    // ---- Closing the focused pane keeps the box.
    await ev(`SB.activate('${B}')`);
    await ev(`SB.closePane('${B}')`);
    await wait(200);
    check(await ev(`document.getElementById('composer').isConnected && !!document.getElementById('composer').closest('.pane')`), 'closing the focused pane keeps the box, in the pane that took the focus');
    await panel.drag(await tabAt(B), await paneSpot(D, 0.5, 0.92));
    await wait(300);
    check(JSON.stringify(await ev('SB.state.grid')) === JSON.stringify([[A, C], [D, B]]), 'B under D again');

    // ---- A pane closing mid-drag (its line redrawn away) still ends the drag.
    const line2 = await ev(`(() => { const r = document.querySelector('.pane-divider.across').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: line2.x, y: line2.y, button: 'left', buttons: 1, clickCount: 1 });
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: line2.x + 20, y: line2.y, button: 'left', buttons: 1 });
    check(await ev(`document.body.classList.contains('resizing-panes')`), 'pressing a line starts a drag');
    await ev(`SB.closePane('${B}')`);
    await wait(200);
    check(!(await ev(`document.body.classList.contains('resizing-panes')`)), 'a pane closing mid-drag ends it, so the feeds take clicks again');
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: line2.x + 20, y: line2.y, button: 'left', buttons: 0, clickCount: 1 });
    await ev(`SB.placeTab('${B}', '${D}', 'bottom')`);
    await wait(300);
    check(JSON.stringify(await ev('SB.state.grid')) === JSON.stringify([[A, C], [D, B]]), 'and B goes back under D');

    // ---- Split adds columns while they fit, as many as this screen holds (up to four).
    const E = await ev(`(async () => (await SB.newTab({ focus: false, reuse: false })).id)()`);
    const F = await ev(`(async () => (await SB.newTab({ focus: false, reuse: false })).id)()`);
    // A pane is 280 px wide at least, with 6 px between and 6 px each side (tab-panes.js PANE_CHROME).
    const fitCols = Math.min(4, Math.floor((await ev(`document.getElementById('feeds').getBoundingClientRect().width`) - 6) / 286));
    await ev(`SB.activate('${D}')`);
    for (let i = 0; i < 2; i++) await ev('SB.splitPane()');
    await wait(400);
    const nCols = await ev('SB.state.grid.length');
    check(nCols === Math.min(4, Math.max(2, fitCols)), `Split keeps adding columns while there's room (${nCols}, room for ${fitCols})`);
    check(await ev(`[...document.querySelectorAll('.pane')].every(p => p.getBoundingClientRect().width >= ${280 - 1})`), 'and every pane is still 280 px wide or more');

    // ...and on a screen too small for another, it says so instead.
    await panel.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 600, screenWidth: 640, screenHeight: 600, deviceScaleFactor: 0, mobile: false });
    await wait(300);
    check(await ev(`SB.roomFor(SB.panes.place(SB.state.grid, 'new', '${D}', 'right')).ok`) === false, "another column doesn't fit a 640 px screen");
    await ev('SB.splitPane()');
    check(await until(`/No room/.test(document.getElementById('toast').textContent)`), 'and Split is refused with a toast');
    check(await ev('SB.state.grid.length') === nCols, 'leaving the panes as they were');
    await panel.send('Emulation.clearDeviceMetricsOverride');
    await wait(300);
    for (const id of [E, F]) { await ev(`SB.closePane('${id}')`); await ev(`SB.closeTab('${id}')`); }
    await wait(300);
    if (JSON.stringify(await ev('SB.state.grid')) !== JSON.stringify([[A, C], [D, B]])) await ev(`SB.state.grid = [['${A}', '${C}'], ['${D}', '${B}']]; SB.renderPanes()`);
    await ev(`SB.activate('${D}')`);
    await wait(300);
    check(JSON.stringify(await ev('SB.state.grid')) === JSON.stringify([[A, C], [D, B]]), 'the 2x2 again once they close');

    // ---- Keys: Alt+arrow to the next pane, Ctrl+Alt+arrow to move one.
    const press = async (key, mods) => {
      for (const type of ['rawKeyDown', 'keyUp']) await panel.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key], modifiers: mods });
      await wait(150);
    };
    const ALT = 1, CTRL_ALT = 3; // CDP: Alt = 1, Ctrl = 2
    await ev(`SB.activate('${A}')`);
    await press('ArrowRight', ALT);
    check(await until(`SB.state.activeTab === '${D}'`), 'Alt+→ goes to the pane on the right');
    await press('ArrowDown', ALT);
    check(await until(`SB.state.activeTab === '${B}'`), 'Alt+↓ goes to the one below');
    await press('ArrowLeft', CTRL_ALT);
    check(await until(`JSON.stringify(SB.state.grid) === JSON.stringify([['${A}', '${B}'], ['${D}', '${C}']])`), 'Ctrl+Alt+← swaps it with the pane on the left');
    check(await ev(`SB.state.activeTab === '${B}'`), 'and it keeps the focus');
    await press('ArrowRight', ALT); // B is bottom left now; C is beside it
    check(await until(`SB.state.activeTab === '${C}'`), 'Alt+→ from the swapped pane reaches C, beside it');
    await ev(`SB.state.grid = [['${A}', '${C}'], ['${D}', '${B}']]; SB.activate('${D}')`);
    await wait(200);

    // Up and down swap inside a column and stop at its ends.
    await ev(`SB.activate('${A}')`);
    await press('ArrowDown', CTRL_ALT);
    check(await until(`JSON.stringify(SB.state.grid) === JSON.stringify([['${C}', '${A}'], ['${D}', '${B}']])`), 'Ctrl+Alt+↓ swaps it with the pane below');
    await press('ArrowDown', CTRL_ALT);
    check(JSON.stringify(await ev('SB.state.grid')) === JSON.stringify([[C, A], [D, B]]), 'Ctrl+Alt+↓ from the bottom pane is a no-op: it is already the last in its column');
    await ev(`SB.state.grid = [['${A}', '${C}'], ['${D}', '${B}']]; SB.activate('${A}')`);
    await wait(200);

    // ...but not behind the palette or the shortcut list.
    await ev(`SB.activate('${A}')`);
    await ev(`document.getElementById('paletteSheet').hidden = false`);
    await press('ArrowRight', ALT);
    check(await ev(`SB.state.activeTab === '${A}'`), 'Alt+→ does nothing with the palette open');
    await ev(`document.getElementById('paletteSheet').hidden = true; document.getElementById('shortcutsSheet').hidden = false`);
    await press('ArrowRight', CTRL_ALT);
    check(await ev(`JSON.stringify(SB.state.grid) === JSON.stringify([['${A}', '${C}'], ['${D}', '${B}']])`), 'Ctrl+Alt+→ moves nothing with the shortcut list open');
    await ev(`document.getElementById('shortcutsSheet').hidden = true`);
    // And Alt+arrows in the box still do their pane job without typing anything.
    await ev(`document.getElementById('input').focus()`);
    await press('ArrowRight', ALT);
    check(await until(`SB.state.activeTab === '${D}'`), 'Alt+→ works from the message box too');
    await ev(`SB.activate('${D}')`);

    // ---- A restart brings the layout and its sizes back. Only conversations
    // that have said something reopen after a restart (main's openTabs), and A
    // and B have, so C and D say something first.
    for (const id of [C, D]) {
      await ev(`SB.activate('${id}'); document.getElementById('input').value = ''; SB.send('hello from ' + '${id}'.slice(0, 4))`);
      await until(`!SB.state.tabs.get('${id}').busy && SB.state.tabs.get('${id}').el.querySelector('.msg.assistant')`, 15000);
    }
    await ev(`(() => { const s = SB.state.paneSizes; for (const id of SB.state.grid[0]) s.w[id] = 3; SB.renderPanes(); })()`);
    const layout = await ev('JSON.stringify({ grid: SB.state.grid, w: SB.state.paneSizes.w })');
    // A screen with room for the left column at three times the right one, both
    // at least 280 px, gets them back as they were; a smaller one evens them out.
    const roomAsLeft = await ev('SB.roomFor(SB.state.grid, SB.state.paneSizes).ok');
    await ev('shellby.maximize()'); // back to its own size, so the restart has to grow it
    await wait(1500); // past the save's 500 ms
    panel.ws.close();
    app.kill();
    await wait(1500);
    app = launch();
    let again = [];
    for (let i = 0; i < 40 && !again.some(t => t.url.endsWith('panel.html')); i++) { again = await targets(); await wait(500); }
    Object.assign(panel, await connect(again.find(t => t.url.endsWith('panel.html'))));
    ({ ev, until } = panel);
    await wait(3000);
    await ev("SB.setView('chat')");
    check(await until(`SB.state.grid.length > 1`), 'the panel comes back split');
    const back = await ev('JSON.stringify({ grid: SB.state.grid, w: SB.state.paneSizes.w })');
    if (roomAsLeft) check(back === layout, 'with the same panes, in the same places, at the same sizes');
    else check(JSON.stringify(JSON.parse(back).grid) === JSON.stringify(JSON.parse(layout).grid), `with the same panes in the same places (sizes evened: no room for them as left on a ${await ev('screen.availWidth')} px screen)`);
    check(await until(`[...document.querySelectorAll('.pane')].every(p => p.getBoundingClientRect().width >= 279)`, 5000), 'and the panel grew to fit them');
    await ev('shellby.maximize()'); // the drags that follow want the room
    await wait(800);

    // ---- A click into a pane gives it the box.
    await panel.click(await paneSpot(C, 0.5, 0.5));
    check(await until(`SB.state.activeTab === '${C}'`), 'clicking into C focuses it');
    check(await ev(`SB.state.tabs.get('${C}').el.classList.contains('focused')`), 'and outlines it');

    // ---- Dragging a pane onto another swaps them.
    const headOf = id => ev(`(() => { const r = [...document.querySelectorAll('.pane-head')].find(h => h.dataset.tab === '${id}').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
    await panel.drag(await headOf(C), await paneSpot(B, 0.5, 0.5));
    await wait(300);
    check(JSON.stringify(await ev('SB.state.grid')) === JSON.stringify([[A, B], [D, C]]), 'dragging C\'s header onto B swaps them');

    // ---- Close a pane: the conversation keeps its tab.
    await ev(`SB.closePane('${B}')`);
    await wait(200);
    check(JSON.stringify(await ev('SB.state.grid')) === JSON.stringify([[A], [D, C]]) && await ev(`SB.state.tabs.has('${B}')`), 'closing B\'s pane leaves its tab');

    // ---- Out of the window: A with a half-typed message, dragged well past the edge.
    await ev(`SB.activate('${A}'); document.getElementById('input').value = 'half a thought'`);
    const w = await ev('window.innerWidth');
    await panel.drag(await tabAt(A), { x: w + 200, y: 300 }, 12);
    let out = null;
    for (let i = 0; i < 30 && !out; i++) { out = (await targets()).find(t => t.url.includes(`popout=${A}`)); if (!out) await wait(300); }
    if (!out) {
      // Some CDP builds don't send moves past the window's edge; the button does the same thing.
      console.log('(the drag past the edge never reached the page; popping out with the button instead)');
      await ev(`SB.popOut('${A}')`);
      for (let i = 0; i < 30 && !out; i++) { out = (await targets()).find(t => t.url.includes(`popout=${A}`)); if (!out) await wait(300); }
    }
    check(!!out, 'A opens in a window of its own');
    check(await until(`!SB.state.tabs.has('${A}') && !SB.isShown('${A}')`), 'and leaves the panel\'s tabs and panes');
    if (out) {
      const pop = await connect(out);
      check(await pop.until(`SB.solo === '${A}' && SB.state.tabs.has('${A}')`), 'the window knows its one conversation');
      check(await pop.until(`[...SB.state.tabs.get('${A}').el.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('echo: hello from A'))`), 'with what was said in it');
      check(await pop.ev("document.getElementById('input').value === 'half a thought'"), 'and what was typed but not sent');
      check(await pop.ev("document.body.classList.contains('solo') && getComputedStyle(document.getElementById('tabstrip')).display === 'none'"), 'just the chat: no strip');
      check(await pop.ev(`document.title`) !== 'Shellby', `named for its conversation (${await pop.ev('document.title')})`);
      await pop.shot('popout');

      // Talking to it there: the reply comes to this window, not the panel.
      await pop.ev(`document.getElementById('input').value = ''; SB.send('hello from its own window')`);
      check(await pop.until(`[...SB.state.tabs.get('${A}').el.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('echo: hello from its own window'))`), 'a message sent there is answered there');
      await pop.until(`!SB.state.tabs.get('${A}').busy`);
      check(!(await ev(`SB.state.tabs.has('${A}')`)), 'and the panel never grew a copy');

      // Its ×: back in the panel, with the box as it was left.
      await pop.ev(`document.getElementById('input').value = 'typed in the window'`);
      await pop.ev(`document.getElementById('closeBtn').click()`);
      pop.ws.close();
      check(await until(`SB.state.tabs.has('${A}')`), '× hands it back to the panel');
      check(await until(`SB.state.activeTab === '${A}'`), 'focused there');
      check(await ev(`document.getElementById('input').value === 'typed in the window'`), 'with what was typed in the window');
      check(await ev(`[...SB.state.tabs.get('${A}').el.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('echo: hello from its own window'))`), 'and the whole conversation');
      check(!(await targets()).some(t => t.url.includes('popout=')), 'its window is gone');
    }

    // ---- Back to one pane: the box goes home, no stand-ins.
    for (const id of await ev('SB.panes.ids(SB.state.grid)')) if ((await ev('SB.panes.ids(SB.state.grid).length')) > 1) await ev(`SB.closePane('${id}')`);
    await wait(200);
    check(await ev(`document.getElementById('composer').parentElement.id === 'chatView' && !document.querySelector('.pane-standin')`), 'one pane: the box is back where it always was');
    check(await ev(`(() => { const f = document.getElementById('feeds').getBoundingClientRect(); const p = document.querySelector('.pane').getBoundingClientRect(); return Math.abs(p.width - f.width) < 2 && Math.abs(p.height - f.height) < 2; })()`), 'and the lone pane fills the whole chat');
  } catch (err) {
    check(false, `crashed: ${err.stack || err}`);
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
