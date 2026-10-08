// ci: the workflow-scope toggle: gated, never on by default
// The "…including changes to CI workflows" toggle, which is what asks GitHub for
// the `workflow` scope: present, gated on "Let Claude tasks push", never on by
// default, and saying the right thing in each state. The panel is driven with a
// fake signed-in view, so no account and no network are involved.
//   node scripts/e2e-github-workflows.js
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..'), PORT = 9387;
const wait = ms => new Promise(r => setTimeout(r, ms));

const view = ({ claude, workflows }) => JSON.stringify({
  signedIn: true, login: 'x-salmon', name: 'Salmon', avatar: null, flow: null, encryption: true,
  syncing: false, lastSyncAt: Date.now(), lastSyncError: null,
  features: {
    profile: { on: true, granted: true },
    sync: { on: true, granted: true },
    friends: { on: false, granted: false },
    publish: { on: false, granted: false },
    ci: { on: false, granted: false },
    claude: { on: claude, granted: claude },
    workflows: { on: workflows, granted: workflows },
  },
});

(async () => {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`],
    { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-wf-')) } });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
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
    await wait(3000);

    check(await ev("!!document.getElementById('ghWorkflows')"), 'the toggle exists');

    // Tasks can't push at all: the workflow toggle is unavailable and says why.
    let s = await ev(`(() => { SB.github.render(${view({ claude: false, workflows: false })});
      const el = document.getElementById('ghWorkflows');
      return { disabled: el.disabled, checked: el.checked, note: document.getElementById('ghWorkflowsNote').textContent }; })()`);
    check(s.disabled === true, 'disabled until "Let Claude tasks push" is on');
    check(/Needs "Let Claude tasks push" first/.test(s.note), `and says so (${JSON.stringify(s.note)})`);

    // Tasks can push, workflows not granted yet: available, explains the refusal.
    s = await ev(`(() => { SB.github.render(${view({ claude: true, workflows: false })});
      const el = document.getElementById('ghWorkflows');
      return { disabled: el.disabled, checked: el.checked, note: document.getElementById('ghWorkflowsNote').textContent }; })()`);
    check(s.disabled === false, 'available once tasks can push');
    check(s.checked === false, 'off by default — never granted silently');
    check(/refuses any push that changes a file in \.github\/workflows/.test(s.note), 'explains what GitHub refuses without it');

    // Granted.
    s = await ev(`(() => { SB.github.render(${view({ claude: true, workflows: true })});
      const el = document.getElementById('ghWorkflows');
      return { checked: el.checked, note: document.getElementById('ghWorkflowsNote').textContent }; })()`);
    check(s.checked === true, 'checked when granted');
    check(/secrets/.test(s.note), 'and keeps the secrets warning in front of you');
  } catch (e) {
    check(false, e.message);
  } finally { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); }
  await wait(700);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
