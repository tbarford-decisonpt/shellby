const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { ClaudeSession } = require('../src/main/session');
const { SessionManager, MAX_TABS } = require('../src/main/sessions');
const { History } = require('../src/main/history');
const { annotatePermission, referencedFiles, selfConfigTarget } = require('../src/main/safety');
const { toItems } = require('../src/main/stream');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-crew-'));

function waitFor(emitter, event, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    emitter.on(event, function h(...args) {
      if (pred(...args)) { clearTimeout(t); emitter.off(event, h); resolve(args); }
    });
  });
}

// ---------------------------------------------------------------- stream parsing

test('task_* events become task items keyed by task id and Agent call id', () => {
  const [s] = toItems({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'tu1', description: 'Count files', subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1 });
  assert.deepEqual([s.kind, s.phase, s.taskId, s.toolUseId, s.subagentType, s.background], ['task', 'started', 'a1', 'tu1', 'Explore', true]);
  const [p] = toItems({ type: 'system', subtype: 'task_progress', task_id: 'a1', last_tool_name: 'Glob', usage: { total_tokens: 5, tool_uses: 2, duration_ms: 30 } });
  assert.deepEqual(p.usage, { tokens: 5, toolUses: 2, durationMs: 30 });
  assert.equal(p.lastTool, 'Glob');
  assert.equal(toItems({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'failed' } })[0].status, 'failed');
  assert.equal(toItems({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'ok' })[0].phase, 'done');
});

test('Agent tool calls carry subagent info; child messages carry their parent', () => {
  const [agent] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Scan', run_in_background: true } }] } });
  assert.deepEqual(agent.agent, { type: 'Explore', description: 'Scan', background: true });
  const [child] = toItems({ type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: 'C:\\a.ps1' } }] } });
  assert.equal(child.parent, 'tu1');
  assert.equal(child.filePath, 'C:\\a.ps1');
});

test('init exposes the toolbox lists from the CLI', () => {
  const [init] = toItems({ type: 'system', subtype: 'init', session_id: 's', skills: ['a', 3], agents: ['x'], slash_commands: ['a', 'b'], mcp_servers: [{ name: 'm', status: 'connected' }, { bad: 1 }], plugins: [{ name: 'p', path: 'C:\\p' }] });
  assert.deepEqual(init.toolbox.skills, ['a']);
  assert.equal(init.toolbox.mcp_servers.length, 1);
  assert.equal(init.toolbox.plugins[0].name, 'p');
});

// ---------------------------------------------------------------- safety flags

test('flags a command that runs a file Claude wrote this session', () => {
  const created = ['C:\\proj\\tools\\cleanup.ps1', 'C:\\proj\\notes.md'];
  assert.deepEqual(referencedFiles('powershell -File .\\tools\\cleanup.ps1', created), ['C:\\proj\\tools\\cleanup.ps1']);
  assert.deepEqual(referencedFiles('& "C:/proj/tools/cleanup.ps1" -Force', created), ['C:\\proj\\tools\\cleanup.ps1']);
  assert.deepEqual(referencedFiles('Get-Content notes.md', created), ['C:\\proj\\notes.md']);
  assert.deepEqual(referencedFiles('Get-ChildItem', created), []);
  assert.deepEqual(referencedFiles('echo mycleanup.ps1x', created), []);
});

test('flags changes to Claude Code\'s own setup', () => {
  assert.equal(selfConfigTarget('C:\\Users\\me\\.claude\\skills\\csv\\SKILL.md'), 'a skill');
  assert.equal(selfConfigTarget('C:\\Users\\me\\.claude\\settings.json'), "Claude Code's settings");
  assert.equal(selfConfigTarget('C:\\proj\\CLAUDE.md'), 'CLAUDE.md instructions');
  assert.equal(selfConfigTarget('Set-Content C:\\x\\.claude\\hooks\\pre.js "..."'), 'a hook script');
  assert.equal(selfConfigTarget('C:\\proj\\src\\index.js'), null);
});

test('annotatePermission attributes subagent prompts to their task', () => {
  const tasks = new Map([['a1', { toolUseId: 'tu1', description: 'Clean up', subagentType: 'general-purpose' }]]);
  const flags = annotatePermission({ toolName: 'Write', agentId: 'a1', filePath: 'C:\\x.txt', input: {} }, { tasks });
  assert.deepEqual(flags.agent, { taskId: 'a1', toolUseId: 'tu1', description: 'Clean up', type: 'general-purpose' });
});

