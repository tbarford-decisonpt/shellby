// The usage banner and held messages' logic (src/renderer/shared/outlook-format.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/renderer/shared/outlook-format');

test('noteFor: being at the limit wins over a warning', () => {
  const o = { limit: { name: '5-hour', at: '3:00 pm', resetsAt: 111 }, warning: { text: 'Close to it', resetsAt: 222 } };
  assert.deepEqual(W.noteFor(o), { text: "You're at your 5-hour limit until 3:00 pm.", key: 111, cls: 'limit' });
});

test('noteFor: a warning on its own, and nothing when there is neither', () => {
  assert.deepEqual(W.noteFor({ warning: { text: 'Close to it', resetsAt: 222 } }), { text: 'Close to it', key: 222, cls: 'warning' });
  assert.equal(W.noteFor({}), null);
  assert.equal(W.noteFor(null), null);
  assert.equal(W.noteFor(undefined), null);
});

test('actionsFor offers nothing until the reset time is known', () => {
  assert.deepEqual(W.actionsFor({ resetAt: null, typed: true, queued: 2 }), []);
});

test('actionsFor offers to send what is typed, hold the queue, or else the hint', () => {
  assert.deepEqual(W.actionsFor({ resetAt: 1, typed: true, queued: 0 }), ['send-typed']);
  assert.deepEqual(W.actionsFor({ resetAt: 1, typed: false, queued: 3 }), ['hold-queue']);
  assert.deepEqual(W.actionsFor({ resetAt: 1, typed: true, queued: 3 }), ['send-typed', 'hold-queue']);
  assert.deepEqual(W.actionsFor({ resetAt: 1, typed: false, queued: 0 }), ['hint']);
});

test('heldFor keeps only held messages for that tab', () => {
  const outlook = { held: [
    { id: 1, kind: 'message', tabId: 'a' },
    { id: 2, kind: 'message', tabId: 'b' },
    { id: 3, kind: 'routine', tabId: 'a' },
  ] };
  assert.deepEqual(W.heldFor(outlook, 'a').map(x => x.id), [1]);
  assert.deepEqual(W.heldFor({}, 'a'), []);
  assert.deepEqual(W.heldFor(null, 'a'), []);
});

test('describe shows the text, or counts the attachments when there is none', () => {
  assert.equal(W.describe({ text: 'Ship it', attachments: [] }), 'Ship it');
  assert.equal(W.describe({ text: '', attachments: ['a.png'] }), '1 attached file');
  assert.equal(W.describe({ text: '', attachments: ['a.png', 'b.png'] }), '2 attached files');
});

test('holdRefusal: not before the reset time is known, and never a ! command', () => {
  assert.match(W.holdRefusal('hi', null).text, /doesn't know when your window resets/);
  assert.equal(W.holdRefusal('hi', null).ms, 5000);
  assert.match(W.holdRefusal('!dir', 123).text, /Commands you run with !/);
  assert.equal(W.holdRefusal('!!not a command', 123), null, '!! is a literal !, not a command');
  assert.equal(W.holdRefusal('hello', 123), null);
});

test('queueHeldText counts one and many', () => {
  assert.equal(W.queueHeldText(1, '3:00 pm'), 'Your queued message goes at 3:00 pm, once your usage resets.');
  assert.equal(W.queueHeldText(3, '3:00 pm'), '3 queued messages go at 3:00 pm, once your usage resets.');
});
