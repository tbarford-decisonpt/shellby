// ci: Settings' five tabs: what's on each, the arrow keys, jumps by name, links between them
// End-to-end check of the Settings tabs against the dev app over CDP: each tab
// shows only its own sections, the arrow keys walk them, jumps by name (the tray,
// the palette) land on the right tab, and just-the-crab starts on Shellby.
//   node scripts/e2e-settings-tabs.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9351;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-settings-tabs-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

function newProfile(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: true, notifications: false, ...extra }));
  return dir;
}

async function launch(profile) {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`],
    { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile } });
  let list = [];
  for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
    await wait(500);
  }
  const ws = new WebSocket(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
  // A call that never answers fails by name instead of running into e2e-ci's five-minute limit.
  const send = (method, params = {}, ms = 30000) => new Promise((r, reject) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); reject(new Error(`${method} got no answer in ${ms / 1000}s`)); }, ms);
    pending.set(i, m => { clearTimeout(t); pending.delete(i); r(m.result); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { app, send, ev };
}

const TABS = {
  shellby: ['Look', 'Moving around', 'Personality', 'Sound', 'Games', 'Mischief'],
  around: ['Music', 'Typing along', 'Weather', 'Desk lighting', 'Discord', 'On a stream', 'Stream Deck'],
  claude: ['Claude Code', 'Mode', 'Model', 'Usage limit', 'Folder', 'Copies', 'Checks', 'Dev servers', 'Editor', 'Everywhere'],
  connect: ['Elsewhere', 'GitHub', 'GitLab', 'Other computers'],
  general: ['System', 'Notifications', 'Shortcut', 'What you use', 'About'],
};

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  // Screenshots are for a person to look at, not something checked, so one that
  // doesn't come (a hidden or unpainted window on a CI runner) is noted and skipped.
  const shot = async (panel, name) => {
    try {
      const s = await panel.send('Page.captureScreenshot', { format: 'png' }, 10000);
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64'));
    } catch (e) {
      console.log(`(no screenshot for ${name}: ${e.message})`);
    }
  };
  const selected = panel => panel.ev("document.querySelector('#settingsTabs [aria-selected=\"true\"]')?.dataset.tab");
  const shown = panel => panel.ev(`[...document.querySelectorAll('#settingsView .setting-group[data-nav]')]
    .filter(g => g.offsetParent !== null).map(g => g.dataset.nav)`);

  // ---- with Claude
  let run = await launch(newProfile({ crabOnly: false }));
  try {
    const panel = run;
    await wait(2500);
    await panel.ev("SB.setView('settings')");
    await wait(500);
    check(await selected(panel) === 'claude', 'Settings opens on the Claude tab');
    check(await panel.ev("document.querySelectorAll('#modelSelect optgroup').length >= 2 && document.getElementById('modelSelect').offsetParent !== null"),
      'the model picker on the Claude tab lists the models by family');

    for (const [tab, navs] of Object.entries(TABS)) {
      await panel.ev(`document.getElementById('setTab-${tab}').click()`);
      await wait(300);
      const got = await shown(panel);
      check(JSON.stringify(got) === JSON.stringify(navs), `the ${tab} tab shows ${navs.join(', ')} (got ${JSON.stringify(got)})`);
      await shot(panel, `tab-${tab}`);
    }
    // the extras start folded to one line that says whether each is on
    await panel.ev("document.getElementById('setTab-around').click()");
    await wait(200);
    check(await panel.ev("[...document.querySelectorAll('#settingsView .setting-fold')].every(f => !f.open)"), 'the extras start folded');
    check(await panel.ev("document.querySelector('#musicGroup .fold-state').textContent") === 'Off', 'a folded extra says Off');
    await panel.ev("document.getElementById('npEnabled').click()");
    await wait(600);
    check(await panel.ev("document.querySelector('#musicGroup .fold-state').textContent") === 'On', 'and On once it is turned on');
    await panel.ev("document.getElementById('npEnabled').click()");
    await wait(300);
    const all = Object.values(TABS).flat();
    const every = await panel.ev("[...document.querySelectorAll('#settingsView .setting-group[data-nav]')].map(g => g.dataset.nav)");
    check(every.length === all.length && all.every(n => every.includes(n)), 'every section lives on exactly one tab');

    // keyboard: from General, Right wraps to Shellby, End goes to General
    await panel.ev("document.getElementById('setTab-general').focus()");
    await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await wait(200);
    check(await selected(panel) === 'shellby', 'ArrowRight wraps from the last tab to the first');
    check(await panel.ev("document.activeElement.id") === 'setTab-shellby', 'and focus moves with it');
    await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await wait(200);
    check(await selected(panel) === 'general', 'End goes to the last tab');

    // leaving and coming back keeps the tab
    await panel.ev("SB.setView('health'); SB.setView('settings')");
    await wait(300);
    check(await selected(panel) === 'general', 'Settings reopens on the last tab you looked at');

    // a jump by name (the tray's update item) switches tab and scrolls there
    await panel.ev("document.getElementById('setTab-shellby').click(); SB.setView('chat'); SB.jumpToSettingByName('GitHub')");
    await wait(1200);
    check(await selected(panel) === 'connect', 'jumping to GitHub opens the Connections tab');
    check(await panel.ev(`(() => {
      const r = document.getElementById('githubGroup').getBoundingClientRect();
      const v = document.getElementById('settingsView').getBoundingClientRect();
      return r.top >= v.top - 1 && r.top < v.bottom;
    })()`), 'and GitHub is on screen');

    // the palette still finds every section, wherever it lives
    const pal = await panel.ev("(SB.openPalette(), [...document.querySelectorAll('#paletteList .pal-title')].map(e => e.textContent))");
    check(all.every(n => pal.includes(`Settings › ${n}`)), 'Ctrl+K lists every section, not just the open tab');
    await panel.ev("const i = document.getElementById('paletteInput'); i.value = 'desk lighting'; i.dispatchEvent(new Event('input'))");
    await wait(100);
    await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wait(1000);
    check(await selected(panel) === 'around', 'picking Desk lighting in the palette opens the Around you tab');
    check(await panel.ev("document.getElementById('rgbGroup').open"), 'and unfolds Desk lighting');
    await shot(panel, 'jump-desk-lighting');

    // the highlight sits under the chosen tab, and every tab's name fits
    check(await panel.ev(`(() => {
      const bar = document.getElementById('settingsTabs');
      const b = bar.querySelector('[aria-selected="true"]');
      const near = (v, want) => Math.abs(parseFloat(bar.style.getPropertyValue(v)) - want) < 1;
      return bar.classList.contains('has-ink') && near('--ink-x', b.offsetLeft) && near('--ink-w', b.offsetWidth);
    })()`), 'the highlight sits under the chosen tab');
    check(await panel.ev("[...document.querySelectorAll('#settingsTabs [role=tab]')].every(b => b.scrollWidth <= b.clientWidth + 1)"), 'every tab name fits without clipping');

    // a setting that talks about one on another tab links straight to it
    check(await panel.ev("[...document.querySelectorAll('#settingsView [data-jump-setting]')].every(a => document.getElementById(a.dataset.jumpSetting))"),
      'every link between settings points at one that exists');
    await panel.ev("document.getElementById('setTab-general').click(); document.querySelector('#notifyGroup [data-jump-setting]').click()");
    // It focuses the setting on the next frame, which a busy desktop can hold back past a fixed wait.
    let landed = false;
    for (let i = 0; i < 30 && !landed; i++) {
      await wait(100);
      landed = await selected(panel) === 'connect' && await panel.ev('document.activeElement.id') === 'chEnabled';
    }
    check(landed, "Notifications' phone link opens Tell me when I'm away on Connections");

    // the autonomous-mode warning lives on the Claude tab
    await panel.ev("document.getElementById('setTab-general').click(); SB.chooseMode('autonomous')");
    await wait(600);
    check(await selected(panel) === 'claude' && await panel.ev("document.getElementById('autonomousConfirm').offsetParent !== null"),
      'asking for Autonomous shows its warning on the Claude tab');
    await panel.ev("document.getElementById('autonomousNo').click()");

    // update news reaches the General tab too
    await panel.ev("SB.state.updates = { state: 'ready', version: '99.0.0' }; SB.views.settings.render()");
    await wait(200);
    check(await panel.ev("!document.getElementById('updateTabDot').hidden"), 'a ready update puts a dot on the General tab');
    await panel.ev("document.getElementById('setTab-general').click()");
    await wait(200);
    await shot(panel, 'update-dot');
  } catch (e) {
    check(false, e.message);
  } finally {
    run.app.kill();
    await wait(1500);
  }

  // ---- just the crab
  run = await launch(newProfile({ crabOnly: true }));
  try {
    await wait(2500);
    await run.ev("SB.setView('settings')");
    await wait(400);
    check(await selected(run) === 'shellby', 'just-the-crab opens Settings on the Shellby tab');
  } catch (e) {
    check(false, e.message);
  } finally {
    run.app.kill();
  }

  console.log(`\nscreenshots in ${OUT}`);
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
