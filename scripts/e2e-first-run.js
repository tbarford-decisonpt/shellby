// ci: first run: welcome, First steps done by real events, the game's rooms after the core loop, existing users unchanged
// End-to-end check of a fresh profile's first ten minutes (main/first-run.js,
// main/rooms.js, panel/first-run.js, panel/rooms.js) against the dev app over
// CDP, driven by the fake Claude CLI (test/fixtures/fake-claude.js):
//   1. A brand-new profile meets the welcome screen; Let's go lands on the chat
//      with First steps (hello already done), a short bar, and words on what
//      a screen is for
//   2. × puts First steps away and Settings → General → Screens brings them back
//   3. Each step is done by the real thing: a folder chosen, a task sent, his
//      changes opened, Outfits visited. Two finished tasks earn Finds and
//      Stickers, which stay shut (and Review mastery's card hidden) until the
//      core loop is done, then open with a card and a "new" on their doors
//   4. A visit takes the "new" off; "Show everything now" opens the rest
//   5. Existing profiles (0.85 mid-rooms, and from before rooms) see no card,
//      nothing hidden and no newcomer words
//   node scripts/e2e-first-run.js [--shots <dir>]
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { STEPS } = require('../src/main/first-run');
const { ROOMS } = require('../src/main/rooms');

const ROOT = path.join(__dirname, '..');
const PORT = 9437;
const HOOK_PORT = '47957';
const wait = ms => new Promise(r => setTimeout(r, ms));
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : path.join(os.tmpdir(), 'shellby-e2e-first-run');
fs.mkdirSync(SHOTS, { recursive: true });

// A small git project for the first task to change.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-first-run-')));
const repo = path.join(base, 'proj');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n');
git('add', '-A');
git('commit', '-qm', 'init');

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r?.result?.value);
  return new Promise(r => { ws.onopen = () => r({ ev, send }); });
}

// One app run with these settings; `body` gets the panel's evaluate, a poller and the CDP caller.
async function run(name, settings, body) {
  const data = path.join(base, `data-${name}`);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ sounds: false, wander: false, ...settings }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: HOOK_PORT, CLAUDE_CONFIG_DIR: path.join(base, `claude-${name}`) },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const { ev, send } = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    await until("!!window.SB && document.body.classList.contains('rooms-ready')", 20000);
    await body({ ev, until, send, data });
  } finally {
    app.kill();
    await wait(1500); // let the port go before the next run
  }
}

