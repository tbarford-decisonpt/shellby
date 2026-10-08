// Turn checks (wiring/checks.js): "Checking…" is said to the window the
// conversation is in, the panel or its own popped-out one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { installFakeElectron } = require('./helpers/fake-ipc');

installFakeElectron();
// Its project's scripts never run here: checks.js and changes.js stand in.
const stub = (rel, exports) => {
  const key = require.resolve(path.join('../src/main', rel));
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
};
stub('checks', {
  detect: () => ['npm test'],
  trustOf: () => true,
  timeoutMs: () => 1000,
  runAll: () => ({ promise: Promise.resolve({ results: [{ ok: true }], cancelled: false }), cancel: () => {} }),
  buildVerdict: (_results, { after, root, tree }) => ({ kind: 'checks', status: 'pass', after, root, tree, at: 1 }),
  failingOf: () => ({ count: 0 }),
});
stub('changes', { snapshot: async () => ({ root: 'C:\\repo', tree: 'a'.repeat(40) }) });
const { wireChecks } = require('../src/main/wiring/checks');

function setup(windowOf) {
  const panel = { name: 'panel' };
  const sent = [];
  const manager = Object.assign(new EventEmitter(), {
    tabs: new Map([['t1', { session: { cwd: 'C:\\repo' } }]]),
    isBusy: () => false, note: () => {}, changed: () => {},
  });
  const d = {
    panel, manager, CAPTURE: false, log: { info: () => {} },
    config: { get: () => undefined, set: () => {} },
    send: (win, channel, payload) => sent.push({ win, channel, payload }),
    ...(windowOf ? { tabWindow: windowOf } : {}),
  };
  return { panel, sent, c: wireChecks(d) };
}

test('a popped-out conversation hears its checks start and finish', async () => {
  const popout = { name: 'popout' };
  const { sent, c } = setup(id => (id === 't1' ? popout : null));
  const r = await c.runChecksFor({ tabId: 't1', root: 'C:\\repo', after: 'b'.repeat(40) });
  assert.equal(r.ok, true);
  const running = sent.filter(s => s.channel === 'checks:running');
  assert.deepEqual(running.map(s => [s.win, s.payload.running]), [[popout, true], [popout, false]]);
});

test('one in the panel hears it there', async () => {
  const { panel, sent, c } = setup(() => null);
  await c.runChecksFor({ tabId: 't1', root: 'C:\\repo', after: 'b'.repeat(40) });
  assert.ok(sent.filter(s => s.channel === 'checks:running').every(s => s.win === panel));
});
