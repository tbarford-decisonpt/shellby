const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const { questionsOf, describeTool, toItems } = require('../src/main/stream');
const { ClaudeSession } = require('../src/main/session');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const INPUT = { questions: [{ question: 'Which color do you like?', header: 'Color Choice', options: [{ label: 'Red', description: 'The color red' }, { label: 'Blue', description: 'The color blue' }], multiSelect: false }] };

test('AskUserQuestion reads as a question, not JSON', () => {
  assert.deepEqual(describeTool('AskUserQuestion', INPUT), { label: 'Asked you', detail: 'Which color do you like?' });
  const [item] = toItems({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: INPUT } });
  assert.equal(item.kind, 'permission');
  assert.deepEqual(item.questions, [{ question: 'Which color do you like?', header: 'Color Choice', multiSelect: false, options: [{ label: 'Red', description: 'The color red' }, { label: 'Blue', description: 'The color blue' }] }]);
  assert.equal(item.detail.includes('{'), false);
});

test('questionsOf tolerates junk and bounds sizes', () => {
  assert.deepEqual(questionsOf(null), []);
  assert.deepEqual(questionsOf({ questions: [null, { question: '' }, { question: 'ok?', options: [{ label: '' }, 'x', { label: 'Yes' }] }] }),
    [{ question: 'ok?', header: '', multiSelect: false, options: [{ label: 'Yes', description: '' }] }]);
  const big = questionsOf({ questions: [{ question: 'q'.repeat(2000), options: Array.from({ length: 20 }, (_, i) => ({ label: `o${i}` })) }] });
  assert.equal(big[0].question.length, 500);
  assert.equal(big[0].options.length, 8);
});

// ------------------------------------------------------------------ the session answers in the format the CLI expects

const sessions = [];
after(() => sessions.forEach(s => s.kill()));

function ask(content, answer) {
  const s = new ClaudeSession({ exe: process.execPath, argsPrefix: [FAKE], cwd: os.tmpdir(), mode: 'ask' });
  sessions.push(s);
  return new Promise((resolve, reject) => {
    const texts = [];
    s.on('item', item => {
      if (item.kind === 'permission') answer(s, item);
      if (item.kind === 'text') texts.push(item.text);
      if (item.kind === 'result') resolve(texts.join('\n'));
    });
    setTimeout(() => reject(new Error('timeout')), 10000);
    s.send(content);
  });
}

test('answers reach Claude as updatedInput.answers (question -> label)', async () => {
  const reply = await ask('ask', (s, item) => s.respond(item.requestId, 'allow', undefined, { 'Which color do you like?': 'Blue' }));
  assert.equal(reply, 'answers: {"Which color do you like?":"Blue"}');
});

test('multi-select and free-text answers; answers to questions that were never asked are dropped', async () => {
  const reply = await ask('ask2', (s, item) => s.respond(item.requestId, 'allow', undefined, {
    'Which color do you like?': 'a nice teal', 'Which snacks?': 'Chips, Nuts', 'Injected?': 'evil',
  }));
  assert.equal(reply, 'answers: {"Which color do you like?":"a nice teal","Which snacks?":"Chips, Nuts"}');
});

test('Skip denies with a message Claude can act on', async () => {
  const reply = await ask('ask', (s, item) => s.respond(item.requestId, 'deny', 'The user skipped the question.'));
  assert.equal(reply, 'skipped: The user skipped the question.');
});
