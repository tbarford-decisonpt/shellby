// Opens the Wardrobe in the dev app over CDP and screenshots it, plus the
// desktop critter wearing the current outfit. Reports renderer errors.
//   node scripts/wardrobe-shots.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9343;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: process.env.SHELLBY_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')) } });
  try {
    let list = [];
    for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html'))); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const connect = async url => {
      const ws = new WebSocket(url);
      await new Promise(r => { ws.onopen = r; });
      let id = 0; const p = new Map(); const errors = [];
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value || a.description).join(' '));
        p.get(m.id)?.(m);
      };
      const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
      await send('Runtime.enable');
      const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
      const shot = async (file, clip) => { const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); console.log('shot', file); };
      return { ws, send, ev, shot, errors };
    };
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await panel.send('Page.reload'); await critter.send('Page.reload');
    await wait(3500);
    // Open the panel only if it isn't already (a fresh profile opens it for onboarding).
    if (await panel.ev('document.visibilityState') !== 'visible') await critter.ev('window.shellby.critter.click()');
    await wait(800);
    await panel.ev("SB.setView('wardrobe')");
    await wait(900);
    await panel.shot(path.join(os.tmpdir(), 'wd-1.png'));
    // hover the witch hat to preview a try-on
    await panel.ev("document.querySelector('#wdSlots [data-slot=hat]').click()");
    await wait(300);
    const pos = JSON.parse(await panel.ev(`(() => { const t=[...document.querySelectorAll('.wd-tile')].find(x=>x.textContent.includes('Witch')); t.scrollIntoView({block:'center'}); const r=t.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`));
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await wait(900);
    await panel.ev("document.getElementById('wdStage').scrollIntoView()");
    await wait(300);
    await panel.shot(path.join(os.tmpdir(), 'wd-2.png'));
    await panel.ev("SB.setView('trophies')");
    await wait(600);
    await panel.shot(path.join(os.tmpdir(), 'wd-3.png'));
    await critter.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 40, g: 60, b: 80, a: 1 } });
    await wait(400);
    await critter.shot(path.join(os.tmpdir(), 'wd-critter.png'));
    console.log('panel errors:', panel.errors.length ? panel.errors : 'none');
    console.log('critter errors:', critter.errors.length ? critter.errors : 'none');
    panel.ws.close(); critter.ws.close();
  } catch (e) {
    console.error('failed:', e.message);
  } finally {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    setTimeout(() => process.exit(0), 600);
  }
})();
