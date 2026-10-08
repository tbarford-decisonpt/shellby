// Stickers through a molt, end to end: Shellby starts one push short of level 3
// with stickers on the shell he hatched with. The push levels him up, so he
// moves into the Snail Shell, and the same push ships a new project. His three
// most shipped stickers come with him, the old shell keeps all of its own, and
// the new sticker lands on the new shell.
//   node scripts/e2e-stickers-molt.js       (E2E_SHOTS=<dir> to keep screenshots)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9375;
const HOOK = 47996;
const wait = ms => new Promise(r => setTimeout(r, ms));

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-molt-')));
const repo = path.join(base, 'kelp');
const bare = path.join(base, 'origin.git');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
fs.mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 't@example.com');
git(repo, 'config', 'user.name', 'T');
git(repo, 'config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'main.py'), 'x\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-qm', 'init');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
git(repo, 'remote', 'add', 'origin', bare);

// Level 2, 10 XP short of level 3 (a push is worth 40), with four stickers on his own shell.
const now = Date.now();
const ids = ['111111111111', '222222222222', '333333333333', '444444444444'];
const ships = [2, 9, 5, 12];
const projects = Object.fromEntries(ids.map((id, i) => [id, { name: `old-${i + 1}`, firstShipAt: now - 86400000, lastShipAt: now - 3600000, ships: ships[i] }]));
const userData = path.join(base, 'userdata');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  onboarded: true,
  xp: { total: 240, log: [], lastDay: new Date().toISOString().slice(0, 10) },
  stickers: { projects, layouts: { home: ids.map((id, i) => ({ id, slot: i, z: i + 1 })) } },
}));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: userData, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK) },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !['panel.html', 'critter.html'].every(n => list.some(t => t.url.endsWith(n))); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const connect = async name => {
      const ws = new WebSocket(list.find(t => t.url.endsWith(name)).webSocketDebuggerUrl);
      await new Promise(r => { ws.onopen = r; });
      let id = 0; const p = new Map();
      ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
      const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
      const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
      const shot = async n => {
        if (!process.env.E2E_SHOTS) return;
        const r = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(process.env.E2E_SHOTS, `${n}.png`), Buffer.from(r.data, 'base64'));
      };
      return { ev, shot };
    };
    const panel = await connect('panel.html');
    const crab = await connect('critter.html');
    const until = async (c, expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    await wait(3000);
    await panel.ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);
    await panel.ev('SB.newTab()');
    const tabId = await panel.ev('SB.state.activeTab');

    check(await crab.ev("document.querySelectorAll('#sprite [data-sticker]').length === 4"), 'he starts with four stickers on his own shell');
    await crab.ev("window.__moltStickers = []; new MutationObserver(() => { if (document.body.classList.contains('molt-in')) window.__moltStickers.push(document.querySelectorAll('#sprite [data-sticker]').length); }).observe(document.body, { attributes: true, attributeFilter: ['class'] }); true");

    const pushed = await panel.ev(`shellby.pushRepo(${JSON.stringify(tabId)})`);
    check(pushed?.ok && pushed.pushed >= 1, 'the push goes');
    check(await until(panel, "shellby.getXp().then(v => v.level === 3)"), 'and levels him up');
    check(await until(crab, 'window.__moltStickers.length > 0', 6000), 'he molts');
    check(await crab.ev('window.__moltStickers.every(n => n === 3)'), 'the new shell arrives with the three he carried');
    await crab.shot('molt-1-in');
    check(await until(panel, "shellby.getStickers().then(v => v.shells.find(s => s.worn)?.id === 'snail')", 8000), 'he lives in the Snail Shell now');
    const v = await panel.ev('shellby.getStickers()');
    const snail = v.shells.find(s => s.id === 'snail');
    const home = v.shells.find(s => s.id === 'home');
    const carried = snail.stickers.map(s => s.id).filter(id => ids.includes(id)).sort();
    check(JSON.stringify(carried) === JSON.stringify(['222222222222', '333333333333', '444444444444']), `his three most shipped came along (${carried})`);
    check(home.stickers.length === 4, 'the old shell keeps all four');
    check(await until(panel, "shellby.getStickers().then(v => v.shells.find(s => s.id === 'snail').stickers.some(s => !['111111111111','222222222222','333333333333','444444444444'].includes(s.id)))", 8000), 'the new project’s sticker went on the new shell');
    check(await until(crab, "document.querySelectorAll('#sprite [data-sticker]').length === 4", 8000), 'and the desktop crab wears all four on the Snail Shell');
    await wait(800);
    await crab.shot('molt-2-after');

    // The Sticker Book offers both shells to decorate.
    await panel.ev("SB.clearCelebrations(); SB.setView('stickers')");
    check(await until(panel, "document.querySelectorAll('#stShells .st-shell-chip').length === 2"), 'the book offers both shells');
    await panel.ev("[...document.querySelectorAll('#stShells .st-shell-chip')].find(b => /His own shell/.test(b.textContent)).click()");
    check(await until(panel, "document.querySelectorAll('#stSpots .st-spot.has').length === 4"), 'and shows the old one with its four');
    await panel.shot('molt-3-book');
  } catch (e) {
    console.log('FAIL  crashed:', e.message);
    fails++;
  } finally {
    app.kill();
    await wait(1500);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* Windows may still hold it */ }
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
