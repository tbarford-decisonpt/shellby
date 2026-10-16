// ci: molting at 99: the Molt sheet, the confirm, the badge ring, the tier shell, unlocks kept
// End-to-end check of molting against the dev app over CDP with the fake CLI
// (isolated profile): a crab at level 99 opens the Molt sheet, molts (the
// confirm window answered), and comes back level 1 with the molt badge ring,
// wearing tier shell I, with every level unlock (the Grand aquarium, level
// decor) still his. Then the dev hook puts him at 99 again on the new curve.
// No Claude account, no usage.
//   node scripts/e2e-molt.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { xpForLevel } = require('../src/main/progression/levels');
const { tierShell } = require('../src/main/progression/shells');
const { ACHIEVEMENTS } = require('../src/main/wardrobe/achievements');

const ROOT = path.join(__dirname, '..');
const PORT = 9431;
const HOOK = 47943;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-molt-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, close: () => ws.close(), shot: name => savePng(send, path.join(OUT, `${name}.png`)) };
}

const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const total = xpForLevel(99);
  // Reaching 99 is already his (its trophies and quest pay XP), so the molt keeps exactly `total`.
  const unlocked = ACHIEVEMENTS.filter(a => a.stat === 'level' || a.stat === 'everLevel').map(a => a.id);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, xp: { total, lastDay: today }, wardrobe: { unlocked }, quests: { done: { 'ninety-nine': Date.now() } } }));
  const first = tierShell(1);

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`, '--force-prefers-no-reduced-motion'], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_E2E: '1', SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK) },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) { list = await targets(); await wait(500); }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    await until(panel, "!!window.SB");

    // 1. At 99: the Molt button on the XP card, and the sheet offering tier shell I.
    // Opened as soon as the panel's page is there, which is before its start is over (boot.js):
    // the start keeps it rather than ending on the chat.
    const early = await panel.ev("performance.getEntriesByName('shellby:panel-ready').length === 0");
    await panel.ev("SB.setView('trophies')");
    check(await until(panel, "performance.getEntriesByName('shellby:panel-ready').length > 0", 20000), 'the panel has started');
    check(await panel.ev("SB.state.view") === 'trophies', `Trophies, opened while it was starting${early ? '' : ' (it had already started)'}, stays open`);
    // `=== false`, not `!…?.hidden`: before the XP card is drawn there is no button, and that must not pass.
    check(await until(panel, "document.querySelector('.lv-molt-btn')?.hidden === false"), 'the XP card offers the Molt');
    await panel.ev("document.querySelector('.lv-molt-btn').click()");
    check(await until(panel, "!document.getElementById('moltSheet').hidden"), 'the Molt sheet opens');
    check(await until(panel, `document.getElementById('moltTitle').textContent.includes(${JSON.stringify(first.name)})`), `it offers the ${first.name}`);
    check(await panel.ev("!!document.querySelector('#moltCrab svg .shell-fx')"), 'the tier shell is drawn with its effects');
    await panel.shot('molt-sheet');

    // 2. Molt: Shellby's own confirm window asks first.
    await panel.ev("document.getElementById('moltGo').click()");
    let dlgT = null;
    for (let i = 0; i < 40 && !dlgT; i++) { dlgT = (await targets()).find(t => t.url.endsWith('dialog.html')); await wait(250); }
    check(!!dlgT, 'the confirm window opens');
    if (dlgT) {
      const dlg = await connect(dlgT.webSocketDebuggerUrl);
      await until(dlg, "(document.getElementById('title')?.textContent || '').length > 0");
      check(/^Molt into/.test(await dlg.ev("document.getElementById('title').textContent")), 'it asks to molt');
      await dlg.ev("{ const b = [...document.querySelectorAll('#actions button')].find(b => b.textContent === 'Molt'); setTimeout(() => b.click(), 0); true; }");
      dlg.close();
    }

    // 3. Level 1 again, with the ring, the tier shell and everything kept.
    check(await until(panel, "document.getElementById('brandLevel').textContent === '1'"), `the badge shows level 1 (${await panel.ev("document.getElementById('brandLevel').textContent")})`);
    check(await until(panel, "document.getElementById('brandLevel').dataset.molt === 'I'"), 'the badge wears the molt ring I');
    const xp = await panel.ev('shellby.getXp()');
    check(xp.level === 1 && xp.molts === 1 && xp.everLevel === 99 && xp.total - xp.xp === total, `main: level 1, one molt, everLevel 99, ${total} XP kept (${xp.total} total, ${xp.xp} since)`);
    const homes = await panel.ev('shellby.getHomes()');
    check(homes.worn === 'molt-1', `he wears tier shell I (${homes.worn})`);
    check(homes.shells.filter(s => !s.molt).every(s => !s.locked), 'every level shell is still unlocked');
    const tank = await panel.ev("shellby.getTank ? shellby.getTank() : null");
    if (tank?.sizes) check(tank.sizes.find(s => s.id === 'grand')?.unlocked === true, 'the Grand aquarium is still unlocked');
    await until(panel, "document.getElementById('moltTitle').textContent.startsWith('Molt I')", 4000);
    await panel.shot('molt-done');

    // 4. The dev hook: 99 again on the new curve, and tier shell II is offered.
    const v = await panel.ev("shellby.gameAct('molt', 'dev-level', { level: 99 })");
    check(v?.canMolt === true && v.next.id === 'molt-2', 'back at 99 on the 0.8 curve, tier shell II next');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
