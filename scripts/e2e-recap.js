// ci: While you were away, from scripted idle readings: finished, failed and asking
// End-to-end check of "While you were away" against the dev app over CDP, with
// the fake CLI. Idle readings come from dev:away (SHELLBY_RECAP_TEST) instead of
// Windows: two hours away, during which one task finishes, one fails and one
// asks a question, then back at the keyboard. The recap lists all three, a row
// opens its conversation, and a short absence or the setting turned off says nothing.
//   node scripts/e2e-recap.js [screenshot.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9361;
const H = 3600e3;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47991', SHELLBY_RECAP_TEST: '1' },
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
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(200); } return false; };
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    const recapUp = () => ev("!!document.querySelector('.recap:not(.leaving)')");

    // 1. Gone for two hours, during which three conversations get somewhere.
    await ev(`shellby.devAway({ idleMs: ${2 * H} })`);
    const task = async (prompt) => {
      await ev('SB.newTab()');
      const tabId = await ev('SB.state.activeTab');
      await ev(`SB.send(${JSON.stringify(prompt)})`);
      return tabId;
    };
    await task('build the thing');
    const failedTab = await task('fail');
    await task('ask');
    check(await until("shellby.listSessions().then(l => l.filter(s => s.lastOutcome).length >= 2)"), 'two turns ended while away');
    await wait(800); // the question lands
    check(!(await recapUp()), 'no recap while you are still away');

    // 2. Back at the keyboard.
    await ev('shellby.devAway({ idleMs: 0 })');
    check(await until("!!document.querySelector('.recap')"), 'the recap appears on return');
    const card = await ev(`(() => {
      const c = document.querySelector('.recap');
      const secs = Object.fromEntries([...c.querySelectorAll('.recap-sec')].map(s => [s.querySelector('h4').textContent.replace(/[^A-Za-z ]/g, '').trim(), s.querySelectorAll('.recap-row').length]));
      return { eyebrow: c.querySelector('.cel-eyebrow').textContent, secs, waiting: c.querySelector('.recap-row.wait small')?.textContent };
    })()`);
    check(/While you were away · 2h/.test(card.eyebrow), `eyebrow says how long (${card.eyebrow})`);
    check(card.secs.Finished === 1, `one finished (${JSON.stringify(card.secs)})`);
    check(card.secs.Failed === 1, 'one failed');
    check(card.secs['Waiting on you'] === 1 && card.waiting === 'has a question', `one waiting with a question (${card.waiting})`);

    check(await ev("getComputedStyle(document.querySelector('.recap-host')).visibility === (document.body.classList.contains('celebrating') ? 'hidden' : 'visible')"), 'a trophy celebration hides the recap until it has gone');
    if (process.argv[2]) {
      console.log(`panel is ${await ev('document.visibilityState')}`);
      await ev('SB.clearCelebrations()');
      await wait(700);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.argv[2], Buffer.from(shot.data, 'base64'));
      console.log(`saved ${process.argv[2]}`);
    }

    // 3. A row opens its conversation and puts the card away.
    await ev("document.querySelector('.recap-row.fail button').click()");
    check(await until(`SB.state.activeTab === ${JSON.stringify(failedTab)}`), 'clicking the failed row opens that conversation');
    check(await until("!document.querySelector('.recap')", 2000), 'and dismisses the card');

    // 4. A short break says nothing.
    await ev(`shellby.devAway({ idleMs: ${20 * 60e3} })`);
    await ev('shellby.devAway({ idleMs: 0 })');
    await wait(600);
    check(!(await recapUp()), 'twenty minutes away: no recap');

    // 5. Turned off in Settings: nothing, however long.
    await ev('shellby.setSettings({ recap: false })');
    await ev(`shellby.devAway({ idleMs: ${3 * H} })`);
    await ev('shellby.devAway({ idleMs: 0 })');
    await wait(600);
    check(!(await recapUp()), 'setting off: no recap');

    // 6. The usage block, from a digest shaped like recap.build()'s (the fake CLI's window never moves).
    const now = Date.now();
    const none = { items: [], more: 0 };
    await ev(`SB.showRecap(${JSON.stringify({
      since: now - 3 * H, until: now, awayMs: 3 * H, waiting: none, failed: none,
      finished: { items: [{ tabId: null, title: 'Nightly tests', routine: true, runs: 3, at: now - H }], more: 0 },
      usage: { spent: 21, from: 20, to: 41, resetsAt: now + 2 * H, rolledOver: false, by: [{ tabId: 'a', title: 'Nightly tests', pct: 18 }, { tabId: 'b', title: 'Fix login', pct: 3 }] },
      limit: null,
    })})`);
    const usage = await ev("({ segs: document.querySelectorAll('.recap-bar i').length, text: document.querySelector('.recap .recap-text').textContent })");
    check(usage.segs === 2 && /About 21% .* \(20% → 41%\)/.test(usage.text), `usage split by conversation (${usage.text})`);
    if (process.argv[2]) {
      await wait(700);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.argv[2].replace(/\.png$/, '-usage.png'), Buffer.from(shot.data, 'base64'));
    }
  } catch (err) {
    console.log('FAIL ', err.stack || err.message);
    fails++;
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
