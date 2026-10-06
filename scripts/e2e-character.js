// End-to-end check of the character sheet against the dev app over CDP. Seeds
// XP that makes him a Tester (Rigour well ahead) with some of it this week,
// runs a passing test task so the first class is announced, then checks the
// Trophies page's sheet and draws the weekly card with its nameplate.
// No Claude account, no usage.
//   node scripts/e2e-character.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dayKey } = require('../src/main/weekly');

const ROOT = path.join(__dirname, '..');
const PORT = 9353;
const HOOK = 47995;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-character-'));
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));

// Rigour 40ish, Shipping 20ish, Craft and Tidiness lower: a Tester, gaining this week.
// lastDay is today, so the day's XP at startup (before the panel listens) finds no class.
function seed(dir) {
  const today = dayKey(Date.now()), yesterday = dayKey(Date.now() - 86400000);
  const byKind = { tests: 6000, fixed: 2000, ship: 1600, deploy: 200, trick: 600, tidy: 150, fresh: 40, task: 3000 };
  const total = Object.values(byKind).reduce((n, v) => n + v, 0);
  const xp = { total, byDevice: { legacy: total }, byKind, dailyKinds: { [today]: { tests: 500, ship: 120 }, [yesterday]: { tests: 300, trick: 150 } }, daily: { [today]: 620, [yesterday]: 450 }, lastDay: today };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: true, xp }));
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  seed(data);
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK) },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const ws = new WebSocket(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const shot = async name => fs.writeFileSync(path.join(OUT, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await wait(3000);
    await ev("shellby.dev?.life?.({ what: 'call', on: false }); SB.setView('chat'); true");

    const sheet = (await ev('shellby.getXp()')).character;
    check(sheet?.cls?.name === 'Tester', `seeded stats make him a Tester (${sheet?.cls?.name})`);
    check(sheet?.stats?.length === 4 && sheet.stats.map(s => s.name).join() === 'Shipping,Rigour,Craft,Tidiness', 'four stats, in order');
    check(sheet?.stats.find(s => s.id === 'rigour').gain > 0, 'Rigour gained points this week');

    // A passing test run: the first award since seeding finds his first class.
    await ev("SB.send('run npm test')");
    await until('!SB.activeTab().busy && document.querySelectorAll(".msg.user").length > 0');
    check(await until("[...document.querySelectorAll('.celebrate .cel-eyebrow')].some(e => e.textContent === 'New class')", 6000), 'a new class is celebrated');
    check(await ev("[...document.querySelectorAll('.celebrate .cel-title')].some(e => e.textContent === 'Tester')"), '...and it is Tester');
    check((await ev('shellby.getXp()')).character.seen.some(c => c.id === 'rigour'), 'the class is remembered');
    await shot('class-celebration.png');
    await ev("(document.querySelector('.celebrate .cel-all') || document.querySelector('.celebrate .cel-close'))?.click()");

    // The Trophies page.
    await ev("SB.setView('trophies')");
    await wait(600);
    check(await ev("!document.getElementById('xpSheet').hidden"), 'the character sheet shows on Trophies');
    check(await ev("document.getElementById('xpClassName').textContent") === 'Tester', 'it names his class');
    check(await ev("document.querySelectorAll('#xpStats li').length") === 4, 'it lists four stats');
    check(await ev("document.querySelector('#xpStats li.top .xp-stat-name')?.textContent") === 'Rigour', 'the class stat is highlighted');
    check(await ev("[...document.querySelectorAll('.xp-stat-gain')].some(e => /^\\+\\d+$/.test(e.textContent))"), "this week's gains show");
    const box = await ev("(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }))((document.getElementById('xpSheet').scrollIntoView({ block: 'center' }), document.getElementById('xpSheet').getBoundingClientRect()))");
    fs.writeFileSync(path.join(OUT, 'sheet.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } })).data, 'base64'));

    // The weekly card, drawn straight from its renderer.
    const png = await ev("SB.weekCard.render().then(r => r.canvas.toDataURL('image/png'))");
    check(typeof png === 'string' && png.startsWith('data:image/png'), 'the weekly card draws');
    if (png) fs.writeFileSync(path.join(OUT, 'week-card.png'), Buffer.from(png.split(',')[1], 'base64'));
    check((await ev('shellby.getWeek()')).character?.cls?.name === 'Tester', 'the week carries the sheet');

    // Just the crab: every stat is Claude work, so the sheet steps aside.
    await ev("SB.state.settings.crabOnly = true; SB.views.trophies.render(); true");
    await wait(300);
    check(await ev("document.getElementById('xpSheet').hidden"), 'just-the-crab hides the sheet');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
