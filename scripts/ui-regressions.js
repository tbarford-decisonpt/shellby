// Quick UI regression checks against the dev app over CDP:
//  1. closing the last tab leaves exactly ONE blank tab (was: two)
//  2. hovering a titled button shows the themed tooltip, not the OS one
//  3. the title bar fits at every width in every mode (see titlebar-fit.js)
//   node scripts/ui-regressions.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9342;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
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
    await critter.ev('window.shellby.critter.click()'); // show the panel so layout/hover are real
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
    const r = JSON.parse(await panel.ev("JSON.stringify(document.getElementById('newTabBtn').getBoundingClientRect())"));
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + r.width / 2, y: r.y + r.height / 2 });
    await wait(700);
    const t = JSON.parse(await panel.ev(`JSON.stringify({
      visible: !document.querySelector('.tip').hidden,
      text: document.querySelector('.tip').textContent,
      nativeTitle: document.getElementById('newTabBtn').getAttribute('title'),
    })`));
    check(t.visible && /New conversation/.test(t.text), `themed tooltip shows ("${t.text}")`);
    check(t.nativeTitle === null, 'native title removed, so no OS tooltip');
    const shot = await panel.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r.x - 150), y: r.y - 10, width: 260, height: 90, scale: 2 } });
    const out = path.join(os.tmpdir(), 'shellby-tooltip.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('tooltip screenshot:', out);

    // 3. critter helpers have no native titles
    const titles = await critter.ev("document.querySelectorAll('[title]').length");
    check(titles === 0, `critter has no native-tooltip titles (${titles})`);
    panel.ws.close(); critter.ws.close();
  } catch (e) {
    console.error('failed:', e.message);
    fails++;
  } finally {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    setTimeout(() => process.exit(fails ? 1 : 0), 600);
  }
})();
