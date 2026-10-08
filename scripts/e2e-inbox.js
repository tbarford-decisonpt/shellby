// ci: the Projects inbox: stale branches in a throwaway repo, Delete a merged one, Keep the other
// End-to-end check of the Projects inbox against the dev app over CDP
// (throwaway profile, no GitHub). A real repository with a remote, a merged
// branch and an old one with a commit nowhere else is added to the list; then:
// the inbox lists both under Stale branches, Delete takes the merged one at
// once, Keep files the other away, its "What's on it?" is offered, the
// pull-request half says how to turn it on, and nothing throws.
//   node scripts/e2e-inbox.js [screenshot.png]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9367;
const DAY = 24 * 60 * 60 * 1000;
const wait = ms => new Promise(r => setTimeout(r, ms));

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

function makeRepo() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-inbox-')));
  const repo = path.join(base, 'reef');
  const origin = path.join(base, 'origin.git');
  fs.mkdirSync(repo);
  const g = (args, env = {}) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, env: { ...process.env, ...env } });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
  g(['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) g(['config', k, v]);
  const commit = (file, daysAgo) => {
    fs.writeFileSync(path.join(repo, file), `${file}\n`);
    g(['add', '-A']);
    const when = new Date(Date.now() - daysAgo * DAY).toISOString();
    g(['commit', '-qm', file], { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when });
  };
  commit('a.txt', 60);
  g(['remote', 'add', 'origin', origin]);
  g(['push', '-q', '-u', 'origin', 'main']);
  g(['checkout', '-q', '-b', 'old-feature']);
  commit('f.txt', 40);
  g(['checkout', '-q', 'main']);
  g(['merge', '-q', '--ff-only', 'old-feature']);
  g(['push', '-q', 'origin', 'main']);
  g(['checkout', '-q', '-b', 'forgotten-idea']);
  commit('idea.txt', 30);
  g(['checkout', '-q', 'main']);
  const branches = () => String(g(['branch', '--format=%(refname:short)'])).trim().split('\n').sort();
  return { base, repo, branches };
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const r = makeRepo();
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: false, projects: { added: [r.repo] } }));

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`],
    { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile } });
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
    await wait(2500);

    await ev("SB.setView('projects')");
    const rowsOf = "[...document.querySelectorAll('#pjInbox .pj-inbox-group[aria-label=\"Stale branches\"] .pj-h-row')]";
    const names = `${rowsOf}.map(li => li.querySelector('b').textContent)`;
    check(await until(`${rowsOf}.length === 2`, 20000), 'the inbox lists both stale branches');
    check(JSON.stringify(await ev(names)) === JSON.stringify(['old-feature', 'forgotten-idea']), `merged first (${await ev(names)})`);
    check(await ev(`${rowsOf}[0].textContent.includes('merged')`), 'the merged one says so');
    check(await ev(`${rowsOf}[1].textContent.includes('1 commit only here')`), 'the other says what deleting it would lose');
    check(await ev(`[...${rowsOf}[1].querySelectorAll('button')].some(b => b.textContent === "What's on it?")`), "the unmerged one offers What's on it?");
    check(await ev("document.querySelector('#pjInbox .pj-inbox-note')?.textContent.includes('Watch CI on my pull requests')"), 'with no GitHub, it says how to get pull requests here');
    check(await ev("!document.querySelector('#pjInbox .pj-inbox-group[aria-label=\"Waiting on your review\"]')"), 'and lists none');

    if (process.argv[2]) {
      await ev("document.getElementById('pjInbox').scrollIntoView({ block: 'start' })");
      await wait(300);
      const shot = await panel.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.argv[2], Buffer.from(shot.data, 'base64'));
    }

    // Delete the merged one: no question asked, gone from git and the list.
    await ev(`[...${rowsOf}[0].querySelectorAll('button')].find(b => b.textContent === 'Delete').click()`);
    check(await until(`${rowsOf}.length === 1`), 'Delete takes the merged branch off the list');
    check(JSON.stringify(r.branches()) === JSON.stringify(['forgotten-idea', 'main']), `and out of git (${r.branches()})`);

    // Keep the other: off the list, still in git, and still off after a reload.
    await ev(`[...${rowsOf}[0].querySelectorAll('button')].find(b => b.textContent === 'Keep').click()`);
    check(await until(`${rowsOf}.length === 0`), 'Keep files it away');
    check(r.branches().includes('forgotten-idea'), 'without deleting anything');
    await ev("document.getElementById('pjRefresh').click()");
    await wait(2500);
    check(await ev(`${rowsOf}.length === 0`), 'and it stays away after a refresh');
    check(await until("document.querySelector('#pjInbox .pj-calm')?.textContent.startsWith('Nothing waiting on you')"), 'an empty inbox says so');

    check(panel.errors.length === 0, `no uncaught errors in the panel${panel.errors.length ? `: ${panel.errors.join(' | ')}` : ''}`);
  } catch (e) {
    console.log(`FAIL  ${e.stack || e.message}`);
    fails++;
  } finally {
    panel?.ws.close();
    app.kill();
    await wait(1000);
    for (const dir of [profile, r.base]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still held */ } }
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
