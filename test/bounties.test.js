const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BOUNTIES, CLEAR_ALL_XP, pickFor, normalizeBounties, progressBounties, bountiesView } = require('../src/main/bounties');

const days = n => Array.from({ length: n }, (_, i) => { const d = new Date(2026, 9, 1 + i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });

test('every day has three bounties, the same on every PC, never two of a kind', () => {
  const seen = new Set();
  for (const day of days(60)) {
    const ids = pickFor(day);
    assert.equal(ids.length, 3, day);
    assert.deepEqual(pickFor(day), ids);
    const kinds = ids.flatMap(id => BOUNTIES.find(b => b.id === id).kinds);
    assert.equal(new Set(kinds).size, kinds.length, `${day}: ${ids}`);
    ids.forEach(id => seen.add(id));
  }
  assert.equal(seen.size, BOUNTIES.length, 'every bounty comes up sooner or later');
});

test('distinct-project bounties only count new projects', () => {
  const day = days(60).find(d => pickFor(d).includes('push2'));
  let r = progressBounties(null, day, 'ship', 'reef');
  r = progressBounties(r.state, day, 'ship', 'reef');
  assert.deepEqual(r.completed, []);
  r = progressBounties(r.state, day, 'ship', 'kelp');
  assert.deepEqual(r.completed.map(b => b.id), ['push2']);
  assert.equal(r.xp, 50);
  assert.equal(progressBounties(r.state, day, 'ship', 'tide').completed.length, 0, 'done is done');
});

test('clearing all three pays the bonus once; a new day starts fresh; junk is tolerated', () => {
  const day = '2026-10-03';
  let s = null, total = 0, cleared = 0;
  for (let i = 0; i < 40; i++) {
    for (const k of ['task', 'tests', 'fixed', 'ship', 'deploy', 'focus']) {
      const r = progressBounties(s, day, k, `p${i}`);
      s = r.state; total += r.xp; cleared += r.cleared ? 1 : 0;
    }
  }
  const want = pickFor(day).reduce((n, id) => n + BOUNTIES.find(b => b.id === id).xp, 0) + CLEAR_ALL_XP;
  assert.equal(total, want);
  assert.equal(cleared, 1);
  assert.equal(bountiesView(s, day).cleared, true);
  assert.equal(bountiesView(s, '2026-10-04').cleared, false);
  assert.deepEqual(normalizeBounties({ day, progress: { x: 1 }, done: ['nope'], cleared: true }, day).done, []);
  assert.equal(normalizeBounties('junk', 'not-a-day').day, null);
  assert.equal(progressBounties(null, 'bad', 'task').xp, 0);
});
