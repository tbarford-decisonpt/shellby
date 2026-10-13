// ci: tool panes: a dev server's log beside the chat, the box staying with the conversation, the crash, its x
// A dev server's log in a pane beside the chat (tool-tabs.js, shared/panes.js):
// opened from the server's card on the Project page, it shows what the server
// prints, takes no box and no conversation, shows the crash and the way to its
// card, and its x closes it. The stand-in server (test/fixtures/devservers)
// comes up the way Vite does and dies once a flag file appears.
// No Claude account needed: the fake CLI answers.
//   node scripts/e2e-tool-panes.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9431;
const HOOK_PORT = 48031;
const CDP_TIMEOUT_MS = 30000;
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'devservers', 'server.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
const BOOTED = "performance.getEntriesByName('shellby:panel-ready').length > 0";
const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    p.get(m.id)?.(m);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => { p.delete(i); reject(new Error(`no answer to ${method} in ${CDP_TIMEOUT_MS / 1000} s: ${String(params.expression ?? '').slice(0, 200)}`)); }, CDP_TIMEOUT_MS);
    p.set(i, m => { clearTimeout(timer); p.delete(i); resolve(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const until = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
  await send('Runtime.enable');
  return { ws, ev, until, errors };
}

(async () => {
  let fails = 0;
  const check = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n      ${detail}` : ''}`); if (!ok) fails++; };
  if ((await targets()).length) {
    console.log(`FAIL  port ${PORT} is taken by another app, maybe an Electron a killed run left behind`);
    process.exit(1);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-tool-')));
  const flag = path.join(repo, 'crash.flag');
  fs.copyFileSync(FIXTURE, path.join(repo, 'server.js'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'site', private: true, scripts: { dev: 'node server.js crash.flag' } }, null, 2));
  fs.mkdirSync(path.join(repo, 'node_modules'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: false, projects: { added: [repo] } }));

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK_PORT), SHELLBY_E2E: '1' },
  });
  let panel = null;
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) { list = await targets(); await wait(500); }
    panel = await connect(list.find(t => t.url.endsWith('panel.html')));
    const { ev, until } = panel;
    check(await until(BOOTED, 30000), 'the panel boots');
    // Main starts servers only in folders the Project page has listed.
    await ev("SB.setView('projects')");
    check(await until('!!SB.pj.data()', 30000), 'the project page lists the repo');

    const started = await ev(`SB.api.startServer({ root: ${JSON.stringify(repo)}, script: 'dev' })`);
    const id = started?.server?.id;
    check(!!id, 'the dev server starts', JSON.stringify(started));
    check(await until("(async () => (await SB.api.getServers()).servers.some(s => s.status === 'up'))()", 30000), 'and comes up');

    // From its card, as you would.
    check(await until(`(async () => { await SB.pj.showServer(${JSON.stringify(id)}); return !!document.getElementById('srv-card-${id}'); })()`), 'its card is on the project page');
    await ev(`[...document.getElementById('srv-card-${id}').querySelectorAll('button')].find(b => b.textContent === 'Show beside the chat').click()`);
    const tool = "document.querySelector('.pane.tool')";
    check(await until(`SB.state.view === 'chat' && !!${tool}`), 'Show beside the chat opens its log in a pane of its own');
    check(await ev(`SB.panes.count(SB.state.grid) === 2 && SB.panes.tabIds(SB.state.grid).length === SB.state.tabs.size`), 'and no conversation thinks it is one');
    check(await ev(`${tool}.querySelector('.tool-chip')?.textContent === 'npm run dev'`), "its strip names the server's script", await ev(`${tool}.querySelector('.tool-chip')?.textContent`));
    check(await until(`${tool}.querySelector('.tp-log')?.textContent.includes('ready in')`), 'it shows what the server printed');
    check(await ev(`!${tool}.contains(document.getElementById('composer')) && !${tool}.querySelector('.pane-standin')`), 'the box stays with the conversation, with no stand-in in the tool');
    await ev(`${tool}.querySelector('.tp-log').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    check(await ev(`SB.state.tabs.has(SB.state.activeTab) && !${tool}.contains(document.getElementById('composer'))`), 'clicking into it leaves the box where it was');
    check(await ev(`(() => { const t = SB.state.activeTab; const g = SB.state.grid; return SB.panes.place(g, t, SB.panes.paneWith(g, 'server:${id}').id, 'center') === g; })()`), 'a conversation dropped on it stays where it was');

    fs.writeFileSync(flag, '');
    check(await until("(async () => (await SB.api.getServers()).servers.some(s => s.status === 'crashed'))()", 15000), 'the server crashes');
    check(await until(`${tool}.querySelector('.tp-log')?.textContent.includes('Error: something broke')`), 'the pane shows the error');
    check(await until(`[...${tool}.querySelectorAll('.tp-actions button')].some(b => b.textContent === 'Ask Claude to fix it…')`), 'and offers to take it to Claude, by way of its card');

    await ev(`${tool}.querySelector('.pane-close').click()`);
    check(await until(`!document.querySelector('.pane.tool') && SB.panes.count(SB.state.grid) === 1`), 'its x closes it, back to one pane');
    // Gone some other way (a named layout, a merge): it stops too, nothing left hidden in the page.
    await ev(`SB.tools.openServer(${JSON.stringify(id)})`);
    check(await until(`!!${tool}`), 'it opens again');
    await ev(`(() => { SB.state.grid = SB.panes.leave(SB.state.grid, 'server:${id}'); SB.renderPanes(); SB.renderTabStrip(); })()`);
    check(await until(`!document.querySelector('[data-tool]')`), 'taken out of the grid by another way, its element goes with it');
    check(panel.errors.length === 0, 'no uncaught errors in the panel', panel.errors.join('\n'));
  } catch (e) {
    check(false, `the run itself: ${e.stack || e}`);
  } finally {
    try { await panel?.ev('SB.api.stopAllServers()'); } catch { /* app gone */ }
    panel?.ws.close();
    app.kill();
    await wait(800);
    for (const d of [profile, repo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still held */ } }
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
