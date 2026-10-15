// ci: the Council: reading the project first, picked seats, decisions, cited facts, records, Debate, plans, notes, history
// End-to-end check of the Council screen against the fake Claude CLI (no
// account, no usage): Shellby reads a project first and lays its checked facts
// on the table as cards, picks who sits, and a Quick sitting fills the
// bubbles, votes, decision seal and verdict scroll; a cited fact lights its
// card; saying how it went gives each advisor a record; Debate shows rebuttals
// and changed minds; the verdict becomes a plan, a note and a re-sitting on
// what's open; the minutes and history keep it; a custom advisor takes a seat.
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
// The fake CLI's pick (test/fixtures/fake-claude.js) and its one real fact (the other names a file that isn't there).
const PICKED = 4;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'council-project-')));
  fs.writeFileSync(path.join(project, 'README.md'), '# A project\nIt has a council.\n');
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, stats: { tasksCompleted: 0 }, cwd: project }));
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
    const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`);
    const sessions = () => ev('shellby.councilHistory().then(l => l.length)');
    const finished = async (n, ms = 20000) => until(`shellby.councilHistory().then(l => l.length === ${n})`, ms)
      && until("!document.getElementById('ccMinutes').hidden && !document.getElementById('ccConvene').disabled", ms);
    const ask = async (question, mode) => {
      const before = await sessions();
      await ev(`document.querySelector('#ccModes [data-mode="${mode}"]').click()`);
      await until(`document.querySelector('#ccModes [data-mode="${mode}"]').getAttribute('aria-checked') === 'true'`);
      await ev(`document.getElementById('ccQuestion').value = ${JSON.stringify(question)}; document.getElementById('ccAsk').requestSubmit()`);
      return finished(before + 1);
    };
    const press = label => ev(`(() => { const b = [...document.querySelectorAll('#ccVerdict button')].find(x => x.textContent === ${JSON.stringify(label)}); b?.click(); return !!b; })()`);

    await until('!!SB.state.skin');
    await ev("SB.setView('council')");
    check(await until("document.body.dataset.view === 'council' && document.querySelectorAll('#ccSeats .cc-seat').length > 0"), 'the Council screen opens');
    check(await count('#ccSeats .cc-seat') === SEATS + 1, `the ${SEATS} advisors and Shellby sit at the table`);
    check(await ev("!!document.querySelector('#ccCrabs .cc-crab.is-chair .cc-throne')"), 'Shellby sits on the chair at the head');
    // The advisors sit round the far side: every crab is above the table's middle line or beside it.
    check(await ev(`(() => { const t = document.querySelector('.cc-table').getBoundingClientRect(); return [...document.querySelectorAll('#ccCrabs .cc-crab')].every(c => c.getBoundingClientRect().top < t.top + t.height / 2); })()`), 'the crabs sit round the table, not in a row in front of it');
    // A wide panel once squashed the hall flat: its max-height held while the width grew, and the crabs dwarfed the table.
    check(await ev(`(() => { const v = document.getElementById('councilView'); v.style.width = '2400px'; const r = document.getElementById('ccChamber').getBoundingClientRect(); v.style.width = ''; return Math.abs(r.width / r.height - 16 / 9.5) < 0.05; })()`), 'a wide panel keeps the hall in proportion');
    check(await count('#ccModes [data-mode]') === 2, 'there are two ways to sit, Quick and Debate');
    check(await ev(`document.getElementById('ccProject').checked && document.getElementById('ccReadText').textContent === 'Read ${path.basename(project)} first'`), 'it offers to read the project first, by name');
    check((await text('#ccHint')).includes('he picks') && (await text('#ccHint')).includes('2 calls'), 'the hint says he picks and Quick with a read is two calls');
    check(/About \$\d+\.\d\d–\d+\.\d\d/.test(await text('#ccHint')), 'the hint gives a dollar range before it sits');
    await shot('council-empty');

    // ---- Quick, reading the project first
    check(await ask('Should settings move to SQLite?', 'quick'), 'a Quick sitting that reads the project finishes');
    check(await count('#ccSeats .cc-seat') === PICKED + 1, `he picked ${PICKED} advisors for the question`);
    check(await ev("!!document.querySelector('#ccSeats [data-seat=\"tester\"]')"), 'one from the bench sits');
    check(await count('#ccSeats .cc-seat[data-state="spoke"]') === PICKED + 1, 'every seat has spoken');
    check(await count('#ccSeats .cc-bubble:not(:empty)') === PICKED, 'each advisor has a speech bubble');
    check(await ev("document.querySelector('#ccSeats [data-seat=\"skeptic\"] .cc-vote').dataset.vote === 'against'"), "the Skeptic's vote token says against");
    check((await text('#ccScrollText')).includes('Go ahead'), 'the scroll shows the verdict');
    check(await ev("!document.getElementById('ccStamp').hidden && document.getElementById('ccStamp').dataset.decision === 'do'"), 'the scroll is sealed with the decision');
    check(await count('#ccDeck .cc-card') === 1, 'the one checked fact lies on the table as a card');
    check(await count('#ccVerdict .cc-facts li') === 1 && await count('#ccVerdict .cc-facts a.file-link') === 1, 'What he read lists it with a link to its file');
    check((await text('#ccVerdict .cc-read')).includes("isn’t there"), 'and says a fact naming a missing file was left out');
    check((await text('#ccVerdict .cc-against')).includes('may not be needed'), 'the verdict gives the best case against');
    check((await text('#ccVerdict .cc-list.is-open')).includes('Does anyone use it'), 'and what is still open');
    check(await count('#ccOpinions .cc-row') === PICKED, 'the minutes list every advisor');
    check(await count('#ccOpinions .cc-flip') === PICKED, 'each says what would change their mind');
    check((await text('.cc-cost')).startsWith('2 calls'), 'the minutes say it took two calls');
    check((await text('.cc-cost')).includes('under $0.01 of your plan'), 'and what they really cost');
    await shot('council-quick');
    await ev("document.querySelector('#ccOpinions .cc-cite').click()");
    check(await until("document.querySelector('#ccDeck .cc-card[data-fact=\"1\"]').classList.contains('is-lit')"), 'a cited fact lights its card on the table');
    await shot('council-cited');

    // ---- how it went: each advisor gets a record
    check(await press('Followed it, and it worked'), 'it asks how it went');
    check(await until(`document.querySelectorAll('#ccSeats .cc-record').length === ${PICKED}`), 'each advisor now has a record on their plaque');
    check(await ev("document.querySelector('#ccSeats [data-seat=\"skeptic\"] .cc-record').textContent === '0/1' && document.querySelector('#ccSeats [data-seat=\"builder\"] .cc-record').textContent === '1/1'"), 'the Skeptic voted against what worked, the Builder for it');

    // ---- the verdict, put to work
    check(await press('Add to Notes'), 'Add to Notes is offered');
    check(await until("shellby.listNotes().then(v => [...v.general, ...v.projects.flatMap(p => p.notes)].some(n => n.text.startsWith('Council on')))"), 'the verdict lands on the Notes list');
    check(await press('Plan the next steps'), 'Plan the next steps is offered');
    check(await until("SB.state.view === 'chat' && document.getElementById('input').value.includes('Their decision: Do it.')"), 'it opens a conversation with the plan ready to send, not sent');
    await ev("SB.setView('council')");
    await until("document.body.dataset.view === 'council'");

    // ---- Debate, with the table and reading fixed
    await ev("document.getElementById('ccSeatsBtn').click()");
    await until("!document.getElementById('ccSeatsEditor').hidden");
    await ev("document.getElementById('ccPick').click()");
    check(await until('shellby.councilView().then(v => v.settings.pick === false)'), 'picking can be turned off');
    await ev("document.getElementById('ccProject').click()");
    check(await until('shellby.councilView().then(v => v.settings.read === false)'), 'and reading the project');
    check(await ask('And should we migrate old files?', 'debate'), 'a Debate sitting finishes');
    check((await text('.cc-cost')).startsWith(`${SEATS + 2} calls`), `Debate took ${SEATS + 2} calls`);
    check(await count('#ccDeck .cc-card') === 0, 'nothing was read, so no cards');
    check(await count('#ccOpinions .cc-rebuttal') === SEATS, 'every advisor answered the others');
    check((await text('#ccOpinions .cc-rebuttal')).startsWith('To the '), 'each answers someone by name');
    check(await count('#ccOpinions .cc-changed') === SEATS, 'and the minutes say who changed their mind');
    check((await text('#ccTally')).includes('~'), 'the tally counts the changed votes');
    await shot('council-debate');

    // ---- history, and sitting again on what's open
    await ev("document.getElementById('ccHistoryBtn').click()");
    check(await until("document.querySelectorAll('#ccHistoryList .cc-history-item').length === 2"), 'both sittings are in Past sessions');
    check((await text('#ccHistoryList .cc-history-item:last-child')).includes('worked'), 'the first says it worked');
    await ev("document.querySelector('#ccHistoryList .cc-history-item:last-child .cc-history-open').click()");
    check(await until("document.querySelector('.cc-eyebrow').textContent.includes('SQLite') && document.querySelectorAll('#ccDeck .cc-card').length === 1"), 'an old sitting opens from the minutes with its cards, with no call');
    check(await press('Answer what’s open'), 'it offers to answer what is still open');
    check(await finished(3), 'the council sits again on the same question');
    check(await ev("document.querySelector('.cc-eyebrow').textContent.includes('SQLite') && document.querySelectorAll('#ccDeck .cc-card').length === 1"), 'reading the project again, whatever the setting');

    await ev("document.querySelector('.cc-actions .cc-follow').click()");
    check(await ev("!document.getElementById('ccNewBtn').hidden && document.getElementById('ccQuestion').placeholder.startsWith('A follow-up')"), 'a follow-up offers a new session');
    await ev("document.getElementById('ccNewBtn').click()");
    check(await until("document.getElementById('ccMinutes').hidden && document.getElementById('ccNewBtn').hidden && document.getElementById('ccScrollText').textContent.includes('waiting for a question') && !document.getElementById('ccQuestion').placeholder.startsWith('A follow-up')"), 'New session clears the table and the follow-up');
    check(await count('#ccSeats .cc-seat[data-state="spoke"]') === 0, 'no seat has spoken at a fresh table');

    await until("document.querySelectorAll('#ccSeatList li').length > 0");
    await ev("document.getElementById('ccCustomName').value = 'Accountant'; document.getElementById('ccCustomBrief').value = 'Count the cost.'; document.getElementById('ccCustomForm').requestSubmit()");
    check(await until("[...document.querySelectorAll('#ccSeats .cc-plaque')].some(p => p.textContent === 'Accountant') || [...document.querySelectorAll('#ccSeatList b')].some(b => b.textContent === 'Accountant')"), 'a custom advisor joins the council');
    check(await ev("shellby.councilView().then(v => v.settings.custom.length === 1 && v.settings.seated.length === " + (SEATS + 1) + ')'), 'main keeps the new seat');
  } catch (e) {
    console.error('failed:', e.message);
    fails++;
  } finally {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    setTimeout(() => {
      fs.rmSync(profile, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
      process.exit(fails ? 1 : 0);
    }, 1200);
  }
})();
