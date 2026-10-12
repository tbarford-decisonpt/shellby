// ci: the file viewer: a copy's changes and diffs, whole files, live refresh, Esc back to the panes
// The file viewer (panel/viewer.js, main's viewer.js) end to end against the
// fake CLI: a conversation in its own copy edits files, the viewer lists them
// with diffs and the new side's line numbers, a second edit shows up on its own,
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
// Forty committed lines: a copy that changes two far apart gets a diff of two hunks.
const MULTI = Array.from({ length: 40 }, (_v, i) => `line ${i + 1}`);
fs.writeFileSync(path.join(repo, 'multi.txt'), `${MULTI.join('\n')}\n`);
git('add', '-A');
git('commit', '-qm', 'init');
const claudeConfig = path.join(base, 'claude');
fs.mkdirSync(claudeConfig);
const userData = path.join(base, 'userdata');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: false, worktrees: true, projects: { added: [repo] } }));
fs.writeFileSync(path.join(base, 'outside.txt'), 'not in the project\n');

// What the turns write, and so what the viewer must list: counts come from here.
// The last one is a single long line (300 characters or so), wider than any panel, to see wrapping.
const MADE = [
  { file: 'b.txt', words: 'made in the copy' },
  { file: 'c.txt', words: 'second change' },
  { file: 'long.txt', words: 'a long line that must wrap in a narrow panel '.repeat(7).trim() },
];
const ADDED = MADE.reduce((n, m) => n + m.words.split('\n').length, 0); // each turn writes its words as lines
const FOOT = `${MADE.length} files · +${ADDED}`;

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
    const paneId = await ev(`SB.panes.paneWith(SB.state.grid, ${JSON.stringify(copyTab)}).id`);
    check(await until(`!document.querySelector('.pane-head[data-pane="${paneId}"] .pane-files').hidden`), "the copy's pane has a Files button");
    await ev(`document.querySelector('.pane-head[data-pane="${paneId}"] .pane-files').click()`);
    check(await until("SB.state.view === 'viewer' && document.querySelectorAll('#viewerList .vw-row').length > 0"), 'the viewer opens on the copy');
    const rows = await ev("[...document.querySelectorAll('#viewerList .vw-row')].map(b => b.dataset.path + ':' + b.querySelector('.vw-st').textContent)");
    check(JSON.stringify(rows) === JSON.stringify([`${MADE[0].file}:?`]), `Changes lists the new file as untracked (${rows})`);
    check(/\(from main\)/.test(await ev("document.getElementById('viewerWhere').textContent")), 'the header names the base');
    check(await until(`document.querySelector('#viewerMain .vw-empty p')?.textContent === 'Pick a file to see what changed.' && document.querySelector('#viewerMain .vw-totals')?.textContent === ${JSON.stringify(`1 file · +${MADE[0].words.split('\n').length}`)}`), 'with no file picked, the right panel says so and totals the changes');
    await shot('0-pick-a-file');
    await ev(`[...document.querySelectorAll('#viewerList .vw-row')].find(b => b.dataset.path === ${JSON.stringify(MADE[0].file)}).click()`);
    check(await until(`[...document.querySelectorAll('#viewerMain .dl.add .code')].some(c => c.textContent === ${JSON.stringify(MADE[0].words)})`), 'its diff shows the line coming');
    check(await ev("document.querySelector('#viewerMain .dl.add .vw-ln:nth-child(2)').textContent") === '1', 'with the new side numbered');
    await shot('1-changes');
    check(await ev("document.querySelector('#viewerMain .vw-file-head .vw-wrap')?.getAttribute('aria-pressed')") === 'true', 'the file header has a Wrap button, on by default');

    // ---- a second edit shows up on its own. SB.send goes back to the chat (tab-send.js), so the
    // viewer hears the nudge while hidden and catches up when it's shown again.
    for (const m of MADE.slice(1)) {
      await ev(`SB.send(${JSON.stringify(`edit ${m.file} ${m.words}`)})`);
      await idle();
    }
    check(await ev("SB.state.view === 'chat' && SB.viewer.current() !== null"), 'sending went back to the chat, the viewer kept its place');
    await ev("SB.setView('viewer')");
    check(await until(`document.querySelectorAll('#viewerList .vw-row').length === ${MADE.length}`), 'shown again, it lists the later edits');
    check(await ev(`SB.viewer.current().file === ${JSON.stringify(MADE[0].file)}`), 'and still has the file you were on');
    check(await until(`document.getElementById('viewerFoot').textContent === ${JSON.stringify(FOOT)}`), `the left panel's footer totals the changes (${FOOT})`);
    check(await ev("!document.getElementById('viewerFoot').hidden"), 'and shows');

    // ---- long lines wrap, and Wrap turns it off: the code scrolls sideways inside its own area
    const scrollerFits = "(() => { const s = document.querySelector('#viewerMain .vw-scroll'); return s.scrollWidth <= s.clientWidth + 1; })()";
    const open = file => ev(`[...document.querySelectorAll('#viewerList .vw-row')].find(b => b.dataset.path === ${JSON.stringify(file)}).click()`);
    const longWords = JSON.stringify(MADE[2].words);
    await open(MADE[2].file);
    check(await until(`[...document.querySelectorAll('#viewerMain .dl.add .code')].some(c => c.textContent === ${longWords})`), 'the long line is in its diff');
    check(await ev("!document.querySelector('#viewerMain .vw-code').classList.contains('nowrap')") && await ev(scrollerFits), 'wrapped, it has no sideways overflow');
    await shot('1b-wrapped');
    const lefts = await ev("(() => { const c = [...document.querySelectorAll('#viewerMain .dl.add .code')].find(x => x.textContent.length > 200); const r = document.createRange(); r.selectNodeContents(c); return [...r.getClientRects()].map(x => Math.round(x.left)); })()");
    check(lefts.length > 2 && Math.min(...lefts.slice(1)) > lefts[0], `a wrapped line's continuation rows are indented (first row at ${lefts[0]}, the others from ${Math.min(...lefts.slice(1))})`);
    await ev("document.querySelector('#viewerMain .vw-wrap').click()");
    check(await ev("document.querySelector('#viewerMain .vw-code').classList.contains('nowrap') && document.querySelector('#viewerMain .vw-wrap').getAttribute('aria-pressed') === 'false'"), 'Wrap off marks the code block and the button');
    check(!(await ev(scrollerFits)), 'unwrapped, the long line runs past the edge and scrolls');
    // a look again keeps where you had scrolled to, sideways too
    await ev("(() => { const s = document.querySelector('#viewerMain .vw-scroll'); window.__scroller = s; s.scrollLeft = 40; })()");
    await ev("document.getElementById('viewerRefresh').click()");
    check(await until("document.querySelector('#viewerMain .vw-scroll') && document.querySelector('#viewerMain .vw-scroll') !== window.__scroller"), 'a refresh redraws the file');
    check(await ev("document.querySelector('#viewerMain .vw-scroll').scrollLeft") === 40, 'and keeps it scrolled sideways');
    await shot('1c-unwrapped');
    await open(MADE[0].file);
    check(await until(`[...document.querySelectorAll('#viewerMain .dl.add .code')].some(c => c.textContent === ${JSON.stringify(MADE[0].words)})`), 'another file opens');
    check(await ev("document.querySelector('#viewerMain .vw-code').classList.contains('nowrap') && document.querySelector('#viewerMain .vw-wrap').getAttribute('aria-pressed') === 'false'"), 'and the choice carries over to it');
    check(await ev("window.localStorage.getItem('shellby.viewer.wrap')") === '0', 'and is remembered');
    await ev("document.querySelector('#viewerMain .vw-wrap').click()");
    check(await ev("!document.querySelector('#viewerMain .vw-code').classList.contains('nowrap') && window.localStorage.getItem('shellby.viewer.wrap') === '1'"), 'Wrap on again puts it back');

    // ---- Whole file on a changed file, and back to its diff
    await ev("[...document.querySelectorAll('#viewerMain .vw-file-head button')].find(b => b.textContent === 'Whole file').click()");
    check(await until(`[...document.querySelectorAll('#viewerMain .dl.ctx .code')].some(c => c.textContent === ${JSON.stringify(MADE[0].words)})`), 'Whole file shows the changed file as text');
    await ev("[...document.querySelectorAll('#viewerMain .vw-file-head button')].find(b => b.textContent === 'Diff').click()");
    check(await until("!!document.querySelector('#viewerMain .dl.add')"), 'and Diff goes back');

    // ---- a file that didn't change, read whole
    await ev("document.getElementById('viewerTabFiles').click()");
    check(await ev("document.getElementById('viewerFoot').hidden"), "the footer's totals are for Changes, so All files hides them");
    await until("[...document.querySelectorAll('#viewerList .vw-row')].some(b => b.dataset.path === 'a.txt')");
    await ev("[...document.querySelectorAll('#viewerList .vw-row')].find(b => b.dataset.path === 'a.txt').click()");
    check(await until("[...document.querySelectorAll('#viewerMain .dl.ctx .code')].some(c => c.textContent === 'original')"), 'an unchanged file opens as its text');
    // the tree comes from an index up to 20 s old; a file made since is still listed on All files
    check(await ev(`[...document.querySelectorAll('#viewerList .vw-row')].some(b => b.dataset.path === ${JSON.stringify(MADE[1].file)})`), 'All files lists the second edit too');
    await shot('2-whole-file');

    // ---- Esc puts the panes back
    check(await ev("SB.state.view === 'viewer'"), 'still in the viewer before Esc');
    await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    check(await until("SB.state.view === 'chat'"), 'Esc goes back to the chat');
    check(await ev('SB.panes.count(SB.state.grid)') === 2, 'with both panes still there');

    // ---- file links: click opens the viewer, Ctrl the editor, Shift its folder, outside the repo the editor
    await ev("window.__opened = []; SB.openFile = (p, o) => { window.__opened.push({ p, line: o?.line ?? null, reveal: !!o?.reveal }); }");
    const linkIn = (file, opts = {}) => `(() => { const a = SB.fileLink(${JSON.stringify(file)}, { line: 1 }); document.querySelector('.feed[data-tab="' + ${JSON.stringify(copyTab)} + '"]').append(a); a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: ${!!opts.ctrl}, shiftKey: ${!!opts.shift} })); })()`;
    await ev(linkIn(MADE[0].file));
    check(await until(`SB.state.view === 'viewer' && SB.viewer.current()?.file === ${JSON.stringify(MADE[0].file)}`), 'a file link opens the viewer on that file');
    await ev("SB.setView('chat')");
    await ev(linkIn(MADE[0].file, { ctrl: true }));
    check(await until('window.__opened.length === 1') && await ev("SB.state.view === 'chat' && !window.__opened[0].reveal"), 'Ctrl+click opens the editor instead');
    await ev(linkIn(MADE[0].file, { shift: true }));
    check(await until('window.__opened.length === 2') && await ev('window.__opened[1].reveal'), 'Shift+click shows it in its folder');
    await ev(linkIn(path.join(base, 'outside.txt')));
    check(await until('window.__opened.length === 3') && await ev("SB.state.view === 'chat'"), 'a file outside the repo still opens in the editor');

    // ---- the branch chip, in a conversation in your own checkout
    const other = await ev(`[...SB.state.tabs.keys()].find(id => id !== ${JSON.stringify(copyTab)})`);
    await ev(`SB.activate(${JSON.stringify(other)})`);
    check(await until("!document.getElementById('branchChip').hidden && document.getElementById('branchLabel').textContent === 'main'"), 'a plain checkout shows its branch too');
    await ev("document.getElementById('branchChip').click()");
    check(await until("[...document.querySelectorAll('#branchMenu .mi-title')].some(t => t.textContent === 'View changes')"), 'its menu offers View changes');
    await ev("[...document.querySelectorAll('#branchMenu .menu-item')].find(b => b.textContent.includes('View changes')).click()");
    check(await until("SB.state.view === 'viewer' && SB.viewer.current()?.side === 'changes'"), 'which opens the viewer on Changes');
    check(await until("document.getElementById('viewerNote').textContent === 'Nothing has changed here.'"), 'and says when nothing has');
    await ev("SB.setView('chat')");

    // ---- the Project page: Browse files, and its worktrees open in the viewer
    await ev("SB.setView('projects')");
    const name = path.basename(repo);
    check(await until(`[...document.querySelectorAll('#pjProjects .pj-row-name b')].some(b => b.textContent === ${JSON.stringify(name)})`), 'the project is on the list');
    await ev(`[...document.querySelectorAll('#pjProjects .pj-row')].find(b => b.textContent.includes(${JSON.stringify(name)})).click()`);
    check(await until("[...document.querySelectorAll('#pjDetailScreen .pj-clone-head button')].some(b => b.textContent === 'Browse files')"), 'its clone has Browse files');
    check(await until("document.querySelectorAll('#pjDetailScreen .pj-copy-open').length === 1", 20000), "and its copy is listed, ready to open");
    await ev("document.querySelector('#pjDetailScreen .pj-copy-open').click()");
    check(await until(`SB.state.view === 'viewer' && SB.viewer.current()?.files.length === ${MADE.length}`), "the copy opens in the viewer with what it changed");

    // ---- a diff of two hunks: the second is set off from the first by a line you can see
    const multiAt = path.join(await ev('SB.viewer.current().root'), 'multi.txt');
    const edited = [...MULTI]; edited[1] = 'line 2 changed'; edited[37] = 'line 38 changed';
    fs.writeFileSync(multiAt, `${edited.join('\n')}\n`);
    await wait(2200); // main answers a look again within 2 s of the last one from that one
    await ev("document.getElementById('viewerRefresh').click()");
    check(await until("[...document.querySelectorAll('#viewerList .vw-row')].some(b => b.dataset.path === 'multi.txt')"), 'a file changed in two places shows up in the changes');
    await ev("[...document.querySelectorAll('#viewerList .vw-row')].find(b => b.dataset.path === 'multi.txt').click()");
    check(await until("document.querySelectorAll('#viewerMain .dl.hunk').length === 2"), 'its diff has two hunks');
    const edges = await ev("[...document.querySelectorAll('#viewerMain .dl.hunk')].map(d => { const c = getComputedStyle(d); return { top: c.borderTopWidth, line: c.borderTopColor, bar: c.backgroundColor }; })");
    check(edges[0].top === '0px' && edges[1].top === '1px' && edges[1].line !== edges[1].bar, `the second hunk has a border of its own colour, the first none (${edges[1].line} on ${edges[1].bar})`);
    await shot('1d-two-hunks');
    await ev("SB.setView('projects')");
    await ev("[...document.querySelectorAll('#pjDetailScreen .pj-clone-head button')].find(b => b.textContent === 'Browse files').click()");
    check(await until(`SB.state.view === 'viewer' && SB.viewer.current()?.root.toLowerCase() === ${JSON.stringify(repo)}.toLowerCase() && SB.viewer.current().side === 'files' && SB.viewer.current().files.length === 0`), 'Browse files opens the checkout itself, clean, on All files');
    await shot('3-project-page');
    await ev("document.getElementById('viewerBack').click()");
    check(await until("SB.state.view === 'projects'"), 'Back goes to the Project page it was opened from');

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
