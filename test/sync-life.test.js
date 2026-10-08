const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubApi } = require('../src/main/github/api');
const { syncNow, FILE } = require('../src/main/github/sync');
const life = require('../src/main/sync-life');
const gifts = require('../src/main/gifts');
const voice = require('../src/main/voice');
const { startMockGitHub } = require('./fixtures/mock-github');

class MemConfig {
  constructor(data = {}) { this.data = { ...data }; }
  get(k) { return this.data[k]; }
  set(p) { this.data = { ...this.data, ...p }; return this.data; }
}
const io = c => ({ get: k => c.get(k), set: p => c.set(p) });
const [A, B, C] = gifts.FINDS.map(f => f.id);
const pc = (device, extra = {}) => new MemConfig({ xp: { total: 0, device, byDevice: {} }, ...extra });
const n = (c, id) => gifts.normalize(c.get('finds')).items[id]?.n || 0;
const withGist = async fn => {
  const mock = await startMockGitHub();
  try { await fn(new GitHubApi({ token: mock.state.token, api: mock.base }), mock); } finally { await mock.close(); }
};

test('finds dug on two PCs add up on both, and syncing again never counts them twice', () => withGist(async gh => {
  const pc1 = pc('pc-one1', { finds: { items: { [A]: { n: 2, first: 100, last: 200 } }, digs: 5 } });
  const pc2 = pc('pc-two2', { finds: { items: { [A]: { n: 1, first: 50, last: 60, shiny: 1 }, [B]: { n: 3, first: 70, last: 80 } }, digs: 4 } });
  await syncNow(gh, io(pc1));
  await syncNow(gh, io(pc2));
  await syncNow(gh, io(pc1));
  for (const c of [pc1, pc2]) {
    const f = gifts.normalize(c.get('finds'));
    assert.equal(f.items[A].n, 3);
    assert.equal(f.items[A].shiny, 1, 'the sparkly one came along');
    assert.equal(f.items[A].first, 50, 'the earliest first find');
    assert.equal(f.items[B].n, 3);
    assert.equal(f.digs, 9);
  }
  for (let i = 0; i < 2; i++) { await syncNow(gh, io(pc2)); await syncNow(gh, io(pc1)); }
  assert.equal(n(pc1, A), 3);
  const again = await syncNow(gh, io(pc1));
  assert.deepEqual([again.pulled, again.pushed], [false, false], 'settled: nothing new, nothing written');
}));

test('a find given away on one PC stays gone on the other, and new ones still add up', () => withGist(async gh => {
  const pc1 = pc('pc-one1', { finds: { items: { [A]: { n: 2, first: 1, last: 1 } } } });
  const pc2 = pc('pc-two2');
  await syncNow(gh, io(pc1));
  await syncNow(gh, io(pc2));
  assert.equal(n(pc2, A), 2);
  // pc2 swaps both away (one dug on pc1), then pc1 digs another.
  pc2.set({ finds: { ...pc2.get('finds'), items: {} } });
  await syncNow(gh, io(pc2));
  pc1.set({ finds: { items: { [A]: { n: 3, first: 1, last: 9 } } } });
  await syncNow(gh, io(pc1));
  await syncNow(gh, io(pc2));
  assert.equal(n(pc1, A), 1);
  assert.equal(n(pc2, A), 1);
}));

test('a deleted gist loses nothing: this PC remembers every PC\'s share', () => withGist(async (gh, mock) => {
  const pc1 = pc('pc-one1', { finds: { items: { [A]: { n: 1, first: 1, last: 1 } } }, bond: { points: 40 } });
  const pc2 = pc('pc-two2', { finds: { items: { [C]: { n: 2, first: 1, last: 1 } } }, bond: { points: 10 } });
  await syncNow(gh, io(pc1));
  await syncNow(gh, io(pc2));
  mock.state.gists.clear();
  await syncNow(gh, io(pc2));
  const fresh = pc('pc-new33');
  await syncNow(gh, io(fresh));
  assert.equal(n(fresh, A), 1);
  assert.equal(n(fresh, C), 2);
  assert.equal(fresh.get('bond').points, 50);
}));

