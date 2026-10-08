// The Bugdex, end to end against the fake CLI: a failed command shows a bug
// (seen, on the loose, nothing paid); an edit and the same command passing
// catches it (XP, the jar, the page); the same bug again soon isn't counted
// twice; a pass with no change, a deleted test or a grep through a log
// catches nothing; switched off in Settings, nothing is noted.
// The fake replays commands from test/fixtures/bugdex/. No account, no network.
//   node scripts/e2e-bugdex.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9391;
const wait = ms => new Promise(r => setTimeout(r, ms));

// A git project to fix things in. realpath.native: CI's temp folder is an
// 8.3 short path, and git reports the long one.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-bugdex-')));
const repo = path.join(base, 'proj');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'app.js'), 'broken\n');
git('add', '-A');
git('commit', '-qm', 'init');
const claudeConfig = path.join(base, 'claude');
fs.mkdirSync(claudeConfig);
// Mid-level, so no level-up (and its new shell) takes the moment mid-test.
fs.mkdirSync(path.join(base, 'userdata'));
fs.writeFileSync(path.join(base, 'userdata', 'settings.json'), JSON.stringify({ onboarded: true, wander: false, xp: { byDevice: { legacy: 2750 } } }));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: path.join(base, 'userdata'), CLAUDE_CONFIG_DIR: claudeConfig, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47997', SHELLBY_MOTION_TEST: '1' },
  });
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
      return { send, ev };
    };
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const until = async (c, expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(150); } return false; };
    const task = async text => {
      await panel.ev(`SB.send(${JSON.stringify(text)})`);
      await until(panel, '!SB.activeTab().busy', 10000);
      await wait(1500); // snapshots, git and the book are written after the result
    };
    const dex = () => panel.ev('shellby.getBugdex()');
    const entry = async id => (await dex())?.species.find(s => s.id === id);
    const xpKinds = () => panel.ev('shellby.getXp().then(v => v.log.map(e => e.kind))');

    await wait(3000);
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await panel.ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);
    // A game or Discord holding the mic reads as a call, and he keeps still on a call.
    await panel.ev("shellby.dev.life({ what: 'call', on: false })");
    // Every body class and held thing the crab gets: the jar moment.
    await critter.ev("window.__bits = []; new MutationObserver(() => window.__bits.push(document.body.className)).observe(document.body, { attributes: true, attributeFilter: ['class'] }); true");

    // ---- 1. a failure: seen, on the loose, and nothing paid for it
    await panel.ev('SB.newTab()');
    await task('bug enoent-fail');
    let hermit = await entry('shell-less-hermit');
    check(hermit?.state === 'seen', `a failed command shows the bug as seen (${hermit?.state})`);
    let v = await dex();
    check(v.loose.length === 1 && v.loose[0].species === 'shell-less-hermit', 'it is on the loose');
    check(!(await xpKinds()).some(k => k === 'catch' || k === 'newbug'), 'seeing a bug pays nothing');
    check(!(await critter.ev("window.__bits.some(c => /bit-catch/.test(c))")), 'and he makes no show of it');

    // ---- 2. an edit, then the same command passing: caught
    await task('edit app.js fixed');
    await task('bug enoent-pass');
    hermit = await entry('shell-less-hermit');
    check(hermit?.state === 'caught' && hermit.caught === 1, `fixed, it's caught (${hermit?.state} ×${hermit?.caught})`);
    v = await dex();
    check(v.loose.length === 0 && v.caught === 1, 'off the loose, into the book');
    check((await xpKinds()).includes('newbug'), 'a new kind of bug pays XP');
    check(await until(critter, "window.__bits.some(c => /bit-catch/.test(c))", 20000), 'he jars it');
    check(v.unseen.includes('shell-less-hermit'), 'it shows as new');

    // ---- 3. the same bug again soon: not counted twice
    await task('edit app.js broken again');
    await task('bug enoent-fail');
    await task('edit app.js fixed again');
    await task('bug enoent-pass');
    hermit = await entry('shell-less-hermit');
    check(hermit?.caught === 1, `the same bug in the same project counts once in 12 hours (×${hermit?.caught})`);

    // ---- 4. passing with nothing changed is not a fix
    await task('bug typeerror-fail');
    await task('bug typeerror-pass');
    v = await dex();
    const shrimp = v.species.find(s => s.id === 'shapeshifter-shrimp');
    check(shrimp?.state === 'seen', `no change, no catch (${shrimp?.state})`);
    check(v.loose.find(l => l.species === 'shapeshifter-shrimp')?.refused === 'no-change', 'and the loose row says why');

    // ---- 5. deleting the failing test is not a fix
    await task('edit add.test.js test');
    await task('bug assert-fail');
    await task('delete add.test.js');
    await task('bug assert-pass');
    v = await dex();
    check(v.species.find(s => s.id === 'assertive-lobster')?.state === 'seen', 'a deleted test catches nothing');
    check(v.loose.find(l => l.species === 'assertive-lobster')?.refused === 'deleted-tests', `refused: a test was deleted (${JSON.stringify(v.loose.map(l => [l.species, l.refused, l.engaged]))})`);

    // ---- 6. a grep through a log full of errors sees nothing
    const before = (await dex()).seen;
    await task('bug grep-typeerror');
    check((await dex()).seen === before, 'reading a log is not a bug');

    // ---- 7. the page
    await panel.ev("SB.setView('bugdex')");
    check(await until(panel, "document.querySelectorAll('#bugdexView [data-id]').length > 10"), 'the Bugdex page lists the book');
    check(await until(panel, "/1 of \\d+ caught/.test(document.getElementById('bugdexView').textContent)"), 'with how many are caught');
    check(await panel.ev("!!document.querySelector('[data-goto=\"bugdex\"]')"), 'and has its tab');

    // ---- 8. switched off: nothing new is noted
    await panel.ev('shellby.setSettings({ catchBugs: false }).then(r => { SB.state.settings = r.settings; })');
    await panel.ev("SB.setView('chat')");
    const seenBefore = (await dex()).seen;
    await task('edit app.js off');
    await task('bug enoent-fail');
    check((await dex()).seen === seenBefore && (await dex()).loose.every(l => l.species !== 'shell-less-hermit'), 'with catching off in Settings, nothing is noted');
  } catch (e) {
    console.log(`FAIL  ${e.stack || e.message}`);
    fails++;
  } finally {
    app.kill();
    await wait(800);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* still locked */ }
  }
  console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
  process.exit(fails ? 1 : 0);
})();
