// End-to-end check of team packs against the dev app over CDP, in a throwaway
// profile and throwaway repos: opening a repo with a .shellby/team.json says so,
// Toolbox → Team lists it, "Use these snippets" makes /ship work there (and only
// there), and Make a team pack writes the file in a repo that has none.
//   node scripts/e2e-team.js [screenshot.png]
// SHELLBY_ELECTRON points at an electron.exe when this checkout has none (a worktree).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9361;
const HOOK = 47999;
const wait = ms => new Promise(r => setTimeout(r, ms));

function repo(base, name, pack) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (pack) {
    fs.mkdirSync(path.join(dir, '.shellby'));
    fs.writeFileSync(path.join(dir, '.shellby', 'team.json'), JSON.stringify({ kind: 'shellby-team-pack', version: 1, ...pack }, null, 2));
  }
  return dir;
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-repos-'));
  const acme = repo(work, 'acme', {
    name: 'Acme web', about: 'How we work on the web app',
    snippets: [{ name: 'ship', text: 'Get $ARGUMENTS ready to merge and write the PR description.', hint: 'a branch' }],
    workflows: [{ name: 'Check before a release', cwd: '{repo}', steps: [{ id: 'test', type: 'run', command: 'npm test' }] }],
    hooks: [{ event: 'Stop', command: "bash -c 'echo done'", about: 'Says when Claude is done' }],
    rules: [{ list: 'deny', rule: 'Bash(git push --force:*)' }],
  });
  const other = repo(work, 'other', null);
  const exe = process.env.SHELLBY_ELECTRON || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(exe, [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK), SHELLBY_FAKE_HEALTH: 'calm' },
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
    const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await ev(expr); if (v) return v; await wait(150); } return ev(expr); };
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");

    // 1. Opening a repo with a pack says so, once.
    await ev(`shellby.setFolder(${JSON.stringify(acme)})`);
    const toast = await until("!document.getElementById('toast').hidden && document.getElementById('toast').textContent.includes('team pack') && document.getElementById('toast').textContent");
    check(/Acme web \(acme\) has a team pack: a snippet, a workflow, a hook and a rule/.test(toast || ''), `notice when the repo opens ("${toast}")`);

    // 2. Toolbox → Team lists it, with the snippets off.
    await ev("SB.showToolbox('team')");
    const listed = await until("document.getElementById('setupPane').textContent.includes('Use these snippets') && document.getElementById('setupPane').textContent");
    check(/Acme web/.test(listed || '') && /\/ship/.test(listed) && /Check before a release/.test(listed) && /Says when Claude is done/.test(listed) && /git push --force/.test(listed), 'Team tab lists every part of the pack');
    check(await ev("document.querySelector('#toolGroups [data-group=team] .n').textContent") === '4', 'the Team tab counts the 4 things waiting');
    check(!(await ev("(SB.state.snippets || []).some(s => s.name === 'ship')")), '/ship is off before you say yes');
    check((await ev("shellby.expandSnippet('/ship main')")) === null, '/ship is not a snippet yet');

    // 3. Use these snippets: /ship works in this repo.
    await ev("[...document.querySelectorAll('#setupPane button')].find(b => b.textContent === 'Use these snippets').click()");
    check(await until("(SB.state.snippets || []).some(s => s.name === 'ship' && s.team)"), '/ship shows up as a team snippet');
    const x = await ev("shellby.expandSnippet('/ship main')");
    check(x?.ok && x.prompt === 'Get main ready to merge and write the PR description.', `/ship main expands ("${x?.prompt}")`);
    check(await until("document.getElementById('setupPane').textContent.includes('On in this repo')"), 'the Team tab says they are on');
    if (process.argv[2]) fs.writeFileSync(process.argv[2], Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

    // 4. Another repo: no team snippets there, and Make a team pack writes one.
    await ev(`shellby.setFolder(${JSON.stringify(other)})`);
    check(await until("!(SB.state.snippets || []).some(s => s.name === 'ship')"), '/ship is gone in a repo without the pack');
    await ev("SB.showToolbox('team')");
    check(await until("document.getElementById('setupPane').textContent.includes('Make a team pack')"), 'a repo without a pack offers to make one');
    const w = await ev("shellby.writeTeamPack({ name: 'Other', snippets: ['review'] })");
    const file = path.join(other, '.shellby', 'team.json');
    const written = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    check(w?.ok && written?.kind === 'shellby-team-pack' && written.snippets[0].name === 'review', `Make a team pack wrote .shellby/team.json (${w?.error || 'ok'})`);
  } catch (e) {
    console.log(`FAIL  ${e.stack || e.message}`);
    fails++;
  } finally {
    // The whole tree: Electron leaves GPU and utility processes behind otherwise.
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    await wait(500);
    for (const d of [profile, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still locked */ } }
  }
  console.log(fails ? `\n${fails} failed` : '\nAll passed');
  process.exit(fails ? 1 : 0);
})();
