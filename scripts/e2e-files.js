// ci: All files in the File manager: the tree with git marks and folder totals, an edit and a commit lit up, the branch row's menu
// All files, the File manager's second tab (Ctrl+Shift+F), end to end against the fake CLI in a
// throwaway repository:
//   1. Ctrl+Shift+F opens it; Ctrl+Shift+E switches to the Trail rather than closing it, and back
//   2. the branch row says main and clean; the tree lists the project, folders first
//   3. an edit lights its row orange and opens its folder, dimmed; the marks and the folder's
//      totals follow; when the flash is over the folder closes again
//   4. a commit lights what it changed green, and the branch row is clean again
//   5. the branch row opens the worktree and branch menu, this worktree ticked
//   6. Ctrl+Shift+F closes it
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

    // ---- 6. closing
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
