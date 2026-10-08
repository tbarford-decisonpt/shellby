// ci: the Done tick in History: filter tabs, Undo, un-ticking
// The Done tick in History: a conversation you've finished with leaves the
// default list, the Not done / Done / All tabs only turn up once there's
// something to filter, Undo puts a row back, and giving a done conversation
// more work marks it not done again. Runs against the fake CLI; no account needed.
//   node scripts/e2e-history-done.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9364;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47988' },
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
    const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    const idle = async () => { for (let i = 0; i < 60 && await ev('SB.activeTab().busy'); i++) await wait(150); };
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");

    // ---- three saved conversations (an entry is written on the first send)
    for (const text of ['hello alpha', 'hello bravo', 'hello charlie']) {
      await ev('SB.newTab()');
      await ev(`SB.send(${JSON.stringify(text)})`);
      await idle();
    }

    // The History screen, rendered and settled. setView kicks the render off
    // without waiting for the session list, so ask for it directly.
    const open = () => ev("SB.setView('history'), SB.views.history.render()");
    const titles = () => ev("[...document.querySelectorAll('#historyList .h-title')].map(e => e.textContent)");
    const hiddenTabs = () => ev("document.getElementById('historyTabs').hidden");
    const counts = () => ev("[...document.querySelectorAll('#historyTabs [data-filter]')].map(b => `${b.dataset.filter}:${b.querySelector('.n').textContent}`).join(' ')");
    const filter = f => ev(`document.querySelector('#historyTabs [data-filter="${f}"]').click()`);
    const tick = (n = 0) => ev(`document.querySelectorAll('#historyList .history-tick')[${n}].click()`).then(() => wait(400));

    await open();
    check((await titles()).length === 3, 'three conversations in History');
    check(await hiddenTabs() === true, 'the filter tabs stay out of the way until something is done');

    // ---- 1. tick the newest off
    await tick(0);
    const left = await titles();
    check(left.length === 2 && !left.includes('hello charlie'), `a conversation marked done leaves the list (${left.join(', ')})`);
    check(await hiddenTabs() === false, 'the filter tabs appear once there is something to filter');
    check(await counts() === 'todo:2 done:1 all:3', `each tab counts what it would show (${await counts()})`);
    check(await ev("!document.getElementById('toast').hidden && document.getElementById('toast').textContent.includes('Undo')"), 'the toast says so and offers Undo');
    check(await ev('shellby.listSessions().then(l => l.filter(s => s.done).length)') === 1, 'the flag is written by the main process, not just held in the panel');

    // ---- 2. the Done tab
    await filter('done');
    check((await titles()).join() === 'hello charlie', 'the Done tab shows exactly what you ticked off');
    check(await ev("document.querySelector('#historyList .history-item').classList.contains('done')"), 'the row is marked done');
    check(await ev("document.querySelector('#historyList .h-done')?.textContent") === '✓ done', 'and says so in its meta line');
    check(await ev("document.querySelector('#historyList .history-tick').getAttribute('aria-pressed')") === 'true', 'the tick reads as pressed to a screen reader');

    // ---- 3. All keeps everything, done at the bottom
    await filter('all');
    check((await titles()).join() === 'hello bravo,hello alpha,hello charlie', `All shows every conversation with the done ones last (${(await titles()).join(', ')})`);

    // ---- 4. un-ticking puts it back, and the tabs bow out again
    await tick(2);
    check(await ev('SB.state.sessions.some(s => s.done)') === false, 'un-ticking clears it');
    check(await hiddenTabs() === true, 'with nothing done, the filter tabs go away again');
    check((await titles()).length === 3, 'and all three are back in the list');

    // ---- 5. more work on a done conversation un-ticks it on its own
    await tick(0);
    check(await ev('SB.state.sessions.some(s => s.done)') === true, 'marked done again');
    await ev("(async () => { const s = SB.state.sessions.find(x => x.done); await SB.openHistory(s.id); await SB.send('hello again'); })()");
    await idle();
    await open();
    check(await ev('SB.state.sessions.some(s => s.done)') === false, 'sending it something new marks it not done again');
    check((await titles()).length === 3, 'so it is back in the default list');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
