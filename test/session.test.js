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

test('stamps when a turn starts, for the running clock, and clears it after', async () => {
  const { s } = makeSession();
  assert.equal(s.busySince, null);
  const before = Date.now();
  s.send('hello');
  assert.ok(s.busySince >= before && s.busySince <= Date.now());
  await waitFor(s, i => i.kind === 'result');
  assert.equal(s.busySince, null);
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

test('beforeWork sees a change before it happens, and can hold it back', async () => {
  const dir = require('fs').mkdtempSync(path.join(os.tmpdir(), 'shellby-gate-'));
  try {
    const { s, items } = makeSession({ cwd: dir });
    const seen = [];
    s.beforeWork = input => {
      seen.push(input.tool_name);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'not yet' } };
    };
    s.send('edit a.txt hi');
    await waitFor(s, i => i.kind === 'result');
    assert.deepEqual(seen, ['Write']);
    assert.equal(require('fs').existsSync(path.join(dir, 'a.txt')), false, 'held back');
    assert.deepEqual(texts(items), ['Branch: add-greeting']);

    // Held busy while main.js moves it, a stop() is not a crash; the next turn
    // starts a fresh process, without the hook.
    s.beforeWork = null;
    s.setBusy(true);
    await s.stop();
    assert.ok(!items.some(i => i.kind === 'error'));
    assert.equal(s.busy, true);
    s.setBusy(false);
    s.send('edit a.txt hi');
    await waitFor(s, i => i.kind === 'result' && texts(items).length === 2);
    assert.equal(require('fs').readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hi\n');
    await s.stop(); // its folder can't go while it's working there
  } finally { require('fs').rmSync(dir, { recursive: true, force: true }); }
});

test('a turn that ends with work still running in the background says what it is waiting on', () => {
  const { s, items } = makeSession();
  s.handle({ kind: 'task', phase: 'started', taskId: 'b1', description: 'Run full e2e suite' });
  s.handle({ kind: 'task', phase: 'started', taskId: 'b2', description: 'Lint' });
  s.handle({ kind: 'task', phase: 'done', taskId: 'b2', status: 'completed' });
  s.handle({ kind: 'result', ok: true, durationMs: 1000, turns: 9 });
  assert.deepEqual(items.find(i => i.kind === 'result').waiting, ['Run full e2e suite']);

  // Once it reports back, the next turn's result has nothing left to wait on.
  s.handle({ kind: 'task', phase: 'done', taskId: 'b1', status: 'completed' });
  s.handle({ kind: 'result', ok: true, durationMs: 1000, turns: 1 });
  assert.equal(items.filter(i => i.kind === 'result')[1].waiting, undefined);
});

test('reports how full the context is, and empties it on /compact', async () => {
  const { s, items } = makeSession();
  const readings = [];
  s.on('context', (now, before) => readings.push({ now, before }));
  s.send('big 170000');
  await waitFor(s, i => i.kind === 'result');
  assert.deepEqual(s.context, { tokens: 170000, window: 200000, pct: 85 });
  assert.equal(readings.at(-1).now.pct, 85);
  s.send('/compact');
  await waitFor(s, i => i.kind === 'result' && items.filter(x => x.kind === 'result').length === 2);
  assert.ok(items.some(i => i.kind === 'compacted' && i.preTokens === 170000));
  assert.equal(s.context, null);
  s.close();
});

test('a resumed conversation starts with its last reading', () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask', context: { tokens: 90000, window: 200000, pct: 45 } });
  assert.deepEqual(s.context, { tokens: 90000, window: 200000, pct: 45 });
});

// ---- the terminal's conveniences: effort, output style, control requests, rewind

const lastText = items => texts(items).at(-1);

test('effort and output style go on the command line when set, and not otherwise', async () => {
  const { s, items } = makeSession({ effort: 'high', outputStyle: 'Explanatory' });
  s.send('args');
  await waitFor(s, i => i.kind === 'result');
  const args = JSON.parse(lastText(items));
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'high']);
  assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).outputStyle, 'Explanatory');
  s.close();

  const plain = makeSession({ effort: 'bogus' });
  plain.s.send('args');
  await waitFor(plain.s, i => i.kind === 'result');
  const bare = JSON.parse(lastText(plain.items));
  assert.ok(!bare.includes('--effort') && !bare.includes('--settings'));
  plain.s.close();
});

test('setEffort reaches a running conversation before its next turn', async () => {
  const { s, items } = makeSession();
  s.send('effort');
  await waitFor(s, i => i.kind === 'result');
  assert.equal(lastText(items), 'effort:default');
  s.setEffort('max');
  s.send('effort');
  await waitFor(s, i => i.kind === 'result' && texts(items).length === 2);
  assert.equal(lastText(items), 'effort:max');
  s.close();
});

test('request: answers come back by id; errors and a stopped CLI never hang', async () => {
  const { s } = makeSession();
  assert.equal((await s.request('mcp_status')).ok, false, 'no process yet');
  s.send('hello');
  await waitFor(s, i => i.kind === 'result');
  const r = await s.request('mcp_status');
  assert.equal(r.ok, true);
  assert.deepEqual(r.response.mcpServers.map(x => x.name), ['github', 'broken']);
  const no = await s.request('made_up_request');
  assert.equal(no.ok, false);
  assert.match(no.error, /Unsupported/);
  s.close();
});

test('each result carries where its turn ends, and rewindTo resumes only that far, as a fork', async () => {
  const { s } = makeSession();
  s.send('one');
  const first = await waitFor(s, i => i.kind === 'result');
  assert.match(first.anchor, /^uuid-fake-session-1-/);
  await s.rewindTo(first.anchor);
  assert.equal(s.proc, null, 'the process is stopped');
  assert.ok(s.buildArgs().includes(`--resume-session-at=${first.anchor}`));
  assert.ok(s.buildArgs().includes('--fork-session'));
  s.send('two');
  await waitFor(s, i => i.kind === 'init');
  assert.ok(!s.buildArgs().includes('--fork-session'), 'once the fork exists it is resumed as usual');
  await waitFor(s, i => i.kind === 'result');
  s.close();
});

test('rewindTo(null) starts the conversation over', async () => {
  const { s } = makeSession();
  s.send('one');
  await waitFor(s, i => i.kind === 'result');
  await s.rewindTo(null);
  assert.equal(s.sessionId, null);
  assert.ok(!s.buildArgs().includes('--resume'));
  s.close();
});

test('a rewind saved in History is honoured when the conversation is reopened', () => {
  const s = new ClaudeSession({ exe: 'x', cwd: os.tmpdir(), mode: 'ask', resumeId: 'sess-1', resumeAt: 'uuid-9' });
  assert.ok(s.buildArgs().includes('--resume-session-at=uuid-9'));
  assert.ok(s.buildArgs().includes('--fork-session'));
  const fresh = new ClaudeSession({ exe: 'x', cwd: os.tmpdir(), mode: 'ask', resumeAt: 'uuid-9' });
  assert.ok(!fresh.buildArgs().some(a => a.startsWith('--resume')), 'nothing to resume into, so no rewind point either');
});
