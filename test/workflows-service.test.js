const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { WorkflowService } = require('../src/main/workflows/service');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await tick(5); }
  throw new Error('timed out waiting');
}

// A stand-in for SessionManager: every send gets a reply. `reply(prompt)` decides what Claude says.
class FakeManager extends EventEmitter {
  constructor(reply = p => `ok: ${p.slice(0, 30)}`) {
    super();
    this.tabs = new Map();
    this.reply = reply;
    this.sent = [];
  }
  open({ tabId, cwd, mode, workflowRunId, title }) {
    const session = { cwd, mode, busy: false, proc: null, pending: new Map(), setMode(m) { this.mode = m; }, stop: async () => {} };
    const tab = { id: tabId, session, workflowRunId, title };
    this.tabs.set(tabId, tab);
    return tab;
  }
  send(tabId, prompt) {
    const tab = this.tabs.get(tabId);
    this.sent.push({ tabId, prompt, mode: tab.session.mode, cwd: tab.session.cwd });
    tab.session.busy = true;
    setImmediate(() => {
      tab.session.busy = false;
      this.emit('item', tabId, { kind: 'text', text: this.reply(prompt) });
      this.emit('item', tabId, { kind: 'result', ok: true });
    });
  }
  isBusy(id) { return !!this.tabs.get(id)?.session.busy; }
  interrupt(id) { this.emit('item', id, { kind: 'result', ok: false, interrupted: true }); }
  close(id) { this.tabs.delete(id); }
}

function make(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-wf-'));
  const store = { workflows: over.workflows || [] };
  const calls = { notify: [], phone: [], say: [], confirm: [], panel: [], copy: [], commands: [] };
  const manager = over.manager || new FakeManager();
  let confirmAnswer = over.confirmAnswer ?? 0;
  const deps = {
    config: { get: k => store[k], set: o => Object.assign(store, o) },
    dataDir: dir, home: 'C:\\Users\\me', manager, maxTabs: 3,
    openTab: opts => manager.open(opts),
    closeTab: id => manager.close(id),
    currentCwd: () => 'C:\\work',
    claudeReady: () => true,
    allowAutonomous: () => false,
    confirm: async spec => { calls.confirm.push(spec); return confirmAnswer; },
    notify: (...a) => calls.notify.push(a),
    tellPhone: e => calls.phone.push(e),
    say: t => calls.say.push(t),
    showWorkflows: () => {},
    toPanel: (c, p) => calls.panel.push([c, p]),
    runCommand: async (cwd, raw, { env = {} } = {}) => {
      // What PowerShell would run, with ${env:…} filled in.
      const command = raw.replace(/\$\{env:(\w+)\}/g, (_, n) => env[n] ?? '');
      calls.commands.push({ cwd, command, raw });
      return over.command ? over.command(command) : { output: 'done', code: 0 };
    },
    runClaude: over.runClaude || (async () => ({ stdout: '' })),
    copy: t => calls.copy.push(t),
    crypto: { available: () => true, encrypt: t => Buffer.from(`enc:${t}`), decrypt: b => String(b).slice(4) },
    webhookPort: () => 47913,
    log: { info: () => {}, warn: () => {} },
  };
  const svc = new WorkflowService(deps);
  svc.workflows = svc.loadWorkflows();
  return { svc, deps, calls, store, manager, dir, setConfirm: v => { confirmAnswer = v; } };
}

const simple = (over = {}) => ({ name: 'Hello', steps: [{ type: 'tell', to: 'crab', text: 'hi {{ inputs.who }}' }], inputs: [{ name: 'who', default: 'you' }], ...over });

test('saving a quiet workflow needs no confirmation; a risky one does', async () => {
  const { svc, calls, setConfirm } = make();
  const r = await svc.save(simple());
  assert.equal(r.ok, true);
  assert.equal(calls.confirm.length, 0);
  assert.equal(svc.view().workflows.length, 1);

  const risky = await svc.save({ name: 'Risky', steps: [{ type: 'run', command: 'npm publish' }] });
  assert.equal(risky.ok, true);
  assert.equal(calls.confirm.length, 1);
  assert.match(calls.confirm[0].detail, /npm publish/);

  // Renaming doesn't ask again; changing the command does, and a no keeps the old one.
  await svc.save({ ...risky.workflow, name: 'Risky 2' });
  assert.equal(calls.confirm.length, 1);
  setConfirm(1);
  const declined = await svc.save({ ...svc.byName('Risky 2'), steps: [{ type: 'run', command: 'rm -r C:\\' }] });
  assert.equal(declined.ok, false);
  assert.equal(svc.byName('Risky 2').steps[0].command, 'npm publish');
});

