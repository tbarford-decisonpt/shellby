// Screenshots of the Automate list screens for a visual check: the workflow
// list (empty and full, top and scrolled) and Routines (empty and full), at
// the panel's normal width. Uses the fake Claude CLI, so it needs no account.
//   node scripts/automate-shots.js [outDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9363;
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'shellby-automate-shots'));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`, '--force-prefers-reduced-motion'], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-shots-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47997' },
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
    const thrown = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') thrown.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      p.get(m.id)?.(m);
    };
    const call = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = expr => call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(m => m.result?.result?.value);
    const shot = async name => {
      await wait(400);
      await ev("document.querySelectorAll('.celebrate-host .celebrate').forEach(c => c.remove())");
      await wait(100);
      const m = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(m.result.data, 'base64'));
      console.log(path.join(OUT, `${name}.png`));
    };
    const scroll = (sel, y) => ev(`(() => { const v = document.querySelector(${JSON.stringify(sel)}); v.scrollTop = ${y}; return v.scrollHeight; })()`);
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
    const save = async def => { const r = ev(`shellby.saveWorkflow(${def}).then(r => JSON.stringify(r))`); const done = await Promise.race([r, wait(1500).then(() => null)]); if (done === null) await yesToDialog(); return JSON.parse(await r); };

    await wait(3000);
    await call('Runtime.enable');
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");

    // Empty states first.
    await ev("SB.setView('workflows')");
    await shot('a1-workflows-empty');
    console.log('templates grid:', await ev("(() => { const t = document.querySelector('#workflowsView .templates'); return t && getComputedStyle(t).gridTemplateColumns + ' w=' + t.clientWidth; })()"));
    const emptyH = await scroll('#workflowsView', 600);
    if (emptyH > 1000) await shot('a2-workflows-empty-scrolled');
    await ev("SB.setView('routines')");
    await shot('b1-routines-empty');

    // Then fill both.
    await ev("shellby.setWorkflowSecret('API_KEY', 'demo-value-123')");
    const tpl = JSON.parse(await ev('shellby.listWorkflows().then(v => JSON.stringify(v.templates))'));
    const plain = t => JSON.stringify({ ...t.workflow, steps: JSON.parse(JSON.stringify(t.workflow.steps).replace(/"mode":"(acceptEdits|smart)"/g, '"mode":"plan"')) });
    for (const key of ['morning-brief', 'release-notes', 'uptime']) await save(plain(tpl.find(t => t.key === key)));
    const gate = (await save(JSON.stringify({ name: 'Ship gate', description: 'Checks the build, then asks before shipping.', steps: [{ id: 'check', type: 'claude', mode: 'plan', prompt: 'Check it FAKE_JSON:{"ready": true}', output: { ready: 'boolean' } }, { type: 'ask', question: 'Everything passes. Ship version 1.4?', choices: ['Ship it', 'Not yet'] }] }))).workflow.id;
    await ev(`shellby.runWorkflow(${JSON.stringify(gate)}, {})`);
    const broken = (await save(JSON.stringify({ name: 'Broken fetch', steps: [{ id: 'fetch', type: 'http', url: 'http://127.0.0.1:1/nothing' }, { type: 'tell', text: '{{ fetch.body }}' }] }))).workflow.id;
    await ev(`shellby.runWorkflow(${JSON.stringify(broken)}, {})`);
    const offDef = { ...JSON.parse(plain(tpl.find(t => t.key === 'morning-brief'))), name: 'Weekend digest', enabled: false };
    await save(JSON.stringify(offDef));
    for (const r of [
      { name: 'Friday Downloads tidy', prompt: 'Sort ~/Downloads into subfolders by type and tell me what moved.', schedule: { type: 'weekly', days: [5], time: '17:00' }, mode: 'plan', enabled: true, catchUp: true },
      { name: 'Morning repo check', prompt: 'List open PRs that need my review and anything failing on main.', schedule: { type: 'daily', time: '08:30' }, mode: 'plan', enabled: true, catchUp: true },
      { name: 'Clean temp files', prompt: 'Delete build output older than a week.', schedule: { type: 'interval', everyHours: 6 }, mode: 'plan', enabled: false, catchUp: false },
    ]) console.log('routine:', await ev(`shellby.saveRoutine(${JSON.stringify(r)}).then(r => r.ok ? 'ok' : JSON.stringify(r.errors))`));
    await wait(2500);

    await ev("SB.setView('chat')"); await wait(200);
    await ev("SB.setView('workflows')");
    await scroll('#workflowsView', 0);
    await shot('a3-workflows-full');
    const h1 = await scroll('#workflowsView', 520);
    await shot('a4-workflows-full-scrolled');
    await scroll('#workflowsView', h1);
    await shot('a5-workflows-full-bottom');
    await ev("SB.setView('routines')");
    await scroll('#routinesView', 0);
    await shot('b2-routines-full');
    const h2 = await scroll('#routinesView', 99999);
    if (h2 > 1100) await shot('b3-routines-full-bottom');
    // The wide panel.
    await ev("SB.setView('workflows')");
    await ev("document.querySelector('#workflowsView [data-room-btn]')?.click()");
    console.log('page errors:', thrown.length ? thrown.join('\n') : 'none');
  } catch (e) {
    console.log('crashed:', e.stack || e.message);
  } finally {
    app.kill();
  }
})();
