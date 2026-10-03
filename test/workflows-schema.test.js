const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkflow, capabilities, riskSignature, describeTrigger, walkSteps } = require('../src/main/workflows/schema');

const base = (over = {}) => ({ name: 'Test', steps: [{ type: 'tell', text: 'hi' }], ...over });
const ok = (input, opts) => {
  const r = validateWorkflow(input, opts);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.workflow;
};
const errs = (input, opts) => {
  const r = validateWorkflow(input, opts);
  assert.equal(r.ok, false, 'expected errors');
  return r.errors;
};

test('a minimal workflow is normalised with defaults and ids', () => {
  const wf = ok({ name: '  My   flow ', steps: [{ type: 'claude', prompt: 'Hello' }, { type: 'claude', prompt: 'Again' }, { type: 'run', command: 'dir' }] });
  assert.equal(wf.name, 'My flow');
  assert.match(wf.id, /^wf-/);
  assert.equal(wf.enabled, true);
  assert.equal(wf.concurrency, 'skip');
  assert.deepEqual(wf.when, []);
  assert.deepEqual(wf.steps.map(s => s.id), ['claude1', 'claude2', 'run1']);
  assert.equal(wf.steps[0].mode, 'smart');
});

test('unknown fields are dropped and unknown types refused', () => {
  const wf = ok(base({ evil: 1, steps: [{ type: 'tell', text: 'x', __proto__: { polluted: true }, extra: 2 }] }));
  assert.equal(wf.evil, undefined);
  assert.equal(wf.steps[0].extra, undefined);
  assert.ok(errs(base({ steps: [{ type: 'eval', code: '1' }] })).some(e => e.path === 'steps[0]'));
  assert.ok(errs(base({ when: [{ type: 'cron' }] })).some(e => e.path === 'when[0]'));
  assert.ok(errs('nope').length);
  assert.ok(errs(base({ steps: [] })).some(e => e.path === 'steps'));
});

test('triggers are checked and described', () => {
  const wf = ok(base({ when: [
    { type: 'schedule', schedule: { type: 'weekly', time: '9:05', days: [5, 1] } },
    { type: 'schedule', schedule: { type: 'minutes', every: 15 } },
    { type: 'ci', on: 'failed', repo: 'x-salmon/shellby' },
    { type: 'webhook' },
    { type: 'folder', path: 'C:\\Users\\me\\Downloads', pattern: '*.pdf' },
  ] }));
  assert.deepEqual(wf.when[0].schedule, { type: 'weekly', time: '09:05', days: [1, 5] });
  assert.match(wf.when[3].token, /^[a-f0-9]{48}$/);
  assert.equal(describeTrigger(wf.when[1]), 'Every 15 minutes');
  assert.equal(describeTrigger(wf.when[2]), 'When a build fails on x-salmon/shellby');
  assert.match(describeTrigger(wf.when[4]), /Downloads \(\*\.pdf\)/);
  // A token, once made, is kept.
  assert.equal(ok(base({ when: [wf.when[3]] })).when[0].token, wf.when[3].token);
  assert.ok(errs(base({ when: [{ type: 'schedule', schedule: { type: 'minutes', every: 1 } }] })).length);
  assert.ok(errs(base({ when: [{ type: 'ci', repo: 'not a repo' }] })).length);
  assert.ok(errs(base({ when: [{ type: 'folder', path: 'relative/dir' }] })).length);
  assert.ok(errs(base({ when: [{ type: 'folder', path: '\\\\server\\share' }] })).length);
  assert.ok(errs(base({ when: [{ type: 'startup' }, { type: 'startup' }] })).length);
});

test('every step type validates its own fields', () => {
  const wf = ok(base({
    inputs: [{ name: 'target', label: 'Target' }],
    steps: [
      { id: 'look', type: 'claude', prompt: 'Look at {{ inputs.target }}', mode: 'plan', output: { files: 'list', fixable: { type: 'boolean', description: 'can it be fixed' } } },
      { type: 'run', command: 'npm test', cwd: 'C:\\code', allowFail: true, retry: { times: 2, delaySec: 5 }, timeoutMin: 5 },
      { type: 'http', method: 'post', url: 'https://example.com/hook', headers: { Authorization: 'Bearer {{ secrets.TOKEN }}' }, body: { a: 1 } },
      { type: 'ask', question: 'Go on?', choices: ['Ship', 'Wait'] },
      { type: 'set', values: { total: '{{ look.files | length }}', list: [1, 2] } },
      { type: 'if', test: 'look.fixable', then: [{ type: 'tell', to: 'phone', text: 'fixable' }], else: [{ type: 'stop', status: 'error', message: 'no' }] },
      { type: 'each', over: '{{ look.files }}', as: 'file', steps: [{ type: 'tell', text: '{{ file }} #{{ loop.number }}' }] },
      { type: 'wait', minutes: 2 },
      { type: 'file', action: 'append', path: 'C:\\log.txt', content: '{{ now }}' },
      { type: 'workflow', name: 'Other', inputs: { x: '{{ vars.total }}' } },
    ],
  }));
  const [claude, run, http, ask, set, ifs, each, wait, file] = wf.steps;
  assert.deepEqual(claude.output, { files: { type: 'list', description: '' }, fixable: { type: 'boolean', description: 'can it be fixed' } });
  assert.deepEqual(run.retry, { times: 2, delaySec: 5 });
  assert.equal(http.method, 'POST');
  assert.equal(http.body, '{"a":1}');
  assert.deepEqual(ask.choices, ['Ship', 'Wait']);
  assert.equal(set.values.list, '[1,2]');
  assert.equal(ifs.then.length, 1);
  assert.equal(ifs.else[0].type, 'stop');
  assert.equal(each.as, 'file');
  assert.equal(each.max, 25);
  assert.equal(wait.seconds, 120);
  assert.equal(file.action, 'append');
});

