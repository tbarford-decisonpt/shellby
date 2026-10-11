// ci: the file viewer: a copy's changes and diffs, whole files, live refresh, Esc back to the panes
// The file viewer (panel/viewer.js, main's viewer.js) end to end against the
// fake CLI: a conversation in its own copy edits files, the viewer lists them
// with diffs and both sides' line numbers, a second edit shows up on its own,
// and Esc puts the split panes back as they were.
//   node scripts/e2e-viewer.js [--shots <dir>]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9421;
const SHOT_TIMEOUT_MS = 10000;   // an unpainted window never answers captureScreenshot
const wait = ms => new Promise(r => setTimeout(r, ms));
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : process.env.E2E_SHOTS || null;

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-viewer-')));
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
const userData = path.join(base, 'userdata');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: false, worktrees: true, projects: { added: [repo] } }));
fs.writeFileSync(path.join(base, 'outside.txt'), 'not in the project\n');

// What the turns write, and so what the viewer must list: counts come from here.
const MADE = [{ file: 'b.txt', words: 'made in the copy' }, { file: 'c.txt', words: 'second change' }];

const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  // Something already on the port (an Electron a killed run left behind): the checks would drive that app instead.
  if ((await targets()).length) {
    console.log(`FAIL  port ${PORT} is taken by another app, maybe an Electron a killed run left behind`);
    process.exit(1);
  }
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: userData, CLAUDE_CONFIG_DIR: claudeConfig, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47972', SHELLBY_E2E: '1' },
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
    const cdp = (method, params) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = expr => cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(m => m.result?.result?.value);
    const until = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 150) { if (await ev(expr)) return true; await wait(150); } return false; };
    const idle = () => until('!SB.activeTab().busy');
    // Raced against a wait: a window something covers never answers (CLAUDE.md).
    const shot = async name => {
      if (!SHOTS) return;
      const m = await Promise.race([cdp('Page.captureScreenshot', { format: 'png' }), wait(SHOT_TIMEOUT_MS).then(() => null)]);
      if (m?.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(m.result.data, 'base64'));
      else console.log(`(no screenshot for ${name}: the window didn't paint in time)`);
    };
    await wait(3000);
    await ev("SB.setView('chat')");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);

    // ---- a conversation in its own copy, beside another
    await ev('SB.newTab()');
    await ev(`SB.send(${JSON.stringify(`edit ${MADE[0].file} ${MADE[0].words}`)})`);
    await idle();
    check(await until("!document.getElementById('branchChip').hidden"), 'the conversation works in its own copy');
    const copyTab = await ev('SB.state.activeTab');
    await ev('SB.splitPane()');
    check(await until('SB.panes.count(SB.state.grid) === 2'), 'two panes side by side');
    await ev(`SB.activate(${JSON.stringify(copyTab)})`);

    // ---- the viewer on it
    await ev(`SB.viewer.openTab(${JSON.stringify(copyTab)})`);
    check(await until("SB.state.view === 'viewer' && document.querySelectorAll('#viewerList .vw-row').length > 0"), 'the viewer opens on the copy');
    const rows = await ev("[...document.querySelectorAll('#viewerList .vw-row')].map(b => b.dataset.path + ':' + b.querySelector('.vw-st').textContent)");
    check(JSON.stringify(rows) === JSON.stringify([`${MADE[0].file}:?`]), `Changes lists the new file as untracked (${rows})`);
    check(/\(from main\)/.test(await ev("document.getElementById('viewerWhere').textContent")), 'the header names the base');
    await ev(`[...document.querySelectorAll('#viewerList .vw-row')].find(b => b.dataset.path === ${JSON.stringify(MADE[0].file)}).click()`);
    check(await until(`[...document.querySelectorAll('#viewerMain .dl.add .code')].some(c => c.textContent === ${JSON.stringify(MADE[0].words)})`), 'its diff shows the line coming');
    check(await ev("document.querySelector('#viewerMain .dl.add .vw-ln:nth-child(2)').textContent") === '1', 'with the new side numbered');
    await shot('1-changes');

    // ---- a second edit shows up on its own. SB.send goes back to the chat (tab-send.js), so the
    // viewer hears the nudge while hidden and catches up when it's shown again.
    await ev(`SB.send(${JSON.stringify(`edit ${MADE[1].file} ${MADE[1].words}`)})`);
    await idle();
    check(await ev("SB.state.view === 'chat' && SB.viewer.current() !== null"), 'sending went back to the chat, the viewer kept its place');
    await ev("SB.setView('viewer')");
    check(await until(`document.querySelectorAll('#viewerList .vw-row').length === ${MADE.length}`), 'shown again, it lists the second edit');
    check(await ev(`SB.viewer.current().file === ${JSON.stringify(MADE[0].file)}`), 'and still has the file you were on');

    // ---- Whole file on a changed file, and back to its diff
    await ev("[...document.querySelectorAll('#viewerMain .vw-file-head button')].find(b => b.textContent === 'Whole file').click()");
    check(await until(`[...document.querySelectorAll('#viewerMain .dl.ctx .code')].some(c => c.textContent === ${JSON.stringify(MADE[0].words)})`), 'Whole file shows the changed file as text');
    await ev("[...document.querySelectorAll('#viewerMain .vw-file-head button')].find(b => b.textContent === 'Diff').click()");
    check(await until("!!document.querySelector('#viewerMain .dl.add')"), 'and Diff goes back');

    // ---- a file that didn't change, read whole
    await ev("document.getElementById('viewerTabFiles').click()");
    await until("[...document.querySelectorAll('#viewerList .vw-row')].some(b => b.dataset.path === 'a.txt')");
    await ev("[...document.querySelectorAll('#viewerList .vw-row')].find(b => b.dataset.path === 'a.txt').click()");
    check(await until("[...document.querySelectorAll('#viewerMain .dl.ctx .code')].some(c => c.textContent === 'original')"), 'an unchanged file opens as its text');
    await shot('2-whole-file');

    // ---- Esc puts the panes back
    check(await ev("SB.state.view === 'viewer'"), 'still in the viewer before Esc');
    await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    check(await until("SB.state.view === 'chat'"), 'Esc goes back to the chat');
    check(await ev('SB.panes.count(SB.state.grid)') === 2, 'with both panes still there');

    console.log(fails ? `\n${fails} failed` : '\nall passed');
    process.exitCode = fails ? 1 : 0;
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    app.kill();
    await wait(500);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
})();
