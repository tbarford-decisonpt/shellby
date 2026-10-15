// ci: a panel with many busy tabs keeps answering while minimized, restored and made huge
// Main sends the whole list of conversations every time any one of them moves. With a lot
// of busy tabs that is a flood, and the panel used to handle each message in full (the tab
// strip rebuilt and measured): it fell behind, most of all while minimized, and froze for as
// long as the backlog took to drain. This check opens 15 tabs with long conversations,
// floods the panel with those lists from main, resizes it, minimizes it for a while,
// restores it and makes it huge, and wants the page to answer promptly after every step and
// to have handled the newest list once per pace, not every message. Everything happens
// to the panel this run launched, off screen.
/* global SB, window -- fill and wrapSync below run in the panel page */
//   node scripts/e2e-restore-many-tabs.js [--profile file]    STORM_MS=0 turns the flood off
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9366;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`, `--inspect=${PORT + 1}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_E2E: '1', SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47992' },
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
    const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    const TABS = 15;
    const BLOCKS = 60;
    const OFFSCREEN_X = -6000;
    const ANSWER_MS = 1500;
    const LONG_TASK_MS = 1000;
    const profAt = process.argv.indexOf('--profile');
    const PROFILE = profAt > 0 ? process.argv[profAt + 1] : null;
    // The main process, over the Node inspector: it moves only the panel this run owns.
    const mj = await (await fetch('http://127.0.0.1:' + (PORT + 1) + '/json/list')).json();
    const mws = new WebSocket(mj[0].webSocketDebuggerUrl);
    await new Promise(r => { mws.onopen = r; });
    let mid = 0; const mp = new Map();
    mws.onmessage = e => { const m = JSON.parse(e.data); mp.get(m.id)?.(m); };
    const mainSend = (method, params) => new Promise(r => { const i = ++mid; mp.set(i, m => r(m.result)); mws.send(JSON.stringify({ id: i, method, params })); });
    const mainEval = expr => mainSend('Runtime.evaluate', { expression: expr });
    const panelWin = "process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('panel.html'))";
    const state = s => mainEval(panelWin + (s === 'normal' ? '.restore()' : '.minimize()'));
    const size = (w, h) => mainEval(panelWin + '.setBounds({ x: ' + OFFSCREEN_X + ', y: 0, width: ' + w + ', height: ' + h + ' })');
    await state('normal');
    await size(460, 700);
    await wait(2500);
    // Runs in the page: a long, busy conversation in every tab.
    const fill = async (tabs, blocks) => {
      const fence = String.fromCharCode(96).repeat(3);
      const nl = String.fromCharCode(10);
      const code = ['const x = 1;', 'function f(a, b) { return a + b; }'].join(nl).concat(nl).repeat(12);
      const para = 'Lorem ipsum dolor sit amet. '.repeat(30);
      const body = n => ['## Step ' + n, '', 'Some **bold** text and a [link](https://example.com).', '', '- one', '- two', '', fence + 'js', code + fence, '', para].join(nl);
      for (let i = 0; i < tabs; i++) {
        const t = i === 0 ? SB.activeTab() : await SB.newTab({ reuse: false });
        for (let n = 0; n < blocks; n++) {
          const add = (kind, extra) => t.render(Object.assign({ kind }, extra));
          add('text', { text: body(n) });
          const tid = 'tool-' + n;
          add('tool', Object.fromEntries([['id', tid], ['label', 'Read']]));
          add('tool_result', Object.fromEntries([['id', tid], ['text', 'done']]));
        }
      }
      return SB.state.tabs.size;
    };
    const made = await ev('(' + fill + ')(' + TABS + ',' + BLOCKS + ')');
    check(made >= TABS, TABS + ' tabs are open (' + made + ')');
    const wrapSync = () => {
      window.__sync = 0;
      window.__syncMs = 0;
      const orig = SB.syncTabs;
      SB.syncTabs = s => {
        const t0 = performance.now();
        window.__sync += 1;
        orig(s);
        window.__syncMs += performance.now() - t0;
      };
    };
    await ev('(' + wrapSync + ')()');
    const cdpSend = (method, params) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    await cdpSend('Profiler.enable', {});
    await cdpSend('Profiler.start', {});
    await ev("window.__long = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });");
    const steps = {};
    let mark = 0;
    const settle = async label => {
      mark = Date.now();
      await (label === 'minimized' ? ev('1 + 1') : Promise.race([cdpSend('Page.captureScreenshot', { format: 'jpeg', quality: 20 }), wait(12000)]));
      steps[label] = Date.now() - mark;
    };
    const summaryJson = await ev("JSON.stringify(Array.from(SB.state.tabs.values()).map(t => Object.fromEntries([['id', t.id], ['title', t.title], ['cwd', t.cwd], ['busy', true], ['busySince', Date.now()], ['turnTokens', 1234]])))");
    const stormEvery = Number(process.env.STORM_MS || 10);
    const wc = panelWin + '.webContents';
    const sendOne = 'if (!globalThis.stormOff) { globalThis.stormSent = (globalThis.stormSent || 0) + 1; ' + wc + '.send("tabs", ' + summaryJson + '); }';
    if (stormEvery) await mainEval('globalThis.stormTimer = setInterval(() => { ' + sendOne + ' }, ' + stormEvery + ')');
    for (const w of [600, 700, 820, 960, 1100]) await size(w, 700 + w / 10);
    await settle('resize burst');
    await state('minimized');
    await wait(Number(process.env.HIDE_MS || 15000));
    await settle('minimized');
    await state('normal');
    await settle('restored');
    await size(1900, 1000);
    await settle('grown');
    await wait(1500);
    await settle('afterwards');
    for (const label of Object.keys(steps)) check(steps[label] < ANSWER_MS, 'page answers within ' + ANSWER_MS + ' ms after ' + label + ' (' + steps[label] + ' ms)');
    const longs = await ev('window.__long');
    const worst = Math.max(0, ...longs);
    check(worst < LONG_TASK_MS, 'no task holds the main thread ' + LONG_TASK_MS + ' ms (' + longs.length + ' long tasks, worst ' + worst + ' ms)');
    if (stormEvery) await mainEval('globalThis.stormOff = 1');
    const sentBox = stormEvery ? await mainEval('globalThis.stormSent') : null;
    const sent = sentBox ? sentBox.result.value : 0;
    if (stormEvery) await wait(8000);
    const handledAfter = await ev('window.__sync');
    if (stormEvery) console.log('summaries sent', sent, 'handled 8 s after the last', handledAfter);
    if (sent) check(handledAfter < sent / 4, 'the panel handles the newest list once per pace, not each of ' + sent + ' messages (' + handledAfter + ' handled)');
    const profile = (await cdpSend('Profiler.stop', {})).profile;
    if (PROFILE) {
      fs.writeFileSync(PROFILE, JSON.stringify(profile));
      const self = new Map();
      const byId = new Map(profile.nodes.map(n => [n.id, n]));
      for (let k = 0; k < profile.samples.length; k++) {
        const cf = byId.get(profile.samples[k]).callFrame;
        const name = (cf.functionName || '(anon)') + ' ' + path.basename(cf.url) + ':' + (cf.lineNumber + 1);
        self.set(name, (self.get(name) || 0) + (profile.timeDeltas[k] || 0));
      }
      for (const [name, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log('  ' + Math.round(us / 1000) + ' ms  ' + name);
    }
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? fails + ' FAILED' : 'all passed');
  process.exit(fails ? 1 : 0);
})();
