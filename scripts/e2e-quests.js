// ci: quests: the card after his first task, a real review finishing one, the line complete, hide and bring back
// End-to-end check of quests (main/quests.js, panel/quests.js) against the dev app
// over CDP, driven by the fake Claude CLI (test/fixtures/fake-claude.js):
//   1. Someone brand new: no quest card until his first task is done
//   2. Then a fresh conversation shows the first quest, and the trail is in Trophies
//   3. A real review with line comments finishes it, with a card for the next
//   4. The rest finish the line, saved, with its own card
//   5. × hides the card from the chat (Undo-able); Trophies can bring it back
//   node scripts/e2e-quests.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9393;
const wait = ms => new Promise(r => setTimeout(r, ms));

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
  return new Promise(r => { ws.onopen = () => r({ ev }); });
}

async function run(settings, body) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ sounds: false, wander: false, ...settings }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47998', SHELLBY_MOTION_TEST: '1', SHELLBY_FAKE_HEALTH: 'calm' },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const { ev } = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    await until("!!window.SB && document.body.classList.contains('rooms-ready') && !!SB.activeTab()"); // rooms come apart from the tabs
    await body({ ev, until, data });
  } finally {
    app.kill();
    await wait(1500);
  }
}

const CARD = "(() => { const c = [...document.querySelectorAll('.empty .quest-card')].find(e => e.offsetParent); return c && !c.hidden ? c.textContent : ''; })()";
const saved = data => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).quests;

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  try {
    await run({ onboarded: true, rooms: { tasks: 0, open: [], all: false } }, async ({ ev, until, data }) => {
      await ev("SB.setView('chat')");
      // 1. Brand new: the crab and the box first.
      check(await ev(CARD) === '', 'no quest card before his first task');

      // 2. A finished task, then a fresh conversation.
      await ev("(i => { i.value = 'hello'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(SB.$('input'))");
      await until("!SB.isRoomLocked('history')", 15000);
      const firstTab = await ev('SB.activeTab().id');
      await ev('SB.newTab()');
      check(await until(`/Quest 1 of 4/.test(${CARD}) && /Comment on a diff line/.test(${CARD})`), 'a new conversation shows the first quest');
      await ev("SB.setView('trophies')");
      check(await until("!SB.$('xpQuests').hidden && SB.$('xpQuestList').children.length === 4"), 'Trophies shows the whole trail');
      check(await ev("SB.$('xpQuestList').children[0].getAttribute('aria-current') === 'step'"), 'the first stop is marked as next up');

      // 3. A review with a line comment goes: the quest is done.
      await ev("SB.clearCelebrations?.()");
      await ev(`SB.api.noteReviewComments(${JSON.stringify(firstTab)}, [{ file: 'a.js', body: 'Call this parseRow' }], 'e2e-batch')`);
      check(await until("/Quest complete/.test(document.querySelector('.celebrate')?.textContent || '') && /Try it another way/.test(document.querySelector('.celebrate')?.textContent || '')", 15000), 'a "Quest complete" card points at the next one');
      check(await until("SB.$('xpQuestList').children[0].classList.contains('done')"), 'the trail ticks it off');
      check(!!saved(data)?.done?.comment, 'and it is saved');

      // 4. The rest of the line.
      for (const id of ['branch', 'home']) await ev(`SB.api.dev.quest('${id}')`);
      await ev("SB.setView('trophies')");
      check(await until("[...SB.$('xpQuestList').querySelectorAll('.quest-go')].some(b => b.textContent === 'Open the reset queue')"), 'the reset quest offers to open the queue');
      await ev("[...SB.$('xpQuestList').querySelectorAll('.quest-go')].find(b => b.textContent === 'Open the reset queue').click()");
      check(await until("SB.state.view === 'routines' && document.activeElement?.id === 'resetQueueText'"), 'which lands in the reset queue box');
      await ev("SB.api.dev.quest('reset')");
      check(await until("/Quest line complete/.test(document.querySelector('.celebrate-host')?.textContent || '') || /Quest line complete/.test(document.body.textContent)", 40000), 'finishing all four gets its own card');
      check(Object.keys(saved(data)?.done || {}).length === 4, 'all four are saved');
      check(await ev("/all found/.test(SB.$('xpQuestCount').textContent)"), 'Trophies says they are all found');
      await ev("SB.setView('chat')");
      check(await ev(CARD) === '', 'the chat card goes once the line is done');
    });

    // 5. Hiding the card.
    await run({ onboarded: true, rooms: { tasks: 0, open: [], all: true } }, async ({ ev, until, data }) => {
      await ev("SB.setView('chat')");
      check(await until(`/Quest 1 of 4/.test(${CARD})`), 'an existing user sees the first quest straight away');
      await ev("[...document.querySelectorAll('.empty .quest-x')].find(e => e.offsetParent).click()");
      check(await until(`(${CARD}) === ''`), '× hides it from the chat');
      await wait(500);
      check(saved(data)?.hidden === true, 'and that is saved');
      await ev("SB.setView('trophies')");
      check(await until("!SB.$('xpQuestShow').hidden"), 'Trophies offers to show it again');
      await ev("SB.$('xpQuestShow').click()");
      await ev("SB.setView('chat'); SB.newTab()");
      check(await until(`/Quest 1 of 4/.test(${CARD})`), 'and it comes back');
    });
  } catch (e) {
    check(false, e.message);
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