test('the bond: points add up, days together never double, memories and the birthday travel', () => withGist(async gh => {
  const pc1 = pc('pc-one1', { bond: { hatchedAt: 1000, points: 120, days: 30, level: 2, journal: [{ kind: 'first-pet', at: 2000 }] } });
  const pc2 = pc('pc-two2', { bond: { hatchedAt: 5000, points: 30, days: 12, level: 1, birthday: { m: 3, d: 14 }, journal: [{ kind: 'first-throw', at: 6000 }] } });
  pc2.set({ syncStamps: { life: { birthdayAt: 7000 } } });
  await syncNow(gh, io(pc1));
  await syncNow(gh, io(pc2));
  await syncNow(gh, io(pc1));
  for (const c of [pc1, pc2]) {
    const b = c.get('bond');
    assert.equal(b.points, 150);
    assert.equal(b.days, 30);
    assert.equal(b.hatchedAt, 1000);
    assert.equal(b.level, 2);
    assert.deepEqual(b.birthday, { m: 3, d: 14 });
    assert.deepEqual(b.journal.map(e => e.kind), ['first-pet', 'first-throw']);
  }
}));

test('he is the same crab everywhere: the older crab\'s seed wins', () => withGist(async gh => {
  const pc1 = pc('pc-one1', { voice: { seed: 'zz-new' }, bond: { hatchedAt: 9000 } });
  const pc2 = pc('pc-two2', { voice: { seed: 'aa-old' }, bond: { hatchedAt: 1000 } });
  await syncNow(gh, io(pc1));
  await syncNow(gh, io(pc2));
  await syncNow(gh, io(pc1));
  assert.equal(voice.normalize(pc1.get('voice')).seed, 'aa-old');
  assert.equal(voice.normalize(pc2.get('voice')).seed, 'aa-old');
}));

test('games, quests, scenes and the typing best come along', () => withGist(async gh => {
  const pc1 = pc('pc-one1', { play: { hide: { games: 3, found: 2, won: 1, best: 9000 }, fetch: { throws: 4, fetched: 4, longest: 300 } }, quests: { done: { [require('../src/main/quests').QUESTS[0].id]: 50 } }, scenesSeen: ['sneeze'], typingBest: 80 });
  const pc2 = pc('pc-two2', { play: { hide: { games: 1, found: 1, best: 4000 }, fetch: { throws: 1, fetched: 1, longest: 900 } }, scenesSeen: ['hiccups'], typingBest: 60 });
  await syncNow(gh, io(pc1));
  await syncNow(gh, io(pc2));
  const p = pc2.get('play');
  assert.deepEqual(p.hide, { games: 4, found: 3, won: 1, best: 4000 });
  assert.deepEqual(p.fetch, { throws: 5, fetched: 5, longest: 900 });
  assert.equal(Object.keys(pc2.get('quests').done).length, 1);
  assert.deepEqual([...pc2.get('scenesSeen')].sort(), ['hiccups', 'sneeze']);
  assert.equal(pc2.get('typingBest'), 80);
}));

test('what stays on each PC: today\'s caps, finds set aside for a swap, the shelf\'s new marks', () => withGist(async gh => {
  const pc1 = pc('pc-one1', { finds: { items: { [A]: { n: 2, first: 1, last: 1, held: 1 } }, today: 4, day: '2026-10-08', unseen: [A] } });
  const pc2 = pc('pc-two2');
  await syncNow(gh, io(pc1));
  await syncNow(gh, io(pc2));
  const f = gifts.normalize(pc2.get('finds'));
  assert.equal(f.items[A].n, 2);
  assert.equal(f.items[A].held, undefined);
  assert.equal(f.today, 0);
  assert.deepEqual(f.unseen, []);
}));

test('a hostile gist part is cleaned away', () => {
  const c = life.clean({ tally: { 'BAD DEV': { at: 1, v: { x: 1 } }, 'pc-ok12': { at: 'x', v: { '../x': 5, 'finds.a': 1e99, 'finds.b': 'lots' } } }, finds: { first: { nope: 1 } }, voice: { seed: 7 }, typingBest: 1e9, scenes: ['<img>'] });
  assert.deepEqual(Object.keys(c.tally), ['pc-ok12']);
  assert.deepEqual(c.tally['pc-ok12'].v, { 'finds.a': 1e9 });
  assert.deepEqual(c.finds.first, {});
  assert.equal(c.voice, null);
  assert.equal(c.typingBest, 400);
  assert.deepEqual(c.scenes, []);
  assert.ok(FILE);
});
