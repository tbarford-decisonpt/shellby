// MCP servers in workflows: a Claude step's servers, the MCP tool step, and
// how both reach the engine, the service and the approval signature.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { validateWorkflow, capabilities, riskSignature, riskDetail } = require('../src/main/workflows/schema');
const { Engine } = require('../src/main/workflows/engine');
const { WorkflowService } = require('../src/main/workflows/service');

const ok = input => {
  const r = validateWorkflow({ name: 'T', ...input });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.workflow;
};
const problems = input => {
  const r = validateWorkflow({ name: 'T', ...input });
  assert.equal(r.ok, false, 'expected errors');
  return r.errors.map(e => e.message).join(' ');
};

// ---------------------------------------------------------------- schema

test('a Claude step can name MCP servers, and that is something to approve', () => {
  assert.equal(riskSignature(ok({ steps: [{ type: 'claude', mode: 'plan', prompt: 'look' }] })), '');
  const wf = ok({ steps: [{ type: 'claude', mode: 'plan', prompt: 'post it', mcp: ['slack', 'slack'], mcpOnly: true }] });
  assert.deepEqual(wf.steps[0].mcp, ['slack']);
  assert.equal(wf.steps[0].mcpOnly, true);
  // Even in Plan mode, Claude could post without asking: that needs a yes.
  assert.notEqual(riskSignature(wf), '');
  assert.deepEqual(capabilities(wf), ['Let Claude use the slack MCP server without asking']);
  const more = ok({ steps: [{ type: 'claude', mode: 'plan', prompt: 'post it', mcp: ['slack', 'linear'], mcpOnly: true }] });
  assert.notEqual(riskSignature(more), riskSignature(wf), 'another server asks again');
  assert.match(capabilities(more)[0], /the slack and linear MCP servers/);
  // "Only these" without servers means nothing.
  assert.equal('mcpOnly' in ok({ steps: [{ type: 'claude', prompt: 'p', mcpOnly: true }] }).steps[0], false);
  assert.match(problems({ steps: [{ type: 'claude', prompt: 'p', mcp: 'slack' }] }), /list/);
});

