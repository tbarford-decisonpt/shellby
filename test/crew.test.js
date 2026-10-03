const { test, after } = require('node:test');
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
const live = new Set();
after(() => { for (const s of live) s.close(); });
const track = s => (live.add(s), s);
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
  const s = track(new ClaudeSession({ exe: process.execPath, argsPrefix: [FAKE], cwd: os.tmpdir(), mode: 'ask' }));
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
  const s = track(new ClaudeSession({ exe: process.execPath, argsPrefix: [FAKE], cwd: os.tmpdir(), mode: 'ask' }));
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

// Resolves once `check()` is true, re-checking on every manager event. Unlike
// waitFor, it can't miss an event that fired before the wait started.
function until(mgr, check, ms = 8000) {
  return new Promise((resolve, reject) => {
    const done = () => { if (check()) { cleanup(); resolve(); } };
    const t = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for condition')); }, ms);
    const cleanup = () => { clearTimeout(t); mgr.off('item', done); mgr.off('aggregate', done); };
    mgr.on('item', done);
    mgr.on('aggregate', done);
    done();
  });
}

test('SessionManager runs tabs in parallel and rolls up state for the critter', async () => {
  const history = new History(tmp());
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history, getMode: () => 'ask', getModel: () => '' });
  try {
    const cwd = os.tmpdir();
    mgr.open({ tabId: 'tab-a', cwd });
    mgr.open({ tabId: 'tab-b', cwd });
    const results = new Set();
    let sawAsking = false;
    mgr.on('item', (tabId, item) => { if (item.kind === 'result') results.add(tabId); });
    mgr.on('aggregate', a => { if (a.state === 'asking' && a.pending === 1) sawAsking = true; });

    mgr.send('tab-a', 'tool one', { kind: 'user', text: 'tool one' });
    mgr.send('tab-b', 'hello two', { kind: 'user', text: 'hello two' });

    // Tab B finishes on its own while tab A waits for approval: order doesn't matter.
    // Critter updates are coalesced to one per tick, so wait for that emit too.
    await until(mgr, () => results.has('tab-b') && mgr.tabs.get('tab-a').session.pending.size === 1 && sawAsking);
    const [requestId] = mgr.tabs.get('tab-a').session.pending.keys();
    assert.ok(mgr.respond('tab-a', requestId, 'allow'));
    await until(mgr, () => results.has('tab-a'));

    const tabs = Object.fromEntries(mgr.summary.map(t => [t.id, t]));
    assert.equal(tabs['tab-a'].outcome, 'ok');
    assert.equal(tabs['tab-b'].title, 'hello two');
    assert.equal(history.get('tab-a').lastOutcome, 'ok');
    assert.ok(history.load('tab-b').some(i => i.kind === 'text' && i.text.startsWith('echo: hello two')));
  } finally {
    mgr.closeAll(); // never leave fake CLI processes behind, even on failure
  }
});

test('sending to a conversation you marked done puts it back on the list', async () => {
  const history = new History(tmp());
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history, getMode: () => 'ask', getModel: () => '' });
  try {
    mgr.open({ tabId: 'tab-done', cwd: os.tmpdir() });
    let answered = false;
    mgr.on('item', (_tabId, item) => { if (item.kind === 'result') answered = true; });
    mgr.send('tab-done', 'hello there', { kind: 'user', text: 'hello there' });
    await until(mgr, () => answered); // a busy session refuses the next send
    history.setDone('tab-done', true);
    mgr.send('tab-done', 'one more thing', { kind: 'user', text: 'one more thing' });
    assert.equal(history.get('tab-done').done, undefined, 'more work means it is not done');
  } finally {
    mgr.closeAll();
  }
});

test('a tab renamed before its first message keeps that name; a saved one renames its History entry', () => {
  const history = new History(tmp());
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history, getMode: () => 'ask', getModel: () => '' });
  try {
    mgr.open({ tabId: 'fresh', cwd: os.tmpdir() });
    assert.equal(mgr.rename('fresh', '  Login   bug  '), true);
    assert.equal(mgr.tabs.get('fresh').title, 'Login bug');
    assert.equal(mgr.summary[0].named, true);
    mgr.send('fresh', 'fix the redirect after login', { kind: 'user', text: 'fix the redirect after login' });
    assert.equal(history.get('fresh').title, 'Login bug', 'the first message does not replace a chosen name');

    mgr.open({ tabId: 'saved', cwd: os.tmpdir(), historyEntry: history.create({ id: 'saved', title: 'old name', cwd: os.tmpdir(), mode: 'ask' }) });
    assert.equal(mgr.rename('saved', 'new name'), true);
    assert.equal(mgr.tabs.get('saved').title, 'new name');
    assert.equal(history.get('saved').title, 'new name');

    assert.equal(mgr.rename('saved', '   '), false, 'a blank name changes nothing');
    assert.equal(history.get('saved').title, 'new name');
    assert.equal(mgr.rename('gone', 'x'), false);
  } finally {
    mgr.closeAll();
  }
});

