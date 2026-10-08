// The secret scan every push asks (src/main/secret-gate.js): nothing found
// pushes on, "Push anyway" pushes on, anything else stops the push the same
// way wherever it came from. Fake secrets are glued together at runtime.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { secretGate } = require('../src/main/secret-gate');

const finding = { file: 'aws.js', line: 2, kind: 'an AWS access key', where: 'unpushed' };

function fakeD({ crabOnly = false } = {}) {
  const sent = [];
  const logged = [];
  return {
    sent, logged, panel: {},
    config: { get: k => (k === 'crabOnly' ? crabOnly : undefined) },
    log: { info: m => logged.push(m), warn: m => logged.push(m) },
    dialogLook: () => ({ theme: 'test' }),
    showPanel: () => {},
    send: (_w, ch, payload) => sent.push({ ch, payload }),
  };
}

const scanning = (findings, extra = {}) => {
  const calls = [];
  const scan = async (root, run, opts) => { calls.push({ root, run, opts }); return { ok: true, partial: false, findings, more: 0, ...extra }; };
  return { scan, calls };
};

test('nothing found: the push goes on without a question, and the range is passed through', async () => {
  const { scan, calls } = scanning([]);
  let asked = false;
  const r = await secretGate(fakeD(), '/r/proj', { rev: 'refs/heads/main', remote: 'origin', scan, ask: async () => { asked = true; } });
  assert.equal(r, null);
  assert.equal(asked, false);
  assert.deepEqual(calls[0].opts, { rev: 'refs/heads/main', remote: 'origin' });
});

test('a scan git could not run lets the push go, and says so in the log', async () => {
  const d = fakeD();
  const r = await secretGate(d, '/r/proj', { scan: async () => ({ ok: false, findings: [], more: 0 }), ask: async () => 2 });
  assert.equal(r, null);
  assert.match(d.logged[0], /secret scan/);
});

test('found: "Don\'t push" is the default, and stops the push', async () => {
  const { scan } = scanning([finding]);
  let spec;
  const r = await secretGate(fakeD(), '/r/proj', { scan, ask: async s => { spec = s; return s.cancelId; } });
  assert.deepEqual(r, { ok: false, cancelled: true, secrets: 1, error: 'Not pushed: it had something that looks like a secret.' });
  assert.equal(spec.defaultId, spec.cancelId);
  assert.deepEqual(spec.buttons.map(b => b.label), ['Push anyway', 'Ask Claude to take them out', "Don't push"]);
  assert.equal(spec.detail, 'aws.js:2 (an AWS access key)');
  assert.equal(spec.theme, 'test');
  assert.match(spec.message, /proj's remote/);
});

test('"Push anyway" pushes on; "Ask Claude" opens a draft and still stops', async () => {
  const { scan } = scanning([finding]);
  assert.equal(await secretGate(fakeD(), '/r/proj', { scan, ask: async () => 0 }), null);
  const d = fakeD();
  const r = await secretGate(d, '/r/proj', { scan, ask: async () => 1 });
  assert.equal(r.cancelled, true);
  assert.equal(d.sent[0].ch, 'tab:new-in');
  assert.match(d.sent[0].payload.draft, /aws\.js:2/);
});

test('crab-only: no "Ask Claude" button', async () => {
  const { scan } = scanning([finding]);
  let spec;
  await secretGate(fakeD({ crabOnly: true }), '/r/proj', { scan, ask: async s => { spec = s; return 1; } });
  assert.deepEqual(spec.buttons.map(b => b.label), ['Push anyway', "Don't push"]);
});
