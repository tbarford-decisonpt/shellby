// Quick UI regression checks against the dev app over CDP:
//  1. closing the last tab leaves exactly ONE blank tab (was: two)
//  2. hovering a titled button shows the themed tooltip, not the OS one
//  3. the title bar fits at every width in every mode (see titlebar-fit.js)
//  4. dragging a tab along the strip reorders it, and main keeps the new order
//  5. keyboard only: Ctrl+PageUp/PageDown, the Ctrl+/ shortcut list, the palette's
//     actions and their keys, focus landing back in the box, Ctrl+W asking first
//   node scripts/ui-regressions.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9342;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // The fake CLI stands in for Claude Code so onboarding is satisfied and there is
  // a chat tab to close, on a machine with Claude Code installed or without one.
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: process.env.SHELLBY_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js') } });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  try {
    let list = [];
    for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html'))); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const connect = async url => {
      const ws = new WebSocket(url);
      await new Promise(r => { ws.onopen = r; });
      let id = 0; const p = new Map();
      ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
      const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
      const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
      return { ws, send, ev };
    };
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await wait(3000);
    // Open the panel only if it isn't already (a fresh profile opens it for onboarding).
    if (await panel.ev('document.visibilityState') !== 'visible') await critter.ev('window.shellby.critter.click()'); // show the panel so layout/hover are real
    await wait(800);
    await panel.ev("SB.setView('chat')");

    // 1. close-last-tab: slow, then rapid-fire
    const tabCount = () => panel.ev("JSON.stringify({ state: SB.state.tabs.size, dom: document.querySelectorAll('#tabs .tab').length })");
    for (const [label, gap] of [['normal close', 900], ['fast close', 0], ['double click on ×', 0]]) {
      await panel.ev(`(async () => { for (const id of [...SB.state.tabs.keys()].slice(1)) await SB.closeTab(id); })()`);
      await wait(400);
      if (label === 'double click on ×') {
        await panel.ev(`(() => { const x = document.querySelector('#tabs .tab.active .tab-x'); x.click(); x.click(); })()`);
      } else {
        await panel.ev('SB.closeTab(SB.state.activeTab)');
      }
      await wait(gap || 150);
      await wait(900);
      const c = JSON.parse(await tabCount());
      check(c.state === 1 && c.dom === 1, `${label}: one tab left (state=${c.state}, dom=${c.dom})`);
    }

    // 2. themed tooltip on hover (real mouse move through the compositor)
    // The tip correctly hides when the window loses focus, which happens if
    // someone is using the PC during the run, so hover again before failing.
    const r = JSON.parse(await panel.ev("JSON.stringify(document.getElementById('newTabBtn').getBoundingClientRect())"));
    let t;
    for (let attempt = 0; attempt < 3; attempt++) {
      await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
      await wait(100);
      await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + r.width / 2, y: r.y + r.height / 2 });
      await wait(700);
      t = JSON.parse(await panel.ev(`JSON.stringify({
        visible: !document.querySelector('.tip').hidden,
        text: document.querySelector('.tip').textContent,
        nativeTitle: document.getElementById('newTabBtn').getAttribute('title'),
      })`));
      if (t.visible) break;
    }
    check(t.visible && /New conversation/.test(t.text), `themed tooltip shows ("${t.text}")`);
    check(t.nativeTitle === null, 'native title removed, so no OS tooltip');
    const shot = await panel.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r.x - 150), y: r.y - 10, width: 260, height: 90, scale: 2 } });
    const out = path.join(os.tmpdir(), 'shellby-tooltip.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('tooltip screenshot:', out);

    // 3. scrollIntoView on deep content must never scroll the page itself
    //    (the original "top of the panel gets messed up when scrolling" bug)
    for (const view of ['settings', 'routines', 'history', 'health', 'chat']) {
      await panel.ev(`SB.setView('${view}')`);
      await wait(250);
      const r2 = JSON.parse(await panel.ev(`(() => {
        const main = document.querySelector('.view-${view}') || document.body;
        const deep = main.querySelector('*:last-child') || main;
        // block 'start' on content near the bottom: the view can't scroll that far,
        // so the browser tries to scroll the page itself to make up the difference.
        deep.scrollIntoView({ block: 'start' });
        // The title bar sits just inside the body's 1px border, so its top is that
        // border width — which is 1 at 100% display scaling and 0.8 at 125%.
        // Measure the offset from where it belongs, not from the viewport, or this
        // silently becomes a test of the monitor it was written on.
        const border = parseFloat(getComputedStyle(document.body).borderTopWidth) || 0;
        return JSON.stringify({ page: document.scrollingElement.scrollTop + document.body.scrollTop, bar: document.querySelector('.titlebar').getBoundingClientRect().top - border });
      })()`));
      check(r2.page === 0 && Math.abs(r2.bar) < 1, `${view}: page never scrolls, title bar stays at top (page=${r2.page}, bar=${r2.bar})`);
    }

    // 4. critter helpers have no native titles
    const titles = await critter.ev("document.querySelectorAll('[title]').length");
    check(titles === 0, `critter has no native-tooltip titles (${titles})`);

    // 5. drag a tab along the strip, with real mouse input through the compositor
    await panel.ev("SB.setView('chat')");
    await panel.ev(`(async () => {
      for (const id of [...SB.state.tabs.keys()].slice(1)) await SB.closeTab(id);
      // Straight through api.newTab: SB.newTab() reuses a blank tab, so it can
      // only ever give us the one we already have.
      for (let i = 0; i < 3; i++) { const r = await SB.api.newTab(); SB.ensureTab({ id: r.tabId, cwd: SB.state.cwd }); }
      SB.renderTabStrip();
    })()`);
    await wait(900);
    const strip = () => panel.ev("JSON.stringify([...document.querySelectorAll('#tabs .tab')].map(el => el.dataset.tabId))").then(JSON.parse);
    const boxes = () => panel.ev("JSON.stringify([...document.querySelectorAll('#tabs .tab')].map(el => el.getBoundingClientRect()))").then(JSON.parse);
    const before = await strip();
    check(before.length === 4 && before.every(Boolean), `four tabs to shuffle, each tagged with its id (${before.length})`);

    const b = await boxes();
    const y = b[0].y + b[0].height / 2;
    const from = b[0].x + b[0].width / 2;
    const to = b[3].x + b[3].width * 0.9;    // past the last tab's midpoint
    await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from, y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from + (to - from) * (i / 8), y, button: 'left', buttons: 1 });
      await wait(40);
    }
    const mid = await strip();
    check(mid.at(-1) === before[0], `the dragged tab follows the pointer to the end (${mid.at(-1) === before[0]})`);
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to, y, button: 'left', buttons: 0, clickCount: 1 });
    await wait(400);
    const dropped = await strip();
    check(
      dropped.join() === [...before.slice(1), before[0]].join(),
      `dropped where it was let go: ${before.join()} -> ${dropped.join()}`,
    );
    check(await panel.ev('SB.state.activeTab') === before[0], 'and you end up in the conversation you grabbed');
    check(await panel.ev("!document.body.classList.contains('reordering') && !document.querySelector('#tabs .dragging')"), 'no drag styling left behind');

    // Main has to have taken the same order, or it would snap back on the next
    // update from it — and `openTabs` would come back wrong next launch.
    await panel.ev('SB.api.newTab()');
    await wait(900);
    const afterSync = await strip();
    check(afterSync.slice(0, 4).join() === dropped.join(), `main kept the new order (${afterSync.slice(0, 4).join()})`);

    // The keyboard path, which is the only one without a pointer.
    await panel.ev("SB.activate(SB.state.tabs.keys().next().value)");
    const first = await panel.ev('SB.state.activeTab');
    await panel.ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', ctrlKey: true, shiftKey: true, bubbles: true }))");
    await wait(300);
    const nudged = await strip();
    check(nudged[1] === first, `Ctrl+Shift+PageDown moves it one place right (${nudged.indexOf(first)})`);
    await panel.ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', ctrlKey: true, shiftKey: true, bubbles: true }))");
    await wait(300);
    check((await strip())[0] === first, 'and PageUp puts it back');

    // 6. keyboard only: tabs, the shortcut list, the palette's actions, Ctrl+W's safety.
    // Keys go to whatever has focus, the way a real press does.
    const press = (key, mods = {}) => panel.ev(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} }))`);
    const focused = () => panel.ev("(document.activeElement && (document.activeElement.id || document.activeElement.className)) || 'body'");
    await panel.ev("SB.activate(SB.state.tabs.keys().next().value)");
    await wait(200);
    const ids = await panel.ev('JSON.stringify([...SB.state.tabs.keys()])').then(JSON.parse);
    await press('PageDown', { ctrl: true });
    await wait(200);
    check(await panel.ev('SB.state.activeTab') === ids[1], 'Ctrl+PageDown goes to the next conversation');
    await press('PageUp', { ctrl: true });
    await wait(200);
    check(await panel.ev('SB.state.activeTab') === ids[0], 'Ctrl+PageUp comes back');
    check(await focused() === 'input', `switching tabs leaves the keyboard in the box (${await focused()})`);

    await press('/', { ctrl: true });
    await wait(200);
    const sheet = JSON.parse(await panel.ev(`JSON.stringify({
      open: !document.getElementById('shortcutsSheet').hidden,
      rows: document.querySelectorAll('#shortcutsList dt').length,
      table: SB.shortcuts.SHORTCUTS.length,
      inside: document.getElementById('shortcutsSheet').contains(document.activeElement),
    })`));
    check(sheet.open && sheet.rows === sheet.table, `Ctrl+/ lists every shortcut in the table (${sheet.rows} of ${sheet.table})`);
    check(sheet.inside, 'and the keyboard is in the list');
    await press('Escape');
    await wait(200);
    check(await panel.ev("document.getElementById('shortcutsSheet').hidden") && await focused() === 'input', `Esc closes it and the keyboard is back in the box (${await focused()})`);

    await press('k', { ctrl: true });
    await wait(200);
    const pal = JSON.parse(await panel.ev(`JSON.stringify({
      group: document.querySelector('#paletteList .pal-group')?.textContent,
      close: [...document.querySelectorAll('#paletteList .pal-item')].find(li => /Close this conversation/.test(li.textContent))?.querySelector('kbd')?.textContent,
    })`));
    check(pal.group === 'This conversation', `Ctrl+K on the chat starts with this conversation's actions (${pal.group})`);
    check(pal.close === 'Ctrl+W', `and shows an action's shortcut (${pal.close})`);
    await panel.ev("(() => { const i = document.getElementById('paletteInput'); i.value = 'keyboard shortcuts'; i.dispatchEvent(new Event('input')); })()");
    await press('Enter');
    await wait(250);
    check(await panel.ev("!document.getElementById('shortcutsSheet').hidden"), 'typing "keyboard shortcuts" and Enter opens the list');
    await press('Escape');
    await wait(200);
    check(await focused() === 'input', `closing it from there lands in the box too (${await focused()})`);

    // A conversation that's working isn't closed by one stray Ctrl+W.
    const count = () => panel.ev('SB.state.tabs.size');
    const n = await count();
    await panel.ev('SB.activeTab().busy = true');
    await press('w', { ctrl: true });
    await wait(300);
    check(await count() === n && /still working/.test(await panel.ev("document.getElementById('toast').textContent")), 'Ctrl+W on a working conversation asks first');
    await press('w', { ctrl: true });
    await wait(600);
    check(await count() === n - 1, 'and a second Ctrl+W closes it');

    panel.ws.close(); critter.ws.close();
  } catch (e) {
    console.error('failed:', e.message);
    fails++;
  } finally {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    setTimeout(() => process.exit(fails ? 1 : 0), 600);
  }
})();
