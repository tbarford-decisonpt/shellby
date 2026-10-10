// Claude Code features Shellby passes through: the reply as it's written,
// prompt suggestions, a helper's words, /goal, and the newer launch flags
// (fallback model, Chrome, safe mode, an agent, the conversation's name).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const { ClaudeSession, OPTIONAL_FLAGS } = require('../src/main/session');
const { toItems, goalOf, KNOWN } = require('../src/main/stream');
const { helpFlags } = require('../src/main/claude/cli');
const handoff = require('../src/main/handoff');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const live = new Set();
after(() => { for (const s of live) s.close(); });

function makeSession(opts = {}) {
  const s = new ClaudeSession({ exe: process.execPath, argsPrefix: [FAKE], cwd: os.tmpdir(), mode: 'ask', ...opts });
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

// ---- the stream

test('a text delta on the main thread is a partial; anything else in stream_event is not', () => {
  const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, parent_tool_use_id: null });
  assert.deepEqual(toItems(delta('Hel')), [{ kind: 'partial', text: 'Hel' }]);
  assert.deepEqual(toItems({ ...delta('sub'), parent_tool_use_id: 'tu_1' }), [], "a helper's words aren't streamed into the main reply");
  assert.deepEqual(toItems({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } }), []);
  assert.deepEqual(toItems({ type: 'stream_event', event: { type: 'message_start' } }), []);
  assert.ok(KNOWN.types.has('stream_event') && KNOWN.types.has('prompt_suggestion'));
  assert.ok(KNOWN.system.has('session_title_changed'));
});

test('a prompt suggestion becomes one line of what you might ask next', () => {
  assert.deepEqual(toItems({ type: 'prompt_suggestion', suggestion: '  Now add\n a test ' }), [{ kind: 'next', text: 'Now add a test' }]);
  assert.deepEqual(toItems({ type: 'prompt_suggestion', suggestion: '' }), []);
  assert.deepEqual(toItems({ type: 'prompt_suggestion' }), []);
});

