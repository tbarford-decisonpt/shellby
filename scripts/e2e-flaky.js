// The flaky test detective, end to end against the fake CLI: a test that fails
// and then passes with the code unchanged lands on the Routines page; the
// second time this week he says so; an edit between runs is not a flake; a
// click on his bubble opens the list; Fix it starts a task in a copy of the
// repository; switched off in Settings, he stops noting anything.
// The fake runs `npm test 2>&1 | tail -40`, which always exits 0: only Jest's
// summary says it failed. No account, no network.
//   node scripts/e2e-flaky.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9384;
const wait = ms => new Promise(r => setTimeout(r, ms));

// A git project to run the tests in. realpath.native: CI's temp folder is an
// 8.3 short path, and git reports the long one.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-flaky-')));
const repo = path.join(base, 'proj');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n');
git('add', '-A');
git('commit', '-qm', 'init');
const claudeConfig = path.join(base, 'claude');
fs.mkdirSync(claudeConfig);
// Mid-level, so no level-up (and its new shell) takes the bubble mid-test.
fs.mkdirSync(path.join(base, 'userdata'));
fs.writeFileSync(path.join(base, 'userdata', 'settings.json'), JSON.stringify({ onboarded: true, wander: false, xp: { byDevice: { legacy: 2750 } } }));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: path.join(base, 'userdata'), CLAUDE_CONFIG_DIR: claudeConfig, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47996' },
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
      await wait(700); // the snapshot and the ledger are written after the result
    };
    const flakyList = () => panel.ev('shellby.getFlaky().then(v => v.list)');

    await wait(3000);
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await panel.ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);
    // Every line he says, whatever replaces it (his first task also earns a trophy).
    await critter.ev("window.__said = []; const bt = document.getElementById('bubbleText'); new MutationObserver(() => window.__said.push(bt.textContent)).observe(bt, { childList: true, characterData: true, subtree: true }); true");
    const said = () => critter.ev('window.__said.join(" | ")');

    // ---- 1. failed, then passed on the same code: one flake, on the list only
    await panel.ev('SB.newTab()');
    await task('jest fail signs in');
    check((await flakyList()).length === 0, 'a failing run alone is not a flake');
    await task('jest pass');
    let rows = await flakyList();
    check(rows.length === 1 && rows[0].label === 'auth.spec › signs in' && rows[0].week === 1, `fail then pass with the code unchanged is a flake (${JSON.stringify(rows.map(r => [r.label, r.week]))})`);
    check(rows[0]?.framework === 'jest', 'the runner is known from its output');
    check(!/flaked/.test(await said()), 'one flake is not worth a word');

    await panel.ev("SB.setView('routines')");
    check(await until(panel, "!document.getElementById('flakyTests').hidden && document.querySelectorAll('#flakyList li').length === 1"), 'the Routines page lists it');
    check(/flaked once this week/.test(await panel.ev("document.getElementById('flakyList').textContent")), 'with how often this week');
    check(await panel.ev("[...document.querySelectorAll('#flakyList button')].map(b => b.textContent).join(',')") === 'Fix it,Quarantine,Not flaky', 'and what can be done about it');
    await panel.ev("SB.setView('chat')");

    // ---- 2. an edit between the failure and the pass is not a flake
    await task('edit a.txt before the failure');
    await task('jest fail signs in');
    await task('edit a.txt changed between runs');
    await task('jest pass');
    rows = await flakyList();
    check(rows[0]?.total === 1, `a pass after the code changed is a fix, not a flake (total ${rows[0]?.total})`);

    // ---- 3. the second flake this week: he says so
    await task('edit a.txt once more');
    await task('jest fail signs in');
    await task('jest pass');
    rows = await flakyList();
    check(rows[0]?.week === 2, `a second flake on the new code (week ${rows[0]?.week})`);
    check(await until(critter, 'window.__said.some(s => /auth\\.spec › signs in flaked 2 times this week/.test(s))', 4000), `he says "auth.spec › signs in flaked 2 times this week" (said: ${await said()})`);

    // ---- 4. a click on that bubble opens the list
    await panel.ev("SB.setView('chat')");
    await critter.ev('shellby.critter.click()');
    check(await until(panel, "SB.state.view === 'routines'", 4000), 'clicking him while he says it opens the Routines page');

    // ---- 5. Fix it: a task in a copy of the repository, and the test is being fixed
    const fixed = await panel.ev(`shellby.flakyAct({ key: ${JSON.stringify(rows[0].key)}, id: ${JSON.stringify(rows[0].id)}, action: 'fix' })`);
    check(fixed?.ok, `Fix it starts a task (${JSON.stringify(fixed)})`);
    check(await until(panel, `SB.state.activeTab === ${JSON.stringify(fixed?.tabId)}`), 'in a new tab, shown');
    const tab = await panel.ev('(t => ({ title: t.title, cwd: t.cwd }))(SB.activeTab())');
    check(/^Fix flaky auth\.spec › signs in/.test(tab?.title || ''), `named for the test (${tab?.title})`);
    check(tab?.cwd && path.resolve(tab.cwd) !== path.resolve(repo), `working in a copy of the repository (${tab?.cwd})`);
    check(git('status', '--porcelain') === 'M a.txt' && fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'once more\n', 'your checkout is left as it was');
    rows = await flakyList();
    check(rows[0]?.status === 'fixing' && rows[0]?.clean?.of === 20, 'the list shows it being fixed');
    check((await panel.ev(`shellby.flakyAct({ key: 'aaaaaaaaaaaa', id: 'made up', action: 'fix' })`))?.ok === false, 'a test that is not on the list is refused');
    check((await panel.ev(`shellby.flakyAct({ key: ${JSON.stringify(rows[0].key)}, id: ${JSON.stringify(rows[0].id)}, action: 'rm -rf' })`))?.ok === false, 'an unknown action is refused');

    // ---- 6. switched off: nothing new is noted
    await panel.ev('shellby.setSettings({ flakyTests: false }).then(r => { SB.state.settings = r.settings; })');
    await panel.ev('SB.newTab()');
    await task('jest fail logs out');
    await task('jest pass');
    check(!(await flakyList()).some(r => /logs out/.test(r.id)), 'with spotting off in Settings, nothing new is noted');
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
