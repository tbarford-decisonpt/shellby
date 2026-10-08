// ci: "just the crab": Health as home, Claude features hidden
// End-to-end check of "just the crab" mode against the dev app over CDP, as a
// brand-new user (throwaway profile, fake hot GPU so Health has something to say).
//   node scripts/e2e-crab-only.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9347;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-crab-only-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));

async function launch() {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`],
    { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_HEALTH: 'hot' } });
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
    return { send, ev };
  };
  const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
  const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
  return { app, panel, critter };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const shot = async (panel, name) => {
    const s = await panel.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64'));
  };
  let run = await launch();
  try {
    const { panel, critter } = run;
    await wait(3000);
    // 1. First run: onboarding with three paths, Claude steps tucked away.
    check(await panel.ev("document.body.dataset.view") === 'onboarding', 'new user sees onboarding');
    check(await panel.ev("document.querySelectorAll('#onboardPaths .path').length") === 4, 'four paths offered');
    check(await panel.ev("document.getElementById('claudeSetup').hidden"), 'Claude steps hidden until chosen');
    await shot(panel, '1-onboarding');

    // 2. Just the crab.
    await panel.ev("document.querySelector('.path[data-path=crab]').click()");
    await wait(900);
    check(await panel.ev("document.body.dataset.view") === 'health', 'lands on Health');
    check(await panel.ev("document.body.classList.contains('crab-only')"), 'crab-only mode on');
    const hidden = await panel.ev(`['.tabstrip', '.subbar', '.mode-chip', '[data-view-btn=toolbox]', '[data-view-btn=routines]', '[data-view-btn=history]']
      .every(s => getComputedStyle(document.querySelector(s)).display === 'none')`);
    check(hidden, 'chat, modes, Toolbox, Routines and History are hidden');
    check(await panel.ev("getComputedStyle(document.querySelector('[data-view-btn=health]')).display !== 'none'"), 'Health button still there');
    check(await panel.ev("!document.getElementById('hlClaude').hidden"), 'Health shows the "Give Shellby a brain" card');
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    check(saved.crabOnly === true && saved.onboarded === true, 'choice saved (crabOnly, onboarded)');
    await wait(1500);
    await shot(panel, '2-health');

    // 3. "Ask Shellby why" is the upsell.
    const ask = await (async () => { for (let i = 0; i < 20; i++) { if (await panel.ev("!document.getElementById('hlAsk').hidden")) return true; await wait(300); } return false; })();
    check(ask, 'hot GPU shows "Ask Shellby why"');
    await panel.ev("document.getElementById('hlAsk').click()");
    await wait(500);
    check(await panel.ev("!document.getElementById('upsellSheet').hidden"), 'asking opens the Claude Code upsell');
    await shot(panel, '3-upsell');
    check(await panel.ev("SB.state.tabs.size") <= 1 && await panel.ev("[...SB.state.tabs.values()].every(t => !t.busy)"), 'no task was started');

    // 4. Set up Claude → onboarding steps; "just the crab for now" → back.
    await panel.ev("document.querySelector('#upsellSheet [data-claude-setup]').click()");
    await wait(600);
    check(await panel.ev("document.body.dataset.view") === 'onboarding' && await panel.ev("!document.getElementById('claudeSetup').hidden"), 'upsell leads to the Claude setup steps');
    await panel.ev("document.getElementById('crabInsteadBtn').click()");
    await wait(700);
    check(await panel.ev("document.body.dataset.view") === 'health', '"Just the crab for now" goes back to Health');

    // 5. Chat routes to Health; dropping files is an upsell.
    await panel.ev("SB.setView('chat')");
    check(await panel.ev("document.body.dataset.view") === 'health', 'chat view maps to Health');
    await critter.ev("window.shellby.critter.drop(['C:\\\\Users\\\\you\\\\notes.txt'])");
    await wait(700);
    check(await panel.ev("!document.getElementById('upsellSheet').hidden"), 'dropping files shows the upsell');
    await panel.ev("document.getElementById('upsellLater').click()");

    // 6. Settings offers the way back.
    await panel.ev("SB.setView('settings')");
    check(await panel.ev("document.getElementById('claudeModeBtn').textContent") === 'Set up Claude Code', 'Settings offers "Set up Claude Code"');
  } catch (e) {
    check(false, e.message);
  } finally {
    run.app.kill();
    await wait(1500);
  }

  // 7. Restart: straight back to the crab.
  run = await launch();
  try {
    await wait(3500);
    check(await run.panel.ev("document.body.dataset.view") === 'health' || await run.panel.ev("document.body.classList.contains('crab-only')"), 'after restart: crab-only, no onboarding');
    check(await run.panel.ev("document.body.dataset.view") !== 'onboarding', 'after restart: onboarding not shown again');
  } catch (e) {
    check(false, e.message);
  } finally {
    run.app.kill();
  }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