const TABS = "[...document.querySelectorAll('#wardrobeView .shellby-tabs [data-goto]')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.goto).join()";
const SHOWN = "[...document.querySelectorAll('.dock .dock-btn')].filter(b => getComputedStyle(b).display !== 'none' && !b.hidden).map(b => b.dataset.viewBtn || b.id).join()";
const CARD = "document.querySelector('.feed:not([hidden]) .empty .first-run-card')";
const NOW_STEP = `(${CARD}?.querySelector('.fr-step.now')?.dataset.step || null)`;
const visible = sel => `(el => !!el && getComputedStyle(el).display !== 'none' && !el.hidden)(${sel})`;

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  try {
    await run('fresh', {}, async ({ ev, until, send }) => {
      // Celebration cards queue up (a first trophy, a room, First steps done):
      // close the ones in the way until the wanted one is in front.
      const seeCard = async (re, ms = 25000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const text = await ev("document.querySelector('.celebrate:not([hidden])')?.textContent || ''");
          if (re.test(text)) return true;
          if (text) await ev("document.querySelector('.celebrate .cel-close')?.click()");
          await wait(250);
        }
        return false;
      };
      const closeCards = () => ev("document.querySelectorAll('.celebrate .cel-close').forEach(b => b.click())");

      // 1. The welcome screen, then the chat with First steps.
      check(await until("SB.state.view === 'onboarding'"), 'a brand-new profile starts on the welcome screen');
      await ev("document.querySelector('#onboardPaths [data-path=\"claude\"]').click()");
      check(await until("!SB.$('letsGoBtn').disabled"), "Let's go is ready once the (fake) Claude Code is found and signed in");
      await ev("SB.$('letsGoBtn').click()");
      check(await until("SB.state.view === 'chat' && !!SB.activeTab()"), "Let's go lands on the chat");
      check(await until(visible(CARD)), 'First steps sit on the start screen');
      check(await until(`/First steps · 1 of ${STEPS.length}/.test(${CARD}.textContent)`), `hello is already done (1 of ${STEPS.length})`);
      check(await ev(NOW_STEP) === 'project', `the next step is opening a project (${await ev(NOW_STEP)})`);
      check(!(await ev(visible("document.querySelector('.feed:not([hidden]) .empty .quest-card')"))), 'no quest card beside it');
      check(await ev(SHOWN) === 'wardrobe,chat,dockMore', `a short bar: Shellby, Chat and More (${await ev(SHOWN)})`);
      check(await ev("document.body.classList.contains('newcomer')"), 'newcomer words are on');
      await ev("SB.setView('logbook')");
      check(await until("document.querySelectorAll('#lbCards .lb-card').length > 0"), 'the Logbook has its cards');
      const lb = await ev("[...document.querySelectorAll('#lbCards .lb-card')].map(c => c.dataset.card).join()");
      check(!/\b(loose|reef|review)\b/.test(lb), `but none about the game rooms still shut (${lb})`);
      check(await ev(visible("SB.$('lbNewcomer')")), 'and a line pointing back to First steps');
      await ev("SB.setView('chat')");
      await ev(`${CARD}.scrollIntoView({ block: 'start' })`);
      await savePng(send, path.join(SHOTS, '1-first-steps.png'));

      // 2. × puts it away; Settings brings it back where it was.
      await ev(`${CARD}.querySelector('.quest-x').click()`);
      check(await until(`!${visible(CARD)}`), '× puts First steps away');
      await ev("SB.setView('settings')");
      check(await until(visible("SB.$('firstRunAgainBtn')")), 'Settings offers to bring them back');
      check(await ev("!SB.$('showEverythingBtn').disabled"), 'and Show everything now is there');
      await savePng(send, path.join(SHOTS, '2-settings-screens.png'));
      await ev("SB.$('firstRunAgainBtn').click()");
      await ev("SB.setView('chat')");
      check(await until(visible(CARD)) && await ev(NOW_STEP) === 'project', 'they come back at the same step');

      // 3a. A folder chosen (the real setFolder) is opening a project.
      await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
      check(await until(`${NOW_STEP} === 'message'`), 'choosing a folder finishes Open a project');

      // 3b. Write one puts a task in the box, unsent; sending one is the step.
      await ev(`${CARD}.querySelector('.fr-go').click()`);
      check(await until("SB.$('input').value.length > 0 && document.activeElement === SB.$('input')"), 'Write one puts a first task in the box, unsent');
      check(await ev(`${NOW_STEP} === 'message'`), 'and that alone does not finish the step');
      await ev("SB.$('input').value = ''; SB.$('input').dispatchEvent(new Event('input'))");
      await ev("SB.send('edit a.txt hello from first steps')");
      check(await until("!!document.querySelector('.feed:not([hidden]) details.changes')", 20000), 'the task edits a file and shows what changed');
      check(await until("!SB.activeTab().busy", 20000), 'the first task finishes');
      check(await until(`(${SHOWN}).includes('history')`, 15000), 'the first finished task opens History and the rest of the working rooms');
      await closeCards();

      // 3c. Opening his changes is seeing what changed. The card's button goes there.
      const step = await ev("shellby.getFirstRun().then(v => v.current)");
      check(step === 'result', `next is See what changed (${step})`);
      // The card sits on an empty conversation, so in this one a nudge points at the changes.
      check(await until("[...document.querySelectorAll('.toast')].some(t => /First steps/.test(t.textContent))"), 'a nudge says to open his changes');
      await ev("(d => { d.open = false; d.open = true; })(document.querySelector('.feed:not([hidden]) details.changes'))");
      check(await until("shellby.getFirstRun().then(v => v.current === 'crab')"), 'opening his changes finishes See what changed');

      // A second finished task earns Finds and Stickers, which wait for the core loop.
      await ev("SB.send('just talking')");
      check(await until("shellby.getRooms().then(v => v.tasks === 2)", 20000), 'a second task is counted');
      const gameIds = ROOMS.filter(r => r.game && r.tasks <= 2).map(r => r.id);
      check(await ev(`shellby.getRooms().then(v => !v.core && ${JSON.stringify(gameIds)}.every(id => v.locked.includes(id)))`), `${gameIds.join(' and ')} stay shut before the core loop`);
      check(!(await ev(TABS)).split(',').some(id => gameIds.includes(id)), `and are not on his screen (${await ev(TABS)})`);
      check(await ev("SB.$('rmCard').classList.contains('room-locked')"), "Review mastery's card is out of sight too");
      await closeCards();

      // 3d. Outfits visited is meeting the crab: the last step, and the core loop.
      await ev("SB.setView('wardrobe')");
      check(await until("shellby.getFirstRun().then(v => v.complete)"), 'visiting Outfits finishes Meet the crab, and First steps');
      check(await seeCard(/You two are off/), 'a "First steps done" card says so');
      check(await seeCard(new RegExp(`${ROOMS.find(r => r.id === gameIds[0]).name}.* open`)), 'and a "New room" card opens the game rooms already earned');
      check(await until(`${JSON.stringify(gameIds)}.every(id => (${TABS}).split(',').includes(id))`), `${gameIds.join(' and ')} join his screen`);
      check(await ev(`${JSON.stringify(gameIds)}.every(id => document.querySelector('#wardrobeView .shellby-tabs [data-goto="' + id + '"]').classList.contains('room-fresh'))`), 'each with a "new" on its tab');
      check(await until("!document.body.classList.contains('newcomer')"), 'the newcomer words go');
      await closeCards();
      await savePng(send, path.join(SHOTS, '3-new-rooms.png'));

      // 4. A visit takes its "new" off; Show everything now opens the rest.
      await ev(`SB.setView(${JSON.stringify(gameIds[0])})`);
      check(await until(`!document.querySelector('#wardrobeView .shellby-tabs [data-goto="${gameIds[0]}"]').classList.contains('room-fresh')`), `visiting ${gameIds[0]} takes its "new" off`);
      check(await ev(`document.querySelector('#wardrobeView .shellby-tabs [data-goto="${gameIds[1]}"]').classList.contains('room-fresh')`), `and leaves ${gameIds[1]}'s`);
      await ev("SB.setView('settings')");
      await ev("SB.$('showEverythingBtn').click()");
      check(await until("SB.$('showEverythingBtn').disabled"), 'Show everything now opens every screen');
      check(await ev(`(${SHOWN}) === 'wardrobe,chat,toolbox,workflows,health,history,projects,notes'`), `every button is on the bar (${await ev(SHOWN)})`);
      check(await ev("!SB.$('rmCard').classList.contains('room-locked')"), "and Review mastery's card is back");
    });

    // 5. Existing profiles: nothing changes for them.
    await run('mid-rooms', { onboarded: true, rooms: { tasks: 2, open: [], all: false } }, async ({ ev, until }) => {
      await until('!!SB.activeTab()');
      await ev("SB.setView('chat')");
      check(!(await ev(visible(CARD))), 'someone mid-rooms from 0.85 sees no First steps');
      check(await ev(`(${TABS}).includes('finds') && (${TABS}).includes('stickers')`), `and keeps Finds and Stickers (${await ev(TABS)})`);
      check(await ev("!SB.$('rmCard').classList.contains('room-locked') && !SB.$('reefCard').classList.contains('room-locked')"), 'the Reef and Review mastery cards stay where they were');
      check(!(await ev("document.body.classList.contains('newcomer')")), 'and no newcomer words');
    });
    await run('before-rooms', { onboarded: true }, async ({ ev, until, data }) => {
      await until('!!SB.activeTab()');
      check(await ev(SHOWN) === 'wardrobe,chat,toolbox,workflows,health,history,projects,notes', 'someone from before rooms keeps the whole bar');
      check(!(await ev(visible(CARD))), 'with no First steps');
      const saved = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
      check(saved.firstRun?.legacy === true && saved.rooms?.all === true, 'saved as finished, every screen open');
    });
  } catch (e) {
    check(false, e.stack || e.message);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(`screenshots in ${SHOTS}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
