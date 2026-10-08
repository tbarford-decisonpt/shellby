// End-to-end check of the 0.14.1 fixes against the dev app over CDP, on an
// isolated profile: Settings says whether the Shellby plugin is installed (and
// offers to install it), both status files are written (emoji + plain ASCII for
// cmd.exe), and an isolated dev copy never takes the real hook port.
//   node scripts/e2e-plugin-card.js [screenshot.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9357;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '' },
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
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");

    // 1. The plugin card: not installed in this fresh profile → an Install button.
    await ev("SB.setView('settings')");
    await wait(800);
    const text = await ev("document.getElementById('pluginText').textContent");
    check(/Not installed on this PC/.test(text), `plugin card says it's missing ("${text}")`);
    check(await ev("!document.getElementById('pluginBtn').hidden"), 'offers "Install the plugin"');
    await ev("document.getElementById('pluginCard').scrollIntoView({ block: 'center' })");
    if (process.argv[2]) await savePng(send, process.argv[2]);

    // 2. Installed (as Claude Code records it) → the card says so, no button.
    const target = path.join(data, 'claude-settings.json'); // the isolated stand-in for ~/.claude/settings.json
    fs.writeFileSync(target, JSON.stringify({ enabledPlugins: { 'shellby@shellby': true } }));
    const v = await ev('shellby.getPlugin()');
    check(v && v.state === 'on', `detected as installed (${JSON.stringify(v)})`);

    // 3. The external listener: an isolated copy listens on a random port, not 47913.
    const ext = await ev('shellby.getExternal()');
    check(ext && ext.port && ext.port !== 47913, `isolated dev copy uses its own port (${ext && ext.port})`);
    check(fs.existsSync(path.join(os.tmpdir(), `shellby-hooks-${ext.port}`)), 'and marks it as listening');

    // 4. Both status files, the plain one pure ASCII.
    const files = fs.readdirSync(data, { recursive: true }).map(f => path.join(data, f)).filter(f => /shellby-status(-plain)?\.txt$/.test(f));
    const plainF = files.find(f => f.endsWith('-plain.txt'));
    check(files.length === 2, `emoji and plain status files written (${files.map(f => path.basename(f)).join(', ') || 'none'})`);
    if (plainF) {
      const line = fs.readFileSync(plainF, 'utf8');
      check(/^[\x00-\x7f]+$/.test(line) && line.includes('Shellby') && line.includes('Lv'), `plain line is ASCII: ${line.replace(/\x1b\[[0-9;]*m/g, '')}`);
    }
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