// ---------------------------------------------------------------- live sessions (fake CLI)

test('subagent permission prompts arrive tagged with their crew member', async () => {
  const s = new ClaudeSession({ exe: process.execPath, argsPrefix: [FAKE], cwd: os.tmpdir(), mode: 'ask' });
  const items = [];
  const crewSnapshots = [];
  s.on('item', i => items.push(i));
  s.on('crew', c => crewSnapshots.push(c.map(t => t.status)));
  s.send('crew go');
  const [perm] = await waitFor(s, 'item', i => i.kind === 'permission');
  assert.equal(perm.agent.description, 'Write crew file');
  assert.equal(perm.agent.toolUseId, 'tu_agent');
  assert.equal(s.runningCrew().length, 1);
  s.respond(perm.requestId, 'allow');
  await waitFor(s, 'item', i => i.kind === 'result');
  assert.equal(s.runningCrew().length, 0);
  assert.deepEqual(crewSnapshots.at(-1), ['completed']);
  const child = items.find(i => i.kind === 'tool' && i.id === 'tu_sub');
  assert.equal(child.parent, 'tu_agent');
  assert.ok(items.find(i => i.kind === 'tool_result' && i.id === 'tu_agent').agentStats.tokens === 200);
  s.close();
});

test('running a script Claude just wrote is flagged on the permission card', async () => {
  const s = new ClaudeSession({ exe: process.execPath, argsPrefix: [FAKE], cwd: os.tmpdir(), mode: 'ask' });
  s.send('script please');
  const [write] = await waitFor(s, 'item', i => i.kind === 'permission');
  assert.equal(write.runsCreated, undefined);
  s.respond(write.requestId, 'allow');
  const [run] = await waitFor(s, 'item', i => i.kind === 'permission' && i.toolName === 'PowerShell');
  assert.deepEqual(run.runsCreated, ['C:\\tmp\\tools\\cleanup.ps1']);
  s.respond(run.requestId, 'deny');
  await waitFor(s, 'item', i => i.kind === 'result');
  s.close();
});

test('SessionManager runs tabs in parallel and rolls up state for the critter', async () => {
  const history = new History(tmp());
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history, getMode: () => 'ask', getModel: () => '' });
  const cwd = os.tmpdir();
  mgr.open({ tabId: 'tab-a', cwd });
  mgr.open({ tabId: 'tab-b', cwd });
  const results = new Set();
  mgr.on('item', (tabId, item) => { if (item.kind === 'result') results.add(tabId); });

  mgr.send('tab-a', 'tool one', { kind: 'user', text: 'tool one' });
  mgr.send('tab-b', 'hello two', { kind: 'user', text: 'hello two' });
  const [agg] = await waitFor(mgr, 'aggregate', a => a.state === 'asking');
  assert.equal(agg.pending, 1);

  await waitFor(mgr, 'item', (tabId, item) => tabId === 'tab-b' && item.kind === 'result');
  const perm = history.load('tab-a').find(i => i.kind === 'permission');
  assert.ok(mgr.respond('tab-a', perm.requestId, 'allow'));
  await waitFor(mgr, 'item', (tabId, item) => tabId === 'tab-a' && item.kind === 'result');

  assert.deepEqual([...results].sort(), ['tab-a', 'tab-b']);
  const tabs = Object.fromEntries(mgr.summary.map(t => [t.id, t]));
  assert.equal(tabs['tab-a'].outcome, 'ok');
  assert.equal(tabs['tab-b'].title, 'hello two');
  assert.equal(history.get('tab-a').lastOutcome, 'ok');
  assert.ok(history.load('tab-b').some(i => i.kind === 'text' && i.text.startsWith('echo: hello two')));
  mgr.closeAll();
});

test('SessionManager enforces the tab limit and pins routine modes', () => {
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history: new History(tmp()), getMode: () => 'ask', getModel: () => '' });
  for (let i = 0; i < MAX_TABS; i++) mgr.open({ tabId: `t${i}`, cwd: os.tmpdir() });
  assert.throws(() => mgr.open({ tabId: 'one-too-many', cwd: os.tmpdir() }), /up to/);
  assert.throws(() => mgr.open({ tabId: '../evil', cwd: os.tmpdir() }), /bad tab id/);
  mgr.closeAll();
  const r = mgr.open({ tabId: 'routine', cwd: os.tmpdir(), mode: 'smart' });
  mgr.setMode('plan');
  assert.equal(r.session.mode, 'smart');
  mgr.closeAll();
});
