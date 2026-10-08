// ci: work a turn left running: the badge, the list, clearing it
// End-to-end check of the one thing Shellby shows while he looks idle: work a
// turn started in the background and never came back to. Drives the real app
// over CDP and feeds it real hook events on the real port.
//   1. a backgrounded command survives the Stop that ends the turn
//   2. the crab wears a badge for it, even sitting idle, and the status line says so
//   3. Settings lists what it was, where, and how long ago
//   4. "I've checked" clears it everywhere
//   node scripts/e2e-background.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9372;
const HOOK = 47994;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-bg-'));
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

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-bg-data-'));
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
    const badge = () => critter.ev("(() => { const b = document.getElementById('bgBadge'); return b.hidden ? '' : b.textContent; })()");
    const rows = () => panel.ev("[...document.querySelectorAll('#bgList .bg-item')].map(li => li.querySelector('b').textContent + '@' + li.querySelector('.bg-where').textContent)");
    const statusLine = () => { try { return fs.readFileSync(path.join(data, 'shellby-status.txt'), 'utf8'); } catch { return ''; } };
    const hook = body => fetch(`http://127.0.0.1:${HOOK}/v1/hook`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-Shellby': '1' },
    }).then(r => r.status);

    await wait(3000);
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");
    await panel.ev('shellby.setExternal(true)');
    check(await until(panel, "shellby.getExternal().then(v => v.status === 'listening')", 6000), 'Shellby is listening for sessions elsewhere');

    // ---------------------------------------------- 1. a turn backgrounds a command
    const session = { session_id: 'bg-e2e-1', cwd: 'C:\\Users\\you\\code\\tide-pool' };
    check(await hook({ ...session, hook_event_name: 'UserPromptSubmit' }) === 204, 'a session elsewhere starts a turn');
    check(await until(critter, "document.body.classList.contains('state-working')", 6000), 'he works along with it');
    await hook({ ...session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cd /c/code && node scripts/serve.js', run_in_background: true } });
    await hook({ ...session, hook_event_name: 'Stop' });

    // ---------------------------------------------- 2. the turn ends, the badge doesn't
    check(await until(critter, "document.body.classList.contains('state-idle')", 9000), 'the turn ends and he settles');
    check(await badge() === '1', "...but he still wears a badge: the server is nobody's business but yours");
    check(/left running/.test(statusLine()), `the status line says so too (${statusLine().replace(/\u001b\[[0-9;]*m/g, '').slice(0, 60)})`);
    await critter.shot('1-badge');

    // ---------------------------------------------- 3. inspect it
    await panel.ev("SB.setView('settings'); document.getElementById('externalGroup').scrollIntoView({ block: 'start' })");
    check(await until(panel, "!document.getElementById('bgLeft').hidden", 4000), 'Settings shows what was left running');
    check(JSON.stringify(await rows()) === JSON.stringify(['node@tide-pool']), `the program and the project, never the command (${JSON.stringify(await rows())})`);
    check(!/serve\.js|\/c\/code/.test(await panel.ev("document.getElementById('bgLeft').textContent")), 'no arguments and no paths on screen');
    // A trophy for the first finished turn can land over this; dismiss it first.
    for (let i = 0; i < 12 && await panel.ev("!!document.querySelector('.cel-close')"); i++) {
      await panel.ev("document.querySelector('.cel-close').click()");
      await wait(350);
    }
    await wait(400);
    await panel.shot('2-settings');

    // a second one, from another project, stacks up
    await hook({ session_id: 'bg-e2e-2', cwd: 'C:\\Users\\you\\code\\reef', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run dev', run_in_background: true } });
    check(await until(critter, "document.getElementById('bgBadge').textContent === '2'", 5000), 'a second one counts up');
    check(JSON.stringify(await rows()) === JSON.stringify(['npm@reef', 'node@tide-pool']), 'newest first');

    // ---------------------------------------------- 4. clearing it
    await panel.ev("document.getElementById('bgClear').click()");
    check(await until(panel, "document.getElementById('bgLeft').hidden", 4000), "\"I've checked\" empties the list");
    check(await until(critter, "document.getElementById('bgBadge').hidden", 4000), '...and takes the badge off him');
    check(!/left running/.test(statusLine()), '...and the status line goes quiet');

    console.log(`\nScreenshots: ${OUT}`);
    console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  } finally {
    app.kill();
  }
  process.exit(fails ? 1 : 0);
})();
