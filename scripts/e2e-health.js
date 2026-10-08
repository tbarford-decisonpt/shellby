// End-to-end check of health moods against the dev app over CDP, one launch per
// fake scenario (SHELLBY_FAKE_HEALTH), each in a throwaway profile. Checks the
// desktop critter's mood + bubble, the Health view, and the Health badge in the bottom bar, and
// saves screenshots of both windows.
//   node scripts/e2e-health.js [outDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9343;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-health-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

const SCENARIOS = [
  { name: 'calm', mood: null, title: 'All calm', badge: false },
  { name: 'hot', mood: 'hot', title: 'Running hot', badge: 'warn', bubble: /^8\d°$/, card: ['gpu-temp:0', 'lvl-warn'], hogs: ['GPU', 'Cyberpunk2077'] },
  { name: 'scorching', mood: 'scorching', title: 'Overheating!', badge: 'critical', bubble: /^9\d°$/, card: ['cpu-temp', 'lvl-critical'], hogs: ['CPU', 'Cyberpunk2077'] },
  { name: 'dizzy', mood: 'dizzy', title: "Memory's nearly full", badge: 'warn', bubble: /^9\d%$/, card: ['ram', 'lvl-warn'], hogs: ['Memory', 'Cyberpunk2077'] },
  { name: 'stuffed', mood: 'stuffed', title: 'C: is filling up', badge: 'critical', bubble: /^C: 8\.4 GB$/ },
  { name: 'nocpu', mood: null, title: 'All calm', badge: false, setup: true, cards: 5, fans: false },
  // Kinds with no gauge-era hero copy of their own: worded from the check's reading.
  { name: 'hotdrive', mood: 'hot', title: 'Running hot', sub: /^Drive \(Samsung SSD 980 PRO 1TB\) is at 7\d°C, over your 70°C line/, badge: 'warn', bubble: /^7\d°$/, card: ['storage-temp:0', 'lvl-warn'] },
  { name: 'cluttered', mood: 'stuffed', title: '70 GB of developer clutter', sub: /^Mostly Docker, npm cache, pip cache\./, badge: 'warn', bubble: /^70 GB$/, ask: "Ask Shellby what's safe to clear" },
];