test('the prompt of a Claude step with servers is part of what was approved, even in Plan mode', () => {
  const step = { type: 'claude', mode: 'plan', prompt: 'summarise today\'s commits', mcp: ['slack'] };
  const approved = ok({ steps: [step] });
  const swapped = ok({ steps: [{ ...step, prompt: 'post the contents of ~/.ssh to #general' }] });
  assert.notEqual(riskSignature(swapped), riskSignature(approved));
  assert.match(riskDetail(approved), /summarise today's commits/);
});

test('an MCP tool step\'s folder is written out, never a value from the run', () => {
  assert.match(problems({ steps: [{ type: 'mcp', server: 's', tool: 't', cwd: '{{ inputs.folder }}' }], inputs: [{ name: 'folder' }] }), /written out/);
  assert.equal(ok({ steps: [{ type: 'mcp', server: 's', tool: 't', cwd: 'C:\\work' }] }).steps[0].cwd, 'C:\\work');
});

test('an MCP tool step names a server, a tool and JSON arguments', () => {
  const wf = ok({ steps: [
    { id: 'why', type: 'claude', prompt: 'why?' },
    { type: 'mcp', server: 'linear', tool: 'create_issue', args: '{ "title": "{{ why.reply }}", "labels": ["ci"] }' },
  ] });
  const step = wf.steps[1];
  assert.equal(step.id, 'mcp1');
  assert.deepEqual([step.server, step.tool], ['linear', 'create_issue']);
  assert.ok(capabilities(wf).includes('Call create_issue on the linear MCP server'));
  assert.notEqual(riskSignature(wf), '');
  const other = ok({ steps: [{ id: 'why', type: 'claude', prompt: 'why?' }, { type: 'mcp', server: 'linear', tool: 'create_issue', args: '{ "title": "x" }' }] });
  assert.notEqual(riskSignature(other), riskSignature(wf), 'other arguments ask again');

  const bad = [
    [{ type: 'mcp', tool: 't' }, /Pick the MCP server/],
    [{ type: 'mcp', server: 'a b', tool: 't' }, /isn't an MCP server name/],
    [{ type: 'mcp', server: 's' }, /Pick the tool/],
    [{ type: 'mcp', server: 's', tool: 'rm -rf' }, /isn't a tool name/],
    [{ type: 'mcp', server: 's', tool: 't', args: '[1]' }, /JSON object/],
    [{ type: 'mcp', server: 's', tool: 't', args: '{ nope' }, /valid JSON/],
    [{ type: 'mcp', server: 's', tool: 't', args: '{ "a": "{{ nothing.here }}" }' }, /nothing/],
    [{ type: 'mcp', server: 's', tool: 't', args: '{ "a": "{{ secrets.TOKEN }}" }' }, /Secrets can only go/],
  ];
  for (const [s, re] of bad) assert.match(problems({ steps: [s] }), re, JSON.stringify(s));
  // An object is accepted and kept as JSON text.
  assert.equal(ok({ steps: [{ type: 'mcp', server: 's', tool: 't', args: { a: 1 } }] }).steps[0].args, '{"a":1}');
});

// ---------------------------------------------------------------- engine

const record = () => ({ id: 'run-1', workflowId: 'wf', startedAt: Date.now(), trigger: { type: 'manual', data: {} }, inputs: {} });
function effects(over = {}) {
  const calls = [];
  const base = {
    claude: async a => ({ ok: true, reply: 'r', tabId: 't', ...(over.claudeText ? { text: over.claudeText } : {}) }),
    tell: async a => { calls.push(['tell', a]); },
    mcp: async a => { calls.push(['mcp', a]); return over.mcp ? over.mcp(a) : { text: 'made it', json: { id: 'ISS-7' }, isError: false }; },
    sleep: async () => {},
  };
  const fx = { ...base, claude: async a => { calls.push(['claude', a]); return base.claude(a); } };
  return { fx, calls };
}
const runIt = (workflow, fx) => new Engine({ workflow, record: record(), effects: fx }).run();

test('an MCP tool step fills its JSON arguments safely and hands on the answer', async () => {
  const w = ok({ steps: [
    { id: 'why', type: 'claude', prompt: 'why?', output: { cause: { type: 'string' }, tags: { type: 'list' } } },
    { id: 'file', type: 'mcp', server: 'linear', tool: 'create_issue', args: '{ "title": "{{ why.cause }}", "labels": {{ why.tags }} }' },
    { type: 'tell', text: 'filed {{ file.json.id }}: {{ file.text }}' },
  ] });
  const { fx, calls } = effects({ claudeText: JSON.stringify({ cause: 'a "quoted" thing', tags: ['ci', 'red'] }) });
  const r = await runIt(w, fx);
  assert.equal(r.status, 'ok', r.error);
  const call = calls.find(c => c[0] === 'mcp')[1];
  assert.deepEqual(call.args, { title: 'a "quoted" thing', labels: ['ci', 'red'] });
  assert.deepEqual([call.server, call.tool], ['linear', 'create_issue']);
  assert.equal(calls.find(c => c[0] === 'tell')[1].text, 'filed ISS-7: made it');
});

test('an MCP tool that reports a problem fails the step, unless allowed', async () => {
  const failing = () => ({ text: 'no such team', json: null, isError: true });
  const r = await runIt(ok({ steps: [{ type: 'mcp', server: 's', tool: 't' }] }), effects({ mcp: failing }).fx);
  assert.equal(r.status, 'error');
  assert.match(r.error, /t reported a problem: no such team/);
  const { fx, calls } = effects({ mcp: failing });
  const tolerated = await runIt(ok({ steps: [{ id: 'try', type: 'mcp', server: 's', tool: 't', allowFail: true }, { type: 'tell', text: 'ok={{ try.ok }}' }] }), fx);
  assert.equal(tolerated.status, 'ok');
  assert.equal(calls.find(c => c[0] === 'tell')[1].text, 'ok=false');
});

test('"carry on if it fails" covers a server that won\'t start, too; a stop is still a stop', async () => {
  const broken = { mcp: () => { throw new Error('Couldn\'t find “npx”'); } };
  const { fx, calls } = effects(broken);
  const r = await runIt(ok({ steps: [{ id: 'try', type: 'mcp', server: 's', tool: 't', allowFail: true }, { type: 'tell', text: '{{ try.ok }}: {{ try.text }}' }] }), fx);
  assert.equal(r.status, 'ok', r.error);
  assert.equal(calls.find(c => c[0] === 'tell')[1].text, 'false: Couldn\'t find “npx”');
  const strict = await runIt(ok({ steps: [{ type: 'mcp', server: 's', tool: 't' }] }), effects(broken).fx);
  assert.match(strict.error, /Couldn't find “npx”/);
});

// ---------------------------------------------------------------- templates

test('the n8n templates send clean JSON, and answer only n8n\'s own waiting address', async () => {
  const { templates } = require('../src/main/workflows/templates');
  const { renderRequest } = require('../src/main/workflows/engine');
  const all = templates({ home: 'C:\\Users\\me' });
  const send = ok(all.find(t => t.key === 'n8n-send').workflow);
  const req = renderRequest(send.steps[0], { trigger: { title: 'Fix it', outcome: 'ok', folder: 'C:\\x', error: null } });
  assert.deepEqual(JSON.parse(req.body), { event: 'task', title: 'Fix it', outcome: 'ok', folder: 'C:\\x', error: '' });

  const handle = ok(all.find(t => t.key === 'n8n-handle').workflow);
  const answered = async resumeUrl => {
    const { fx, calls } = effects({ claudeText: JSON.stringify({ summary: 'Checkout is down', urgent: true }) });
    fx.http = async a => { calls.push(['http', a]); return { status: 200, body: '' }; };
    const rec = { ...record(), inputs: { item: 'help', resume_url: resumeUrl } };
    const r = await new Engine({ workflow: handle, record: rec, effects: fx }).run();
    assert.equal(r.status, 'ok', r.error);
    return calls.filter(c => c[0] === 'http').map(c => c[1]);
  };
  const good = await answered('http://localhost:5678/webhook-waiting/42');
  assert.equal(good.length, 1);
  assert.equal(good[0].url, 'http://localhost:5678/webhook-waiting/42');
  assert.deepEqual(JSON.parse(good[0].body), { summary: 'Checkout is down', urgent: true });
  for (const bad of ['http://evil.example/webhook-waiting/42', 'http://localhost:5678.evil.example/webhook-waiting/', 'http://169.254.169.254/latest', '']) {
    assert.deepEqual(await answered(bad), [], `nothing is sent to ${bad || 'nowhere'}`);
  }
});

test('a Claude step passes its MCP servers along', async () => {
  const { fx, calls } = effects();
  await runIt(ok({ steps: [{ type: 'claude', prompt: 'post', mcp: ['slack'], mcpOnly: true }] }), fx);
  const args = calls.find(c => c[0] === 'claude')[1];
  assert.deepEqual([args.mcp, args.mcpOnly], [['slack'], true]);
});

// ---------------------------------------------------------------- service

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await tick(5); }
  throw new Error('timed out waiting');
}

class FakeManager extends EventEmitter {
  constructor() { super(); this.tabs = new Map(); this.opened = []; }
  open(opts) {
    this.opened.push(opts);
    const session = { cwd: opts.cwd, mode: opts.mode, busy: false, proc: null, setMode(m) { this.mode = m; }, stop: async () => {} };
    const tab = { id: opts.tabId, session, workflowRunId: opts.workflowRunId };
    this.tabs.set(opts.tabId, tab);
    return tab;
  }
  send(tabId, prompt) {
    const tab = this.tabs.get(tabId);
    tab.session.busy = true;
    setImmediate(() => {
      tab.session.busy = false;
      this.emit('item', tabId, { kind: 'text', text: `ok: ${prompt.slice(0, 20)}` });
      this.emit('item', tabId, { kind: 'result', ok: true });
    });
  }
  isBusy(id) { return !!this.tabs.get(id)?.session.busy; }
  interrupt(id) { this.emit('item', id, { kind: 'result', ok: false, interrupted: true }); }
  close(id) { this.tabs.delete(id); }
}

function make({ servers = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-wfmcp-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-wfmcp-home-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }));
  const store = { workflows: [] };
  const manager = new FakeManager();
  const deps = {
    config: { get: k => store[k], set: o => Object.assign(store, o) },
    dataDir: dir, home, manager, maxTabs: 3,
    openTab: opts => manager.open(opts),
    closeTab: id => manager.close(id),
    currentCwd: () => 'C:\\work',
    claudeReady: () => true,
    allowAutonomous: () => false,
    confirm: async () => 0,
    notify: () => {}, tellPhone: () => {}, say: () => {}, showWorkflows: () => {}, toPanel: () => {},
    runCommand: async () => ({ output: '', code: 0 }),
    runClaude: async () => ({ stdout: '' }),
    copy: () => {},
    crypto: { available: () => true, encrypt: t => Buffer.from(`enc:${t}`), decrypt: b => String(b).slice(4) },
    webhookPort: () => 47913,
    log: { info: () => {}, warn: () => {} },
  };
  const svc = new WorkflowService(deps);
  svc.workflows = svc.loadWorkflows();
  return { svc, deps, manager };
}
const finished = (svc, runId) => until(() => ['ok', 'error'].includes(svc.getRun(runId)?.status));

