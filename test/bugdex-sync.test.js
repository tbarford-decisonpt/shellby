const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GitHubApi } = require('../src/main/github/api');
const { syncNow } = require('../src/main/github/sync');
const b = require('../src/main/bugdex');
const { ACHIEVEMENTS } = require('../src/main/wardrobe/achievements');
const { wireBugdex } = require('../src/main/wiring/bugdex');
const { startMockGitHub } = require('./fixtures/mock-github');

class MemConfig {
  constructor(data = {}) { this.data = { ...data }; }
  get(k) { return this.data[k]; }
  set(p) { this.data = { ...this.data, ...p }; return this.data; }
}
const io = c => ({ get: k => c.get(k), set: p => c.set(p) });
const T0 = new Date(2026, 9, 6, 12, 0, 0).getTime();
const HOUR = 3600 * 1000;
const never = () => 0.99;
const catchOf = (over = {}) => ({ species: 'nullfish', fp: 'abcdefabcdef', project: 'a1b2c3d4e5f6', firstAt: T0, device: 'local', rand: never, ...over });
const pc = (device, book) => new MemConfig({ xp: { total: 0, device, byDevice: {} }, bugdex: book });
const caught = (c, id) => b.caughtOf(b.normalize(c.get('bugdex')).species[id]);
const withGist = async fn => {
  const mock = await startMockGitHub();
  try { await fn(new GitHubApi({ token: mock.state.token, api: mock.base })); } finally { await mock.close(); }
};

test('bugs caught on two PCs add up on both through the gist, and syncing again never counts them twice', () => withGist(async gh => {
  const one = b.recordCatch(null, catchOf(), T0).state;
  let two = b.recordCatch(null, catchOf({ fp: '000000000002' }), T0 - HOUR).state;
  two = b.recordCatch(two, catchOf({ fp: '000000000003', firstAt: T0 + HOUR }), T0 + 2 * HOUR).state;
  const pc1 = pc('pc-one1', one);
  const pc2 = pc('pc-two2', two);
  await syncNow(gh, io(pc1));
  await syncNow(gh, io(pc2));
  await syncNow(gh, io(pc1));
  for (const c of [pc1, pc2]) {
    assert.equal(caught(c, 'nullfish'), 3);
    assert.equal(b.normalize(c.get('bugdex')).species.nullfish.first, T0 - HOUR, 'the earliest first catch');
  }
  for (let i = 0; i < 2; i++) { await syncNow(gh, io(pc2)); await syncNow(gh, io(pc1)); }
  assert.equal(caught(pc1, 'nullfish'), 3);
  assert.equal(b.normalize(pc1.get('bugdex')).open.length, b.normalize(one).open.length, 'open encounters stay on their PC');
}));

test('an old Shellby with no Bugdex in the gist keeps its catches', () => withGist(async gh => {
  const pc1 = pc('pc-one1', null);
  const pc2 = pc('pc-two2', b.recordCatch(null, catchOf(), T0).state);
  await syncNow(gh, io(pc1));
  await syncNow(gh, io(pc2));
  await syncNow(gh, io(pc1));
  assert.equal(caught(pc1, 'nullfish'), 1);
  assert.equal(caught(pc2, 'nullfish'), 1);
}));

test('a catch counts toward the Bugdex trophies and the week in review', () => {
  const data = { bugdex: null, xp: null, catchBugs: true };
  const stats = [];
  const week = [];
  const d = {
    CAPTURE: false, SNAPSHOT_WAIT_MS: 2000,
    config: { get: k => data[k], set: patch => Object.assign(data, patch) },
    log: { info() {}, warn() {}, error() {} },
    send() {},
    panel: { isVisible: () => false, isFocused: () => false },
    stickerState: () => ({ projects: {} }),
    devServers: { view: () => ({ servers: [] }), fixDraft: () => null },
    projects: { localRepos: async () => [] },
    manager: { tabs: new Map() },
    stat: id => stats.push(id), noteWeek: k => week.push(k),
    awardXp() {}, notify() {}, life: { presentJar() {} }, critter: {}, outfit: () => ({ confetti: null }), noteRecap() {},
  };
  wireBugdex(d).auditPatched({ id: 'a1b2c3d4e5f6', name: 'proj' });
  assert.ok(stats.includes('bug-caught') && stats.includes('bug-species'));
  assert.deepEqual(week, ['caught', 'newbug']);
  const bugStats = new Set(['bugsCaught', 'bugSpecies', 'habitatsDone', 'goldenCatches', 'legendaryBugs', 'ghostSpecies']);
  assert.ok(ACHIEVEMENTS.some(a => a.id === 'gotcha' && bugStats.has(a.stat)), 'the first catch has a trophy');
});
