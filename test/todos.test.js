const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/renderer/shared/todos');
const { toItems } = require('../src/main/stream');

// Feed items as stream.js makes them from Claude Code 2.1.293's events.
const tool = (id, name, input, extra = {}) => toItems({ type: 'assistant', parent_tool_use_id: extra.parent || null, message: { content: [{ type: 'tool_use', id, name, input }] } })[0];
const res = (id, content, data, isError = false) => toItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, tool_use_result: data })[0];

function created(list, id, subject, n, activeForm) {
  assert.equal(T.apply(list, tool(id, 'TaskCreate', { subject, description: subject, activeForm })), false, 'nothing to show until its id comes back');
  return T.apply(list, res(id, `Task #${n} created successfully: ${subject}`, { task: { id: String(n), subject } }));
}

test('TaskCreate adds a to-do once its result names it, and TaskUpdate moves it on', () => {
  const list = T.create();
  assert.equal(created(list, 'a', 'Read the config', 1, 'Reading the config'), true);
  assert.equal(created(list, 'b', 'Fix the parser', 2), true);
  let s = T.summary(list);
  assert.deepEqual([s.total, s.done, s.current], [2, 0, null]);

  assert.equal(T.apply(list, tool('c', 'TaskUpdate', { taskId: '1', status: 'in_progress' })), true);
  s = T.summary(list);
  assert.equal(s.current, 'Reading the config', 'what it is doing now, worded as it is done');

  T.apply(list, tool('d', 'TaskUpdate', { taskId: '1', status: 'completed' }));
  T.apply(list, tool('e', 'TaskUpdate', { taskId: '2', status: 'in_progress' }));
  s = T.summary(list);
  assert.deepEqual([s.done, s.current], [1, 'Fix the parser'], 'no activeForm: its subject');
  assert.equal(T.allDone(s), false);

  T.apply(list, tool('f', 'TaskUpdate', { taskId: '2', status: 'completed' }));
  assert.equal(T.allDone(T.summary(list)), true);
});

test('an update that changes nothing, or names a to-do it never made, is no change', () => {
  const list = T.create();
  created(list, 'a', 'One', 1);
  assert.equal(T.apply(list, tool('b', 'TaskUpdate', { taskId: '1', status: 'pending' })), false);
  assert.equal(T.apply(list, tool('c', 'TaskUpdate', { taskId: '9', status: 'completed' })), false);
  assert.equal(T.apply(list, tool('d', 'TaskUpdate', { taskId: '1', subject: 'One, renamed' })), true);
  assert.equal(T.summary(list).items[0].subject, 'One, renamed');
});

test('deleted drops a to-do; a failed TaskCreate adds nothing', () => {
  const list = T.create();
  created(list, 'a', 'Keep', 1);
  created(list, 'b', 'Drop', 2);
  assert.equal(T.apply(list, tool('c', 'TaskUpdate', { taskId: '2', status: 'deleted' })), true);
  assert.deepEqual(T.summary(list).items.map(t => t.subject), ['Keep']);
  T.apply(list, tool('x', 'TaskCreate', { subject: 'Never' }));
  assert.equal(T.apply(list, res('x', 'Error: no', undefined, true)), false);
  assert.equal(T.summary(list).total, 1);
});

test("an id is read from the result's words when its data isn't there (an older transcript)", () => {
  const list = T.create();
  T.apply(list, tool('a', 'TaskCreate', { subject: 'Old' }));
  assert.equal(T.apply(list, res('a', 'Task #7 created successfully: Old')), true);
  assert.equal(T.summary(list).items[0].id, '7');
});

test('TodoWrite replaces the whole list; a helper writing its own list leaves the conversation’s be', () => {
  const list = T.create();
  const todos = [{ content: 'A', status: 'completed', activeForm: 'Doing A' }, { content: 'B', status: 'in_progress', activeForm: 'Doing B' }, { content: 'C', status: 'weird' }];
  assert.equal(T.apply(list, tool('w', 'TodoWrite', { todos })), true);
  const s = T.summary(list);
  assert.deepEqual([s.total, s.done, s.current], [3, 1, 'Doing B']);
  assert.equal(s.items[2].status, 'pending', 'an unknown status reads as to do');
  assert.equal(T.apply(list, tool('w2', 'TodoWrite', { todos: [] }, { parent: 'agent-1' })), false);
  assert.equal(T.summary(list).total, 3);
});

test('a conversation replayed from its items has the same list, and other items are ignored', () => {
  const items = [
    { kind: 'text', text: 'hi' },
    tool('a', 'TaskCreate', { subject: 'One' }), res('a', 'Task #1 created successfully: One', { task: { id: '1' } }),
    tool('b', 'Bash', { command: 'ls' }), res('b', 'ok'),
    tool('c', 'TaskUpdate', { taskId: '1', status: 'completed' }),
  ];
  const s = T.summary(T.fromItems(items));
  assert.deepEqual([s.total, s.done], [1, 1]);
  assert.equal(T.apply(null, items[1]), false);
  assert.equal(T.apply(T.create(), null), false);
});

test('summary hands out copies, so the list can be passed on safely', () => {
  const list = T.create();
  created(list, 'a', 'One', 1);
  T.summary(list).items[0].status = 'completed';
  assert.equal(T.summary(list).done, 0);
});