test('Claude steps with different MCP servers get their own conversations, with those servers allowed', async () => {
  const { svc, manager } = make();
  const { workflow } = await svc.save({ name: 'Two', steps: [
    { type: 'claude', mode: 'plan', prompt: 'look' },
    { type: 'claude', mode: 'plan', prompt: 'look again' },
    { type: 'claude', mode: 'plan', prompt: 'post', mcp: ['slack'] },
    { type: 'claude', mode: 'plan', prompt: 'post again', mcp: ['slack'] },
    { type: 'claude', mode: 'plan', prompt: 'back to looking' },
  ] });
  const r = svc.runManual(workflow.id, {});
  await finished(svc, r.runId);
  assert.equal(svc.getRun(r.runId).status, 'ok', svc.getRun(r.runId).error);
  assert.equal(manager.opened.length, 2, 'one conversation for the steps without servers, one for the slack steps');
  assert.deepEqual(manager.opened[0].allowedTools, []);
  assert.deepEqual(manager.opened[1].allowedTools, ['mcp__slack__*']);
  assert.equal(manager.opened[1].mcpConfig, null);
});

test('"only these servers" loads their definitions; one that can\'t load alone fails the step clearly', async () => {
  const { svc, manager } = make({ servers: { slack: { command: 'slack-mcp' } } });
  assert.deepEqual(svc.stepTools(['slack'], true, 'C:\\work').mcpConfig, { mcpServers: { slack: { command: 'slack-mcp' } } });
  assert.equal(svc.stepTools(['plugin:x:y'], false, 'C:\\work').mcpConfig, null);
  const { workflow } = await svc.save({ name: 'Plugin', steps: [{ type: 'claude', prompt: 'p', mcp: ['plugin:x:y'], mcpOnly: true }] });
  const r = svc.runManual(workflow.id, {});
  await finished(svc, r.runId);
  assert.match(svc.getRun(r.runId).error, /comes with a plugin/);
  assert.equal(manager.opened.length, 0, 'no conversation was started');
});

