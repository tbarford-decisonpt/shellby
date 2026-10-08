// End-to-end check of new tricks against the dev app over CDP, with the fake
// CLI (which says it's Claude Code 2.1.290) and a changelog served from here
// (SHELLBY_CHANGELOG_URL), so no network. Shellby last saw 2.1.288: the card
// lists what's new since, Try it puts a question in a new tab's box without
// sending it, Got it puts the card away for good, and with the setting off
// nothing is read at all.
//   node scripts/e2e-claude-tricks.js [screenshot.png]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9367;
const wait = ms => new Promise(r => setTimeout(r, ms));

const CHANGELOG = `# Changelog

## 2.1.290

- Added \`/recap\` to sum up a long session
- Fixed a leak

## 2.1.289

- Improved startup
- [Claude Tag] Fixed Slack

## 2.1.288

- Added something already seen
`;

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

  let reads = 0;
  const server = http.createServer((req, res) => {
    reads++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(CHANGELOG);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/CHANGELOG.md`;

  const launch = settings => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, claudeTricksState: { lastSeen: '2.1.288' }, ...settings }));
    return spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
      stdio: 'ignore',
      env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47993', SHELLBY_CHANGELOG_URL: url },
    });
  };
  const connect = async () => {
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
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(200); } return false; };
    return { ws, send, ev, until };
  };
  const quit = async app => { app.kill(); await new Promise(r => app.once('exit', r)); await wait(500); };

  let app = launch({});
  try {
    const { ws, send, ev, until } = await connect();
    // Boot reads the version, then the changelog; the panel may already be up.
    check(await until("!!document.querySelector('.tricks:not(.leaving)')", 15000), 'the new tricks card appears by itself');
    const card = await ev(`(() => {
      const c = document.querySelector('.tricks');
      return {
        eyebrow: c.querySelector('.cel-eyebrow').textContent,
        title: c.querySelector('.recap-title').textContent,
        rows: [...c.querySelectorAll('.tricks-row')].map(r => ({ kind: r.className, text: r.querySelector('.tricks-text').textContent, tryIt: !!r.querySelector('.tricks-try') })),
        code: !!c.querySelector('.tricks-text code'),
      };
    })()`);
    check(card.eyebrow === 'New in Claude Code · 2.1.290', `eyebrow names the version (${card.eyebrow})`);
    check(card.title === '1 new thing Claude can do', `title counts the new features (${card.title})`);
    check(card.rows.length === 2, `two highlights: the new command and the improvement (${JSON.stringify(card.rows.map(r => r.text))})`);
    check(card.rows[0]?.tryIt && !card.rows[1]?.tryIt, 'only the new feature offers Try it');
    check(!card.rows.some(r => /Slack|leak|already seen/.test(r.text)), 'no fixes, other products or older releases');
    check(card.code, 'code in a line is drawn as code');
    check(reads === 1, `the changelog was read once (${reads})`);

    if (process.argv[2]) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.argv[2], Buffer.from(shot.data, 'base64'));
      console.log(`saved ${process.argv[2]}`);
    }

    // Try it: a question in a new tab's box, not sent.
    const tabsBefore = await ev('SB.state.tabs.size');
    await ev("document.querySelector('.tricks-try').click()");
    check(await until("document.getElementById('input').value.includes('Claude Code just added this')"), 'Try it puts the question in the box');
    check(await ev("document.getElementById('input').value.includes('/recap')"), 'about the feature it was next to');
    check(await ev(`SB.state.tabs.size >= ${tabsBefore} && !SB.activeTab().busy`), 'nothing was sent');
    check(await until("!document.querySelector('.tricks')", 3000), 'the card goes away');
    check(await until('shellby.bootstrap().then(b => !b.claudeTricks)'), 'and stays away (dismissed in main)');
    ws.close();
  } finally {
    await quit(app);
  }

  // Turned off: the update is noted, the changelog never read.
  reads = 0;
  app = launch({ claudeTricks: false });
  try {
    const { ws, ev } = await connect();
    await wait(4000);
    check(reads === 0, 'with the setting off, the changelog is not read');
    check(await ev("!document.querySelector('.tricks')"), 'and no card');
    ws.close();
  } finally {
    await quit(app);
    server.close();
  }

  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
