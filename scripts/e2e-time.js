// End-to-end check of the Time page against the dev app over CDP (throwaway
// profile). Seeds a week of tracked time for this repository, then checks the
// page: the total, the chart, the project and its commits from git, rounding
// and rate, adding time by hand, the switch with History, and that a timesheet
// PDF really renders (in the main process, through the same hidden window).
//   node scripts/e2e-time.js [screenshot.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9351;
const INSPECT = 9352;
const wait = ms => new Promise(r => setTimeout(r, ms));
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { ws, send, ev };
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const key = ROOT.toLowerCase();
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 24 * 60 * 60 * 1000);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    onboarded: false, crabOnly: true,
    streaks: { days: [], projects: { [key]: { name: 'shellby', lastSeen: Date.now() } } },
    timeTracking: {
      enabled: true, roundMinutes: 15, currency: 'USD',
      projects: { [key]: { name: 'shellby', client: 'Harbor Tree', rate: 100 } },
      days: { [today]: { [key]: 80 * 60 }, [yesterday]: { [key]: 2 * 3600 + 7 * 60 } },
      notes: { [yesterday]: { [key]: 'Time tracker design' } },
    },
  }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [`--inspect=${INSPECT}`, ROOT, `--remote-debugging-port=${PORT}`],
    { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile } });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const { send, ev } = await cdp(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await wait(2500);
    await ev("SB.setView('time')");
    const ready = async () => { for (let i = 0; i < 40; i++) { if (await ev("document.querySelectorAll('#timeProjects .tm-project').length")) return true; await wait(250); } return false; };
    check(await ready(), 'the Time page lists a project');

    const total = await ev("document.getElementById('timeTotal').textContent");
    check(/^3h 27m this week$/.test(total), `the week's total (${total})`);
    const bars = await ev("document.querySelectorAll('#timeChart .tm-bar').length");
    const dow = (new Date().getDay() + 6) % 7;
    check(bars === dow + 1, `a bar for each day so far this week (${bars})`);
    const tip = await ev("[...document.querySelectorAll('#timeChart .tm-bar')].pop().getAttribute('aria-label') || [...document.querySelectorAll('#timeChart .tm-bar')].pop().dataset.tip");
    check(/1h 20m/.test(tip || ''), `today's bar says its hours (${tip})`);
    const amount = await ev("document.getElementById('timeAmount').textContent");
    // 80 min -> 1:15, 127 min -> 2:00 at 15-minute rounding: 3.25 h x $100
    check(/\$325\.00/.test(amount) && /3\.25 billable h/.test(amount), `rounded and billed (${amount})`);

    await ev("document.querySelector('#timeProjects details').open = true");
    await wait(200);
    const commits = await ev("document.querySelectorAll('#timeProjects .tm-commits').length");
    check(commits > 0, `git commits show on their days (${commits} days with commits)`);
    const note = await ev(`[...document.querySelectorAll('#timeProjects .tm-note')].map(i => i.value).includes('Time tracker design')`);
    check(note, 'the note is on its day');

    await ev("document.getElementById('timeRound').value = '30|up'; document.getElementById('timeRound').dispatchEvent(new Event('change'))");
    await wait(800);
    const up = await ev("document.getElementById('timeAmount').textContent");
    check(/\$400\.00/.test(up), `rounding up to 30 minutes changes the bill (${up})`);

    // Add 45 minutes to today by hand.
    await ev(`(() => {
      document.getElementById('timeAddHours').value = '0';
      document.getElementById('timeAddMinutes').value = '45';
      document.getElementById('timeAddNote').value = 'Client call';
      document.getElementById('timeAdd').requestSubmit();
    })()`);
    await wait(900);
    const after = await ev("document.getElementById('timeTotal').textContent");
    check(/^4h 12m this week$/.test(after), `time added by hand counts (${after})`);
    const bad = await ev("shellby.addTime({ key: 'c:\\\\not\\\\a\\\\project', day: '2026-01-01', minutes: 30 }).then(r => r.ok)");
    check(bad === false, 'time for an unknown project is refused');
    const future = await ev(`shellby.addTime({ key: ${JSON.stringify(key)}, day: '2999-01-01', minutes: 30 }).then(r => r.ok)`);
    check(future === false, 'time in the future is refused');

    const out = process.argv[2] || path.join(os.tmpdir(), 'shellby-time.png');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot?.data) { fs.writeFileSync(out, Buffer.from(shot.data, 'base64')); console.log(`screenshot: ${out}`); }

    await ev("document.getElementById('timeProjects').scrollIntoView()");
    await wait(300);
    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    if (shot2?.data) fs.writeFileSync(out.replace(/\.png$/, '-days.png'), Buffer.from(shot2.data, 'base64'));
    await ev("document.getElementById('timeView').scrollTop = 1e6");
    await wait(300);
    const shot3 = await send('Page.captureScreenshot', { format: 'png' });
    if (shot3?.data) fs.writeFileSync(out.replace(/\.png$/, '-forms.png'), Buffer.from(shot3.data, 'base64'));

    await ev("document.querySelector('#timeView [data-goto-view=\"history\"]').click()");
    await wait(300);
    check(await ev("document.body.dataset.view") === 'history', 'Conversations goes to History');
    check(await ev("document.querySelector('[data-view-btn=\"history\"].dock-btn').getAttribute('aria-current')") === 'page', 'the History dock button stays lit on both');

    // The timesheet PDF, rendered by the main process exactly as Save PDF does.
    const targets = await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json();
    const main = await cdp(targets[0].webSocketDebuggerUrl);
    const pdfPath = path.join(profile, 'timesheet.pdf');
    const r = await main.ev(`(async () => { try {
      const req = process.mainModule.require;
      const { BrowserWindow, app } = req('electron');
      const { TimeTracker } = req(${JSON.stringify(path.join(ROOT, 'src', 'main', 'timetrack-service.js'))});
      const { timesheetHtml } = req(${JSON.stringify(path.join(ROOT, 'src', 'main', 'timesheet.js'))});
      const tt = req(${JSON.stringify(path.join(ROOT, 'src', 'main', 'timetrack.js'))});
      const state = tt.normalize(JSON.parse(req('fs').readFileSync(${JSON.stringify(path.join(profile, 'settings.json'))}, 'utf8')).timeTracking);
      const week = tt.ranges(Date.now()).find(x => x.id === 'week');
      const html = timesheetHtml(tt.summarize(state, week), { label: 'This week', preparedBy: 'E2E' });
      const t = new TimeTracker({ config: { get: () => null }, electron: { BrowserWindow, app } });
      const pdf = await t.renderPdf(html);
      req('fs').writeFileSync(${JSON.stringify(pdfPath)}, pdf);
      return pdf.length;
    } catch (e) { return 'error: ' + (e && e.stack || e); } })()`);
    const head = fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath).subarray(0, 5).toString() : '';
    check(head === '%PDF-' && r > 1000, `the timesheet renders to a PDF (${r} bytes)`);
    main.ws.close();
  } catch (e) {
    check(false, e.stack || e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exitCode = fails ? 1 : 0;
})();
