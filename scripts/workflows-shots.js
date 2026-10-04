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

    // Anything the page throws from here on is reported at the end.
    const thrown = [];
    const onMsg = ws.onmessage;
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') thrown.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); onMsg(e); };
    await call('Runtime.enable');
    const click = sel => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); b && b.click(); return !!b; })()`);
    const rect = sel => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const mouse = (type, { x, y }, buttons = 1) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });

    await ev("SB.setView('workflows')");
    await shot('1-list');
    // The editor on a template with an If inside: the map is the default.
    await ev(`(() => { const b = [...document.querySelectorAll('#workflowsView button')].find(x => /template/i.test(x.textContent)); b && b.click(); })()`);
    await wait(300);
    await ev(`(() => { const b = [...document.querySelectorAll('#workflowsView button, #workflowsView [role=button]')].find(x => /Red build fixer/.test(x.textContent)); b && b.click(); })()`);
    await shot('2-editor-map');
    console.log('map nodes:', await ev("document.querySelectorAll('#workflowsView .wfc-node').length"), 'wires:', await ev("document.querySelectorAll('#workflowsView .wfc-wire').length"));
    // Pick the If with a real mouse click: its fields open beside (or under) the map.
    const ifNode = await rect('#workflowsView .wfc-cell[data-type="if"] .wfc-node');
    await mouse('mousePressed', ifNode);
    await mouse('mouseReleased', ifNode, 0);
    await wait(200);
    console.log('mouse click opens the inspector:', await ev("!document.querySelector('#workflowsView .wfc-insp').hidden && /If/.test(document.querySelector('#workflowsView .wfc-insp-title')?.textContent)"));
    await shot('3-editor-map-if');
    // Enter on a node puts focus in its fields; Esc goes back to the node.
    await ev("document.querySelector('#workflowsView .wfc-cell[data-type=\"claude\"] .wfc-node').focus()");
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wait(200);
    console.log('after Enter the inspector shows:', await ev("document.querySelector('#workflowsView .wfc-insp-title')?.textContent"), 'focus on:', await ev('document.activeElement.tagName + "." + document.activeElement.className'));
    console.log('Enter focuses a field:', await ev("!!document.activeElement.closest('.wfc-insp') && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)"));
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(150);
    console.log('Esc closes it, back on the node:', await ev("document.querySelector('#workflowsView .wfc-insp').hidden && document.activeElement.classList.contains('wfc-node')"), 'still in the editor:', await ev("!!document.querySelector('#workflowsView .wfc')"));
    await click('#workflowsView .wfc-cell[data-type="claude"] .wfc-node');
    await shot('4-editor-map-claude');
    // Make room: the panel widens and the inspector docks.
    await click('#workflowsView [data-room-btn]');
    await wait(900);
    await shot('5-editor-map-roomy');
    // Drag the first step onto the last +: it should move to the end.
    const before = await ev("JSON.stringify([...document.querySelectorAll('#workflowsView .wfc-flow > .wfc-col > .wfc-cell .wfc-title, #workflowsView .wfc-flow > .wfc-col > .wfc-block > .wfc-cell .wfc-title')].map(t => t.textContent))");
    const from = await rect('#workflowsView .wfc-flow > .wfc-col > .wfc-cell .wfc-node, #workflowsView .wfc-flow > .wfc-col > .wfc-block > .wfc-cell .wfc-node');
    const to = await rect('#workflowsView .wfc-flow > .wfc-col > .wfc-add:last-child');
    if (from && to) {
      await mouse('mousePressed', from);
      for (let i = 1; i <= 12; i++) await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / 12, y: from.y + ((to.y - from.y) * i) / 12 });
      await shot('6-editor-map-dragging');
      await mouse('mouseReleased', to, 0);
      await wait(300);
    }
    const after = await ev("JSON.stringify([...document.querySelectorAll('#workflowsView .wfc-flow > .wfc-col > .wfc-cell .wfc-title, #workflowsView .wfc-flow > .wfc-col > .wfc-block > .wfc-cell .wfc-title')].map(t => t.textContent))");
    console.log('top-level order before:', before, 'after drag:', after);
    await shot('7-editor-map-dropped');
    // The same workflow as a list still works.
    await click('#workflowsView [data-fk="lay-list"]');
    await shot('8-editor-list');
    await click('#workflowsView [data-fk="lay-map"]');
    // Runs, on the map: one waiting on you, one failed.
    const runs = JSON.parse(await ev(`shellby.listRuns().then(l => JSON.stringify(l))`));
    console.log(JSON.stringify(runs.map(r => [r.workflowName, r.status])));
    await ev("SB.setView('chat')"); await wait(200); await ev("SB.setView('workflows')");
    await ev(`SB.views.workflows.openRun(${JSON.stringify(runs.find(r => r.workflowName === 'Ship gate')?.id)})`);
    await shot('9-run-waiting-map');
    await ev(`SB.views.workflows.openRun(${JSON.stringify(runs.find(r => r.workflowName === 'Broken fetch')?.id)})`);
    await shot('10-run-failed-map');
    // Give the room back: the narrow run map, with its sheet.
    await click('#workflowsView [data-room-btn]');
    await wait(900);
    await shot('11-run-failed-narrow');
    console.log('exports:', await ev('Object.keys(SB.views.workflows).join(",")'));
    console.log('page errors:', thrown.length ? thrown.join('\n') : 'none');
  } catch (e) {
    console.log('crashed:', e.stack || e.message);
  } finally {
    app.kill();
  }
})();
