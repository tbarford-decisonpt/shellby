// End-to-end check of GitHub sign-in against the dev app over CDP, with a mock
// GitHub (test/fixtures/mock-github.js) and an isolated profile:
// device-code sign-in, profile, sync to a private gist, publishing a Wardrobe
// pack as a pull request (through the confirm window), and Claude's git access.
//   node scripts/e2e-github.js [settings.png] [code.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { startMockGitHub } = require('../test/fixtures/mock-github');

const ROOT = path.join(__dirname, '..');
const PORT = 9358;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, close: () => ws.close() };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const mock = await startMockGitHub();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  // One of your own packs, ready to publish.
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'shellby-packs', 'packs', 'tiny-hats', 'pack.json'), 'utf8'));
  fs.mkdirSync(path.join(data, 'wardrobe'), { recursive: true });
  fs.writeFileSync(path.join(data, 'wardrobe', `${pack.id}.json`), JSON.stringify(pack, null, 2));

  // GitHub access the shell running this script already has (GH_TOKEN etc.) would
  // leak into Shellby's tasks and hide whether Shellby itself handed any out.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GH_TOKEN|GITHUB_TOKEN|GITHUB_PERSONAL_ACCESS_TOKEN|GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+))$/.test(k)));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_GITHUB_WEB: mock.base, SHELLBY_GITHUB_API: mock.base, SHELLBY_GITHUB_CLIENT_ID: 'e2e-client',
    },
  });
  const until = async (ev, expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(200); } return false; };
  const dialogs = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.url.includes('dialog.html'));
  async function answer(button, titleRe) {
    let d = null;
    for (let i = 0; i < 40 && !d; i++) { d = (await dialogs())[0]; if (!d) await wait(200); }
    if (!d) return check(false, `confirm window for ${titleRe}`);
    const dlg = await connect(d.webSocketDebuggerUrl);
    await wait(500);
    const title = await dlg.ev("document.querySelector('h1, h2, .title')?.textContent || ''");
    check(titleRe.test(title), `asks first: "${title}"`);
    await dlg.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(button)}).click()`);
    dlg.close();
  }
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const ev = panel.ev;
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");

    // 1. Signed out: the section explains itself; Claude access waits for sign-in.
    await ev("SB.setView('settings')");
    await wait(700);
    check(await ev("!document.getElementById('ghSignIn').hidden && document.getElementById('ghAccount').hidden"), 'signed out: "Sign in with GitHub"');
    check(await ev("document.getElementById('ghClaude').disabled"), 'Claude access needs a sign-in first');
    await ev("document.getElementById('ghPublish').click()"); // ask for publishing too
    await ev("document.getElementById('githubGroup').scrollIntoView({ block: 'start' })");
    if (process.argv[2]) await savePng((m, p) => panel.send(m, p), process.argv[2]);

    // 2. The device code.
    await ev("document.getElementById('ghSignIn').click()");
    check(await until(ev, "document.getElementById('ghCodeText').textContent === 'CRAB-1234' && !document.getElementById('ghCode').hidden"), 'shows the code to enter on GitHub');
    check(/gist/.test(mock.state.requestedScope) && /public_repo/.test(mock.state.requestedScope) && !/\brepo\b/.test(mock.state.requestedScope), `asks only for the chosen features (${mock.state.requestedScope})`);
    if (process.argv[3]) await savePng((m, p) => panel.send(m, p), process.argv[3]);

    // 3. Approve → signed in, profile, first sync.
    mock.approve();
    check(await until(ev, "document.getElementById('ghLogin').textContent === '@crabfan' && !document.getElementById('ghAccount').hidden"), 'signed in as @crabfan');
    check(await ev("document.getElementById('ghName').textContent") === 'Crab Fan', 'shows the GitHub name');
    check(await until(ev, "/Last synced/.test(document.getElementById('ghSyncStatus').textContent)"), 'first sync done');
    const gist = [...mock.state.gists.values()][0];
    check(gist && gist.public === false && !!gist.files['shellby-sync.json'], 'progress lives in a private gist');
    const settingsText = fs.readFileSync(path.join(data, 'settings.json'), 'utf8');
    check(!settingsText.includes(mock.state.token), 'the token is not in settings.json');
    const bin = fs.readFileSync(path.join(data, 'github.bin'));
    check(bin.length > 0 && !bin.toString('latin1').includes(mock.state.token), 'the token file is encrypted');

    // 4. Publish your pack as a pull request.
    await ev("SB.setView('wardrobe')");
    await wait(800);
    const hasBtn = await until(ev, `[...document.querySelectorAll('#packList .pack')].some(li => li.textContent.includes(${JSON.stringify(pack.name)}) && li.querySelector('.publish-btn'))`);
    check(hasBtn, 'your pack has a Publish button');
    ev(`[...document.querySelectorAll('#packList .pack')].find(li => li.textContent.includes(${JSON.stringify(pack.name)})).querySelector('.publish-btn').click()`);
    await answer('Publish', /Publish to the gallery/);
    check(await until(ev, "/Pull request opened/.test(document.getElementById('toast').textContent)"), 'toast: pull request opened');
    const pr = mock.state.pulls[0];
    check(pr && pr.head.startsWith('crabfan:pack-') && pr.base === 'main', `PR from your fork (${pr && pr.head})`);
    check(mock.state.forks.has('crabfan/shellby-packs'), 'forked the gallery');

    // 5. Claude access: widening the sign-in, with a warning first.
    await ev("SB.setView('settings')");
    await wait(500);
    await ev('SB.newTab()');
    await ev("SB.send('gitenv')");
    check(await until(ev, "document.body.textContent.includes('gh:no')"), 'tasks get no GitHub access by default');
    await ev("SB.setView('settings')");
    await wait(400);
    ev("document.getElementById('ghClaude').click()");
    await answer('Allow', /Let Claude tasks use your GitHub/);
    check(await until(ev, "!document.getElementById('ghCode').hidden"), 'asks GitHub again for the wider permission');
    check(/\brepo\b/.test(mock.state.requestedScope) && /gist/.test(mock.state.requestedScope), `asks for repo and keeps the rest (${mock.state.requestedScope})`);
    check(await until(ev, "document.getElementById('ghClaude').checked && document.getElementById('ghCode').hidden"), 'Claude access on after approval');
    await ev('SB.newTab()');
    await ev("SB.send('gitenv')");
    check(await until(ev, "document.body.textContent.includes('gh:yes mcp:yes helpers:2')"), 'new tasks get GH_TOKEN, the GitHub plugin token and the git credential helper');

    // 6. Sign out.
    await ev("SB.setView('settings')");
    await wait(400);
    await ev("document.getElementById('ghSignOut').click()");
    check(await until(ev, "!document.getElementById('ghSignIn').hidden"), 'signed out');
    check(!fs.existsSync(path.join(data, 'github.bin')), 'the token file is gone');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
    await mock.close();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
