// Steering: what you queue while Claude works goes in at his next step, in the
// same turn, the way Claude Code's own queue does (session.js steer).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { ClaudeSession } = require('../src/main/session');
const { SessionManager } = require('../src/main/sessions');
const { History } = require('../src/main/history');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const live = new Set();
after(() => { for (const s of live) s.close(); });
const wait = ms => new Promise(r => setTimeout(r, ms));

function makeSession() {
  const s = new ClaudeSession({ exe: process.execPath, argsPrefix: [FAKE], cwd: os.tmpdir(), mode: 'ask' });
  live.add(s);
  const items = [];
  s.on('item', i => items.push(i));
  return { s, items };
}

function waitFor(session, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for item')), ms);
    session.on('item', function onItem(i) {
      if (pred(i)) { clearTimeout(t); session.off('item', onItem); resolve(i); }
    });
  });
}

// Hands the session `steers` the first time it asks, and nothing after.
function steerOnce(s, steers) {
  const asked = [];
  s.takeSteers = () => { asked.push(steers.length); const out = steers; steers = []; return out; };
  return asked;
}
const steerOf = (id, text) => ({ content: text, item: { kind: 'user', text, attachments: [], steerId: id } });
const texts = items => items.filter(i => i.kind === 'text').map(i => i.text);

test('a message queued while a tool runs goes in at the next step, in the same turn', async () => {
  const { s, items } = makeSession();
  const busy = [];
  s.on('busy', b => busy.push(b));
  steerOnce(s, [steerOf('q1', 'also add tests')]);
  s.send('steps 3 150');
  await waitFor(s, i => i.kind === 'result');
  await wait(300); // a steer left unread would have started a turn of its own by now
  const read = items.filter(i => i.kind === 'user');
  assert.deepEqual(read.map(i => [i.steerId, i.text]), [['q1', 'also add tests']]);
  assert.deepEqual(texts(items), ['steered: also add tests']);
  assert.equal(items.filter(i => i.kind === 'result').length, 1, 'one turn, not two');
  assert.deepEqual(busy, [true, false]);
  assert.ok(s.proc, 'the process carries on');
  s.close();
});

test('the steer is shown only once Claude has read it, after the step it went in at', async () => {
  const { s, items } = makeSession();
  steerOnce(s, [steerOf('q1', 'one'), steerOf('q2', 'two')]);
  s.send('steps 2 100');
  await waitFor(s, i => i.kind === 'result');
  const kinds = items.filter(i => ['tool_result', 'user', 'text'].includes(i.kind)).map(i => i.kind === 'user' ? i.steerId : i.kind);
  assert.deepEqual(kinds, ['tool_result', 'q1', 'q2', 'text']);
  assert.deepEqual(texts(items), ['steered: one | two']);
  s.close();
});

test('with nothing queued, a turn of steps runs to its end untouched', async () => {
  const { s, items } = makeSession();
  const asked = steerOnce(s, []);
  s.send('steps 2 80');
  await waitFor(s, i => i.kind === 'result');
  assert.deepEqual(texts(items), ['steps done']);
  assert.equal(asked.length >= 2, true, 'asked at each step');
  s.close();
});

// A session with nothing behind it: what it writes is kept, as if to a running CLI.
function bareSession() {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask' });
  const written = [];
  s.write = obj => written.push(obj);
  s.proc = { stdin: { writable: true } };
  s.busy = true;
  return { s, written, users: () => written.filter(w => w.type === 'user').length };
}

test("nothing goes in once you've pressed Stop, or at a tool Stop cut short", () => {
  const { s, written, users } = bareSession();
  s.takeSteers = () => [steerOf('q1', 'hi')];
  s.steer('r1', { tool_use_id: 't1', is_interrupt: true });
  assert.equal(users(), 0, 'a tool Stop cut short');
  s.interrupting = true;
  s.steer('r2', { tool_use_id: 't2' });
  assert.equal(users(), 0, 'Stop pressed, the turn winding down');
  assert.equal(written.filter(w => w.type === 'control_response').length, 2, 'each hook still answered');
});

test('a tool that failed is a step too', () => {
  const { s, users } = bareSession();
  s.takeSteers = () => [steerOf('q1', 'hi')];
  s.steer('r1', { hook_event_name: 'PostToolUseFailure', tool_use_id: 't1', error: 'Exit code 2', is_interrupt: false });
  assert.equal(users(), 1);
});

test('the CLI is asked to echo each message as Claude reads it', () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask' });
  assert.ok(s.buildArgs().includes('--replay-user-messages'));
});

