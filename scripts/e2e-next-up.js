// End-to-end check of Next up (docs/plans/next-up.md) against the dev app over
// CDP (throwaway profile, the fake Claude CLI). A real git repository with a
// committed .shellby/tasks.md and a FIXME in its code is added to Projects;
// then: its page opens on the Next up card with the Now task first, a task
// added from the card lands in the file, Do this opens a conversation in a
// copy with the prompt waiting in the box (nothing sent), closing it unsent
// takes the empty copy with it, a task is ticked off from its menu, Commit it
// commits only tasks.md, a Linear MCP server brings its issues in (read by
// the fake CLI, through reading tools only) and Do this starts one in a copy
// named for it, and nothing throws in the panel.
//   node scripts/e2e-next-up.js [screenshot.png]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9367;
const wait = ms => new Promise(r => setTimeout(r, ms));
const shot = process.argv[2] ? path.resolve(process.argv[2]) : null;

async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    p.get(m.id)?.(m);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send('Runtime.enable');
  return { ws, send, ev, errors };
}

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-nextup-')));
  const repo = path.join(base, 'tidepool');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) git('config', k, v);
  fs.writeFileSync(path.join(repo, 'src', 'sync.js'), 'function sync() {\n  // FIXME retry once when offline\n  return fetch(url);\n}\n');
  fs.mkdirSync(path.join(repo, '.shellby'));
  fs.writeFileSync(path.join(repo, '.shellby', 'tasks.md'), '# Tasks\n\n## Now\n- [ ] Fix the flicker on the second monitor\n  Only on the second monitor.\n\n## Next\n');
  // A Linear MCP server, for the Linear part: listed, never started (the fake CLI answers the read).
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } }));
  git('add', '-A');
  git('commit', '-qm', 'init');
  const tasksFile = () => fs.readFileSync(path.join(repo, '.shellby', 'tasks.md'), 'utf8');
  const profile = path.join(base, 'userdata');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: false, projects: { added: [repo] } }));

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: profile, CLAUDE_CONFIG_DIR: path.join(base, 'claude'),
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47997',
    },
  });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  let panel = null;
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    panel = await cdp(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const { ev } = panel;
    const until = async (expr, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await ev(expr); if (v || Date.now() > end) return v; await wait(200); } };
    const rows = "[...document.querySelectorAll('#pjDetailScreen .bl-card .bl-row')]";
    const rowOf = title => `${rows}.find(r => r.querySelector('.pj-h-text b')?.textContent === ${JSON.stringify(title)})`;
    await wait(2500);

    // ---- the card
    await ev("SB.setView('projects')");
    const name = path.basename(repo);
    check(await until(`[...document.querySelectorAll('#pjProjects .pj-row-name b')].some(b => b.textContent === ${JSON.stringify(name)})`), 'the repo is on the Projects list');
    await ev(`[...document.querySelectorAll('#pjProjects .pj-row')].find(b => b.textContent.includes(${JSON.stringify(name)})).click()`);
    check(await until(`${rows}.length >= 2`), 'its page opens with Next up listing things');
    check(await ev("document.querySelector('#pjDetailScreen .pj-panel')?.classList.contains('bl-card')"), 'Next up is the first card on the page');
    const first = await ev(`(r => r && [r.querySelector('.bl-tag')?.textContent, r.querySelector('.pj-h-text b')?.textContent])(${rows}[0])`);
    check(JSON.stringify(first) === JSON.stringify(['Now', 'Fix the flicker on the second monitor']), `the Now task comes first (${JSON.stringify(first)})`);
    check(await ev(`${rows}.some(r => r.querySelector('.sf-tag.fixme') && r.textContent.includes('src/sync.js:2'))`), 'the FIXME from the code is on it, with where it is');

    // ---- add a task from the card
    await ev("(i => { i.value = 'Write the release notes'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(document.querySelector('#pjDetailScreen .bl-add'))");
    check(await until(`!!${rowOf('Write the release notes')}`), 'a task added from the card shows up');
    check(/## Next\n- \[ \] Write the release notes\n$/.test(tasksFile()), 'and lands at the end of ## Next in .shellby/tasks.md');
    check(await until("[...document.querySelectorAll('#pjDetailScreen .bl-note')].some(n => n.textContent.includes('has changes no commit has'))"), 'the card says tasks.md has changes to commit');
    if (shot) {
      const r = await panel.send('Page.captureScreenshot', { format: 'png' });
      if (r?.data) fs.writeFileSync(shot, Buffer.from(r.data, 'base64'));
    }

    // ---- Do this: a copy, the prompt in the box, nothing sent
    const tabsBefore = await ev('SB.state.tabs.size');
    await ev(`${rowOf('Fix the flicker on the second monitor')}.querySelector('.pj-h-acts .btn').click()`);
    check(await until(`SB.state.view === 'chat' && SB.state.tabs.size > ${tabsBefore}`, 30000), 'Do this opens a conversation');
    const tabId = await ev('SB.state.activeTab');
    const box = await until("document.getElementById('input').value", 10000);
    check(/a task from my list: "Fix the flicker on the second monitor"/.test(box || '') && /Only on the second monitor/.test(box || ''), 'with the task and its notes waiting in the box');
    check(await ev("!SB.activeTab().el.querySelector('.msg.user')"), 'and nothing sent');
    const copies = () => git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length;
    check(copies() === 2, 'in a copy of its own');
    await ev("SB.setView('projects')");
    check(await until(`${rowOf('Fix the flicker on the second monitor')}?.querySelector('.pj-h-acts .btn')?.textContent === 'Open conversation'`), 'the row says Open conversation now');

    // Closed without sending: the empty copy goes with it, and the row is back to Do this.
    await ev(`SB.closeTab(${JSON.stringify(tabId)}, { quiet: true })`);
    const end = Date.now() + 20000;
    while (copies() > 1 && Date.now() < end) await wait(300);
    check(copies() === 1, 'closing it unsent tidies the empty copy away');
    await ev("SB.setView('projects')");
    await ev(`[...document.querySelectorAll('#pjDetailScreen .bl-foot .link-btn')].find(b => b.textContent === 'Look again')?.click()`);
    check(await until(`${rowOf('Fix the flicker on the second monitor')}?.querySelector('.pj-h-acts .btn')?.textContent === 'Do this'`), 'and the row offers Do this again');

    // ---- tick one off from its menu
    await ev(`${rowOf('Write the release notes')}.querySelector('.bl-more').click()`);
    check(await until("!document.getElementById('blMenu').hidden"), '⋯ opens the item\'s menu');
    await ev("[...document.querySelectorAll('#blMenu .menu-item')].find(b => b.textContent.includes('Tick off')).click()");
    check(await until(`!${rowOf('Write the release notes')}`), 'Tick off takes it off the list');
    check(/## Done\n- \[x\] Write the release notes \(\d{4}-\d\d-\d\d\)\n$/.test(tasksFile()), 'and under ## Done in the file, dated');

    // ---- Commit it: tasks.md and nothing else
    fs.writeFileSync(path.join(repo, 'wip.js'), 'work in progress\n');
    git('add', 'wip.js');
    await ev("[...document.querySelectorAll('#pjDetailScreen .bl-note .link-btn')].find(b => b.textContent === 'Commit it')?.click()");
    const committed = async () => { try { return git('log', '-1', '--format=%s'); } catch { return ''; } };
    const stop = Date.now() + 15000;
    while ((await committed()) !== 'chore: update tasks' && Date.now() < stop) await wait(300);
    check((await committed()) === 'chore: update tasks', 'Commit it makes a commit');
    check(git('show', '--name-only', '--format=', 'HEAD') === '.shellby/tasks.md', 'with only tasks.md in it');
    check(/^A {2}wip\.js$/m.test(git('status', '--porcelain')), 'what you had staged stays staged');

    // ---- Linear, through the MCP server the project has
    const link = "document.querySelector('#pjDetailScreen .bl-tracker-link')";
    check(await until(`${link}?.textContent === 'Linear…'`), 'someone with a Linear server gets one quiet Linear… link under the list');
    await ev(`${link}.click()`);
    check(await until("[...document.querySelectorAll('#pjDetailScreen .bl-tracker select:first-child option')].some(o => o.value === 'linear')"), 'its form offers the linear server');
    check(await ev("document.querySelectorAll('#pjDetailScreen .bl-tracker select')[1]?.value === 'linear'"), 'and knows it\'s Linear');
    await ev("(f => { f.querySelector('.bl-tracker-scope').value = 'ENG'; f.requestSubmit(); })(document.querySelector('#pjDetailScreen .bl-tracker'))");
    const eng = `${rows}.find(r => r.querySelector('.bl-tag')?.textContent === 'ENG-7')`;
    check(await until(`!!${eng}`, 30000), 'Claude reads it in the background and ENG-7 joins the list');
    check(await ev(`${eng}?.classList.contains('tier-now') && ${eng}.textContent.includes('Urgent')`), 'ranked Now, saying why');
    check(await ev(`${link}?.textContent === 'Linear: ENG'`), 'the link says what\'s set');
    await ev("[...document.querySelectorAll('#pjDetailScreen .bl-filter button')].find(b => b.textContent === 'Issues')?.click()");
    check(await until(`${rows}.length === 1 && !!${eng}`), 'the Issues filter shows it');
    await ev("[...document.querySelectorAll('#pjDetailScreen .bl-filter button')].find(b => b.textContent === 'All')?.click()");
    await ev(`${eng}.querySelector('.bl-more').click()`);
    check(await until("[...document.querySelectorAll('#blMenu .menu-item')].some(b => b.textContent.includes('Open in Linear'))"), 'its menu has Open in Linear');
    await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    if (shot) await savePng((m, p) => panel.send(m, p), shot.replace(/\.png$/i, '-linear.png'));
    const tabsNow = await ev('SB.state.tabs.size');
    await ev(`${eng}.querySelector('.pj-h-acts .btn').click()`);
    check(await until(`SB.state.view === 'chat' && SB.state.tabs.size > ${tabsNow}`, 30000), 'Do this on ENG-7 opens a conversation');
    const engBox = await until("document.getElementById('input').value", 10000);
    check(/^Work on Linear issue ENG-7: "Crab walks sideways"/.test(engBox || '') && /<issue>\nHe should walk forwards when asked\.\n<\/issue>/.test(engBox || ''), 'with the issue waiting in the box, fenced');
    check(/worktree .*\nHEAD [0-9a-f]+\nbranch refs\/heads\/shellby\/eng-7-crab-walks-sideways-/.test(git('worktree', 'list', '--porcelain')), 'in a copy on a branch named for it');
    await ev(`SB.closeTab(${JSON.stringify(await ev('SB.state.activeTab'))}, { quiet: true })`);

    check(!panel.errors.length, `no uncaught errors in the panel${panel.errors.length ? `: ${panel.errors[0]}` : ''}`);
  } catch (e) {
    check(false, e.stack || e.message);
  } finally {
    app.kill();
    panel?.ws.close();
    await wait(800);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* in use */ }
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exitCode = fails ? 1 : 0;
})();
