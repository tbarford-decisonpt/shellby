// ci: a flaky test filed as a GitHub issue: no button without GitHub, asks first, labelled and linked
// A flaky test filed as a GitHub issue, end to end against a mock GitHub: no
// button until GitHub can take it, a question first (Cancel files nothing),
// then one issue labelled shellby and assigned to you, with the evidence, and
// the row linking to it. No account, no network: the flaky test is seeded, and
// GitHub is test/fixtures/mock-github.js.
//   node scripts/e2e-flaky-issue.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockGitHub } = require('../test/fixtures/mock-github');

const ROOT = path.join(__dirname, '..');
const PORT = 9391;
const wait = ms => new Promise(r => setTimeout(r, ms));

const KEY = 'abcdef012345';
const TEST = 'src/auth.spec.js › auth › signs in';

// A git project on GitHub as crabfan/app. realpath.native: CI's temp folder is
// an 8.3 short path, and git reports the long one.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-flaky-issue-')));
const repo = path.join(base, 'app');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
git('add', '-A');
git('commit', '-qm', 'init');
git('remote', 'add', 'origin', 'https://github.com/crabfan/app.git');

const now = Date.now();
fs.mkdirSync(path.join(base, 'userdata'));
fs.writeFileSync(path.join(base, 'userdata', 'settings.json'), JSON.stringify({
  onboarded: true, wander: false, xp: { byDevice: { legacy: 2750 } },
  flaky: { projects: { [KEY]: { name: 'app', root: repo, runs: [], tests: { [TEST]: { flakes: [now - 3600e3, now - 7200e3], framework: 'jest', status: 'watching' } } } } },
}));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const mock = await startMockGitHub({ autoApprove: true });
  mock.state.repos.set('crabfan/app', { private: false });
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: path.join(base, 'userdata'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'),
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47997',
      SHELLBY_GITHUB_WEB: mock.base, SHELLBY_GITHUB_API: mock.base, SHELLBY_GITHUB_CLIENT_ID: 'e2e-client',
    },
  });
  const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };
  const connect = async url => {
    const ws = new WebSocket(url);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const p = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    return { ev, close: () => ws.close() };
  };
  const until = async (c, expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(150); } return false; };
  // The confirm window: what it asks, then press `button`.
  async function answer(button) {
    let d = null;
    for (let i = 0; i < 50 && !d; i++) { d = (await targets()).find(t => t.url.includes('dialog.html')); if (!d) await wait(200); }
    if (!d) return null;
    const dlg = await connect(d.webSocketDebuggerUrl);
    await until(dlg, "(document.getElementById('title')?.textContent || '').length > 0", 5000);
    const said = await dlg.ev("({ title: document.getElementById('title').textContent, text: document.body.innerText })");
    await dlg.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(button)}).click()`);
    dlg.close();
    return said;
  }

  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) { list = await targets(); await wait(500); }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await wait(3000);
    await panel.ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    const buttons = () => panel.ev("[...document.querySelectorAll('#flakyList button')].map(b => b.textContent).join(',')");
    const act = () => panel.ev(`shellby.flakyAct({ key: ${JSON.stringify(KEY)}, id: ${JSON.stringify(TEST)}, action: 'issue' })`);

    // ---- 1. signed out: no button, and the action says why
    await panel.ev("SB.setView('routines')");
    check(await until(panel, "document.querySelectorAll('#flakyList li').length === 1"), 'the seeded flaky test is listed');
    check(await buttons() === 'Fix it,Quarantine,Not flaky', `no "File an issue" without GitHub (${await buttons()})`);
    check(/Let Claude tasks push/.test((await act())?.error || ''), 'filing anyway says what to turn on');

    // ---- 2. signed in, with Claude access: the button appears
    await panel.ev("shellby.githubSignIn(['ci'])");
    check(await until(panel, "shellby.getGitHub().then(v => v.login === 'crabfan')", 15000), 'signed in to the mock GitHub');
    panel.ev("shellby.githubSetFeature('claude', true)");
    check(/Let Claude tasks use your GitHub/.test((await answer('Allow'))?.title || ''), 'Claude access asks first');
    check(await until(panel, "shellby.getGitHub().then(v => v.features.claude.on && v.features.claude.granted)", 15000), 'Claude access on');
    await panel.ev("SB.setView('chat')");
    await panel.ev("SB.setView('routines')");
    await panel.ev('SB.refreshFlaky()');
    check(await until(panel, "[...document.querySelectorAll('#flakyList button')].some(b => b.textContent === 'File an issue')"), `"File an issue" once GitHub can take it (${await buttons()})`);

    // ---- 3. Cancel files nothing
    const pending = act();
    const asked = await answer('Cancel');
    check(/File an issue on crabfan\/app\?/.test(asked?.title || ''), `asks first, naming the repository (${asked?.title})`);
    check(/is public: anyone can read the issue/.test(asked?.text || ''), 'and says the repository is public');
    check((await pending)?.canceled === true && mock.state.issues.length === 0, 'Cancel files nothing');

    // ---- 4. File it: one issue, labelled, assigned, with the evidence
    await panel.ev("document.querySelectorAll('#flakyList button').forEach(b => { if (b.textContent === 'File an issue') b.click(); })");
    await answer('File it');
    check(await until(panel, "/Filed as issue #1/.test(document.getElementById('toast').textContent)"), 'toast: filed as issue #1');
    const issue = mock.state.issues[0];
    check(issue?.repo === 'crabfan/app' && issue.title === 'Flaky test: auth.spec › signs in', `on the project's repository, named for the test (${issue?.title})`);
    check(JSON.stringify(issue?.labels) === '["shellby"]' && JSON.stringify(issue?.assignees) === '["crabfan"]', 'labelled shellby and assigned to you, for the Issue helper');
    check(issue?.body.includes(`\`${TEST}\``) && /Flaked: 2 times \(2 this week/.test(issue?.body || ''), 'with the test and how often it flaked');
    check(await until(panel, "document.querySelector('#flakyList a.dep-pill')?.textContent === 'Issue #1'"), 'the row links to the issue');
    check(await panel.ev("document.querySelector('#flakyList a.dep-pill').dataset.href") === 'https://github.com/crabfan/app/issues/1', '...on GitHub');
    check(!/File an issue/.test(await buttons()), 'and offers it no more');

    // ---- 5. asked again: the same issue, not a second one
    const again = await act();
    check(again?.ok && again.existing && again.number === 1 && mock.state.issues.length === 1, 'filing it again gives back the same issue');
    const saved = JSON.parse(fs.readFileSync(path.join(base, 'userdata', 'settings.json'), 'utf8'));
    check(saved.flaky?.projects?.[KEY]?.tests?.[TEST]?.issue?.number === 1, 'remembered in settings, across restarts');
  } catch (e) {
    console.log(`FAIL  ${e.stack || e.message}`);
    fails++;
  } finally {
    app.kill();
    await mock.close?.();
    await wait(800);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* still locked */ }
  }
  console.log(fails ? `\n${fails} check(s) failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
