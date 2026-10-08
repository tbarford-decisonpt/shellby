// End-to-end check of Shellby in Claude Code's status line, against the dev app
// over CDP. Isolated: the status file and the Claude settings.json both live in
// the throwaway profile, never the real ones. Fake CLI + fake hot GPU + an
// outside session asking for permission.
//   node scripts/e2e-statusline.js [screenshot.png]
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { COMMAND } = require('../src/main/statusline');

const ROOT = path.join(__dirname, '..');
const PORT = 9353;
const HOOK = 47993;
const wait = ms => new Promise(r => setTimeout(r, ms));
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const statusFile = path.join(profile, 'shellby-status.txt');
  const settingsFile = path.join(profile, 'claude-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }, null, 2));
  const read = () => (fs.existsSync(statusFile) ? plain(fs.readFileSync(statusFile, 'utf8')) : '');
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK), SHELLBY_FAKE_HEALTH: 'calm' },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const connect = async url => {
      const ws = new WebSocket(url);
      await new Promise(r => { ws.onopen = r; });
      let id = 0; const p = new Map();
      ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
      const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
      const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
      return { send, ev };
    };
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const untilLine = async (re, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(read())) return read(); await wait(150); } return read(); };
    await wait(3000);
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");

    // 1. The line exists and shows Shellby with his level.
    let line = await untilLine(/Shellby/);
    check(/^🦀\S* Shellby/.test(line) && /Lv 1 Hatchling/.test(line), `status line written ("${line}")`);

    // 2. Working, then done with "+XP".
    await panel.ev("SB.send('wait 1500 hello')");
    line = await untilLine(/working/);
    check(/🦀💨 Shellby working/.test(line), `working shows in the status line ("${line}")`);
    line = await untilLine(/\+10 XP/);
    check(/\+10 XP/.test(line), `finished task shows its "+10 XP" ("${line}")`);

    // 3. An outside session asks for permission.
    const post = b => fetch(`http://127.0.0.1:${HOOK}/v1/hook`, { method: 'POST', headers: { 'X-Shellby': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await post({ hook_event_name: 'Notification', session_id: 's1', cwd: 'C:/code/app', message: 'Claude needs your permission to use Bash' });
    line = await untilLine(/needs your OK/);
    check(/🦀✋ Shellby needs your OK/.test(line), `asking shows ("${line}")`);
    await post({ hook_event_name: 'SessionEnd', session_id: 's1' });

    // 4. Settings: add to Claude Code through the confirm window.
    await panel.ev("SB.setView('settings')");
    await wait(700);
    check(await panel.ev("document.getElementById('slBtn').textContent") === 'Add to Claude Code', 'Settings offers "Add to Claude Code"');
    check(/Shellby/.test(await panel.ev("document.getElementById('slPreview').textContent")), 'Settings shows a live preview');
    await panel.ev("document.getElementById('slCard').scrollIntoView({ block: 'center' })");
    await wait(300);
    if (process.argv[2]) await savePng((m, p) => panel.send(m, p), process.argv[2]);
    panel.ev("document.getElementById('slBtn').click()");
    let dialog = null;
    for (let i = 0; i < 30 && !dialog; i++) { dialog = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.url.includes('dialog.html')); if (!dialog) await wait(200); }
    check(!!dialog, 'asks in the isolated confirm window first');
    const dlg = await connect(dialog.webSocketDebuggerUrl);
    await wait(500);
    const title = await dlg.ev("document.querySelector('h1, h2, .title')?.textContent || ''");
    check(/Add Shellby to Claude Code/.test(title), `dialog: "${title}"`);
    await dlg.ev("[...document.querySelectorAll('button')].find(b => /Add it/.test(b.textContent)).click()");
    await wait(1000);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check(settings.statusLine?.command === COMMAND && settings.theme === 'dark', 'statusLine added, other settings kept');
    check(fs.existsSync(`${settingsFile}.shellby-backup`), 'backup of the original settings kept');
    check(await panel.ev("document.getElementById('slBtn').textContent") === 'Remove', 'Settings now offers Remove');

    // 5. Run the exact command Claude Code would run.
    const bash = ['C:\\Program Files\\Git\\bin\\bash.exe'].find(b => fs.existsSync(b)) || 'bash';
    const inner = COMMAND.slice(COMMAND.indexOf("'") + 1, COMMAND.lastIndexOf("'"));
    const r = spawnSync(bash, ['-c', inner], { env: { ...process.env, TEMP: profile, TMPDIR: profile }, encoding: 'utf8' });
    check(r.status === 0 && /Shellby/.test(plain(r.stdout)), `the statusLine command prints Shellby ("${plain(r.stdout)}")`);

    // 6. Remove restores the settings.
    await panel.ev("document.getElementById('slBtn').click()");
    await wait(800);
    check(JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))) === JSON.stringify({ theme: 'dark' }), 'Remove restores the original settings');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
