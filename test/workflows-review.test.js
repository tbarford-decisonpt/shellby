// Regression tests for what the 0.48.0 code and security reviews found.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Engine } = require('../src/main/workflows/engine');
const { validateWorkflow, riskDetail } = require('../src/main/workflows/schema');
const { WorkflowService } = require('../src/main/workflows/service');
const effects = require('../src/main/workflows/effects');
const { patternTest } = require('../src/main/workflows/triggers');
const expr = require('../src/main/workflows/expr');

const wf = (steps, extra = {}) => {
  const r = validateWorkflow({ name: 'T', steps, ...extra }, { allowAutonomous: true });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.workflow;
};
const rec = () => ({ id: 'run-1', startedAt: Date.now(), trigger: { type: 'manual', data: {} }, inputs: {} });
const fakeFx = over => ({
  claude: async () => ({ ok: true, reply: 'ok', tabId: 't' }), run: async () => ({ output: '', code: 0 }),
  http: async () => ({ status: 200, body: '' }), ask: async a => a.choices[0], tell: async () => {},
  readFile: async () => 'x', writeFile: async () => {}, runWorkflow: async () => ({ status: 'ok' }), sleep: async () => {},
  ...over,
});
// What the service does on Retry: keep finished work, drop the rest.
const forRetry = r => {
  for (const [k, s] of Object.entries(r.steps)) {
    if (s.type === 'if' && s.output?.branch) { s.status = 'ok'; continue; }
    if (s.status !== 'ok' && s.status !== 'skipped' && !(s.status === 'error' && s.tolerated)) delete r.steps[k];
  }
  r.order = r.order.filter(k => r.steps[k]);
  return r;
};

test('a retry takes the branch the If took first, and doesn\'t redo a tolerated failure', async () => {
  const w = wf([
    { id: 'x', type: 'http', url: 'https://a.com', continueOnError: true },
    { id: 'pick', type: 'if', test: 'x.ok', then: [{ id: 'yes', type: 'run', command: 'then' }], else: [{ id: 'no', type: 'run', command: 'else' }, { id: 'e2', type: 'run', command: 'fails' }] },
  ]);
  let httpCalls = 0;
  const ran = [];
  const first = await new Engine({ workflow: w, record: rec(), effects: fakeFx({ http: async () => { httpCalls++; throw new Error('down'); }, run: async a => { ran.push(a.command); return { output: '', code: a.command === 'fails' ? 1 : 0 }; } }) }).run();
  assert.equal(first.status, 'error');
  assert.deepEqual(ran, ['else', 'fails']);
  // Now the site is up: the retry must not call it again, nor switch branch.
  const again = await new Engine({ workflow: w, record: forRetry(first), effects: fakeFx({ http: async () => { httpCalls++; return { status: 200, body: '' }; }, run: async a => { ran.push(a.command); return { output: '', code: 0 }; } }) }).run();
  assert.equal(again.status, 'ok');
  assert.equal(httpCalls, 1);
  assert.deepEqual(ran, ['else', 'fails', 'fails']);
});

test('replay keys are step ids: a step added before a failure doesn\'t take another\'s result', async () => {
  const w1 = wf([{ id: 'a', type: 'run', command: 'a' }, { id: 'b', type: 'run', command: 'b' }]);
  const first = await new Engine({ workflow: w1, record: rec(), effects: fakeFx({ run: async a => ({ output: a.command, code: a.command === 'b' ? 1 : 0 }) }) }).run();
  const w2 = wf([{ id: 'new', type: 'run', command: 'new' }, { id: 'a', type: 'run', command: 'a' }, { id: 'b', type: 'run', command: 'b' }]);
  const ran = [];
  await new Engine({ workflow: w2, record: forRetry(first), effects: fakeFx({ run: async a => { ran.push(a.command); return { output: '', code: 0 }; } }) }).run();
  assert.deepEqual(ran, ['new', 'b']);
});

test('a long read is kept whole for later steps, and secrets are blanked for them too', async () => {
  const big = 'x'.repeat(60000);
  const w = wf([{ id: 'r', type: 'file', action: 'read', path: 'C:\\in.txt' }, { id: 'k', type: 'http', url: 'https://a.com' }, { type: 'claude', prompt: '{{ r.text | length }} {{ k.body }}', mode: 'plan' }]);
  let prompt = '';
  const r = await new Engine({ workflow: w, record: rec(), secrets: { KEY: 'sk-secret-123' }, effects: fakeFx({ readFile: async () => big, http: async () => ({ status: 200, body: 'echo sk-secret-123' }), claude: async a => { prompt = a.prompt; return { ok: true, reply: '', tabId: 't' }; } }) }).run();
  assert.equal(r.steps.r.output.text.length, 60000);
  assert.match(prompt, /«60000»/);
  assert.equal(prompt.includes('sk-secret-123'), false);
  assert.match(prompt, /echo ••••/);
});

