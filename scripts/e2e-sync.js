// End-to-end check that your friends list, settings and his finds and bond
// follow you between PCs (sync-prefs.js, friends.js mergeSync, sync-life.js), against the dev app over CDP with a
// mock GitHub (test/fixtures/mock-github.js). Two isolated profiles stand in
// for two PCs signed in to the same account, one after the other:
//   1. PC A, with finds on his shelf and a bond, picks its settings, adds two friends and syncs.
//   2. PC B signs in fresh and gets them: the settings view shows them, the
//      friends' crabs are fetched, and PC A's own things (start at login) stay there.
//   3. Another PC changes a setting while B is open: it takes effect at once.
//   4. B removes a friend and changes a setting; A, opened again, follows.
//   node scripts/e2e-sync.js [settings-b.png] [friends-b.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { startMockGitHub } = require('../test/fixtures/mock-github');
const { FINDS } = require('../src/main/gifts');

const ROOT = path.join(__dirname, '..');
const PORT = 9367;
const HOTKEY = 'Control+Alt+Shift+F9'; // nothing else on the PC should hold this one
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
  const mock = await startMockGitHub({ autoApprove: true });
  const card = (login, hat) => JSON.stringify({ format: 1, login, name: login, skin: 'classic', level: 5, outfit: { hat }, updatedAt: Date.now() });
  mock.othersGist('reefbuddy', { 'shellby-card.json': card('reefbuddy', 'crown') });
  mock.othersGist('tidepal', { 'shellby-card.json': card('tidepal', null) });
  const pcA = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-a-'));
  const pcB = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-b-'));
  const settingsOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const syncGist = () => [...mock.state.gists.values()].find(g => g.files['shellby-sync.json']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GH_TOKEN|GITHUB_TOKEN|GITHUB_PERSONAL_ACCESS_TOKEN|GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+))$/.test(k)));

  let app = null;
  let panel = null;
  const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
  const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await panel.ev(expr)) return true; await wait(200); } return false; };

  /** Open Shellby on one "PC" and sign in to the mock GitHub, sync on. */
  async function open(dir, { signIn }) {
    app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
      stdio: 'ignore',
      env: {
        ...env, SHELLBY_USER_DATA: dir, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47967',
        SHELLBY_GITHUB_WEB: mock.base, SHELLBY_GITHUB_API: mock.base, SHELLBY_GITHUB_CLIENT_ID: 'e2e-client',
      },
    });
    let list = [];
    for (let i = 0; i < 60 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await targets(); } catch { /* starting */ }
      await wait(500);
    }
    panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await wait(3000);
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");
    if (signIn) {
      await panel.ev("shellby.githubSignIn(['sync'])");
      check(await until("document.getElementById('ghLogin')?.textContent === '@crabfan' || SB.state.github?.login === 'crabfan'"), 'signed in as @crabfan');
    }
  }

  async function turnOnFriends() {
    panel.ev("shellby.githubSetFeature('friends', true)");
    let d = null;
    for (let i = 0; i < 40 && !d; i++) { d = (await targets()).find(t => t.url.includes('dialog.html')); if (!d) await wait(200); }
    if (!d) return check(false, 'confirm window for Visiting crabs');
    const dlg = await connect(d.webSocketDebuggerUrl);
    await wait(500);
    await dlg.ev("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Turn on').click()");
    dlg.close();
    await wait(1000);
  }

  // Quit the way a PC does, not a kill: Chromium writes the key the sign-in is
  // encrypted with (Local State) on the way out, and the next start needs it.
  async function close() {
    if (!app) return;
    panel?.close();
    const exited = new Promise(r => app.once('exit', r));
    try {
      const browser = await connect((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
      browser.send('Browser.close');
    } catch { /* already gone */ }
    if (!(await Promise.race([exited.then(() => true), wait(10000)]))) app.kill();
    app = null;
    await wait(1000);
  }

  const sync = async () => panel.ev('shellby.githubSync().then(r => r.ok)');

  try {
    // ---- 1. PC A: finds and a bond already, settings, two friends, sync.
    const FIND = FINDS[0].id;
    fs.writeFileSync(path.join(pcA, 'settings.json'), JSON.stringify({ finds: { items: { [FIND]: { n: 3, first: 1000, last: 2000, shiny: 1 } }, digs: 7 }, bond: { hatchedAt: 1000, points: 140, days: 20, level: 2 } }));
    await open(pcA, { signIn: true });
    await turnOnFriends();
    const r = await panel.ev(`shellby.setSettings({ chatter: 'quiet', sounds: true, critterScale: 1.5, mode: 'plan', hotkey: '${HOTKEY}', openAtLogin: true }).then(r => r.settings)`);
    check(r.chatter === 'quiet' && r.hotkey === HOTKEY, 'PC A: settings saved');
    for (const login of ['reefbuddy', 'tidepal']) check((await panel.ev(`shellby.friendsAdd('${login}').then(r => r.ok)`)) === true, `PC A: added @${login}`);
    check(await sync(), 'PC A: synced');
    const gistA = JSON.parse(syncGist().files['shellby-sync.json'].content);
    check(gistA.prefs?.chatter?.v === 'quiet' && gistA.prefs?.hotkey?.v === HOTKEY, 'the gist holds the settings');
    check(!('openAtLogin' in gistA.prefs) && !('critterPos' in gistA.prefs) && !('cwd' in gistA.prefs), "but not the PC's own ones");
    check(gistA.friends?.list?.map(f => f.login).join() === 'reefbuddy,tidepal', 'and the friends list');
    check(!JSON.stringify(gistA).includes(mock.state.token), 'no token in the gist');
    check(Object.values(gistA.life?.tally || {}).some(e => e.v[`finds.${FIND}`] === 3), "and PC A's finds");
    await close();

    // ---- 2. PC B: a fresh sign-in brings it all.
    await open(pcB, { signIn: true });
    check(await until("SB.state.settings.chatter === 'quiet'"), 'PC B: the panel has the synced settings');
    const b = settingsOf(pcB);
    check(b.chatter === 'quiet' && b.sounds === true && b.critterScale === 1.5 && b.mode === 'plan' && b.hotkey === HOTKEY, 'PC B: saved them');
    check(b.openAtLogin === false, "PC B: start at login stayed PC A's");
    check(b.finds?.items?.[FIND]?.n === 3 && b.finds.items[FIND].shiny === 1 && b.finds.digs === 7, 'PC B: the finds came along, the sparkly one too');
    check(b.bond?.points >= 140 && b.bond.hatchedAt === 1000, 'PC B: so did his bond, and his hatch day');
    check(b.friends?.list?.map(f => f.login).join() === 'reefbuddy,tidepal', 'PC B: has both friends');
    await turnOnFriends();
    await panel.ev("SB.setView('settings')");
    await wait(800);
    check(await until("document.getElementById('chatterSelect').value === 'quiet' && document.getElementById('soundsToggle').checked && document.getElementById('scaleSelect').value === '1.5'"), 'PC B: the Settings view shows them');
    check(await until("/Shift/.test(document.getElementById('hotkeyBtn').textContent)"), `PC B: the hotkey is ${HOTKEY}`);
    check(await until("[...document.querySelectorAll('#frList .fr-friend')].filter(li => li.querySelector('svg.fr-crab')).length === 2", 15000), "PC B: both friends' crabs fetched");
    await panel.ev("document.getElementById('setTab-shellby').click()");
    await wait(400);
    await panel.ev("document.getElementById('chatterSelect').scrollIntoView({ block: 'center' })");
    if (process.argv[2]) await savePng((m, p) => panel.send(m, p), process.argv[2]);
    await panel.ev("document.getElementById('setTab-connect').click()");
    await wait(400);
    await panel.ev("document.getElementById('frList').scrollIntoView({ block: 'center' })");
    if (process.argv[3]) await savePng((m, p) => panel.send(m, p), process.argv[3]);

    // ---- 3. Another PC changes settings while B is open: they take effect now.
    const g = syncGist();
    const body = JSON.parse(g.files['shellby-sync.json'].content);
    const later = Date.now();
    body.prefs.chatter = { v: 'chatty', at: later };
    body.prefs.mode = { v: 'acceptEdits', at: later };
    body.prefs.critterScale = { v: 2, at: later };
    g.files['shellby-sync.json'].content = JSON.stringify(body);
    check(await sync(), 'PC B: synced again');
    check(await until("document.getElementById('chatterSelect').value === 'chatty' && document.getElementById('scaleSelect').value === '2'"), 'PC B: the open Settings view follows');
    check(await until("SB.state.settings.mode === 'acceptEdits' && document.querySelector('#modeCards [aria-checked=\"true\"]')?.textContent.length > 0"), 'PC B: the mode switched');
    const c = await connect((await targets()).find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    check(await c.ev('window.innerWidth') >= 150, `PC B: he grew to the synced size (${await c.ev('window.innerWidth')}px wide)`);
    c.close();

    // ---- 4. B removes a friend and goes back to normal chatter; A follows.
    check((await panel.ev("shellby.friendsRemove('tidepal').then(r => r.ok)")) === true, 'PC B: removed @tidepal');
    await panel.ev("shellby.setSettings({ chatter: 'normal' })");
    check(await sync(), 'PC B: synced');
    await close();
    await open(pcA, { signIn: false });
    check(await sync(), 'PC A: still signed in, and synced');
    const a = settingsOf(pcA);
    check(a.friends?.list?.map(f => f.login).join() === 'reefbuddy', 'PC A: @tidepal is gone here too');
    check(a.chatter === 'normal' && a.mode === 'acceptEdits' && a.critterScale === 2, `PC A: has the newest settings (${a.chatter}, ${a.mode}, ${a.critterScale})`);
    check(a.openAtLogin === true, 'PC A: kept its own start at login');
    check(await sync() && JSON.stringify(settingsOf(pcA).friends.list.map(f => f.login)) === '["reefbuddy"]', 'PC A: syncing again changes nothing');
  } catch (e) {
    check(false, e.message);
  } finally {
    await close();
    await mock.close();
    for (const dir of [pcA, pcB]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