test("Claude Code's own goal notes pin, clear and meet a goal; the model's words never do", () => {
  assert.deepEqual(goalOf('Goal set: tests pass'), { kind: 'goal', text: 'tests pass' });
  assert.deepEqual(goalOf('Goal cleared: tests pass'), { kind: 'goal', text: null });
  assert.deepEqual(goalOf('Goal achieved'), { kind: 'goal', text: null, met: true });
  assert.equal(goalOf('Goal acknowledged'), null);
  const synthetic = { type: 'assistant', parent_tool_use_id: null, message: { model: '<synthetic>', content: [{ type: 'text', text: 'Goal set: ship it' }] } };
  assert.deepEqual(toItems(synthetic).map(i => i.kind), ['goal', 'text']);
  const model = { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Goal set: ship it' }] } };
  assert.deepEqual(toItems(model).map(i => i.kind), ['text'], 'only Claude Code itself can set the pin');
});

// ---- a live session on the fake CLI

test('the reply arrives in pieces before the whole of it, and the pieces add up to it', async () => {
  const { s, items } = makeSession();
  s.send('stream one two three four');
  await waitFor(s, i => i.kind === 'result');
  const partial = items.filter(i => i.kind === 'partial').map(i => i.text).join('');
  assert.equal(partial, 'one two three four');
  const lastPartial = items.findLastIndex(i => i.kind === 'partial');
  assert.ok(lastPartial < items.findIndex(i => i.kind === 'text'), 'every piece is out before the finished reply');
  s.close();
});

test('the pieces are batched, not one message per token', async () => {
  const { s, items } = makeSession();
  s.send('stream a b c d e f g h i j k l m n o p');
  await waitFor(s, i => i.kind === 'result');
  const n = items.filter(i => i.kind === 'partial').length;
  assert.ok(n >= 1 && n <= 16, `${n} pieces for 16 words`);
  s.close();
});

test('a prompt suggestion after the turn comes through as next', async () => {
  const { s } = makeSession();
  s.send('stream hi');
  const next = await waitFor(s, i => i.kind === 'next');
  assert.equal(next.text, 'Now add a test for it');
  s.close();
});

test("a helper's forwarded words become its crab's line", async () => {
  const { s } = makeSession();
  const lines = [];
  s.on('crew', crew => { for (const c of crew) if (c.said) lines.push(c.said); });
  s.send('helper says Found the bug in auth.js\nmore detail');
  await waitFor(s, i => i.kind === 'result');
  assert.ok(lines.some(l => l.text === 'Found the bug in auth.js' && l.to === null), JSON.stringify(lines));
  s.close();
});

test('/goal goes through and comes back as a goal item', async () => {
  const { s } = makeSession();
  s.send('/goal the tests pass');
  const goal = await waitFor(s, i => i.kind === 'goal');
  assert.equal(goal.text, 'the tests pass');
  s.close();
});

// ---- the launch flags

test('the newer flags only go to a Claude Code that lists them', () => {
  const opts = { exe: 'x', cwd: '.', mode: 'ask', model: 'opus', fallbackModel: 'sonnet', chrome: true, safeMode: true, agent: 'reviewer', name: () => 'Fix the login' };
  const all = new ClaudeSession(opts).buildArgs();
  for (const f of OPTIONAL_FLAGS) assert.ok(all.includes(f), `${f} with a CLI that takes it`);
  assert.equal(all[all.indexOf('--fallback-model') + 1], 'sonnet');
  assert.equal(all[all.indexOf('--agent') + 1], 'reviewer');
  assert.equal(all[all.indexOf('--name') + 1], 'Fix the login');
  const old = new ClaudeSession({ ...opts, supports: () => false }).buildArgs();
  for (const f of OPTIONAL_FLAGS) assert.ok(!old.includes(f), `${f} left out for a CLI that doesn't list it`);
  const some = new ClaudeSession({ ...opts, supports: f => f === '--name' }).buildArgs();
  assert.ok(some.includes('--name') && !some.includes('--chrome'));
});

test('no fallback to the same model, and nothing for options left off', () => {
  const same = new ClaudeSession({ exe: 'x', cwd: '.', mode: 'ask', model: 'sonnet', fallbackModel: 'sonnet' }).buildArgs();
  assert.ok(!same.includes('--fallback-model'));
  const plain = new ClaudeSession({ exe: 'x', cwd: '.', mode: 'ask' }).buildArgs();
  for (const f of ['--fallback-model', '--chrome', '--safe-mode', '--agent', '--name']) assert.ok(!plain.includes(f), f);
  assert.ok(plain.includes('--include-partial-messages') && plain.includes('--forward-subagent-text'));
});

test('a conversation name is one line, cut short, and never empty', () => {
  const args = new ClaudeSession({ exe: 'x', cwd: '.', mode: 'ask', name: () => `Fix\nthe\u202e login ${'x'.repeat(200)}` }).buildArgs();
  const name = args[args.indexOf('--name') + 1];
  assert.ok(!/[\n\u202e]/.test(name) && name.length <= 100 && name.startsWith('Fix the login'));
  assert.ok(!new ClaudeSession({ exe: 'x', cwd: '.', mode: 'ask', name: () => '  \n ' }).buildArgs().includes('--name'));
});

test('on another computer the newer flags stay here', () => {
  const s = new ClaudeSession({ exe: 'x', cwd: '.', mode: 'ask', chrome: true });
  s.remoteHost = 'box';
  const args = s.buildArgs();
  for (const f of OPTIONAL_FLAGS) assert.ok(!args.includes(f), f);
});

test('helpFlags reads the flags out of --help, and nothing that only looks like one', () => {
  const help = 'Options:\n  --add-dir <dirs>  Allow dirs\n  -n, --name <name>  Set a name\n  --safe-mode   Start clean (see --bare and -- extra)\n  --no-chrome  Off';
  assert.deepEqual(helpFlags(help), ['--add-dir', '--bare', '--name', '--no-chrome', '--safe-mode']);
  assert.deepEqual(helpFlags(''), []);
});

// ---- cloud sessions in a terminal

test('cloud, teleport and from-pr each make a fixed, checked command line', () => {
  assert.deepEqual(handoff.cloudArgs('teleport'), { ok: true, args: ['--teleport'] });
  assert.deepEqual(handoff.cloudArgs('pr'), { ok: true, args: ['--from-pr'] });
  assert.deepEqual(handoff.cloudArgs('pr', 'https://github.com/x-salmon/shellby/pull/42'), { ok: true, args: ['--from-pr', 'https://github.com/x-salmon/shellby/pull/42'] });
  assert.equal(handoff.cloudArgs('pr', 'https://evil.example/pull/1').ok, false);
  assert.equal(handoff.cloudArgs('pr', 'https://github.com/a/b/pull/1; calc').ok, false);
  assert.equal(handoff.cloudArgs('cloud', '   ').ok, false);
  assert.equal(handoff.cloudArgs('cloud', 'x'.repeat(2001)).ok, false);
  assert.deepEqual(handoff.cloudArgs('cloud', 'fix "the" tests\nnow'), { ok: true, args: ['--cloud', "fix 'the' tests now"] });
  assert.equal(handoff.cloudArgs('cloud', '--dangerously-skip-permissions').args[1], ' --dangerously-skip-permissions', 'a description is never read as a flag');
  assert.equal(handoff.cloudArgs('rm').ok, false);
});

test("a cloud session's own words reach PowerShell quoted, and never cmd", () => {
  const base = { exe: 'C:\\Claude\\claude.exe', cwd: 'C:\\code\\app', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', cmd: 'C:\\Windows\\System32\\cmd.exe' };
  const cloud = handoff.launchPlans({ ...base, cloud: { kind: 'cloud', value: "it's & | done" } });
  assert.ok(cloud.ok);
  assert.ok(!cloud.plans.some(p => p.shell === 'cmd'), 'free text never goes through cmd');
  const script = handoff.resumeScript({ exe: base.exe, cwd: base.cwd, args: ['--cloud', "it's & | done"] });
  assert.match(script, /& 'C:\\Claude\\claude\.exe' '--cloud' 'it''s & \| done'$/);
  const teleport = handoff.launchPlans({ ...base, cloud: { kind: 'teleport' } });
  assert.ok(teleport.ok && teleport.plans.some(p => p.shell === 'cmd'), 'a plain flag may');
  assert.equal(handoff.launchPlans({ ...base, cloud: { kind: 'pr', value: 'nope' } }).ok, false);
});
