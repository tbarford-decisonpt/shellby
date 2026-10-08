// ci: rooms: a newcomer's short bar, rooms opening as they're earned, Show every screen
// End-to-end check of rooms (main/rooms.js, panel/rooms.js) against the dev app
// over CDP, driven by the fake Claude CLI (test/fixtures/fake-claude.js):
//   1. Someone new: only Shellby, Chat and "More" are on the bar
//   2. Their first finished task opens History and Projects, with a card
//   3. Ctrl+K to a locked screen opens it for good
//   4. "Show every screen" puts the rest on the bar
//   5. Someone who was here before rooms keeps the whole bar
//   node scripts/e2e-rooms.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9392;
const wait = ms => new Promise(r => setTimeout(r, ms));

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
  return new Promise(r => { ws.onopen = () => r({ ev }); });
}

// One app run with these settings; `body` gets the panel's evaluate and a poller.
async function run(settings, body) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ sounds: false, wander: false, ...settings }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47999' },
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
    await wait(1500); // let the port go before the next run
  }
}

const SHOWN = "[...document.querySelectorAll('.dock .dock-btn')].filter(b => getComputedStyle(b).display !== 'none' && !b.hidden).map(b => b.dataset.viewBtn || b.id).join()";

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  try {
    // A new user who has just finished onboarding: rooms decided at first boot.
    await run({ onboarded: true, rooms: { tasks: 0, open: [], all: false } }, async ({ ev, until, data }) => {
      await ev("SB.setView('chat')");
      check(await ev(SHOWN) === 'wardrobe,chat,dockMore', `a new bar is Shellby, Chat and More (${await ev(SHOWN)})`);
      check(/History opens after his first task/.test(await ev("SB.$('dockMore').title")), '"More" says what opens next');

      // 2. A finished task opens History and Projects.
      await ev("(i => { i.value = 'hello'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(SB.$('input'))");
      check(await until(`(${SHOWN}) === 'wardrobe,chat,history,projects,notes,dockMore'`, 15000), 'the first task puts History and Projects on the bar');
      check(await ev("document.querySelector('.dock [data-view-btn=\"history\"]').classList.contains('room-new')"), 'the new button glows');
      // The first task's trophy card may go first; the room card waits its turn.
      check(await until("/History, Projects and Notes are open/.test(document.querySelector('.celebrate')?.textContent || '')", 20000), 'a "New room" card says so');
      const saved = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).rooms;
      check(saved?.tasks === 1 && !saved.all, 'the count is saved');

      // 3. Ctrl+K to Automate opens it for good.
      await ev("SB.setView('routines')");
      check(await until(`(${SHOWN}).includes('workflows')`), 'going to Routines another way opens Automate');
      check(await ev("document.querySelector('.dock [data-view-btn=\"workflows\"]').getAttribute('aria-current') === 'page'"), 'and lights its button');

      // 4. Show every screen.
      await ev('SB.openAllRooms()');
      check(await until(`(${SHOWN}) === 'wardrobe,chat,toolbox,workflows,health,history,projects,notes'`), '"Show every screen" opens the rest and hides More');
    });

    // 5. Someone who was here before rooms: no rooms value yet, already onboarded.
    await run({ onboarded: true }, async ({ ev, data }) => {
      check(await ev(SHOWN) === 'wardrobe,chat,toolbox,workflows,health,history,projects,notes', 'an existing user keeps the whole bar');
      check(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).rooms?.all === true, 'and is saved as everything open');
    });
  } catch (e) {
    check(false, e.message);
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
