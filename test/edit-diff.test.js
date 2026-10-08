// The diff an edit card shows: worked out from the tool call (stream.js), with
// line numbers and an overwritten file's old contents read before it runs
// (session.js placeEdit), and kept off saved permission cards (history.js).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toItems } = require('../src/main/stream');
const { placeEdit } = require('../src/main/session');
const { History } = require('../src/main/history');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-edit-diff-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('edit tool calls and their permission requests carry the change', () => {
  const input = { file_path: 'C:\\x\\a.js', old_string: 'one', new_string: 'two' };
  const [tool] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input }] } });
  assert.deepEqual(tool.edits, [{ old: 'one', new: 'two' }]);
  const [ask] = toItems({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Edit', input, tool_use_id: 't1' } });
  assert.deepEqual(ask.edits, tool.edits);
  const [bash] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] } });
  assert.equal(bash.edits, undefined);
});

test('an Edit gets the line it lands on', async () => {
  const file = path.join(tmp(), 'a.txt');
  fs.writeFileSync(file, 'first\r\nsecond\r\nthird\r\n');
  const item = { kind: 'tool', name: 'Edit', filePath: file, edits: [{ old: 'second\nthird', new: 'x' }] };
  await placeEdit(item);
  assert.equal(item.line, 2);
});

test('a Write over an existing file is diffed against what it replaces; a new file is all additions', async () => {
  const cwd = tmp();
  const file = path.join(cwd, 'old.txt');
  fs.writeFileSync(file, 'keep\r\ndrop\r\n');
  const over = { kind: 'tool', name: 'Write', filePath: file, edits: [{ old: null, new: 'keep\nadd\n' }] };
  await placeEdit(over);
  assert.deepEqual(over.edits, [{ old: 'keep\ndrop\n', new: 'keep\nadd\n' }]);
  assert.equal(over.line, 1);
  const fresh = { kind: 'permission', toolName: 'Write', filePath: path.join(cwd, 'new.txt'), edits: [{ old: null, new: 'x' }] };
  await placeEdit(fresh);
  assert.deepEqual(fresh.edits, [{ old: null, new: 'x' }]);
  assert.equal(fresh.line, undefined);
});

test('a saved permission card keeps neither the input nor the edit text; the tool row keeps its diff', () => {
  const h = new History(tmp());
  h.create({ id: 'c1', title: 't', cwd: os.tmpdir() });
  h.append('c1', { kind: 'permission', requestId: 'r', toolName: 'Edit', input: { old_string: 'a' }, edits: [{ old: 'a', new: 'b' }] });
  h.append('c1', { kind: 'tool', id: 't', name: 'Edit', edits: [{ old: 'a', new: 'b' }] });
  const [ask, tool] = h.load('c1');
  assert.equal(ask.input, undefined);
  assert.equal(ask.edits, undefined);
  assert.deepEqual(tool.edits, [{ old: 'a', new: 'b' }]);
});