async function launch(scenario) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  // Quiet: the scenarios with no health mood assert an empty bubble, and one of
  // his own lines ("morning", an idle mutter) lands in the same bubble. Whether
  // one was due by the time we looked depended on how fast the machine booted
  // him, which made this pass here and fail on a slower CI runner.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ chatter: 'quiet' }, null, 2));
  const env = { ...process.env, SHELLBY_FAKE_HEALTH: scenario, SHELLBY_USER_DATA: profile };
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
      else check(bubble === '', `${sc.name}: no bubble (${JSON.stringify(bubble)})`);
      if (sc.mood) {
        const overlays = await critter.ev("document.querySelectorAll('#healthFx .hfx').length");
        check(overlays > 0, `${sc.name}: ${overlays} pixel overlays drawn`);
      }

      await panel.ev("SB.setView('health')");
      const trophy = await until(() => critter.ev("document.body.classList.contains('state-unlocked')"), 4000);
      check(!!trophy, `${sc.name}: opening Health celebrates the Check-Up trophy`);

      const title = await until(async () => { const t = await panel.ev("document.getElementById('hlTitle').textContent"); return t.startsWith(sc.title) && t; });
      check(!!title, `${sc.name}: hero says "${sc.title}"`);
      const sub = await panel.ev("document.getElementById('hlSub').textContent");
      check(!/undefined|NaN/.test(sub), `${sc.name}: hero line has no undefined/NaN (${JSON.stringify(sub)})`);
      if (sc.sub) check(sc.sub.test(sub), `${sc.name}: hero line reads right`);
      if (sc.ask) check(await panel.ev("document.getElementById('hlAsk').textContent") === sc.ask, `${sc.name}: ask button says "${sc.ask}"`);
      const heroMood = await panel.ev("document.getElementById('hlHero').dataset.health || ''");
      check((heroMood || null) === sc.mood, `${sc.name}: hero crab mood ${heroMood || 'none'}`);
      const ask = await panel.ev("!document.getElementById('hlAsk').hidden");
      check(ask === !!sc.mood, `${sc.name}: "Ask Shellby" ${sc.mood ? 'shown' : 'hidden'}`);

      const badge = await panel.ev("(b => b.hidden ? false : b.classList.contains('critical') ? 'critical' : 'warn')(document.getElementById('healthBadge'))");
      check(badge === sc.badge, `${sc.name}: Health badge ${sc.badge || 'hidden'} (got ${badge})`);

      // GPU temp, CPU temp, memory, CPU load, GPU load and the NVMe's temperature
      // (which comes from LHM, so it's missing with the CPU temperature).
      const want = sc.cards ?? 6;
      const cards = await panel.ev("document.querySelectorAll('#hlGauges .hl-gauge').length");
      check(cards === want, `${sc.name}: ${want} gauges (got ${cards})`);
      if (sc.card) {
        const cls = await panel.ev(`document.querySelector('.hl-gauge[data-id="${sc.card[0]}"]')?.className || ''`);
        check(cls.includes(sc.card[1]), `${sc.name}: ${sc.card[0]} card is ${sc.card[1]}`);
      }
      const fans = await panel.ev("document.getElementById('hlFansBlock').hidden ? 0 : document.querySelectorAll('#hlFans .hl-fan').length");
      check(sc.fans === false ? fans === 0 : fans === 3, `${sc.name}: ${fans} fans listed`);
      const disks = await panel.ev("document.querySelectorAll('#hlDisks .hl-disk').length");
      check(disks === 2, `${sc.name}: 2 drives listed`);
      const clutter = await until(() => panel.ev("document.getElementById('hlSpace').hidden ? 0 : document.querySelectorAll('#hlSpaceList .hl-space-row').length"));
      check(clutter === 4, `${sc.name}: developer clutter lists Docker, 2 caches and a virtual disk (${clutter} rows)`);
      // What's hogging it: opens itself while he sweats or is dizzy, sorted by what explains it.
      const hogsOpen = await panel.ev("document.getElementById('hlHogs').dataset.open === 'true'");
      check(hogsOpen === !!sc.hogs, `${sc.name}: "What's hogging it" ${sc.hogs ? 'open' : 'closed'}`);
      if (sc.hogs) {
        const top = await until(() => panel.ev("document.querySelector('#hlHogList .hl-hog-name')?.textContent || ''"));
        const by = await panel.ev("document.querySelector('#hlHogsSeg [aria-selected=\"true\"]')?.textContent || ''");
        check(by === sc.hogs[0] && top === sc.hogs[1], `${sc.name}: hogs by ${by}, top is ${top}`);
        const ends = await panel.ev("document.querySelectorAll('#hlHogList .hl-hog-end').length");
        check(ends > 0, `${sc.name}: ${ends} End task buttons`);
        // By app: the two chrome processes are one row.
        const chrome = await panel.ev("[...document.querySelectorAll('#hlHogList .hl-hog')].filter(r => r.querySelector('.hl-hog-name').textContent === 'chrome').map(r => r.querySelector('.hl-hog-count')?.textContent || '')");
        check(chrome.length <= 1 && (!chrome.length || chrome[0] === '×2'), `${sc.name}: chrome grouped (${JSON.stringify(chrome)})`);
      } else if (sc.name === 'calm') {
        // Calm: closed, but one click away.
        await panel.ev("document.getElementById('hlHogsOpen').click()");
        const top = await until(() => panel.ev("document.querySelector('#hlHogList .hl-hog-name')?.textContent || ''"));
        check(top === 'Cyberpunk2077', `calm: "See what's using it" opens the list (top ${top})`);
        await panel.ev("document.querySelector('#hlHogsGroup [data-group=proc]').click()");
        const rows = await panel.ev("document.querySelectorAll('#hlHogList .hl-hog').length");
        check(rows === 8, `calm: "Each" lists single processes (${rows})`);
        await panel.ev("document.getElementById('hlHogsClose').click()");
        // His own footprint, real (getAppMetrics), above the list: two readings
        // 5 s apart, so give it a sample or two.
        const self = await until(() => panel.ev("document.getElementById('hlSelf').hidden ? '' : document.getElementById('hlSelfLine').textContent"), 15000);
        check(/^Shellby himself: [\d.]+% CPU, \d+(\.\d)? (MB|GB)$/.test(self), `calm: his own footprint is shown (${JSON.stringify(self)})`);
        const hint = await panel.ev("document.getElementById('hlSelfHint').hidden ? '' : document.getElementById('hlSelfHintText').textContent");
        check(!/undefined|NaN/.test(hint), `calm: footprint hint reads right (${JSON.stringify(hint) || 'none'})`);
      }
      if (sc.card && sc.name === 'hot') {
        // A live sample must not take focus away from a card's button.
        await panel.ev(`document.querySelector('.hl-gauge[data-id="${sc.card[0]}"] .hl-mini').focus()`);
        await wait(6000);
        const kept = await panel.ev(`document.activeElement === document.querySelector('.hl-gauge[data-id="${sc.card[0]}"] .hl-mini')`);
        check(kept, `${sc.name}: focus survives a live sample`);
        await panel.ev("document.querySelector('#hlRange [data-range=\"3600000\"]').click()");
        check(await panel.ev("document.querySelector('#hlRange [aria-selected=\"true\"]').textContent") === '1 hour', `${sc.name}: graph range switches to an hour`);
        await panel.ev("document.querySelector('#hlRange [data-range=\"600000\"]').click()");
        const stats = await panel.ev(`document.querySelector('.hl-gauge[data-id="${sc.card[0]}"] .hl-gstats').textContent`);
        check(/^↓\d+° ↑\d+°$/.test(stats), `${sc.name}: low/peak under the graph (${JSON.stringify(stats)})`);
        // An alert in the log takes you to the moment on its graph.
        await panel.ev(`[...document.querySelectorAll('#hlLog .hl-logbtn')].find(b => /GPU/.test(b.textContent))?.click()`);
        const marked = await panel.ev(`(c => c.classList.contains('marked') && !!c.querySelector('.hl-spark-mark'))(document.querySelector('.hl-gauge[data-id="${sc.card[0]}"]'))`);
        check(marked, `${sc.name}: picking the alert marks it on the GPU graph`);
      }
      const startup = await until(() => panel.ev("document.querySelectorAll('#hlStartup .hl-start').length"));
      const startupSum = await panel.ev("document.getElementById('hlStartupSum').textContent");
      check(startup === 10 && /^9 things start/.test(startupSum), `${sc.name}: startup list (${startup} rows, "${startupSum}")`);
      check(await panel.ev("!document.getElementById('hlAskStartup').disabled"), `${sc.name}: startup audit button enabled`);
      const setup = await panel.ev("!document.getElementById('hlSetup').hidden && document.getElementById('hlSensorsFold').open");
      check(setup === !!sc.setup, `${sc.name}: LHM setup card ${sc.setup ? 'shown, fold open' : 'hidden'}`);
      check(await panel.ev("!document.getElementById('hlSettingsFold').open"), `${sc.name}: alert settings folded away`);

      // No layout overflow sideways in the Health view.
      const overflow = await panel.ev("(v => v.scrollWidth - v.clientWidth)(document.getElementById('healthView'))");
      check(overflow <= 0, `${sc.name}: no horizontal overflow (${overflow}px)`);

      await wait(1600); // let a sparkline point or two land and the overlays animate in
      for (const [who, page] of [['panel', panel], ['critter', critter]]) {
        await savePng((m, p) => page.send(m, p), path.join(OUT, `${sc.name}-${who}.png`));
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
