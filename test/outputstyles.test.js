const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { list, clean, frontmatter } = require('../src/main/outputstyles');
const { addPrompt } = require('../src/main/parity');

test('list: Claude Code\'s own styles, then the project\'s and yours', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-styles-'));
  try {
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(path.join(home, '.claude', 'output-styles'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.claude', 'output-styles'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'output-styles', 'pirate.md'), '---\nname: Pirate\ndescription: Arr\n---\nTalk like a pirate.');
    fs.writeFileSync(path.join(cwd, '.claude', 'output-styles', 'terse.md'), 'No frontmatter.');
    fs.writeFileSync(path.join(cwd, '.claude', 'output-styles', 'learning.md'), '---\nname: Learning\n---\nA copy of a built-in name.');
    const styles = list({ home, cwd });
    assert.deepEqual(styles.map(s => `${s.name}:${s.source}`), [':built-in', 'Explanatory:built-in', 'Learning:built-in', 'terse:project', 'Pirate:user']);
    assert.equal(styles.find(s => s.name === 'Pirate').description, 'Arr');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('clean: plain short names only; Default means none', () => {
  assert.equal(clean('Explanatory'), 'Explanatory');
  assert.equal(clean(' Learning '), 'Learning');
  assert.equal(clean('default'), '');
  assert.equal(clean('{"x":1}'), '');
  assert.equal(clean(42), '');
});

test('frontmatter: name and description, quotes trimmed', () => {
  assert.deepEqual(frontmatter('---\r\nname: "Teacher"\r\ndescription: Explains\r\n---\r\nbody'), { name: 'Teacher', description: 'Explains' });
  assert.deepEqual(frontmatter('no frontmatter'), {});
});

test('addPrompt: anything that looks like it carries a key stays out', () => {
  assert.deepEqual(addPrompt([], 'use the key sk-ant-api03-abcdefghijklmnopqrstuv'), []);
  assert.deepEqual(addPrompt([], 'token: ghp_abcdefghijklmnopqrstuvwxyz0123'), []);
  assert.deepEqual(addPrompt([], 'set password=hunter2hunter2'), []);
  assert.deepEqual(addPrompt([], 'explain how tokens are counted'), ['explain how tokens are counted']);
});

test('addPrompt: newest last, no repeats, /compact left out, capped', () => {
  assert.deepEqual(addPrompt(['a', 'b'], 'a'), ['b', 'a']);
  assert.deepEqual(addPrompt(['a'], '  '), ['a']);
  assert.deepEqual(addPrompt(['a'], '/compact'), ['a']);
  assert.deepEqual(addPrompt(null, 'x'), ['x']);
  const many = Array.from({ length: 250 }, (_, i) => `p${i}`);
  const next = addPrompt(many, 'new');
  assert.equal(next.length, 100);
  assert.equal(next.at(-1), 'new');
});
