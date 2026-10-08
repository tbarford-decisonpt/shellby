// End-to-end check of streaks and nudges against the dev app over CDP, with
// the fake CLI and a REAL throwaway git repo whose last commit is 6 days old.
// A task in it starts a streak and registers the project; a nudge fires
// ("You haven't committed to … in 6 days"); "Pick it up" opens a tab there.
// "Look over my changes" then reviews it: its own tab, in the repo, Ask-first.
//   node scripts/e2e-streaks.js [screenshot.png]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9356;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

  // A repo whose newest commit is 6 days old.
  // The long path: CI's temp folder is an 8.3 name (RUNNER~1), and git reports the long one.
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'streak-repo-')));
  const when = new Date(Date.now() - 6 * 24 * 3600e3).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'old work'], { env });
  const name = path.basename(repo);

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47989', SHELLBY_NUDGE_TEST: '1' },
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
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(200); } return false; };
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");

    // 1. Work in the repo (a subfolder, to prove it finds the repo root).
    fs.mkdirSync(path.join(repo, 'src'));
    await ev(`shellby.setFolder(${JSON.stringify(path.join(repo, 'src'))}).then(r => SB.folderChanged ? SB.folderChanged(r) : r)`);
    await ev("SB.newTab()");
    await ev("SB.send('wait 50 do some work')");
    check(await until("shellby.getStreaks().then(v => v.projects.length > 0)"), 'the git repo is registered as a project');
    let v = await ev('shellby.getStreaks()');
    const proj = v.projects[0];
    check(proj.name === name, `named after the repo root, not the subfolder (${proj.name})`);
    check(proj.quietDays === 6, `real last-commit time read with git (${proj.quietDays} days)`);
    check(v.current === 1 && v.today, `a 1-day streak started (${v.current})`);

    // 2. The Streaks card on Time, and its badge on Trophies.
    await ev("SB.setView('trophies')");
    await wait(600);
    check(await ev("!document.getElementById('xpStreak').hidden && /🔥 1/.test(document.getElementById('xpStreak').textContent)"), 'Trophies shows the streak badge');
    await ev("document.getElementById('xpStreak').click()");
    await wait(600);
    check(await ev('SB.state.view') === 'time', 'the badge opens Time');
    check(/1-day streak/.test(await ev("document.getElementById('streakTitle').textContent")), 'Time shows the streak');
    const row = await ev("document.querySelector('#streakProjects .streak-project')?.textContent || ''");
    check(row.includes(name) && /6 days since a commit/.test(row), `project row: "${row}"`);
    check(await ev("document.querySelector('#streakProjects .streak-project').classList.contains('late')"), 'a quiet project is highlighted');
    await ev("document.getElementById('streakCard').scrollIntoView({ block: 'start' })");
    if (process.argv[2]) await savePng(send, process.argv[2]);

    // 3. A nudge, then "Pick it up".
    await ev('window.__nudges = 0; shellby.onNudge(() => { window.__nudges++; }); true');
    await ev('shellby.devCheckNudges()');
    const nudgeOk = await until(`(document.getElementById('toast').textContent || '').includes("You haven't committed to ${name} in 6 days")`);
    if (!nudgeOk) console.log('      toast was:', JSON.stringify(await ev("document.getElementById('toast').textContent")));
    check(nudgeOk, 'nudge: "You haven\'t committed to … in 6 days 🐚"');
    const tabsBefore = await ev('SB.state.tabs.size');
    await ev("document.querySelector('#toast .toast-action').click()");
    check(await until(`SB.state.tabs.size === ${tabsBefore + 1} && /Where did we leave off in/.test(SB.$('input').value)`), '"Pick it up" opens a new tab with a starter prompt');
    check(await ev('SB.activeTab().cwd').then(c => c && c.toLowerCase() === repo.toLowerCase()), 'the new tab works in that project');

    // 4. Not again today; muting stops nudges.
    await ev('shellby.devCheckNudges()');
    await wait(800);
    check(await ev('window.__nudges') === 1, `only one nudge per project per day (${await ev('window.__nudges')})`);
    v = await ev(`shellby.muteProject(${JSON.stringify(proj.key)}, true)`);
    check(v.projects[0].muted === true, 'a project can be muted');

    // 5. "Look over my changes": a read-only review of that project. The app is
    //    put on Accept edits first, because the review is meant to pin itself to
    //    Ask-first whatever mode you are in (the fake CLI echoes the mode it got).
    check(await ev("shellby.setSettings({ mode: 'acceptEdits' }).then(r => r.settings.mode === 'acceptEdits')"), 'the app is on Accept edits');
    check(await ev("shellby.reviewProject('not-a-project').then(r => r.ok === false)"), 'a folder Shellby does not track is refused');
    const tabsNow = await ev('SB.state.tabs.size');
    await ev("document.querySelector('#streakProjects .sp-review').click()");
    check(await until(`SB.state.tabs.size === ${tabsNow + 1}`), 'the review opens its own tab');
    check(await ev('/^Look over /.test(SB.activeTab().title)'), `the tab is titled after the project (${await ev('SB.activeTab().title')})`);
    check(await ev('SB.activeTab().cwd').then(c => c && c.toLowerCase() === repo.toLowerCase()), 'the review runs in that project, not the current folder');
    check(await until('/not an audit/.test(document.body.textContent)'), 'the prompt it sent is the read-only one, and refuses to call you secure');
    check(await until('/mode=default/.test(document.body.textContent)'), 'it runs Ask-first even though the app is on Accept edits');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
