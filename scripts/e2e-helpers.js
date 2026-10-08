// ci: a project's Helpers and the port doctor: before-start notes, a taken port moved, bisect, docs and the tour waiting unsent
// End-to-end check of a project page's helpers and the port doctor, against
// the dev app over CDP with the fake Claude CLI (throwaway profile and repo,
// no account, no network):
//   - Before you start: a setting .env.example has and no .env does, Make
//     .env from the example, and a Node version the project doesn't fit
//   - a dev server whose port this script holds: it crashes, the card names
//     who has the port, Use :N instead brings it up there, and the port is
//     remembered until Use its usual port
//   - Helpers: Show me around opens a tab in Ask first with the tour in the box
//     (nothing sent), When did this break? checks what it's given and opens a
//     copy with the bisect prompt waiting, Check the docs the same, and Make it
//     automatic… opens the routine editor without saving anything
//   node scripts/e2e-helpers.js [screenshot-folder]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9399;
const wait = ms => new Promise(r => setTimeout(r, ms));
const shots = process.argv[2] || null;

async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    p.get(m.id)?.(m);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send('Runtime.enable');
  return { ws, send, ev, errors };
}

// A port nobody has, then held by this script (every address, as a server would take it).
function holdPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => resolve(srv));
  });
}

// A repository with a dev server that listens on PORT (or the port this
// script holds), a tag to bisect from, an example env and an .nvmrc no PC has.
function makeRepo(held) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-helpers-')));
  const repo = path.join(base, 'tidepool');
  fs.mkdirSync(repo);
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  g('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) g('config', k, v);
  fs.writeFileSync(path.join(repo, 'server.js'), [
    "const http = require('http');",
    `const port = Number(process.env.PORT) || ${held};`,
    "http.createServer((q, s) => s.end('ok')).listen(port, () => console.log(`listening on http://localhost:${port}/`));",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'tidepool', private: true, scripts: { dev: 'node server.js' } }, null, 2));
  fs.writeFileSync(path.join(repo, '.env.example'), 'SHELLBY_E2E_ONLY_KEY=\n');
  fs.writeFileSync(path.join(repo, '.nvmrc'), '99\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n.env\n');
  g('add', '-A');
  g('commit', '-qm', 'first');
  g('tag', 'v1.0.0');
  fs.writeFileSync(path.join(repo, 'README.md'), '# tidepool\n\nRun `npm run dev`.\n');
  g('add', '-A');
  g('commit', '-qm', 'readme');
  fs.mkdirSync(path.join(repo, 'node_modules'));
  return { base, repo, g };
}

