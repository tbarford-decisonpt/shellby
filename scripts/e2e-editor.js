// End-to-end check of the editor features against the dev app over CDP with
// the fake CLI, in a throwaway git repo: an edit's permission card shows its
// diff with line numbers, the tool row folds open to it, "Rewind files" puts the
// file back, @ picks a file, Ctrl+F finds text, Ctrl+= zooms, Ctrl+Shift+P opens
// the palette, the branch chip lists what changed, and paths in replies are links.
// No file is opened in a real editor: links are checked, not clicked.
//   node scripts/e2e-editor.js [screenshot-folder]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9367;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const shots = process.argv[2];
  if (shots) fs.mkdirSync(shots, { recursive: true });

  // A small repo to work in: one committed file the fake CLI will edit.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-editor-repo-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { windowsHide: true, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'first line\nsecond line\nthird line\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'console.log(1);\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'start');

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47993' },
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
    const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const shot = async name => { if (shots) fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
    const key = (k, mods = {}) => ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} }))`);
    const feed = 'SB.activeTab().el';

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(r => SB.folderChanged(r))`);
    check(await until(`SB.activeTab()?.cwd?.toLowerCase() === ${JSON.stringify(repo.toLowerCase())}`), 'a conversation in the test repo');

    // 1. The branch chip, before anything changes.
    check(await until("!document.getElementById('gitChip').hidden && document.getElementById('gitBranch').textContent === 'main'"), 'the branch chip shows main');
    check(await ev("document.getElementById('gitChanges').hidden"), 'nothing changed yet, so no count');

    // 2. An edit asks first, with its diff.
    await ev("SB.send('edit notes.txt')");
    const card = `[...${feed}.querySelectorAll('.ask')].pop()`;
    check(await until(`!!${card}?.querySelector('.diff')`), 'the edit card shows a diff');
    check(await ev(`${card}.querySelector('.dl.del .dt').textContent === 'first line' && ${card}.querySelector('.dl.add .dt').textContent === 'changed in turn 1'`), 'removed and added lines are the real ones');
    check(await ev(`${card}.querySelector('.dl.del .dn').textContent === '1'`), 'with line numbers from the file');
    check(await ev(`${card}.querySelector('.ask-file .file-link').textContent === 'notes.txt'`), 'the file is a link, relative to the folder');
    check(await ev(`/line 1/.test(${card}.querySelector('.ask-line').textContent) && /\\+1/.test(${card}.querySelector('.dstat').textContent)`), 'line and +/- counts in the header');
    await shot('1-edit-card');
    await ev(`${card}.querySelector('.btn.allow').click()`);
    check(await until('!SB.activeTab().busy'), 'allowed, the turn finishes');
    check(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8').startsWith('changed in turn 1'), 'the file really changed');
    await wait(400);
    await ev('SB.clearCelebrations()'); // the first-task trophy would cover the screenshots

    // 3. The tool row: counts in the summary, the diff when opened, no "has been updated" text.
    const row = `[...${feed}.querySelectorAll('.tool.edit')].pop()`;
    check(await ev(`!!${row}.querySelector('summary .dstat') && !!${row}.querySelector('summary a.file-link')`), 'the tool row has the file link and counts');
    await ev(`${row}.open = true`);
    check(await until(`!!${row}.querySelector('.diff') && !${row}.querySelector('.t-result')`), 'opening it shows the diff, not the result text');

    // 4. The branch chip notices, and lists the file.
    check(await until("document.getElementById('gitChanges').textContent === '1 changed'", 5000), 'the branch chip says 1 changed');
    await ev("document.getElementById('gitChip').click()");
    check(await until("!document.getElementById('gitMenu').hidden && /notes\\.txt/.test(document.getElementById('gitMenu').textContent)"), 'its menu lists notes.txt');
    await shot('2-branch-menu');
    await ev('SB.closeMenus()');

    // 5. Rewind files.
    const msg = `${feed}.querySelector('.msg.user[data-uuid]')`;
    check(await ev(`!!${msg}?.querySelector('.msg-rewind')`), 'the message has a Rewind files button');
    check(await ev(`${msg}.textContent.trim() === 'edit notes.txt'`), "and the message's own text is untouched");
    await ev(`${msg}.querySelector('.msg-rewind').click()`);
    check(await until(`/Put this file back/.test(${feed}.querySelector('.rewind-box')?.textContent || '')`), 'it asks first, naming the file');
    check(await ev(`/notes\\.txt/.test(${feed}.querySelector('.rewind-files').textContent)`), 'the file is listed');
    await shot('3-rewind-confirm');
    await ev(`${feed}.querySelector('.rewind-box .btn.allow').click()`);
    check(await until(`!!${feed}.querySelector('.meta.rewound')`), 'a "Rewound 1 file" line appears');
    check(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8') === 'first line\nsecond line\nthird line\n', 'the file is back as it was');
    check(await until("document.getElementById('gitChanges').hidden", 5000), 'and the branch chip is clean again');

    // 6. @ picks a file.
    await ev("(() => { const i = document.getElementById('input'); i.focus(); i.value = 'look at @ap'; i.setSelectionRange(11, 11); i.dispatchEvent(new Event('input')); })()");
    check(await until("!document.getElementById('slashMenu').hidden && /app\\.js/.test(document.getElementById('slashMenu').textContent)"), '@ap lists src/app.js');
    await shot('4-at-picker');
    await key('Enter');
    check(await ev("document.getElementById('input').value") === 'look at @src/app.js ', 'Enter puts the path in the box');
    await ev("(() => { const i = document.getElementById('input'); i.value = '@sr'; i.setSelectionRange(3, 3); i.dispatchEvent(new Event('input')); })()");
    await until("/src\\//.test(document.getElementById('slashMenu').textContent)");
    await key('Enter');
    check(await until("document.getElementById('input').value === '@src/' && /app\\.js/.test(document.getElementById('slashMenu').textContent)"), 'a folder keeps the list open inside it');
    await ev("(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input')); })()");

    // 7. A path in a reply is a link.
    await ev("SB.send('see `notes.txt:2` and `config.get`')");
    check(await until('!SB.activeTab().busy'), 'the reply arrives');
    const last = `[...${feed}.querySelectorAll('.msg.assistant')].pop()`;
    check(await ev(`${last}.querySelector('a.file-link')?.dataset.path === 'notes.txt:2' && ${last}.querySelector('a.file-link').dataset.line === '2'`), '`notes.txt:2` became a link to line 2');
    check(await ev(`${last}.querySelectorAll('a.file-link').length === 1`), '`config.get` stayed text');
    const missing = await ev("shellby.openFile(SB.state.activeTab, 'nope/missing.js')");
    check(missing && !missing.ok && /Couldn't find/.test(missing.error), 'a file that is not there says so instead of opening anything');
    const editors = await ev('shellby.getEditors()');
    console.log(`      (links here would open in: ${editors.using || "Windows' default app"})`);

    // 8. Ctrl+F.
    await ev("document.getElementById('input').focus()");
    await key('f', { ctrl: true });
    check(await until("!document.getElementById('findBar').hidden && document.activeElement.id === 'findInput'"), 'Ctrl+F opens the find bar');
    await ev("(() => { const i = document.getElementById('findInput'); i.value = 'edit'; i.dispatchEvent(new Event('input')); })()");
    // It starts at the first match on screen, which needn't be the first in the conversation.
    check(await until("/^\\d+ of \\d+$/.test(document.getElementById('findCount').textContent)"), 'it counts matches');
    const [at, total] = (await ev("document.getElementById('findCount').textContent")).split(' of ').map(Number);
    await key('Enter');
    check(await ev("document.getElementById('findCount').textContent") === `${at % total + 1} of ${total}`, 'Enter goes to the next one');
    check(await ev("CSS.highlights.get('shellby-find')?.size") === total, 'every match is highlighted');
    await shot('5-find');
    await key('Escape');
    check(await ev("document.getElementById('findBar').hidden && !CSS.highlights.has('shellby-find')"), 'Esc closes it and clears the highlights');
    check(await ev('!SB.activeTab().busy'), 'and Esc in the find box did not touch the conversation');

    // 9. Zoom, and the VS Code palette key.
    await key('=', { ctrl: true });
    check(await until("/Zoom 110%/.test(document.getElementById('toast').textContent)"), 'Ctrl+= zooms to 110%');
    await key('0', { ctrl: true });
    check(await until("/Zoom 100%/.test(document.getElementById('toast').textContent)"), 'Ctrl+0 resets');
    await key('P', { ctrl: true, shift: true });
    check(await until("!document.getElementById('paletteSheet').hidden"), 'Ctrl+Shift+P opens the palette');
    await ev("(() => { const i = document.getElementById('paletteInput'); i.value = 'zoom'; i.dispatchEvent(new Event('input')); })()");
    check(await until("/Zoom in/.test(document.getElementById('paletteList').textContent)"), 'the palette has the zoom commands');
    await ev("(() => { const i = document.getElementById('paletteInput'); i.value = 'find'; i.dispatchEvent(new Event('input')); })()");
    check(await until("/Find in this conversation/.test(document.getElementById('paletteList').textContent)"), 'and Find');
    await key('Escape');

    // 10. Settings → Editor.
    await ev("SB.setView('settings')");
    check(await until("document.getElementById('editorSelect').options[0].textContent.startsWith('Automatic (')"), 'Settings → Editor says what Automatic means here');
    await ev("SB.jumpToSettingByName('Editor')");
    await wait(600);
    await shot('6-settings-editor');
  } finally {
    app.kill();
    await wait(1500);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  console.log(fails ? `\n${fails} check(s) failed` : '\nAll editor checks passed');
  process.exit(fails ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
