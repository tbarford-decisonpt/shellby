// End-to-end check of the usage forecast and "after the reset" against the dev
// app over CDP, with the fake CLI. 5-hour readings come from dev:usage
// (SHELLBY_FORECAST_TEST), backdated so a pace builds without an hour's wait.
// A climbing window warns in the composer and on the meter; Ctrl+Shift+Enter
// holds a message, which can be edited back or dropped; at the limit, a held
// message and a held routine both go by themselves once it resets.
//   node scripts/e2e-forecast.js [screenshot.png]
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
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboarded: true, worktrees: false }));

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: userData, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47994', SHELLBY_FORECAST_TEST: '1' },
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
    const call = (method, params) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = expr => call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(m => m.result?.result?.value);
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await wait(250); } return false; };
    const usage = r => ev(`SB.api.devUsage(${JSON.stringify(r)})`);
    await wait(3000);
    await ev("SB.setView('chat')");

    // A real conversation first, so there's a tab for held messages to go back to.
    await ev("SB.send('Tidy the README')");
    await until("!SB.activeTab()?.busy && !!document.querySelector('.msg.assistant')");
    const tabId = await ev('SB.activeTab().id');

    // ---- the forecast: 40% -> 60% in 40 minutes, resets in three hours
    const reset = Date.now() + 3 * H;
    await usage({ pct: 40, minsAgo: 40, resetsAt: reset });
    await usage({ pct: 50, minsAgo: 20, resetsAt: reset });
    const o = await usage({ pct: 60, minsAgo: 0, resetsAt: reset });
    check(/At this pace you'll hit your 5-hour limit around .+\. It resets at .+\./.test(o?.warning?.text || ''), `main forecasts the hit (${o?.warning?.text})`);
    check(o?.pace?.perHour === 30, `at 30 points an hour (${o?.pace?.perHour})`);
    check(await until("!document.getElementById('outlook').hidden"), 'the composer shows the warning');
    check(/at this pace, full around/.test(await ev("document.getElementById('meter5h').title")), 'the 5-hour meter says when it fills');
    check(await ev("document.getElementById('meter5h').classList.contains('warn')"), '...and is marked as worth a glance at 60%');
    check(/Ctrl\+Shift\+Enter/.test(await ev("document.getElementById('outlook').textContent")), 'an empty box gets the shortcut as a hint');

    // Turned off in Settings, it stops warning; on again, it's back.
    await ev('SB.api.setSettings({ forecast: false })');
    check(await until("document.getElementById('outlook').hidden"), 'the setting turns the warning off');
    await ev('SB.api.setSettings({ forecast: true })');
    check(await until("!document.getElementById('outlook').hidden"), '...and back on');

    // ---- holding what's typed: Ctrl+Shift+Enter
    await ev("(() => { const i = document.getElementById('input'); i.value = 'carry on after the reset'; i.dispatchEvent(new Event('input')); })()");
    check(/Send after the reset/.test(await ev("document.getElementById('outlook').textContent")), 'with something typed, the banner offers to send it after the reset');
    await ev("document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))");
    check(await until("!!document.querySelector('#queued .queue-item.held')"), 'Ctrl+Shift+Enter holds it: a chip with the queue');
    check(await ev("document.getElementById('input').value === ''"), '...and clears the box');
    check(await ev("/carry on after the reset/.test(document.querySelector('#queued .queue-item.held').textContent)"), '...showing what it says');
    const heldNow = await ev('SB.api.getOutlook().then(o => o.held)');
    check(heldNow.length === 1 && heldNow[0].tabId === tabId && heldNow[0].at > reset, 'main holds it for this tab, after the reset');

    // Click to edit: back in the box, no longer held.
    await ev("document.querySelector('#queued .queue-item.held .queue-text').click()");
    check(await until("document.getElementById('input').value === 'carry on after the reset'"), 'clicking it puts it back in the box');
    check(await until("!document.querySelector('#queued .queue-item.held')"), '...and it is no longer held');
    // Held again, then ✕ drops it.
    await ev("document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))");
    await until("!!document.querySelector('#queued .queue-item.held')");
    await ev("document.querySelector('#queued .queue-item.held .queue-x').click()");
    check(await until("!document.querySelector('#queued .queue-item.held')"), '✕ drops a held message');
    check((await ev('SB.api.getOutlook().then(o => o.held.length)')) === 0, '...in main too');

    // ---- at the limit: hold a message and a routine, and both go at the reset
    const limitReset = Date.now() + 8000;
    await usage({ pct: 100, minsAgo: 0, resetsAt: limitReset, status: 'rejected' });
    check(await until("/You're at your 5-hour limit until/.test(document.getElementById('outlook').textContent)"), 'at the limit, the banner says until when');

    await ev("(() => { const i = document.getElementById('input'); i.value = 'go once it resets'; i.dispatchEvent(new Event('input')); })()");
    await ev("[...document.querySelectorAll('#outlook button')].find(b => /Send after the reset/.test(b.textContent)).click()");
    check(await until("!!document.querySelector('#queued .queue-item.held')"), "the banner's button holds the message");

    // Ask first, so saving it doesn't stop for the confirm window.
    const saved = await ev("SB.api.saveRoutine({ name: 'Nightly sweep', prompt: 'sweep the floor', schedule: { type: 'daily', time: '03:00' }, mode: 'ask' })");
    check(saved?.ok, 'a routine to hold');
    await ev("SB.setView('routines')");
    await until("!!document.querySelector('.routine')");
    const clock = "[...document.querySelectorAll('.routine-actions button')].find(b => /after the usage reset/.test(b.getAttribute('aria-label') || ''))";
    check(await ev(`!!${clock}`), 'each routine offers to run after the reset');
    await ev(`${clock}.click()`);
    check(await until("/after reset/.test(document.querySelector('.r-pill.held')?.textContent || '')"), 'a held routine says so');
    await ev('SB.clearCelebrations()'); // the first task's trophy card would cover the screenshots
    if (process.argv[2]) {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.argv[2].replace(/\.png$/, '-routines.png'), Buffer.from(shot.result.data, 'base64'));
    }
    await ev("SB.setView('chat')");
    await ev(`SB.activate(${JSON.stringify(tabId)})`);
    if (process.argv[2]) {
      await wait(300);
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.argv[2], Buffer.from(shot.result.data, 'base64'));
      console.log('screenshots:', process.argv[2]);
    }

    // The reset: the message goes back to its conversation, the routine opens its own tab.
    check(await until("[...document.querySelectorAll('.msg.user')].some(m => /go once it resets/.test(m.textContent))", 25000), 'after the reset the held message is sent in its conversation');
    check(await until('[...SB.state.tabs.values()].some(t => /Nightly sweep/.test(t.title))', 15000), '...and the held routine runs');
    check(await until("!document.querySelector('#queued .queue-item.held')"), 'nothing is left held');
    check((await ev('SB.api.getOutlook().then(o => o.held.length)')) === 0, '...in main either');
    check(await until("document.getElementById('outlook').hidden"), 'the limit banner is gone');
  } catch (e) {
    console.log('FAIL ', e.message);
    fails++;
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
