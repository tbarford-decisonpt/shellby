// ci: your prompt stays visible as the Working bar appears
// Regression check: after sending a prompt, the whole prompt is visible at the
// bottom of the conversation, even though the "Working… / Stop" bar (and any
// queued-message chips) appear above the composer at the same moment and make
// the conversation area shorter. Runs against the fake CLI; no account needed.
//   node scripts/e2e-feed-scroll.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9354;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47992' },
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
    const idle = async () => { for (let i = 0; i < 60 && await ev('SB.activeTab().busy'); i++) await wait(150); };
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev("document.body.style.width = '460px'");

    // Enough history that the conversation scrolls.
    for (let i = 0; i < 6; i++) { await ev(`SB.send('wait 50 filler message ${i} ' + 'lorem ipsum dolor sit amet '.repeat(6))`); await idle(); }

    // How much of the newest user message is hidden below the conversation area?
    const hidden = () => ev(`(() => {
      const t = SB.activeTab(); const msgs = t.el.querySelectorAll('.msg.user'); const last = msgs[msgs.length - 1];
      return Math.round(last.getBoundingClientRect().bottom - t.el.getBoundingClientRect().bottom);
    })()`);

    // 1. A long prompt while idle: the Working bar appears as it's sent.
    await ev("SB.send('wait 2500 ' + 'a long prompt that wraps onto several lines in the panel '.repeat(5))");
    await wait(400);
    let h = await hidden();
    check(h <= 0, `prompt fully visible after sending (${h > 0 ? `${h}px cut off` : 'ok'})`);

    // 2. Queue one while it works: the chips appear above the composer.
    await ev("SB.send('queued one ' + 'more words to wrap '.repeat(4))");
    await wait(300);
    await idle(); await wait(400);
    h = await hidden();
    check(h <= 0, `queued prompt fully visible once it's sent (${h > 0 ? `${h}px cut off` : 'ok'})`);

    // 3. Scrolled up reading history: sending still jumps to your new prompt.
    await idle();
    await ev('SB.activeTab().el.scrollTop = 0');
    await ev("SB.send('wait 300 sent while scrolled up')");
    await wait(400);
    h = await hidden();
    check(h <= 0, `sending while scrolled up shows the new prompt (${h > 0 ? `${h}px cut off` : 'ok'})`);
    await idle();

    // 4. ...but a reply arriving while you read history doesn't yank you down.
    await ev("SB.send('wait 1200 slow reply')");
    await wait(200);
    await ev('SB.activeTab().el.scrollTop = 0');
    await idle(); await wait(300);
    check(await ev('SB.activeTab().el.scrollTop') < 50, 'a reply does not yank you away from history you scrolled up to read');

    // 5. The feed shrinking by more than 40px in the very frame a new message lands (the bar,
    // chips and a warning at once, or a slow machine batching them): the scroll event that
    // message's own scroll-to-end queued must not read as "you scrolled away".
    await idle();
    await ev('SB.activeTab().el.scrollTop = SB.activeTab().el.scrollHeight');
    await wait(400);
    await ev(`(() => {
      const t = SB.activeTab(); const room = t.el.clientHeight;
      t.el.style.flex = 'none'; t.el.style.height = room + 'px';
      const m = document.createElement('div'); m.className = 'msg user'; m.textContent = 'one more ' + 'words '.repeat(30);
      t.append(m);
      t.el.style.height = (room - 60) + 'px';
    })()`);
    await wait(600);
    h = await hidden();
    check(h <= 0, `a message landing as the feed shrinks 60px is still fully visible (${h > 0 ? `${h}px cut off` : 'ok'})`);
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
