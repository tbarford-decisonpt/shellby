// Config to-dos of a project with a clone here move into its .shellby/tasks.md
// (src/main/projects/todo-move.js): once, none lost, none doubled.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { moveTodos } = require('../src/main/projects/todo-move');

const LOCAL = 'local:c:\\code\\thing';
const GH = 'github:me/site';
const FAR = 'github:me/elsewhere'; // no clone here: stays in config
const item = (id, text, from = 'you') => ({ id: `t-${id.padStart(8, '0')}`, text, from, at: 1 });

// A tasks.md per root, with the file's own rule: the same text is the same to-do.
function fakeFiles({ failOn = null } = {}) {
  const files = new Map();
  return {
    files,
    add(root, text, from) {
      if (text === failOn) return { ok: false, error: 'mixed line endings' };
      const list = files.get(root) || [];
      if (list.some(t => t.text.toLowerCase() === text.toLowerCase())) return { ok: true, existed: true };
      files.set(root, [...list, { text, from }]);
      return { ok: true, existed: false };
    },
  };
}

const roots = new Map([[LOCAL, 'c:\\code\\thing'], [GH, 'c:\\code\\site']]);

test('moves every to-do of a cloned project into its file, in order, with who added it', () => {
  const rt = fakeFiles();
  const todo = { [LOCAL]: [item('1', 'one'), item('2', 'two', 'claude')], [GH]: [item('3', 'three')], [FAR]: [item('4', 'four')] };

  const r = moveTodos(todo, roots, rt);

  assert.equal(r.changed, true);
  assert.equal(r.moved, 3);
  assert.deepEqual(r.todo, { [FAR]: [item('4', 'four')] });
  assert.deepEqual(rt.files.get('c:\\code\\thing'), [{ text: 'one', from: 'you' }, { text: 'two', from: 'claude' }]);
  assert.deepEqual(rt.files.get('c:\\code\\site'), [{ text: 'three', from: 'you' }]);
  assert.ok(todo[LOCAL], 'the input is left as it was');
});

test('running it again changes nothing and doubles nothing', () => {
  const rt = fakeFiles();
  const first = moveTodos({ [LOCAL]: [item('1', 'one')] }, roots, rt);
  const again = moveTodos(first.todo, roots, rt);

  assert.equal(again.changed, false);
  assert.equal(again.todo, first.todo);
  assert.equal(rt.files.get('c:\\code\\thing').length, 1);
});

test('a to-do already in the file is not added twice', () => {
  const rt = fakeFiles();
  rt.add('c:\\code\\thing', 'One', 'you');

  const r = moveTodos({ [LOCAL]: [item('1', 'one')] }, roots, rt);

  assert.deepEqual(r.todo, {});
  assert.equal(rt.files.get('c:\\code\\thing').length, 1);
});

test('one the file refuses stays in config for next time', () => {
  const rt = fakeFiles({ failOn: 'two' });

  const r = moveTodos({ [LOCAL]: [item('1', 'one'), item('2', 'two')] }, roots, rt);

  assert.equal(r.moved, 1);
  assert.deepEqual(r.todo, { [LOCAL]: [item('2', 'two')] });
});

test('a throwing writer or no writer loses nothing', () => {
  const todo = { [LOCAL]: [item('1', 'one')] };
  const thrower = { add() { throw new Error('disk'); } };

  assert.equal(moveTodos(todo, roots, thrower).todo, todo);
  assert.equal(moveTodos(todo, roots, null).todo, todo);
  assert.equal(moveTodos(todo, new Map(), fakeFiles()).changed, false);
});
