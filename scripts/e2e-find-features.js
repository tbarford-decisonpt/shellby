// ci: finding things: Settings search, what you use
// Finding what's there: the search box on Settings shows every tab at once, cut
// down to the sections and rows that match, opens a fold that matches and
// closes it again, says when nothing matches, and Esc puts the tabs back.
// What you use (Settings → General) counts the screens you go to, on this PC
// only, and suggests the ones you haven't opened. Runs against the fake CLI;
// no account needed.
//   node scripts/e2e-find-features.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9340;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  // Someone who has every screen open (rooms.js), so all of them can be suggested.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, sounds: false, wander: false, rooms: { tasks: 0, open: [], all: true } }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47959' },
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
    const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");

    // ---- Settings search
    await ev("SB.setView('settings')");
    const search = q => ev(`(() => { const b = document.getElementById('settingsSearch'); b.value = ${JSON.stringify(q)}; b.dispatchEvent(new Event('input')); })()`);
    const shown = sel => `[...document.querySelectorAll('#settingsView ${sel}')].filter(e => e.offsetParent !== null)`;
    const visibleNavs = () => ev(`${shown('.setting-group[data-nav]')}.map(g => g.dataset.nav)`);
    const visiblePanels = () => ev(`${shown('.settings-panel')}.map(p => p.dataset.tab)`);
    const line = () => ev("document.getElementById('settingsSearchLine').textContent");

    const before = await visiblePanels();
    check(before.length === 1, 'one tab shows before searching');

    await search('discord');
    const navs = await visibleNavs();
    check(navs.includes('Discord'), 'a search finds the Discord section');
    check(navs.length < 6, `and leaves most sections out (${navs.length} left)`);
    check(await ev("document.querySelector('#settingsView .setting-group[data-nav=\"Discord\"]').open") === true, 'its fold opens');
    check(await ev(`${shown('.settings-tabs')}.length`) === 0, 'the tabs step aside while searching');
    check(/match/.test(await line()), `the line says what matched ("${await line()}")`);

    await search('stroll idle');
    const rows = await ev(`${shown('.setting-group[data-nav="Moving around"] label.toggle')}.map(l => l.textContent.trim())`);
    check(rows.length === 1 && /stroll/.test(rows[0]), 'inside a section, only the row that matches shows');

    await search('zzzz nothing here');
    check((await visibleNavs()).length === 0, 'nothing matches, nothing shows');
    check(/Nothing in Settings matches/.test(await line()), 'and the line says so');

    await ev("document.getElementById('settingsSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    check(await ev("document.getElementById('settingsSearch').value") === '', 'Esc clears the box');
    check((await visiblePanels()).join() === before.join(), 'and the tab you were on comes back');
    check(await ev("document.querySelector('#settingsView .setting-group[data-nav=\"Discord\"]').open") === false, 'the fold the search opened closes again');
    check(await ev(`${shown('.settings-tabs')}.length`) === 1, 'the tabs are back');

    await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true }))");
    check(await ev("document.activeElement.id") === 'settingsSearch', 'Ctrl+F on Settings goes to the search box');
    check(await ev("document.getElementById('findBar')?.hidden ?? true") !== false, "and doesn't open the conversation's find bar");

    // ---- What you use
    for (const v of ['projects', 'chat', 'projects', 'projects', 'tank', 'projects', 'settings']) await ev(`SB.setView('${v}')`);
    await wait(300);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).featureUse;
    check(saved?.views?.projects?.n === 3 && saved.views.tank?.n === 1, `each arrival at a screen is counted, staying put is not (${JSON.stringify(saved?.views)})`);
    check(!saved?.views?.settings, 'Settings itself is not');
    await ev("SB.showSettingsTab('general'); SB.views.settings.render()");
    await wait(600);
    const top = await ev("document.getElementById('usesTop').textContent");
    check(/^Most: Projects 3/.test(top), `What you use leads with the most opened (${top})`);
    const never = await ev("[...document.querySelectorAll('#usesNever .uses-row b')].map(b => b.textContent)");
    check(never.includes('Beach') && never.includes('Health') && !never.includes('Projects') && !never.includes('Tank'), `and lists what you haven't opened (${never.join(', ')})`);
    await ev("[...document.querySelectorAll('#usesNever .uses-row')].find(r => r.querySelector('b').textContent === 'Beach').querySelector('button').click()");
    check(await ev('SB.state.view') === 'beach', 'Take a look goes there');
    check(/never sent anywhere/.test(await ev("document.getElementById('usesLede').textContent")), 'and it says the count stays on this PC');
    const sync = require(path.join(ROOT, 'src', 'main', 'sync-prefs.js'));
    check(!JSON.stringify(Object.keys(sync.PREFS || {})).includes('featureUse'), 'the count is not one of the settings Sync carries');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
