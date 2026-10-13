// ci: the trail: files read, searched and changed, the crab on them, circles, secrets, untested, replay
// The trail (Ctrl+Shift+E), end to end against the fake CLI's "crawl" turn in a
// throwaway repository:
//   1. Ctrl+Shift+E opens it beside the chat, on the File manager's Trail tab (the panel grows to keep the chat usable)
//   2. a turn that wanders: what it read, what a search found, what it changed
//      (+/− from the turn's diff), .env called a secret, a file outside the project
//   3. what's worth a look: going in circles, a change whose test nobody ran,
//      a secret; each action puts its words in the box, unsent
//   4. a row goes to its step in the feed; @ mentions it in the box
//   4b. a row's open button opens the file in the viewer; Ctrl+double-click opens the editor
//   5. the replay: step 1 puts him back on the first file and lights its step
//   6. a change waiting for your OK: its row says so and he stands on it
//   7. its width: drag the line on its left edge, arrow keys, Home/End, double-click
//   8. This turn / All, and Ctrl+Shift+E closes it
// No account, no network beyond this PC.
//   node scripts/e2e-trail.js [--shots <dir>]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9426;
const HOOK_PORT = '48026';
const wait = ms => new Promise(r => setTimeout(r, ms));
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : process.env.E2E_SHOTS || null; })();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-trail-')));
const repo = path.join(base, 'proj');
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
put('src/app.js', 'let total = 0;\nmodule.exports = { total };\n');
put('src/util.js', 'const total = n => n;\nmodule.exports = { total };\n');
put('test/app.test.js', "require('../src/app');\n");
put('docs/guide.md', '# Guide\n');
put('.env', 'API_KEY=not-a-real-key\n');
put('.gitignore', '.env\n');
fs.writeFileSync(path.join(base, 'notes.md'), 'notes\n');
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
      await savePng((m, params) => send(m, params).then(r => r.result), path.join(SHOTS, `trail-${name}.png`)); };
    const FEED = '.feed:not([hidden])';
    const row = name => `[...document.querySelectorAll('#trailRows .tr-row')].find(r => r.querySelector('.tr-name')?.textContent === ${JSON.stringify(name)})`;
    const rowHas = (name, sel) => ev(`!!${row(name)}?.querySelector(${JSON.stringify(sel)})`);
    const input = () => ev("document.getElementById('input').value");
    const clearInput = () => ev("(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");

    // Booted, not just past trail.js: the scripts after it (crabonly.js's
    // SB.isCrabOnly, which the shortcut checks) are still loading until boot.js marks it.
    check(await until("performance.getEntriesByName('shellby:panel-ready').length > 0 && typeof SB.toggleTrail === 'function'", 30000), 'the panel booted with the trail in it');
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await ev('SB.newTab()');
    check(await until(`SB.activeTab() && SB.activeTab().cwd && SB.activeTab().cwd.toLowerCase() === ${JSON.stringify(repo.toLowerCase())}`), 'a new conversation in the throwaway repository');

    // ---- 1. Ctrl+Shift+E opens it beside the chat
    const widthBefore = await ev('window.innerWidth');
    await ev("document.getElementById('input').focus()");
    await key('e', { ctrl: true, shift: true });
    check(await until("!document.getElementById('trail').hidden && document.body.classList.contains('trail-open')"), 'Ctrl+Shift+E opens the trail');
    check(await until("document.getElementById('trail').classList.contains('empty')"), 'with nothing on it yet, it says what it will show');
    check(await until(`document.body.classList.contains('trail-over') || document.getElementById('chatView').getBoundingClientRect().width - document.getElementById('trail').getBoundingClientRect().width >= 330`),
      `the chat keeps room beside it (the panel went from ${widthBefore} px to ${await ev('window.innerWidth')} px)`);
    check(await ev("document.activeElement === document.getElementById('trailMap')"), 'the map has the keyboard');
    check(await ev("document.getElementById('trailBtn').getAttribute('aria-pressed')") === 'true', 'the subbar\'s Trail button shows it\'s open');
    check(await ev("document.getElementById('trailTitle').textContent") === 'File manager', 'the drawer is the File manager');
    check(await ev("document.getElementById('drawerTabTrail').getAttribute('aria-selected') === 'true' && !document.getElementById('trailPanel').hidden && document.getElementById('filesDock').hidden"), 'Ctrl+Shift+E chose the Trail tab');
    await ev("document.getElementById('drawerTabTrail').focus()");
    await key('ArrowRight');
    check(await until("document.getElementById('drawerTabFiles').getAttribute('aria-selected') === 'true' && document.getElementById('drawerTabTrail').getAttribute('aria-selected') === 'false' && !document.getElementById('filesDock').hidden && document.getElementById('trailPanel').hidden"), 'the right arrow on the tab list selects All files');
    await key('ArrowLeft');
    check(await until("document.getElementById('drawerTabTrail').getAttribute('aria-selected') === 'true' && document.getElementById('drawerTabFiles').getAttribute('aria-selected') === 'false' && document.getElementById('filesDock').hidden && !document.getElementById('trailPanel').hidden"), 'and the left arrow brings the Trail back');
    await ev("document.getElementById('drawerTabTrail').click()");
    check(await until("document.getElementById('drawerTabTrail').getAttribute('aria-selected') === 'true' && !document.getElementById('trailPanel').hidden"), 'the Trail tab brings the Trail back');
    await ev("document.getElementById('trailMap').focus()");

    // ---- 2. a turn that wanders
    await ev("SB.send('crawl 70')");
    check(await until("!!document.querySelector('#trailCrabs .tr-crab.main')", 8000), 'he turns up on the trail as soon as he starts');
    check(await until('!SB.activeTab().busy', 20000), 'the crawl finishes');
    check(await until(`!!${row('app.js')}?.querySelector('.dstat')`), 'a changed file shows its +/− from the turn\'s diff');
    check(await rowHas('app.js', '.tr-prints.p-dug'), 'and is dug over, not just stepped on');
    check(await ev(`${row('app.js')}.querySelector('.m-circles')?.textContent`) === '↻4', 'four edits in one turn read as going round in circles (↻4)');
    check(await rowHas('util.js', '.m-seen') && await rowHas('util.js', '.tr-prints.p-seen'), 'a file only a search found is "seen", with a glint');
    check(await rowHas('.env', '.m-secret'), '.env is called a secret');
    check(await ev("[...document.querySelectorAll('#trailRows .tr-group')].some(g => g.textContent === 'Outside this project')") && await rowHas('notes.md', '.tr-where'), 'a file outside the project is listed apart, with where it is');
    check(await rowHas('guide.md', '.tr-lane'), 'the helper\'s file wears its lane\'s colour');
    check(await ev(`${row('src/')}?.querySelector('.m-search')?.textContent`) === '“total”', 'the folder he searched says what for');
    check(await ev("document.querySelectorAll('#trailCrabs .tr-crab.helper').length") === 0, 'the helper has gone home once its lane is done');
    check(await ev("document.querySelector('#trailCrabs .tr-crab.main').classList.contains('resting')"), 'and he rests where he stopped');
    check(await ev("document.getElementById('trailCounts').textContent.includes('1 changed')"), `the counts say what happened: "${await ev("document.getElementById('trailCounts').textContent")}"`);
    await shot('1-crawl');

    // ---- 3. what's worth a look
    const sig = kind => `document.querySelector('#trailSignals .s-${kind}')`;
    check(await until(`!!${sig('circles')}`), 'a signal says he keeps going back to app.js');
    check(await until(`!!${sig('tests')}`), 'another says app.js changed and nobody ran its test');
    check(await ev(`${sig('tests')}.textContent.includes('app.test.js')`), 'naming the test');
    check(await ev(`!!${sig('secret')} && ${sig('secret')}.textContent.includes('.env')`), 'and one that he opened .env');
    await ev(`${sig('circles')}.querySelector('.btn').click()`);
    check((await input()).includes('Stop and tell me what\'s going wrong'), 'Ask what\'s wrong puts the question in the box');
    check(!await ev('SB.activeTab().busy'), 'without sending it');
    await clearInput();
    await ev(`${sig('tests')}.querySelector('.btn').click()`);
    check((await input()).startsWith('Run test/app.test.js'), 'Run it asks for that test by name');
    await clearInput();
    await shot('2-signals');

    // ---- 4. going to the step, and @
    await ev(`${row('app.js')}.click()`);
    check(await until(`!!document.querySelector('${FEED} details.tool.edit.history-landed')`), 'clicking app.js lights its last edit in the feed');
    check(await ev(`document.querySelector('${FEED} details.tool.edit.history-landed').open`), 'with its diff open');
    await ev(`${row('util.js')}.querySelector('[data-act="mention"]').click()`);
    check((await input()).trim() === '@src/util.js', `@ puts it in the box as a mention ("${(await input()).trim()}")`);
    await clearInput();

    // ---- 4b. a row opens in the viewer, as a file link does; Ctrl opens the editor
    await clearInput();
    await ev("window.__opened = []; window.__openFile = SB.openFile; SB.openFile = (p, o) => { window.__opened.push({ p, reveal: !!o?.reveal }); }");
    await ev(`${row('util.js')}.querySelector('[data-act="open"]').click()`);
    check(await until("SB.state.view === 'viewer' && SB.viewer.current()?.file === 'src/util.js'"), "a row's open button opens it in the viewer");
    await ev('SB.goBack()');
    check(await until("SB.state.view === 'chat'"), 'Back returns to the chat');
    await ev(`${row('util.js')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, ctrlKey: true }))`);
    check(await until('window.__opened.length === 1') && await ev("SB.state.view === 'chat' && /util\\.js$/.test(window.__opened[0].p)"), 'Ctrl+double-click opens the editor instead');
    await ev('SB.openFile = window.__openFile');

    // ---- 5. the replay
    const steps = Number(await ev("document.getElementById('trailScrub').max"));
    check(steps >= 10, `the replay has every step (${steps})`);
    await ev("(() => { const s = document.getElementById('trailScrub'); s.value = s.min; s.dispatchEvent(new Event('input')); })()");
    check(await until("document.getElementById('trail').classList.contains('replaying')"), 'dragging back starts the replay');
    check(await ev(`document.querySelector('#trailCrabs .tr-crab.main').dataset.key`) === await ev(`${row('app.js')}.dataset.key`), 'step 1 puts him on the first file he read');
    check(await ev(`!${row('util.js')}`), 'what came later isn\'t on the map yet');
    check(await until(`!!document.querySelector('${FEED} .tool.trail-here')`), 'and its step is lit in the feed');
    check(await ev("document.getElementById('trailCounts').textContent").then(t => /^Step \d+ of \d+$/.test(t)), 'the footer says which step');
    await shot('3-replay');
    await ev("document.getElementById('trailLive').click()");
    check(await until("!document.getElementById('trail').classList.contains('replaying') && !document.querySelector('.tool.trail-here')"), 'Live goes back to now');

    // ---- 6. a change waiting for your OK
    await ev("SB.send('editask src/util.js')");
    check(await until(`!!${row('util.js')}?.querySelector('.m-ask')`), 'a change waiting for your OK says so on its row');
    check(await until(`document.querySelector('#trailCrabs .tr-crab.main').dataset.key === ${row('util.js')}.dataset.key`), 'and he stands on it');
    // His pose holds a moment before the next takes over (shared/workposes.js MIN_MS).
    check(await until("document.querySelector('#trailCrabs .tr-crab.main').dataset.pose === 'write'", 4000), 'holding his pencil');
    await shot('4-asking');
    await ev(`document.querySelector('${FEED} .ask:not(.decided) .btn.allow').click()`);
    check(await until('!SB.activeTab().busy'), 'allowed, the turn finishes');
    check(await until(`!${row('util.js')}?.querySelector('.m-ask')`), 'and the row stops asking');

    // ---- 7. its width: the line on its left edge, dragged or with the arrow keys
    const trailW = "Math.round(document.getElementById('trail').getBoundingClientRect().width)";
    const w0 = await ev(trailW);
    check(await ev("document.getElementById('trailGrip')?.getAttribute('role') === 'separator'"), 'the trail\'s left edge is a line you can drag');
    // A real press lands on whatever is on top: a reward card (celebrate.js) or a toast can float over the chat by now (as in e2e-panes).
    await ev("SB.clearCelebrations?.(); document.querySelectorAll('.celebrate').forEach(c => c.remove()); document.querySelector('#toast .toast-close')?.click()");
    const at = await ev("(r => ({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }))(document.getElementById('trailGrip').getBoundingClientRect())");
    check(await ev(`document.elementFromPoint(${at.x}, ${at.y})?.id`) === 'trailGrip', 'a press on the line lands on it');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 3; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + 10 * i, y: at.y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x + 30, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    check(await until(`${trailW} === ${w0 - 30}`), `dragging it 30 px right makes the trail 30 px narrower (${w0} → ${await ev(trailW)})`);
    check(await ev("window.localStorage.getItem('shellby.trail.width')") === String(w0 - 30), 'and the width is kept for next time');
    await ev("document.getElementById('trailGrip').focus()");
    await key('ArrowLeft');
    check(await until(`${trailW} === ${w0 - 30 + 16}`), 'the left arrow on it widens it');
    await key('Home');
    const narrowest = await ev(trailW);
    check(narrowest < w0 - 30 && narrowest >= 200, `Home makes it as narrow as it goes (${narrowest})`);
    await key('End');
    check(await until("document.body.classList.contains('trail-over') || document.getElementById('chatView').getBoundingClientRect().width - document.getElementById('trail').getBoundingClientRect().width >= 340"), 'End widens it only as far as leaves the chat its room');
    await ev("document.getElementById('trailGrip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    check(await until(`${trailW} === ${w0}`), 'a double-click puts it back to its usual width');

    // ---- 8. This turn / All, and closing
    await ev("document.querySelector('.trail-scope [data-scope=\"turn\"]').click()");
    check(await until(`!${row('app.js')} && !!${row('util.js')}`), 'This turn shows only what the last turn touched');
    await ev("document.querySelector('.trail-scope [data-scope=\"all\"]').click()");
    check(await until(`${row('app.js')}?.classList.contains('earlier')`), 'All brings the earlier turn back, paler');
    await ev("document.getElementById('trailMap').focus()");
    await key('e', { ctrl: true, shift: true });
    check(await until("document.getElementById('trail').hidden && !document.body.classList.contains('trail-open')"), 'Ctrl+Shift+E closes it');
  } catch (e) {
    console.log(`FAIL  ${e.message}`);
    fails++;
  } finally {
    try { process.kill(app.pid); } catch { /* gone */ }
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    await wait(800);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* the OS still holds a file; temp gets it */ }
    console.log(fails ? `\n${fails} check(s) failed` : '\nall trail checks passed');
    process.exit(fails ? 1 : 0);
  }
})();