test('names are unique, and a workflow cannot trigger itself', async () => {
  const { svc } = make();
  await svc.save(simple());
  const dup = await svc.save(simple({ name: 'hello' }));
  assert.equal(dup.errors[0].path, 'name');
  const loop = await svc.save(simple({ name: 'Loop', when: [{ type: 'workflow', name: 'Loop' }] }));
  assert.equal(loop.ok, false);
});

test('a manual run goes through every step and is recorded', async () => {
  const { svc, calls } = make();
  const { workflow } = await svc.save(simple());
  const r = svc.runManual(workflow.id, { who: 'Jo' });
  assert.equal(r.ok, true);
  await until(() => svc.getRun(r.runId)?.status === 'ok');
  assert.deepEqual(calls.say, ['hi Jo']);
  assert.equal(svc.listRuns(workflow.id)[0].status, 'ok');
  assert.equal(svc.view().workflows[0].lastRun.status, 'ok');
});

test('required inputs are enforced', async () => {
  const { svc } = make();
  const { workflow } = await svc.save(simple({ inputs: [{ name: 'who', required: true }] }));
  assert.match(svc.runManual(workflow.id, {}).error, /needed/);
});

test('Claude steps share one conversation and get typed fields back', async () => {
  const manager = new FakeManager(p => (p.includes('JSON') ? 'Looked.\n```json\n{"count": 3}\n```' : 'Done it.'));
  const { svc } = make({ manager });
  const { workflow } = await svc.save({ name: 'Two steps', steps: [
    { id: 'look', type: 'claude', mode: 'plan', prompt: 'Count things', output: { count: 'number' } },
    { type: 'claude', mode: 'plan', prompt: 'Now act on {{ look.count }}' },
    { type: 'claude', mode: 'plan', prompt: 'Fresh look', fresh: true },
  ] });
  const r = svc.runManual(workflow.id);
  await until(() => svc.getRun(r.runId)?.status === 'ok');
  const rec = svc.getRun(r.runId);
  assert.equal(rec.steps.s0.output.count, 3);
  assert.equal(manager.sent[0].tabId, manager.sent[1].tabId);
  assert.notEqual(manager.sent[2].tabId, manager.sent[0].tabId);
  assert.match(manager.sent[1].prompt, /Now act on «3»/);
  assert.ok(svc.ownsTab(manager.sent[0].tabId));
});

test('a Claude step frees an old workflow tab when every slot is taken, but never yours', async () => {
  const manager = new FakeManager();
  const { svc } = make({ manager });
  manager.open({ tabId: 'mine-1', cwd: 'C:\\' });
  manager.open({ tabId: 'mine-2', cwd: 'C:\\' });
  const { workflow } = await svc.save({ name: 'C', steps: [{ type: 'claude', mode: 'plan', prompt: 'x' }] });
  const a = svc.runManual(workflow.id);
  await until(() => svc.getRun(a.runId)?.status === 'ok');
  const b = svc.runManual(workflow.id);
  await until(() => svc.getRun(b.runId)?.status === 'ok');
  assert.ok(manager.tabs.has('mine-1') && manager.tabs.has('mine-2'));
  assert.equal(manager.tabs.size, 3);
  // All three taken by your own tabs: the step fails, nothing of yours is closed.
  manager.tabs.clear();
  ['a', 'b', 'c'].forEach(id => manager.open({ tabId: id, cwd: 'C:\\' }));
  const c = svc.runManual(workflow.id);
  await until(() => ['error', 'ok'].includes(svc.getRun(c.runId)?.status));
  assert.match(svc.getRun(c.runId).error, /conversations are open/);
});

