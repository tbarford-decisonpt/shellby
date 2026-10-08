// What his claws are busy with while Claude works (workpose.js), and where the
// running tool comes from: a tab's main thread (session.js), the tabs together
// (sessions.js) and Claude Code sessions elsewhere (external.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { POSES, poseOf, latestTool } = require('../src/main/workpose');
const { ClaudeSession } = require('../src/main/session');
const { applyHookEvent, summarize } = require('../src/main/external');

test('each kind of tool has his pose', () => {
  const cases = {
    Read: 'read', Grep: 'read', Glob: 'read',
    Edit: 'write', Write: 'write', MultiEdit: 'write', NotebookEdit: 'write',
    Bash: 'shell', PowerShell: 'shell', BashOutput: 'shell',
    WebFetch: 'web', WebSearch: 'web',
    TodoWrite: 'plan', ExitPlanMode: 'plan',
    Task: 'call', Agent: 'call',
  };
  for (const [tool, pose] of Object.entries(cases)) assert.equal(poseOf(tool), pose, tool);
  for (const pose of Object.values(cases)) assert.ok(POSES.includes(pose), pose);
});

test('an MCP tool goes by its verb, and one that says nothing is his plain scuttle', () => {
  assert.equal(poseOf('mcp__plugin_playwright_playwright__browser_take_screenshot'), 'web');
  assert.equal(poseOf('mcp__plugin_github_github__get_file_contents'), 'read');
  assert.equal(poseOf('mcp__plugin_github_github__create_pull_request'), 'write');
  assert.equal(poseOf('mcp__claude_ai_Claude_Docs__batch'), null);
  for (const nothing of [null, undefined, '', 'AskUserQuestion', 'SomethingNew', 'constructor', 'toString', 42]) assert.equal(poseOf(nothing), null, String(nothing));
});

test('of several places tools run, the one that started last wins', () => {
  assert.equal(latestTool([{ tool: 'Read', toolAt: 5 }, { tool: 'Bash', toolAt: 9 }]), 'Bash');
  assert.equal(latestTool([{ tool: 'Read', toolAt: 9 }, { tool: null, toolAt: 0 }]), 'Read');
  assert.equal(latestTool([{ tool: null }, {}, null]), null);
  assert.equal(latestTool(undefined), null);
});

test("a tab's tool is the newest of its main thread's calls still running", () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask' });
  const seen = [];
  s.on('tool', t => seen.push(t));
  const use = (...blocks) => s.trackSteps({ type: 'assistant', message: { content: blocks.map(([id, name]) => ({ type: 'tool_use', id, name })) } });
  const done = id => s.trackSteps({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

  use(['t1', 'Read']);
  assert.equal(s.tool, 'Read');
  assert.ok(s.toolAt > 0);
  use(['t2', 'Grep'], ['t3', 'Edit']);
  assert.equal(s.tool, 'Edit', 'two at once: the later one');
  done('t3');
  assert.equal(s.tool, 'Grep', 'that one finished: the one still running');
  done('t1');
  done('t2');
  assert.equal(s.tool, null, 'all done: thinking between calls');
  assert.equal(s.toolAt, 0);
  assert.deepEqual(seen, ['Read', 'Edit', 'Grep', null], 'a change is told once, and a call that leaves it the same is not');
});

test('a turn that ends, or a process that stops, puts the tool down', () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask' });
  s.trackSteps({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } });
  assert.equal(s.tool, 'Bash');
  s.ended(0);
  assert.equal(s.tool, null);
});

test('a session elsewhere has a tool only while it runs, and the panel still sees the last one', () => {
  const ev = (hook_event_name, extra = {}) => ({ hook_event_name, session_id: 'abc-123', cwd: 'C:\\Users\\you\\code\\reef', ...extra });
  let sessions = new Map();
  const at = [];
  const step = (e, now) => { sessions = applyHookEvent(sessions, e, now).sessions; at.push(summarize(sessions)); };
  step(ev('UserPromptSubmit'), 1000);
  assert.equal(at.at(-1).tool, null, 'thinking');
  step(ev('PreToolUse', { tool_name: 'Read' }), 2000);
  assert.equal(at.at(-1).tool, 'Read');
  assert.equal(at.at(-1).toolAt, 2000);
  step(ev('PostToolUse', { tool_name: 'Read' }), 3000);
  assert.equal(at.at(-1).tool, null, 'done with it');
  assert.equal(at.at(-1).sessions[0].tool, 'Read', 'the panel keeps the last one used');
  const long = 'mcp__plugin_playwright_playwright__browser_take_screenshot';
  step(ev('PreToolUse', { tool_name: long }), 4000);
  assert.equal(at.at(-1).tool, long, 'an MCP name keeps the verb that decides his pose');
  step(ev('PostToolUseFailure', { tool_name: long }), 5000);
  assert.equal(at.at(-1).tool, null, 'a failed one is done too');
  step(ev('PreToolUse', { tool_name: 'Bash' }), 6000);
  step(ev('Stop'), 7000);
  assert.equal(at.at(-1).tool, null, 'the turn is over');
});

