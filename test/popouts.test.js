const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/fake-ipc').installFakeElectron();
const { cleanCarry } = require('../src/main/wiring/popouts');

test('what was typed travels between windows, with the ids steering knows queued messages by', () => {
  const c = cleanCarry({
    draft: 'half a thought', attachments: ['C:\\a.png'], turnId: 't1',
    queue: [{ id: 'qab-1', text: 'also add tests', attachments: [], taken: true }, { id: 'qab-2', text: 'then push', attachments: ['C:\\b.txt'] }],
  });
  assert.deepEqual(c, {
    draft: 'half a thought', attachments: ['C:\\a.png'], turnId: 't1',
    queue: [{ id: 'qab-1', text: 'also add tests', attachments: [], taken: true }, { id: 'qab-2', text: 'then push', attachments: ['C:\\b.txt'] }],
  });
});

test('anything else a window sends is dropped, and nothing is nothing', () => {
  assert.equal(cleanCarry(null), null);
  assert.equal(cleanCarry('words'), null);
  const c = cleanCarry({
    draft: 42, attachments: ['', 7, 'C:\\ok'], turnId: 'x'.repeat(65), extra: 'no',
    queue: [{ text: 'no id' }, { id: 'q1' }, { id: 'q2', text: 'kept', attachments: 'not a list', taken: 'yes' }, null],
  });
  assert.deepEqual(c, { draft: '', attachments: ['C:\\ok'], turnId: null, queue: [{ id: 'q2', text: 'kept', attachments: [] }] });
});

test('long text is cut to what the box can send, and the queue to twenty', () => {
  const c = cleanCarry({ draft: 'x'.repeat(30), queue: Array.from({ length: 25 }, (_, i) => ({ id: `q${i}`, text: 'y'.repeat(30) })) }, { maxText: 10 });
  assert.equal(c.draft.length, 10);
  assert.equal(c.queue.length, 20);
  assert.equal(c.queue[0].text.length, 10);
});
