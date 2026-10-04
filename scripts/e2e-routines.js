// End-to-end check of Claude's help with routines against the dev app over CDP,
// driven by the fake Claude CLI (test/fixtures/fake-claude.js): no account, no
// usage. Describe it fills the editor; the editor's chat changes it and
// dry-runs it in Plan mode, where a permission is refused on the spot; a
// failed routine gets Fix with Claude; a request that needs a workflow is
// handed to the workflow builder; and the workflow editor's own chat still
// builds, tests and fixes.
//   node scripts/e2e-routines.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9363;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: userData, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47998' },
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
    const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`);
    // Typing into a chat box the way a person does: the chat reads its input event.
    const say = (scope, words) => ev(`(() => {
      const box = document.querySelector(${JSON.stringify(`${scope} .wf-chat-text`)});
      box.value = ${JSON.stringify(words)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector(${JSON.stringify(`${scope} .wf-chat-form button[type=submit]`)}).click();
      return true;
    })()`);

    await wait(3000);
    check(await until("typeof shellby !== 'undefined' && !!SB.state?.settings", 20000), 'the panel is up');
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('routines'); })");
    check(await until("document.getElementById('routinesView')?.offsetParent !== null"), 'the Routines page opens');

    // 1. Describe it fills the editor and opens the chat beside it.
    await ev(`(() => { document.getElementById('routineAskText').value = 'every morning, what changed in my Documents'; document.getElementById('routineAskBtn').click(); return true; })()`);
    check(await until("!document.getElementById('routineEditor').hidden && document.querySelector('#routineEditor [name=name]').value === 'Morning briefing'"), 'Describe it fills in the editor');
    check(await ev("document.querySelector('#routineEditor [name=mode]').value === 'plan'"), 'with the mode Claude chose');
    check(await ev("!document.getElementById('routineChatSlot').hidden && !!document.querySelector('#routineChatSlot .wf-chat')"), 'the chat opens under it');
    check(await ev("document.getElementById('routineAsWorkflow').hidden"), 'no workflow suggestion for a plain chore');

    // 2. The chat changes the routine, dry-runs it, reads the run and says it's right.
    await say('#routineChatSlot', 'weekdays only');
    check(await until("document.querySelector('#routineEditor [name=type]').value === 'weekly'"), 'Claude\'s change shows in the editor');
    check(await ev("[...document.querySelectorAll('#routineEditor input[name=day]:checked')].map(c => c.value).join() === '1,2,3,4,5'"), 'weekdays are ticked');
    check(await until("[...SB.state.tabs.values()].some(t => /Dry run: Morning briefing/.test(t.title))"), 'a dry run opens its own tab');
    check(await until("/The dry run worked/.test(document.getElementById('routineChatSlot').innerText)", 20000), 'the dry run comes back to the chat');
    check(await until("/looked in the right place/.test(document.getElementById('routineChatSlot').innerText)", 20000), 'Claude reads it and answers');
    check(await until("!document.querySelector('#routineChatSlot .wf-chat').classList.contains('busy')"), 'and stops there');
    const dry = await ev("(() => { const t = [...SB.state.tabs.values()].find(x => /Dry run/.test(x.title)); return t && t.id; })()");
    check((await ev(`shellby.getRoutineTest(${JSON.stringify(dry)}).then(t => t && t.status)`)) === 'ok', 'the dry run finished ok');
    check((await ev('shellby.listRoutines().then(l => l.length)')) === 0, 'nothing was saved by the chat');

    // 3. A dry run refuses a permission by itself instead of waiting for you.
    const perm = JSON.parse(await ev("shellby.testRoutine({ name: 'Perm', prompt: 'tool write a file', schedule: { type: 'daily', time: '09:00' }, cwd: null }).then(r => JSON.stringify(r))"));
    check(perm.ok, `a dry run starts from the bridge (${perm.error || ''})`);
    check(await until(`shellby.getRoutineTest(${JSON.stringify(perm.runId)}).then(t => t && t.status === 'ok')`), 'its permission was refused and it finished');
    // Its transcript, as History keeps it: the refusal, then the fake's answer to it.
    const lines = fs.readFileSync(path.join(userData, 'sessions', `${perm.runId}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    check(lines.some(i => i.kind === 'decision' && i.decision === 'deny'), 'the permission was refused');
    check(lines.some(i => i.kind === 'text' && /DENIED/.test(i.text)), 'and the run carried on without it');

    // 3b. The fence: an edit that would never ask (the work hook sees it first) is refused too.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-dry-'));
    const target = path.join(work, 'dry.txt');
    const fenced = JSON.parse(await ev(`shellby.testRoutine({ name: 'Fenced', prompt: ${JSON.stringify(`editabs ${target} should-not-exist`)}, schedule: { type: 'daily', time: '09:00' }, cwd: ${JSON.stringify(work)} }).then(r => JSON.stringify(r))`));
    check(fenced.ok, `a dry run with an edit starts (${fenced.error || ''})`);
    check(await until(`shellby.getRoutineTest(${JSON.stringify(fenced.runId)}).then(t => t && t.status !== 'running')`), 'it finishes');
    check(!fs.existsSync(target), 'the file was not written');
    const fencedLines = fs.readFileSync(path.join(userData, 'sessions', `${fenced.runId}.jsonl`), 'utf8');
    check(/fenced: This is a dry run/.test(fencedLines), 'the fence said why');

    // 4. Save it; then a routine whose run fails gets Fix with Claude.
    await ev("document.querySelector('#routineEditor button[type=submit]').click()");
    check(await until('shellby.listRoutines().then(l => l.length === 1)'), 'Save keeps the chat\'s version');
    check((await ev("shellby.listRoutines().then(l => l[0].schedule.type)")) === 'weekly', 'as weekly');
    const failing = JSON.parse(await ev("shellby.saveRoutine({ name: 'Broken one', prompt: 'fail', mode: 'plan', schedule: { type: 'daily', time: '07:00' } }).then(r => JSON.stringify(r.routine))"));
    await ev(`shellby.runRoutine(${JSON.stringify(failing.id)})`);
    check(await until(`shellby.listRoutines().then(l => l.find(r => r.id === ${JSON.stringify(failing.id)})?.lastStatus === 'error')`), 'the failing routine is marked failed');
    await ev("SB.setView('routines')");
    check(await until("[...document.querySelectorAll('#routineList .r-fix')].length === 1"), 'it gets a Fix with Claude button');
    await ev("document.querySelector('#routineList .r-fix').click()");
    check(await until("!document.getElementById('routineEditor').hidden && /Edit/.test(document.getElementById('routineEditorTitle').textContent)"), 'the fix opens in the editor, as an edit');
    check(await until("/isn't there/.test(document.getElementById('routineChatSlot').innerText)"), 'with what Claude changed in the chat');
    check(await ev("document.querySelector('#routineEditor [name=mode]').value === 'plan'"), '"unchanged" kept its mode');
    await ev("document.getElementById('routineCancel').click()");

    // 5. Something a routine can't do is handed to the workflow builder.
    await ev(`(() => { document.getElementById('routineAskText').value = 'when a build fails on my repo, find out why'; document.getElementById('routineAskBtn').click(); return true; })()`);
    check(await until("!document.getElementById('routineAsWorkflow').hidden"), 'Claude suggests a workflow instead');
    check(/build fails/.test(await text('#routineAskNote')), 'and says why');
    await ev("document.getElementById('routineAsWorkflow').click()");
    check(await until("SB.state.view === 'workflows' && /Drafted workflow/.test(document.getElementById('workflowsView').innerText)"), 'the workflow editor opens with a draft');
    check(await ev("document.getElementById('routineEditor').hidden"), 'the routine editor closed');

    // 6. The workflow editor's own chat still builds, tests and fixes (wf-chat.js is shared now).
    await say('#workflowsView', 'say good morning at nine');
    check(await until("/The test run failed/.test(document.getElementById('workflowsView').innerText)", 20000), 'the workflow chat tests its first try');
    check(await until("/The test run worked/.test(document.getElementById('workflowsView').innerText)", 30000), 'and fixes it until it works');
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