test('references must name a real step, input or loop value', () => {
  assert.ok(errs(base({ steps: [{ type: 'tell', text: '{{ typo.x }}' }] })).some(e => /typo/.test(e.message)));
  assert.ok(errs(base({ steps: [{ type: 'tell', text: '{{ inputs.nope }}' }] })).some(e => /no input/.test(e.message)));
  assert.ok(errs(base({ steps: [{ type: 'tell', text: '{{ steps.nope.x }}' }] })).some(e => /no step/.test(e.message)));
  // A loop value only exists inside its loop.
  assert.ok(errs(base({ steps: [{ type: 'each', over: '{{ trigger.files }}', steps: [{ type: 'tell', text: 'x' }] }, { type: 'tell', text: '{{ item }}' }] })).length);
  assert.ok(errs(base({ steps: [{ type: 'if', test: 'ghost == 1', then: [{ type: 'tell', text: 'x' }] }] })).length);
});

test('secrets only go into commands and requests', () => {
  ok(base({ steps: [{ type: 'run', command: 'gh auth login --with-token {{ secrets.GH }}' }] }));
  for (const step of [
    { type: 'claude', prompt: 'use {{ secrets.GH }}' },
    { type: 'tell', text: '{{ secrets.GH }}' },
    { type: 'file', action: 'write', path: 'C:\\x.txt', content: '{{ secrets.GH }}' },
    { type: 'if', test: 'secrets.GH == "x"', then: [{ type: 'tell', text: 'x' }] },
  ]) assert.ok(errs(base({ steps: [step] })).some(e => /Secrets/.test(e.message)), step.type);
  assert.ok(errs(base({ steps: [{ type: 'run', command: '{{ secrets.lower }}' }] })).some(e => /capitals/.test(e.message)));
});

test('Autonomous needs the acknowledgement', () => {
  const wf = base({ steps: [{ type: 'claude', prompt: 'x', mode: 'autonomous' }] });
  assert.ok(errs(wf).some(e => /Autonomous/.test(e.message)));
  ok(wf, { allowAutonomous: true });
});

test('limits: step count, nesting, duplicate ids, reserved names', () => {
  const many = Array.from({ length: 61 }, () => ({ type: 'tell', text: 'x' }));
  assert.ok(errs(base({ steps: many })).some(e => /at most 60/.test(e.message)));
  const nest = d => (d === 0 ? { type: 'tell', text: 'x' } : { type: 'if', test: 'true', then: [nest(d - 1)] });
  ok(base({ steps: [nest(3)] }));
  assert.ok(errs(base({ steps: [nest(5)] })).some(e => /nest/.test(e.message)));
  assert.ok(errs(base({ steps: [{ id: 'a', type: 'tell', text: 'x' }, { id: 'a', type: 'tell', text: 'y' }] })).some(e => /Two steps/.test(e.message)));
  assert.ok(errs(base({ steps: [{ id: 'trigger', type: 'tell', text: 'x' }] })).length);
  assert.ok(errs(base({ steps: [{ id: 'Bad-Id', type: 'tell', text: 'x' }] })).length);
});

test('capabilities and the risk signature describe what runs unasked', () => {
  const quiet = ok(base({ steps: [{ type: 'claude', prompt: 'look', mode: 'plan' }, { type: 'tell', text: 'x' }] }));
  assert.deepEqual(capabilities(quiet), []);
  assert.equal(riskSignature(quiet), '');
  const loud = ok(base({ cwd: 'C:\\code', steps: [
    { type: 'claude', prompt: 'fix', mode: 'acceptEdits' },
    { type: 'run', command: 'npm publish' },
    { type: 'http', url: 'https://api.example.com/x' },
    { type: 'file', action: 'write', path: 'C:\\out.txt', content: 'x' },
  ] }));
  const caps = capabilities(loud);
  assert.equal(caps.length, 4);
  assert.match(caps[0], /Auto-edit mode in C:\\code/);
  assert.match(caps[1], /npm publish/);
  assert.match(caps[2], /api\.example\.com/);
  const renamed = ok({ ...loud, name: 'Renamed', steps: loud.steps.map(s => ({ ...s, label: 'new label' })) });
  assert.equal(riskSignature(renamed), riskSignature(loud));
  const changed = ok({ ...loud, steps: loud.steps.map(s => (s.type === 'run' ? { ...s, command: 'npm publish --force' } : s)) });
  assert.notEqual(riskSignature(changed), riskSignature(loud));
});

test('walkSteps visits nested steps with their loop scope', () => {
  const wf = ok(base({ steps: [{ type: 'each', over: '{{ trigger.x }}', as: 'f', steps: [{ type: 'if', test: 'f', then: [{ type: 'tell', text: '{{ f }}' }] }] }] }));
  const seen = [];
  walkSteps(wf.steps, (s, at, scope) => seen.push([s.type, at, scope.join()]));
  assert.deepEqual(seen, [
    ['each', 'steps[0]', ''],
    ['if', 'steps[0].steps[0]', 'f'],
    ['tell', 'steps[0].steps[0].then[0]', 'f'],
  ]);
});
