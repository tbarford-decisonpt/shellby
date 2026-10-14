// ci: All files in the File manager: the tree with git marks and folder totals, an edit and a commit lit up, the branch row's menu
// All files, the File manager's second tab (Ctrl+Shift+F), end to end against the fake CLI in a
// throwaway repository:
//   1. Ctrl+Shift+F opens it; Ctrl+Shift+E switches to the Trail rather than closing it, and back
//   2. the branch row says main and clean; the tree lists the project, folders first
//   3. an edit lights its row orange and opens its folder, dimmed; the marks and the folder's
//      totals follow; when the flash is over the folder closes again; hidden mid-tool, it still goes dark
//   4. a commit lights what it changed green, and the branch row is clean again
//   5. the branch row opens the worktree and branch menu, this worktree ticked
//   6. a picked file: its chip, the [Shellby: line reaching Claude, still picked after; × clears it;
//      @path in the box finds its row without picking it; a message typed mid-turn keeps its pick;
//      a folder made mid-turn shows at once, with its files
//   7. Ctrl+Shift+F closes it
// CI has reduced motion on: rows are checked by class, never by how they move.
// No account, no network beyond this PC.
//   node scripts/e2e-files.js [--shots <dir>]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9427;
const HOOK_PORT = '48027';
const wait = ms => new Promise(r => setTimeout(r, ms));
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : process.env.E2E_SHOTS || null; })();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-files-')));
const repo = path.join(base, 'proj');
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
put('src/app.js', 'let total = 0;\nmodule.exports = { total };\n');
put('src/util.js', 'const total = n => n;\nmodule.exports = { total };\n');
put('docs/guide.md', '# Guide\n');
put('README.md', '# Proj\n');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'core.autocrlf', 'false');
git('add', '-A');
git('commit', '-qm', 'init');
// A worktree inside the project, ignored there, as Claude Code's EnterWorktree makes one. Made now
// so every menu lists it: main reuses a repo's list for 10 s.
const wt = path.join(repo, '.claude', 'worktrees', 'wt');
fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.claude/\n');
git('worktree', 'add', '-q', '-b', 'wt', wt);
const claudeConfig = path.join(base, 'claude');
fs.mkdirSync(claudeConfig);

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_E2E: '1', SHELLBY_USER_DATA: path.join(base, 'userdata'), CLAUDE_CONFIG_DIR: claudeConfig, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: HOOK_PORT },
  });
  try {
    let list = [];
    for (let i = 0; i < 60 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const target = list.find(t => t.url.endsWith('panel.html'));
    if (!target) throw new Error(`the panel never came up on port ${PORT}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0; const p = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); p.delete(m.id); };
    const DEADLINE_MS = 20000;
    const send = (method, params) => new Promise((resolve, reject) => {
      const i = ++id;
      const t = setTimeout(() => { p.delete(i); reject(new Error(`${method} got no answer in ${DEADLINE_MS / 1000}s`)); }, DEADLINE_MS);
      p.set(i, m => { clearTimeout(t); resolve(m); });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(m => {
      if (m.result?.exceptionDetails) throw new Error(`${m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text}\n  in: ${expr.slice(0, 160)}`);
      return m.result?.result?.value;
    });
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 150) { if (await ev(expr)) return true; await wait(150); } return false; };
    const key = async (k, mods = {}) => {
      const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
      const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
      const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: mods.shift && k.length === 1 ? k.toUpperCase() : k, code, modifiers, windowsVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
    };
    const shot = async (name) => {
      if (!SHOTS) return;
      await ev("document.querySelectorAll('.celebrate .cel-close').forEach(b => b.click())");
      await wait(400);
      await Promise.race([savePng((m, params) => send(m, params).then(r => r.result), path.join(SHOTS, `files-${name}.png`)), wait(10000)]);
    };
    const row = k => `[...document.querySelectorAll('#filesDock .ft-rows .ft-row')].find(r => r.dataset.key === ${JSON.stringify(k)})`;
    const cur = 'SB.filesDock.current()';
    const litAs = (rel, tone) => `(${cur}?.lit || []).some(([p, t]) => p.toLowerCase() === ${JSON.stringify(rel)} && t === ${JSON.stringify(tone)})`;
    const tabUp = name => `!document.getElementById('trail').hidden && document.getElementById(${JSON.stringify(name === 'files' ? 'drawerTabFiles' : 'drawerTabTrail')}).getAttribute('aria-selected') === 'true'`;

    check(await until("performance.getEntriesByName('shellby:panel-ready').length > 0 && typeof SB.toggleDrawer === 'function' && !!SB.filesDock", 30000), 'the panel booted with All files in it');
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await ev('SB.newTab()');
    check(await until(`SB.activeTab() && SB.activeTab().cwd && SB.activeTab().cwd.toLowerCase() === ${JSON.stringify(repo.toLowerCase())}`), 'a new conversation in the throwaway repository');

    // ---- 1. the shortcuts
    // A fresh profile: the drawer opens on All files, however it is opened.
    await ev('SB.toggleTrail(true)');
    check(await until(`${tabUp('files')} && !document.getElementById('filesDock').hidden && document.getElementById('trailPanel').hidden && document.getElementById('trail').dataset.tab === 'files'`), 'a fresh profile opens the File manager on All files');
    check(await ev("document.querySelector('.trail-head .drawer-tabs [role=tab]').id") === 'drawerTabFiles', 'All files is its first tab');
    await ev('SB.toggleTrail(false)');
    await ev("document.getElementById('input').focus()");
    await key('f', { ctrl: true, shift: true });
    check(await until(`${tabUp('files')} && !document.getElementById('filesDock').hidden && document.getElementById('trailPanel').hidden`), 'Ctrl+Shift+F opens the File manager on All files');
    check(await ev("document.activeElement === document.querySelector('#filesDock .ft-tree')"), 'the tree has the keyboard');
    await key('e', { ctrl: true, shift: true });
    check(await until(`${tabUp('trail')} && document.getElementById('filesDock').hidden`), 'Ctrl+Shift+E switches to the Trail rather than closing it');
    await key('f', { ctrl: true, shift: true });
    check(await until(tabUp('files')), 'and Ctrl+Shift+F back');

    // ---- 2. the branch row and the tree
    check(await until(`${cur}?.branch === 'main' && document.querySelector('#filesDock .ft-branch-name')?.textContent === 'main'`), 'the branch row names the branch');
    await ev("window.__ftWhere = document.querySelector('#filesDock .ft-where')");
    check(await until("document.querySelector('#filesDock .ft-sums')?.textContent === 'clean'"), 'and says it is clean');
    check(await until(`!!${row('src')} && !!${row('docs')} && !!${row('readme.md')}`), 'the tree lists the project');
    check(await ev(`[...document.querySelectorAll('#filesDock .ft-rows .ft-row')].findIndex(r => r.dataset.key === 'readme.md') > [...document.querySelectorAll('#filesDock .ft-rows .ft-row')].findIndex(r => r.dataset.key === 'src')`), 'folders first');
    check(await ev(`${row('src')}.getAttribute('aria-expanded')`) === 'false', 'src starts closed');
    await shot('tree');

    // ---- 3. an edit lights its row and opens its folder
    await ev("SB.send('edit src/app.js hello world')");
    check(await until(litAs('src/app.js', 'write'), 4000), 'the edit lights src/app.js orange');
    check(await until(`${row('src')}?.getAttribute('aria-expanded') === 'true' && ${row('src')}?.classList.contains('revealed') && !!${row('src/app.js')}?.classList.contains('lit')`, 4000), 'and opens src to show it, dimmed as a folder only the flash opened');
    check(await until(`${row('src/app.js')}?.classList.contains('t-write')`, 4000), 'the row carries the write tone');
    await shot('lit');
    check(await until("!SB.activeTab().busy", 15000), 'the edit finishes');
    check(await until(`(${cur}?.files || []).some(f => f.path === 'src/app.js' && f.status === 'M' && f.added === 1 && f.removed === 2)`), 'git now marks it M, +1 −2');
    check(await until(`(${row('src')}?.querySelector('.ft-sum')?.textContent || '') === '+1 −2 M:1'`), "src's totals say so even when it's closed");
    check(await until("document.querySelector('#filesDock .ft-sums')?.textContent === '+1 −2 M:1'"), 'and so does the branch row');
    check(await until(`!(${cur}?.lit || []).length && ${row('src')}?.getAttribute('aria-expanded') === 'false'`, 8000), 'when the flash is over, src closes again');
    // Hidden while a tool runs: its result still comes in, so the flash ends once the tab is back.
    const take = item => ev(`SB.filesTake(SB.activeTab(), ${JSON.stringify(item)})`);
    await take({ kind: 'tool', id: 'e2e-hidden', name: 'Edit', filePath: path.join(repo, 'docs', 'guide.md') });
    check(await until(litAs('docs/guide.md', 'write'), 4000), 'a tool lights docs/guide.md');
    await ev("SB.toggleDrawer('trail')");
    await take({ kind: 'tool_result', id: 'e2e-hidden' });
    await take({ kind: 'result' });
    await ev("SB.toggleDrawer('files')");
    check(await until(`${tabUp('files')} && !!${cur} && !${cur}.lit.length`, 8000), 'with the tab hidden while it ran, it still goes dark');

    // ---- 4. a commit lights what it changed green
    git('add', '-A');
    git('commit', '-qm', 'work');
    await ev("SB.send('hello')"); // its turn's end nudges the tree, as one that committed would
    check(await until(litAs('src/app.js', 'commit'), 12000), 'the commit lights src/app.js green');
    check(await until("document.querySelector('#filesDock .ft-sums')?.textContent === 'clean'"), 'and the branch row is clean again');
    await shot('commit');

    // ---- 5. the branch row's menu
    await ev("document.querySelector('#filesDock .ft-where').click()");
    check(await until("!document.getElementById('filesMenu').hidden && document.getElementById('filesMenu').textContent.includes('Worktrees') && document.getElementById('filesMenu').textContent.includes('✓')"), 'the branch row opens the worktree and branch menu, this one ticked');
    check(await ev("document.querySelector('#filesDock .ft-where') === window.__ftWhere"), 'the branch button is the same element after the edit and the commit reads, so the menu stays anchored to it');
    check(await ev("(m => (d => m.top > 0 && m.left >= d.left - 4 && m.left < d.right)(document.getElementById('filesDock').getBoundingClientRect()))(document.getElementById('filesMenu').getBoundingClientRect())"), 'and the menu opens beside the dock, not at the window corner');
    await ev('SB.closeMenus()');

    // ---- 6. a picked file goes along with the next message
    // As the user does it: text in the box, then send. SB.send('...') is a message Shellby composed, with no pick.
    const typeSend = text => ev(`(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return SB.send(); })()`);
    await ev(`${row('readme.md')}.click()`);
    check(await until("!document.getElementById('pickChip').hidden && document.getElementById('pickChip').textContent.includes('README.md')"), 'a click picks README.md: its chip shows above the box');
    check(await ev("document.querySelector('#filesDock .ft-picked').textContent") === 'README.md', 'and the footer names it');
    check(await ev(`${row('readme.md')}.classList.contains('picked')`), 'its row is marked');
    await typeSend('what is this');
    check(await until("document.querySelector('.feed:not([hidden])').textContent.includes('[Shellby: the user has the file \"README.md\" selected in the file tree')", 12000), 'Claude is told which file is picked (the fake CLI echoes its prompt)');
    check(await until("!SB.activeTab().busy", 15000), 'that turn finishes');
    check(await ev("!document.getElementById('pickChip').hidden"), 'the pick stays after sending');
    // A message Shellby composed (a fix prompt, a chip) goes without the pick, which stays.
    const told = "document.querySelector('.feed:not([hidden])').textContent.split('[Shellby: the user has the file').length - 1";
    const toldBefore = await ev(told);
    await ev("SB.send('composed text')");
    check(await until("/echo:[^]*composed text/.test(document.querySelector('.feed:not([hidden])').textContent) && !SB.activeTab().busy", 15000), 'a message composed by code reaches Claude');
    check(await ev(told) === toldBefore, 'without the [Shellby: line about the picked file');
    check(await ev("!document.getElementById('pickChip').hidden"), 'and the pick is still there');
    await ev("document.querySelector('#pickChip button').click()");
    check(await until("document.getElementById('pickChip').hidden && document.querySelector('#filesDock .ft-picked').textContent === ''"), '× clears it');
    await ev("(() => { const i = document.getElementById('input'); i.value = '@src/util.js '; i.selectionStart = i.selectionEnd = i.value.length; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    check(await until(`!!${row('src/util.js')} && document.querySelector('#filesDock .ft-tree').getAttribute('aria-activedescendant') === ${row('src/util.js')}?.id`), '@src/util.js in the box brings its row into view with the keyboard on it');
    check(await ev("document.getElementById('pickChip').hidden"), 'without picking it');
    await ev("(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    // A folder made mid-turn: git lists it whole ('?? feature/'), so its row comes from status at once,
    // and the tree is read afresh (main's list is cached 20 s) so what's in it shows too.
    await ev("SB.toggleDrawer('trail')");
    await ev("SB.toggleDrawer('files')"); // a tree read: main's list of the folder is cached from here
    check(await until(`${tabUp('files')} && !!${row('src')}`), 'the tree is read again');
    await ev("SB.send('steps 3 1200')");
    check(await until('SB.activeTab().busy'), 'a turn of several steps starts');
    put('feature/a.js', 'a\n');
    put('feature/b.js', 'b\n');
    check(await until(`${row('feature')}?.querySelector('.ft-st')?.textContent === '?'`, 10000), 'a folder made mid-turn shows in the tree, marked ?');
    check(await until('!SB.activeTab().busy', 15000), 'that turn finishes');
    await ev(`(r => r.getAttribute('aria-expanded') === 'true' || r.click())(${row('feature')})`);
    check(await until(`!!${row('feature/a.js')} && !!${row('feature/b.js')}`), 'with both files in it');
    // Typed while Claude works, with a pick: queued with it, not steered in mid-turn (that carries no
    // pick), and sent with it when the turn ends, even though the pick is cleared meanwhile.
    await ev("SB.send('steps 4 600')");
    check(await until('SB.activeTab().busy'), 'a turn of several steps starts');
    await ev(`(r => r.getAttribute('aria-expanded') === 'true' || r.click())(${row('docs')})`);
    check(await until(`!!${row('docs/guide.md')}`), 'docs opens');
    await ev(`${row('docs/guide.md')}.click()`);
    check(await until("document.getElementById('pickChip').textContent.includes('guide.md')"), 'docs/guide.md is picked');
    await typeSend('with a pick');
    check(await ev("SB.activeTab().queue.length === 1 && SB.activeTab().queue[0].selected === 'docs/guide.md'"), 'the message typed meanwhile is queued with the pick');
    await ev("document.querySelector('#pickChip button').click()");
    check(await until("document.querySelector('.feed:not([hidden])').textContent.includes('[Shellby: the user has the file \"docs/guide.md\" selected in the file tree')", 20000), 'it reaches Claude with its [Shellby: line after the turn, though the pick was cleared since');
    check(await ev("!document.querySelector('.feed:not([hidden])').textContent.includes('steered: with a pick')"), 'and was never steered in mid-turn');
    check(await until('!SB.activeTab().busy', 15000), 'that turn finishes');

    // A file added to a folder git already lists whole: '?? feature/' doesn't change, so only a fresh
    // read of the tree can show it.
    await ev("SB.send('edit feature/c.js c')");
    check(await until('!SB.activeTab().busy', 15000), 'a turn adds feature/c.js beside them');
    check(await until(`!!${row('feature/c.js')}`, 8000), 'it shows in the tree, though git still lists the folder whole');

    // A worktree inside the project (as Claude Code's EnterWorktree makes one), picked from the
    // branch row's menu: what Claude adds there shows while it's the view, and back home shows home.
    const pickTree = home => ev(`(async () => {
      document.querySelector('#filesDock .ft-where').click();
      for (let i = 0; i < 100 && !document.querySelector('#filesMenu [role=menuitem]'); i++) await new Promise(r => setTimeout(r, 50));
      const items = [...document.querySelectorAll('#filesMenu [role=menuitem]')];
      const want = items.find(b => ${home ? "b.textContent.includes('✓') === false && b.textContent.includes('main')" : "b.textContent.includes('wt') && !b.textContent.includes('✓')"});
      want?.click();
      return want ? true : 'menu: ' + JSON.stringify(items.map(b => b.textContent));
    })()`);
    const offered = await pickTree(false);
    if (offered !== true) console.log(offered);
    check(offered === true, 'the menu offers the worktree');
    check(await until(`(${cur}?.root || '').toLowerCase().endsWith('wt') && !!${cur}?.place`, 8000), 'picking it shows its tree');
    fs.mkdirSync(path.join(wt, 'newdir'));
    fs.writeFileSync(path.join(wt, 'newdir', 'one.js'), '1\n');
    await ev("SB.send('hello')"); // its turn's end nudges every view on the project's folders
    check(await until('!SB.activeTab().busy', 15000), 'a turn ends');
    check(await until(`${row('newdir')}?.querySelector('.ft-st')?.textContent === '?'`, 8000), 'a folder made in the worktree shows, marked ?');
    await ev(`(r => r.getAttribute('aria-expanded') === 'true' || r.click())(${row('newdir')})`);
    check(await until(`!!${row('newdir/one.js')}`, 4000), 'with its file');
    await ev(`SB.send(${JSON.stringify(`editabs ${path.join(wt, 'newdir', 'two.js')} 2`)})`);
    check(await until('!SB.activeTab().busy', 15000), 'a turn adds a second file there');
    check(await until(`!!${row('newdir/two.js')}`, 8000), 'it shows while the worktree is the view, without switching away and back');
    check((await pickTree(true)) === true, 'the menu offers the home checkout');
    check(await until(`!${cur}?.place && (${cur}?.root || '').toLowerCase() === ${JSON.stringify(repo.toLowerCase())}`, 8000), 'picking it goes back home');
    check(await until(`!${row('newdir')} && !!${row('feature/c.js')}`, 8000), "and shows home's tree, not the worktree's");
    // The worktree being viewed is deleted: back home, with the branch row (and its menu) still there.
    check((await pickTree(false)) === true && await until(`!!${cur}?.place`, 8000), 'the worktree is the view again');
    git('worktree', 'remove', '--force', wt);
    await ev("SB.send('hello')");
    check(await until('!SB.activeTab().busy', 15000), 'a turn ends after it was deleted');
    check(await until(`!${cur}?.place && (${cur}?.root || '').toLowerCase() === ${JSON.stringify(repo.toLowerCase())} && !!document.querySelector('#filesDock .ft-where')`, 8000), 'a deleted worktree goes back home, the branch row still there to pick another');
    check(await ev("!document.querySelector('#filesDock .ft-note')"), 'not stuck on "This folder is gone"');
    git('worktree', 'add', '-q', wt, 'wt');
    check((await pickTree(false)) === true && await until(`!!${cur}?.place && !!${row('newdir')}`, 8000), 'made again, it can be picked again');
    check((await pickTree(true)) === true && await until(`!${cur}?.place`, 8000), 'and home again');

    // ---- 7. closing
    await ev("document.querySelector('#filesDock .ft-tree').focus()");
    await key('f', { ctrl: true, shift: true });
    check(await until("document.getElementById('trail').hidden"), 'Ctrl+Shift+F closes it');
  } catch (e) {
    console.log(`FAIL  ${e.message}`);
    fails++;
  } finally {
    try { process.kill(app.pid); } catch { /* gone */ }
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    await wait(800);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* the OS still holds a file; temp gets it */ }
    console.log(fails ? `\n${fails} check(s) failed` : '\nall All files checks passed');
    process.exit(fails ? 1 : 0);
  }
})();
