// ci: Work mode: the tools first, a quiet crab, your own settings back when you leave
// End-to-end check of Work mode (src/main/workmode.js) against the dev app over
// CDP with the fake CLI, as a brand-new user whose settings already have a
// lively crab in them (pals, chatty, climbing your windows):
//   1. first run offers three paths; Work mode goes through the Claude setup
//   2. Let's go: the chat, a bar that leads with the tools, Shellby's screens last
//   3. his settings show Work mode's quiet ones; the file keeps yours
//   4. a pal added in Work mode is Work mode's, not yours
//   5. his needs rest (the Us page says so)
//   6. Ctrl+K → Leave Work mode: the usual bar, and everything as it was
// No Claude account, no usage.
//   node scripts/e2e-work-mode.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9393;
const HOOK = 47986;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-work-mode-'));
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
const MINE = { colony: 3, chatter: 'chatty', perch: 'often', climb: 'often' };
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(MINE));
const saved = () => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  // A screenshot is for a person to look at; one that doesn't come is noted, not failed.
  const shot = async name => {
    const s = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), wait(10000)]);
    if (s?.data) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64'));
    else console.log(`(no screenshot for ${name})`);
  };
  return { send, ev, shot, close: () => ws.close() };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
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
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await wait(3000);
    const bar = () => panel.ev("[...document.querySelectorAll('.dock [data-view-btn]')].map(b => b.dataset.viewBtn)");

    // 1. Three paths; Work mode needs Claude Code, so its steps show.
    check(await panel.ev('document.body.dataset.view') === 'onboarding', 'new user sees onboarding');
    check(await panel.ev("document.querySelectorAll('#onboardPaths .path').length") === 3, 'three paths offered');
    await panel.ev("document.querySelector('.path[data-path=work]').click()");
    await wait(500);
    check(await panel.ev("!document.getElementById('claudeSetup').hidden"), 'Work mode shows the Claude Code steps');
    await panel.shot('1-onboarding');

    // 2. Let's go.
    for (let i = 0; i < 20 && await panel.ev("document.getElementById('letsGoBtn').disabled"); i++) await wait(300);
    await panel.ev("document.getElementById('letsGoBtn').click()");
    await wait(900);
    check(await panel.ev('document.body.dataset.view') === 'chat', 'lands on the chat');
    check(await panel.ev("document.body.classList.contains('work-mode')"), 'Work mode is on');
    const order = await bar();
    check(JSON.stringify(order) === JSON.stringify(['chat', 'projects', 'notes', 'history', 'toolbox', 'workflows', 'health', 'wardrobe']), `the bar leads with the tools (${order})`);
    check(await panel.ev("document.querySelector('.dock [data-view-btn=chat]').title") === 'Chat (Ctrl+1)', 'Ctrl+1 is the chat');
    check(await panel.ev("[...document.querySelectorAll('.dock [data-view-btn]')].every(b => getComputedStyle(b).display !== 'none')"), 'every tool is on the bar from the start');
    check(await panel.ev("/^Show me around a project/.test(SB.activeTab().empty.querySelector('.suggestion')?.textContent.slice(1) || '')"), 'the first task leads with Show me around');
    await panel.shot('2-chat');

    // 3. Settings show Work mode's; the file keeps yours.
    let s = saved();
    check(s.workMode === true && s.onboarded === true && s.crabOnly === false, 'choice saved (workMode, onboarded)');
    check(s.colony === 3 && s.chatter === 'chatty' && s.perch === 'often', 'your own settings are untouched on disk');
    await panel.ev("SB.setView('settings'); SB.showSettingsTab('shellby')");
    await wait(400);
    check(await panel.ev("document.getElementById('workModeToggle').checked"), 'Settings: the Work mode switch is on');
    check(await panel.ev("document.getElementById('chatterSelect').value") === 'work', 'he talks "just about work"');
    check(await panel.ev("document.getElementById('colonySelect').value") === '0', 'no pals');
    check(await panel.ev("document.getElementById('perchSelect').value") === 'off', 'off your windows');
    await panel.shot('3-settings');

    // 4. A pal while in Work mode: Work mode's, not yours.
    await panel.ev("(() => { const el = document.getElementById('colonySelect'); el.value = '1'; el.dispatchEvent(new Event('change')); })()");
    await wait(600);
    s = saved();
    check(s.colony === 3 && s.workOverrides?.colony === 1, 'the pal is kept as Work mode\'s; yours stays 3');
    check(await panel.ev('SB.state.settings.colony') === 1, 'and it shows');

    // 5. His needs rest.
    await panel.ev("SB.setView('us')");
    await wait(800);
    check(await panel.ev("document.getElementById('usNeedsMood').textContent") === 'Resting while you work', 'the Us page: resting while you work');

    // 6. Leave from Ctrl+K.
    await panel.ev("SB.setView('chat'); SB.openPalette()");
    await panel.ev("(() => { const i = document.getElementById('paletteInput'); i.value = 'leave work'; i.dispatchEvent(new Event('input')); })()");
    await wait(200);
    check(await panel.ev("document.querySelector('#paletteList .pal-title')?.textContent") === 'Leave Work mode', 'Ctrl+K offers Leave Work mode');
    await panel.ev("document.getElementById('paletteInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    await wait(900);
    check(!await panel.ev("document.body.classList.contains('work-mode')"), 'Work mode is off');
    check((await bar())[0] === 'wardrobe', 'the usual bar is back');
    check(await panel.ev('SB.state.settings.colony') === 3 && await panel.ev('SB.state.settings.chatter') === 'chatty'
      && await panel.ev('SB.state.settings.perch') === 'often', 'everything as it was: 3 pals, chatty, climbing your windows');
    await panel.shot('4-back');
    panel.close();
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
    await wait(1500);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
