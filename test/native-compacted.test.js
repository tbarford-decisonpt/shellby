const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wireNative } = require('../src/main/wiring/native');

function rig() {
  const sent = [], said = [];
  const critter = {};
  const native = wireNative({ critter, send: (win, ch, msg) => sent.push({ win, ch, msg }), speak: o => said.push(o) });
  return { native, sent, said, critter };
}

test('a compacted conversation makes him pack his load down and say so', () => {
  const { native, sent, said, critter } = rig();
  native.onItem('t1', { kind: 'compacted', trigger: 'auto' }, { id: 't1' });
  assert.deepEqual(sent, [{ win: critter, ch: 'critter:bit', msg: { bit: 'pack', ms: 2200 } }]);
  assert.deepEqual(said, ['compacted']);
});

test('routines and workflows compacting on their own stay quiet', () => {
  const { native, sent, said } = rig();
  native.onItem('t1', { kind: 'compacted' }, { id: 't1', routineId: 'r1' });
  native.onItem('t2', { kind: 'compacted' }, { id: 't2', workflowRunId: 'w1' });
  assert.deepEqual([sent, said], [[], []]);
});