(async () => {
  const held = await holdPort();
  const heldPort = held.address().port;
  const r = makeRepo(heldPort);
  const claudeConfig = path.join(r.base, 'claude');
  fs.mkdirSync(claudeConfig);
  const profile = path.join(r.base, 'userdata');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: false, wander: false, projects: { added: [r.repo] } }));

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile, CLAUDE_CONFIG_DIR: claudeConfig, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47996' },
  });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  let panel = null;
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    panel = await cdp(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const { ev } = panel;
    const until = async (expr, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await ev(expr); if (v || Date.now() > end) return v; await wait(200); } };
    const shot = async (name, sel = null) => {
      if (!shots) return;
      if (sel) { await ev(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'start' })`); await wait(300); }
      fs.mkdirSync(shots, { recursive: true });
      const s = await panel.send('Page.captureScreenshot', { format: 'png' });
      if (s?.data) fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(s.data, 'base64'));
    };
    const click = async (scope, text) => ev(`(b => { if (b) b.click(); return !!b; })([...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.textContent === ${JSON.stringify(text)}))`);
    await wait(2500);
    await until("!!SB.state.claude?.loggedIn || !!SB.state.claudeStatus?.loggedIn", 8000);

    // ---- the project's page
    await ev("SB.setView('projects')");
    check(await until("[...document.querySelectorAll('#pjProjects .pj-row')].some(b => b.textContent.includes('tidepool'))", 20000), 'the repo is on the Projects page');
    await ev("[...document.querySelectorAll('#pjProjects .pj-row')].find(b => b.textContent.includes('tidepool')).click()");
    check(await until("!!document.querySelector('#pjDetailScreen .pj-script')"), 'its page lists the dev script');

    // ---- before you start
    const doctorText = "document.querySelector('#pjDetailScreen .pj-doctor')?.textContent || ''";
    check(await until(`/There's a \\.env\\.example but no \\.env/.test(${doctorText})`), 'Before you start: an example env with no .env');
    check(/wants Node 99 \(\.nvmrc\)/.test(await ev(doctorText)), `and the Node version it wants (${await ev(doctorText)})`);
    check(!/SHELLBY_E2E_ONLY_KEY=/.test(await ev(doctorText)), 'names only, never a value');
    await shot('before-you-start', '#pjDetailScreen .pj-servers');
    check(await click('#pjDetailScreen .pj-doctor button', 'Make .env from .env.example'), 'Make .env from the example is offered');
    check(await until(`!/no \\.env/.test(${doctorText})`, 8000) && fs.existsSync(path.join(r.repo, '.env')), 'and makes it');
    check(fs.readFileSync(path.join(r.repo, '.env'), 'utf8') === 'SHELLBY_E2E_ONLY_KEY=\n', 'as a copy of the example');

    // ---- the port is taken
    await ev("[...document.querySelectorAll('#pjDetailScreen .pj-script button')].find(b => b.textContent === 'Start').click()");
    check(await until("!!document.querySelector('#pjDetailScreen .pj-card.crashed')", 30000), `the server crashes: :${heldPort} is held`);
    const portText = "document.querySelector('#pjDetailScreen .pj-port')?.textContent || ''";
    check(await until(`/Port ${heldPort} was already taken, by node\\.exe \\(process ${process.pid}\\)/.test(${portText})`, 15000), `the card names who has the port (${await ev(portText)})`);
    const useBtn = "[...document.querySelectorAll('#pjDetailScreen .pj-port button')].find(b => /^Use :\\d+ instead$/.test(b.textContent))";
    const offered = Number((await ev(`${useBtn}?.textContent`) || '').replace(/\D/g, ''));
    check(offered > heldPort, `a free port is offered (:${offered})`);
    check(await ev(`[...document.querySelectorAll('#pjDetailScreen .pj-port button')].some(b => b.textContent === 'Stop node.exe')`), 'and Stop node.exe');
    check((await ev("shellby.serverUsePort({ id: 'srv-aaaaaaaa', port: 1 })"))?.ok === false, 'a port the card never offered is refused');
    await shot('port-taken', '#pjDetailScreen .pj-card');
    await ev(`${useBtn}.click()`);
    check(await until(`document.querySelector('#pjDetailScreen .pj-card.up .pj-status')?.textContent.includes(':${offered}')`, 30000), `it comes up on :${offered}`);
    check(/Shellby moved it to :\d+/.test(await ev("document.querySelector('#pjDetailScreen .pj-moved')?.textContent || ''")), 'the card says Shellby moved it');
    check(/node server\.js|npm run dev/.test(await ev("document.querySelector('#pjDetailScreen .pj-card code')?.textContent || ''")), 'the card still names the script');
    const settings = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    check(Object.values(settings.devServers?.ports || {}).includes(offered), 'the port is remembered for the script');
    await ev("[...document.querySelectorAll('#pjDetailScreen .pj-card button')].find(b => b.textContent === 'Stop').click()");
    check(await until("!document.querySelector('#pjDetailScreen .pj-card')", 10000), 'Stop ends it');

    // ---- Helpers: Show me around
    check(await until("!!document.querySelector('#pjDetailScreen .pt-card')"), 'the page has a Helpers card');
    await shot('helpers', '#pjDetailScreen .pt-card');
    const tabsBefore = await ev('SB.state.tabs.size');
    await click('#pjDetailScreen .pt-card button', 'Show me around');
    check(await until("SB.state.view === 'chat' && /^Show me around tidepool/.test(document.getElementById('input').value)", 10000), 'Show me around puts the tour in the box');
    const tour = await ev('(t => ({ title: t.title, cwd: t.cwd, busy: !!t.busy }))(SB.activeTab())');
    check(tour?.title === 'Tour of tidepool' && path.resolve(tour.cwd || '') === path.resolve(r.repo), `in the project itself (${JSON.stringify(tour)})`);
    check(!tour?.busy && await ev('SB.state.tabs.size') === tabsBefore + 1, 'and nothing has been sent');
    const chip = await ev("document.getElementById('modeChip')?.textContent || ''");
    check(/Ask/.test(chip), `in Ask first (${chip})`);

    // ---- When did this break?
    await ev("SB.setView('projects')");
    await until("!!document.querySelector('#pjDetailScreen .pt-card')");
    await click('#pjDetailScreen .pt-card button', 'Find it…');
    check(await until("[...document.querySelectorAll('#pjDetailScreen .pt-form option')].some(o => o.value === 'v1.0.0')"), 'the form offers the project\'s tags');
    check(await ev("[...document.querySelectorAll('#pjDetailScreen .pt-form button')].find(b => b.textContent === 'Write the prompt').disabled"), 'and waits for what broke');
    const root = JSON.stringify(r.repo);
    check((await ev(`shellby.startBisect({ root: ${root}, what: 'x', good: '--exec=x' })`))?.ok === false, 'an option for a ref is refused');
    check(/There's no v9/.test((await ev(`shellby.startBisect({ root: ${root}, what: 'x', good: 'v9' })`))?.error || ''), 'and a ref the repo hasn\'t got');
    check((await ev(`shellby.startBisect({ root: 'C:\\\\Windows', what: 'x' })`))?.ok === false, 'and a folder the page never listed');
    await ev("(el => { el.value = 'The README lost its run command'; el.dispatchEvent(new Event('input')); })(document.querySelector('#pjDetailScreen .pt-what'))");
    await ev("(el => { el.value = 'v1.0.0'; el.dispatchEvent(new Event('change')); })(document.querySelector('#pjDetailScreen .pt-form select'))");
    await click('#pjDetailScreen .pt-form button', 'Write the prompt');
    check(await until("SB.state.view === 'chat' && /git bisect/.test(document.getElementById('input').value)", 30000), 'the bisect prompt waits in the box');
    const bisect = await ev("({ text: document.getElementById('input').value, cwd: SB.activeTab().cwd, busy: !!SB.activeTab().busy })");
    check(/The README lost its run command/.test(bisect.text) && /`v1\.0\.0`/.test(bisect.text), 'with what broke and the last good version');
    check(path.resolve(bisect.cwd || '') !== path.resolve(r.repo) && !bisect.busy, `in a copy, unsent (${bisect.cwd})`);
    check(r.g('status', '--porcelain') === '' && r.g('rev-parse', '--abbrev-ref', 'HEAD') === 'main', 'your checkout is left as it was');

    // ---- Check the docs, and Make it automatic…
    await ev("SB.setView('projects')");
    await until("!!document.querySelector('#pjDetailScreen .pt-card')");
    await click('#pjDetailScreen .pt-card button', 'Check the docs');
    check(await until("SB.state.view === 'chat' && /Check that the documentation in tidepool/.test(document.getElementById('input').value)", 30000),
      `Check the docs waits in the box too (${(await ev("SB.state.view + ': ' + document.getElementById('input').value.slice(0, 80)"))})`);
    check(!(await ev('SB.activeTab().busy')), 'unsent');
    const routinesBefore = (await ev('shellby.listRoutines()'))?.length ?? 0;
    await ev("SB.setView('projects')");
    await until("!!document.querySelector('#pjDetailScreen .pt-card')");
    await click('#pjDetailScreen .pt-card button', 'Make it automatic…');
    check(await until("SB.state.view === 'routines' && !document.getElementById('routineWork').hidden", 8000), 'Make it automatic… opens the routine editor');
    const form = await ev("(f => ({ name: f.elements.name.value, mode: f.elements.mode.value, prompt: f.elements.prompt.value }))(document.getElementById('routineEditor'))");
    check(form?.name === 'Docs check: tidepool' && form.mode === 'ask' && /Report only/.test(form.prompt), `filled in, Ask first, report only (${JSON.stringify(form)})`);
    check(/uses your Claude usage each time/.test(await ev("document.getElementById('routineTplNote').textContent")), 'and says what it costs once saved');
    const routinesAfter = (await ev('shellby.listRoutines()'))?.length ?? 0;
    check(routinesAfter === routinesBefore, 'nothing is saved until you press Save');
    await shot('routine');

    // Nothing in the new parts of the page is a stray word from a false or a null.
    await ev("SB.setView('projects')");
    await until("!!document.querySelector('#pjDetailScreen .pt-card')");
    const page = await ev("[...document.querySelectorAll('#pjDetailScreen .pt-card, #pjDetailScreen .pj-servers')].map(e => e.textContent).join(' ')");
    const stray = /.{0,40}\b(?:false|null|undefined)\b.{0,20}/.exec(page);
    check(!stray, `no stray false or null on the page${stray ? ` (…${stray[0]}…)` : ''}`);

    check(panel.errors.length === 0, `no uncaught errors in the panel${panel.errors.length ? `: ${panel.errors.join(' | ')}` : ''}`);
  } catch (e) {
    console.log(`FAIL  ${e.stack || e.message}`);
    fails++;
  } finally {
    // The dev server outlives Shellby: make sure it's gone.
    try { await panel?.ev('shellby.stopAllServers()'); } catch { /* closing */ }
    panel?.ws.close();
    app.kill();
    held.close();
    await wait(1500);
    try { execFileSync('git', ['-C', r.repo, 'worktree', 'prune'], { windowsHide: true }); } catch { /* gone */ }
    try { fs.rmSync(r.base, { recursive: true, force: true }); } catch { /* still held */ }
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
