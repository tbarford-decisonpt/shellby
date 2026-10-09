// ci: the Council: seats round the table, Quick and Debate sittings, minutes, history, custom seats
// End-to-end check of the Council screen against the fake Claude CLI (no
// account, no usage): every seated advisor sits at the table with Shellby at
// its head, a Quick sitting makes one call and fills the bubbles, votes and the
// verdict scroll, Debate adds rebuttals, the minutes and history keep it, and
// a custom advisor takes a seat.
//   node scripts/e2e-council.js [folder for screenshots]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { DEFAULT_SEATS } = require('../src/main/council/prompts');

const ROOT = path.join(__dirname, '..');
const PORT = 9402;
const SHOTS = process.argv[2];
const SEATS = DEFAULT_SEATS.length;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, stats: { tasksCompleted: 0 } }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47996' },
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
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const shot = async name => { if (SHOTS) await savePng(send, path.join(SHOTS, `${name}.png`)); };
    const count = sel => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    const ask = async (question, mode) => {
      await ev(`document.querySelector('#ccModes [data-mode="${mode}"]').click()`);
      await until(`document.querySelector('#ccModes [data-mode="${mode}"]').getAttribute('aria-checked') === 'true'`);
      await ev(`document.getElementById('ccQuestion').value = ${JSON.stringify(question)}; document.getElementById('ccAsk').requestSubmit()`);
      return until("!document.getElementById('ccMinutes').hidden && !document.getElementById('ccConvene').disabled", 20000);
    };

    await until('!!SB.state.skin');
    await ev("SB.setView('council')");
    check(await until("document.body.dataset.view === 'council' && document.querySelectorAll('#ccSeats .cc-seat').length > 0"), 'the Council screen opens');
    check(await count('#ccSeats .cc-seat') === SEATS + 1, `the ${SEATS} advisors and Shellby sit at the table`);
    check(await ev("!!document.querySelector('#ccCrabs .cc-crab.is-chair .cc-throne')"), 'Shellby sits on the chair at the head');
    // The advisors sit round the far side: every crab is above the table's middle line or beside it.
    check(await ev(`(() => { const t = document.querySelector('.cc-table').getBoundingClientRect(); return [...document.querySelectorAll('#ccCrabs .cc-crab')].every(c => c.getBoundingClientRect().top < t.top + t.height / 2); })()`), 'the crabs sit round the table, not in a row in front of it');
    check(await ev("document.getElementById('ccHint').textContent.includes('1 call')"), 'Quick says it makes one call');
    await shot('council-empty');

    check(await ask('Should settings move to SQLite?', 'quick'), 'a Quick sitting finishes');
    check(await count('#ccSeats .cc-seat[data-state="spoke"]') === SEATS + 1, 'every seat has spoken');
    check(await count('#ccSeats .cc-bubble:not(:empty)') === SEATS, 'each advisor has a speech bubble');
    check(await ev("document.querySelector('#ccSeats [data-seat=\"skeptic\"] .cc-vote').dataset.vote === 'against'"), "the Skeptic's vote token says against");
    check(await ev("document.getElementById('ccScrollText').textContent.includes('Go ahead')"), 'the scroll shows the verdict');
    check(await count('#ccOpinions .cc-row') === SEATS, 'the minutes list every advisor');
    check(await ev("document.querySelector('.cc-cost').textContent.startsWith('1 call')"), 'the minutes say it took one call');
    await shot('council-quick');

    check(await ask('And should we migrate old files?', 'debate'), 'a Debate sitting finishes');
    check(await ev("document.querySelector('.cc-cost').textContent.startsWith('" + (SEATS + 2) + " calls')"), `Debate took ${SEATS + 2} calls`);
    check(await count('#ccOpinions .cc-rebuttal') === SEATS, 'every advisor answered the others');
    check(await ev("document.getElementById('ccTally').textContent.includes('~')"), 'the tally counts the changed votes');
    await shot('council-debate');

    await ev("document.getElementById('ccHistoryBtn').click()");
    check(await until("document.querySelectorAll('#ccHistoryList .cc-history-item').length === 2"), 'both sittings are in Past sessions');
    await ev("document.querySelector('#ccHistoryList .cc-history-item:last-child .cc-history-open').click()");
    check(await until("document.querySelector('.cc-eyebrow').textContent.includes('SQLite')"), 'an old sitting opens from the minutes, with no call');

    await ev("document.getElementById('ccSeatsBtn').click()");
    await until("document.querySelectorAll('#ccSeatList li').length > 0");
    await ev("document.getElementById('ccCustomName').value = 'Accountant'; document.getElementById('ccCustomBrief').value = 'Count the cost.'; document.getElementById('ccCustomForm').requestSubmit()");
    check(await until("[...document.querySelectorAll('#ccSeats .cc-plaque')].some(p => p.textContent === 'Accountant') || [...document.querySelectorAll('#ccSeatList b')].some(b => b.textContent === 'Accountant')"), 'a custom advisor joins the council');
    check(await ev("shellby.councilView().then(v => v.settings.custom.length === 1 && v.settings.seated.length === " + (SEATS + 1) + ')'), 'main keeps the new seat');
  } catch (e) {
    console.error('failed:', e.message);
    fails++;
  } finally {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); process.exit(fails ? 1 : 0); }, 1200);
  }
})();
