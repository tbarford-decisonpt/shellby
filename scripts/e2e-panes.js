// ci: split panes: side by side up to twelve, tabs and a box in each, sizes, a saved layout, windows of their own
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
    // The grid as each pane shows it (its active tab), the shape the checks
    // compare. PID(x): the pane x is in, as an expression for ev. setShape:
    // back to one pane per conversation laid out as `cols`, after a step that
    // moved things about (or failed).
    const shape = async () => JSON.stringify(await ev('SB.state.grid.map(col => col.map(p => p.active))'));
    const isShape = async want => (await shape()) === JSON.stringify(want);
    const PID = id => `SB.panes.paneWith(SB.state.grid, '${id}').id`;
    const setShape = cols => ev(`(() => { let n = 0; SB.state.grid = ${JSON.stringify(cols)}.map(col => col.map(id => ({ id: 'p' + (++n), tabs: [id], active: id }))); SB.renderPanes(); SB.renderTabStrip(); })()`);
    await ev(`SB.send('hello from A')`);
    check(await until(`[...SB.state.tabs.get('${A}').el.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('echo: hello from A'))`), 'A has a reply');
    await until(`!SB.state.tabs.get('${A}').busy`);

    // ---- Split: the one pane holds all four, so the focused tab (D) goes into a pane of its own beside it.
    // Asked for from another view with the shortcut: the chat comes back, and is
    // measured as it shows, not as the hidden 0 x 0 it was.
    const chromeW = startWidth - await ev(`document.getElementById('feeds').getBoundingClientRect().width`);
    await ev(`SB.activate('${D}')`);
    await ev("SB.setView('settings')");
    await wait(300);
    for (const type of ['keyDown', 'keyUp']) await panel.send('Input.dispatchKeyEvent', { type, key: '\\', code: 'Backslash', windowsVirtualKeyCode: 220, modifiers: 2 });
    check(await until('SB.state.grid.length === 2'), 'Ctrl+\\ from Settings splits');
    check(await ev("SB.state.view === 'chat'"), 'and shows the chat');
    await wait(300);
    const split = await ev(`(() => {
      const r = id => SB.state.tabs.get(id).el.getBoundingClientRect();
      const shown = [...SB.state.tabs.values()].filter(t => !t.el.hidden).map(t => t.id);
      return { grid: SB.state.grid.map(col => col.map(p => p.active)), shown, panes: document.getElementById('feeds').dataset.panes,
        cLeftOfD: r('${C}').right <= r('${D}').left + 1, heads: [...document.querySelectorAll('.pane-head')].filter(h => h.offsetHeight).length };
    })()`);
    check(JSON.stringify(split.grid) === JSON.stringify([[C], [D]]), `Split takes D into a pane of its own; the other shows the tab next to where it was: ${JSON.stringify(split.grid)}`);
    check(split.shown.length === 2 && split.panes === '2' && split.cLeftOfD, 'both show, side by side');
    check(split.heads === 2, 'each pane has its header once there are two');
    check(await ev(`SB.state.activeTab === '${D}' && document.getElementById('input').placeholder.includes('"')`), 'the new pane has the focus, and the box says which');
    await panel.shot('split');

    // Two columns need 2 x 286 + 6 px of chat; a 460 px panel can't hold that, so it must have grown.
    const grownTo = await ev('window.innerWidth');
    check(startWidth >= 700 || grownTo > startWidth, `the panel grew to fit two panes (${startWidth} -> ${grownTo})`);
    check(grownTo <= Math.max(startWidth, 2 * 286 + 6 + chromeW + 2), `and no wider than they need (${grownTo})`);
    check(await ev(`[...document.querySelectorAll('.pane')].every(p => p.getBoundingClientRect().width >= ${280 - 1})`), 'no pane narrower than 280 px');
    // The left pane shows A from here on. The box moving to another pane leaves
    // a stand-in where it was, which comes in still: nothing slides past the
    // chat's foot and puts a scrollbar on it, a frame or ten narrowing every pane.
    const barFrames = await ev(`(async () => {
      SB.activate('${A}'); SB.activate('${D}');
      const home = document.getElementById('chatView');
      let n = 0;
      for (let i = 0; i < 12; i++) { if (home.offsetWidth > home.clientWidth) n++; await new Promise(requestAnimationFrame); }
      return n;
    })()`);
    check(barFrames === 0, `the box moving to another pane never puts a scrollbar on the chat (${barFrames} of 12 frames had one)`);

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
      await ev('SB.closeTab(SB.state.grid[2][0].active)'); // the new conversation, and with it its pane
      await wait(300);
    }
    check(await isShape([[A], [D]]), 'back to A beside D');
    await ev(`SB.activate('${D}')`);
    await ev('shellby.maximize()'); // room for the 2x2 grid the drags below make
    await wait(800);

    // ---- Drag a tab from the strip onto the bottom of a pane: that column splits.
    // A tab in whichever strip shows it: the top one with one pane, its pane's
    // while split. Only one strip ever holds a tab (the rest are emptied), so the first match is it.
    const tabAt = id => ev(`(() => { const r = [...document.querySelectorAll('.tabs [data-tab-id]')].find(e => e.dataset.tabId === '${id}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const paneSpot = (id, fx, fy) => ev(`(() => { const r = SB.state.tabs.get('${id}').el.getBoundingClientRect(); return { x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy} }; })()`);
    await panel.drag(await tabAt(C), await paneSpot(A, 0.5, 0.92));
    await wait(300);
    check(await isShape([[A, C], [D]]), 'C dragged from A\'s strip to the foot of A\'s pane splits off under it');
    check(await ev("document.getElementById('dropHint').hidden"), 'the drop preview goes away on letting go');

    // ...and the last one under D: a full 2x2 grid.
    await panel.drag(await tabAt(B), await paneSpot(D, 0.5, 0.92));
    await wait(300);
    const quad = await ev(`(() => {
      const r = id => SB.state.tabs.get(id).el.getBoundingClientRect();
      const [a, b, c, d] = ['${A}', '${B}', '${C}', '${D}'].map(r);
      return { grid: SB.state.grid.map(col => col.map(p => p.active)), grid2x2: a.right <= d.left + 1 && a.bottom <= c.top + 1 && d.bottom <= b.top + 1 && Math.abs(a.top - d.top) < 2 };
    })()`);
    check(JSON.stringify(quad.grid) === JSON.stringify([[A, C], [D, B]]), `four panes: ${JSON.stringify(quad.grid)}`);
    check(quad.grid2x2, 'laid out two by two');
    check(await ev(`SB.panes.zones(SB.state.grid, ${PID(A)}, 'x').includes('right')`), 'a 2x2 can still take another column');
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
    check(await ev(`(() => { const s = SB.state.paneSizes; return s.w[${PID(A)}] > s.w[${PID(D)}]; })()`), 'and the sizes say so, by pane');
    await ev(`document.querySelector('.pane-divider.across').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await wait(200);
    const evened = await colRects();
    check(Math.abs(evened[0].width - evened[1].width) < 3, 'a double-click evens them out');

    // ---- A feed scrolled up keeps its place when the grid changes around it.
    await ev(`(() => { const t = SB.state.tabs.get('${A}'); for (let i = 0; i < 80; i++) t.render({ kind: 'text', text: 'filler line ' + i }, { replay: true }); })()`);
    await ev(`(() => { const el = SB.state.tabs.get('${A}').el; el.scrollTop = 40; el.dispatchEvent(new Event('scroll')); })()`);
    await wait(150);
    await ev(`SB.closePane(${PID(B)})`);
    await wait(300);
    check(await ev(`SB.state.tabs.get('${A}').el.scrollTop`) === 40, 'a scrolled-up feed keeps its place when a pane closes');
    // D was half its column; alone now, it takes the whole column (sizes are normalized).
    check(await ev(`(() => { const p = document.querySelector('.pane[data-tab="${D}"]').getBoundingClientRect(); const c = document.querySelector('.pane[data-tab="${D}"]').parentElement.getBoundingClientRect(); return p.height > c.height - 20; })()`), 'D fills its column once B\'s pane closes');
    await panel.drag(await tabAt(B), await paneSpot(D, 0.5, 0.92));
    await wait(300);
    check(await isShape([[A, C], [D, B]]), 'B back under D');

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
    check(await ev(`SB.placeTab('${B}', ${PID(A)}, 'bottom')`), 'three panes fit in a column 760 px tall');
    await wait(300);
    await ev(`SB.activate('${A}')`);
    await slashOnScreen('the top of three panes');
    // A busy box in a pane that short: the Working bar and Claude's to-do list,
    // opened, are taller than the pane has room for. The box stays inside its
    // pane (the list scrolls), its input row shows, and the feed keeps a few lines.
    await ev(`SB.send('todos')`);
    check(await until(`!document.getElementById('todos').hidden && !SB.state.tabs.get('${A}').busy`), 'a to-do list in the top pane\'s box');
    await ev(`SB.send('wait 6000')`);
    check(await until(`!document.getElementById('status').hidden`), 'and the Working bar with it');
    await wait(300);
    const busyBox = await ev(`(() => {
      const pane = document.querySelector('.pane[data-tab="${A}"]').getBoundingClientRect();
      // Everything in the box that takes up room (the menus are absolute), down to its last line.
      const parts = [...document.getElementById('composer').children].filter(el => getComputedStyle(el).position !== 'absolute' && el.getClientRects().length);
      const bottom = Math.max(...parts.map(el => el.getBoundingClientRect().bottom));
      const row = document.getElementById('form').getBoundingClientRect();
      const bar = document.getElementById('status').getBoundingClientRect();
      const feed = SB.state.tabs.get('${A}').el.getBoundingClientRect();
      return { pane: Math.round(pane.height), paneTop: Math.round(pane.top), paneBottom: Math.round(pane.bottom), boxBottom: Math.round(bottom), rowBottom: Math.round(row.bottom), barTop: Math.round(bar.top), feed: Math.round(feed.height) };
    })()`);
    check(busyBox.boxBottom <= busyBox.paneBottom + 1 && busyBox.rowBottom <= busyBox.paneBottom + 1, `a busy box stays inside its pane, input row and all (${JSON.stringify(busyBox)})`);
    check(busyBox.barTop >= busyBox.paneTop, 'and the Working bar shows');
    check(busyBox.feed >= 40, `and the feed above it keeps a few lines (${busyBox.feed} px)`);
    await panel.shot('busy-box');
    await until(`!SB.state.tabs.get('${A}').busy`, 15000);
    await ev(`SB.send('todos done')`);
    await until(`!SB.state.tabs.get('${A}').busy && document.getElementById('todos').hidden`);
    await panel.send('Emulation.clearDeviceMetricsOverride');
    await ev(`SB.placeTab('${B}', ${PID(D)}, 'bottom')`);
    await wait(300);

    // ---- A stand-in follows its conversation: a draft handed back while it's out of focus shows.
    await ev(`(() => { SB.state.tabs.get('${C}').draft = 'changed while away'; SB.renderTabStrip(); })()`);
    check(await until(`document.querySelector('.pane[data-tab="${C}"] .pane-standin')?.textContent.includes('changed while away')`), 'a stand-in shows a draft that changed while its pane was out of focus');

    // ---- Closing the focused pane keeps the box.
    await ev(`SB.activate('${B}')`);
    await ev(`SB.closePane(${PID(B)})`);
    await wait(200);
    check(await ev(`document.getElementById('composer').isConnected && !!document.getElementById('composer').closest('.pane')`), 'closing the focused pane keeps the box, in the pane that took the focus');
    await panel.drag(await tabAt(B), await paneSpot(D, 0.5, 0.92));
    await wait(300);
    check(await isShape([[A, C], [D, B]]), 'B under D again');

    // ---- A pane closing mid-drag (its line redrawn away) still ends the drag.
    const line2 = await ev(`(() => { const r = document.querySelector('.pane-divider.across').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: line2.x, y: line2.y, button: 'left', buttons: 1, clickCount: 1 });
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: line2.x + 20, y: line2.y, button: 'left', buttons: 1 });
    check(await ev(`document.body.classList.contains('resizing-panes')`), 'pressing a line starts a drag');
    await ev(`SB.closePane(${PID(B)})`);
    await wait(200);
    check(!(await ev(`document.body.classList.contains('resizing-panes')`)), 'a pane closing mid-drag ends it, so the feeds take clicks again');
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: line2.x + 20, y: line2.y, button: 'left', buttons: 0, clickCount: 1 });
    await ev(`SB.placeTab('${B}', ${PID(D)}, 'bottom')`);
    await wait(300);
    check(await isShape([[A, C], [D, B]]), 'and B goes back under D');

    // ---- Split adds columns while they fit, as many as this screen holds (up to four).
    // D's pane holds only D, so each Split starts a new conversation in a pane of its own.
    const had = await ev('JSON.stringify([...SB.state.tabs.keys()])');
    // A pane is 280 px wide at least, with 6 px between and 6 px each side (pane-room.js PANE_CHROME).
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
    check(await ev(`SB.roomFor(SB.panes.place(SB.state.grid, 'new', ${PID(D)}, 'right')).ok`) === false, "another column doesn't fit a 640 px screen");
    await ev('SB.splitPane()');
    check(await until(`/No room/.test(document.getElementById('toast').textContent)`), 'and Split is refused with a toast');
    check(await ev('SB.state.grid.length') === nCols, 'leaving the panes as they were');
    await panel.send('Emulation.clearDeviceMetricsOverride');
    await wait(300);
    for (const id of await ev(`[...SB.state.tabs.keys()].filter(id => !${had}.includes(id))`)) await ev(`SB.closeTab('${id}')`);
    await wait(300);
    const quadAgain = await isShape([[A, C], [D, B]]);
    check(quadAgain, 'the 2x2 again once they close');
    // Only to keep going after that failure: the steps below start from the 2x2.
    if (!quadAgain) await setShape([[A, C], [D, B]]);
    await ev(`SB.activate('${D}')`);
    await wait(300);

    // ---- Tabs in a pane: each pane has a strip of its own tabs, and the top strip hides.
    const strips = await ev(`({ top: getComputedStyle(document.getElementById('tabstrip')).display, topTabs: document.querySelectorAll('#tabs .tab').length,
      perPane: [...document.querySelectorAll('.pane')].map(p => [...p.querySelectorAll('.pane-head .tab')].map(t => t.dataset.tabId)) })`);
    check(strips.top === 'none' && strips.topTabs === 0, 'split, the top strip hides');
    check(strips.perPane.length === 4 && strips.perPane.every(s => s.length === 1), `each pane has a strip of its own tabs (${JSON.stringify(strips.perPane)})`);
    check(await ev(`(() => { const b = document.getElementById('tabAllBtn'); return b.parentElement.id === 'subbar' && !b.hidden; })()`), 'Every conversation sits at the end of the bar under it');

    // A new conversation opens in the focused pane, after the tab it shows.
    await ev(`SB.activate('${D}')`);
    const G1 = await ev(`(async () => (await SB.newTab({ reuse: false })).id)()`);
    check(await ev(`JSON.stringify(SB.panes.paneWith(SB.state.grid, '${G1}').tabs) === JSON.stringify(['${D}', '${G1}']) && SB.state.activeTab === '${G1}'`), 'a new conversation opens in the focused pane, after its tab');
    check(await ev(`[...document.querySelector('.pane[data-tab="${G1}"]').querySelectorAll('.pane-head .tab')].map(t => t.dataset.tabId).join() === ['${D}', '${G1}'].join()`), 'and that pane\'s strip shows both');

    // A tab clicked in an unfocused pane shows there and focuses it.
    // Its strip wired a second time first (as a rebuild that made it again would): still one click, not a rename.
    await ev(`(() => { const s = SB.paneStripOf(${PID(D)}); SB.wireStrip(s); SB.watchEdges(s, s.parentElement.querySelector('.tab-edge.left'), s.parentElement.querySelector('.tab-edge.right')); })()`);
    await ev(`SB.activate('${A}')`);
    await panel.click(await tabAt(D));
    check(await until(`SB.state.activeTab === '${D}'`), 'a tab clicked in an unfocused pane focuses that pane');
    check(await ev(`!!document.querySelector('.pane[data-tab="${D}"]')?.contains(document.getElementById('composer'))`), 'and shows there, with the box');
    check(await ev('!document.querySelector(\'.title-edit\')'), 'and opens no rename: a strip is wired once, however often it\'s asked');

    // One that turns up without being opened here (main's, a pop-out back) joins the focused pane.
    const H1 = await ev(`(async () => (await SB.newTab({ focus: false, reuse: false })).id)()`);
    await ev('SB.renderTabStrip()');
    check(await ev(`SB.panes.paneWith(SB.state.grid, '${H1}')?.id === SB.focusedPane()`), 'a conversation that turns up without being opened here joins the focused pane');

    // Closing the tab an unfocused pane shows: its neighbour shows there, and the focus stays put.
    await ev(`SB.activate('${H1}'); SB.activate('${A}')`);
    await ev(`SB.closeTab('${H1}')`);
    await wait(200);
    check(await ev(`SB.state.activeTab === '${A}' && SB.panes.paneWith(SB.state.grid, '${G1}').active === '${G1}'`), 'closing the tab an unfocused pane shows: its neighbour shows there, the focus stays');

    // Picking a tab in Every conversation focuses its pane.
    await ev('SB.openTabList()');
    await ev(`document.getElementById('tl-${B}').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
    check(await until(`SB.state.activeTab === '${B}' && !!document.querySelector('.pane[data-tab="${B}"]')?.contains(document.getElementById('composer'))`), 'picking a tab in Every conversation focuses its pane');

    // A pane's x moves its tabs into the pane beside it: D's pane (top right) into B's, below it.
    await ev(`SB.closePane(${PID(D)})`);
    await wait(200);
    check(await ev(`JSON.stringify(SB.panes.paneWith(SB.state.grid, '${B}').tabs) === JSON.stringify(['${D}', '${G1}', '${B}']) && SB.state.tabs.has('${G1}')`), 'a pane\'s × moves its tabs into the pane beside it, closing none');

    // Split takes the focused tab into a pane of its own when its pane holds others.
    await ev(`SB.activate('${D}')`);
    await ev('SB.splitPane()');
    check(await until(`SB.panes.paneWith(SB.state.grid, '${D}')?.tabs.length === 1 && SB.panes.count(SB.state.grid) === 4`), 'Split takes the focused tab into a new pane when its pane holds others');

    // A focused tab taken away under the panes, the way a folder change does it
    // (tab-chips.js; a History delete does the same): its replacement opens in that pane.
    const K1 = await ev(`(async () => (await SB.newTab({ reuse: false })).id)()`);
    const kPane = await ev(PID(K1));
    const K2 = await ev(`(async () => { const tab = SB.activeTab(); await SB.api.closeTab(tab.id); tab.destroy(); SB.state.tabs.delete(tab.id); SB.state.activeTab = null; return (await SB.newTab()).id; })()`);
    await ev('SB.renderTabStrip()');
    check(await ev(`SB.panes.paneWith(SB.state.grid, '${K2}')?.id === '${kPane}' && SB.state.activeTab === '${K2}' && SB.panes.count(SB.state.grid) === 4`), 'a focused tab taken away under the panes: its replacement opens in the same pane, which stays');
    await ev(`SB.closeTab('${K2}')`);
    await ev(`SB.closeTab('${G1}')`);
    await setShape([[A, C], [D, B]]);
    await ev(`SB.activate('${D}')`);
    await wait(300);

    // ---- A tab dragged onto a pane's strip joins that pane where it's dropped.
    const stripStart = id => ev(`(() => { const t = document.querySelector('.pane[data-tab="${id}"] .pane-tabs .tab').getBoundingClientRect(); return { x: t.left + 4, y: t.top + t.height / 2 }; })()`);
    await panel.drag(await tabAt(C), await stripStart(D));
    await wait(300);
    check(await ev(`JSON.stringify(SB.panes.paneWith(SB.state.grid, '${C}').tabs) === JSON.stringify(['${C}', '${D}'])`), 'C dropped at the front of D\'s strip joins D\'s pane there');
    check(await ev(`SB.panes.count(SB.state.grid) === 3 && SB.state.activeTab === '${C}'`), 'its own pane, left empty, closes, and C shows where it landed');
    // ...and along its own pane's strip it only moves.
    await panel.drag(await tabAt(D), await stripStart(C));
    await wait(300);
    check(await ev(`JSON.stringify(SB.panes.paneWith(SB.state.grid, '${D}').tabs) === JSON.stringify(['${D}', '${C}'])`), 'a tab dragged along its own pane\'s strip reorders it');
    check(await ev("!document.body.classList.contains('reordering') && document.getElementById('dropHint').hidden"), 'and leaves no drag behind');

    // ---- Onto the middle of a pane: it joins at the end and shows there. Onto an edge: a pane of its own.
    await panel.drag(await tabAt(C), await paneSpot(A, 0.5, 0.5));
    await wait(300);
    check(await ev(`(() => { const p = SB.panes.paneWith(SB.state.grid, '${A}'); return JSON.stringify(p.tabs) === JSON.stringify(['${A}', '${C}']) && p.active === '${C}'; })()`), 'C dropped on the middle of A\'s pane joins it at the end, and shows there');
    await panel.drag(await tabAt(C), await paneSpot(C, 0.5, 0.92));
    await wait(300);
    check(await isShape([[A, C], [D, B]]) && await ev(`SB.panes.paneWith(SB.state.grid, '${A}').tabs.length === 1`), 'C dragged to the foot of its pane splits off under it: the 2x2 again');

    // ---- Renaming a tab in one pane's strip survives a redraw for another pane's working tab.
    await ev(`SB.renameTab('${C}')`);
    check(await ev("!!document.querySelector('.pane-tabs .title-edit')"), 'F2 opens the name in place, in its pane\'s strip');
    await ev(`(() => { const b = SB.state.tabs.get('${B}'); b.busy = true; SB.renderTabStrip(); b.busy = false; })()`);
    check(await ev("!!document.activeElement?.classList.contains('title-edit')"), 'a redraw for another pane\'s working tab leaves the name being typed alone');
    await ev(`document.querySelector('.title-edit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    check(await until("!document.querySelector('.title-edit')"), 'Escape puts the name back');

    // ---- A pane closing while a tab is dragged over it: letting go does nothing, and leaves no drag behind.
    const from = await tabAt(A);
    const over = await paneSpot(D, 0.5, 0.5);
    await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((over.x - from.x) * i) / 6, y: from.y + ((over.y - from.y) * i) / 6, button: 'left', buttons: 1 });
      await wait(30);
    }
    check(await ev("document.body.classList.contains('reordering') && !document.getElementById('dropHint').hidden"), 'A is being dragged over D\'s pane');
    await ev(`SB.closePane(${PID(D)})`);
    await wait(150);
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: over.x, y: over.y, button: 'left', buttons: 0, clickCount: 1 });
    await wait(300);
    check(await ev("!document.body.classList.contains('reordering') && document.getElementById('dropHint').hidden && !document.querySelector('.tab.dragging')"), 'letting go after the pane under it closed ends the drag cleanly');
    check(await ev(`SB.state.tabs.has('${A}') && JSON.stringify(SB.panes.paneWith(SB.state.grid, '${A}').tabs) === JSON.stringify(['${A}'])`), 'and A stays where it was: a drop on a pane that has gone is refused');
    await setShape([[A, C], [D, B]]);
    await ev(`SB.activate('${D}')`);
    await wait(300);

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
    check(await until(`JSON.stringify(SB.panes.paneWith(SB.state.grid, '${B}').tabs) === JSON.stringify(['${C}', '${B}'])`), 'Ctrl+Alt+← moves it into the pane on the left, after its tabs');
    check(await isShape([[A, B], [D]]) && await ev(`SB.state.activeTab === '${B}'`), 'its own pane closes; it shows where it went and keeps the focus');
    await press('ArrowRight', ALT); // B is bottom left now; D has the whole right column
    check(await until(`SB.state.activeTab === '${D}'`), 'Alt+→ from there reaches D, beside it');
    await setShape([[A, C], [D, B]]);
    await ev(`SB.activate('${D}')`);
    await wait(200);

    // Up and down swap inside a column and stop at its ends.
    await ev(`SB.activate('${A}')`);
    await press('ArrowDown', CTRL_ALT);
    check(await until(`JSON.stringify(SB.panes.paneWith(SB.state.grid, '${A}').tabs) === JSON.stringify(['${C}', '${A}'])`), 'Ctrl+Alt+↓ moves it into the pane below');
    await press('ArrowDown', CTRL_ALT);
    check(await isShape([[A], [D, B]]), 'Ctrl+Alt+↓ again does nothing: its pane is the last in its column');
    await setShape([[A, C], [D, B]]);
    await ev(`SB.activate('${A}')`);
    await wait(200);

    // ...but not behind the palette or the shortcut list.
    await ev(`SB.activate('${A}')`);
    await ev(`document.getElementById('paletteSheet').hidden = false`);
    await press('ArrowRight', ALT);
    check(await ev(`SB.state.activeTab === '${A}'`), 'Alt+→ does nothing with the palette open');
    await ev(`document.getElementById('paletteSheet').hidden = true; document.getElementById('shortcutsSheet').hidden = false`);
    await press('ArrowRight', CTRL_ALT);
    check(await isShape([[A, C], [D, B]]), 'Ctrl+Alt+→ moves nothing with the shortcut list open');
    await ev(`document.getElementById('shortcutsSheet').hidden = true`);
    // And Alt+arrows in the box still do their pane job without typing anything.
    await ev(`document.getElementById('input').focus()`);
    await press('ArrowRight', ALT);
    check(await until(`SB.state.activeTab === '${D}'`), 'Alt+→ works from the message box too');
    await ev(`SB.activate('${D}')`);

    // Alt+↑ from an empty box with a message queued moves to the pane above and
    // leaves the queue alone (a bare ↑ there pulls the message back to edit it).
    await ev(`SB.activate('${C}'); document.getElementById('input').value = ''; SB.send('wait 4000')`);
    await until(`SB.state.tabs.get('${C}').busy`);
    await ev(`SB.send('held back')`);
    check(await ev(`SB.state.tabs.get('${C}').queue.length === 1`), 'a message queued behind C\'s turn');
    await ev(`(() => { const i = document.getElementById('input'); i.value = ''; i.focus(); })()`);
    await press('ArrowUp', ALT);
    const queueKept = await ev(`({ active: SB.state.activeTab === '${A}', queue: SB.state.tabs.get('${C}').queue.length, draft: SB.state.tabs.get('${C}').draft || '' })`);
    check(queueKept.active, 'Alt+↑ from C\'s empty box goes to A, above it');
    check(queueKept.queue === 1 && queueKept.draft === '', `and C's queued message stays queued, not pulled into its draft (${JSON.stringify(queueKept)})`);
    await until(`!SB.state.tabs.get('${C}').busy && !SB.state.tabs.get('${C}').queue.length`, 20000);
    await until(`!SB.state.tabs.get('${C}').busy`, 10000);

    // ---- A button at the bottom of a pane out of focus takes the click that
    // focuses it: the box moving in for the stand-in doesn't shift it away.
    await ev(`SB.activate('${B}')`);
    await ev(`(() => { const t = SB.state.tabs.get('${B}'); for (let i = 0; i < 80; i++) t.render({ kind: 'text', text: 'filler line ' + i }, { replay: true }); })()`);
    await ev(`document.getElementById('input').value = ''; SB.send('tool please')`);
    check(await until(`!!SB.state.tabs.get('${B}').el.querySelector('.btn.allow')`), 'B asks to use a tool');
    await ev(`SB.activate('${D}')`);
    await wait(300);
    await ev(`SB.state.tabs.get('${B}').scrollToEnd()`);
    await wait(300);
    const allowAt = await ev(`(() => { const r = [...SB.state.tabs.get('${B}').el.querySelectorAll('.btn.allow')].pop().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    // A person's press and release, a moment apart.
    await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: allowAt.x, y: allowAt.y, button: 'left', buttons: 1, clickCount: 1 });
    await wait(120);
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: allowAt.x, y: allowAt.y, button: 'left', buttons: 0, clickCount: 1 });
    check(await until(`SB.state.activeTab === '${B}'`, 3000), 'clicking Allow in B\'s pane focuses B');
    const allowed = await until(`[...SB.state.tabs.get('${B}').el.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('ALLOWED'))`, 5000);
    check(allowed, 'and the click lands on Allow, though the box moved into that pane');
    if (!allowed) await ev(`[...SB.state.tabs.get('${B}').el.querySelectorAll('.btn.allow')].pop()?.click()`); // let the turn end
    await until(`!SB.state.tabs.get('${B}').busy`);

    // ...and a text field there keeps the keyboard: an answer of your own,
    // clicked in B's pane while D has the focus, gets what's typed next.
    await ev(`document.getElementById('input').value = ''; SB.send('ask')`);
    check(await until(`!!SB.state.tabs.get('${B}').el.querySelector('.qa-other')`), 'B asks a question');
    await ev(`SB.activate('${D}')`);
    await wait(300);
    await ev(`SB.state.tabs.get('${B}').scrollToEnd()`);
    await wait(300);
    const otherAt = await ev(`(() => { const r = [...SB.state.tabs.get('${B}').el.querySelectorAll('.qa-other')].pop().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: otherAt.x, y: otherAt.y, button: 'left', buttons: 1, clickCount: 1 });
    await wait(120);
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: otherAt.x, y: otherAt.y, button: 'left', buttons: 0, clickCount: 1 });
    await wait(200);
    for (const type of ['keyDown', 'keyUp']) await panel.send('Input.dispatchKeyEvent', { type, key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, ...(type === 'keyDown' ? { text: 'x' } : {}) });
    await wait(150);
    const typedIn = await ev(`({ active: SB.state.activeTab === '${B}', field: [...SB.state.tabs.get('${B}').el.querySelectorAll('.qa-other')].pop().value, box: document.getElementById('input').value, focus: document.activeElement.className || document.activeElement.id })`);
    check(typedIn.active, 'clicking the answer field in B\'s pane focuses B');
    check(typedIn.field === 'x' && typedIn.box === '', `and what's typed goes into the answer field, not the message box (${JSON.stringify(typedIn)})`);
    await ev(`document.getElementById('input').value = ''; [...SB.state.tabs.get('${B}').el.querySelectorAll('.ask .btn.ghost')].pop()?.click()`); // Skip: the turn ends
    await until(`!SB.state.tabs.get('${B}').busy`);

    // ---- A stand-in from the keyboard: Enter hands it the box, and its
    // accessible name is what it shows (the draft), not a fixed label.
    await ev(`SB.activate('${D}'); SB.state.tabs.get('${C}').draft = 'C waits'; SB.renderTabStrip()`);
    await wait(150);
    check(await ev(`(() => { const s = document.querySelector('.pane[data-tab="${C}"] .pane-standin'); return !!s && !s.hasAttribute('aria-label') && s.textContent.includes('C waits'); })()`), 'a stand-in is named by its draft');
    await ev(`document.querySelector('.pane[data-tab="${C}"] .pane-standin').focus()`);
    for (const type of ['keyDown', 'keyUp']) await panel.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    check(await until(`SB.state.activeTab === '${C}' && document.activeElement.id === 'input'`, 3000), 'Enter on C\'s stand-in hands C the box');
    check(await ev(`document.getElementById('input').value === 'C waits'`), 'with C\'s draft in it, nothing sent');
    await ev(`document.getElementById('input').value = ''; SB.activate('${D}')`);

    // A press on a stand-in closes an open menu, as a press anywhere else does.
    await ev(`document.getElementById('modeChip').click()`);
    const menuUp = await until('SB.anyMenuOpen()', 3000);
    check(menuUp, 'the mode menu opens');
    await panel.click(await standinOf(C));
    check(menuUp && await until(`SB.state.activeTab === '${C}' && !SB.anyMenuOpen()`, 3000), 'a press on C\'s stand-in closes it and hands C the box');
    await ev(`SB.closeMenus(); SB.activate('${D}')`);

    // AltGr characters (Ctrl+Alt to the browser) type on a stand-in too: @ on a German keyboard.
    await ev(`document.querySelector('.pane[data-tab="${B}"] .pane-standin').focus()`);
    await ev(`document.querySelector('.pane[data-tab="${B}"] .pane-standin').dispatchEvent(new KeyboardEvent('keydown', { key: '@', ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true }))`);
    await wait(150);
    check(await ev(`SB.state.activeTab === '${B}' && document.getElementById('input').value.endsWith('@')`), 'AltGr+Q (@) on B\'s stand-in starts B\'s message with @');
    await ev(`document.getElementById('input').value = ''; SB.activate('${D}')`);

    // ---- A restart brings the layout and its sizes back. Only conversations
    // that have said something reopen after a restart (main's openTabs), and A
    // and B have, so C and D say something first.
    for (const id of [C, D]) {
      await ev(`SB.activate('${id}'); document.getElementById('input').value = ''; SB.send('hello from ' + '${id}'.slice(0, 4))`);
      await until(`!SB.state.tabs.get('${id}').busy && SB.state.tabs.get('${id}').el.querySelector('.msg.assistant')`, 15000);
    }
    await ev(`(() => { const s = SB.state.paneSizes; for (const p of SB.state.grid[0]) s.w[p.id] = 3; SB.renderPanes(); })()`);
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

    // ---- A tab dragged onto the middle of another pane joins it, at the end.
    await panel.drag(await tabAt(C), await paneSpot(B, 0.5, 0.5));
    await wait(300);
    check(await isShape([[A], [D, C]]) && await ev(`JSON.stringify(SB.panes.paneWith(SB.state.grid, '${B}').tabs) === JSON.stringify(['${B}', '${C}'])`), 'C dropped on the middle of B\'s pane joins it, and its own pane closes');

    // ---- Close a pane: its conversations move into the pane beside it.
    await ev(`SB.closePane(${PID(B)})`);
    await wait(200);
    check(await isShape([[A], [D]]) && await ev(`JSON.stringify(SB.panes.paneWith(SB.state.grid, '${D}').tabs) === JSON.stringify(['${D}', '${B}', '${C}'])`), 'closing B\'s pane moves B and C into D\'s, closing neither');

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
      check(await ev(`!!SB.panes.paneWith(SB.state.grid, '${A}')`), 'in a pane again');
      check(await ev(`document.getElementById('input').value === 'typed in the window'`), 'with what was typed in the window');
      check(await ev(`[...SB.state.tabs.get('${A}').el.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('echo: hello from its own window'))`), 'and the whole conversation');
      check(!(await targets()).some(t => t.url.includes('popout=')), 'its window is gone');
    }

    // ---- Back to one pane: the box goes home, no stand-ins.
    for (const id of await ev('SB.panes.paneIds(SB.state.grid)')) if ((await ev('SB.panes.count(SB.state.grid)')) > 1) await ev(`SB.closePane('${id}')`);
    await wait(200);
    check(await ev(`document.getElementById('composer').parentElement.id === 'chatView' && !document.querySelector('.pane-standin')`), 'one pane: the box is back where it always was');
    check(await ev(`(() => { const f = document.getElementById('feeds').getBoundingClientRect(); const p = document.querySelector('.pane').getBoundingClientRect(); return Math.abs(p.width - f.width) < 2 && Math.abs(p.height - f.height) < 2; })()`), 'and the lone pane fills the whole chat');
    check(await ev(`getComputedStyle(document.getElementById('tabstrip')).display !== 'none' && document.querySelectorAll('#tabs .tab').length === SB.state.tabs.size && document.getElementById('tabAllBtn').parentElement.id === 'tabstrip'`), 'one pane: the top strip is back, with every conversation');
    check(await ev(`!document.querySelector('.pane-tabs .tab')`), 'and no pane\'s hidden strip keeps a stale tab');

    // ---- One pane: closing the open tab opens the last one in the strip, as it always has (not its neighbour).
    const made3 = [];
    for (let i = 0; i < 3; i++) made3.push(await ev(`(async () => (await SB.newTab({ reuse: false })).id)()`));
    await ev(`SB.activate('${made3[0]}')`);
    await ev(`SB.closeTab('${made3[0]}')`);
    await wait(200);
    check(await ev(`SB.state.activeTab === [...SB.state.tabs.keys()].pop() && SB.state.activeTab === '${made3[2]}'`), 'one pane: closing the open tab opens the last tab, not the one beside it');
    for (const id of made3.slice(1)) await ev(`SB.closeTab('${id}')`);
    await wait(200);
  } catch (err) {
    check(false, `crashed: ${err.stack || err}`);
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
