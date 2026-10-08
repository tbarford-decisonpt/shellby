// End-to-end check of the Shellby Claude Code plugin: a dev Shellby listens on a
// test port, a REAL `claude -p` session runs with --plugin-dir ./claude-plugin,
// and we record what the desktop crab did. Uses one tiny prompt on your Claude
// plan; the only tool it may use is a harmless `echo`.
// Also checks the hook script with nothing listening: never fails, never stalls.
//   node scripts/e2e-plugin.js
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findClaude } = require('../src/main/claude/cli');

const ROOT = path.join(__dirname, '..');
const CDP = 9348;
const HOOK_PORT = 47999;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

  // 1. The hook with Shellby not running: exit 0, silent, fast.
  const bash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash'].find(b => b === 'bash' || fs.existsSync(b));
  const t0 = Date.now();
  const r = spawnSync(bash, [path.join(ROOT, 'claude-plugin', 'hooks', 'notify.sh')], { input: '{"hook_event_name":"Stop","session_id":"x"}', env: { ...process.env, SHELLBY_PORT: '47998' }, encoding: 'utf8' });
  check(r.status === 0 && !r.stdout && !r.stderr, `hook with Shellby closed: exit ${r.status}, no output`);
  check(Date.now() - t0 < 600, `...and returns at once (${Date.now() - t0} ms)`);

  // 2. A dev Shellby listening on the test port.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${CDP}`],
    { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_HOOK_PORT: String(HOOK_PORT) } });
  try {
    let list = [];
    for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('critter.html')) && list.some(t => t.url.endsWith('panel.html'))); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const connect = async url => {
      const ws = new WebSocket(url);
      await new Promise(res => { ws.onopen = res; });
      let id = 0; const p = new Map();
      ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
      return expr => new Promise(res => { const i = ++id; p.set(i, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    };
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await wait(2500);
    // Record every mood the crab shows.
    await critter("window.__moods = []; setInterval(() => { const m = (document.body.className.match(/state-(\\w+)/) || [])[1]; if (m && window.__moods.at(-1) !== m) window.__moods.push(m); }, 50); true");

    // 3. A real Claude Code session with the plugin.
    const exe = findClaude();
    check(!!exe, `Claude Code found (${exe})`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-e2e-'));
    const env = { ...process.env, SHELLBY_PORT: String(HOOK_PORT) };
    delete env.SHELLBY_OWNED;
    const started = Date.now();
    const cli = spawnSync(exe, ['-p', 'Run this exact shell command with the Bash tool: echo shellby-plugin-test. Then reply with just: DONE',
      '--plugin-dir', path.join(ROOT, 'claude-plugin'), '--allowedTools', 'Bash(echo shellby-plugin-test)', '--model', 'haiku'],
      { cwd: work, env, encoding: 'utf8', timeout: 180000, shell: /\.(cmd|ps1)$/i.test(exe) });
    check(cli.status === 0, `claude exited 0 in ${((Date.now() - started) / 1000).toFixed(1)}s (${(cli.stdout || '').trim().slice(0, 40)})`);
    await wait(800);

    const moods = await critter('window.__moods');
    console.log('      crab moods:', moods.join(' -> '));
    check(moods.includes('working'), 'the crab worked while Claude worked');
    // A first-ever task also unlocks a trophy, whose celebration takes over from "success".
    const party = moods.findIndex(m => m === 'success' || m === 'unlocked');
    check(party >= 0, `the crab celebrated when the turn finished (${moods[party]})`);
    check(moods.indexOf('working') < party, '...after working');

    const ext = await panel('shellby.getExternal()');
    check(ext.status === 'listening', `Shellby listening (port ${ext.port})`);
    const s = (ext.sessions || [])[0];
    check(!s || s.project === path.basename(work), `session labelled with its folder (${s ? s.project : 'ended'})`);
    const stats = await panel('shellby.wardrobeView().then(v => v.stats.tasksCompleted)');
    check(stats >= 1, `the finished turn counts toward trophies (tasks: ${stats})`);
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
