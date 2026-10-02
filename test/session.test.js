const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const { ClaudeSession } = require('../src/main/session');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');

const live = new Set();
after(() => { for (const s of live) s.close(); }); // no orphaned fake CLIs if a test fails midway

function makeSession(opts = {}) {
  const s = new ClaudeSession({ exe: process.execPath, argsPrefix: [FAKE], cwd: os.tmpdir(), mode: 'ask', ...opts });
  live.add(s);
  const items = [];
  s.on('item', i => items.push(i));
  return { s, items };
}

// Resolves with the first item matching `pred`, or rejects after `ms`.
function waitFor(session, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for item')), ms);
    session.on('item', function onItem(i) {
      if (pred(i)) { clearTimeout(t); session.off('item', onItem); resolve(i); }
    });
  });
}

const texts = items => items.filter(i => i.kind === 'text').map(i => i.text);

test('runs a turn, captures the session id and reports busy state', async () => {
  const { s, items } = makeSession();
  const busy = [];
  s.on('busy', b => busy.push(b));
  s.send('hello');
  await waitFor(s, i => i.kind === 'result');
  assert.equal(s.sessionId, 'fake-session-1');
  assert.deepEqual(texts(items), ['echo: hello (mode=default)']);
  assert.deepEqual(busy, [true, false]);
  assert.ok(items.some(i => i.kind === 'usage' && i.fiveHour.pct === 25));
  s.close();
});

test('a follow-up can be sent from inside the result handler', async () => {
  const { s, items } = makeSession();
  s.on('item', i => { if (i.kind === 'result' && texts(items).length === 1) s.send('second'); });
  s.send('first');
  await waitFor(s, i => i.kind === 'result' && texts(items).length === 2);
  assert.equal(texts(items)[1], 'echo: second (mode=default)');
  s.close();
});

test('keeps context across turns in one process and rejects sends while busy', async () => {
  const { s, items } = makeSession();
  s.send('one');
  assert.throws(() => s.send('two'), /still working/);
  await waitFor(s, i => i.kind === 'result');
  s.send('two');
  await waitFor(s, i => i.kind === 'result' && texts(items).length === 2);
  assert.deepEqual(texts(items), ['echo: one (mode=default)', 'echo: two (mode=default)']);
  s.close();
});

test('permission request -> allow', async () => {
  const { s, items } = makeSession();
  s.send('tool please');
  const perm = await waitFor(s, i => i.kind === 'permission');
  assert.equal(perm.toolName, 'Write');
  assert.equal(perm.label, 'Created');
  assert.ok(s.respond(perm.requestId, 'allow'));
  await waitFor(s, i => i.kind === 'result');
  assert.ok(texts(items).includes('ALLOWED'));
  assert.ok(items.some(i => i.kind === 'decision' && i.decision === 'allow'));
  s.close();
});

test('permission request -> always sends the suggested rules', async () => {
  const { s, items } = makeSession();
  s.send('tool please');
  const perm = await waitFor(s, i => i.kind === 'permission');
  s.respond(perm.requestId, 'always');
  await waitFor(s, i => i.kind === 'result');
  assert.ok(texts(items).includes('ALLOWED +always'));
  s.close();
});

test('permission request -> deny, and stale answers are ignored', async () => {
  const { s, items } = makeSession();
  s.send('tool please');
  const perm = await waitFor(s, i => i.kind === 'permission');
  assert.ok(s.respond(perm.requestId, 'deny'));
  assert.equal(s.respond(perm.requestId, 'allow'), false);
  await waitFor(s, i => i.kind === 'result');
  assert.ok(texts(items).includes('DENIED'));
  const tr = items.find(i => i.kind === 'tool_result');
  assert.equal(tr.isError, true);
  s.close();
});

test('interrupt stops a running turn and marks the result as interrupted', async () => {
  const { s } = makeSession();
  s.send('slow task');
  await waitFor(s, i => i.kind === 'tool');
  s.interrupt();
  const res = await waitFor(s, i => i.kind === 'result');
  assert.equal(res.interrupted, true);
  assert.equal(s.busy, false);
  s.close();
});

test('mode switches mid-session reach the CLI', async () => {
  const { s, items } = makeSession();
  s.send('a');
  await waitFor(s, i => i.kind === 'result');
  s.setMode('plan');
  s.send('b');
  await waitFor(s, i => i.kind === 'result' && texts(items).length === 2);
  assert.equal(texts(items)[1], 'echo: b (mode=plan)');
  s.close();
});

test('passes mode, model and resume id as CLI flags', () => {
  const s = new ClaudeSession({ exe: 'x', cwd: '.', mode: 'smart', model: 'opus', resumeId: 'abc' });
  const args = s.buildArgs();
  const flag = f => args[args.indexOf(f) + 1];
  assert.equal(flag('--permission-mode'), 'auto');
  assert.equal(flag('--model'), 'opus');
  assert.equal(flag('--resume'), 'abc');
  assert.equal(flag('--permission-prompt-tool'), 'stdio');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('a crash mid-turn surfaces an error and clears busy', async () => {
  const { s } = makeSession();
  s.send('crash');
  const err = await waitFor(s, i => i.kind === 'error');
  assert.match(err.text, /exited|code 3/);
  assert.equal(s.busy, false);
});

// ---- waiting for main.js before Claude sees a message (worktree + snapshot)

test('a turn can wait for something first, and starts in the folder it settles on', async () => {
  const { s, items } = makeSession();
  let release;
  const ready = new Promise(r => { release = r; });
  s.send('after the wait', ready);
  assert.equal(s.busy, true, 'busy at once, so typing more still queues');
  assert.equal(s.proc, null, 'no process until it is ready');
  assert.throws(() => s.send('another'), /still working/);
  s.cwd = os.homedir(); // e.g. moved into a worktree while waiting
  release();
  await waitFor(s, i => i.kind === 'result');
  assert.deepEqual(texts(items), ['echo: after the wait (mode=default)']);
  s.close();
});

test('stopping a turn that is still waiting ends it without Claude ever seeing it', async () => {
  const { s, items } = makeSession();
  let release;
  s.send('never sent', new Promise(r => { release = r; }));
  s.interrupt();
  assert.equal(s.busy, false);
  const result = items.find(i => i.kind === 'result');
  assert.equal(result.interrupted, true);
  release();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(s.proc, null, 'nothing started after the stop');
  assert.deepEqual(texts(items), []);
});

test('closing a tab while its first message waits means it never goes', async () => {
  const { s } = makeSession();
  let release;
  s.send('never', new Promise(r => { release = r; }));
  s.close();
  release();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(s.proc, null, 'no Claude process for a closed tab');
});

test('a wait that fails still sends the turn', async () => {
  const { s, items } = makeSession();
  s.send('anyway', Promise.reject(new Error('snapshot failed')));
  await waitFor(s, i => i.kind === 'result');
  assert.deepEqual(texts(items), ['echo: anyway (mode=default)']);
  s.close();
});