test('a command cut off by Stop is not recorded as done', async () => {
  const w = wf([{ id: 'c', type: 'run', command: 'long', allowFail: true }]);
  const eng = new Engine({ workflow: w, record: rec(), effects: fakeFx({ run: async () => { eng.stop(); return { output: '', code: null }; } }) });
  const r = await eng.run();
  assert.equal(r.status, 'stopped');
  assert.equal(r.steps.c.status, 'stopped');
});

test('one step budget for a run and the workflows it calls', async () => {
  const budget = { executions: 999 };
  const r = await new Engine({ workflow: wf([{ type: 'tell', text: 'a' }, { type: 'tell', text: 'b' }]), record: rec(), effects: fakeFx(), budget }).run();
  assert.equal(r.status, 'error');
  assert.match(r.error, /past 1000 steps/);
});

test('a loop variable doesn\'t hide a step of the same name after the loop', () => {
  const r = validateWorkflow({ name: 'T', steps: [{ id: 'file', type: 'tell', text: 'x' }, { type: 'each', over: '{{ trigger.f }}', as: 'file', steps: [{ type: 'tell', text: 'y' }] }] });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /already a step's name/);
});

test('the schema refuses time limits and retries on If and For each, and checks every templated field', () => {
  assert.equal(validateWorkflow({ name: 'T', steps: [{ type: 'if', test: 'true', timeoutMin: 1, then: [{ type: 'tell', text: 'x' }] }] }).ok, false);
  assert.equal(validateWorkflow({ name: 'T', steps: [{ type: 'tell', title: '{{ nope.x }}', text: 'x' }] }).ok, false);
  assert.equal(validateWorkflow({ name: 'T', steps: [{ type: 'stop', message: '{{ broken' }] }).ok, false);
  assert.equal(validateWorkflow({ name: 'T', steps: [{ type: 'run', command: 'x', cwd: '{{ ghost.dir }}' }] }).ok, false);
  // A long body without values is fine.
  assert.equal(validateWorkflow({ name: 'T', steps: [{ type: 'http', method: 'POST', url: 'https://a.com', body: 'y'.repeat(50000) }] }).ok, true);
  assert.equal(expr.render('{{ trigger.l | join " | " }}', { trigger: { l: ['a', 'b'] } }), 'a | b');
  // Invisible characters are gone from what the confirm window shows.
  const w = validateWorkflow({ name: 'T', steps: [{ type: 'run', command: 'echo safe\u200b\u2028 && evil' }] }).workflow;
  assert.equal(w.steps[0].command, 'echo safe && evil');
});

test('the confirm window names a called workflow, and header values', () => {
  const w = wf([{ type: 'workflow', name: 'Deploy', inputs: { env: 'prod' } }, { type: 'http', url: 'https://a.com', headers: { 'X-Data': '{{ trigger.x }}' } }]);
  const d = riskDetail(w);
  assert.match(d, /runs the workflow “Deploy”, and everything it does/);
  assert.match(d, /"env":"prod"/);
  assert.match(d, /X-Data: \{\{ trigger\.x \}\}/);
});

test('effects: no writes to places that run code later; no calls to Shellby\'s own port', async () => {
  const home = 'C:\\Users\\me';
  for (const bad of ['C:\\Users\\me\\.claude\\settings.json', 'C:\\code\\app\\.git\\hooks\\pre-commit', 'C:\\Users\\me\\Documents\\WindowsPowerShell\\profile.ps1', 'C:\\data\\shellby\\settings.json']) {
    assert.equal(effects.forbiddenWrite(bad, { home, extra: ['C:\\data\\shellby'] }), true, bad);
  }
  assert.equal(effects.forbiddenWrite('C:\\Users\\me\\notes.md', { home }), false);
  const fetchImpl = async () => ({ status: 200, headers: { get: () => null }, text: async () => '' });
  await assert.rejects(effects.http({ method: 'POST', url: 'http://127.0.0.1:47913/v1/flow', fetchImpl, blockedPorts: [47913] }), /own local port/);
  await assert.rejects(effects.http({ method: 'POST', url: 'http://localhost:47913/v1/crab', fetchImpl, blockedPorts: [47913] }), /own local port/);
  for (const sneaky of ['http://2130706433:47913/', 'http://0x7f.1:47913/', 'http://127.1:47913/', 'http://[::ffff:127.0.0.1]:47913/', 'http://[::]:47913/', 'http://[0:0:0:0:0:0:0:1]:47913/']) {
    await assert.rejects(effects.http({ method: 'POST', url: sneaky, fetchImpl, blockedPorts: [47913] }), /own local port/, sneaky);
  }
  const redirect = async url => (url.includes('a.com') ? { status: 307, headers: { get: () => 'https://b.com/x' }, text: async () => '' } : { status: 200, headers: { get: () => null }, text: async () => '' });
  await assert.rejects(effects.http({ method: 'POST', url: 'https://a.com/', body: '{"key":1}', fetchImpl: redirect }), /body and all/);
});

