// End-to-end check of XP and levels against the dev app over CDP: the fake CLI
// runs shell commands in a Shellby tab (tests, git push, a failing test), and
// hook events from an "outside" Claude Code session deploy something. Checks
// the XP log, the desktop "+XP" float, the titlebar badge, the Trophies XP
// card, and the level-up celebration. No Claude account, no usage.
//   node scripts/e2e-xp.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9352;
const HOOK = 47994;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-xp-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK) },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html'))); i++) {
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
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(150); } return false; };
    const xp = () => panel.ev('shellby.getXp()');
    const kinds = async () => (await xp()).log.map(e => e.kind);
    await wait(3000);
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    // Count XP floats on the desktop.
    await critter.ev("window.__xp = []; new MutationObserver(m => m.forEach(r => r.addedNodes.forEach(n => window.__xp.push(n.textContent)))).observe(document.getElementById('xpFloat'), { childList: true }); true");

    const start = await xp();
    check(start.log.some(e => e.kind === 'day'), 'a new day earns XP');
    check(await panel.ev("!document.getElementById('brandLevel').hidden && document.getElementById('brandLevel').textContent") === '1', 'titlebar badge shows level 1');
    check(await panel.ev("(r => r.width > 0 && r.height > 0)(document.getElementById('brandLevel').getBoundingClientRect())"), 'level badge is visible at the default width');

    const runTask = async text => {
      await panel.ev(`SB.send(${JSON.stringify(text)})`);
      await until(panel, '!SB.activeTab().busy && document.querySelectorAll(".msg.user").length > 0', 8000);
      await wait(600);
    };

    // 1. Tests pass in a Shellby tab.
    await runTask('run npm test');
    let k = await kinds();
    check(k.includes('tests'), 'passing "npm test" earns tests XP');
    check(k.includes('task'), 'finishing the task earns task XP');

    // 2. A failing test run earns no tests XP.
    const testsBefore = k.filter(x => x === 'tests').length;
    await runTask('run npm test FAIL');
    k = await kinds();
    check(k.filter(x => x === 'tests').length === testsBefore, 'a failing test run earns no tests XP');

    // 2b. ...and the next pass in that project is "green again".
    await runTask('run npm test');
    const proj = (await xp()).log.find(e => e.kind === 'tests')?.project;
    if (proj) check((await kinds()).includes('fixed'), `tests passing after a failure in ${proj} earn "green again" XP`);
    else console.log('SKIP  green again: the tab is not in a project folder');

    // 3. git push.
    await runTask('run git push origin main');
    check((await kinds()).includes('ship'), 'git push earns ship XP');

    // 4. An outside Claude Code session deploys (plugin hook events).
    const post = b => fetch(`http://127.0.0.1:${HOOK}/v1/hook`, { method: 'POST', headers: { 'X-Shellby': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const sess = { session_id: 'ext-1', cwd: 'C:/code/3d-rack' };
    await post({ ...sess, hook_event_name: 'UserPromptSubmit' });
    await post({ ...sess, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'vercel --prod' } });
    await post({ ...sess, hook_event_name: 'Stop' });
    await wait(800);
    const after = await xp();
    const dep = after.log.find(e => e.kind === 'deploy');
    check(!!dep && dep.project === '3d-rack', `outside deploy earns XP, labelled with its project (${dep && dep.project})`);
    check(after.xp > start.xp, `XP went up (${start.xp} -> ${after.xp})`);

    // 5. Desktop floats and level-up.
    const floats = await critter.ev('window.__xp');
    check(floats.length >= 6 && floats.every(f => /^\+\d+ XP$/.test(f)), `"+XP" floats on the desktop (${floats.join(', ')})`);
    check(after.level >= 2, `levelled up (level ${after.level}, ${after.title})`);
    check(await until(panel, "[...document.querySelectorAll('.celebrate .cel-title')].some(e => /^Level \\d+ · /.test(e.textContent))", 6000) || await panel.ev("document.body.classList.contains('celebrating')"), 'level-up celebration card shown');
    await panel.send('Page.captureScreenshot', { format: 'png' }).then(s => fs.writeFileSync(path.join(OUT, 'levelup.png'), Buffer.from(s.data, 'base64')));
    check(await panel.ev("document.getElementById('brandLevel').textContent") === String(after.level), 'titlebar badge updated');
    check(!(await kinds()).length || !(await xp()).log.some(e => e.project === require('os').userInfo().username), 'home-folder work is not labelled with the username');

    // 6. Trophies view: the XP card.
    await panel.ev("SB.setView('trophies')");
    await wait(500);
    check(await panel.ev("document.getElementById('xpLevel').textContent") === String(after.level), 'Trophies shows the level');
    check(await panel.ev("document.querySelectorAll('#xpLog li').length") >= 5, 'Trophies shows the XP log');
    const unlock = await panel.ev("document.getElementById('xpUnlock').textContent");
    check(/^Next at level \d+:.+ XP to go$/.test(unlock) && !/Shell shell/.test(unlock), `Trophies shows the next unlock (${unlock})`);
    check(await panel.ev("document.querySelectorAll('#xpBountyList li').length") === 3, "Trophies shows today's three bounties");
    check(await panel.ev("document.querySelectorAll('#xpSpark i').length") === 30, 'Trophies shows the last 30 days');
    check(await panel.ev("document.querySelectorAll('#xpWays li').length") === (await xp()).ways.length, 'the ways to earn come from main');
    check(/^#[0-9a-f]{6}$/i.test(await panel.ev("getComputedStyle(document.documentElement).getPropertyValue('--rank').trim()")), 'the badge colour follows the rank');
    await panel.send('Page.captureScreenshot', { format: 'png' }).then(s => fs.writeFileSync(path.join(OUT, 'trophies.png'), Buffer.from(s.data, 'base64')));
    const box = await panel.ev("(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }))((document.getElementById('xpCard').scrollIntoView({ block: 'start' }), document.getElementById('xpCard').getBoundingClientRect()))");
    await panel.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, scale: 1 } }).then(s => fs.writeFileSync(path.join(OUT, 'xp-card.png'), Buffer.from(s.data, 'base64')));
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