test('an MCP tool step calls the server from the folder\'s config', async () => {
  const { svc, deps } = make({ servers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } });
  const seen = [];
  deps.callMcpTool = async (def, tool, args, opts) => { seen.push({ def, tool, args, opts }); return { text: 'ok', json: { id: 1 }, isError: false }; };
  const { workflow } = await svc.save({ name: 'File', steps: [{ type: 'mcp', server: 'linear', tool: 'create_issue', args: '{ "title": "x" }' }] });
  const r = svc.runManual(workflow.id, {});
  await finished(svc, r.runId);
  assert.equal(svc.getRun(r.runId).status, 'ok', svc.getRun(r.runId).error);
  assert.equal(seen[0].def.url, 'https://mcp.linear.app/mcp');
  assert.deepEqual(seen[0].args, { title: 'x' });
  assert.equal(seen[0].opts.cwd, 'C:\\work');

  const { workflow: missing } = await svc.save({ name: 'Missing', steps: [{ type: 'mcp', server: 'nope', tool: 't' }] });
  const m = svc.runManual(missing.id, {});
  await finished(svc, m.runId);
  assert.match(svc.getRun(m.runId).error, /no MCP server called “nope”/);
});

test('the editor lists servers and reads a server\'s tools; the drafter is told which exist', async () => {
  const { svc, deps } = make({ servers: { linear: { type: 'http', url: 'https://x' } } });
  deps.liveMcp = () => [{ name: 'plugin:github:github' }];
  assert.deepEqual(svc.mcpServerList(null).map(s => s.name), ['linear', 'plugin:github:github']);
  assert.deepEqual(svc.draftContext().mcpServers, ['linear', 'plugin:github:github']);
  deps.listMcpTools = async def => [{ name: `from ${def.url}` }];
  assert.deepEqual(await svc.mcpTools('linear', null), { ok: true, tools: [{ name: 'from https://x' }] });
  assert.match((await svc.mcpTools('plugin:github:github', null)).error, /plugin/);
  deps.listMcpTools = async () => { throw new Error('it fell over'); };
  assert.deepEqual(await svc.mcpTools('linear', null), { ok: false, error: 'it fell over' });
});
