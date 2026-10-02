// End-to-end check of the update button against the dev app over CDP, with the
// scripted fake updater (SHELLBY_FAKE_UPDATE) standing in for GitHub Releases.
//   node scripts/e2e-updates.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9349;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-updates-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// A crab-only profile that has already been through onboarding: this is about
// the update row, not the welcome.
function newProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: true, notifications: false }));
  return dir;
}

async function launch(mode, profile) {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`],
    { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_UPDATE: mode } });
  let list = [];
  for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
    await wait(500);
  }
  const ws = new WebSocket(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { app, send, ev };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const shot = async (panel, name) => {
    const s = await panel.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64'));
  };
  const until = async (panel, expr, ms = 20000) => {
    for (let i = 0; i < ms / 300; i++) { if (await panel.ev(expr)) return true; await wait(300); }
    return false;
  };
  const text = (panel, id) => panel.ev(`document.getElementById('${id}').textContent`);

  // ---- a release is waiting
  let run = await launch('1', newProfile());
  try {
    const panel = run;
    await wait(2500);
    await panel.ev("SB.setView('settings')");
    check(await panel.ev("!document.getElementById('updateRow').hidden"), 'Settings → About has an update row');
    check(await until(panel, "SB.state.updates.state === 'downloading'"), 'the check finds the new version and downloads it');
    const status = await text(panel, 'updateStatus');
    check(status === 'Downloading v99.0.0…', `it says what it is doing: "${status}"`);
    check((await text(panel, 'updateBtn')).endsWith('%'), 'and how far along it is');
    check(await panel.ev("!document.getElementById('updateBar').hidden"), 'a progress bar fills as it downloads');
    check(await panel.ev("document.getElementById('updateBtn').disabled"), 'the button waits its turn');
    await shot(panel, '1-downloading');

    check(await until(panel, "SB.state.updates.state === 'ready'"), 'the download lands');
    check(await text(panel, 'updateBtn') === 'Restart and update', 'the button becomes "Restart and update"');
    check(!(await panel.ev("document.getElementById('updateBtn').disabled")), 'and is pressable');
    check(/99\.0\.0 is downloaded and ready/.test(await text(panel, 'updateStatus')), 'the row names the version');
    check(await panel.ev("!document.getElementById('updateDot').hidden"), 'the gear carries a dot from any screen');
    check(/Update 99\.0\.0 is ready/.test(await text(panel, 'toast')), 'a toast offers the restart');
    check(await panel.ev("document.querySelector('#toast .toast-action').textContent") === 'Restart and update', 'with the restart on it');

    // Where the tray item and the notification both land.
    await panel.ev("SB.setView('chat'); SB.jumpToSettingByName('About')");
    await wait(1200);
    check(await panel.ev("document.body.dataset.view") === 'settings', 'the tray route opens Settings');
    // The jump is a smooth scroll, so give it time to land.
    const onScreen = await until(panel, `(() => {
      const r = document.getElementById('updateRow').getBoundingClientRect();
      const v = document.getElementById('settingsView').getBoundingClientRect();
      return r.top >= v.top - 1 && r.bottom <= v.bottom + 1;
    })()`, 5000);
    check(onScreen, 'scrolled to the update button, not just to Settings');
    await shot(panel, '2-ready');

    // The button really drives the installer (the fake logs instead of quitting).
    check(await panel.ev('window.shellby.installUpdate()') === true, 'pressing it starts the install');
  } catch (e) {
    check(false, e.message);
  } finally {
    run.app.kill();
    await wait(1500);
  }

  // ---- offline: the row says so, and the button still works
  run = await launch('fail', newProfile());
  try {
    const panel = run;
    await wait(2500);
    await panel.ev("SB.setView('settings')");
    check(await until(panel, "SB.state.updates.state === 'error'"), 'a failed check ends in an error');
    check(/ERR_INTERNET_DISCONNECTED/.test(await text(panel, 'updateStatus')), 'which says what went wrong');
    check(await text(panel, 'updateBtn') === 'Check for updates', 'the button offers another go');
    check(await panel.ev("document.getElementById('updateDot').hidden"), 'no dot on the gear for a failed check');
    await shot(panel, '3-offline');

    await panel.ev("document.getElementById('updateBtn').click()");
    check(await until(panel, "SB.state.updates.state === 'checking'", 3000), 'pressing it checks again');
    check(await panel.ev('SB.state.updates.error') === null, 'and clears the old error while it does');
  } catch (e) {
    check(false, e.message);
  } finally {
    run.app.kill();
  }

  console.log(`\nscreenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
