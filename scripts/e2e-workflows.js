// ci: workflows: typed Claude output, the confirm window, ask/stop/resume, a web hook
// End-to-end check of workflows against the dev app over CDP, driven by the
// fake Claude CLI (test/fixtures/fake-claude.js): no account, no usage.
// Saves workflows through the panel's bridge, runs them, and checks the
// Automate page shows what happened: typed Claude output steering an If, a
// command, an Ask answered from the run view, a stop and a resume, a web hook
// on the local port, and the confirmation window guarding risky saves.
//   node scripts/e2e-workflows.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { templates } = require('../src/main/workflows/templates');

const ROOT = path.join(__dirname, '..');
const PORT = 9361;
const HOOK_PORT = 47997;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-wf-work-'));
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
    const connect = async target => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise(r => { ws.onopen = r; });
      let id = 0; const p = new Map();
      ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
      return expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    };
    const ev = await connect(list.find(t => t.url.endsWith('panel.html')));
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    // The confirmation window is its own page: answer it like a person would.
    const answerDialog = async index => {
      const end = Date.now() + 8000;
      while (Date.now() < end) {
        const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const dlg = pages.find(t => t.url.includes('dialog.html'));
        if (dlg) {
          const dev = await connect(dlg);
          await wait(300);
          const text = await dev('document.body.innerText');
          await dev(`document.querySelectorAll('button')[${index}]?.click()`);
          return text || '';
        }
        await wait(150);
      }
      return null;
    };
    const runOf = id => ev(`shellby.getRun(${JSON.stringify(id)}).then(r => r && JSON.stringify(r))`).then(t => (t ? JSON.parse(t) : null));
    const waitRun = async (id, statuses, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const r = await runOf(id); if (r && statuses.includes(r.status)) return r; await wait(200); }
      return runOf(id);
    };

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await wait(500);

    // 1. The page and its templates. On a cold start the bridge and the
    // workflow service may still be coming up: wait until it answers.
    check(await until("typeof shellby !== 'undefined' && shellby.listWorkflows().then(v => !!v?.templates)", 20000), 'the workflow service answers');
    const view = JSON.parse(await ev('shellby.listWorkflows().then(v => JSON.stringify(v))'));
    check(view && Array.isArray(view.workflows) && view.workflows.length === 0, 'starts with no workflows');
    check(view.templates.length === templates().length, `every template (${view.templates.length} of ${templates().length})`);
    check(view.webhookPort === HOOK_PORT, `web hook port is the plugin port (${view.webhookPort})`);
    await ev("SB.setView('workflows')");
    check(await until("document.getElementById('workflowsView')?.offsetParent !== null"), 'the Automate page opens');

    // 2. Typed Claude output steers an If; a quiet workflow saves without asking.
    const triage = {
      name: 'Triage', cwd: work,
      steps: [
        { id: 'look', type: 'claude', mode: 'plan', prompt: 'Look around FAKE_JSON:{"fixable": true, "cause": "a typo"}', output: { fixable: 'boolean', cause: 'string' } },
        { type: 'if', test: 'look.fixable', then: [{ type: 'set', values: { verdict: 'fix {{ look.cause }}' } }], else: [{ type: 'set', values: { verdict: 'leave it' } }] },
        { type: 'tell', to: 'crab', text: '{{ vars.verdict }}' },
      ],
    };
    const saved = JSON.parse(await ev(`shellby.saveWorkflow(${JSON.stringify(triage)}).then(r => JSON.stringify(r))`));
    check(saved.ok === true, `a plan-only workflow saves without a confirmation (${JSON.stringify(saved.errors || '')})`);
    check(await until("document.querySelectorAll('#workflowsView [data-workflow-id]').length === 1 || /Triage/.test(document.getElementById('workflowsView').innerText)"), 'it is listed on the Automate page');
    const run1 = JSON.parse(await ev(`shellby.runWorkflow(${JSON.stringify(saved.workflow.id)}, {}).then(r => JSON.stringify(r))`));
    check(run1.ok, 'it runs');
    const r1 = await waitRun(run1.runId, ['ok', 'error']);
    check(r1?.status === 'ok', `the run finishes ok (${r1?.status}: ${r1?.error || ''})`);
    check(r1?.steps?.look?.output?.fixable === true && r1?.steps?.look?.output?.cause === 'a typo', 'Claude handed back typed fields');
    check(r1?.vars?.verdict === 'fix a typo', `the If took the right branch (${r1?.vars?.verdict})`);
    check(!!r1?.steps?.look?.output?.tabId && await ev('/⚡ Triage/.test(document.body.textContent)'), 'its Claude step ran in a ⚡ tab');

    // 3. A risky save asks in the confirmation window: No keeps nothing, Yes saves.
    const risky = { name: 'Run it', cwd: work, steps: [{ id: 'cmd', type: 'run', command: 'Write-Output "hi {{ inputs.who }}"' }, { id: 'q', type: 'ask', question: 'Carry on?' }, { type: 'run', command: 'Write-Output after' }], inputs: [{ name: 'who', default: 'there' }] };
    const pendingNo = ev(`shellby.saveWorkflow(${JSON.stringify(risky)}).then(r => JSON.stringify(r))`);
    const shown = await answerDialog(1);
    check(shown !== null && /Write-Output/.test(shown), 'the confirmation window shows the command');
    check(JSON.parse(await pendingNo).ok === false, 'saying no saves nothing');
    const pendingYes = ev(`shellby.saveWorkflow(${JSON.stringify(risky)}).then(r => JSON.stringify(r))`);
    await answerDialog(0);
    const riskySaved = JSON.parse(await pendingYes);
    check(riskySaved.ok === true, 'saying yes saves it');

    // 4. Ask: the run waits, the answer comes from the panel, Stop then Resume.
    const run2 = JSON.parse(await ev(`shellby.runWorkflow(${JSON.stringify(riskySaved.workflow.id)}, { who: 'Jo' }).then(r => JSON.stringify(r))`));
    const r2 = await waitRun(run2.runId, ['waiting', 'error']);
    check(r2?.status === 'waiting', `the run waits for an answer (${r2?.status})`);
    check((r2?.steps?.cmd?.output?.output || '').trim() === 'hi Jo', `the input reached the command as text (${JSON.stringify(r2?.steps?.cmd?.output?.output)})`);
    await ev(`shellby.stopRun(${JSON.stringify(run2.runId)})`);
    const stopped = await waitRun(run2.runId, ['stopped']);
    check(stopped?.status === 'stopped', 'Stop stops it');
    check(JSON.parse(await ev(`shellby.resumeRun(${JSON.stringify(run2.runId)}).then(r => JSON.stringify(r))`)).ok, 'Resume picks it up');
    await waitRun(run2.runId, ['waiting']);
    const answered = JSON.parse(await ev(`shellby.answerRun(${JSON.stringify(run2.runId)}, 'q', 'Continue').then(r => JSON.stringify(r))`));
    check(answered.ok, 'the answer is taken');
    const r2b = await waitRun(run2.runId, ['ok', 'error']);
    check(r2b?.status === 'ok', `it finishes after the answer (${r2b?.status}: ${r2b?.error || ''})`);
    check(r2b?.steps?.cmd?.attempts === 1, 'the first command did not run twice');

    // 5. A web hook on the plugin's local port.
    const hooked = { name: 'Hooked', when: [{ type: 'webhook' }], inputs: [{ name: 'msg' }], steps: [{ type: 'set', values: { got: '{{ inputs.msg }}' } }] };
    const h = JSON.parse(await ev(`shellby.saveWorkflow(${JSON.stringify(hooked)}).then(r => JSON.stringify(r))`));
    const token = h.workflow?.when?.[0]?.token;
    check(/^[a-f0-9]{48}$/.test(token || ''), 'the web hook got a token');
    const post = body => fetch(`http://127.0.0.1:${HOOK_PORT}/v1/flow`, { method: 'POST', headers: { 'X-Shellby': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    check((await post({ hook: 'a'.repeat(48), data: {} })).status === 404, 'a wrong token is refused');
    const ok = await post({ hook: token, data: { msg: 'from a script' } });
    check(ok.status === 200, `the right token starts it (${ok.status})`);
    check(await until(`shellby.listRuns(${JSON.stringify(h.workflow.id)}).then(l => l[0]?.status === 'ok')`), 'the hooked run finishes');
    const hookRun = await runOf((JSON.parse(await ev(`shellby.listRuns(${JSON.stringify(h.workflow.id)}).then(l => JSON.stringify(l))`)))[0].id);
    check(hookRun?.vars?.got === 'from a script', 'the posted data reached the run');
    const browserish = await fetch(`http://127.0.0.1:${HOOK_PORT}/v1/flow`, { method: 'POST', headers: { 'X-Shellby': '1', 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ hook: token }) });
    check(browserish.status === 403, 'a request from a web page is refused');

    // 6. The run list on the page reflects what happened.
    await ev("SB.setView('workflows')");
    check(await until("/Hooked/.test(document.getElementById('workflowsView').innerText) && /Run it/.test(document.getElementById('workflowsView').innerText)"), 'all three are on the page');
  } catch (e) {
    console.log('FAIL  crashed:', e.stack || e.message);
    fails++;
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
