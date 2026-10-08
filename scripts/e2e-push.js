// ci: Push from the folder menu: take in the remote's work, send yours, a hook's refusal
// Sending your checkout to its remote, end to end: the folder menu counts what
// would go, Push takes in what the remote has first and sends the rest, and
// the conversation and XP say so. A bare repo in a temp folder stands in for
// GitHub. No account, no network beyond this PC.
//   node scripts/e2e-push.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9373;
const wait = ms => new Promise(r => setTimeout(r, ms));

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-push-')));
const repo = path.join(base, 'proj');
const bare = path.join(base, 'origin.git');
const other = path.join(base, 'other');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const ident = cwd => { git(cwd, 'config', 'user.email', 't@example.com'); git(cwd, 'config', 'user.name', 'T'); git(cwd, 'config', 'core.autocrlf', 'false'); };
const commit = (cwd, file, text, msg) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', msg); };

fs.mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
ident(repo);
commit(repo, 'a.txt', 'a\n', 'init');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
git(repo, 'remote', 'add', 'origin', bare);
git(repo, 'push', '-q', '-u', 'origin', 'main');
execFileSync('git', ['clone', '-q', bare, other], { windowsHide: true });
ident(other);
// Two of yours that origin hasn't seen, and one of theirs you haven't.
commit(repo, 'mine1.txt', '1\n', 'mine one');
commit(repo, 'mine2.txt', '2\n', 'mine two');
commit(other, 'theirs.txt', 't\n', 'theirs');
git(other, 'push', '-q');

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: path.join(base, 'userdata'), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47993' },
  });
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
    const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 150) { if (await ev(expr)) return true; await wait(150); } return false; };
    const shot = name => (process.env.E2E_SHOTS ? new Promise(r => { const i = ++id; p.set(i, m => { fs.writeFileSync(path.join(process.env.E2E_SHOTS, `${name}.png`), Buffer.from(m.result.data, 'base64')); r(); }); ws.send(JSON.stringify({ id: i, method: 'Page.captureScreenshot', params: { format: 'png' } })); }) : null);
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);
    await ev('SB.newTab()');
    const tabId = await ev('SB.state.activeTab');

    // ---- the folder menu counts it, as of the last fetch and then after one
    const pushItem = "[...document.querySelectorAll('#folderMenu .menu-item')].find(b => b.querySelector('.mi-title')?.textContent === 'Push main')";
    await ev("document.getElementById('folderChip').click()");
    check(await until(`!!${pushItem} && !${pushItem}.hidden`), 'the folder menu offers to push main');
    check(await until(`${pushItem}.querySelector('.mi-sub').textContent === '2 commits to push · 1 to take in from origin first'`), 'and, once it has asked origin, says what would go and what comes first');
    check(await ev(`!${pushItem}.disabled`), 'it can be pressed');
    check(await ev("[...document.querySelectorAll('#folderMenu .menu-item')].every(b => b.querySelector('.mi-title')?.textContent !== 'Bring all home' || b.hidden)"), 'with no copies waiting, Bring all home stays out of the way');
    await shot('push-1-menu');

    // ---- pressing it
    await ev(`${pushItem}.click()`);
    check(await until("[...document.querySelectorAll('.toast')].some(t => /Pushed 3 commits to origin\\/main, after taking in 1 from origin/.test(t.textContent))", 30000), 'Push takes in theirs, then sends yours and the merge');
    const log = git(bare, 'log', '--format=%s', 'main');
    check(/^theirs$/m.test(log) && /^mine one$/m.test(log) && /^mine two$/m.test(log), 'origin has both sides, nothing forced');
    check(fs.existsSync(path.join(repo, 'theirs.txt')), 'and your checkout has theirs');
    check(await until("[...document.querySelectorAll('.feed:not([hidden]) .home-mark')].some(m => m.textContent.includes('Pushed main to origin: 3 commits, after taking in 1 from origin'))"), 'the conversation says so');
    await shot('push-2-done');

    // ---- again: nothing to do
    const again = await ev(`shellby.pushRepo(${JSON.stringify(tabId)})`);
    check(again?.ok && again.pushed === 0 && again.pulled === 0, `a second push has nothing to send (${JSON.stringify(again)})`);

    // ---- a hook that says no is shown in full
    commit(repo, 'mine3.txt', '3\n', 'mine three');
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho "flightdeck: 2 checks failed" >&2\nexit 1\n', { mode: 0o755 });
    const refused = await ev(`shellby.pushRepo(${JSON.stringify(tabId)})`);
    check(refused?.ok === false && /flightdeck: 2 checks failed/.test(refused.detail || ''), `a refusing pre-push hook comes back in its own words (${JSON.stringify(refused?.error)})`);
    check(await until("[...document.querySelectorAll('.feed:not([hidden]) .error-block')].some(m => m.textContent.includes('flightdeck: 2 checks failed'))"), 'and is written into the conversation');
    check(!/^mine three$/m.test(git(bare, 'log', '--format=%s', 'main')), 'nothing went');
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