test('events start matching workflows; skip and queue concurrency', async () => {
  let release;
  const { svc, calls } = make({ command: () => new Promise(r => { release = () => r({ output: '', code: 0 }); }) });
  const { workflow } = await svc.save({ name: 'On red', when: [{ type: 'ci', on: 'failed' }], steps: [{ type: 'run', command: 'echo {{ trigger.repo }}' }] });
  svc.event('ci', { event: 'passed', repo: 'x/y' });
  svc.event('ci', { event: 'failed', repo: 'x/y' });
  await until(() => calls.commands.length === 1);
  assert.equal(calls.commands[0].command, 'echo x/y');
  // Already running: skipped.
  svc.event('ci', { event: 'failed', repo: 'x/y' });
  release();
  await until(() => svc.listRuns(workflow.id)[0]?.status === 'ok');
  assert.equal(svc.listRuns(workflow.id).length, 1);

  await svc.save({ ...svc.get(workflow.id), concurrency: 'queue' });
  svc.event('ci', { event: 'failed', repo: 'a/b' });
  await until(() => calls.commands.length === 2);
  svc.event('ci', { event: 'failed', repo: 'c/d' });
  release();
  await until(() => calls.commands.length === 3);
  assert.equal(calls.commands[2].command, 'echo c/d');
  release();
  await until(() => svc.listRuns(workflow.id).every(s => s.status === 'ok') && svc.listRuns(workflow.id).length === 3);
});

test('a workflow that starts too often is paused', async () => {
  const { svc, calls } = make();
  const { workflow } = await svc.save({ name: 'Chatty', when: [{ type: 'health' }], steps: [{ type: 'tell', to: 'crab', text: 'x' }] });
  svc.rate.limit = 2;
  for (let i = 0; i < 3; i++) { svc.event('health', {}); await until(() => svc.active.size === 0); }
  assert.equal(svc.get(workflow.id).enabled, false);
  assert.match(calls.notify.at(-1)[0], /Paused/);
});

test('asks wait for an answer; a wrong answer is refused', async () => {
  const { svc, calls } = make();
  const { workflow } = await svc.save({ name: 'Gate', steps: [{ id: 'q', type: 'ask', question: 'Ship it?', choices: ['Ship', 'Hold'] }, { type: 'tell', to: 'crab', text: '{{ q.choice }}' }] });
  const r = svc.runManual(workflow.id);
  await until(() => svc.getRun(r.runId)?.status === 'waiting');
  assert.equal(svc.listRuns()[0].waiting.question, 'Ship it?');
  assert.equal(calls.phone[0].kind, 'asking');
  assert.equal(svc.answer(r.runId, 's0', 'Maybe').ok, false);
  assert.equal(svc.answer(r.runId, 's0', 'Hold').ok, true);
  await until(() => svc.getRun(r.runId)?.status === 'ok');
  assert.deepEqual(calls.say, ['Hold']);
  assert.equal(svc.answer(r.runId, 's0', 'Hold').ok, false);
});

test('stop, then resume from where it stopped', async () => {
  let n = 0;
  const { svc, calls } = make({ command: () => ({ output: '', code: ++n === 2 ? 1 : 0 }) });
  const { workflow } = await svc.save({ name: 'Flaky', steps: [{ type: 'run', command: 'one' }, { type: 'run', command: 'two' }, { type: 'run', command: 'three' }] });
  const r = svc.runManual(workflow.id);
  await until(() => svc.getRun(r.runId)?.status === 'error');
  assert.equal(svc.resumeRun(r.runId).ok, true);
  await until(() => svc.getRun(r.runId)?.status === 'ok');
  assert.deepEqual(calls.commands.map(c => c.command), ['one', 'two', 'two', 'three']);
});

test('after a restart: running runs are interrupted, waiting ones carry on', async () => {
  const first = make();
  const { workflow } = await first.svc.save({ name: 'Gate', steps: [{ type: 'ask', question: 'Go?' }] });
  const r = first.svc.runManual(workflow.id);
  await until(() => first.svc.getRun(r.runId)?.status === 'waiting');
  first.svc.shutdown();
  // A second "Shellby" over the same folder and settings.
  const fakeRunning = { ...first.svc.getRun(r.runId), id: 'run-crashed', status: 'running' };
  fs.writeFileSync(path.join(first.dir, 'runs', 'run-crashed.json'), JSON.stringify(fakeRunning));
  const second = new WorkflowService({ ...first.deps });
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms > 1000 ? 1 : ms, ...a);
  try {
    second.start();
    assert.equal(second.getRun('run-crashed').status, 'interrupted');
    await until(() => second.active.has(r.runId));
    await until(() => second.getRun(r.runId)?.status === 'waiting');
    assert.equal(second.answer(r.runId, 's0', 'Continue').ok, true);
    await until(() => second.getRun(r.runId)?.status === 'ok');
  } finally {
    global.setTimeout = realSetTimeout;
    second.shutdown();
  }
});

