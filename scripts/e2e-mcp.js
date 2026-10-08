// End-to-end check of MCP servers in workflows and routines, against the dev
// app over CDP with the fake Claude CLI and a fake MCP server
// (test/fixtures/fake-mcp-server.js) in a throwaway home folder: the server
// list, reading a server's tools, an MCP tool step that runs and hands on its
// answer, the confirmation window naming what a step may use unasked, and the
// pickers in the workflow and routine editors.
//   node scripts/e2e-mcp.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9367;
const HOOK_PORT = 47998;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-mcp-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-mcp-work-'));
  // Claude Code's config, as `claude mcp add --scope user` would leave it.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { fake: { type: 'stdio', command: process.execPath, args: [path.join(ROOT, 'test', 'fixtures', 'fake-mcp-server.js')] } },
  }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, USERPROFILE: home, HOME: home,
      SHELLBY_USER_DATA: userData, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK_PORT),
    },
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
    const json = async expr => { const t = await ev(`(${expr}).then(r => JSON.stringify(r))`); return t ? JSON.parse(t) : null; };
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
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
    const waitRun = async (id, ms = 30000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const r = await json(`shellby.getRun(${JSON.stringify(id)})`);
        if (r && ['ok', 'error'].includes(r.status)) return r;
        await wait(200);
      }
      return null;
    };

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    check(await until("typeof shellby !== 'undefined' && shellby.listWorkflows().then(v => !!v?.templates)", 20000), 'the workflow service answers');

    // 1. The servers a step can pick, and one server's tools.
    const servers = await json(`shellby.mcpServers(${JSON.stringify(work)})`);
    check(servers?.some(s => s.name === 'fake' && s.scope === 'user' && s.direct), `the fake server is listed (${JSON.stringify(servers)})`);
    const tools = await json("shellby.mcpTools('fake', null)");
    check(tools?.ok && tools.tools.map(t => t.name).join(',') === 'create_issue,second', `its tools are read from it (${JSON.stringify(tools)})`);

    // 2. An MCP tool step: the confirmation window names the call, and the run hands on the answer.
    const fileIt = { name: 'File it', cwd: work, steps: [
      { id: 'file', type: 'mcp', server: 'fake', tool: 'create_issue', args: '{ "title": "{{ inputs.title }}" }' },
      { type: 'set', values: { got: '{{ file.json.id }} / {{ file.text }}' } },
    ], inputs: [{ name: 'title', default: 'Build broke' }] };
    const pending = ev(`shellby.saveWorkflow(${JSON.stringify(fileIt)}).then(r => JSON.stringify(r))`);
    const shown = await answerDialog(0);
    check(shown !== null && /calls create_issue on the fake MCP server/.test(shown), 'the confirmation window names the tool call');
    const saved = JSON.parse(await pending);
    check(saved.ok === true, `it saves after a yes (${JSON.stringify(saved.errors || '')})`);
    const run = await json(`shellby.runWorkflow(${JSON.stringify(saved.workflow.id)}, {})`);
    const done = await waitRun(run.runId);
    check(done?.status === 'ok', `the run finishes ok (${done?.status}: ${done?.error || ''})`);
    check(done?.vars?.got === 'ISS-1 / made Build broke', `the tool's answer is handed on (${done?.vars?.got})`);

    // 3. A Claude step with servers: the confirmation window says so, even in Plan mode.
    const post = { name: 'Post it', cwd: work, steps: [{ type: 'claude', mode: 'plan', prompt: 'Post a note', mcp: ['fake'], mcpOnly: true }] };
    const pending2 = ev(`shellby.saveWorkflow(${JSON.stringify(post)}).then(r => JSON.stringify(r))`);
    const shown2 = await answerDialog(0);
    check(shown2 !== null && /may use every tool of the fake MCP server without asking, and no other MCP servers/.test(shown2), 'the confirmation window names the servers a Claude step may use');
    const saved2 = JSON.parse(await pending2);
    check(saved2.ok === true, 'it saves after a yes');
    const run2 = await json(`shellby.runWorkflow(${JSON.stringify(saved2.workflow.id)}, {})`);
    const done2 = await waitRun(run2.runId);
    check(done2?.status === 'ok', `its run finishes ok with only the fake server loaded (${done2?.status}: ${done2?.error || ''})`);

    // 4. The workflow editor: the picker on a Claude step, and the MCP tool step's fields.
    await ev("SB.setView('workflows')");
    await until("document.getElementById('workflowsView')?.offsetParent !== null");
    await ev(`localStorage.setItem('shellby.wf.layout', 'list')`);
    check(await until(`!!document.querySelector('[data-fk="edit-${saved2.workflow.id}"]')`), 'the workflow is listed');
    await ev(`document.querySelector('[data-fk="edit-${saved2.workflow.id}"]').click()`);
    await until("!!document.querySelector('.mcp-field')", 5000) || await ev("[...document.querySelectorAll('#workflowsView [role=radio], #workflowsView input[type=radio]')].find(r => /List/.test(r.closest('label')?.textContent || r.textContent))?.click()");
    check(await until("!!document.querySelector('.mcp-field') || !!document.querySelector('.wfc-node')", 5000), 'the editor opens');
    // On the map, the step's inspector holds its fields: open it.
    if (!(await ev("!!document.querySelector('.mcp-field')"))) await ev("[...document.querySelectorAll('.wfc-node')].find(n => /Ask Claude|Post a note|Plan/.test(n.textContent))?.click()");
    check(await until("!!document.querySelector('.mcp-field')", 5000), 'the Claude step shows its MCP servers box');
    check(await ev("[...document.querySelectorAll('.mcp-field .mcp-pick')].some(l => /fake/.test(l.textContent) && l.querySelector('input').checked)"), 'the fake server is listed and ticked');
    check(await ev("[...document.querySelectorAll('.mcp-field .wf-check')].some(l => /Only these servers/.test(l.textContent) && l.querySelector('input').checked)"), '"Only these servers" shows, ticked');

    // 5. The routine editor has the same box.
    await ev("SB.setView('routines')");
    await wait(400);
    await ev("[...document.querySelectorAll('button')].find(b => /New routine/i.test(b.textContent) && b.offsetParent)?.click()");
    check(await until("!!document.querySelector('#routineMcp .mcp-field')", 5000), 'the routine editor shows the MCP servers box');
    check(await until("[...document.querySelectorAll('#routineMcp .mcp-pick')].some(l => /fake/.test(l.textContent))", 5000), 'it lists the fake server');
  } catch (e) {
    check(false, `no errors (${e.message})`);
  } finally {
    app.kill();
    await wait(800);
    for (const d of [userData, home, work]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
