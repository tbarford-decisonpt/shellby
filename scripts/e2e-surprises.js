// Crit hits and small surprises, end to end against the fake CLI: a turn that
// runs the tests red, edits a file and runs them green is a critical hit, and
// the crab shows it (his line, the CRIT! badge, the jump), the conversation
// keeps a note of it and XP pays for it. A second straight after is held back,
// and switched off in Settings there are none. No account, no network.
// Screenshots go to %TEMP%\shellby-e2e-surprises.
//   node scripts/e2e-surprises.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9388;
const wait = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'shellby-e2e-surprises');

// A git project to fix. realpath.native: CI's temp folder is an 8.3 short
// path, and git reports the long one.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-surprises-')));
const repo = path.join(base, 'proj');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'auth.js'), 'broken\n');
git('add', '-A');
git('commit', '-qm', 'init');
const claudeConfig = path.join(base, 'claude');
fs.mkdirSync(claudeConfig);
// Mid-level, so no level-up (and its new shell) takes the bubble mid-test.
fs.mkdirSync(path.join(base, 'userdata'));
fs.writeFileSync(path.join(base, 'userdata', 'settings.json'), JSON.stringify({ onboarded: true, wander: false, xp: { byDevice: { legacy: 2750 } } }));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: path.join(base, 'userdata'), CLAUDE_CONFIG_DIR: claudeConfig,
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47997', SHELLBY_MOTION_TEST: '1',
    },
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
      // A guarded screenshot: an unpainted window can hang captureScreenshot for minutes.
      const shot = async name => {
        const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), wait(10000).then(() => null)]);
        if (r?.data) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
        return !!r?.data;
      };
      return { send, ev, shot };
    };
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const until = async (c, expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    const task = async text => {
      await panel.ev(`SB.send(${JSON.stringify(text)})`);
      await until(panel, '!SB.activeTab().busy', 20000);
      await wait(1500); // the turn's diff and the last run's snapshot come after the result
    };

    await wait(3000);
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    // A mic held by another app reads as a call, which hushes him: pin it off.
    await panel.ev("shellby.dev.life({ what: 'call', on: false })");
    await panel.ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);
    // Everything he says, and every surprise shown, whatever replaces it.
    await critter.ev(`window.__said = []; window.__badges = [];
      const bt = document.getElementById('bubbleText');
      new MutationObserver(() => window.__said.push(bt.textContent)).observe(bt, { childList: true, characterData: true, subtree: true });
      new MutationObserver(() => { const s = document.querySelector('#surprise span'); if (s) window.__badges.push(s.textContent + '|' + document.body.className); }).observe(document.getElementById('surprise'), { childList: true });
      true`);

    // ---- 1. red, a fix, green, all in one turn: a critical hit (the first always lands)
    await panel.ev('SB.newTab()');
    await panel.ev(`SB.send(${JSON.stringify('crit 3 auth.js fixed')})`);
    check(await until(critter, 'window.__badges.length > 0', 25000), 'the CRIT! badge pops up over him');
    await wait(250);
    await critter.shot('crit-badge');
    const badge = await critter.ev('window.__badges[0]');
    check(/^CRIT!\|/.test(badge || ''), `it says CRIT! (${badge})`);
    check(/surprise-crit/.test(badge || ''), 'and he jumps for it');
    check(/crit/i.test(await critter.ev('window.__said.join(" | ")')), `he says so (${await critter.ev('window.__said.slice(-2).join(" | ")')})`);
    await until(panel, '!SB.activeTab().busy', 15000);
    // The first crit is also a hidden trophy; its card (and a first task's) sit over the chat.
    let trophy = false;
    for (let i = 0; i < 12 && await until(panel, "!!document.querySelector('.cel-close')", 1500); i++) {
      if (/Critical Hit/.test(await panel.ev("document.querySelector('.celebrate')?.textContent || ''"))) { trophy = /Lucky D20/.test(await panel.ev("document.querySelector('.celebrate').textContent")); await panel.shot('trophy'); }
      await panel.ev("document.querySelector('.cel-close').click()");
      await wait(300);
    }
    check(trophy, 'the first crit unlocks the Critical Hit trophy and its Lucky D20');
    check(await until(panel, "!!document.querySelector('.surprise-mark.crit')"), 'the conversation keeps a note of it');
    check(/3 failing tests to green/.test(await panel.ev("document.querySelector('.surprise-mark.crit')?.textContent || ''")), 'saying what it was');
    await panel.shot('crit-note');
    const xp = await panel.ev('shellby.getXp().then(v => (v.log || []).map(e => e.kind))').catch(() => null);
    check(Array.isArray(xp) ? xp.includes('crit') : true, `XP pays for it (${JSON.stringify(xp)})`);
    check(await until(critter, '!document.querySelector("#surprise span")', 4000), 'and the badge goes away by itself');

    // ---- 2. another straight after: held back by the cooldown
    await panel.ev('SB.newTab()');
    await task('crit 2 auth.js fixed again');
    await wait(1500);
    check(await critter.ev('window.__badges.length') === 1, 'a second one straight after is held back');

    // ---- 3. switched off: nothing, even for the real thing
    await panel.ev("shellby.setSettings({ surprises: false }).then(r => { SB.state.settings = r.settings; })");
    await panel.ev('SB.newTab()');
    await task('crit 4 auth.js and again');
    await wait(1500);
    check(await critter.ev('window.__badges.length') === 1, 'switched off in Settings, there are none');
    await panel.ev("SB.setView('settings')");
    check(await until(panel, "document.getElementById('surprisesToggle').checked === false", 3000), 'and the toggle says so');
    await panel.ev("document.getElementById('surprisesToggle').scrollIntoView({ block: 'center' })");
    await wait(300);
    await panel.shot('setting');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(`screenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
