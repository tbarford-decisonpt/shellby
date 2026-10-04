// End-to-end check of Claude's other help with routines, against the dev app
// over CDP, driven by the fake Claude CLI (test/fixtures/fake-claude.js): no
// account, no usage. Describe it fills the editor; a routine whose run failed
// gets Fix with Claude, which opens a corrected routine as an edit with what
// Claude changed in the chat; and a request that needs a workflow is handed to
// the workflow builder. The editor's chat and its test runs are
// e2e-routine-chat.js.
//   node scripts/e2e-routines.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9364;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: userData, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47994' },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const ws = new WebSocket(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let n = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
    const ev = expr => new Promise(r => { const i = ++n; pending.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    const until = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const describe = words => ev(`(() => { document.getElementById('routineAskText').value = ${JSON.stringify(words)}; document.getElementById('routineAskBtn').click(); return true; })()`);

    await wait(3000);
    check(await until("typeof shellby !== 'undefined' && !!SB.state?.settings", 20000), 'the panel is up');
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('routines'); })");
    check(await until("document.getElementById('routinesView')?.offsetParent !== null"), 'the Routines page opens');

    // 1. Describe it fills the editor, with the chat ready beside it.
    await describe('every morning, what changed in my Documents');
    check(await until("!document.getElementById('routineWork').hidden && document.querySelector('#routineEditor [name=name]').value === 'Morning summary'"), 'Describe it fills in the editor');
    check(await ev("!!document.querySelector('#routineWork .wf-chat')"), 'the chat opens with it');
    check(await ev("document.getElementById('routineAsWorkflow').hidden"), 'no workflow suggestion for a plain chore');
    await ev("document.getElementById('routineCancel').click()");

    // 2. A routine whose run fails gets Fix with Claude.
    const failing = JSON.parse(await ev("shellby.saveRoutine({ name: 'Broken one', prompt: 'fail', mode: 'plan', schedule: { type: 'daily', time: '07:00' } }).then(r => JSON.stringify(r.routine))"));
    check(!!failing?.id, 'a routine is saved');
    await ev(`shellby.runRoutine(${JSON.stringify(failing.id)})`);
    check(await until(`shellby.listRoutines().then(l => l.find(r => r.id === ${JSON.stringify(failing.id)})?.lastStatus === 'error')`), 'its run fails');
    await ev("SB.setView('routines')");
    check(await until("document.querySelectorAll('#routineList .r-fix').length === 1"), 'it gets a Fix with Claude button');
    await ev("document.querySelector('#routineList .r-fix').click()");
    check(await until("!document.getElementById('routineWork').hidden && /Edit/.test(document.getElementById('routineEditorTitle').textContent)"), 'the fix opens in the editor, as an edit of that routine');
    check(await until("/isn't there/.test(document.querySelector('#routineWork .wf-chat').innerText)"), 'with what Claude changed in the chat');
    check(await ev("/Documents/.test(document.querySelector('#routineEditor [name=prompt]').value)"), 'and its corrected instruction');
    check((await ev(`shellby.listRoutines().then(l => l.find(r => r.id === ${JSON.stringify(failing.id)}).prompt)`)) === 'fail', 'nothing is saved until you press Save');
    await ev("document.getElementById('routineCancel').click()");

    // 3. Something a routine can't do is handed to the workflow builder.
    await describe('when a build fails on my repo, find out why');
    check(await until("!document.getElementById('routineAsWorkflow').hidden"), 'Claude suggests a workflow instead');
    check(/build fails/.test(await ev("document.getElementById('routineAskNote').textContent")), 'and says why');
    await ev("document.getElementById('routineAsWorkflow').click()");
    check(await until("SB.state.view === 'workflows' && /Drafted workflow/.test(document.getElementById('workflowsView').innerText)"), 'the workflow editor opens with a draft');
    check(await ev("document.getElementById('routineWork').hidden"), 'and the routine editor closed behind it');
  } catch (e) {
    console.log('FAIL  crashed:', e.stack || e.message);
    fails++;
  } finally {
    // The whole tree: Electron's helpers and any fake sessions.
    try { execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { app.kill(); }
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
