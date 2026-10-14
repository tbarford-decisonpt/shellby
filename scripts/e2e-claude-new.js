// ci: Claude Code's newer abilities: review findings, its own notifications and worktrees, background sessions
// The gaps src/main/cli-coverage.js listed, built: a code review's findings as
// cards with Fix this, Claude's PushNotification and EnterWorktree/ExitWorktree
// shown for what they are, and Claude Code's background sessions in Settings
// with their logs and Stop. The fake CLI speaks Claude Code 2.1.296's shapes.
//   node scripts/e2e-claude-new.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9419;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-new-')));
  const agents = path.join(tmp, 'agents.json');
  const agentsLog = path.join(tmp, 'agents.log');
  const session = state => [{ id: 'abcdef12', cwd: tmp, kind: 'background', startedAt: Date.now() - 60000, sessionId: '378070a6-752d-4d65-84e3-81c3bd78c0e3', name: 'Tidy the tests', state }];
  fs.writeFileSync(agents, JSON.stringify(session('working')));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: path.join(tmp, 'data'), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47964',
      SHELLBY_FAKE_BG: agents, SHELLBY_FAKE_BG_LOG: agentsLog,
    },
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
    const until = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await wait(250); } return false; };
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev('window.__tabs = []; shellby.onTabs(t => { window.__tabs = t; }); true');
    const turn = async (text, done) => { await ev(`SB.send(${JSON.stringify(text)})`); return until(done); };

    // ---- a code review's findings
    check(await turn('findings', "!!SB.activeTab().el.querySelector('.findings')"), 'ReportFindings shows a findings card');
    const card = await ev(`(() => { const c = SB.activeTab().el.querySelector('.findings'); return {
      head: c.querySelector('.findings-head').textContent, rows: c.querySelectorAll('.finding').length,
      links: [...c.querySelectorAll('a.file-link')].map(a => a.dataset.line), verdicts: [...c.querySelectorAll('.finding-verdict')].map(v => v.textContent),
      why: c.querySelectorAll('.finding-why').length }; })()`);
    check(/2 findings/.test(card.head) && /low effort/.test(card.head), `its head counts them and the effort ("${card.head}")`);
    check(card.rows === 2, `one row per finding (${card.rows})`);
    check(card.links.join() === '12,3', `each place is a file link with its line (${card.links})`);
    check(card.verdicts.join() === 'Confirmed,Plausible', `verdicts in plain words (${card.verdicts})`);
    check(card.why === 1, 'only a finding with a failure scenario has "How it goes wrong"');
    await ev("SB.activeTab().el.querySelector('.finding-fix').click()");
    const box = await ev("document.getElementById('input').value");
    check(/src\/app\.js:12/.test(box) && /never ends/.test(box), `Fix this puts a prompt in the box, unsent ("${box.slice(0, 60)}")`);
    await ev("SB.activeTab().el.querySelector('.findings-fix-all').click()");
    check(/1\. src\/app\.js:12/.test(await ev("document.getElementById('input').value")) && /2\. src\/util\.js:3/.test(await ev("document.getElementById('input').value")), 'Fix all lists every finding');
    await ev("document.getElementById('input').value = ''");

    // ---- Claude's own notification
    check(await turn('notify Build is green', "[...SB.activeTab().el.querySelectorAll('.t-label')].some(l => l.textContent.includes('Notified you'))"), 'PushNotification is a "Notified you" step');

    // ---- Claude moving into a worktree and back
    check(await turn('worktree in', "[...SB.activeTab().el.querySelectorAll('.home-mark')].some(m => m.textContent.includes('worktree of its own: branch worktree-fake-wt'))"), 'EnterWorktree leaves a note with its branch');
    check(await until("window.__tabs.some(t => t.claudeWorktree?.branch === 'worktree-fake-wt')"), 'the tab knows it is in Claude\'s worktree');
    const replies = await ev("SB.activeTab().el.querySelectorAll('.msg.assistant').length");
    await turn('still here?', `SB.activeTab().el.querySelectorAll('.msg.assistant').length > ${replies}`);
    await wait(500);
    check(await ev("window.__tabs.some(t => t.claudeWorktree?.branch === 'worktree-fake-wt')"), 'the next turn, whose init is in the worktree, keeps it');
    check(await turn('worktree out', "[...SB.activeTab().el.querySelectorAll('.home-mark')].some(m => m.textContent.includes('left its worktree and kept it'))"), 'ExitWorktree says it left, and kept it');
    check(await until("!window.__tabs.some(t => t.claudeWorktree)"), 'and the tab is back in its own folder');

    // ---- background sessions
    const v = await ev('shellby.bgSessions()');
    check(v?.sessions?.length === 1 && v.sessions[0].label === 'Working' && v.sessions[0].running, `the background session is listed, working (${JSON.stringify(v?.sessions?.[0]?.label)})`);
    check(await until("!document.getElementById('bgsBox').hidden && document.querySelectorAll('#bgsList .bgs-item').length === 1"), 'Settings, Everywhere shows it');
    fs.writeFileSync(agents, JSON.stringify(session('blocked')));
    const v2 = await ev('shellby.bgSessions()');
    check(v2?.sessions?.[0]?.label === 'Needs input', `a change of state is picked up (${v2?.sessions?.[0]?.label})`);
    await ev("[...document.querySelectorAll('#bgsList button')].find(b => b.textContent === 'Logs').click()");
    check(await until("document.getElementById('bgsLogsText').textContent.includes('fake log line for abcdef12')"), 'Logs shows claude logs');
    await ev("[...document.querySelectorAll('#bgsList button')].find(b => b.textContent === 'Stop').click()");
    check((await (async () => { for (let i = 0; i < 40; i++) { if (fs.existsSync(agentsLog) && /stop abcdef12/.test(fs.readFileSync(agentsLog, 'utf8'))) return true; await wait(250); } return false; })()), 'Stop runs claude stop on that id');
    const refused = await ev("shellby.bgStop('deadbeef99')");
    check(refused?.ok === false && !/stop deadbeef99/.test(fs.readFileSync(agentsLog, 'utf8')), 'an id the listing never had is refused, and nothing runs');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
