// ci: split panes: side by side up to twelve, sizes, a box in each, a saved layout, windows of their own
// Conversations side by side (tab-panes.js, shared/panes.js) and in windows of
// their own (main's wiring/popouts.js): Split puts one beside another, dragging
// a tab into the chat splits a pane and fills a 2x2 grid, a click picks which
// pane the box talks to, and a tab dragged out of the window gets one of its
// own, with its conversation and what was typed. Its × hands it back.
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
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47960' },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) { list = await targets(); await wait(500); }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')));
    const { ev, until } = panel;
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev('shellby.maximize()'); // room for a 2x2 grid
    await wait(800);

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
    await ev('SB.splitPane()');
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
  } catch (err) {
    check(false, `crashed: ${err.stack || err}`);
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
