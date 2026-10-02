// Three things that reach outside the panel, end to end against the fake CLI:
//   1. what a turn changed: the block, a file's diff, and Undo
//   2. a copy of the repo per tab: the branch chip, and bringing it home
//   3. answering from the phone: an ntfy server on 127.0.0.1 stands in for
//      ntfy.sh, carries the Allow button back, and the card says so
// No account, no network beyond this PC.
//   node scripts/e2e-changes.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9371;
const wait = ms => new Promise(r => setTimeout(r, ms));

// A git project to work in.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-changes-')));
const repo = path.join(base, 'proj');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n');
// Where the fake CLI keeps its transcripts, for Shellby to carry into a copy.
const claudeConfig = path.join(base, 'claude');
fs.mkdirSync(claudeConfig);
git('add', '-A');
git('commit', '-qm', 'init');

// A pocket-sized ntfy: remembers what was published, and hands the reply topic
// whatever the "phone" pressed.
const published = [];
let pressed = null;
const ntfy = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/shellby-e2e-k7m2p9q4r8t3') {
      published.push({ headers: req.headers, body });
      res.end('{}');
    } else if (req.method === 'GET' && req.url.startsWith('/shellby-e2e-k7m2p9q4r8t3-reply/json')) {
      res.end(pressed ? `${JSON.stringify({ id: 'r1', event: 'message', message: pressed })}\n` : '');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
});

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  await new Promise(r => ntfy.listen(0, '127.0.0.1', r));
  const ntfyPort = ntfy.address().port;
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: path.join(base, 'userdata'), CLAUDE_CONFIG_DIR: claudeConfig, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47991' },
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
    const idle = () => until('!SB.activeTab().busy');
    // E2E_SHOTS=<dir>: also save the panel at each step, to look at by eye.
    const shot = name => (process.env.E2E_SHOTS ? ev("document.querySelectorAll('.celebrate .cel-close').forEach(b => b.click())").then(() => wait(400)).then(() => new Promise(r => { const i = ++id; p.set(i, m => { fs.writeFileSync(path.join(process.env.E2E_SHOTS, `${name}.png`), Buffer.from(m.result.data, 'base64')); r(); }); ws.send(JSON.stringify({ id: i, method: 'Page.captureScreenshot', params: { format: 'png' } })); })) : null);
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);

    // ---- 1. what a turn changed
    await ev('SB.newTab()');
    await ev("SB.send('edit a.txt changed by the turn')");
    await idle();
    check(await until("document.querySelector('.feed:not([hidden]) details.changes')"), 'a turn that edits a file gets a changes block');
    check(await ev("document.querySelector('.feed:not([hidden]) .changes .chg-title').textContent") === '1 file changed', 'it counts the files');
    check(await ev("document.querySelector('.feed:not([hidden]) .changes .chg-path').textContent") === 'a.txt', 'and names them');
    await ev("document.querySelector('.feed:not([hidden]) .changes').open = true; document.querySelector('.feed:not([hidden]) .chg-file').click()");
    check(await until("document.querySelector('.feed:not([hidden]) .chg-diff pre.diff')"), 'a file opens to its diff');
    const lines = await ev("[...document.querySelectorAll('.feed:not([hidden]) .chg-diff .dl')].map(l => l.className.replace('dl ', '') + ':' + l.textContent)");
    await shot('1-changes');
    check(lines.includes('del:-original') && lines.includes('add:+changed by the turn'), `the diff shows the line going and coming (${lines.join(' | ')})`);

    const undo = "document.querySelector('.feed:not([hidden]) .chg-actions .btn')";
    await ev(`${undo}.click()`);
    check(await ev(`${undo}.textContent`) === 'Undo 1 file?', 'Undo asks once before doing anything');
    check(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'changed by the turn\n', 'and the first press changes nothing');
    await ev(`${undo}.click()`);
    check(await until("document.querySelector('.feed:not([hidden]) .changes.undone')"), 'the second press undoes it, and the block says so');
    await shot('2-undone');
    check(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'original\n', 'a.txt is back the way it was');

    const echo = await ev("SB.send('just talking').then(() => true)");
    await idle();
    check(echo && await ev("document.querySelectorAll('.feed:not([hidden]) details.changes').length") === 1, 'a turn that changes nothing adds no block');

    // ---- 2. a copy of the repo per tab
    await ev("shellby.setSettings({ worktrees: true }).then(r => { SB.state.settings = r.settings; })");
    await ev('SB.newTab()');
    await ev("SB.send('edit b.txt made in the copy')");
    await idle();
    check(await until("!document.getElementById('branchChip').hidden"), 'the tab shows the branch it works on');
    const label = await ev("document.getElementById('branchLabel').textContent");
    check(/^add-greeting-[0-9a-f]{6}$/.test(label), `named as Claude suggested (${label})`);
    check(await ev("document.getElementById('folderLabel').textContent").then(t => t.endsWith('proj')), 'the folder chip still shows your project');
    check(!fs.existsSync(path.join(repo, 'b.txt')), 'your checkout is untouched');
    check(await until("document.querySelector('.feed:not([hidden]) details.changes')"), 'turns in the copy get their diffs too');

    await ev("document.getElementById('branchChip').click()"); await wait(800); await shot('3-branch-menu'); await ev('SB.closeMenus()');
    const tabId = await ev('SB.state.activeTab');
    const home = await ev(`shellby.bringWorktreeHome(${JSON.stringify(tabId)})`);
    check(home?.ok && home.merged && home.commits === 1 && home.base === 'main', `bring it home merges one commit into main (${JSON.stringify(home)})`);
    check(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8') === 'made in the copy\n', 'the work arrives in your checkout');
    check(home?.kept && git('worktree', 'list').split('\n').length === 2, 'and the copy stays, for the conversation to carry on in');
    const done = await ev(`shellby.bringWorktreeHome(${JSON.stringify(tabId)}, { finish: true })`);
    check(done?.ok && !done.merged && done.tidied, `finishing brings nothing new home and tidies up (${JSON.stringify(done)})`);
    check(git('branch', '--list', 'shellby/*') === '', 'the copy\'s branch is gone');
    check(git('worktree', 'list').split('\n').length === 1, 'as is the copy itself');
    await ev(`SB.state.tabs.has(${JSON.stringify(tabId)}) && SB.closeTab(${JSON.stringify(tabId)})`);

    // ---- 3. answering from the phone
    await ev("shellby.setSettings({ worktrees: false }).then(r => { SB.state.settings = r.settings; })");
    await ev(`shellby.setChannels({ enabled: true, provider: 'ntfy', target: 'http://127.0.0.1:${ntfyPort}/shellby-e2e-k7m2p9q4r8t3', replies: true })`);
    await ev('SB.newTab()');
    await ev("SB.send('tool please')");
    for (let t = 0; t < 8000 && !published.length; t += 150) await wait(150);
    const sent = published[0];
    check(!!sent, 'the prompt was published');
    const nonce = /body=allow:([A-Za-z0-9_-]{22})/.exec(sent?.headers?.actions || '')?.[1];
    check(!!nonce, 'with Allow and Deny buttons on it');
    check((sent?.headers?.actions || '').includes(`http://127.0.0.1:${ntfyPort}/shellby-e2e-k7m2p9q4r8t3-reply`), 'that answer on the reply topic');
    pressed = `allow:${nonce}`;
    check(await until("[...document.querySelectorAll('.feed:not([hidden]) .ask-verdict')].some(v => v.textContent === '→ Allowed from your phone')", 15000), 'pressing Allow on the phone answers the card, and it says where from');
    check(await until("[...document.querySelectorAll('.feed:not([hidden]) .msg.assistant')].some(m => m.textContent.includes('ALLOWED'))"), 'and Claude carries on');
    await shot('4-phone');
    await ev("SB.setView('settings'); setTimeout(() => document.getElementById('chRepliesRow').scrollIntoView({ block: 'center' }), 300)"); await wait(600); await shot('5-settings-replies');
    await ev("document.getElementById('worktreeToggle').scrollIntoView({ block: 'center' })"); await wait(600); await shot('6-settings-worktrees');
  } catch (e) {
    console.log('FAIL  crashed:', e.message);
    fails++;
  } finally {
    app.kill();
    ntfy.close();
    await wait(1500);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* Windows may still hold it */ }
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
