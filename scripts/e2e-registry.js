// End-to-end: one-click install from the LIVE community registry.
//   1. warm: Shellby is running; a shellby://install link arrives as a second launch
//   2. cold: the link itself launches Shellby (panel must end on the Wardrobe)
// The native "Install pack?" dialog is read and clicked with Windows UI Automation.
// Isolated profiles (SHELLBY_USER_DATA): your real Shellby is untouched.
//   node scripts/e2e-registry.js [pack-id]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PACK = process.argv[2] || 'tiny-hats';
const LINK = `shellby://install?pack=${PACK}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

// Finds Shellby's confirmation window (its own isolated window), reports what it
// shows, screenshots it, and clicks the named button inside that window.
async function clickInWindow(port, label = 'Install', shotName = null) {
  for (let i = 0; i < 80; i++) {
    let t;
    try { t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.url.endsWith('dialog.html')); } catch { /* not yet */ }
    if (t) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise(r => { ws.onopen = r; });
      let id = 0; const p = new Map();
      ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
      const send = (method, params = {}) => new Promise(r => { const n = ++id; p.set(n, m => r(m.result)); ws.send(JSON.stringify({ id: n, method, params })); });
      const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;
      for (let k = 0; k < 20 && !(await ev("document.getElementById('title').textContent")); k++) await wait(150);
      await wait(400);
      const info = JSON.parse(await ev(`JSON.stringify({ title: document.getElementById('title').textContent, message: document.getElementById('message').textContent,
        items: [...document.querySelectorAll('.item .nm')].map(n => n.textContent), buttons: [...document.querySelectorAll('button')].map(b => b.textContent) })`));
      if (shotName) {
        const img = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(os.tmpdir(), shotName), Buffer.from(img.data, 'base64'));
      }
      await ev(`[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)})?.click()`);
      ws.close();
      return info;
    }
    await wait(500);
  }
  return null;
}

async function cdpPanel(port) {
  let t;
  for (let i = 0; i < 60 && !t; i++) {
    try { t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.url.endsWith('panel.html')); } catch { /* starting */ }
    await wait(500);
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
  return { ev, close: () => ws.close() };
}

async function verify(panel, label) {
  let toast = '';
  for (let i = 0; i < 40; i++) {
    toast = await panel.ev("document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent");
    if (/Installed|already|Couldn/i.test(toast)) break;
    await wait(500);
  }
  check(/Installed/.test(toast) && !/null|undefined/.test(toast), `${label}: success toast ("${toast.replace(/\s+/g, ' ').slice(0, 70)}")`);
  const packs = await panel.ev('JSON.stringify((SB.state.wardrobe?.packs || []).map(p => p.id))');
  check(JSON.parse(packs || '[]').includes(PACK), `${label}: ${PACK} is installed (${packs})`);
  check(await panel.ev('document.body.dataset.view') === 'wardrobe', `${label}: panel is showing the Wardrobe`);
}

(async () => {
  const procs = [];
  const profiles = [];
  const launch = (profile, port, extra = []) => {
    const p = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${port}`, ...extra], { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile } });
    procs.push(p);
    return p;
  };
  try {
    // ---- warm: running app receives the link from a second launch
    const warm = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-reg-'));
    profiles.push(warm);
    launch(warm, 9351);
    const panel = await cdpPanel(9351);
    await wait(3500);
    launch(warm, 9352, [LINK]);  // second instance: forwards argv to the first and exits
    const info = await clickInWindow(9351, 'Install', 'shellby-confirm-install.png');
    console.log('  confirm window:', JSON.stringify(info));
    check(!!info && info.title === 'Install wardrobe pack?', 'warm: themed "Install wardrobe pack?" window appeared and was confirmed');
    check(!!info && /Tiny Hats/i.test(info.message), 'warm: it names the pack');
    check(!!info && /community registry/i.test(info.message), 'warm: it says the pack came from the community registry');
    check(!!info && info.items.length >= 6, `warm: it previews every item (${info && info.items.join(', ')})`);
    await verify(panel, 'warm');
    panel.close();

    // ---- cold: the link launches Shellby
    const cold = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-reg-'));
    profiles.push(cold);
    // A real user has finished setup; a brand-new profile would (correctly) show setup first.
    fs.writeFileSync(path.join(cold, 'settings.json'), JSON.stringify({ onboarded: true }));
    launch(cold, 9353, [LINK]);
    const panel2 = await cdpPanel(9353);
    const info2 = await clickInWindow(9353, 'Install');
    check(!!info2, 'cold: confirm window appeared and was confirmed');
    await verify(panel2, 'cold');
    panel2.close();
  } catch (e) {
    console.error('failed:', e.message);
    fails++;
  } finally {
    for (const p of procs) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F']);
    setTimeout(() => { for (const d of profiles) fs.rmSync(d, { recursive: true, force: true }); process.exit(fails ? 1 : 0); }, 1500);
  }
})();