test('a Claude turn ends when its tab is closed', async () => {
  const m = Object.assign(new EventEmitter(), { tabs: new Map([['t1', {}]]), send() {}, isBusy: () => true, interrupt() {} });
  const p = effects.claudeTurn(m, 't1', 'hi', {}, null);
  effects.tabClosed('t1');
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /closed/);
});

test('wildcards match in linear time', () => {
  const t = patternTest('*a*a*a*a*a*a*a*a*a*a*b');
  const start = Date.now();
  assert.equal(t('a'.repeat(250)), false);
  assert.ok(Date.now() - start < 50);
  assert.equal(patternTest('*.PDF')('x.pdf'), true);
});

// ---- the service
function svcWith(store = {}, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-wfr-'));
  const calls = { confirm: 0, say: [] };
  const deps = {
    config: { get: k => store[k], set: o => Object.assign(store, o) }, dataDir: dir, home: 'C:\\Users\\me',
    manager: Object.assign(new EventEmitter(), { tabs: new Map(), isBusy: () => false }), maxTabs: 8,
    openTab: () => { throw new Error('no tabs'); }, closeTab: () => {}, currentCwd: () => dir,
    claudeReady: () => true, allowAutonomous: () => false,
    confirm: async () => { calls.confirm++; return 0; }, notify: () => {}, tellPhone: () => {}, say: t => calls.say.push(t),
    showWorkflows: () => {}, toPanel: () => {}, runCommand: async () => ({ output: '', code: 0 }), runClaude: async () => ({ stdout: '' }),
    copy: () => {}, crypto: { available: () => true, encrypt: t => Buffer.from(t), decrypt: b => String(b) },
    webhookPort: () => 47913, log: { info: () => {}, warn: () => {} }, ...over,
  };
  return { svc: new WorkflowService(deps), deps, calls, dir, store };
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out'); };

test('a risky workflow written straight into settings is paused until saved again', async () => {
  const a = svcWith();
  a.svc.workflows = a.svc.loadWorkflows();
  await a.svc.save({ name: 'Mine', steps: [{ type: 'run', command: 'echo approved' }] });
  // Someone edits settings.json: the command changes, and a new workflow appears.
  const tampered = a.store.workflows.map(w => ({ ...w, steps: [{ ...w.steps[0], command: 'evil' }] }));
  tampered.push({ id: 'wf-x', name: 'Planted', enabled: true, when: [{ type: 'startup' }], steps: [{ id: 'run1', type: 'run', command: 'evil' }] });
  const b = svcWith({ ...a.store, workflows: tampered }, { dataDir: a.dir });
  b.svc.workflows = b.svc.loadWorkflows();
  assert.deepEqual(b.svc.workflows.map(w => [w.name, w.enabled, !!w.needsApproval]), [['Mine', false, true], ['Planted', false, true]]);
  // No encrypted storage, no way to check: a risky workflow stays paused (fails closed).
  const d = svcWith({ workflows: a.store.workflows }, { crypto: { available: () => false } });
  d.svc.workflows = d.svc.loadWorkflows();
  assert.equal(d.svc.workflows[0].enabled, false);
  // Autonomous written in by hand isn't loaded without the acknowledgement, and isn't lost either.
  const c = svcWith({ workflows: [{ id: 'wf-a', name: 'Auto', steps: [{ type: 'claude', prompt: 'x', mode: 'autonomous' }] }] });
  c.svc.workflows = c.svc.loadWorkflows();
  assert.equal(c.svc.workflows.length, 0);
  await c.svc.save({ name: 'Other', steps: [{ type: 'tell', text: 'x' }] });
  assert.ok(c.store.workflows.some(w => w.name === 'Auto'), 'the unreadable one is kept in settings');
});

test('a run never runs the copy of a workflow kept in its record', async () => {
  const { svc, dir } = svcWith();
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runs', 'run-forged.json'), JSON.stringify({ id: 'run-forged', workflowId: 'wf-gone', status: 'waiting', startedAt: Date.now(), steps: {}, order: [], definition: { id: 'wf-gone', name: 'Evil', steps: [{ id: 'run1', type: 'run', command: 'evil' }] } }));
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms > 1000 ? 1 : ms, ...a);
  try {
    svc.start();
    await until(() => svc.getRun('run-forged')?.status === 'interrupted');
    assert.equal(svc.active.size, 0);
  } finally { global.setTimeout = realSetTimeout; svc.shutdown(); }
});

