const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { POSES, poseOf, latest } = require('../src/main/work-pose');
const { ClaudeSession } = require('../src/main/session');
const { applyHookEvent, summarize } = require('../src/main/external');

test('each tool has its pose, and between tools he thinks', () => {
  assert.equal(poseOf(null), 'think');
  assert.equal(poseOf('Read'), 'read');
  assert.equal(poseOf('MultiEdit'), 'write');
  assert.equal(poseOf('PowerShell'), 'run');
  assert.equal(poseOf('Grep'), 'search');
  assert.equal(poseOf('WebSearch'), 'web');
  assert.equal(poseOf('Agent'), 'crew');
  assert.equal(poseOf('mcp__github__list_issues'), 'busy', 'anything else is the scuttle he always had');
  assert.equal(poseOf('constructor'), 'busy', 'no prototype names');
});

test('every pose the renderer knows has a rule in critter.css', () => {
  const fs = require('fs');
  const css = fs.readFileSync(require.resolve('../src/renderer/critter/critter.css'), 'utf8');
  const js = fs.readFileSync(require.resolve('../src/renderer/critter/critter.js'), 'utf8');
  for (const p of POSES) {
    assert.ok(js.includes(`'${p}'`), `critter.js accepts ${p}`);
    if (p !== 'busy') assert.ok(css.includes(`body.work-${p} `), `critter.css draws ${p}`);
  }
});

test('the tool that started or finished last wins', () => {
  assert.equal(latest([]), null);
  assert.equal(latest([{ tool: 'Read', toolAt: null }]), null, 'no tool run yet');
  assert.equal(latest([{ tool: 'Read', toolAt: 5 }, { tool: null, toolAt: 9 }, { tool: 'Bash', toolAt: 7 }]).tool, null);
  assert.equal(latest([{ tool: 'Read', toolAt: 5 }, null, { tool: 'Bash', toolAt: 7 }]).tool, 'Bash');
});

test('a conversation knows the main thread tool running, and forgets it between tools', () => {
  const s = new ClaudeSession({ exe: 'x', cwd: os.tmpdir(), mode: 'ask' });
  const seen = [];
  s.on('tool', t => seen.push(t));
  const use = (id, name) => s.trackSteps({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name }] } });
  const done = id => s.trackSteps({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
  use('a', 'Read');
  use('b', 'Grep');
  assert.equal(s.tool, 'Grep');
  done('b');
  assert.equal(s.tool, 'Grep', 'Read is still out');
  done('a');
  assert.equal(s.tool, null);
  assert.ok(Number.isFinite(s.toolAt));
  assert.deepEqual(seen, ['Read', 'Grep', null]);
  s.setBusy(true);
  assert.equal(s.toolAt, null, 'a new turn starts thinking');
});

test('outside sessions: the busy one that moved last says what he does', () => {
  let m = new Map();
  const ev = (hook_event_name, session_id, extra = {}) => ({ hook_event_name, session_id, cwd: `C:\\p\\${session_id}`, ...extra });
  m = applyHookEvent(m, ev('UserPromptSubmit', 'a'), 1).sessions;
  m = applyHookEvent(m, ev('PreToolUse', 'a', { tool_name: 'Edit' }), 2).sessions;
  m = applyHookEvent(m, ev('UserPromptSubmit', 'b'), 3).sessions;
  m = applyHookEvent(m, ev('PreToolUse', 'b', { tool_name: 'WebFetch' }), 4).sessions;
  assert.equal(summarize(m).tool, 'WebFetch');
  m = applyHookEvent(m, ev('PostToolUse', 'b', { tool_name: 'WebFetch' }), 5).sessions;
  assert.equal(summarize(m).tool, null, 'b is thinking');
  m = applyHookEvent(m, ev('Stop', 'b'), 6).sessions;
  assert.equal(summarize(m).tool, 'Edit', 'an idle session has no say');
});
