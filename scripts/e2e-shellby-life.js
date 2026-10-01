// End-to-end check of Shellby's own life on the desktop, against the dev app
// over CDP with the fake CLI and a mock GitHub (isolated profile):
//   1. molting: a level-up into level 3 moves him into the Snail Shell, the
//      Homes tab lists every shell, and you can move him back home
//   2. petting (rubbing the mouse over him), a throw that lands on the floor,
//      and an idle stroll
//   3. a focus session: helmet on, countdown, finished early via a dev hook,
//      XP, the Deep Focus progress and the break
//   4. CI on your pull requests: a red build (sign, bubble, list, "Ask Shellby
//      why"), then fixed (he cheers, Green Light trophy), then a review request
//   5. the usage limit: reached (he naps with a countdown), then reset (he wakes
//      up and says so)
// No Claude account, no usage.
//   node scripts/e2e-shellby-life.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockGitHub } = require('../test/fixtures/mock-github');

const ROOT = path.join(__dirname, '..');
const PORT = 9361;
const HOOK = 47996;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-life-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const shot = async name => fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  return { send, ev, shot, close: () => ws.close() };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const mock = await startMockGitHub({ autoApprove: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Level 2, five XP short of level 3 (today's "day" XP already earned).
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, xp: { total: 245, lastDay: today } }));

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK),
      SHELLBY_GITHUB_WEB: mock.base, SHELLBY_GITHUB_API: mock.base, SHELLBY_GITHUB_CLIENT_ID: 'e2e-client', SHELLBY_MOTION_TEST: '1',
    },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html'))); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    const body = () => critter.ev('document.body.className');
    const bubble = () => critter.ev("document.getElementById('bubbleText').textContent");
    const shellHas = color => critter.ev(`!!document.querySelector('#sprite .part-shell rect[fill="${color}"]')`);
    await wait(3000);
    // Record every body class the critter shows, so short beats aren't missed.
    await critter.ev("window.__cls = new Set(); new MutationObserver(() => document.body.className.split(' ').forEach(c => window.__cls.add(c))).observe(document.body, { attributes: true, attributeFilter: ['class'] }); true");
    const seen = cls => critter.ev(`window.__cls.has(${JSON.stringify(cls)})`);

    // ------------------------------------------------------------ 1. molting
    let homes = await panel.ev('shellby.getHomes()');
    check(homes.worn === 'home' && homes.shells.find(s => s.id === 'snail').locked, 'level 2: still in his own shell, the Snail Shell is locked');
    check(await shellHas('#3fb8a3'), "the desktop crab wears the skin's own shell");
    await panel.ev("SB.setView('chat'); SB.send('hello')");
    check(await until(critter, "document.body.classList.contains('molt-out')", 8000), 'level 3: he starts crawling out of his shell');
    await critter.shot('1-molt-out');
    check(await until(critter, "document.body.classList.contains('molt-bare')", 3000), '...shivers without a shell');
    check(!(await critter.ev("!!document.querySelector('#sprite .part-shell')")), '...with no shell drawn at all');
    check(await bubble() === 'eep!', '"eep!"');
    await critter.shot('2-molt-bare');
    check(await until(critter, "document.body.classList.contains('molt-in')", 3000), '...and the new shell drops in');
    await wait(500);
    await critter.shot('3-molt-in');
    check(await shellHas('#b5793f'), 'he now lives in the Snail Shell');
    check(await until(critter, "!/molt-/.test(document.body.className)", 4000), 'the molt finishes');
    check(await until(critter, "document.body.classList.contains('state-levelup')", 2000), 'then the level-up bubble');
    homes = await panel.ev('shellby.getHomes()');
    check(homes.worn === 'snail', 'Homes: wearing the Snail Shell');
    check(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).home?.worn === 'snail', 'saved in settings');
    check(await until(panel, "[...document.querySelectorAll('.celebrate .cel-rname b')].some(b => b.textContent === 'Snail Shell')", 4000), 'the level-up card shows the new home');
    await panel.shot('4-levelup-card');

    // The Homes tab.
    await panel.ev("SB.clearCelebrations?.(); SB.setView('wardrobe'); document.querySelector('#wdSlots [data-slot=home]').click(); true");
    await wait(400);
    const tiles = await panel.ev("[...document.querySelectorAll('#wdGrid .wd-tile')].map(t => ({ name: t.querySelector('.wd-name').textContent, on: t.classList.contains('on'), locked: t.classList.contains('locked') }))");
    check(tiles.length === 6 && tiles[0].name === 'His own', `Homes lists his own shell plus five (${tiles.map(t => t.name).join(', ')})`);
    check(tiles.find(t => t.name === 'Snail Shell')?.on, 'the Snail Shell is the one he wears');
    check(tiles.find(t => t.name === 'Teacup')?.locked, 'the Teacup waits for level 8');
    check(await panel.ev("!!document.querySelector('#wdCrab .part-shell rect[fill=\"#b5793f\"]')"), 'the preview wears it too');
    await panel.shot('5-homes-tab');
    await panel.ev("[...document.querySelectorAll('#wdGrid .wd-tile')].find(t => t.querySelector('.wd-name').textContent === 'His own').click()");
    check(await until(critter, "!!document.querySelector('#sprite .part-shell rect[fill=\"#3fb8a3\"]')", 3000), 'back in his own shell after picking it');
    const locked = await panel.ev("shellby.wearHome('teacup')");
    check(locked.ok === false, "can't wear a shell he hasn't grown into");
    await panel.ev("shellby.wearHome('snail')");

    // ------------------------------------------------------------ 2. petting, throwing, strolling
    await wait(7000); // let the level-up flash end so he's idle
    await critter.ev(`(() => { const c = document.getElementById('crab'); const r = c.getBoundingClientRect();
      for (let i = 0; i < 9; i++) c.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, screenX: 500 + (i % 2 ? 40 : 0), clientX: r.x + 20, clientY: r.y + 20 })); return true; })()`);
    check(await critter.ev("document.getElementById('hearts').children.length > 0"), 'rubbing the mouse over him makes hearts');
    check(await until(critter, "document.body.classList.contains('state-petted')", 2000), 'he enjoys it (petted)');
    await wait(300);
    await critter.shot('6-petted');
    const pets = await panel.ev("shellby.wardrobeView().then(v => v.achievements.find(a => a.id === 'good-crab'))");
    check(pets?.current === 1 && pets.name === '???', 'counts toward the secret Good Crab trophy');

    const before = await panel.ev('shellby.dev.critterPos()');
    check(await panel.ev('shellby.dev.throw({ vx: -1800, vy: -1400 })'), 'a fast flick is a throw');
    check(await until(critter, "window.__cls.has('flying')", 2000), 'he tumbles through the air');
    check(await until(critter, "window.__cls.has('landed')", 6000), '...and lands');
    const after = await panel.ev('shellby.dev.critterPos()');
    check(after.x < before.x - 50, `flew left (${before.x} -> ${after.x})`);
    await wait(600);
    const thrownTrophy = await panel.ev("shellby.wardrobeView().then(v => v.achievements.find(a => a.id === 'frequent-flyer').done)");
    check(thrownTrophy, 'Frequent Flyer trophy for the first throw');
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).critterPos;
    check(saved && Math.abs(saved.x - after.x) <= 2, 'where he landed is his new spot');

    await wait(6500); // the trophy celebration passes
    const x0 = (await panel.ev('shellby.dev.critterPos()')).x;
    check(await panel.ev('shellby.dev.stroll()'), 'an idle stroll starts');
    check(await until(critter, "document.body.classList.contains('walking')", 1500), 'he walks (sideways, like a crab)');
    check(await until(critter, "!document.body.classList.contains('walking')", 6000), '...and stops');
    check((await panel.ev('shellby.dev.critterPos()')).x !== x0, 'he moved a little');

    // ------------------------------------------------------------ 3. focus
    await panel.ev("SB.setView('trophies')");
    await panel.ev("[...document.querySelectorAll('#focusActions button')].find(b => b.textContent === '15 min').click()");
    check(await until(critter, "document.body.classList.contains('focus-focus')", 3000), 'focus: he stands guard');
    check(await until(critter, "document.getElementById('bubbleText').textContent === '15m'", 3000), 'the bubble counts down (15m)');
    check(await shellHas('#b5793f') && await critter.ev("!!document.querySelector('#sprite .acc-hat rect[fill=\"#cfd8dc\"]')"), 'wearing the guard helmet');
    await critter.shot('7-focus');
    check(await panel.ev("/^1[45]:\\d\\d$/.test(document.getElementById('focusClock').textContent)"), 'the Focus card shows the clock');
    await panel.ev("document.getElementById('focusCard').scrollIntoView({ block: 'center' })");
    await wait(300);
    await panel.shot('8-focus-card');
    const k = await panel.ev("SB.focusCommands().map(c => c.title)");
    check(k.length === 1 && /Stop guarding/.test(k[0]), 'Ctrl+K offers to stop it');
    const xpBefore = (await panel.ev('shellby.getXp()')).xp;
    await panel.ev('shellby.dev.focusEnd()');
    check(await until(critter, "document.body.classList.contains('focus-break')", 3000), 'time is up: a break');
    await wait(5500); // the success flash passes
    await critter.shot('7b-break');
    await panel.shot('8b-focus-break');
    check((await panel.ev('shellby.getXp()')).log[0]?.kind === 'focus', 'a finished session earns XP');
    check((await panel.ev('shellby.getXp()')).xp === xpBefore + 15, '+15 XP');
    check(await panel.ev("shellby.wardrobeView().then(v => v.achievements.find(a => a.id === 'deep-focus').current)") === 1, 'Deep Focus: 1 of 5');
    check(await panel.ev("shellby.getStreaks().then(s => s.current >= 1)"), 'it counts for the streak');
    await panel.ev('shellby.stopFocus()');
    check(await until(critter, "!/focus-/.test(document.body.className)", 3000), 'skipping the break ends the session');

    // ------------------------------------------------------------ 4. CI
    mock.setCi([{ repo: 'crabfan/reef', number: 3, title: 'Teach Shellby to molt', conclusion: 'failure' }]);
    await panel.ev("SB.setView('settings'); document.getElementById('ghCi').click(); document.getElementById('ghSignIn').click()");
    check(await until(panel, "document.getElementById('ghLogin').textContent === '@crabfan'", 10000), 'signed in to the mock GitHub');
    check(/read:user/.test(mock.state.requestedScope) && !/\brepo\b/.test(mock.state.requestedScope), `watching CI asks for nothing extra (${mock.state.requestedScope})`);
    check(await panel.ev("document.getElementById('ghCi').checked"), 'Watch CI is on');
    await panel.ev('shellby.pollCi()');
    check(await until(critter, "document.body.classList.contains('ci-red')", 3000), 'red CI: he worries');
    await until(critter, "document.body.classList.contains('state-idle')", 9000); // any celebration from signing in passes
    check(await critter.ev("getComputedStyle(document.getElementById('ciSign')).display === 'block'"), '...and holds up a sign');
    check(await bubble() === 'CI ✗', 'bubble: CI ✗');
    await critter.shot('9-ci-red');
    check(await until(panel, "document.querySelectorAll('#ghCiList .gh-ci-pr.ci-failing').length === 1"), 'Settings lists the failing pull request');
    await panel.ev("document.getElementById('githubGroup').scrollIntoView({ block: 'start' })");
    await wait(300);
    await panel.shot('10-ci-settings');
    await panel.ev("[...document.querySelectorAll('#ghCiList button')].find(b => b.textContent === 'Ask Shellby why').click()");
    check(await until(panel, "[...SB.state.tabs.values()].some(t => /Why is crabfan\\/reef#3 red\\?/.test(t.title))", 5000), '"Ask Shellby why" opens a task about it');
    await until(panel, '!SB.activeTab().busy', 8000);
    await wait(6000); // the task's own success flash passes

    mock.setCi([{ repo: 'crabfan/reef', number: 3, title: 'Teach Shellby to molt', conclusion: 'success', sha: '2' }]);
    await until(critter, "document.body.classList.contains('state-idle')", 9000);
    await panel.ev('shellby.pollCi()');
    check(await until(critter, "document.body.classList.contains('state-cheer')", 3000), 'fixed: he dances');
    check(!(await body()).includes('ci-red'), 'the sign goes away');
    await wait(400);
    await critter.shot('11-ci-cheer');
    check(await until(panel, "shellby.wardrobeView().then(v => v.achievements.find(a => a.id === 'green-light').done)", 4000), 'Green Light trophy');

    mock.setCi(mock.state.ci.prs, [{ repo: 'crabfan/tide', number: 9, title: 'Tidy the tests' }]);
    await panel.ev('shellby.pollCi()');
    check(await until(critter, "document.body.classList.contains('state-asking')", 3000), 'a review request: he raises a claw');
    check(await panel.ev("[...document.querySelectorAll('#ghCiList .ci-review b')].some(b => b.textContent === 'crabfan/tide#9')"), 'the review shows in the list');

    // ------------------------------------------------------------ 5. usage limit
    await wait(5500);
    await panel.ev("SB.setView('chat'); SB.send('limit 15')");
    check(await until(panel, "!!document.querySelector('#toast:not([hidden])') && /limit is reached/.test(document.getElementById('toast').textContent)", 5000), 'the panel says the limit is reached');
    const wait1 = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).limitWait;
    check(wait1?.window === 'fiveHour' && wait1.resetsAt > Date.now(), 'remembers when it resets');
    check(await until(critter, "document.body.classList.contains('limited') && document.body.classList.contains('state-sleeping')", 10000), 'he naps until then');
    check(/^⏳ \d+s$/.test(await bubble()), `with a countdown in his bubble (${await bubble()})`);
    await critter.shot('12-limit-nap');
    check(await until(critter, "document.body.classList.contains('state-refreshed')", 15000), 'the limit resets: he wakes up');
    check(await bubble() === 'ready!', '"ready!"');
    await wait(700);
    await critter.shot('13-limit-reset');
    check(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).limitWait === null, 'and forgets the wait');
    check(await until(panel, "/just reset/.test(document.getElementById('toast').textContent)", 3000), 'the panel says go ahead');

    check(await seen('molt-in') && await seen('state-petted') && await seen('state-cheer'), 'every new mood was shown');
  } catch (e) {
    console.log('ERROR', e);
    fails++;
  } finally {
    app.kill();
    await mock.close();
  }
  console.log(`\nScreenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
