const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const { ClaudeSession, setLogger } = require('../src/main/session');

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
  assert.equal(err.trouble.message, 'Claude Code stopped partway through that turn.', 'a sentence for the panel; the raw text stays in text');
  assert.equal(err.trouble.action.id, 'retry');
  assert.equal(s.busy, false);
});

test('a crash mid-turn still ends the turn with a result, after its error', async () => {
  const { s, items } = makeSession();
  s.send('crash');
  const res = await waitFor(s, i => i.kind === 'result');
  const kinds = items.map(i => i.kind);
  assert.ok(kinds.indexOf('error') >= 0 && kinds.indexOf('error') < kinds.indexOf('result'), 'the error first, then the turn ends');
  assert.equal(kinds.filter(k => k === 'result').length, 1);
  assert.equal(res.ok, false);
  assert.equal(res.interrupted, false);
  assert.equal(res.crashed, true, 'so the panel shows the error block once, not twice');
  assert.equal(res.error, 'Claude Code stopped partway through that turn.');
  assert.ok(Number.isFinite(res.durationMs));
  assert.equal(s.busy, false);
});

test('a Stop that had to end the process is a stop, not a crash, and the next turn is ordinary', async () => {
  const { s, items } = makeSession();
  s.send('crash');
  s.interrupting = true; // what interrupt() sets before its 8 s kill
  const res = await waitFor(s, i => i.kind === 'result');
  assert.equal(res.interrupted, true);
  assert.equal(res.crashed, undefined);
  assert.equal(items.filter(i => i.kind === 'error').length, 0, 'no "Claude Code exited" for a Stop you pressed');
  assert.equal(s.interrupting, false);
  s.send('hello');
  const next = await waitFor(s, i => i.kind === 'result');
  assert.equal(next.ok, true);
  assert.equal(next.interrupted, undefined, 'not reported as stopped');
  s.close();
});

test('the process going while nothing runs says nothing about a turn', () => {
  const { s, items } = makeSession();
  s.ended(0, '');
  assert.deepEqual(items, []);
});

test('an edit\'s file is read off the main thread, and what came after it still arrives after it', async () => {
  const fs = require('fs');
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-place-')));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'one\ntwo\nthree\n');
  const { s, items } = makeSession();
  s.setBusy(true);
  s.handle({ kind: 'tool', id: 't1', name: 'Edit', filePath: file, edits: [{ old: 'three', new: '3' }] });
  s.handle({ kind: 'text', text: 'after the edit' });
  s.handle({ kind: 'permission', requestId: 'r1', toolName: 'Write', filePath: file, edits: [{ old: null, new: 'x' }], suggestions: [] });
  s.handle({ kind: 'text', text: 'after the card' });
  assert.deepEqual(items, [], 'nothing overtakes the edit being placed');
  s.ended(3, ''); // and a crash meanwhile ends the turn after all of it
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(items.map(i => i.kind === 'decision' ? `decision:${i.decision}` : i.kind),
    ['tool', 'text', 'permission', 'text', 'decision:cancelled', 'error', 'result']);
  assert.equal(items[0].line, 3);
  assert.deepEqual(items[2].edits, [{ old: 'one\ntwo\nthree\n', new: 'x' }]);
  fs.rmSync(dir, { recursive: true, force: true });
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
  // Both listening before the send: on a busy machine init and result can come
  // in one stdout chunk, emitted back to back, so a result waiter added after
  // init resolves would miss it.
  const init = waitFor(s, i => i.kind === 'init');
  const done = waitFor(s, i => i.kind === 'result');
  s.send('two');
  await init;
  assert.ok(!s.buildArgs().includes('--fork-session'), 'once the fork exists it is resumed as usual');
  await done;
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

test('MCP servers a routine or workflow step may use go in as allow rules, and "only these" as a strict config', () => {
  const plain = new ClaudeSession({ exe: 'x', cwd: '.', mode: 'smart' }).buildArgs();
  assert.ok(!plain.includes('--allowedTools'));
  assert.ok(!plain.includes('--strict-mcp-config'));
  const config = { mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } };
  const args = new ClaudeSession({ exe: 'x', cwd: '.', mode: 'ask', allowedTools: ['mcp__linear__*', 'mcp__slack__*'], mcpConfig: config }).buildArgs();
  const flag = f => args[args.indexOf(f) + 1];
  assert.equal(flag('--allowedTools'), 'mcp__linear__*,mcp__slack__*');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(flag('--mcp-config')), config);
});

