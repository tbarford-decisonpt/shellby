// The workflow map's bookkeeping (src/renderer/panel/wf-graph.js): run entries
// finding their node, loop passes adding up, and drags that keep the nesting legal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/renderer/panel/wf-graph');

const MAX_DEPTH = 4;

function sample() {
  const fix = { id: 'fix', type: 'claude', prompt: 'fix it' };
  const tell = { id: 'tell', type: 'tell', text: 'hi' };
  const move = { id: 'move', type: 'file', action: 'write', path: 'x' };
  const check = { id: 'check', type: 'if', test: 'a', then: [fix], else: [tell] };
  const files = { id: 'files', type: 'each', over: '{{ trigger.files }}', steps: [move] };
  const look = { id: 'look', type: 'run', command: 'dir' };
  return { steps: [look, check, files], look, check, files, fix, tell, move };
}

test('loop passes share one key, everything else keeps its own', () => {
  assert.equal(G.keyTemplate('files.each3.move'), 'files.each*.move');
  assert.equal(G.keyTemplate('a.each0.b.each12.c'), 'a.each*.b.each*.c');
  assert.equal(G.keyTemplate('check.then.fix'), 'check.then.fix');
  assert.equal(G.keyTemplate('each1'), 'each1', 'a step called each1 is not a loop pass');
});

test('every step is filed under the key the engine records it as', () => {
  const s = sample();
  const keys = G.stepKeys(s.steps).map(x => x.key);
  assert.deepEqual(keys, ['look', 'check', 'check.then.fix', 'check.else.tell', 'files', 'files.each*.move']);
});

test('a step that ran on several passes shows the most telling status and how many', () => {
  const run = {
    order: ['files', 'files.each0.move', 'files.each1.move', 'files.each2.move'],
    steps: {
      files: { status: 'ok' },
      'files.each0.move': { status: 'ok' },
      'files.each1.move': { status: 'error' },
      'files.each2.move': { status: 'skipped' },
    },
  };
  const m = G.statusMap(run);
  assert.equal(m.get('files.each*.move').status, 'error');
  assert.equal(m.get('files.each*.move').passes, 3);
  assert.equal(m.get('files').passes, 1);
});

test('running beats a failure, and ok beats skipped', () => {
  assert.equal(G.aggregate([{ status: 'error' }, { status: 'running' }]).status, 'running');
  assert.equal(G.aggregate([{ status: 'skipped' }, { status: 'ok' }]).status, 'ok');
  assert.equal(G.aggregate([]), null);
});

test('an If remembers which ways it went', () => {
  const a = G.aggregate([{ status: 'ok', output: { branch: 'then' } }, { status: 'ok', output: { branch: 'then' } }]);
  assert.deepEqual(a.branches, ['then']);
  const b = G.aggregate([{ status: 'ok', output: { branch: 'then' } }, { status: 'ok', output: { branch: 'else' } }]);
  assert.deepEqual(b.branches.sort(), ['else', 'then']);
});

test('entries from an older version of the workflow are picked out', () => {
  const s = sample();
  const m = G.statusMap({ steps: { look: { status: 'ok' }, gone: { status: 'ok' }, 'files.each0.old': { status: 'ok' } } });
  assert.deepEqual(G.strays(s.steps, m).sort(), ['files.each*.old', 'gone']);
});

test('a run record with no steps is just empty', () => {
  assert.equal(G.statusMap(null).size, 0);
  assert.equal(G.statusMap({ steps: { a: null } }).size, 0);
});

test('steps can be found wherever they are nested', () => {
  const s = sample();
  assert.deepEqual(G.findPlace(s.steps, s.tell), { list: s.check.else, index: 0 });
  assert.equal(G.findPlace(s.steps, { id: 'stranger' }), null);
  assert.equal(G.listDepth(s.steps, s.steps), 1);
  assert.equal(G.listDepth(s.steps, s.check.then), 2);
  assert.equal(G.listDepth(s.steps, []), 0);
});

test('a container counts the levels inside it, even when it is empty', () => {
  const s = sample();
  assert.equal(G.nesting(s.look), 1);
  assert.equal(G.nesting(s.check), 2);
  assert.equal(G.nesting({ type: 'each', steps: [] }), 2);
  assert.equal(G.nesting({ type: 'if', then: [{ type: 'each', steps: [{ type: 'run' }] }], else: [] }), 3);
});

test('a step can\'t be dropped inside itself', () => {
  const s = sample();
  assert.equal(G.canDrop(s.steps, s.check, s.check.then, MAX_DEPTH), false);
  assert.equal(G.canDrop(s.steps, s.check, s.files.steps, MAX_DEPTH), true);
});

test('a drop that would nest too deep is refused', () => {
  const inner = { type: 'if', then: [], else: [] };
  const deep = { type: 'each', steps: [{ type: 'each', steps: [inner] }] };
  const steps = [deep, { id: 'box', type: 'if', then: [], else: [] }];
  // inner sits in a depth-3 list; a container needs one more level, so 4 is its limit.
  assert.equal(G.canDrop(steps, steps[1], inner.then, MAX_DEPTH), false);
  assert.equal(G.canDrop(steps, { type: 'run' }, inner.then, MAX_DEPTH), false, 'not in the workflow');
  const run = { type: 'run' };
  steps.push(run);
  assert.equal(G.canDrop(steps, run, inner.then, MAX_DEPTH), true);
});

test('moving down the same list lands where it was dropped', () => {
  const s = sample();
  assert.equal(G.moveTo(s.steps, s.look, s.steps, 3, MAX_DEPTH), true);
  assert.deepEqual(s.steps.map(x => x.id), ['check', 'files', 'look']);
});

test('moving up the same list, and into another list', () => {
  const s = sample();
  assert.equal(G.moveTo(s.steps, s.files, s.steps, 0, MAX_DEPTH), true);
  assert.deepEqual(s.steps.map(x => x.id), ['files', 'look', 'check']);
  assert.equal(G.moveTo(s.steps, s.look, s.check.then, 1, MAX_DEPTH), true);
  assert.deepEqual(s.steps.map(x => x.id), ['files', 'check']);
  assert.deepEqual(s.check.then.map(x => x.id), ['fix', 'look']);
});

test('dropping a step where it already is changes nothing', () => {
  const s = sample();
  assert.equal(G.moveTo(s.steps, s.check, s.steps, 1, MAX_DEPTH), false);
  assert.equal(G.moveTo(s.steps, s.check, s.steps, 2, MAX_DEPTH), false);
  assert.deepEqual(s.steps.map(x => x.id), ['look', 'check', 'files']);
});
