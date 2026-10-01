// End-to-end check of health moods against the dev app over CDP, one launch per
// fake scenario (SHELLBY_FAKE_HEALTH), each in a throwaway profile. Checks the
// desktop critter's mood + bubble, the Health view, and the Health badge in the bottom bar, and
// saves screenshots of both windows.
//   node scripts/e2e-health.js [outDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9343;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-health-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

const SCENARIOS = [
  { name: 'calm', mood: null, title: 'All calm', badge: false },
  { name: 'hot', mood: 'hot', title: 'Running hot', badge: 'warn', bubble: /^8\d°$/, card: ['gpu-temp:0', 'lvl-warn'] },
  { name: 'scorching', mood: 'scorching', title: 'Overheating!', badge: 'critical', bubble: /^9\d°$/, card: ['cpu-temp', 'lvl-critical'] },
  { name: 'dizzy', mood: 'dizzy', title: "Memory's nearly full", badge: 'warn', bubble: /^9\d%$/, card: ['ram', 'lvl-warn'] },
  { name: 'stuffed', mood: 'stuffed', title: 'C: is filling up', badge: 'critical', bubble: /^C: 8\.4 GB$/ },
  { name: 'nocpu', mood: null, title: 'All calm', badge: false, setup: true },
];

async function launch(scenario) {
  const env = { ...process.env, SHELLBY_FAKE_HEALTH: scenario, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')) };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env });
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
  return { app, critter, panel };
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await wait(250); }
  return v;
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  for (const sc of SCENARIOS) {
    const { app, critter, panel } = await launch(sc.name);
    try {
      await wait(2500);
      if (await panel.ev('document.visibilityState') !== 'visible') await critter.ev('window.shellby.critter.click()');
      await wait(600);
      // Desktop first: opening the Health view earns the Check-Up trophy, and the
      // unlock celebration (★) would take over the bubble for a few seconds.
      const mood = await until(async () => {
        const m = await critter.ev("document.getElementById('self').dataset.health || ''");
        return sc.mood ? m === sc.mood && m : await wait(2000).then(() => 'none');
      });
      check((mood === 'none' ? null : mood) === sc.mood, `${sc.name}: desktop mood is ${sc.mood ?? 'none'} (got ${mood})`);

      const bubble = await critter.ev("document.body.classList.contains('bubble-on') ? document.getElementById('bubbleText').textContent : ''");
      if (sc.bubble) check(sc.bubble.test(bubble), `${sc.name}: bubble shows the reading (${JSON.stringify(bubble)})`);
      else check(bubble === '', `${sc.name}: no bubble`);
      if (sc.mood) {
        const overlays = await critter.ev("document.querySelectorAll('#healthFx .hfx').length");
        check(overlays > 0, `${sc.name}: ${overlays} pixel overlays drawn`);
      }

      await panel.ev("SB.setView('health')");
      const trophy = await until(() => critter.ev("document.body.classList.contains('state-unlocked')"), 4000);
      check(!!trophy, `${sc.name}: opening Health celebrates the Check-Up trophy`);

      const title = await until(async () => { const t = await panel.ev("document.getElementById('hlTitle').textContent"); return t.startsWith(sc.title) && t; });
      check(!!title, `${sc.name}: hero says "${sc.title}"`);
      const heroMood = await panel.ev("document.getElementById('hlHero').dataset.health || ''");
      check((heroMood || null) === sc.mood, `${sc.name}: hero crab mood ${heroMood || 'none'}`);
      const ask = await panel.ev("!document.getElementById('hlAsk').hidden");
      check(ask === !!sc.mood, `${sc.name}: "Ask Shellby" ${sc.mood ? 'shown' : 'hidden'}`);

      const badge = await panel.ev("(b => b.hidden ? false : b.classList.contains('critical') ? 'critical' : 'warn')(document.getElementById('healthBadge'))");
      check(badge === sc.badge, `${sc.name}: Health badge ${sc.badge || 'hidden'} (got ${badge})`);

      const cards = await panel.ev("document.querySelectorAll('#hlGauges .hl-gauge').length");
      check(cards === 5, `${sc.name}: 5 gauges (got ${cards})`);
      if (sc.card) {
        const cls = await panel.ev(`document.querySelector('.hl-gauge[data-id="${sc.card[0]}"]')?.className || ''`);
        check(cls.includes(sc.card[1]), `${sc.name}: ${sc.card[0]} card is ${sc.card[1]}`);
      }
      const disks = await panel.ev("document.querySelectorAll('#hlDisks .hl-disk').length");
      check(disks === 2, `${sc.name}: 2 drives listed`);
      const setup = await panel.ev("!document.getElementById('hlSetup').hidden");
      check(setup === !!sc.setup, `${sc.name}: LHM setup card ${sc.setup ? 'shown' : 'hidden'}`);

      // No layout overflow sideways in the Health view.
      const overflow = await panel.ev("(v => v.scrollWidth - v.clientWidth)(document.getElementById('healthView'))");
      check(overflow <= 0, `${sc.name}: no horizontal overflow (${overflow}px)`);

      await wait(1600); // let a sparkline point or two land and the overlays animate in
      for (const [who, page] of [['panel', panel], ['critter', critter]]) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT, `${sc.name}-${who}.png`), Buffer.from(shot.data, 'base64'));
      }
    } catch (e) {
      check(false, `${sc.name}: ${e.message}`);
    } finally {
      app.kill();
      await wait(1200);
    }
  }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
