// ci: Notes per project and General: add, edit, move, and Plan / Build / Ask
// Notes: a list per project plus a General one. Adding, editing, ticking off
// (into the Done fold), pinning, moving between lists, deleting and Clear done,
// each with Undo; and Plan / Build / Ask each opening a task in the right folder
// (Plan and Build in a copy), in the right mode, with the right prompt. Runs
// against the fake CLI; no account needed.
//   node scripts/e2e-notes.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9381;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  // A project to work in: a git repo, so it's keyed by its root.
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-notes-rack-'))); // CI's temp is an 8.3 short path; git says the long one
  execFileSync('git', ['init', '-q', repo]);
  // Plan and Build work in a copy, which needs a commit to start from.
  execFileSync('git', ['-C', repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '--allow-empty', '-m', 'start']);
  const key = repo.toLowerCase();
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47981' },
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
    const idle = async () => { for (let i = 0; i < 60 && await ev('SB.activeTab().busy'); i++) await wait(150); };
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true, mode: 'smart' }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);

    const open = () => ev("(SB.setView('notes'), SB.views.notes.render())");
    const texts = () => ev("[...document.querySelectorAll('#noteList .note-text')].map(e => e.textContent)");
    const scope = () => ev("document.getElementById('notesScope').value");
    const pick = s => ev(`(() => { const sel = document.getElementById('notesScope'); sel.value = ${JSON.stringify(s)}; sel.dispatchEvent(new Event('change')); })()`);
    const add = text => ev(`(() => { const i = document.getElementById('noteInput'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`).then(() => wait(400));
    const row = n => `document.querySelectorAll('#noteList .note')[${n}]`;
    const stored = () => ev('shellby.listNotes()');

    // ---- 1. it opens on the project you're working in
    await open();
    check(await scope() === key, 'Notes opens on the project you are working in');
    check(await ev("document.querySelector('#notesScope option:checked').textContent.includes('· here')"), 'and the list picker says it is the one here');
    check(await ev("document.querySelector('#noteList .note-empty') !== null"), 'an empty project says so');

    // ---- 2. adding: newest first, saved by the main process
    await add('add a dark mode');
    await add('export to STL');
    check((await texts()).join() === 'export to STL,add a dark mode', `notes go in newest first (${(await texts()).join(', ')})`);
    check(await ev("document.getElementById('noteInput').value") === '', 'the box clears after adding');
    check((await stored()).projects.find(x => x.key === key)?.notes.length === 2, 'the notes are saved by the main process, not just held in the panel');

    // ---- 3. General is its own list
    await pick('general');
    check((await texts()).length === 0, 'General starts empty');
    check(await ev("document.getElementById('notesWhere').textContent.includes('where you pick')"), 'General says its notes run where you pick');
    await add('learn rust\nproperly this time');
    check((await texts())[0] === 'learn rust\nproperly this time', 'a note keeps its line breaks');
    check((await stored()).general.length === 1, 'the General note is saved');

    // ---- 4. editing: click, type, Enter; Esc cancels without leaving the screen
    await ev(`${row(0)}.querySelector('.note-text').click()`);
    await wait(100);
    await ev(`(() => { const a = document.querySelector('#noteList .note-edit'); a.value = 'learn rust'; a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await wait(400);
    check((await stored()).general[0].text === 'learn rust', 'an edit is saved');
    await ev(`${row(0)}.querySelector('.note-text').click()`);
    await wait(100);
    await ev(`(() => { const a = document.querySelector('#noteList .note-edit'); a.value = 'oops'; a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
    await wait(300);
    check(await ev('SB.state.view') === 'notes', 'Esc in an edit stays on Notes');
    check((await stored()).general[0].text === 'learn rust', 'and throws the edit away');

    // ---- 5. moving a note from General into the project
    await ev(`${row(0)}.querySelector('.note-more').click()`);
    const targets = await ev("[...document.querySelectorAll('#noteMenu .menu-item .mi-title')].map(e => e.textContent)");
    check(targets.includes(path.basename(repo)) && targets.includes('Delete'), `the menu offers the project and Delete (${targets.join(', ')})`);
    await ev(`[...document.querySelectorAll('#noteMenu .menu-item')].find(b => b.textContent === ${JSON.stringify(path.basename(repo))}).click()`);
    await wait(400);
    const s5 = await stored();
    check(s5.general.length === 0 && s5.projects.find(x => x.key === key)?.notes[0].text === 'learn rust', 'the note moves into the project');

    // ---- 6. ticking off folds a note away under Done
    await pick(key);
    await ev(`${row(0)}.querySelector('.note-check').click()`);
    await wait(400);
    check(!(await texts()).includes('learn rust'), 'a ticked-off note leaves the list');
    check(await ev("document.querySelector('#notesDone .notes-done-toggle')?.textContent.includes('Done · 1')"), 'and is counted under Done');
    await ev("document.querySelector('#notesDone .notes-done-toggle').click()");
    check(await ev("document.querySelector('#notesDone .note.done .note-text')?.textContent") === 'learn rust', 'opening Done shows it, looking done');

    // ---- 6b. pinning puts a note first
    await ev(`${row(1)}.querySelector('.note-more').click()`);
    await ev("[...document.querySelectorAll('#noteMenu .menu-item')].find(b => b.textContent === 'Pin to top').click()");
    await wait(400);
    check((await texts())[0] === 'add a dark mode' && await ev(`${row(0)}.classList.contains('pinned')`), 'a pinned note goes first');
    await ev(`${row(0)}.querySelector('.note-more').click()`);
    await ev("[...document.querySelectorAll('#noteMenu .menu-item')].find(b => b.textContent === 'Unpin').click()");
    await wait(400);
    check((await texts()).join() === 'export to STL,add a dark mode', 'and unpinning puts it back');

    // ---- 7. Ask: read-only, in the project's folder, asking for a verdict
    const run = async (n, kind) => { await open(); await ev(`${row(n)}.querySelector('.note-${kind}').click()`); await wait(300); await idle(); };
    const last = () => ev('shellby.listSessions().then(l => l[0])');
    await run(0, 'ask');
    check(await ev('SB.state.view') === 'chat', 'Ask opens the conversation');
    let entry = await last();
    check(entry.title === 'Ask: export to STL', `the tab says what it is (${entry.title})`);
    check(entry.mode === 'ask', `Ask runs in Ask-first mode whatever mode you are in (${entry.mode})`);
    check(entry.cwd.toLowerCase() === key, 'in the project folder');
    const said = await ev("SB.activeTab().el.textContent");
    check(said.includes('"Do it", "Do it differently" or "Skip it"') && said.includes('Read only'), 'the prompt asks for a verdict and changes nothing');

    // ---- 8. Plan: the note as written, in Plan mode, in a copy
    await run(1, 'plan');
    entry = await last();
    check(entry.mode === 'plan' && entry.title === 'Plan: add a dark mode', `Plan runs in Plan mode (${entry.mode}, ${entry.title})`);
    check(await ev("SB.activeTab().el.textContent.includes('echo: add a dark mode')"), 'and sends the note exactly as written');
    check(entry.cwd.toLowerCase() !== key, `in a copy, not your checkout (${entry.cwd})`);

    // ---- 9. Build: the note as written, in your current mode, in a copy
    await run(1, 'build');
    entry = await last();
    check(entry.mode === 'smart' && entry.title === 'add a dark mode', `Build runs in your current mode (${entry.mode}, ${entry.title})`);
    check(entry.cwd.toLowerCase() !== key, `in a copy, not your checkout (${entry.cwd})`);

    // ---- 10. the note remembers, and links back
    await open();
    check(await ev(`${row(1)}.querySelector('.note-last')?.textContent`) === 'Built just now · open', 'the note says what was last done with it');
    await ev(`${row(0)}.querySelector('.note-last').click()`);
    await wait(500);
    check(await ev('SB.state.view') === 'chat' && await ev('SB.activeTab().title') === 'Ask: export to STL', 'and opens that conversation');

    // ---- 11. delete, with Undo; and the lists only take projects Shellby knows
    // Build's "Moved to <copy>" holds the toast slot until you move on, which a
    // scripted click never does: dismiss it, or Delete's Undo waits behind it.
    await ev("document.querySelector('#toast .toast-close')?.click()");
    await open();
    await ev(`${row(1)}.querySelector('.note-more').click()`);
    await ev("[...document.querySelectorAll('#noteMenu .menu-item')].find(b => b.textContent === 'Delete').click()");
    await wait(400);
    check((await texts()).join() === 'export to STL', 'a note can be deleted');
    await ev("[...document.querySelectorAll('#toast .toast-action')].find(b => b.textContent === 'Undo').click()");
    await wait(400);
    check((await texts()).join() === 'export to STL,add a dark mode', 'and Undo puts it back where it was');
    check((await stored()).projects.find(x => x.key === key)?.notes.find(x => x.text === 'add a dark mode')?.runs.length === 2, 'with its runs');

    // ---- 12. Clear done, with Undo
    await ev("document.querySelector('#notesDone .notes-clear').click()");
    await wait(400);
    check(await ev("document.getElementById('notesDone').hidden"), 'Clear takes the done notes');
    await ev("[...document.querySelectorAll('#toast .toast-action')].find(b => b.textContent === 'Undo').click()");
    await wait(400);
    check((await stored()).projects.find(x => x.key === key)?.notes.length === 3, 'and Undo brings them back');
    const r = await ev("shellby.addNote({ scope: 'c:\\\\windows\\\\system32', text: 'x' })");
    check(r?.ok === false, 'a note for a folder Shellby does not know is refused');
    check(await ev("shellby.runNote({ scope: 'general', id: 'nope', kind: 'build' }).then(r => r.ok)") === false, 'running a note that is not there does nothing');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
