// End-to-end check of the editor touches against the dev app over CDP with
// the fake CLI, in a throwaway folder: an edit's permission card shows its diff
// with line numbers, the tool row folds open to it, paths in replies are links
// (checked, never clicked, so nothing opens in a real editor), Ctrl+F finds
// text, Ctrl+= zooms, Ctrl+Shift+P opens the palette, and Settings → Editor
// says what Automatic means here.
//   node scripts/e2e-editor.js [screenshot-folder]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9397;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const shots = process.argv[2];
  if (shots) fs.mkdirSync(shots, { recursive: true });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-editor-work-'));
  fs.writeFileSync(path.join(work, 'notes.txt'), 'first line\nsecond line\nthird line\n');

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47958' },
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
    const shot = async name => { if (shots) await savePng(send, path.join(shots, `${name}.png`)); };
    const key = (k, mods = {}) => ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} }))`);
    const feed = 'SB.activeTab().el';

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(work)}).then(r => SB.folderChanged(r))`);
    check(await until(`SB.activeTab()?.cwd?.toLowerCase() === ${JSON.stringify(work.toLowerCase())}`), 'a conversation in the test folder');

    // 1. An edit asks first, with its diff.
    await ev("SB.send('editask notes.txt')");
    const card = `[...${feed}.querySelectorAll('.ask')].pop()`;
    check(await until(`!!${card}?.querySelector('.ediff')`), 'the edit card shows a diff');
    check(await ev(`${card}.querySelector('.er.del .et')?.textContent === 'first line' && ${card}.querySelector('.er.add .et')?.textContent === 'changed in turn 1'`), 'removed and added lines are the real ones');
    check(await ev(`${card}.querySelector('.er.del .en')?.textContent === '1'`), 'with line numbers from the file');
    check(await ev(`${card}.querySelector('.ask-file .file-link')?.textContent === 'notes.txt'`), 'the file is a link, relative to the folder');
    check(await ev(`/line 1/.test(${card}.querySelector('.ask-line')?.textContent || '') && /\\+1/.test(${card}.querySelector('.dstat')?.textContent || '')`), 'line and +/- counts in the header');
    await shot('1-edit-card');
    await ev(`${card}.querySelector('.btn.allow').click()`);
    check(await until('!SB.activeTab().busy'), 'allowed, the turn finishes');
    check(fs.readFileSync(path.join(work, 'notes.txt'), 'utf8').startsWith('changed in turn 1'), 'the file really changed');
    await wait(400);
    await ev('SB.clearCelebrations?.()'); // the first-task trophy would cover the screenshots

    // 2. The tool row: counts in the summary, the diff when opened, no "has been updated" text.
    const row = `[...${feed}.querySelectorAll('.tool.edit')].pop()`;
    check(await ev(`!!${row}?.querySelector('summary .dstat') && !!${row}.querySelector('summary a.file-link')`), 'the tool row has the file link and counts');
    await ev(`${row}.open = true`);
    check(await until(`!!${row}.querySelector('.ediff') && !${row}.querySelector('.t-result')`), 'opening it shows the diff, not the result text');

    // 3. A path in a reply is a link.
    await ev("SB.send('see `notes.txt:2` and `config.get`')");
    check(await until('!SB.activeTab().busy'), 'the reply arrives');
    const last = `[...${feed}.querySelectorAll('.msg.assistant')].pop()`;
    check(await ev(`${last}.querySelector('a.file-link')?.dataset.path === 'notes.txt:2' && ${last}.querySelector('a.file-link').dataset.line === '2'`), '`notes.txt:2` became a link to line 2');
    check(await ev(`${last}.querySelectorAll('a.file-link').length === 1`), '`config.get` stayed text');
    const missing = await ev("shellby.openFile(SB.state.activeTab, 'nope/missing.js')");
    check(missing && !missing.ok && /Couldn't find/.test(missing.error), 'a file that is not there says so instead of opening anything');
    const editors = await ev('shellby.getEditors()');
    console.log(`      (links here would open in: ${editors?.using || "Windows' default app"})`);

    // 4. Ctrl+F.
    await ev("document.getElementById('input').focus()");
    await key('f', { ctrl: true });
    check(await until("!document.getElementById('findBar').hidden && document.activeElement.id === 'findInput'"), 'Ctrl+F opens the find bar');
    await ev("(() => { const i = document.getElementById('findInput'); i.value = 'notes'; i.dispatchEvent(new Event('input')); })()");
    // It starts at the first match on screen, which needn't be the first in the conversation.
    check(await until("/^\\d+ of \\d+$/.test(document.getElementById('findCount').textContent)"), 'it counts matches');
    const [at, total] = String(await ev("document.getElementById('findCount').textContent")).split(' of ').map(Number);
    await key('Enter');
    check(await ev("document.getElementById('findCount').textContent") === `${at % total + 1} of ${total}`, 'Enter goes to the next one');
    check(await ev("CSS.highlights.get('shellby-find')?.size") === total, 'every match is highlighted');
    await shot('2-find');
    await key('Escape');
    check(await ev("document.getElementById('findBar').hidden && !CSS.highlights.has('shellby-find')"), 'Esc closes it and clears the highlights');

    // 5. Zoom, and the VS Code palette key.
    await ev("document.getElementById('input').focus()");
    await key('=', { ctrl: true });
    check(await until("/Zoom 110%/.test(document.body.textContent)"), 'Ctrl+= zooms to 110%');
    await key('0', { ctrl: true });
    check(await until("/Zoom 100%/.test(document.body.textContent)"), 'Ctrl+0 resets');
    await key('P', { ctrl: true, shift: true });
    check(await until("!document.getElementById('paletteSheet').hidden"), 'Ctrl+Shift+P opens the palette');
    await ev("(() => { const i = document.getElementById('paletteInput'); i.value = 'zoom'; i.dispatchEvent(new Event('input')); })()");
    check(await until("/Zoom in/.test(document.getElementById('paletteList').textContent)"), 'the palette has the zoom commands');
    await ev("(() => { const i = document.getElementById('paletteInput'); i.value = 'find in'; i.dispatchEvent(new Event('input')); })()");
    check(await until("/Find in this conversation/.test(document.getElementById('paletteList').textContent)"), 'and Find');
    await key('Escape');

    // 6. Settings → Editor.
    await ev("SB.setView('settings')");
    await ev("SB.jumpToSettingByName?.('Editor')");
    check(await until("document.getElementById('editorSelect').options[0].textContent.startsWith('Automatic (')"), 'Settings → Editor says what Automatic means here');
    await wait(600);
    await shot('3-settings-editor');
  } finally {
    app.kill();
    await wait(1500);
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  console.log(fails ? `\n${fails} check(s) failed` : '\nAll editor checks passed');
  process.exit(fails ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