test('Claude may run only workflows that allow it', async () => {
  const { svc } = make();
  await svc.save(simple());
  await svc.save(simple({ name: 'Open', when: [{ type: 'claude' }] }));
  assert.equal(svc.runFromClaude('nope', {}).status, 404);
  assert.equal(svc.runFromClaude('hello', {}).status, 403);
  const r = svc.runFromClaude('open', { who: 'Claude' });
  assert.match(r.text, /Started “Open”/);
  const list = svc.claudeList();
  assert.deepEqual(list.map(w => w.claudeCanRun), [false, true]);
});

test('Claude proposals: always confirmed, no Autonomous, a pause after a no', async () => {
  const { svc, calls, setConfirm } = make();
  const auto = await svc.proposeFromClaude({ name: 'Auto', steps: [{ type: 'claude', prompt: 'x', mode: 'autonomous' }] });
  assert.equal(auto.status, 400);
  const yes = await svc.proposeFromClaude({ name: 'Brief', steps: [{ type: 'claude', prompt: 'summarise', mode: 'plan' }] });
  assert.match(yes.text, /Added the “Brief” workflow/);
  assert.equal(calls.confirm.length, 1);
  assert.match(calls.confirm[0].message, /Claude wants to add/);
  setConfirm(1);
  const no = await svc.proposeFromClaude({ name: 'Brief', steps: [{ type: 'claude', prompt: 'other', mode: 'plan' }] });
  assert.match(no.text, /decided not to change/);
  const soon = await svc.proposeFromClaude({ name: 'Again', steps: [{ type: 'tell', text: 'x' }] });
  assert.equal(soon.status, 429);
});

test('the confirmation shows risky steps in full, and refuses a proposal too long to show', async () => {
  const { svc, calls } = make();
  const tail = `${'Write-Output ok; '.repeat(30)}Remove-Item C:\\important -Recurse`;
  await svc.save({ name: 'Long command', steps: [{ type: 'run', command: tail }, { type: 'http', method: 'POST', url: 'https://api.x.com/a', headers: { Authorization: 'Bearer {{ secrets.TOKEN }}' }, body: '{"a":1}' }] });
  const detail = calls.confirm[0].detail;
  assert.ok(detail.includes('Remove-Item C:\\important -Recurse'), 'the end of a long command is shown');
  assert.match(detail, /POST https:\/\/api\.x\.com\/a/);
  assert.match(detail, /Headers: Authorization/);
  assert.match(detail, /Uses these secrets: TOKEN/);
  const huge = { name: 'Huge', steps: Array.from({ length: 4 }, (_, i) => ({ type: 'run', command: `Write-Output ${i} ${'x'.repeat(3500)}` })) };
  const r = await svc.proposeFromClaude(huge);
  assert.equal(r.ok, false);
  assert.match(r.error, /too long to show in full/);
  assert.equal(calls.confirm.length, 1, 'no window was shown for it');
});

test('web hooks start the workflow with the matching token only', async () => {
  const { svc, calls } = make();
  const { workflow } = await svc.save({ name: 'Hook', when: [{ type: 'webhook' }], inputs: [{ name: 'msg' }], steps: [{ type: 'tell', to: 'crab', text: '{{ inputs.msg }} / {{ trigger.extra }}' }] });
  const token = workflow.when[0].token;
  assert.equal(svc.webhook({ hook: 'f'.repeat(48), data: {} }).status, 404);
  assert.equal(svc.webhook({ hook: 'not hex' }).status, 404);
  const r = svc.webhook({ hook: token, data: { msg: 'hi', extra: 'there' } });
  assert.match(r.text, /Started/);
  await until(() => calls.say.length === 1);
  assert.deepEqual(calls.say, ['hi / there']);
});

test('import and export round-trip, without ids or hook tokens', async () => {
  const { svc, calls } = make();
  const { workflow } = await svc.save({ name: 'Share me', when: [{ type: 'webhook' }], steps: [{ type: 'tell', text: 'x' }] });
  assert.equal(svc.exportText(workflow.id).ok, true);
  const text = calls.copy[0];
  assert.equal(text.includes(workflow.id), false);
  assert.equal(text.includes(workflow.when[0].token), false);
  const back = svc.importText(text);
  assert.equal(back.ok, true);
  assert.equal(back.workflow.id, undefined);
  assert.deepEqual(back.workflow.when, [{ type: 'webhook' }]);
  assert.equal(svc.importText('{bad').ok, false);
  assert.equal(svc.importText('[]').ok, false);
});