test('a run Claude started can only call workflows Claude may start', async () => {
  const { svc } = svcWith();
  svc.workflows = svc.loadWorkflows();
  await svc.save({ name: 'Deploy', steps: [{ type: 'tell', to: 'crab', text: 'deployed' }] });
  await svc.save({ name: 'Wrapper', when: [{ type: 'claude' }], steps: [{ type: 'workflow', name: 'Deploy' }] });
  const r = svc.runFromClaude('Wrapper', {});
  assert.match(r.text, /Started/);
  await until(() => svc.listRuns(svc.byName('Wrapper').id)[0]?.status === 'error');
  assert.match(svc.listRuns(svc.byName('Wrapper').id)[0].error, /doesn't allow being started by Claude Code/);
  // Run by hand, the same wrapper may call it.
  svc.runManual(svc.byName('Wrapper').id);
  await until(() => svc.listRuns(svc.byName('Wrapper').id)[0]?.status === 'ok');
});

test('runs waiting on you don\'t hold a slot; a skipped trigger doesn\'t use the hourly allowance', async () => {
  const { svc } = svcWith();
  svc.workflows = svc.loadWorkflows();
  for (let i = 0; i < 4; i++) await svc.save({ name: `Gate ${i}`, steps: [{ type: 'ask', question: 'Go?' }] });
  for (const w of svc.workflows) svc.runManual(w.id);
  await until(() => [...svc.active.values()].every(r => r.record.status === 'waiting') && svc.active.size === 4);
  await svc.save({ name: 'Quick', when: [{ type: 'health' }], steps: [{ type: 'tell', to: 'crab', text: 'x' }] });
  assert.equal(svc.runManual(svc.byName('Quick').id).ok, true, 'a fifth run starts while four wait on you');
  for (const run of [...svc.active.values()]) run.engine.stop();
  await until(() => svc.active.size === 0);

  await svc.save({ name: 'Busy', when: [{ type: 'health' }], steps: [{ type: 'ask', question: 'Hold' }] });
  svc.rate.limit = 3;
  svc.event('health', {});
  await until(() => svc.isRunning(svc.byName('Busy').id));
  for (let i = 0; i < 10; i++) svc.event('health', {});
  assert.equal(svc.byName('Busy').enabled, true, 'skipped starts didn\'t pause it');
});

test('files that land during a run are handled once it has finished', async () => {
  const { svc } = svcWith();
  svc.workflows = svc.loadWorkflows();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-fold-'));
  const { workflow } = await svc.save({ name: 'Sorter', when: [{ type: 'folder', path: dir }], steps: [{ type: 'ask', question: 'Sort {{ trigger.files | length }}?' }] });
  svc.onFolder(workflow, [path.join(dir, 'a.txt')]);
  await until(() => svc.isRunning(workflow.id));
  const late = path.join(dir, 'b.txt');
  fs.writeFileSync(late, 'x');
  svc.onFolder(workflow, [late]);
  assert.equal(svc.folderBacklog.get(workflow.id)?.length, 1);
  const first = svc.listRuns(workflow.id)[0];
  const release = () => svc.answer(first.id, 'ask1', 'Continue');
  svc.endedAt.set(workflow.id, 0);
  await release();
  await until(() => !svc.isRunning(workflow.id));
  // Fast-forward the grace period.
  for (const t of svc.folderTimers.values()) { clearTimeout(t); }
  svc.folderTimers.clear();
  svc.endedAt.set(workflow.id, 0);
  svc.onFolder(svc.get(workflow.id), svc.folderBacklog.get(workflow.id) || []);
  await until(() => svc.listRuns(workflow.id).length === 2);
});
