// ci: plain words: what a step does on its card, warnings, a plan's size, the Working bar, off
// End-to-end check of plain words against the dev app over CDP, with the fake
// CLI: a permission card says what the step does ("Delete 1 file or folder")
// and warns about a file outside the project, a plan card says how big the plan
// is, the Working bar says "Running your tests…" while they run, and with the
// setting off the cards go back to Claude Code's own names for the steps.
//   node scripts/e2e-plain-cards.js [screenshot.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9368;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47994' },
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
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    await wait(2500);
    await ev("SB.setView('chat')");

    const ask = async prompt => {
      await ev('SB.newTab()');
      await ev(`SB.send(${JSON.stringify(prompt)})`);
      await until('!!SB.activeTab().el.querySelector(".ask .ask-sub")');
      return ev(`(() => {
        const c = [...SB.activeTab().el.querySelectorAll('.ask')].pop();
        return { sub: c.querySelector('.ask-sub').textContent, flags: [...c.querySelectorAll('.ask-flag')].map(f => f.textContent), cmd: c.querySelector('.ask-cmd')?.textContent || null };
      })()`);
    };
    const answer = async (cls, done) => {
      await ev(`[...SB.activeTab().el.querySelectorAll('.ask')].pop().querySelector('.btn.${cls}').click()`);
      return until(`SB.activeTab().el.textContent.includes(${JSON.stringify(done)})`);
    };

    // 1. A delete outside the project.
    const del = await ask('askdelete');
    check(del.sub === 'Delete 1 file or folder', `the card says what it does (${del.sub})`);
    check(del.flags.length === 1 && /Heads up: Reaches outside the project: C:\\Users\\someone\\notes\.txt\./.test(del.flags[0]), `one warning, the path outside the project (${JSON.stringify(del.flags)})`);
    check(/Remove-Item/.test(del.cmd || ''), 'the command itself is still shown');
    if (process.argv[2]) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.argv[2], Buffer.from(shot.data, 'base64'));
      console.log(`saved ${process.argv[2]}`);
    }
    check(await answer('deny', 'KEPT'), 'denying still works');

    // 2. A plan.
    const plan = await ask('askplan');
    check(plan.sub === '3 steps · names 2 files. Nothing changes until you approve.', `the plan card says its size (${plan.sub})`);
    check(await answer('deny', 'STILL PLANNING'), 'Keep planning still works');

    // 3. A test run that takes a while.
    await ev('SB.newTab()');
    await ev("SB.send('longtests')");
    check(await until("document.getElementById('statusText').textContent === 'Running your tests…'"), 'the Working bar says what it is doing');
    check(await until("SB.activeTab().el.textContent.includes('TESTS DONE')"), 'the run finishes');

    // 4. Turned off: Claude Code's own names again.
    await ev('shellby.setSettings({ plainCards: false }).then(r => { SB.state.settings = r.settings; })');
    const raw = await ask('askdelete');
    check(raw.sub === 'Ran · PowerShell', `with the setting off, the step's own name (${raw.sub})`);
    check(!raw.flags.some(f => f.startsWith('Heads up')), 'and no plain-word warnings');
    await answer('deny', 'KEPT');
    ws.close();
  } finally {
    app.kill();
    await new Promise(r => app.once('exit', r));
  }

  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
