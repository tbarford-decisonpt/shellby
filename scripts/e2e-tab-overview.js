// Lots of open conversations (tab-overview.js): the strip's edge markers count
// what's scrolled out of sight and jump to one that needs you, and the list of
// every open conversation groups, filters, opens, closes and tidies up.
// No Claude account needed — tab states are set straight on the panel.
//   node scripts/e2e-tab-overview.js [--shots <dir>]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9371;
const TABS = 20;
const SHOT_TIMEOUT_MS = 10000;   // an unpainted window never answers captureScreenshot
const wait = ms => new Promise(r => setTimeout(r, ms));
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47993' },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const ws = new WebSocket(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const p = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
    const key = async (k, mods = 0, code = k) => {
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, modifiers: mods, windowsVirtualKeyCode: { ArrowDown: 40, Enter: 13, Escape: 27, Delete: 46, a: 65 }[k] || 0 });
    };
    const shot = async name => {
      if (!SHOTS) return;
      const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), wait(SHOT_TIMEOUT_MS).then(() => null)]);
      if (r?.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
      else console.log(`(no screenshot for ${name}: the window didn't paint)`);
    };
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await wait(500);

    // Twenty conversations, named, some of them needing you. Main's snapshots
    // would put the names and states back, so the panel stops listening first.
    const opened = await ev(`(async () => {
      SB.syncTabs = () => {};
      const names = ['Fix login redirect', 'Write release notes', 'Tidy the settings page', 'Bump Electron', 'Crab hat sprites',
        'Investigate flaky e2e', 'Docs for workflows', 'Speed up boot', 'Refactor history', 'Winget manifest',
        'Usage meter colours', 'Tank decorations', 'Beach snapshot share', 'Dark mode audit', 'Profile card fonts',
        'Routine retry logic', 'Hook editor polish', 'Branch compare view', 'Time tracking export', 'Shop search'];
      for (let i = 0; i < ${TABS}; i++) {
        const r = await SB.api.newTab();
        if (!r.ok) return r.error;
        const t = SB.ensureTab({ id: r.tabId, title: names[i], cwd: i % 3 ? 'C:\\\\code\\\\shellby' : 'C:\\\\code\\\\site' });
        Object.assign(t, { reported: true, named: true });
      }
      return SB.state.tabs.size;
    })()`);
    check(opened > TABS, `opened ${TABS} conversations (${opened} open with the first one)`);

    // Pin the states on the panel: main's snapshots would otherwise reset them.
    await ev(`(() => {
      const tabs = [...SB.state.tabs.values()];
      const set = (title, o) => Object.assign(tabs.find(t => t.title === title), o);
      set('Hook editor polish', { pending: 1 });
      set('Dark mode audit', { unread: true, outcome: 'ok' });
      set('Bump Electron', { busy: true, busySince: Date.now() });
      set('Docs for workflows', { draft: 'half a thought' });
      SB.activate(tabs.find(t => t.title === 'Fix login redirect').id);
      document.getElementById('tabs').scrollLeft = 0;
    })()`);
    await wait(400);

    const btn = await ev("({ hidden: document.getElementById('tabAllBtn').hidden, n: document.getElementById('tabAllCount').textContent, asking: document.getElementById('tabAllBtn').classList.contains('asking') })");
    check(!btn.hidden && Number(btn.n) === opened, `the list button shows the count (${btn.n})`);
    check(btn.asking, 'the list button carries the amber dot while one waits for an OK');

    const right = await ev("(() => { const e = document.getElementById('tabEdgeRight'); return { hidden: e.hidden, cls: e.className, text: e.textContent, label: e.getAttribute('aria-label') }; })()");
    check(!right.hidden && /\+\d+/.test(right.text), `the right edge counts what's out of sight (${right.text})`);
    check(/asking/.test(right.cls), `the right edge is amber for a hidden tab waiting on you (${right.cls})`);
    check(await ev("document.getElementById('tabEdgeLeft').hidden"), 'nothing is hidden on the left at the start of the strip');
    await shot('1-strip-many-tabs');

    await ev("document.getElementById('tabEdgeRight').click()");
    await wait(400);
    check(await ev("SB.activeTab().pending === 1"), 'clicking the amber edge opens the tab that needs you');
    check(await ev("!document.getElementById('tabEdgeLeft').hidden"), 'and now the left edge counts what scrolled away');
    await shot('2-jumped-to-asking');

    // The list.
    await ev("document.getElementById('input').focus()");
    await key('a', 2 | 8, 'KeyA');
    await wait(300);
    check(await ev("!document.getElementById('tabList').hidden"), 'Ctrl+Shift+A opens the list');
    check(await ev("document.activeElement?.classList.contains('tl-find')"), 'with the find field focused');
    const groups = await ev("[...document.querySelectorAll('.tl-group > span:first-child')].map(e => e.textContent)");
    check(JSON.stringify(groups) === JSON.stringify(['Waiting for your OK', 'Finished', 'Working', 'Quiet']), `grouped by what they need (${groups.join(', ')})`);
    const sweepText = await ev("document.querySelector('.tl-sweep').textContent");
    check(/Close 1[0-9] quiet conversations/.test(sweepText), `offers to close the quiet ones (${sweepText})`);
    await shot('3-list-open');

    await ev("(() => { const f = document.querySelector('.tl-find'); f.value = 'winget'; f.dispatchEvent(new Event('input')); })()");
    await wait(150);
    const rows = await ev("[...document.querySelectorAll('.tl-row .tl-title')].map(e => e.textContent)");
    check(rows.length === 1 && rows[0] === 'Winget manifest', `the filter narrows the list (${rows.join(', ')})`);
    await shot('4-list-filtered');
    await key('Enter');
    await wait(300);
    check(await ev("SB.activeTab().title === 'Winget manifest' && document.getElementById('tabList').hidden"), 'Enter opens the match and closes the list');

    // Escape closes the list without stopping a working tab.
    await key('a', 2 | 8, 'KeyA');
    await wait(200);
    await key('Escape');
    await wait(200);
    check(await ev("document.getElementById('tabList').hidden && document.activeElement?.id === 'input'"), 'Escape closes the list and goes back to the composer');

    // Closing the quiet ones spares the busy, the asking, the finished, the draft, and the open one.
    const before = await ev('SB.state.tabs.size');
    await key('a', 2 | 8, 'KeyA');
    await wait(200);
    await ev("document.querySelector('.tl-sweep').click()");
    await wait(600);
    const left = await ev("[...SB.state.tabs.values()].map(t => t.title)");
    check(left.length < before && left.length === 5, `closing quiet ones leaves 5 of ${before} (${left.join(', ')})`);
    check(['Hook editor polish', 'Dark mode audit', 'Bump Electron', 'Docs for workflows', 'Winget manifest'].every(t => left.includes(t)), 'the asking, finished and busy tabs, the one with a draft and the open one stay');
    check(await ev("document.querySelector('.tl-sweep').disabled"), 'nothing quiet left to close');
    await shot('5-after-sweep');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