test('secrets are stored encrypted, listed by name, and usable in commands', async () => {
  const { svc, calls, dir } = make();
  assert.equal(svc.setSecret('bad name', 'x').ok, false);
  assert.equal(svc.setSecret('API_KEY', 'sk-12345').ok, true);
  assert.deepEqual(svc.view().secrets, ['API_KEY']);
  assert.equal(fs.readFileSync(path.join(dir, 'secrets.bin'), 'utf8').startsWith('enc:'), true);
  const { workflow } = await svc.save({ name: 'Uses it', steps: [{ type: 'run', command: 'curl -H {{ secrets.API_KEY }}' }] });
  const r = svc.runManual(workflow.id);
  await until(() => svc.getRun(r.runId)?.status === 'ok');
  assert.equal(calls.commands[0].command, 'curl -H sk-12345');
  assert.equal(calls.commands[0].raw.includes('sk-12345'), false);
  assert.equal(JSON.stringify(svc.getRun(r.runId)).includes('sk-12345'), false);
});

test('describe it: a draft that fails validation gets one fixing pass', async () => {
  const answers = [
    { name: 'Draft', steps: [{ type: 'tell', text: '{{ nope.x }}' }] },
    { name: 'Draft', steps: [{ type: 'tell', text: 'fixed' }], when: [{ type: 'schedule', schedule: { type: 'daily', time: '09:00' } }] },
  ];
  const prompts = [];
  const runClaude = async (_args, _t, { input }) => {
    prompts.push(input);
    return { stdout: JSON.stringify({ structured_output: { workflow_json: JSON.stringify(answers.shift()), note: 'Says hi daily.' } }) };
  };
  const { svc } = make({ runClaude });
  const r = await svc.draft('every morning say fixed');
  assert.equal(r.ok, true);
  assert.equal(r.workflow.steps[0].text, 'fixed');
  assert.equal(r.workflow.id, undefined);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /nope/);
  assert.match(prompts[0], /«every morning say fixed»/);
});

test('fix with Claude keeps the id and the hook token', async () => {
  let prompt = '';
  const runClaude = async (_a, _t, { input }) => {
    prompt = input;
    return { stdout: JSON.stringify({ structured_output: { workflow_json: JSON.stringify({ id: 'other', name: 'Broken', when: [{ type: 'webhook' }], steps: [{ type: 'run', command: 'echo fixed' }] }), note: 'The command was wrong.' } }) };
  };
  const { svc } = make({ runClaude, command: c => ({ output: 'nope', code: c === 'bad' ? 1 : 0 }) });
  const { workflow } = await svc.save({ name: 'Broken', when: [{ type: 'webhook' }], steps: [{ type: 'run', command: 'bad' }] });
  const r = svc.runManual(workflow.id);
  await until(() => svc.getRun(r.runId)?.status === 'error');
  const fixed = await svc.repair(r.runId);
  assert.equal(fixed.ok, true);
  assert.equal(fixed.workflow.id, workflow.id);
  assert.equal(fixed.workflow.when[0].token, workflow.when[0].token);
  assert.equal(fixed.note, 'The command was wrong.');
  assert.equal(prompt.includes(workflow.when[0].token), false);
  assert.match(prompt, /exit code 1/);
});

test('deleting a workflow stops its runs and removes its history', async () => {
  const { svc } = make();
  const { workflow } = await svc.save({ name: 'Gate', steps: [{ type: 'ask', question: 'Go?' }] });
  const r = svc.runManual(workflow.id);
  await until(() => svc.getRun(r.runId)?.status === 'waiting');
  await svc.remove(workflow.id);
  await until(() => svc.active.size === 0);
  assert.equal(svc.view().workflows.length, 0);
  assert.equal(svc.listRuns(workflow.id).length, 0);
});

test('a finished workflow can start the next one', async () => {
  const { svc, calls } = make();
  await svc.save({ name: 'First', steps: [{ type: 'set', values: { n: '42' } }] });
  await svc.save({ name: 'Second', when: [{ type: 'workflow', name: 'First', status: 'ok' }], steps: [{ type: 'tell', to: 'crab', text: 'got {{ trigger.vars.n }}' }] });
  svc.runManual(svc.byName('First').id);
  await until(() => calls.say.length === 1);
  assert.deepEqual(calls.say, ['got 42']);
});