test('a strict MCP config reaches Claude Code in a file of its own, gone once the process ends', async () => {
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-mcpcfg-'));
  const out = path.join(dir, 'seen.json');
  const script = path.join(dir, 'cli.js');
  // A stand-in CLI that copies whatever --mcp-config names, then exits.
  fs.writeFileSync(script, `const a = process.argv; const f = a[a.indexOf('--mcp-config') + 1];
require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ file: f, text: require('fs').readFileSync(f, 'utf8') }));`);
  const config = { mcpServers: { linear: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer secret' } } } };
  const s = new ClaudeSession({ exe: process.execPath, argsPrefix: [script], cwd: dir, mode: 'ask', mcpConfig: config });
  s.start();
  assert.ok(!s.buildArgs().join(' ').includes('Bearer secret'), 'the token is not on the command line');
  await new Promise(r => s.proc.once('exit', r));
  await new Promise(r => setTimeout(r, 100));
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(JSON.parse(seen.text), config);
  assert.equal(fs.existsSync(seen.file), false, 'the file is removed with the process');
});

test('an event type Shellby has never seen is logged once, and the turn carries on', async () => {
  const warned = [];
  setLogger({ warn: (what, detail) => warned.push([what, detail]) });
  try {
    const { s, items } = makeSession();
    s.send('novel shiny_new_event');
    await waitFor(s, i => i.kind === 'result');
    s.send('novel shiny_new_event');
    await waitFor(s, i => i.kind === 'result');
    const mine = warned.filter(([, d]) => d === 'shiny_new_event');
    assert.equal(mine.length, 1, 'once per type, however often it comes');
    assert.match(mine[0][0], /does not know/);
    assert.deepEqual(texts(items), ['still here', 'still here']);
    assert.ok(!warned.some(([, d]) => ['system', 'assistant', 'result', 'rate_limit_event'].includes(d)), 'known events are never logged');
    s.close();
  } finally {
    setLogger(null);
  }
});

test('a logger that throws never breaks the session', async () => {
  setLogger({ warn: () => { throw new Error('disk full'); } });
  try {
    const { s, items } = makeSession();
    s.send('novel another_new_event');
    await waitFor(s, i => i.kind === 'result');
    assert.deepEqual(texts(items), ['still here']);
    s.close();
  } finally {
    setLogger(null);
  }
});

// ------------------------------------------------------------------ Claude knowing it's in Shellby

test('a plain session passes no note and no in-app tools', async () => {
  const { s, items } = makeSession();
  s.send('args');
  await waitFor(s, i => i.kind === 'result');
  const args = JSON.parse(texts(items)[0]);
  for (const flag of ['--append-system-prompt', '--mcp-config', '--allowedTools']) assert.ok(!args.includes(flag), flag);
  s.close();
});

test('the note and the crab tools reach the CLI, and tool calls are answered in-app', async () => {
  const crabmcp = require('../src/main/crabmcp');
  const calls = [];
  const mcp = { tools: crabmcp.toolsFor(), call: async (name, args) => { calls.push([name, args]); return { text: `did ${name}` }; } };
  const { s, items } = makeSession({ systemNote: 'You are in Shellby.', mcp });
  s.send('args');
  await waitFor(s, i => i.kind === 'result');
  const args = JSON.parse(texts(items)[0]);
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'You are in Shellby.');
  assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: { shellby: { type: 'sdk', name: 'shellby' } } });
  assert.ok(!args.includes('--strict-mcp-config'), "the user's own servers still load");
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__shellby');

  s.send('mcp tools');
  await waitFor(s, i => i.kind === 'result' && texts(items).length === 2);
  assert.equal(texts(items)[1], 'tools: say,celebrate,wear,status,suggest');

  s.send('mcp say {"text":"all green"}');
  await waitFor(s, i => i.kind === 'result' && texts(items).length === 3);
  assert.equal(texts(items)[2], 'mcp: did say');
  assert.deepEqual(calls, [['say', { text: 'all green' }]]);
  s.close();
});

test('a routine with its own MCP servers keeps them, with the crab alongside and one allow list', async () => {
  const crabmcp = require('../src/main/crabmcp');
  const mcp = { tools: crabmcp.toolsFor(), call: async name => ({ text: `did ${name}` }) };
  const mcpConfig = { mcpServers: { github: { command: 'gh-mcp' } } };
  const { s, items } = makeSession({ mcp, mcpConfig, allowedTools: ['mcp__github'] });
  s.send('args');
  await waitFor(s, i => i.kind === 'result');
  const args = JSON.parse(texts(items)[0]);
  assert.ok(args.includes('--strict-mcp-config'));
  const file = args[args.indexOf('--mcp-config') + 1];
  const written = JSON.parse(file.trimStart().startsWith('{') ? file : require('fs').readFileSync(file, 'utf8'));
  assert.deepEqual(written.mcpServers, { github: { command: 'gh-mcp' }, shellby: { type: 'sdk', name: 'shellby' } });
  assert.equal(args.filter(a => a === '--allowedTools').length, 1);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__github,mcp__shellby');
  s.send('mcp status');
  await waitFor(s, i => i.kind === 'result' && texts(items).length === 2);
  assert.equal(texts(items)[1], 'mcp: did status');
  s.close();
});

