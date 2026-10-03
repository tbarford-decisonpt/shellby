// Shell stickers end to end: a real push from a real repo earns its sticker,
// the critter slaps it on his shell, the trophy unlocks, a release adds its
// marks, and the Sticker Book's editor moves, flips, peels and tidies them.
// A bare repo in a temp folder stands in for GitHub; the fake CLI runs the
// release command. No account, no network beyond this PC.
//   node scripts/e2e-stickers.js            (E2E_SHOTS=<dir> to keep screenshots)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9374;
const HOOK = 47995;
const wait = ms => new Promise(r => setTimeout(r, ms));

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-stickers-')));
const repo = path.join(base, 'tidepool');
const bare = path.join(base, 'origin.git');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const commit = (file, text, msg) => { fs.writeFileSync(path.join(repo, file), text); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', msg); };

fs.mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 't@example.com');
git(repo, 'config', 'user.name', 'T');
git(repo, 'config', 'core.autocrlf', 'false');
commit('index.js', 'x\n', 'init');
commit('lib.js', 'y\n', 'lib');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
git(repo, 'remote', 'add', 'origin', bare);
git(repo, 'push', '-q', '-u', 'origin', 'main');
commit('more.js', 'z\n', 'more');

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: path.join(base, 'userdata'), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK) },
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
    const book = () => panel.ev('shellby.getStickers()');
    await wait(3000);
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await panel.ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);
    await panel.ev('SB.newTab()');
    const tabId = await panel.ev('SB.state.activeTab');

    // Watch the critter's body for the slap's three beats.
    await crab.ev("window.__beats = []; new MutationObserver(() => { for (const c of ['sticker-hold', 'sticker-turn', 'sticker-land']) if (document.body.classList.contains(c) && window.__beats.at(-1) !== c) window.__beats.push(c); }).observe(document.body, { attributes: true, attributeFilter: ['class'] }); true");

    // ---- the first push earns the sticker
    const empty = await book();
    check(empty.projects.length === 0 && empty.totals.projects === 0, 'the Sticker Book starts empty');
    const pushed = await panel.ev(`shellby.pushRepo(${JSON.stringify(tabId)})`);
    check(pushed?.ok && pushed.pushed === 1, `the push goes (${JSON.stringify(pushed)})`);
    check(await until(panel, "[...document.querySelectorAll('.celebrate')].some(c => /New sticker/.test(c.textContent) && /tidepool/.test(c.textContent))"), 'the panel celebrates the new sticker');
    check(await until(crab, "window.__beats.includes('sticker-hold')", 3000), 'he holds it up in his claw');
    check(await crab.ev("!!document.querySelector('#sprite .acc-held')"), '…the sticker is in his claw');
    await crab.shot('stickers-1-hold');
    check(await until(crab, "window.__beats.includes('sticker-turn')", 3000), 'turns his shell to you');
    check(await until(crab, "window.__beats.includes('sticker-land')", 3000), 'and slaps it on');
    await wait(200);
    await crab.shot('stickers-2-landed');
    check(await crab.ev("document.querySelectorAll('#sprite [data-sticker]').length === 1"), 'the sticker is on his shell on the desktop');
    check(await crab.ev("document.querySelector('#sprite [data-sticker]').classList.contains('part-shell')"), 'and moves with the shell');
    check(await crab.ev("/shipped tidepool/.test(document.getElementById('bubbleText').textContent)"), 'he says what shipped');
    let v = await book();
    const p = v.projects[0];
    check(v.projects.length === 1 && p.name === 'tidepool', `one sticker, named for the repo (${p?.name})`);
    check(p.lang === 'JavaScript', `the language comes from the repo's files (${p?.lang})`);
    check(p.ships === 1 && p.tier === 'paper', 'a paper sticker, one ship');
    check(v.shells.find(s => s.worn).stickers.some(s => s.id === p.id), 'it went straight onto the shell he wears');
    check(await until(panel, "shellby.wardrobeView().then(w => w.achievements.find(a => a.id === 'tagged')?.done)", 6000), 'the Tagged trophy unlocks, once the slap has landed');

    // ---- shipping again within the hour counts once
    commit('again.js', 'a\n', 'again');
    await panel.ev("SB.clearCelebrations()");
    await panel.ev(`shellby.pushRepo(${JSON.stringify(tabId)})`);
    await wait(1500);
    v = await book();
    check(v.projects[0].ships === 1, 'a second push in the same hour does not count twice');
    check(!(await panel.ev("[...document.querySelectorAll('.celebrate')].some(c => /New sticker/.test(c.textContent))")), 'and is not a new sticker');

    // ---- a release (run by Claude in the tab) adds its marks
    await panel.ev("SB.send('run gh release create v1.0.0 --notes first')");
    check(await until(panel, "shellby.getStickers().then(v => v.projects[0]?.marks.some(m => m.id === 'v1'))", 10000), 'a 1.0 release adds the release and 1.0 marks');
    v = await book();
    check(v.projects[0].lastVersion === '1.0.0' && v.projects[0].releases === 1, 'and remembers the version');
    check(await until(panel, "[...document.querySelectorAll('.toast')].some(t => /One-point-oh|Released/.test(t.textContent))", 4000), 'the panel says so');
    check((await panel.ev('shellby.wardrobeView()')).achievements.find(a => a.id === 'liftoff')?.done, 'the Liftoff trophy unlocks');

    // ---- the Sticker Book
    await panel.ev("SB.clearCelebrations(); SB.setView('stickers')");
    check(await until(panel, "document.querySelectorAll('#stGrid .st-tile').length === 1"), 'the book shows the sticker');
    check(await panel.ev("document.querySelectorAll('#stSpots .st-spot').length >= 3"), 'his shell has spots to decorate');
    check(await panel.ev("document.querySelectorAll('#stSpots .st-spot.has').length === 1"), 'one of them taken');
    check(await panel.ev("document.getElementById('stTotal').textContent === '1 project shipped'"), 'the heading counts it');
    check(await panel.ev("!document.getElementById('stCrab').querySelector('[data-sticker]') === false"), 'the bench crab wears it too');
    await panel.ev("document.querySelector('#stGrid .st-tile').click()");
    check(await until(panel, "!document.getElementById('stDetail').hidden && /tidepool/.test(document.getElementById('stDetail').textContent)"), 'clicking it opens its page');
    check(await panel.ev("/1\\.0/.test(document.getElementById('stDetail').textContent) && /latest v1\\.0\\.0/.test(document.getElementById('stDetail').textContent)"), 'with its marks and its latest version');
    await panel.shot('stickers-3-book');
    const btn = label => `[...document.querySelectorAll('#stDetail button')].find(b => b.textContent === ${JSON.stringify(label)})`;

    // peel it off
    await panel.ev(`${btn('Take off')}.click()`);
    check(await until(panel, "document.querySelectorAll('#stSpots .st-spot.has').length === 0"), 'Take off peels it off the shell');
    check((await book()).projects.length === 1, '…and it stays in the book');
    check(await until(crab, "document.querySelectorAll('#sprite [data-sticker]').length === 0"), '…and off the desktop crab');

    // put it on a chosen spot
    await panel.ev(`${btn('Put on shell')}.click()`);
    check(await until(panel, "document.getElementById('stBench').classList.contains('holding')"), 'Put on shell asks for a spot');
    check(await panel.ev("document.activeElement?.classList.contains('st-spot')"), 'and focus goes to the spots');
    await panel.ev("document.querySelectorAll('#stSpots .st-spot')[2].click()");
    check(await until(panel, "shellby.getStickers().then(v => v.shells.find(s => s.worn).stickers[0]?.slot === 2)"), 'clicking a spot puts it there');
    check(await until(crab, "document.querySelectorAll('#sprite [data-sticker]').length === 1"), 'the desktop crab follows');

    // keys on a spot
    const key = k => panel.ev(`document.querySelectorAll('#stSpots .st-spot')[2].dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
    await key('f');
    check(await until(panel, "shellby.getStickers().then(v => v.shells.find(s => s.worn).stickers[0]?.flip === true)"), 'F flips it');
    await key('Delete');
    check(await until(panel, "shellby.getStickers().then(v => v.shells.find(s => s.worn).stickers.length === 0)"), 'Delete peels it off');
    await panel.ev("document.getElementById('stArrange').click()");
    check(await until(panel, "shellby.getStickers().then(v => v.shells.find(s => s.worn).stickers.length === 1)"), 'Tidy up puts it back');

    // what friends see
    await panel.ev("document.querySelector('#stCardMode [data-card=\"off\"]').click()");
    check(await until(panel, "shellby.getStickers().then(v => v.card === 'off')"), 'the calling card can leave stickers out');

    // the Outfits stage shows them on his shell too
    await panel.ev("SB.setView('wardrobe')");
    check(await until(panel, "!!document.querySelector('#wdCrab [data-sticker]')"), 'the Wardrobe preview wears them');
    await panel.ev("SB.setView('stickers')");
    await panel.shot('stickers-4-arranged');

    // the crab card: his stickers on the tank glass, and how many projects he's shipped
    const card = await panel.ev("SB.crabCard.render().then(r => ({ url: r.canvas.toDataURL('image/png'), shipped: r.data.shipped, stickers: r.data.stickers.length }))");
    check(card?.shipped === 1 && card.stickers === 1, `the crab card counts it (${JSON.stringify({ shipped: card?.shipped, stickers: card?.stickers })})`);
    if (process.env.E2E_SHOTS && card?.url) fs.writeFileSync(path.join(process.env.E2E_SHOTS, 'stickers-5-card.png'), Buffer.from(card.url.split(',')[1], 'base64'));
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
