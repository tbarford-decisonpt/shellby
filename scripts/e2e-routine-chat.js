// ci: Build it with Claude on routines: fill the form, test in a tab, read it, Save switches it on; the workflow chat too
// End-to-end check of Build it with Claude on the routine editor, against the
// dev app over CDP, driven by the fake Claude CLI (test/fixtures/fake-claude.js):
// no account, no usage. Says what it wants in the chat, watches Claude fill in
// the form, test the routine in its own tab (saved switched off), read the run
// and say it worked; then Save switches it on. Also checks the editor keeps one
// chat when another routine is opened, and that the workflow editor's chat
// (the same component) still answers.
//   node scripts/e2e-routine-chat.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9363;
const HOOK_PORT = 47995;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: userData, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK_PORT) },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const target = list.find(t => t.url.endsWith('panel.html'));
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
    const ev = expr => new Promise(r => { const i = ++id; pending.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    const until = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(200); } return false; };
    const routines = async () => JSON.parse(await ev('shellby.listRoutines().then(l => JSON.stringify(l))'));
    // Type into a chat box and send it, the way a person would.
    const say = (scope, text) => ev(`(() => {
      const box = document.querySelector('${scope} .wf-chat-text');
      box.value = ${JSON.stringify(text)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.closest('form').requestSubmit();
      return true;
    })()`);
    const chatText = scope => ev(`document.querySelector('${scope} .wf-chat-log')?.innerText || ''`);

    await wait(3000);
    check(await until("typeof shellby !== 'undefined' && typeof shellby.chatRoutine === 'function'", 20000), 'the routine chat is on the bridge');
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('routines'); })");
    check(await until("document.getElementById('routinesView')?.offsetParent !== null"), 'the Routines page opens');

    // 1. A new routine opens with the chat beside the form.
    await ev("document.getElementById('newRoutineBtn').click()");
    check(await until("!document.getElementById('routineWork').hidden && document.querySelectorAll('#routineWork .wf-chat').length === 1"), 'New routine opens the editor with its chat');
    check(/Claude changes the routine/.test(await chatText('#routineWork')), 'the chat speaks of the routine');
    check(await ev("document.querySelector('#routineWork .wf-chat-tests input').checked"), 'Let Claude test it is on');

    // 2. Say it: Claude fills in the form, tests it, reads the run and says it worked.
    await say('#routineWork', 'Every weekday morning, sum up what changed here. Only look.');
    check(await until("document.querySelector('#routineEditor [name=name]').value === 'Morning summary'"), 'Claude filled in the name');
    const form = JSON.parse(await ev(`JSON.stringify({
      mode: document.querySelector('#routineEditor [name=mode]').value,
      type: document.querySelector('#routineEditor [name=type]').value,
      time: document.querySelector('#routineEditor [name=time]').value,
      days: [...document.querySelectorAll('#routineEditor input[name=day]:checked')].map(c => c.value).sort().join(','),
      catchUp: document.querySelector('#routineEditor [name=catchUp]').checked })`));
    check(form.mode === 'plan' && form.type === 'weekly' && form.time === '08:30' && form.days === '1,2,3,4,5', `the schedule and mode came through (${JSON.stringify(form)})`);
    check(await until("/Changed the routine/.test(document.querySelector('#routineWork .wf-chat-log').innerText)"), 'the chat says the routine changed');
    check(await until("/test run worked/.test(document.querySelector('#routineWork .wf-chat-log').innerText)", 30000), `Claude read the test run and said it worked (${(await chatText('#routineWork')).slice(-300).replace(/\n/g, ' | ')})`);
    const tested = (await routines()).find(r => r.name === 'Morning summary');
    check(!!tested && tested.enabled === false, `the tested routine was saved switched off (${JSON.stringify(tested && { enabled: tested.enabled })})`);
    check(tested?.lastStatus === 'ok', `its test run finished ok (${tested?.lastStatus})`);
    check(await ev("[...SB.state.tabs.values()].some(t => /Morning summary/.test(t.title || ''))"), 'the test ran in its own tab');
    check(await ev("!!document.querySelector('#routineWork .wf-chat-log button') && [...document.querySelectorAll('#routineWork .wf-chat-log button')].some(b => b.textContent === 'See the run')"), 'the chat offers See the run');

    // 3. Save switches it on, and keeps how the test went.
    await ev("document.getElementById('routineEditor').requestSubmit()");
    check(await until("document.getElementById('routineWork').hidden"), 'Save closes the editor');
    const saved = (await routines()).filter(r => r.name === 'Morning summary');
    check(saved.length === 1 && saved[0].enabled === true, `Save switched the same routine on (${saved.length}, ${saved[0]?.enabled})`);
    check(saved[0]?.lastStatus === 'ok', `Save kept the test run's status (${saved[0]?.lastStatus})`);

    // 4. Opening another routine while one is open keeps a single chat.
    await ev("document.querySelector('#routineList .ar-title').click()");
    check(await until("!document.getElementById('routineWork').hidden"), 'Edit opens the editor');
    await ev("document.getElementById('newRoutineBtn').click()");
    await wait(300);
    check(await ev("document.querySelectorAll('#routineWork .wf-chat').length") === 1, 'opening another keeps one chat');
    await ev("document.getElementById('routineCancel').click()");
    check(await until("document.getElementById('routineWork').hidden && !document.querySelector('#routineWork .wf-chat')"), 'Cancel takes the chat away');

    // 5. The workflow editor's chat (the same component) still builds and tests.
    await ev("SB.setView('workflows')");
    await until("document.getElementById('workflowsView')?.offsetParent !== null");
    check(await until("[...document.querySelectorAll('#workflowsView button')].some(b => /^New workflow$/i.test(b.textContent.trim()))"), 'the Automate page offers New workflow');
    await ev("[...document.querySelectorAll('#workflowsView button')].find(b => /^New workflow$/i.test(b.textContent.trim())).click()");
    check(await until("!!document.querySelector('#workflowsView .wf-chat')"), 'the workflow editor has its chat');
    check(/Claude changes the workflow/.test(await chatText('#workflowsView')), 'the chat speaks of the workflow');
    await say('#workflowsView', 'Say good morning every day at nine.');
    check(await until("/test run worked/.test(document.querySelector('#workflowsView .wf-chat-log')?.innerText || '')", 40000),
      `the workflow chat tested, fixed and passed (${(await chatText('#workflowsView')).slice(-300).replace(/\n/g, ' | ')})`);
  } catch (e) {
    console.log('FAIL  crashed:', e.stack || e.message);
    fails++;
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
