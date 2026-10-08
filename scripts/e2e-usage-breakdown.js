// The usage meters say who filled them: clicking 5h/7d opens a breakdown by tab
// and routine, or by project. Seeds a routine's spend from earlier, then runs a
// real (fake-CLI) conversation and checks it lands in the breakdown too.
// No Claude account needed.
//   node scripts/e2e-usage-breakdown.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9361;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const now = Date.now();
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    onboarded: true,
    worktrees: false,
    lastUsage: { kind: 'usage', status: 'allowed', fiveHour: { pct: 42, resetsAt: now + 3 * 3600e3 }, sevenDay: { pct: 61, resetsAt: now + 3 * 86400e3 }, at: now },
    spendLedger: [
      { t: now - 60 * 60e3, k: 'r:nightly', kind: 'routine', label: 'Nightly sweep', project: 'rack-builder', w: 5000 },
      { t: now - 4 * 86400e3, k: 't:old', kind: 'tab', label: 'Last week thing', project: 'old-project', w: 9000 },
    ],
  }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: userData, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47993' },
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
    await wait(3000);
    await ev("SB.setView('chat')");

    // A real turn: the fake CLI replies with token counts and a usage reading.
    await ev("SB.send('Tidy the README')");
    for (let i = 0; i < 30 && !(await ev("!SB.activeTab()?.busy && !!document.querySelector('.msg.assistant')")); i++) await wait(300);
    await wait(500);
    check(await ev("!document.getElementById('usage').hidden"), 'the meters are showing');

    await ev("document.getElementById('usage').click()");
    await wait(600);
    check(await ev("!document.getElementById('usageMenu').hidden"), 'clicking the meters opens the breakdown');
    const rows = await ev("[...document.querySelectorAll('#usageMenu .usage-row .usage-name')].map(e => e.textContent)");
    const labels = await ev("[...document.querySelectorAll('#usageMenu .menu-label')].map(e => e.textContent)");
    check(labels.some(l => /5-hour/.test(l)) && labels.some(l => /weekly/.test(l)), `both windows are listed (${labels.join(' | ')})`);
    // The fake CLI's reading has resets already in the past: a stale percentage isn't shown.
    check(!labels.some(l => /used/.test(l)), 'a reading from before the last reset shows no percentage');
    check(rows.includes('⟳ Nightly sweep'), 'an earlier routine run is in the breakdown');
    check(rows.some(r => /Tidy the README/.test(r)), `the conversation just run is in the breakdown (${rows.join(', ')})`);
    const fiveHourRows = await ev("(() => { const out = []; let inFive = false; for (const el of document.querySelectorAll('#usageMenu > *')) { if (el.classList.contains('menu-label')) inFive = /5-hour/.test(el.textContent); else if (inFive && el.classList.contains('usage-row')) out.push(el.querySelector('.usage-name').textContent); } return out; })()");
    check(!fiveHourRows.includes('Last week thing'), 'spend from before the 5-hour window started is left out of it');
    check(rows.includes('Last week thing'), '...but still counts toward the weekly one');

    await ev("[...document.querySelectorAll('.usage-by-btn')].find(b => /Projects/.test(b.textContent)).click()");
    await wait(300);
    const projects = await ev("[...document.querySelectorAll('#usageMenu .usage-row .usage-name')].map(e => e.textContent)");
    check(projects.includes('rack-builder') && projects.includes('old-project'), `switching to projects groups by folder (${projects.join(', ')})`);

    const shot = await call('Page.captureScreenshot', { format: 'png' });
    const file = path.join(os.tmpdir(), 'shellby-usage-breakdown.png');
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot:', file);

    await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await wait(200);
    check(await ev("document.getElementById('usageMenu').hidden"), 'Escape closes it');
  } catch (e) {
    console.log('FAIL ', e.message);
    fails++;
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
