// A turn's changes as steps (src/main/change-story.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { story, turnItems, titleOf, relativeTo, FROM_COMMANDS, MAX_STEPS } = require('../src/main/change-story');

const root = path.resolve('/repo');
const at = p => path.join(root, p);
const say = text => ({ kind: 'text', text });
const write = (p, name = 'Edit', extra = {}) => ({ kind: 'tool', name, filePath: at(p), ...extra });
const run = (name = 'Bash') => ({ kind: 'tool', name, detail: 'npm test' });
const diff = (...paths) => paths.map(p => ({ path: p, status: 'M', added: 1, removed: 0 }));

test('story: writes split by a test run become two titled steps, in order', () => {
  const items = [
    say('First I will add the parser. It reads the header.'),
    write('src/parse.js', 'Write'), write('src/index.js'),
    run(),
    say('The tests fail on empty input, so I will guard it.'),
    write('src/parse.js'), write('test/parse.test.js', 'Write'),
  ];
  assert.deepEqual(story(items, root, diff('src/parse.js', 'src/index.js', 'test/parse.test.js')), [
    { title: 'First I will add the parser', files: ['src/parse.js', 'src/index.js'] },
    { title: 'The tests fail on empty input, so I will guard it', files: ['test/parse.test.js'] },
  ]);
});

test('story: files no edit wrote land in a last step of their own', () => {
  const items = [say('Bumping the dependency.'), write('package.json'), run()];
  const s = story(items, root, diff('package.json', 'package-lock.json'));
  assert.deepEqual(s.map(x => x.title), ['Bumping the dependency', FROM_COMMANDS]);
  assert.deepEqual(s[1].files, ['package-lock.json']);
});

test('story: one step is no story', () => {
  const items = [say('Fixing both.'), write('a.js'), write('b.js')];
  assert.equal(story(items, root, diff('a.js', 'b.js')), null);
  assert.equal(story(items, root, diff('a.js')), null);
  assert.equal(story([], root, []), null);
});

test('story: a step with nothing said before it gets a numbered title', () => {
  const items = [write('a.js'), run('Read'), write('b.js')];
  assert.deepEqual(story(items, root, diff('a.js', 'b.js')).map(x => x.title), ['Step 1', 'Step 2']);
});

test('story: writes outside the repo or not in the diff are ignored', () => {
  const items = [say('One.'), { kind: 'tool', name: 'Write', filePath: path.resolve('/elsewhere/x.js') }, write('a.js'), run(), say('Two.'), write('gone.js'), write('b.js')];
  assert.deepEqual(story(items, root, diff('a.js', 'b.js')), [{ title: 'One', files: ['a.js'] }, { title: 'Two', files: ['b.js'] }]);
});

test('story: a helper reading between writes does not split the step', () => {
  const items = [say('Both halves.'), write('a.js'), { kind: 'tool', name: 'Read', sub: true }, write('b.js'), run(), say('Then docs.'), write('README.md')];
  assert.deepEqual(story(items, root, diff('a.js', 'b.js', 'README.md')).map(s => s.files.length), [2, 1]);
});

test('story: past MAX_STEPS the rest fold into the last step', () => {
  const items = [];
  const files = [];
  for (let n = 0; n < MAX_STEPS + 3; n++) { items.push(say(`Step ${n}.`), write(`f${n}.js`), run()); files.push(`f${n}.js`); }
  const s = story(items, root, diff(...files));
  assert.equal(s.length, MAX_STEPS);
  assert.equal(s.flatMap(x => x.files).length, files.length);
});

test('turnItems: only the items between that message and the next', () => {
  const list = [{ kind: 'user', turnId: 'a' }, say('x'), { kind: 'user', turnId: 'b' }, say('y'), say('z')];
  assert.deepEqual(turnItems(list, 'a'), [say('x')]);
  assert.deepEqual(turnItems(list, 'b'), [say('y'), say('z')]);
  assert.deepEqual(turnItems(list, 'c'), []);
  assert.deepEqual(turnItems(null, 'a'), []);
});

test('titleOf: first sentence, markdown stripped, clipped', () => {
  assert.equal(titleOf('**Now** the `parser`. Then more.'), 'Now the parser');
  assert.equal(titleOf(''), '');
  assert.ok(titleOf('x'.repeat(200)).length <= 90);
});

test('relativeTo: forward slashes inside the root, null outside', () => {
  assert.equal(relativeTo(root, at('src/a.js')), 'src/a.js');
  assert.equal(relativeTo(root, path.resolve('/other/a.js')), null);
  assert.equal(relativeTo(root, null), null);
});
