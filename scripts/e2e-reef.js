// ci: reef and review mastery: watch a reef, a new best, coral in the tank, the review ladder
// End-to-end check of reef health (docs/REEF.md) and the review mastery card
// against the dev app over CDP with the fake CLI (isolated profile): a project
// on the Projects page offers "Watch this reef", watching it reads the first
// escape-hatch count from git, a better reading (the test-only dev-reading
// action) is a new best with a polyp, its coral is in the tank's tray and on
// the Tank page, and Trophies shows the review tier ladder. No Claude account,
// no usage, and nothing in the project is run.
//   node scripts/e2e-reef.js [screenshotDir]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { projectId } = require('../src/main/stickers');
const { SIGNAL_IDS } = require('../src/main/reef/signals');
const { TIERS } = require('../src/main/review-mastery');

const ROOT = path.join(__dirname, '..');
const PORT = 9447;
const HOOK = 47947;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-reef-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, shot: name => savePng(send, path.join(OUT, `${name}.png`)) };
}

// A small repo of its own, with two escape hatches committed. Long path, as git reports it (CI has 8.3 temp names).
function makeRepo() {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-reef-repo-')));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=e2e@shellby.test', '-c', 'user.name=e2e', ...args], { windowsHide: true, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'app.ts'), '// @ts-ignore\nconst a: any = 1;\nexport const b = 2;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  return repo;
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const repo = makeRepo();
  const id = projectId(null, repo);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, projects: { added: [repo] } }));

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_E2E: '1', SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK) },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await panel.ev(expr)) return true; await wait(150); } return false; };
    const text = sel => panel.ev(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`);
    await until('!!window.SB?.pj && !!SB.reef');
    await panel.ev("window.__toasts = []; const t = SB.toast; SB.toast = (m, o) => { window.__toasts.push(String(m)); return t(m, o); }; true");

    // 1. The project's page offers to watch its reef; nothing is read before you do.
    await panel.ev("SB.setView('projects')");
    const repoJs = JSON.stringify(repo.toLowerCase());
    check(await until(`(SB.pj.data()?.projects || []).some(p => p.local.some(c => c.root.toLowerCase() === ${repoJs}))`, 15000), 'the repo is on the Projects page');
    await panel.ev(`SB.pj.openProject(SB.pj.data().projects.find(p => p.local.some(c => c.root.toLowerCase() === ${repoJs})).key)`);
    check(await until("!document.getElementById('reefCard').hidden"), 'the Reef card is on the project page');
    check(/Watch this reef/.test(await text('#reefActions')), 'it offers Watch this reef');
    check(/never runs your code/.test(await text('.reef-privacy')), 'the privacy note says it never runs your code');
    check((await panel.ev("shellby.getGame('reef')")).watching === 0, 'nothing is watched yet');

    // 2. Watching it reads the escape hatches from git: a baseline, no XP.
    await panel.ev("[...document.querySelectorAll('#reefActions button')].find(b => /Watch/.test(b.textContent)).click()");
    check(await until("!!document.querySelector('#reefSignals [data-sig=\"escapes\"]')", 15000), 'the first escape-hatch count is shown');
    const v1 = await panel.ev("shellby.getGame('reef')");
    const p1 = v1.projects.find(p => p.id === id);
    check(!!p1 && p1.on, `the reef is watched under the project's id (${v1.projects.map(p => p.id).join(', ')})`);
    check(p1?.signals.find(s => s.id === 'escapes')?.best === 2, `the baseline is the 2 committed escape hatches (${JSON.stringify(p1?.signals)})`);
    check(p1?.polyps === 0, 'a baseline grows nothing');
    check(p1 && p1.signals.length + p1.waiting.length === SIGNAL_IDS.length, 'every signal is either read or waiting');
    await panel.shot('reef-watched');

    // 3. A better reading is a new best: a polyp, a toast, and the card says so.
    const r = await panel.ev(`shellby.gameAct('reef', 'dev-reading', { id: '${id}', sig: 'escapes', value: 1 })`);
    check(r?.result?.best === true, `one fewer escape hatch is a new best (${JSON.stringify(r?.result)})`);
    check(await until("/1 polyp/.test(document.getElementById('reefStage').textContent)"), `the card counts a polyp ("${await text('#reefStage')}")`);
    check(await until("window.__toasts.some(t => /reached a new best/.test(t))", 4000), 'a toast says it reached a new best');
    const worse = await panel.ev(`shellby.gameAct('reef', 'dev-reading', { id: '${id}', sig: 'escapes', value: 9 })`);
    const p2 = worse.projects.find(p => p.id === id);
    check(worse?.result?.best === false && p2.polyps === 1, 'a worse reading takes nothing away');
    check(/escape hatch/.test(await text('#reefNext')), `the next step names what to do ("${await text('#reefNext')}")`);
    await panel.shot('reef-best');

    // 4. Its coral is in the tank's tray, on the Plants shelf, and on the Tank page.
    const tankView = await panel.ev('shellby.getTank()');
    const coral = tankView.tray.find(e => e.ref === `coral:${id}`);
    check(!!coral && coral.category === 'plant' && coral.max === 1, `the coral is in the tray (${coral && coral.name})`);
    check(!!coral && coral.frames.length === 1, 'it sways (one extra frame)');
    await panel.ev("SB.setView('tank')");
    check(await until(`!!document.querySelector('#reefTankList [data-id="${id}"]')`), 'the Tank page lists the coral');

    // 5. Trophies: the review ladder, every tier from source.
    await panel.ev("SB.setView('trophies')");
    check(await until(`document.querySelectorAll('#rmLadder li').length === ${TIERS.length}`), `the review ladder has ${TIERS.length} tiers`);
    check(/Not ranked yet/.test(await text('#rmTier')), 'a fresh profile is not ranked yet');
    check(/Tide-pool Reader/.test(await text('#rmNext')), 'the next tier is named');
    await panel.ev("document.getElementById('rmCard').scrollIntoView()");
    await panel.shot('review-mastery');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
