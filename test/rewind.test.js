const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan, points } = require('../src/main/rewind');

const user = (turnId, text, extra = {}) => ({ kind: 'user', turnId, text, t: 1000, ...extra });
const result = anchor => ({ kind: 'result', ok: true, ...(anchor ? { anchor } : {}) });
const change = after => ({ kind: 'changes', root: 'C:/repo', before: `b-${after}`, after, files: [] });

const convo = [
  user('t1', 'first'),
  { kind: 'text', text: 'one' },
  change('a1'),
  result('u-end-1'),
  user('t2', 'second', { attachments: ['C:/shot.png'] }),
  { kind: 'text', text: 'two' },
  change('a2'),
  result('u-end-2'),
  user('t3', 'third'),
  change('a3'),
  result('u-end-3'),
];

test('plan: rewinding to a later message resumes up to the end of the turn before it', () => {
  const p = plan(convo, 't3');
  assert.equal(p.ok, true);
  assert.equal(p.index, 8);
  assert.equal(p.anchor, 'u-end-2');
  assert.equal(p.fresh, false);
  assert.equal(p.conversation, true);
  assert.deepEqual(p.changes.map(c => c.after), ['a3']);
  assert.equal(p.text, 'third');
});

test('plan: the code to undo is every turn from that message on, newest first', () => {
  const p = plan(convo, 't2');
  assert.equal(p.anchor, 'u-end-1');
  assert.deepEqual(p.changes.map(c => c.after), ['a3', 'a2']);
  assert.deepEqual(p.attachments, ['C:/shot.png'], 'its attachments come back with it');
});

test('plan: the first message means starting the conversation over', () => {
  const p = plan(convo, 't1');
  assert.equal(p.fresh, true);
  assert.equal(p.anchor, null);
  assert.equal(p.conversation, true);
  assert.deepEqual(p.changes.map(c => c.after), ['a3', 'a2', 'a1']);
});

test('plan: a turn from before anchors existed can only have its code put back', () => {
  const old = [user('t1', 'first'), result(null), user('t2', 'second'), change('x'), result('u2')];
  const p = plan(old, 't2');
  assert.equal(p.ok, true);
  assert.equal(p.conversation, false);
  assert.equal(p.anchor, null);
  assert.deepEqual(p.changes.map(c => c.after), ['x']);
});

test('plan: a fresh start counts as a beginning', () => {
  const items = [user('t1', 'first'), result('u1'), { kind: 'fresh' }, user('t2', 'after the summary'), result('u2'), user('t3', 'next'), result('u3')];
  const p2 = plan(items, 't2');
  assert.equal(p2.fresh, true, 'nothing before the fresh start can be resumed into');
  assert.equal(p2.anchor, null);
  const p3 = plan(items, 't3');
  assert.equal(p3.anchor, 'u2');
});

test('plan: /clear counts as a beginning, like a fresh start', () => {
  const items = [user('t1', 'first'), result('u1'), { kind: 'cleared' }, user('t2', 'after the clear'), result('u2'), user('t3', 'next'), result('u3')];
  const p2 = plan(items, 't2');
  assert.equal(p2.fresh, true, 'nothing before the clear can be resumed into');
  assert.equal(p2.anchor, null);
  assert.equal(p2.conversation, true);
  assert.equal(plan(items, 't3').anchor, 'u2');
});

test('points: only messages since the last /clear, as the terminal shows them', () => {
  const items = [user('t1', 'old'), result('u1'), { kind: 'cleared' }, user('t2', 'kept'), result('u2'), { kind: 'cleared' }, user('t3', 'newest'), result('u3')];
  assert.deepEqual(points(items).map(p => p.turnId), ['t3']);
  assert.deepEqual(points([user('t1', 'a'), { kind: 'cleared' }]), [], 'nothing since a clear: nothing to rewind to');
  assert.deepEqual(points([user('t1', 'a'), { kind: 'fresh' }, user('t2', 'b')]).map(p => p.turnId), ['t2', 't1'], 'a fresh start keeps what came before on screen');
});

test('plan: an unknown message is an error, not a guess', () => {
  assert.equal(plan(convo, 'nope').ok, false);
  assert.equal(plan(convo, null).ok, false);
  assert.equal(plan(null, 't1').ok, false);
});

test('points: your messages with ids, newest first; older ones without ids are left out', () => {
  const items = [{ kind: 'user', text: 'no id' }, ...convo, user('t4', '', { attachments: ['a.png', 'b.png'] })];
  assert.deepEqual(points(items).map(p => [p.turnId, p.text]), [
    ['t4', '2 attached files'], ['t3', 'third'], ['t2', 'second'], ['t1', 'first'],
  ]);
});

test('plan: a diff noted after the next message still belongs to its own turn', () => {
  const items = [
    user('t1', 'first'), result('u1'),
    user('t2', 'second'),
    { ...change('a1'), turnId: 't1' }, // turn 1's diff, worked out after you'd sent turn 2
    result('u2'),
    { ...change('a2'), turnId: 't2' },
  ];
  const p = plan(items, 't2');
  assert.deepEqual(p.changes.map(c => c.after), ['a2'], "turn 1's diff is not undone");
  assert.deepEqual(p.tail.map(c => c.after), ['a1'], '...and it stays in the transcript');
  assert.deepEqual(plan(items, 't1').changes.map(c => c.after), ['a2', 'a1']);
});
