// End-to-end check of the things that let something else drive the crab, or
// let him reach out. Drives the real app over CDP on real ports.
//   1. the MCP server's actions: say, celebrate, wear, status
//   2. the `shellby` command's task route refuses a request with no token
//   3. the browser source serves the overlay, and the crab on it is the real one
//   4. the hook's host header names the editor a session is running in
//   node scripts/e2e-integrations.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9376;
const HOOK = 47996;
const OBS = 47997;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-int-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url, dir) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const shot = async name => await savePng(send, path.join(dir, `${name}.png`));
  return { ev, shot };
}

const post = (port, route, body, headers = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'X-Shellby': '1', ...headers },
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-int-data-'));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK) },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl, OUT);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl, OUT);
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(150); } return false; };

    await wait(3000);
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");
    await panel.ev('shellby.setExternal(true)');
    check(await until(panel, "shellby.getExternal().then(v => v.status === 'listening')", 6000), 'the local port is listening');

    // ---- 1. the MCP server's actions
    const said = await post(HOOK, '/v1/crab', { action: 'say', args: { text: 'all green', mood: 'proud' } });
    check(said.status === 200, `say is accepted (${said.status})`);
    const bubble = () => critter.ev("document.getElementById('bubbleText').textContent");
    check(await until(critter, "document.getElementById('bubbleText').textContent === 'all green'", 5000),
      `the crab says it on the desktop (bubble: ${JSON.stringify(await bubble())})`);

    const status = await post(HOOK, '/v1/crab', { action: 'status', args: {} });
    check(status.status === 200 && /Shellby:/.test(status.json?.text || ''), `status reads back (${JSON.stringify(status.json).slice(0, 90)})`);

    const wear = await post(HOOK, '/v1/crab', { action: 'wear', args: { item: 'snorkel' } });
    check(wear.status === 200 && typeof wear.json?.text === 'string', `wear answers (${wear.json?.text})`);

    const nonsense = await post(HOOK, '/v1/crab', { action: 'rm -rf', args: {} });
    check(nonsense.status === 400, `an unknown action is refused (${nonsense.status})`);
    const noTask = await post(HOOK, '/v1/crab', { action: 'task', args: { prompt: 'do something' } });
    check(noTask.status === 400, 'there is no way to start a task over the crab route');

    // ---- 2. the shellby command
    const noToken = await post(HOOK, '/v1/cli', { action: 'task', args: { prompt: 'x', cwd: ROOT } });
    check(noToken.status === 403 || noToken.status === 401, `the command is refused while it is off (${noToken.status})`);
    await panel.ev('shellby.installCli()');
    const badToken = await post(HOOK, '/v1/cli', { action: 'task', args: { prompt: 'x', cwd: ROOT } }, { 'X-Shellby-Token': 'nope' });
    check(badToken.status === 401, `a wrong token is refused (${badToken.status})`);
    const token = (() => { try { return fs.readFileSync(path.join(data, 'cli-token'), 'utf8').trim(); } catch { return ''; } })();
    check(token.length > 30, 'a token was written to the settings folder');
    const good = await post(HOOK, '/v1/cli', { action: 'status' }, { 'X-Shellby-Token': token });
    check(good.status === 200 && /Shellby:/.test(good.json?.text || ''), `the right token gets an answer (${good.status})`);
    await panel.ev('shellby.removeCli()');

    // ---- 3. the browser source
    await panel.ev(`shellby.setObs({ enabled: true, port: ${OBS} })`);
    check(await until(panel, "shellby.getObs().then(v => v.status === 'listening')", 6000), 'the browser source is listening');
    const page = await fetch(`http://127.0.0.1:${OBS}/`).then(r => r.text()).catch(() => '');
    check(/Shellby overlay/.test(page), 'it serves the overlay page');
    const css = await fetch(`http://127.0.0.1:${OBS}/critter/critter.css`).then(r => r.status).catch(() => 0);
    check(css === 200, `it serves the real critter stylesheet (${css})`);
    const traversal = await fetch(`http://127.0.0.1:${OBS}/../package.json`).then(r => r.status).catch(() => 0);
    check(traversal === 404, `it refuses a path outside its table (${traversal})`);
    await panel.ev('shellby.setObs({ enabled: false })');

    // ---- 4. which editor a session is in
    const hook = (body, headers) => fetch(`http://127.0.0.1:${HOOK}/v1/hook`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-Shellby': '1', ...headers },
    }).then(r => r.status);
    await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'int-1', cwd: 'C:/work/kelp' }, { 'X-Shellby-Host': 'cursor' });
    check(await until(panel, "shellby.getExternal().then(v => v.sessions.some(s => s.client === 'Cursor' && s.where === 'kelp in Cursor'))", 6000),
      `the session is labelled with its editor (${JSON.stringify(await panel.ev('shellby.getExternal().then(v => v.sessions.map(s => s.where))'))})`);

    // ---- 5. Settings shows all of it, and nothing in the renderer threw
    await panel.ev("SB.setView('settings')");
    await wait(900);
    const sections = await panel.ev("[...document.querySelectorAll('.setting-group')].map(s => s.dataset.nav).filter(Boolean)");
    for (const nav of ['Elsewhere', 'On a stream', 'Desk lighting', 'Music']) {
      check((sections || []).includes(nav), `Settings has a "${nav}" section`);
    }
    check(await panel.ev("!!document.getElementById('cliBtn').textContent"), 'the shellby command card rendered');
    check(await panel.ev("document.querySelectorAll('#chEvents .toggle').length >= 5"), 'the channel event list rendered');
    check(await panel.ev("document.getElementById('obsUrl').textContent.includes('127.0.0.1')"), 'the overlay URL is shown');
    // Turning one on from the UI has to work, not just over IPC.
    await panel.ev("document.getElementById('npEnabled').click()");
    await wait(600);
    check(await panel.ev("shellby.getNowPlaying().then(v => v.enabled === true)"), 'the music toggle sticks');
    await panel.ev("document.getElementById('npEnabled').click()");
    await panel.shot('integrations-settings');

    await critter.shot('integrations-critter');
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
