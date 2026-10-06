const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { wireBugdex } = require('../src/main/wiring/bugdex');

// Just enough of main's `shared` for the Bugdex's hooks, with a book that has never been saved.
function fakeMain(config = {}) {
  const data = { bugdex: null, xp: null, catchBugs: true, ...config };
  const errors = [];
  const sent = [];
  const d = {
    CAPTURE: false, SNAPSHOT_WAIT_MS: 2000,
    config: { get: k => data[k], set: patch => Object.assign(data, patch) },
    log: { info() {}, warn() {}, error: (...a) => errors.push(a) },
    send: (_w, channel, payload) => sent.push({ channel, payload }),
    panel: { isVisible: () => false, isFocused: () => false },
    stickerState: () => ({ projects: {} }),
    devServers: { view: () => ({ servers: [] }), fixDraft: () => null },
    projects: { localRepos: async () => [] },
    manager: { tabs: new Map() },
  };
  return { d, data, errors, sent };
}

test('every hook copes with a book that has never been saved', async () => {
  const { d, errors } = fakeMain();
  const b = wireBugdex(d);
  const dir = os.tmpdir();
  await b.ciFixed({ key: 'x/y#1' });
  await b.ciFailed({ key: 'x/y#1', repo: 'x/y', failing: ['test'] });
  await b.pushedClean(dir);
  await b.homeResult('t1', { root: dir, branch: 'b' }, { ok: true, merged: true });
  await b.serverCrashed({ id: 's1', root: dir });
  b.serverUp({ id: 's1', root: dir });
  b.turnEnded('t1', { ok: true });
  await b.wrote('t1');
  b.secretIgnored(dir);
  assert.equal(b.commandStart({ command: 'npm test', dir }), null);
  assert.deepEqual(errors, []);
  assert.equal(b.view().caught, 0);
});

test('a hook that fails is logged, never thrown at main', async () => {
  const { d, errors } = fakeMain();
  d.devServers.view = () => { throw new Error('boom'); };
  const b = wireBugdex(d);
  assert.doesNotThrow(() => b.turnEnded('t1', { ok: true }));
  assert.equal(errors.length, 1);
});

test('switched off, or in just-the-crab mode, nothing is noted', async () => {
  for (const config of [{ catchBugs: false }, { crabOnly: true }]) {
    const { d, data } = fakeMain(config);
    const b = wireBugdex(d);
    await b.flakySeen({ id: 'a1b2c3d4e5f6', name: 'p' }, 'auth › signs in');
    b.auditPatched({ id: 'a1b2c3d4e5f6', name: 'p' });
    assert.equal(data.bugdex, null);
  }
});

test('a patched audit catches the Barnacled Anchor; a flaky fix the Phantom, or a Heisenbug with history', () => {
  const { d, data, sent } = fakeMain();
  Object.assign(d, { stat() {}, noteWeek() {}, awardXp() {}, notify() {}, life: { presentJar() {} }, critter: {}, outfit: () => ({ confetti: null }), noteRecap() {} });
  const b = wireBugdex(d);
  const p = { id: 'a1b2c3d4e5f6', name: 'proj' };
  b.auditPatched(p);
  b.flakyFixed(p, 'auth › signs in', [Date.now()]);
  const DAY = 24 * 3600 * 1000;
  b.flakyFixed(p, 'cart › totals', [0, 1, 2, 3, 4].map(i => Date.now() - i * DAY));
  const caught = Object.keys(data.bugdex.species).filter(id => data.bugdex.species[id].byDevice.local > 0).sort();
  assert.deepEqual(caught, ['barnacled-anchor', 'flaky-phantom', 'heisenbug']);
  assert.ok(sent.some(m => m.channel === 'bugdex:caught'));
});

test('red builds are told apart by the checks that failed', () => {
  const { d } = fakeMain();
  const b = wireBugdex(d);
  assert.equal(b.ciSpecies({ failing: ['build', 'test', 'lint'] }), 'the-kraken');
  assert.equal(b.ciSpecies({ failing: ['test (windows-latest)'] }), 'matrix-hydra');
  assert.equal(b.ciSpecies({ failing: ['Deploy to Vercel'] }), 'sunken-deploy');
  assert.equal(b.ciSpecies({ failing: ['eslint'] }), 'lint-louse');
  assert.equal(b.ciSpecies({ failing: ['tsc'] }), 'type-tangle');
  assert.equal(b.ciSpecies({ failing: ['test'] }), 'red-tide');
});

test('starting over leaves a reset marker for sync, not nothing', async () => {
  const { d, data } = fakeMain();
  d.askOnce = async () => 0;
  const b = wireBugdex(d);
  assert.deepEqual(await b.forget(), { ok: true });
  assert.ok(data.bugdex.resetAt > 0);
});