// The tab order is the strip's order and the order tabs come back in next launch
// (main.js writes `summary` to config on every change), so it's worth pinning down.
test('a tab can be moved anywhere in the strip, and nowhere it would be a no-op', () => {
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history: new History(tmp()), getMode: () => 'ask', getModel: () => '' });
  const order = () => [...mgr.tabs.keys()].join('');
  for (const id of ['a', 'b', 'c', 'd']) mgr.open({ tabId: id, cwd: os.tmpdir() });

  assert.equal(mgr.reorder('d', 'a'), true, 'd moves to the front');
  assert.equal(order(), 'dabc');
  assert.equal(mgr.reorder('d', null), true, 'null means the end');
  assert.equal(order(), 'abcd');
  assert.equal(mgr.reorder('b', 'd'), true, 'and in between');
  assert.equal(order(), 'acbd');

  // Each of these would rebuild the Map and push an update for nothing.
  assert.equal(mgr.reorder('b', 'd'), false, 'already in front of d');
  assert.equal(mgr.reorder('d', null), false, 'already last');
  assert.equal(mgr.reorder('b', 'b'), false, 'in front of itself');
  assert.equal(mgr.reorder('b', 'gone'), false, 'unknown neighbour');
  assert.equal(mgr.reorder('gone', 'a'), false, 'unknown tab');
  assert.equal(order(), 'acbd', 'none of which moved anything');

  // The sessions have to come along with their ids, not just the labels.
  assert.deepEqual(mgr.summary.map(t => t.id), ['a', 'c', 'b', 'd']);
  for (const [id, tab] of mgr.tabs) assert.equal(tab.id, id, `${id} kept its own tab`);
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

test("a branch's note goes ahead of its first real message, once, and never in front of a /command", async () => {
  const history = new History(tmp());
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history, getMode: () => 'ask', getModel: () => '' });
  try {
    history.create({ id: 'branch-tab', title: '⑂ Try', cwd: os.tmpdir(), mode: 'ask' });
    history.update('branch-tab', { preamble: 'Shellby has branched this conversation into a new tab.' });
    mgr.open({ tabId: 'branch-tab', cwd: os.tmpdir(), historyEntry: history.get('branch-tab') });
    const texts = [];
    let results = 0;
    mgr.on('item', (_tabId, item) => { if (item.kind === 'text') texts.push(item.text); if (item.kind === 'result') results++; });

    mgr.send('branch-tab', '/compact', { kind: 'user', text: '/compact' });
    await until(mgr, () => results === 1);
    assert.ok(!texts.some(t => t.startsWith('noted:')), 'a /command goes as typed, without the note');
    assert.ok(history.get('branch-tab').preamble, '...and the note waits for a real message');

    mgr.send('branch-tab', 'hello', { kind: 'user', text: 'hello' });
    await until(mgr, () => results === 2);
    assert.ok(texts.includes('noted: Shellby has branched this conversation into a new tab.'), 'the note goes as a block of its own');
    assert.ok(texts.some(t => t.startsWith('echo: hello')), 'the message itself is exactly what was typed');
    assert.equal(history.get('branch-tab').preamble, null, 'once Claude has started with it, it is forgotten');

    const before = texts.length;
    mgr.send('branch-tab', 'again', { kind: 'user', text: 'again' });
    await until(mgr, () => results === 3);
    assert.ok(!texts.slice(before).some(t => t.startsWith('noted:')), 'only once');
  } finally {
    mgr.closeAll();
  }
});

test('a send while the tab is busy is refused before anything is saved or reset', async () => {
  const history = new History(tmp());
  let prepared = 0;
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history, getMode: () => 'ask', getModel: () => '', prepareTurn: () => { prepared++; return null; } });
  try {
    mgr.open({ tabId: 'tab-busy', cwd: os.tmpdir() });
    const first = mgr.send('tab-busy', 'wait 400 first', { kind: 'user', text: 'wait 400 first' });
    const tab = mgr.tabs.get('tab-busy');
    assert.equal(tab.turnId, first);
    assert.throws(() => mgr.send('tab-busy', 'second', { kind: 'user', text: 'second' }), /still working/);
    assert.equal(tab.turnId, first, 'the running turn keeps its id');
    assert.equal(prepared, 1, 'the running turn\'s snapshot is not replaced');
    assert.equal(history.load('tab-busy').filter(i => i.kind === 'user').length, 1, 'no message Claude never saw');
  } finally {
    mgr.closeAll({ kill: true });
  }
});
