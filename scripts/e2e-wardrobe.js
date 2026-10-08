// End-to-end: a real Claude Code task finishes -> "Hello, World" achievement
// unlocks -> desktop critter celebrates (★ state + confetti burst), the panel
// toasts, and the Party Hat becomes wearable and shows up on the desktop crab.
// Runs in an isolated temp profile (SHELLBY_USER_DATA): your real Shellby,
// settings and history are untouched, and it can keep running.
//   node scripts/e2e-wardrobe.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9344;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-profile-'));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`],
    { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile } });
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
    await wait(3500);
    if (await panel.ev('document.body.dataset.view') === 'onboarding') {
      await panel.ev("document.getElementById('letsGoBtn').click()");
      await wait(400);
    }
    check(await panel.ev("SB.state.wardrobe.accessories.find(a => a.key === 'party-hat').locked !== null"), 'fresh profile: Party Hat starts locked');

    // Watch the critter for the celebration while the task runs.
    await critter.ev(`window.__seen = { unlocked: false, burst: 0 };
      new MutationObserver(() => {
        if (document.body.classList.contains('state-unlocked')) window.__seen.unlocked = true;
        window.__seen.burst = Math.max(window.__seen.burst, document.querySelectorAll('.fx-burst .fx-p').length);
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }); 1`);
    await panel.ev("SB.send('Reply with just the word hi. Do not use any tools.')");
    console.log('sent a real task...');

    // Since 0.6 a trophy shows as the celebration card (it used to be a toast).
    let card = '';
    for (let i = 0; i < 120; i++) {
      card = await panel.ev("document.querySelector('.celebrate')?.textContent || ''");
      if (/Hello, World/.test(card)) break;
      await wait(500);
    }
    check(/Hello, World/.test(card) && /Party Hat/.test(card), `celebration card: "${card.replace(/\s+/g, ' ').slice(0, 80)}"`);
    await wait(800);
    const seen = JSON.parse(await critter.ev('JSON.stringify(window.__seen)'));
    check(seen.unlocked, 'desktop critter switched to the ★ unlocked state');
    check(seen.burst > 0, `confetti burst played (${seen.burst} particles)`);
    check(await panel.ev("SB.state.wardrobe.accessories.find(a => a.key === 'party-hat').locked === null"), 'Party Hat is now unlocked');

    // Wear it via the card's "Wear it" button, like a user would.
    await panel.ev("document.querySelector('.celebrate .cel-actions .btn.primary')?.click()");
    await wait(1200);
    check(await panel.ev("SB.state.wardrobe.outfit.hat === 'party-hat'"), 'outfit now includes the Party Hat');
    check(await panel.ev("SB.state.wardrobe.effects.concat(SB.state.wardrobe.accessories).filter(i => ['party-hat', 'confetti'].includes(i.key)).every(i => !i.isNew)"), "closing the card counts as seeing its rewards (no 'new' badges left on them)");
    const crabRects = await critter.ev("document.querySelectorAll('#sprite .acc-hat rect').length");
    check(crabRects > 0, `desktop critter is wearing it (${crabRects} hat pixels drawn)`);
    const out = path.join(os.tmpdir(), 'shellby-e2e-partyhat.png');
    if (await savePng((m, p) => critter.send(m, p), out)) console.log('critter screenshot:', out);
    panel.ws.close(); critter.ws.close();
  } catch (e) {
    console.error('failed:', e.message);
    fails++;
  } finally {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); process.exit(fails ? 1 : 0); }, 1200);
  }
})();
