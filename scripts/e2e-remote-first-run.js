// ci: first run with Claude Code only on another computer: set it up over ssh, start in a folder there
// End-to-end check of first run's "Claude Code on another computer" path, for
// a PC where Claude Code can't be installed (a locked-down work PC) but ssh to
// a computer that has it works. ssh is the stand-in in test/fixtures/fake-ssh.js,
// as in e2e-remote.js, so nothing here touches your ssh settings or a network:
//   - this PC has no Claude Code (the panel is told so), and first run shows;
//   - the remote path borrows Settings' Other computers, and Let's go waits
//     for a computer with Claude Code signed in AND a folder there;
//   - Let's go starts in that folder, and gives the section back to Settings;
//   - first run doesn't come back, though Claude Code is still missing here;
//   - a conversation runs over there.
//   node scripts/e2e-remote-first-run.js [screenshot-folder]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9386;
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const FAKE_SSH = path.join(ROOT, 'test', 'fixtures', 'fake-ssh.js');
const SHOTS = process.argv[2] || null;
const wait = ms => new Promise(r => setTimeout(r, ms));
const NO_CLAUDE = "SB.state.status = { installed: false, loggedIn: false }"; // this PC, as the panel sees it

// The other computer: ~/code/app, and a claude that answers --version and auth
// status itself and is the fake CLI for everything else (as e2e-remote.js).
function otherComputer() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-remote-home-')));
  fs.mkdirSync(path.join(home, 'code', 'app', '.git'), { recursive: true });
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const slash = p => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = auth ]; then echo \'{"loggedIn":true,"email":"crab@example.com","authMethod":"claude.ai","subscriptionType":"max"}\'; exit 0; fi',
    'if [ "$1" = --version ]; then echo "2.1.9 (Claude Code)"; exit 0; fi',
    `exec "${slash(process.execPath)}" "${slash(FAKE_CLAUDE)}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return home;
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const remoteHome = otherComputer();
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: FAKE_CLAUDE, SHELLBY_HOOK_PORT: '47986', SHELLBY_E2E: '1',
      SHELLBY_FAKE_SSH: FAKE_SSH, SHELLBY_FAKE_SSH_HOME: remoteHome, SHELLBY_NODE: process.execPath, SHELLBY_REAL_SSH: '',
    },
  });
  try {
    let list = [];
    for (let i = 0; i < 60 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const ws = new WebSocket(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const p = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const until = async (expr, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(200); } return false; };
    const shot = name => (SHOTS ? savePng(send, path.join(SHOTS, `remote-first-run-${name}.png`)) : null);
    const card = `document.querySelector('#rcList .rc-card')`;
    const press = label => ev(`[...(${card}).querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    const hint = () => ev("document.getElementById('onboardRemoteHint').textContent");
    const letsGoOff = () => ev("document.getElementById('letsGoBtn').disabled");

    await until('!!window.SB && !!SB.state.version', 30000);
    await ev(NO_CLAUDE);
    check(await until("SB.state.view === 'onboarding'"), 'a new profile opens on first run');
    check(await ev('SB.needsOnboarding()'), 'and without Claude Code here, it needs it');

    // 1. The remote path: Settings' Other computers, here.
    await ev("document.querySelector('#onboardPaths .path[data-path=\"remote\"]').click()");
    check(await until("document.getElementById('remoteGroup').parentElement.id === 'onboardRemote' && !document.getElementById('claudeSetup').hidden"), 'the remote path shows Other computers');
    check(await ev("document.getElementById('steps').hidden"), "the install-here steps don't");
    check(await letsGoOff(), "Let's go waits for a computer");
    check(/Add the computer you ssh to/.test(await hint()), `it says what's next: ${await hint()}`);
    await shot('empty');

    // 2. A computer, connected and signed in: still needs a folder there.
    await ev(`(() => {
      document.getElementById('rcNew').click();
      document.getElementById('rcAlias').value = 'homebox';
      document.getElementById('rcAddress').value = '192.168.1.20';
      document.getElementById('rcUser').value = 'crab';
      document.getElementById('rcForm').requestSubmit();
    })()`);
    check(await until(`(${card})?.querySelectorAll('.rc-step.ok').length === 2`, 30000), 'homebox: connected, and Claude Code there signed in');
    check(await until("/Now add a folder/.test(document.getElementById('onboardRemoteHint').textContent)"), `then it asks for a folder: ${await hint()}`);
    check(await letsGoOff(), "Let's go still waits");

    // 3. A folder there: Let's go can go.
    await press('Add a folder there…');
    check(await until(`[...(${card}).querySelectorAll('.rc-dirs .link-btn')].some(b => b.textContent === 'code/')`), 'the browser lists the home folder');
    await ev(`[...(${card}).querySelectorAll('.rc-dirs .link-btn')].find(b => b.textContent === 'code/').click()`);
    check(await until(`[...(${card}).querySelectorAll('.rc-dirs .link-btn')].some(b => b.textContent === 'app/')`), 'code/ holds app');
    await ev(`[...(${card}).querySelectorAll('.rc-dirs .link-btn')].find(b => b.textContent === 'app/').click()`);
    check(await until(`(${card}).querySelector('.rc-browse input')?.value === '~/code/app' && !!(${card}).querySelector('.rc-dirs')`), 'inside app');
    await press('Work in this folder');
    check(await until("!document.getElementById('letsGoBtn').disabled"), "with a folder there, Let's go can go");
    check(/Ready\. Conversations start in homebox: ~\/code\/app/.test(await hint()), `and it says where: ${await hint()}`);
    await shot('ready');

    // 4. Let's go: chat, in that folder, with the section back in Settings.
    await ev("document.getElementById('letsGoBtn').click()");
    check(await until("SB.state.view === 'chat'"), "Let's go opens the chat");
    check(await until("document.getElementById('folderLabel').textContent === 'homebox: ~/code/app'"), `in the folder there: ${await ev("document.getElementById('folderLabel').textContent")}`);
    check(await ev('SB.state.settings.claudeElsewhere === true'), 'Shellby remembers Claude Code is elsewhere');
    check(await ev("!!document.getElementById('remoteGroup').closest('.view-settings') && !document.getElementById('onboardRemote').contains(document.getElementById('remoteGroup'))"), 'Other computers is back in Settings');
    await ev(NO_CLAUDE);
    check(await ev('!SB.needsOnboarding()'), "first run doesn't come back, with Claude Code still missing here");

    // 5. A conversation there.
    await ev("SB.newTab()");
    await wait(500);
    await ev(`(i => { i.value = 'edit made-on-homebox.txt hello from the other side'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(SB.$('input'))`);
    const there = path.join(remoteHome, 'code', 'app', 'made-on-homebox.txt');
    const end = Date.now() + 30000;
    while (Date.now() < end && !fs.existsSync(there)) await wait(250);
    check(fs.existsSync(there) && fs.readFileSync(there, 'utf8') === 'hello from the other side\n', 'Claude Code wrote the file on the other computer');
    check(await until('!SB.activeTab().busy', 20000), 'the turn finished');
    await shot('conversation');
  } catch (e) {
    check(false, e.stack || e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
