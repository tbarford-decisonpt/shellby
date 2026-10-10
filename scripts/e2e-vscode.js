// ci: editor touches: colours, side by side, one hunk back, Mermaid, Ctrl+Shift+T, your own keys, outline, problems
// The things an editor does that Shellby now does too, end to end against the fake CLI:
//   1. a turn's diff in colour, side by side, and one hunk of it taken back
//   2. a code block in a reply: colours and Copy; a Mermaid block drawn
//   3. Ctrl+Shift+T brings back the conversation you closed
//   4. a shortcut given your own keys in the Ctrl+/ list
//   5. the outline (Ctrl+Shift+O) lists messages and files, and goes there
//   6. Problems (Ctrl+Shift+M): a typecheck's errors, file by file, and Fix it
// No account, no network beyond this PC.
//   node scripts/e2e-vscode.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9384;
const wait = ms => new Promise(r => setTimeout(r, ms));

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-vscode-')));
const repo = path.join(base, 'proj');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'core.autocrlf', 'false');
const LINES = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`);
fs.writeFileSync(path.join(repo, 'big.js'), `${LINES.join('\n')}\n`);
// A typecheck that prints a tsc error, so Problems has something to find.
fs.writeFileSync(path.join(repo, 'tc.js'), "console.log(\"big.js(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\"); process.exit(2);\n");
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'proj', scripts: { typecheck: 'node tc.js' } }, null, 2));
git('add', '-A');
git('commit', '-qm', 'init');
const claudeConfig = path.join(base, 'claude');
fs.mkdirSync(claudeConfig);

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_E2E: '1', SHELLBY_USER_DATA: path.join(base, 'userdata'), CLAUDE_CONFIG_DIR: claudeConfig, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47993' },
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
    const send = (method, params) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(m => m.result?.result?.value);
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 150) { if (await ev(expr)) return true; await wait(150); } return false; };
    const idle = () => until('!SB.activeTab().busy');
    const key = async (k, mods = {}) => {
      const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
      const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
      const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: mods.shift && k.length === 1 ? k.toUpperCase() : k, code, modifiers, windowsVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
    };
    const shot = (name, show = null) => (process.env.E2E_SHOTS ? ev(`document.querySelectorAll('.celebrate .cel-close').forEach(b => b.click()); ${show ? `document.querySelector(${JSON.stringify(show)})?.scrollIntoView({ block: 'start' })` : ''}`).then(() => wait(500)).then(() => send('Page.captureScreenshot', { format: 'png' })).then(m => fs.writeFileSync(path.join(process.env.E2E_SHOTS, `vscode-${name}.png`), Buffer.from(m.result.data, 'base64'))) : null);
    const FEED = '.feed:not([hidden])';

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);

    // ---- 1. a turn's diff: colours, side by side, one hunk back
    const changed = LINES.slice();
    changed[1] = 'const v2 = "two";';
    changed[24] = 'const v25 = "twenty-five";';
    await ev('SB.newTab()');
    await ev(`SB.send(${JSON.stringify(`edit big.js ${changed.join('\n')}`)})`);
    await idle();
    check(await until(`document.querySelector('${FEED} details.changes')`), 'a turn that edits a file gets a changes block');
    await ev(`document.querySelector('${FEED} details.changes').open = true; document.querySelector('${FEED} .chg-file').click()`);
    check(await until(`document.querySelector('${FEED} .chg-diff .diff .tok-kw')`), 'the diff is in colour: const is a keyword');
    check(await ev(`[...document.querySelectorAll('${FEED} .chg-diff .dl.add .code')].some(c => c.textContent === '+const v2 = "two";')`), 'and a coloured line still reads as the diff\'s');
    check(await ev(`document.querySelectorAll('${FEED} .chg-diff .hunk-undo').length`) === 2, 'each of its two hunks has Undo this part');

    await ev(`[...document.querySelectorAll('${FEED} .rv-seg')].find(b => b.textContent === 'Side by side').click()`);
    check(await until(`document.querySelector('${FEED} .chg-diff .diff.split .sx-row .sx-half.del + .sx-half.add')`), 'Side by side puts the old line beside the new');
    check(await ev("localStorage.getItem('shellby.diff.layout')") === 'split', 'and is remembered for the next diff');
    await shot('1-split', '.feed:not([hidden]) .rv-head');

    const undoPart = `document.querySelectorAll('${FEED} .chg-diff .hunk-undo')[1]`;
    await ev(`${undoPart}.click()`);
    check(await ev(`${undoPart}.textContent`) === 'Undo it?', 'Undo this part asks once first');
    check(fs.readFileSync(path.join(repo, 'big.js'), 'utf8').includes('twenty-five'), 'and the first press changes nothing');
    await ev(`${undoPart}.click()`);
    check(await until(`document.querySelectorAll('${FEED} .chg-diff .hunk-undo').length === 1`), 'the second press takes it back, and the diff shows what is left');
    const now = fs.readFileSync(path.join(repo, 'big.js'), 'utf8');
    check(now.includes('const v2 = "two";') && now.includes('const v25 = 25;'), 'only that hunk went back');
    await ev(`[...document.querySelectorAll('${FEED} .rv-seg')].find(b => b.textContent === 'Inline').click()`);
    const undo = `document.querySelector('${FEED} .chg-actions .btn')`;
    await ev(`${undo}.click()`); await ev(`${undo}.click()`);
    check(await until(`document.querySelector('${FEED} .changes.undone')`), 'the whole turn can still be undone after a hunk');
    check(fs.readFileSync(path.join(repo, 'big.js'), 'utf8') === `${LINES.join('\n')}\n`, 'and the file is back the way it was');

    // ---- 2. code in a reply
    await ev(`SB.send(${JSON.stringify('Here it is:\n```js\nconst answer = 42; // yes\n```\n\n```mermaid\ngraph TD\n  A[Ask] --> B{Ok?}\n  B -->|yes| C(Done)\n```\nthat is all')})`);
    await idle();
    check(await until(`document.querySelector('${FEED} .msg.assistant .code-block .tok-num')`), 'a code block in a reply is in colour');
    check(await ev(`document.querySelector('${FEED} .msg.assistant .code-block .code-lang')?.textContent`) === 'js', 'its bar names the language');
    check(await ev(`!!document.querySelector('${FEED} .msg.assistant .code-block .code-copy')`), 'and has Copy');
    check(await ev(`document.querySelectorAll('${FEED} .msg.assistant .mm-wrap svg .mm-node').length`) === 3, 'a Mermaid block is drawn: three nodes');
    check(await ev(`[...document.querySelectorAll('${FEED} .msg.assistant .mm-wrap svg text')].map(t => t.textContent).join(',')`) === 'Ask,Ok?,Done,yes', 'with its labels as text');
    await shot('2-code', '.feed:not([hidden]) .msg.assistant:last-of-type .code-block');

    // ---- 3. Ctrl+Shift+T
    const closedId = await ev('SB.activeTab().id');
    await ev('SB.newTab()');
    await ev(`SB.closeTab(${JSON.stringify(closedId)}, { quiet: true })`);
    await until(`!SB.state.tabs.has(${JSON.stringify(closedId)})`);
    await key('t', { ctrl: true, shift: true });
    check(await until(`SB.state.tabs.has(${JSON.stringify(closedId)}) && SB.activeTab().id === ${JSON.stringify(closedId)}`), 'Ctrl+Shift+T brings the closed conversation back');
    check(await until(`!!document.querySelector('${FEED} .mm-wrap svg')`), 'with what was in it');

    // ---- 4. your own keys
    await key('/', { ctrl: true });
    check(await until("!document.getElementById('shortcutsSheet').hidden"), 'Ctrl+/ opens the list');
    check(await ev("!document.querySelector('#shortcutsList .keys-edit')"), 'it reads as a list until you ask to change one');
    await ev("document.getElementById('shortcutsEdit').click()");
    await ev("document.querySelector('#shortcutsList .keys-edit[data-id=\"outline\"]').click()");
    await key('t', { ctrl: true });
    check(await until("/already/.test(document.getElementById('shortcutsStatus').textContent)"), 'a key another shortcut has is refused, with why');
    await key('o', { ctrl: true, alt: true });
    check(await until("JSON.stringify(SB.state.settings.keybindings) === JSON.stringify({ outline: ['Ctrl+Alt+O'] })"), 'Ctrl+Alt+O is saved as the outline\'s key');
    check(await ev("SB.shortcuts.primary('outline')") === 'Ctrl+Alt+O', 'and the table answers with it');
    await shot('4-keys');
    await key('Escape');
    await until("document.getElementById('shortcutsSheet').hidden");

    // ---- 5. the outline, on its new keys
    await key('o', { ctrl: true, alt: true });
    check(await until("!document.getElementById('outlineSheet').hidden"), 'the new keys open the outline');
    const rows = await ev("[...document.querySelectorAll('#outlineList .ol-row')].map(r => r.className.includes('ol-file') ? 'file:' + r.querySelector('.ol-name').textContent : 'turn')");
    check(rows.length >= 3 && rows[1] === 'file:big.js', `it lists messages and the files they touched (${rows.join(' ')})`);
    await ev("const i = document.getElementById('outlineInput'); i.value = 'big'; i.dispatchEvent(new Event('input'))");
    check(await ev("document.querySelectorAll('#outlineList .ol-row').length") === 2, 'typing narrows it to a file');
    await shot('5-outline');
    await key('ArrowDown'); // from the message to its file
    await key('Enter');
    check(await until("document.getElementById('outlineSheet').hidden && document.querySelector('.feed:not([hidden]) .chg-file[aria-expanded=\"true\"]')"), 'Enter on a file opens its diff in that turn');
    await ev("shellby.setSettings({ keybindings: {} }).then(r => { SB.state.settings = r.settings; })");

    // ---- 6. Problems
    await key('m', { ctrl: true, shift: true });
    check(await until("!document.getElementById('problemsSheet').hidden"), 'Ctrl+Shift+M opens Problems');
    check(/No checks have run/.test(await ev("document.getElementById('problemsSub').textContent")), 'before any checks it says so');
    await ev("document.getElementById('problemsRun').click()");
    // The first run in a project asks first, in the confirmation window.
    let dlg = null;
    for (let i = 0; i < 40 && !dlg; i++) {
      try { dlg = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.url.endsWith('dialog.html')); } catch { /* not yet */ }
      if (!dlg) await wait(250);
    }
    if (dlg) {
      const dws = new WebSocket(dlg.webSocketDebuggerUrl);
      await new Promise(r => { dws.onopen = r; });
      let did = 0; const dp = new Map();
      dws.onmessage = e => { const m = JSON.parse(e.data); dp.get(m.id)?.(m); };
      const dev = expr => new Promise(r => { const i = ++did; dp.set(i, m => r(m.result?.result?.value)); dws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
      for (let t = 0; t < 10000 && !(await dev("document.querySelectorAll('#actions button').length")); t += 150) await wait(150);
      const detail = await dev("document.body.textContent");
      check(/npm run typecheck/.test(detail), 'it asks first, naming the command');
      await dev("[...document.querySelectorAll('#actions button')][0].click()");
      dws.close();
    } else check(false, 'it asks first, naming the command');
    check(await until("document.querySelector('#problemsList .pb-row')", 30000), 'the typecheck\'s error is listed');
    check(await ev("document.querySelector('#problemsList .pb-name').textContent") === 'big.js', 'under its file');
    check(await ev("document.querySelector('#problemsList .pb-at').textContent") === '3:7', 'at its line and column');
    check(await ev("document.querySelector('#problemsList .pb-code').textContent") === 'TS2322', 'with its code');
    await shot('6-problems');
    await ev("document.querySelector('#problemsList .pb-fix').click()");
    check(await until(`[...document.querySelectorAll('${FEED} .msg.user')].some(m => /<problems>/.test(m.textContent) && /big\\.js:3:7 error TS2322/.test(m.textContent))`), 'Fix it sends Claude the problem, fenced as output');
    check(await ev("document.getElementById('problemsSheet').hidden"), 'and the list closes');
    await idle();
  } catch (err) {
    check(false, `no exception (${err.message})`);
  } finally {
    app.kill();
    await wait(1500);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* still closing */ }
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
