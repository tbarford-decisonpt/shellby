// End-to-end check of tide events, sparklies and their cards against the dev
// app over CDP, with the date pinned inside The Haunting (SHELLBY_TODAY) and a
// throwaway profile. The Us page's banner (countdown, four goals, its bug and
// finds, the medal), the Bugdex's event bug out now, the shelf's event finds,
// the sparkly reveal, and the shiny and medal cards saved as 1200x630 PNGs.
// Counts come from source (events.js), never typed in.
//   node scripts/e2e-tides.js [screenshot folder]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const events = require('../src/main/events');

const ROOT = path.join(__dirname, '..');
const PORT = 9351;
const DAY = '2026-10-28';
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const shots = process.argv[2] || null;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const haunting = events.eventById('haunting');
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47966', SHELLBY_E2E: '1', SHELLBY_TODAY: DAY },
  });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
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
    const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const shot = async name => { if (shots) await savePng(send, path.join(shots, `${name}.png`)); };
    await wait(3000);
    await ev(`shellby.setSettings({ onboarded: true, crabOnly: false })`);
    await ev(`SB.tide.refresh()`);
    await wait(500);

    // ---- the banner on the Us page
    const v = await ev(`shellby.getEvents()`);
    check(v?.active?.id === 'haunting', `The Haunting is on (${v?.active?.id})`);
    check(v?.active?.goals?.length === haunting.goals.length, `its ${haunting.goals.length} goals`);
    check(v?.active?.bug?.name === 'Will-o’-Wisp' || v?.active?.bug?.name === "Will-o'-Wisp", `its bug, by name (${v?.active?.bug?.name})`);
    await ev(`SB.setView('us')`);
    await wait(600);
    const banner = JSON.parse(await ev(`JSON.stringify((b => b && { hidden: b.hidden, title: b.querySelector('h3')?.textContent, left: b.querySelector('.ev-left')?.textContent, goals: b.querySelectorAll('.ev-goal').length, extras: b.querySelectorAll('.ev-bug, .ev-find, .ev-medal').length })(document.querySelector('[data-ev-banner="us"]')))`));
    check(banner && !banner.hidden, 'the Us page shows the banner');
    check(banner?.title === `${haunting.name} 2026`, `titled with the year (${banner?.title})`);
    check(/days left|ends tonight/.test(banner?.left || ''), `with a countdown (${banner?.left})`);
    check(banner?.goals === haunting.goals.length, `and every goal (${banner?.goals})`);
    check(banner?.extras === 1 + haunting.finds.length + 1, `its bug, its ${haunting.finds.length} finds and the medal (${banner?.extras})`);
    await shot('tides-us');

    // ---- the Bugdex: the event's bug, out now
    await ev(`SB.setView('bugdex')`);
    await wait(900);
    const tile = await ev(`(t => t && t.textContent)([...document.querySelectorAll('#bdGrid .bd-tile')].find(b => b.dataset.id === '${haunting.bug}'))`);
    check(/Out now/.test(tile || ''), `the Bugdex has ${haunting.bug} out now (${tile})`);
    check(await ev(`!!document.querySelector('#bdFilters [data-filter="tides"]')`), 'and a Tide events filter');
    check(await ev(`!document.querySelector('[data-ev-banner="bugdex"]').hidden`), 'with the banner, small');
    await shot('tides-bugdex');

    // ---- the shelf: the event's finds
    await ev(`SB.setView('finds')`);
    await wait(700);
    const out = await ev(`[...document.querySelectorAll('#fdGrid .fd-rarity')].filter(x => x.textContent === 'Out now').length`);
    check(out === haunting.finds.length, `the shelf has its ${haunting.finds.length} finds out now (${out})`);

    // ---- the sparkly reveal, and its card
    const r = await ev(`shellby.getLife().then(l => l.finds.finds.find(f => f.id === 'pebble'))`);
    await ev(`SB.sparkle.show({ kind: 'find', id: 'pebble', name: 'Smooth pebble', rarity: 'common', pixels: ${JSON.stringify(r.pixels)}, palette: { a: '#99aed8', b: '#c4ccd9', c: '#e6ebf1' }, odds: 128, after: 312, at: Date.now(), level: 12, first: true })`);
    await wait(1200);
    const reveal = JSON.parse(await ev(`JSON.stringify((d => d && { title: d.querySelector('h3')?.textContent, odds: d.querySelector('.sp-odds')?.textContent, focus: document.activeElement?.textContent })(document.querySelector('.sp-reveal')))`));
    check(reveal?.title === 'Smooth pebble', 'the reveal names it');
    check(/^1 in 128 · after 312 finds/.test(reveal?.odds || ''), `with the odds (${reveal?.odds})`);
    check(/Share/.test(reveal?.focus || ''), 'and the keyboard on Share');
    await shot('tides-reveal');
    await ev(`document.activeElement.click()`);
    const saved = async kind => { for (let i = 0; i < 40; i++) { const dir = path.join(profile, 'Shellby'); const f = fs.existsSync(dir) && fs.readdirSync(dir).find(x => x.startsWith(`shellby-${kind}-`)); if (f) return path.join(dir, f); await wait(250); } return null; };
    const shiny = await saved('shiny');
    check(!!shiny, 'Share saves a shiny card');
    if (shiny) {
      const buf = fs.readFileSync(shiny);
      check(buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630, 'a 1200x630 PNG');
      if (shots) fs.copyFileSync(shiny, path.join(shots, 'tides-shiny-card.png'));
    }
    await ev(`document.getElementById('cardClose').click()`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('.sp-reveal')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(300);
    check(await ev(`!document.querySelector('.sp-reveal')`), 'Esc closes the reveal');

    // ---- the medal card
    await ev(`SB.tide.shareMedal({ ...SB.state.events.active, pixels: SB.state.events.active.medal.pixels, palette: SB.state.events.active.medal.palette })`);
    const medal = await saved('medal');
    check(!!medal, 'the medal card saves too');
    if (medal && shots) fs.copyFileSync(medal, path.join(shots, 'tides-medal-card.png'));
    await ev(`document.getElementById('cardClose').click()`);

    // ---- off: the banner goes
    await ev(`shellby.setSettings({ tideEvents: false }).then(() => SB.tide.refresh())`);
    await wait(500);
    check(await ev(`document.querySelector('[data-ev-banner="us"]').hidden`), 'Tide events off hides the banner');
  } catch (e) {
    console.log(`FAIL  ${e.stack || e}`);
    fails++;
  } finally {
    app.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still closing */ }
  }
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
