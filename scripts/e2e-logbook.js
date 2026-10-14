// ci: logbook: the tab on his screen, cards for every system, a feed link that navigates, pins, quest chapters
// End-to-end check of the Logbook (main/logbook.js, panel/logbook.js) and the
// quest chapters (main/quests.js) against the dev app over CDP, driven by the
// fake Claude CLI (test/fixtures/fake-claude.js):
//   1. Someone brand new already has the Logbook tab, on every page of his screen
//   2. It opens with a card for each system (counts from main/logbook.js), the
//      ones not built yet saying "not yet" instead of breaking
//   3. A "this feeds that" line is a link that lands on its screen
//   4. Pinning a card moves it to the top, and it's saved
//   5. Chapter 1 finished: the chapter list ticks it off, later ones wait for their level
//   node scripts/e2e-logbook.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CARD_IDS } = require('../src/main/logbook');
const { CHAPTERS } = require('../src/main/quests');

const ROOT = path.join(__dirname, '..');
const PORT = 9447;
const wait = ms => new Promise(r => setTimeout(r, ms));

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
  return new Promise(r => { ws.onopen = () => r({ ev, close: () => ws.close() }); });
}

async function run(settings, body) {
  const data = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ sounds: false, wander: false, ...settings }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47947', SHELLBY_MOTION_TEST: '1', SHELLBY_FAKE_HEALTH: 'calm' },
  });
  let conn = null;
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const target = list.find(t => t.url.endsWith('panel.html'));
    if (!target) throw new Error('the panel never came up');
    conn = await connect(target.webSocketDebuggerUrl);
    const { ev } = conn;
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    await until("!!window.SB && document.body.classList.contains('rooms-ready')", 20000);
    await body({ ev, until, data });
  } finally {
    conn?.close();
    app.kill();
    await wait(1500);
  }
}

const saved = (data, key) => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'))[key];
const CARDS = "[...document.querySelectorAll('#lbCards .lb-card')].map(c => c.dataset.card)";

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  try {
    await run({ onboarded: true, rooms: { tasks: 0, open: [], all: false } }, async ({ ev, until, data }) => {
      // 1. The tab is there from the start, on every page of his screen.
      await ev("SB.setView('wardrobe')");
      check(await until("!!document.querySelector('#wardrobeView .shellby-tabs [data-goto=\"logbook\"]') && !SB.isRoomLocked('logbook')"), 'a brand-new user has the Logbook tab on his screen');
      check(await ev("[...document.querySelectorAll('.shellby-tabs')].every(n => n.querySelector('[data-goto=\"logbook\"]'))"), 'every page of his screen has the tab');
      check(await ev("document.querySelector('#wardrobeView .shellby-tabs button').dataset.goto === 'logbook'"), 'it is the first tab');

      // 2. Cards for every system, none of them broken.
      await ev("document.querySelector('#wardrobeView .shellby-tabs [data-goto=\"logbook\"]').click()");
      check(await until("SB.state.view === 'logbook' && document.querySelectorAll('#lbCards .lb-card').length > 0"), 'the tab opens the Logbook with cards');
      const shown = await ev(CARDS);
      const always = CARD_IDS.filter(id => id !== 'molt' && id !== 'wrapped');
      check(always.every(id => shown.includes(id)), `a card for each system (${always.length})`);
      check(await ev("[...document.querySelectorAll('#lbCards .lb-card.missing .lb-text')].every(p => p.textContent.trim().length > 0)"), 'a system not here yet says so in words');
      check(await ev("[...document.querySelectorAll('#lbCards .lb-card')].every(c => c.querySelector('.lb-title')?.textContent)"), 'every card has a title');
      await wait(600);
      check((saved(data, 'logbook')?.lastOpenAt || 0) > 0, 'opening it is remembered');

      // 3. A feed line navigates to its screen.
      const to = await ev("document.querySelector('#lbCards .lb-feed')?.dataset.to || ''");
      check(!!to, 'cards say what they feed');
      if (to) {
        await ev("document.querySelector('#lbCards .lb-feed').click()");
        check(await until(`SB.state.view === ${JSON.stringify(to)}`), `a feed link lands on ${to}`);
      }

      // 4. Pinning.
      await ev("SB.setView('logbook')");
      await until("document.querySelectorAll('#lbCards .lb-card').length > 0");
      const last = await ev(`${CARDS}.at(-1)`);
      await ev(`document.querySelector('#lbCards .lb-card[data-card="${last}"] .lb-pin').click()`);
      check(await until(`${CARDS}[0] === ${JSON.stringify(last)}`), 'a pinned card moves to the top');
      await wait(300);
      check((saved(data, 'logbook')?.pinned || []).includes(last), 'and the pin is saved');
      await ev(`document.querySelector('#lbCards .lb-card[data-card="${last}"] .lb-fold').click()`);
      check(await until(`!document.querySelector('#lbCards .lb-card[data-card="${last}"] .lb-body')`), 'a card folds down to its title');

      // 5. Quest chapters.
      check(await until(`document.querySelectorAll('#lbChapterList > li').length === ${CHAPTERS.length}`), `the quest line lists all ${CHAPTERS.length} chapters`);
      for (const q of CHAPTERS[0].quests) await ev(`SB.api.dev.quest('${q.id}')`);
      await ev("SB.setView('wardrobe'); SB.setView('logbook')");
      check(await until(`document.querySelector('#lbChapterList > li[data-chapter="${CHAPTERS[0].id}"]')?.classList.contains('done')`), 'Chapter 1 is ticked off');
      // Level 1 on day one: screens only count as never tried after a week, so nothing opens early.
      check(await ev("[...document.querySelectorAll('#lbChapterList > li')].slice(1).every(li => li.classList.contains('locked'))"), 'later chapters wait for their level');
      check(Object.keys(saved(data, 'quests')?.done || {}).length === CHAPTERS[0].quests.length, 'the old four quests are saved as Chapter 1');
    });
  } catch (e) {
    check(false, e.message);
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
