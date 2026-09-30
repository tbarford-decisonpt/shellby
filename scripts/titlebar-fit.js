// Checks the panel title bar fits at various window widths in every permission
// mode (the mode chip's label changes width). Reports any overflow.
//   node scripts/titlebar-fit.js
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9341;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  let fails = 0;
  try {
    let t;
    for (let i = 0; i < 40 && !t; i++) {
      try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.url.endsWith('panel.html')); } catch { /* starting */ }
      await wait(500);
    }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const p = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
    const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
    await wait(3000);
    await ev("SB.setView('chat')");
    for (const width of [400, 420, 440, 460, 494]) {
      const row = [];
      for (const mode of ['ask', 'smart', 'acceptEdits', 'plan', 'autonomous']) {
        const r = JSON.parse(await ev(`(() => {
          document.body.style.width = '${width}px';
          SB.applyMode('${mode}');
          const bar = document.querySelector('.titlebar');
          const close = document.getElementById('closeBtn').getBoundingClientRect();
          return JSON.stringify({ overflow: bar.scrollWidth - bar.clientWidth, closeRight: Math.round(close.right), limit: ${width} });
        })()`));
        const ok = r.overflow <= 0 && r.closeRight <= width;
        if (!ok) fails++;
        row.push(`${mode}:${ok ? 'ok' : `CUT(${r.closeRight - width}px)`}`);
      }
      console.log(`${String(width).padStart(4)}px  ${row.join('  ')}`);
    }
    if (process.argv.includes('--shot')) {
      await ev("document.body.style.width = '400px'; SB.applyMode('autonomous')");
      await wait(300);
      const shot = await new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method: 'Page.captureScreenshot', params: { format: 'png', clip: { x: 0, y: 0, width: 400, height: 60, scale: 2 } } })); });
      const out = require('path').join(require('os').tmpdir(), 'shellby-titlebar-400.png');
      require('fs').writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('shot:', out);
    }
    await ev("document.body.style.width = ''; SB.applyMode(SB.state.settings.mode)");
    ws.close();
  } catch (e) {
    console.error('failed:', e.message);
    fails++;
  } finally {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    setTimeout(() => process.exit(fails ? 1 : 0), 600);
  }
})();
