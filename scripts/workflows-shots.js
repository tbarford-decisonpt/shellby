// Screenshots of the Automate page for a visual check: the list, the editor
// (a template with nested steps), a run waiting on you, and a failed run.
// Uses the fake Claude CLI, so it needs no account.
//   node scripts/workflows-shots.js [outDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9362;
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'shellby-workflow-shots'));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`, '--force-prefers-reduced-motion'], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-shots-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47998' },
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
    const call = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = expr => call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(m => m.result?.result?.value);
    const shot = async name => {
      await wait(400);
      // A trophy unlocked along the way would sit over everything.
      await ev("document.querySelectorAll('.celebrate-host .celebrate').forEach(c => c.remove())");
      await wait(100);
      const m = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(m.result.data, 'base64'));
      console.log(path.join(OUT, `${name}.png`));
    };
    console.log('connected');
    // Saving anything risky opens the confirmation window: say yes there.
    const yesToDialog = async () => {
      for (let i = 0; i < 30; i++) {
        const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const dlg = pages.find(t => t.url.includes('dialog.html'));
        if (dlg) {
          const d = new WebSocket(dlg.webSocketDebuggerUrl);
          await new Promise(r => { d.onopen = r; });
          await wait(300);
          d.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "document.querySelectorAll('button')[0].click()" } }));
          await wait(300);
          return;
        }
        await wait(100);
      }
    };
    const save = async def => { const r = ev(`shellby.saveWorkflow(${typeof def === 'string' ? def : JSON.stringify(def)}).then(r => JSON.stringify(r))`); const done = await Promise.race([r, wait(1500).then(() => null)]); if (done === null) { await yesToDialog(); } return JSON.parse(await r); };
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");
    await ev("shellby.setSecret ? 0 : 0");
    await ev("shellby.setWorkflowSecret('API_KEY', 'demo-value-123')");
    const tpl = JSON.parse(await ev('shellby.listWorkflows().then(v => JSON.stringify(v.templates))'));
    const plain = t => JSON.stringify({ ...t.workflow, steps: JSON.parse(JSON.stringify(t.workflow.steps).replace(/"mode":"(acceptEdits|smart)"/g, '"mode":"plan"')) });
    // Templates with risky steps would open the confirmation window; plan-only copies save quietly.
    for (const key of ['morning-brief', 'release-notes', 'uptime']) await save(plain(tpl.find(t => t.key === key)));
    const gate = (await save(({ name: 'Ship gate', steps: [{ id: 'check', type: 'claude', mode: 'plan', prompt: 'Check it FAKE_JSON:{"ready": true}', output: { ready: 'boolean' } }, { type: 'ask', question: 'Everything passes. Ship version 1.4?', choices: ['Ship it', 'Not yet'] }] }))).workflow.id;
    await ev(`shellby.runWorkflow(${JSON.stringify(gate)}, {})`);
    const broken = (await save(({ name: 'Broken fetch', steps: [{ id: 'fetch', type: 'http', url: 'http://127.0.0.1:1/nothing' }, { type: 'tell', text: '{{ fetch.body }}' }] }))).workflow.id;
    await ev(`shellby.runWorkflow(${JSON.stringify(broken)}, {})`);
    await wait(2500);

    await ev("SB.setView('workflows')");
    await shot('1-list');
    // The editor on a template with an If inside.
    await ev(`(() => { const b = [...document.querySelectorAll('#workflowsView button')].find(x => /template/i.test(x.textContent)); b && b.click(); })()`);
    await wait(300);
    await ev(`(() => { const b = [...document.querySelectorAll('#workflowsView button, #workflowsView [role=button]')].find(x => /Red build fixer/.test(x.textContent)); b && b.click(); })()`);
    await shot('2-editor-top');
    await ev("(el => { el.scrollTop = 700; })([...document.querySelectorAll('#workflowsView, #workflowsView *')].find(e => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible') || document.getElementById('workflowsView'))");
    await shot('3-editor-steps');
    await ev("(() => { const b = [...document.querySelectorAll('#workflowsView button')].find(x => /Find out why/.test(x.textContent)); b && b.click(); b && b.scrollIntoView({ block: 'start' }); })()");
    await shot('4-editor-steps-more');
    // A run waiting on you.
    const runs = JSON.parse(await ev(`shellby.listRuns().then(l => JSON.stringify(l))`));
    console.log(JSON.stringify(runs.map(r => [r.workflowName, r.status])));
    await ev("SB.setView('chat')"); await wait(200); await ev("SB.setView('workflows')");
    await ev(`(() => { const row = [...document.querySelectorAll('#workflowsView [data-workflow-id]')].find(r => /Ship gate/.test(r.textContent)); const b = row && [...row.querySelectorAll('button, a')].find(x => /wait|answer|run|view/i.test(x.textContent + (x.getAttribute('aria-label') || ''))); (b || row)?.click(); })()`);
    await shot('5-after-click-gate');
    await ev(`SB.views.workflows.openRun(${JSON.stringify(runs.find(r => r.workflowName === 'Ship gate')?.id)})`);
    await shot('6-run-waiting');
    await ev(`SB.views.workflows.openRun(${JSON.stringify(runs.find(r => r.workflowName === 'Broken fetch')?.id)})`);
    await shot('7-run-failed');
    console.log('exports:', await ev('Object.keys(SB.views.workflows).join(",")'));
  } catch (e) {
    console.log('crashed:', e.stack || e.message);
  } finally {
    app.kill();
  }
})();