test('of two sessions elsewhere, the newest tool is the one he holds', () => {
  let sessions = new Map();
  const ev = (id, hook_event_name, extra = {}) => ({ hook_event_name, session_id: id, cwd: 'C:\\Users\\you\\code\\reef', ...extra });
  for (const [e, now] of [
    [ev('a-1', 'UserPromptSubmit'), 1], [ev('b-2', 'UserPromptSubmit'), 2],
    [ev('a-1', 'PreToolUse', { tool_name: 'Edit' }), 3], [ev('b-2', 'PreToolUse', { tool_name: 'WebSearch' }), 4],
  ]) sessions = applyHookEvent(sessions, e, now).sessions;
  assert.equal(summarize(sessions).tool, 'WebSearch');
});

// ---------------------------------------------------------------- holding a pose (shared/workposes.js)
const W = require('../src/renderer/shared/workposes');

function clock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimeout: h => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    // Each timer fires at its own time, as a real one would.
    advance(ms) {
      const end = t + ms;
      for (let h; (h = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]);) { timers.splice(timers.indexOf(h), 1); t = h.at; h.fn(); }
      t = end;
    },
  };
}

test('every pose main can send has something drawn for it', () => {
  assert.deepEqual([...W.POSES].sort(), [...POSES].sort());
  for (const [pose, item] of Object.entries(W.ITEMS)) {
    if (!item) continue;
    assert.equal(item.slot, 'held', pose);
    const w = Math.max(...item.pixels.map(r => r.length));
    assert.ok(item.pivot[0] < w && item.pivot[1] < item.pixels.length, `${pose}: the pinch is on the item`);
    for (const ch of new Set(item.pixels.join('').replace(/\./g, ''))) assert.ok(item.palette[ch], `${pose}: ${ch} has a colour`);
  }
});

test('a pose shows at once, and holds a moment before the next', () => {
  const c = clock();
  const seen = [];
  const h = W.holder((p, was) => seen.push([p, was]), c);
  h.set('read', true);
  assert.deepEqual(seen, [['read', null]], 'the first one straight away');
  c.advance(300);
  h.set('write', true);
  assert.equal(h.shown(), 'read', 'too soon: the scroll stays up');
  c.advance(W.MIN_MS - 300);
  assert.equal(h.shown(), 'write');
  c.advance(W.MIN_MS);
  h.set('shell', true);
  assert.equal(h.shown(), 'shell', 'held long enough: the next one at once');
});

test('a short think keeps the tool in his claw, and a quick read between edits gets its moment', () => {
  const c = clock();
  const h = W.holder(() => {}, c);
  h.set('write', true);
  c.advance(W.MIN_MS + 10);
  h.set(null, true); // thinking
  c.advance(W.GAP_MS - 100);
  h.set('write', true);
  c.advance(5000);
  assert.equal(h.shown(), 'write', 'the pencil never went down');
  h.set('read', true);
  h.set('write', true);
  assert.equal(h.shown(), 'read', 'the read happened, so it shows');
  c.advance(W.MIN_MS);
  assert.equal(h.shown(), 'write', '...and the pencil is back after its moment');
  c.advance(W.MIN_MS);
  h.set(null, true);
  c.advance(W.GAP_MS);
  assert.equal(h.shown(), null, 'a longer think goes back to his scuttle');
});

test('leaving work puts it all down at once, and a pose he has nothing for is his scuttle', () => {
  const c = clock();
  const h = W.holder(() => {}, c);
  h.set('web', true);
  h.set('web', false);
  assert.equal(h.shown(), null, 'no waiting once the work is over');
  c.advance(W.MIN_MS);
  h.set('juggle', true);
  assert.equal(h.shown(), null);
  h.set('constructor', true);
  assert.equal(h.shown(), null);
});