test('nothing goes in while another tool of the step runs, nor at a subagent\'s tool', () => {
  const { s, written } = bareSession();
  let offered = 0;
  s.takeSteers = () => { offered++; return [steerOf('q1', 'hi')]; };
  const users = () => written.filter(w => w.type === 'user').length;

  s.steer('r1', { tool_use_id: 'sub-1', agent_id: 'agent-7' });
  assert.equal(users(), 0, "a subagent's tool doesn't let it in");

  s.trackSteps({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }, { type: 'tool_use', id: 't2' }] } });
  s.steer('r2', { tool_use_id: 't1' });
  assert.equal(users(), 0, 't2 is still running');
  s.steer('r3', { tool_use_id: 't2' });
  assert.equal(users(), 1, 'the step is done: in it goes');
  assert.equal(offered, 1);
  // Written ahead of the hook's answer, so the CLI has it before the tool's result.
  const at = written.findIndex(w => w.type === 'user');
  assert.equal(written[at + 1].response.request_id, 'r3');
  // Every hook is answered, whatever happened.
  assert.deepEqual(written.filter(w => w.type === 'control_response').map(w => w.response.request_id), ['r1', 'r2', 'r3']);
});

test('nothing goes in once the turn is over, or with no process to take it', () => {
  const { s, users } = bareSession();
  s.takeSteers = () => [steerOf('q1', 'hi')];
  s.busy = false;
  s.steer('r1', { tool_use_id: 't1' });
  assert.equal(users(), 0);
  s.busy = true;
  s.proc = { stdin: { writable: false } };
  s.steer('r2', { tool_use_id: 't2' });
  assert.equal(users(), 0);
});

test('a steer Stop beat Claude to is dropped with the process, not run as a turn of its own', async () => {
  const { s, items } = makeSession();
  steerOnce(s, [steerOf('q1', 'never read')]);
  s.send('steps 1 100 late 3000');
  await wait(600); // past the hook, inside the window before Claude reads it
  assert.equal(s.steered.length, 1, 'it went in');
  s.interrupt();
  const res = await waitFor(s, i => i.kind === 'result');
  assert.equal(res.interrupted, true);
  assert.equal(s.busy, false);
  assert.equal(s.proc, null, 'the process is let go of');
  await wait(500);
  assert.equal(items.filter(i => i.kind === 'user').length, 0, 'never shown as read');
  assert.equal(items.filter(i => i.kind === 'result').length, 1, 'and never run');
  assert.ok(!texts(items).some(t => t.includes('never read')));
  // The next message starts a fresh process that resumes the conversation.
  s.send('hello again');
  await waitFor(s, i => i.kind === 'text' && i.text.startsWith('echo: hello again'));
  assert.ok(s.buildArgs().includes('--resume'));
  s.close();
});

// ---------------------------------------------------------------- the manager

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-steer-'));
function makeManager() {
  const mgr = new SessionManager({
    getExe: () => process.execPath, argsPrefix: [FAKE], history: new History(tmp()), getMode: () => 'ask', getModel: () => '',
    compose: (text, files) => (files.length ? `${text} +${files.length}` : text),
  });
  return mgr;
}

test('the manager takes the queue only for the turn that is running', async () => {
  const mgr = makeManager();
  try {
    const tab = mgr.open({ tabId: 'steer-a', cwd: os.tmpdir() });
    const item = { id: 'q1', text: 'also this', attachments: [] };
    assert.equal(mgr.steer('steer-a', 'any', [item]), false, 'nothing running');
    const turnId = mgr.send('steer-a', 'steps 3 150', { kind: 'user', text: 'steps 3 150' });
    assert.equal(mgr.steer('steer-a', 'an-older-turn', [item]), false, 'queued behind another turn');
    assert.equal(mgr.steer('nope', turnId, [item]), false);
    assert.equal(mgr.steer('steer-a', turnId, [item, { id: 'q2', text: 'and a picture', attachments: ['C:\\a.png'] }]), true);

    const end = new Promise(r => mgr.on('item', (_id, i) => { if (i.kind === 'result') r(i); }));
    const told = [];
    mgr.on('steering', (id, ids) => told.push([id, ids]));
    const taken = mgr.takeSteers(tab);
    assert.deepEqual(taken.map(t => t.content), ['also this', 'and a picture +1']);
    assert.deepEqual(taken.map(t => t.item.steerId), ['q1', 'q2']);
    assert.deepEqual(told, [['steer-a', ['q1', 'q2']]], 'the panel is told, so the chips stop being editable');
    // The panel hasn't heard yet, and sends its queue again: what went in stays out.
    mgr.steer('steer-a', turnId, [item, { id: 'q3', text: 'third', attachments: [] }]);
    assert.deepEqual(tab.steers.map(m => m.id), ['q3']);
    await end;
    // A new turn starts with nothing steered.
    mgr.send('steer-a', 'hello', { kind: 'user', text: 'hello' });
    assert.deepEqual([tab.steers.length, tab.steeredIds.size], [0, 0]);
  } finally {
    mgr.closeAll({ kill: true });
  }
});

