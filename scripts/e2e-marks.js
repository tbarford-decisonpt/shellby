// ci: marks past level 99: the badge, the XP card, the celebration and the bubble
// End-to-end check of marks (★) against the dev app over CDP with the fake CLI
// (isolated profile): a crab a few XP short of his first mark finishes a task,
// and the titlebar badge, the Trophies XP card, the celebration card and his
// desktop bubble all show ★1. No Claude account, no usage.
//   node scripts/e2e-marks.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { xpForLevel, xpForMarks, AWARDS } = require('../src/main/xp');
const { ACHIEVEMENTS } = require('../src/main/wardrobe/achievements');

const ROOT = path.join(__dirname, '..');
const PORT = 9403;
const HOOK = 47919;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-marks-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, shot: name => savePng(send, path.join(OUT, `${name}.png`)) };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Level 99, one task short of his first mark (today's "day" XP already earned).
  // The level trophies and the Reach level 99 quest are already his: the day's
  // first award reports his level, and their XP would cross the mark before the task does.
  const short = AWARDS.task.xp - 1;
  const total = xpForLevel(99) + xpForMarks(1) - short;
  const unlocked = ACHIEVEMENTS.filter(a => a.stat === 'level' || a.stat === 'everLevel').map(a => a.id);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, xp: { total, lastDay: today }, wardrobe: { unlocked }, quests: { done: { 'ninety-nine': Date.now() } } }));

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK) },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html'))); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    const badge = () => panel.ev("document.getElementById('brandLevel').textContent");
    await until(panel, "!document.getElementById('brandLevel').hidden");
    // Every card that's celebrated (they queue, so one may wait behind a trophy's) and every bubble he shows.
    await panel.ev('window.__cel = []; const o = SB.celebrate; SB.celebrate = c => { window.__cel.push(c.title); o(c); }; true');
    await critter.ev("window.__bubbles = new Set(); new MutationObserver(() => window.__bubbles.add(document.getElementById('bubbleText').textContent)).observe(document.getElementById('bubbleText'), { childList: true, characterData: true, subtree: true }); true");

    // 1. At 99 with no marks yet: a plain badge, and the card counts down to ★1.
    check(await badge() === '99', `the badge shows 99 (${await badge()})`);
    await panel.ev("SB.setView('trophies')");
    check(await until(panel, `document.getElementById('xpNext').textContent === 'Every shell, title and badge is his! ${short} XP to ★1'`, 3000),
      `the card counts down to the first mark ("${await panel.ev("document.getElementById('xpNext').textContent")}")`);

    // 2. A finished task crosses it. Tabs come back a moment after the panel
    // does, and a send with no tab yet goes nowhere.
    await panel.ev("SB.setView('chat')");
    check(await until(panel, '!!SB.activeTab()'), 'a tab to send in');
    check(await panel.ev("SB.send('hello')") === true, 'the task is sent');
    check(await until(panel, "document.getElementById('brandLevel').textContent === '99★1'"), `the badge shows 99★1 (${await badge()})`);
    check(await until(panel, "window.__cel.some(t => t.startsWith('★1 · '))", 4000), `a mark celebration card (${await panel.ev('window.__cel.join(" | ")')})`);
    check(await until(critter, "window.__bubbles.has('★1')", 6000), `his bubble says ★1 (${await critter.ev('[...window.__bubbles].join(" | ")')})`);
    const xp = await panel.ev('shellby.getXp()');
    check(xp.level === 99 && xp.marks === 1 && xp.needed === xpForMarks(2) - xpForMarks(1), `main reports level 99, ★1, ${xp.needed} XP to the next`);

    // 3. The Trophies card shows it too.
    await panel.ev('SB.clearCelebrations()');
    await panel.ev("SB.setView('trophies')");
    check(await until(panel, "/★1$/.test(document.getElementById('xpEyebrow').textContent)", 3000), `the eyebrow shows ★1 (${await panel.ev("document.getElementById('xpEyebrow').textContent")})`);
    check(/^[\d,]+ XP to ★2$/.test(await panel.ev("document.getElementById('xpNext').textContent")), 'the card counts down to ★2');
    check(/1 mark/.test(await panel.ev("document.getElementById('brandLevel').getAttribute('aria-label')")), 'the badge reads its mark aloud');
    await panel.shot('xp-card-marks');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
