// Drives the real Shellby UI over the Chrome DevTools Protocol, end to end:
// onboarding -> send a task -> click Allow on the approval card -> wait for done.
// Uses your real Claude Code subscription (one tiny task).
//
//   node scripts/e2e-ui.js
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9333;
const ROOT = path.join(__dirname, '..');
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function panelTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find(x => x.url.endsWith('panel.html'));
      if (t) return t;
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error('panel never appeared');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const ready = new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  return { ready, send, evaluate, close: () => ws.close() };
}

async function until(c, expr, label, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await c.evaluate(expr)) return;
    await wait(400);
  }
  throw new Error(`timed out: ${label}`);
}

(async () => {
  const target = path.join(os.tmpdir(), `shellby-e2e-${Date.now()}.txt`);
  const app = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  let ok = false;
  try {
    const t = await panelTarget();
    const c = cdp(t.webSocketDebuggerUrl);
    await c.ready;
    await wait(2500); // bootstrap + claude auth status

    const view = await c.evaluate('document.body.dataset.view');
    console.log('start view:', view);
    if (view === 'onboarding') {
      await until(c, "!document.getElementById('letsGoBtn').disabled", 'onboarding checks pass', 20000);
      console.log('onboarding: steps', await c.evaluate("[...document.querySelectorAll('.step')].map(s => s.className).join(' | ')"));
      await c.evaluate("document.getElementById('letsGoBtn').click()");
    }
    await until(c, "document.body.dataset.view === 'chat'", 'chat view');
    console.log('mode:', await c.evaluate("document.getElementById('modeLabel').textContent"));

    const task = `Use the Write tool to create the file ${target} containing the word shell. Do nothing else and do not use any other tool.`;
    await c.evaluate(`(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(task)}; document.getElementById('form').requestSubmit(); })()`);
    console.log('sent task');

    await until(c, "!!document.querySelector('.ask:not(.decided) .btn.allow')", 'approval card');
    console.log('approval card:', await c.evaluate("document.querySelector('.ask .ask-cmd').textContent"));
    await c.evaluate("document.querySelector('.ask:not(.decided) .btn.allow').click()");

    await until(c, "[...document.querySelectorAll('.meta')].some(m => /done|error|stopped/.test(m.textContent))", 'task result');
    console.log('result:', await c.evaluate("[...document.querySelectorAll('.meta')].pop().textContent"));
    console.log('verdict:', await c.evaluate("document.querySelector('.ask-verdict')?.textContent"));
    console.log('usage visible:', await c.evaluate("!document.getElementById('usage').hidden"));
    console.log('file written:', fs.existsSync(target));

    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(os.tmpdir(), 'shellby-e2e.png');
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot:', out);
    ok = fs.existsSync(target);
    c.close();
  } catch (e) {
    console.error('E2E FAILED:', e.message);
  } finally {
    fs.rmSync(target, { force: true });
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    setTimeout(() => process.exit(ok ? 0 : 1), 800);
  }
})();
