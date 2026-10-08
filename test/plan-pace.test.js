const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const pace = require('../src/main/plan-pace');
const L = require('../src/renderer/panel/tab-logic');
const { ClaudeSession } = require('../src/main/session');

const MIN = 60 * 1000;
const NOW = 1_790_000_000_000;

const todo = (...statuses) => ({ type: 'tool_use', name: 'TodoWrite', input: { todos: statuses.map((status, i) => ({ content: `step ${i + 1}`, status })) } });
const create = subject => ({ type: 'tool_use', name: 'TaskCreate', input: { subject } });
const update = (taskId, status) => ({ type: 'tool_use', name: 'TaskUpdate', input: { taskId, status } });

test('TodoWrite replaces the list; anything else leaves the plan as it was', () => {
  const a = pace.read(null, [todo('completed', 'in_progress', 'pending')]);
  assert.deepEqual(pace.counts(a), { done: 1, total: 3 });
  assert.equal(pace.read(a, [{ type: 'tool_use', name: 'Read', input: {} }, { type: 'text', text: 'hi' }]), a);
  assert.equal(pace.read(null, [{ type: 'tool_use', name: 'Bash', input: {} }]), null);
  assert.deepEqual(pace.counts(pace.read(a, [todo('completed', 'completed')])), { done: 2, total: 2 });
});

test('tasks are numbered in creation order and win over to-dos; deleted ones drop out', () => {
  let p = pace.read(null, [todo('pending')]);
  p = pace.read(p, [create('one'), create('two'), create('three')]);
  assert.deepEqual(pace.counts(p), { done: 0, total: 3 });
  p = pace.read(p, [update('1', 'completed'), update(3, 'deleted')]);
  assert.deepEqual(pace.counts(p), { done: 1, total: 2 });
  // An id it never saw created (a conversation picked up from History) changes nothing.
  assert.equal(pace.read(p, [update('9', 'completed')]), p);
});

test('the pace is the time per step finished this turn, carried over what is left', () => {
  let t = pace.track(null, { done: 0, total: 5 }, NOW);
  assert.deepEqual(pace.outlook(t), { step: 1, total: 5, endsAt: null }); // nothing finished yet: no guess
  t = pace.track(t, { done: 1, total: 5 }, NOW + 2 * MIN);
  t = pace.track(t, { done: 2, total: 5 }, NOW + 4 * MIN);
  // Two minutes a step, three steps left.
  assert.deepEqual(pace.outlook(t), { step: 3, total: 5, endsAt: NOW + 10 * MIN });
  // A step added keeps the pace and moves the end out.
  t = pace.track(t, { done: 2, total: 6 }, NOW + 5 * MIN);
  assert.equal(pace.outlook(t).endsAt, NOW + 12 * MIN);
  // All done: nothing to show.
  assert.equal(pace.outlook(pace.track(t, { done: 6, total: 6 }, NOW + 9 * MIN)), null);
});

test('a plan picked up half done only counts what this turn finished, and fast ticks are no pace', () => {
  let t = pace.track(null, { done: 3, total: 6 }, NOW);
  t = pace.track(t, { done: 4, total: 6 }, NOW + 4 * MIN);
  assert.equal(pace.outlook(t).endsAt, NOW + 12 * MIN);
  // Several boxes ticked within seconds of the plan appearing: too quick to mean anything.
  const quick = pace.track(pace.track(null, { done: 0, total: 4 }, NOW), { done: 2, total: 4 }, NOW + pace.MIN_SPAN_MS - 1);
  assert.equal(quick.done, 2);
  assert.equal(pace.outlook(quick).endsAt, null);
});

test("the busy line says the step, and the time left only while it's ahead", () => {
  assert.equal(L.planLine(null, NOW), '');
  assert.equal(L.planLine({ step: 2, total: 4, endsAt: null }, NOW), 'step 2 of 4');
  assert.equal(L.planLine({ step: 2, total: 4, endsAt: NOW + 30 * 1000 }, NOW), 'step 2 of 4 · under a minute left');
  assert.equal(L.planLine({ step: 2, total: 4, endsAt: NOW + 4.4 * MIN }, NOW), 'step 2 of 4 · about 4 min left');
  assert.equal(L.planLine({ step: 2, total: 4, endsAt: NOW + 150 * MIN }, NOW), 'step 2 of 4 · about 3 h left');
  assert.equal(L.planLine({ step: 4, total: 4, endsAt: NOW - MIN }, NOW), 'step 4 of 4'); // running over
});

test('a session follows the plan on the main thread only, and only while a turn runs', () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask' });
  let told = 0;
  s.on('plan', () => told++);
  const say = (...content) => s.trackSteps({ type: 'assistant', message: { content } });
  say(todo('pending', 'pending')); // between turns: remembered, not shown
  assert.equal(told, 0);
  s.turn = { usages: new Map(), weight: 0, tokens: 0, before: null };
  say(todo('completed', 'in_progress'));
  assert.equal(told, 1);
  assert.deepEqual(pace.outlook(s.turn.plan), { step: 2, total: 2, endsAt: null });
  say({ type: 'tool_use', id: 'r1', name: 'Read', input: {} }); // not the plan: no news
  assert.equal(told, 1);
});
