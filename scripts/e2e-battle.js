// Bug battles, end to end against the fake CLI: a red suite opens a battle at
// full HP; a read is a Scout and an edit a Patch; a re-run with fewer failing
// tests takes HP off (super effective: tests against a test bug); a helper
// joins the party; the green run knocks it out and jars it. The chip under the
// tabs and the battle screen show it. No account, no network.
//   node scripts/e2e-battle.js
//   SHELLBY_SHOTS=<folder> node scripts/e2e-battle.js   (also saves screenshots of the screen)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9393;
const SHOTS = process.env.SHELLBY_SHOTS || null;
const wait = ms => new Promise(r => setTimeout(r, ms));

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-battle-')));
const repo = path.join(base, 'proj');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'app.js'), 'broken\n');
git('add', '-A');
git('commit', '-qm', 'init');
const claudeConfig = path.join(base, 'claude');
fs.mkdirSync(claudeConfig);
fs.mkdirSync(path.join(base, 'userdata'));
fs.writeFileSync(path.join(base, 'userdata', 'settings.json'), JSON.stringify({ onboarded: true, wander: false, xp: { byDevice: { legacy: 2750 } } }));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`, ...(SHOTS ? ['--force-prefers-no-reduced-motion'] : [])], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: path.join(base, 'userdata'), CLAUDE_CONFIG_DIR: claudeConfig, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47995', SHELLBY_MOTION_TEST: '1' },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const ws = new WebSocket(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const task = async text => {
      await ev(`SB.send(${JSON.stringify(text)})`);
      await until('!SB.activeTab().busy', 10000);
      await wait(1500); // snapshots and git run after the result
    };
    const fight = () => ev('shellby.getBugBattles().then(l => l[0] || null)');
    let shot = 0;
    const snap = async label => { if (SHOTS) await savePng(send, path.join(SHOTS, `${String(++shot).padStart(2, '0')}-${label}.png`)); };

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);
    await ev('SB.newTab()');

    // ---- 1. a red suite: a wild bug, at full HP, with a chip under the tabs
    await task('suite 4');
    let b = await fight();
    check(b?.species === 'assertive-lobster' && b.hp === b.max, `a red suite starts a battle at full HP (${b?.species} ${b?.hp}/${b?.max})`);
    check(await until("!document.getElementById('battleChip')?.hidden"), 'the chip shows under the tabs');

    // ---- 2. reading and editing chip at it
    await task(`read ${path.join(repo, 'app.js')}`);
    await task('patch app.js half fixed');
    b = await fight();
    check(b.moves.some(m => m.move === 'scout') && b.moves.some(m => m.move === 'patch'), `a read is a Scout, an edit a Patch (${b.moves.map(m => m.move).join(',')})`);
    check(b.hp < b.max && b.hp > 0, `they wear it down (${b.hp}/${b.max})`);

    // ---- 3. fewer failing tests: super effective
    const before = b.hp;
    await task('suite 2');
    b = await fight();
    const last = b.moves.at(-1);
    check(last.move === 'tests' && (last.fx === 'super' || last.fx === 'crit') && b.hp < before, `two of four fixed: ${last.fx} (${before} -> ${b.hp})`);

    // The screen, opened mid-fight.
    await ev('SB.openBattle(SB.bugBattles()[0].id)');
    check(await until("!!document.querySelector('.bb-overlay .bb-screen')"), 'the battle screen opens');
    await wait(SHOTS ? 1500 : 200);
    await snap('intro');
    check(await until("/Assertive Lobster|ASSERTIVE LOBSTER/.test(document.querySelector('.bb-overlay').textContent)", 8000), 'it names the bug');

    // ---- 4. a helper joins, and the green run knocks it out
    await task('review crew');
    b = await fight();
    check(b.party.length === 1 && b.moves.some(m => m.move === 'assist'), `the helper joins the party (${b.party.map(p => p.name)})`);
    await wait(SHOTS ? 2500 : 0);
    await snap('assist');
    await task('patch app.js fixed');
    await task('suite 0');
    b = await fight();
    check(b?.over === 'caught' && b.moves.slice(-2).map(m => m.fx).join() === 'ko,caught', `the fix knocks it out and jars it (${b?.over})`);
    if (b?.over !== 'caught') console.log(JSON.stringify({ battles: await ev('shellby.getBugBattles()'), loose: (await ev('shellby.getBugdex()')).loose }).slice(0, 1500));
    if (SHOTS) {
      for (let i = 0; i < 6; i++) { await wait(1400); await snap(`finish-${i}`); }
    }
    check(await until("/IN THE JAR|NEW BUGDEX ENTRY/.test(document.querySelector('.bb-overlay')?.textContent || '')", 30000), 'the screen plays the catch through to the Bugdex entry');
    const dex = await ev('shellby.getBugdex()');
    check(dex.species.find(s => s.id === 'assertive-lobster')?.state === 'caught', 'and it is in the book');
    const crew = await ev('shellby.getCrew ? shellby.getCrew() : null');
    if (crew) check(crew.members.some(m => m.beaten === 1), 'the helper has it on its record');

    // ---- 5. the page: the loose row is gone, the badge case is there
    await ev("document.querySelector('.bb-close')?.click(); SB.setView('bugdex')");
    check(await until("document.querySelectorAll('#bdLeague .bd-badge-slot').length === 12"), 'the Bugdex page shows the badge case');
    await snap('page');
  } catch (e) {
    console.log(`FAIL  ${e.stack || e.message}`);
    fails++;
  } finally {
    app.kill();
    await wait(800);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* still locked */ }
  }
  console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
  process.exit(fails ? 1 : 0);
})();
