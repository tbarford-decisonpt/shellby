// ci: other computers: add one, connect, a passphrase asked in Shellby, a folder there, a conversation over ssh
// End-to-end check of Settings → Other computers against the dev app over CDP.
// ssh is the stand-in in test/fixtures/fake-ssh.js (it runs the remote side
// with sh, in a pretend home whose claude is the fake CLI), and the profile has
// a pretend ~/.ssh of its own, so nothing here touches your ssh settings, a
// network or a Claude account:
//   - a new computer from the form is written to the (pretend) ssh config and
//     connected straight away: reached, Claude Code there signed in;
//   - one that's off says it couldn't be reached;
//   - one whose key needs a passphrase asks for it in Shellby's own box (the
//     real askpass helper, built and all), and a wrong answer is refused;
//   - a folder there is picked by browsing, and Work here names it for where
//     it really is;
//   - a conversation in it runs over there: the file it writes lands in the
//     remote home, not in the stand-in folder on this PC.
//   node scripts/e2e-remote.js [screenshot-folder]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9385;
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const FAKE_SSH = path.join(ROOT, 'test', 'fixtures', 'fake-ssh.js');
const SHOTS = process.argv[2] || null;
const wait = ms => new Promise(r => setTimeout(r, ms));

// The other computer: ~/code/app (a git repo), and a claude that answers
// --version and auth status itself and is the fake CLI for everything else.
function otherComputer() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-remote-home-')));
  fs.mkdirSync(path.join(home, 'code', 'app', '.git'), { recursive: true });
  fs.mkdirSync(path.join(home, 'code', 'notes'), { recursive: true });
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
  const sshConfig = path.join(profile, 'claude-home', '.ssh', 'config');
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: FAKE_CLAUDE, SHELLBY_HOOK_PORT: '47985', SHELLBY_E2E: '1',
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
    const shot = name => (SHOTS ? savePng(send, path.join(SHOTS, `remote-${name}.png`)) : null);
    const card = alias => `[...document.querySelectorAll('#rcList .rc-card')].find(c => c.querySelector('.sl-head b').textContent === ${JSON.stringify(alias)})`;
    const steps = alias => ev(`JSON.stringify([...(${card(alias)})?.querySelectorAll('.rc-step') || []].map(s => [s.className.replace('rc-step ', ''), s.querySelector('.rc-text').textContent]))`).then(JSON.parse);
    const press = (alias, label) => ev(`[...(${card(alias)}).querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    const addNew = form => ev(`(() => {
      document.getElementById('rcNew').click();
      const set = (id, v) => { document.getElementById(id).value = v; };
      set('rcAlias', ${JSON.stringify(form.alias)}); set('rcAddress', ${JSON.stringify(form.address)});
      set('rcUser', ${JSON.stringify(form.user || '')}); set('rcPort', ${JSON.stringify(form.port || '')});
      document.getElementById('rcForm').requestSubmit();
    })()`);

    await until('!!window.SB && !!SB.state.version', 30000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");
    await ev("SB.showSetting('rcNew')");
    check(await until("!document.getElementById('remoteGroup').closest('.settings-panel').hidden"), 'Settings opens on Other computers');

    // 1. A new computer: written to the ssh config, then connected.
    await addNew({ alias: 'homebox', address: '192.168.1.20', user: 'crab', port: '2222' });
    check(await until(`(${card('homebox')})?.querySelectorAll('.rc-step.ok').length === 2`, 30000), 'homebox: connected, and Claude Code there signed in');
    const homeSteps = await steps('homebox');
    check(/signed in as crab@example\.com \(max\)/.test(homeSteps[1]?.[1] || ''), `it says who's signed in there: ${homeSteps[1]?.[1]}`);
    const written = fs.existsSync(sshConfig) ? fs.readFileSync(sshConfig, 'utf8') : '';
    check(/# Added by Shellby\nHost homebox\n {4}HostName 192\.168\.1\.20\n {4}User crab\n {4}Port 2222\n/.test(written), 'the computer went into the ssh config, Shellby\'s own block');
    await shot('connected');

    // 2. One that's off.
    await addNew({ alias: 'unreachable', address: '10.9.9.9' });
    check(await until(`(${card('unreachable')})?.querySelector('.rc-step.bad')`, 30000), 'an unreachable computer is marked');
    check(/couldn't reach/i.test((await steps('unreachable'))[0]?.[1] || ''), 'and says it couldn\'t be reached');

    // 3. A key with a passphrase: asked in Shellby's box, through the real askpass helper.
    await addNew({ alias: 'asks', address: '10.0.0.7' });
    check(await until("!document.getElementById('rcAskSheet').hidden", 30000), 'ssh asks for the passphrase in Shellby');
    const asked = JSON.parse(await ev("JSON.stringify({ title: document.getElementById('rcAskTitle').textContent, lede: document.getElementById('rcAskLede').textContent, type: document.getElementById('rcAskInput').type })"));
    check(asked.title === 'Unlock your key' && /passphrase for test_key/.test(asked.lede) && asked.type === 'password', `the box says which key, hidden as typed: ${JSON.stringify(asked)}`);
    await shot('passphrase');
    await ev("(() => { document.getElementById('rcAskInput').value = 'wrong'; document.getElementById('rcAskForm').requestSubmit(); })()");
    check(await until(`(${card('asks')})?.querySelector('.rc-step.bad')`, 30000), 'a wrong passphrase is refused');
    check(await ev("document.getElementById('rcAskInput').value === ''"), 'and what was typed is cleared');
    await press('asks', 'Try again');
    check(await until("!document.getElementById('rcAskSheet').hidden", 30000), 'it asks again');
    await ev("(() => { document.getElementById('rcAskInput').value = 'right'; document.getElementById('rcAskForm').requestSubmit(); })()");
    check(await until(`(${card('asks')})?.querySelectorAll('.rc-step.ok').length === 2`, 30000), 'the right passphrase connects');

    // 4. A folder there: browsed to, added, worked in.
    await press('homebox', 'Add a folder there…');
    const dirsOf = () => ev(`JSON.stringify([...(${card('homebox')}).querySelectorAll('.rc-dirs li')].map(li => li.textContent))`).then(JSON.parse);
    check(await until(`(${card('homebox')})?.querySelectorAll('.rc-dirs li').length > 0`), 'the browser lists the home folder');
    await ev(`[...(${card('homebox')}).querySelectorAll('.rc-dirs .link-btn')].find(b => b.textContent === 'code/').click()`);
    check(await until(`[...(${card('homebox')})?.querySelectorAll('.rc-dirs li') || []].some(li => li.textContent === 'app/git')`), 'code/ holds app, marked as a git repo');
    console.log('       in code:', (await dirsOf()).join(' | '));
    await ev(`[...(${card('homebox')}).querySelectorAll('.rc-dirs .link-btn')].find(b => b.textContent === 'app/').click()`);
    check(await until(`(${card('homebox')}).querySelector('.rc-browse input').value === '~/code/app' && !!(${card('homebox')}).querySelector('.rc-dirs')`), 'inside app, the listing is in');
    await press('homebox', 'Work in this folder');
    check(await until(`[...(${card('homebox')})?.querySelectorAll('.rc-folder-list code') || []].some(c => c.textContent === '~/code/app')`), 'the folder is listed under homebox');
    await press('homebox', 'Work here');
    check(await until("document.getElementById('folderLabel').textContent === 'homebox: ~/code/app'"), `the folder chip names it for where it is: ${await ev("document.getElementById('folderLabel').textContent")}`);
    await shot('folder');

    // 5. A conversation there.
    await ev("SB.setView('chat')");
    await ev("SB.newTab()");
    await wait(500);
    await ev(`(i => { i.value = 'edit made-on-homebox.txt hello from the other side'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(SB.$('input'))`);
    const there = path.join(remoteHome, 'code', 'app', 'made-on-homebox.txt');
    const end = Date.now() + 30000;
    while (Date.now() < end && !fs.existsSync(there)) await wait(250);
    check(fs.existsSync(there) && fs.readFileSync(there, 'utf8') === 'hello from the other side\n', 'Claude Code wrote the file on the other computer');
    check(await until('!SB.activeTab().busy', 20000), 'the turn finished');
    const anchor = await ev('SB.activeTab().cwd');
    check(!!anchor && !fs.existsSync(path.join(anchor, 'made-on-homebox.txt')), 'nothing landed in the stand-in folder on this PC');
    await shot('conversation');
  } catch (e) {
    check(false, e.stack || e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