test("one that can't be put together stays queued, and so does all after it", async () => {
  const mgr = makeManager();
  mgr.compose = text => { if (text === 'bad') throw new Error('unreadable picture'); return text; };
  try {
    const tab = mgr.open({ tabId: 'steer-c', cwd: os.tmpdir() });
    const turnId = mgr.send('steer-c', 'steps 3 2000', { kind: 'user', text: 'steps 3 2000' });
    const q = (id, text) => ({ id, text, attachments: [] });
    mgr.steer('steer-c', turnId, [q('q1', 'fine'), q('q2', 'bad'), q('q3', 'after')]);
    const taken = mgr.takeSteers(tab);
    assert.deepEqual(taken.map(t => t.item.steerId), ['q1']);
    assert.deepEqual(tab.steers.map(m => m.id), ['q2', 'q3'], 'still waiting, not lost');
    assert.deepEqual([...tab.steeredIds], ['q1']);
  } finally {
    mgr.closeAll({ kill: true });
  }
});

test('a steer read mid-turn is kept in the transcript, in its place', async () => {
  const mgr = makeManager();
  try {
    mgr.open({ tabId: 'steer-b', cwd: os.tmpdir() });
    const turnId = mgr.send('steer-b', 'steps 3 150', { kind: 'user', text: 'steps 3 150' });
    mgr.steer('steer-b', turnId, [{ id: 'q1', text: 'use tabs', attachments: [] }]);
    await new Promise(r => mgr.on('item', (_id, i) => { if (i.kind === 'result') r(); }));
    const saved = mgr.history.load('steer-b');
    const users = saved.filter(i => i.kind === 'user');
    assert.deepEqual(users.map(i => i.text), ['steps 3 150', 'use tabs']);
    assert.equal(users[1].steerId, 'q1');
    assert.equal(users[1].turnId, undefined, 'part of the turn, not a rewind point of its own');
    const at = saved.indexOf(users[1]);
    assert.equal(saved[at - 1].kind, 'tool_result');
    assert.equal(saved[at + 1].text, 'steered: use tabs');
  } finally {
    mgr.closeAll({ kill: true });
  }
});

test('a queued message taken back by id never reaches Claude; one he has already is too late', async () => {
  const mgr = makeManager();
  try {
    const tab = mgr.open({ tabId: 'steer-x', cwd: os.tmpdir() });
    const turnId = mgr.send('steer-x', 'steps 3 2000', { kind: 'user', text: 'steps 3 2000' });
    const q = (id, text) => ({ id, text, attachments: [] });
    mgr.steer('steer-x', turnId, [q('q1', 'first'), q('q2', 'second'), q('q3', 'third')]);
    assert.equal(mgr.unsteer('steer-x', 'q2'), true);
    assert.deepEqual(tab.steers.map(m => m.id), ['q1', 'q3']);
    const taken = mgr.takeSteers(tab);
    assert.deepEqual(taken.map(t => t.item.steerId), ['q1', 'q3'], 'the one taken back stays out');
    assert.equal(mgr.unsteer('steer-x', 'q1'), false, 'Claude has it: too late');
    assert.equal(mgr.unsteer('closed-tab', 'q9'), true, 'nothing of a closed tab reaches him');
  } finally {
    mgr.closeAll({ kill: true });
  }
});

test('a steer says which message\'s turn it went into, the rewind point it shares', () => {
  const mgr = makeManager();
  try {
    const tab = mgr.open({ tabId: 'steer-t', cwd: os.tmpdir() });
    const turnId = mgr.send('steer-t', 'steps 3 2000', { kind: 'user', text: 'steps 3 2000' });
    mgr.steer('steer-t', turnId, [{ id: 'q1', text: 'also', attachments: [] }]);
    const [t] = mgr.takeSteers(tab);
    assert.equal(t.item.turnOf, turnId);
    assert.equal(t.item.turnId, undefined);
  } finally {
    mgr.closeAll({ kill: true });
  }
});
