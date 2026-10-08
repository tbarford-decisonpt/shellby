// Settings and the friends list following you between PCs (sync-prefs.js,
// friends.js mergeSync, github/sync.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const prefs = require('../src/main/sync-prefs');
const { DEFAULTS } = require('../src/main/config');
const { Friends, syncable, mergeSync, applySync, normalize } = require('../src/main/friends');
const { GitHubApi } = require('../src/main/github/api');
const { syncNow } = require('../src/main/github/sync');
const { startMockGitHub } = require('./fixtures/mock-github');

class MemConfig {
  constructor(data = {}) { this.data = { ...DEFAULTS, ...data }; }
  get(k) { return this.data[k]; }
  set(p) { this.data = { ...this.data, ...p }; return this.data; }
}
const io = c => ({ get: k => c.get(k), set: p => c.set(p), data: () => c.data });

// ------------------------------------------------------------------ settings

test('prefs: only personal settings travel, and never Autonomous', () => {
  const snap = prefs.snapshot({ ...DEFAULTS, chatter: 'chatty', critterPos: { x: 1, y: 2 }, cwd: 'C:\\work', openAtLogin: true, pushToTalk: true }, {});
  assert.equal(snap.chatter.v, 'chatty');
  for (const k of ['critterPos', 'cwd', 'openAtLogin', 'pushToTalk', 'claudePath', 'channelSecret', 'crashReports', 'routines']) assert.ok(!(k in snap), k);
  assert.ok(!('mode' in prefs.snapshot({ ...DEFAULTS, mode: 'autonomous' }, { mode: 5 })), 'Autonomous stays on its PC');
  assert.ok(!('mode' in prefs.clean({ mode: { v: 'autonomous', at: 9 } })), 'and is refused from the gist');
});

test('prefs: remote values are held to the same rules as the Settings panel', () => {
  const c = prefs.clean({
    chatter: { v: 'shouty', at: 5 }, colony: { v: 99, at: 5 }, critterScale: { v: 3, at: 5 }, sounds: { v: 'yes', at: 5 },
    hotkey: { v: 'Control+Alt+K; rm -rf', at: 5 }, workOverrides: { v: { chatter: 'quiet', mode: 'autonomous', colony: 2 }, at: 5 },
    pinnedTools: { v: [{ kind: 'skill', name: 'review' }, { kind: 'Bad Kind', name: 'x' }, null], at: 5 },
    nonsense: { v: 1, at: 5 },
  });
  assert.deepEqual(Object.keys(c).sort(), ['colony', 'pinnedTools', 'workOverrides']);
  assert.equal(c.colony.v, 5, 'clamped to the most pals there are');
  assert.deepEqual(c.workOverrides.v, { chatter: 'quiet', colony: 2 }, "only Work mode's own keys");
  assert.deepEqual(c.pinnedTools.v, [{ kind: 'skill', name: 'review' }]);
});

test('prefs: each setting follows the PC that changed it last; a set-up PC beats a fresh one', () => {
  const setUp = prefs.snapshot({ ...DEFAULTS, chatter: 'quiet', sounds: true }, {});
  const fresh = prefs.snapshot({ ...DEFAULTS }, {});
  assert.equal(prefs.merge(fresh, setUp).chatter.v, 'quiet', 'never stamped, but not the default');
  assert.equal(prefs.merge(setUp, fresh).sounds.v, true);
  const later = prefs.snapshot({ ...DEFAULTS, chatter: 'chatty' }, { chatter: 1000 });
  const m = prefs.merge(setUp, later);
  assert.deepEqual([m.chatter.v, m.sounds.v], ['chatty', true], 'per setting, not all or nothing');
  const { values, stamps } = prefs.apply(setUp, m);
  assert.deepEqual(values, { chatter: 'chatty' }, 'only what another PC changed is written');
  assert.equal(stamps.chatter, 1000);
});

test('prefs: changedKeys sees real changes to synced settings only', () => {
  const prev = { ...DEFAULTS };
  assert.deepEqual(prefs.changedKeys({ chatter: 'quiet', critterPos: { x: 1 }, sounds: false }, prev), ['chatter']);
});

// ------------------------------------------------------------------ friends

test('friends: the list merges by the latest add or remove for each login', () => {
  const pc1 = { list: [{ login: 'alice', addedAt: 100 }, { login: 'bob', addedAt: 100 }] };
  const pc2 = { list: [{ login: 'Alice', addedAt: 100 }, { login: 'carol', addedAt: 300 }], removed: [{ login: 'bob', at: 200 }] };
  const m = mergeSync(pc1, pc2);
  assert.deepEqual(m.list.map(f => f.login.toLowerCase()), ['alice', 'carol']);
  assert.deepEqual(m.removed.map(r => r.login), ['bob']);
  // Bob added back later on pc1 beats the removal.
  const back = mergeSync({ list: [{ login: 'bob', addedAt: 500 }] }, m);
  assert.ok(back.list.some(f => f.login === 'bob'));
  assert.ok(!back.removed.some(r => r.login === 'bob'));
});

test('friends: an old friend (no addedAt) loses to a removal anywhere', () => {
  const m = mergeSync({ list: [{ login: 'dave' }] }, { removed: [{ login: 'dave', at: 2 }] });
  assert.deepEqual(m.list, []);
});

test('friends: applying a sync keeps what this PC knows of each friend', () => {
  const local = normalize({ list: [{ login: 'alice', cardId: 'a1', card: null, visitedAt: 77, addedAt: 100 }], guestbook: [], cardId: 'mine' });
  const out = applySync(local, { list: [{ login: 'alice', addedAt: 100 }, { login: 'carol', cardId: 'c1', addedAt: 300 }] });
  assert.equal(out.list.find(f => f.login === 'alice').visitedAt, 77);
  assert.deepEqual(out.list.find(f => f.login === 'carol'), { login: 'carol', cardId: 'c1', card: null, checkedAt: 0, visitedAt: 0, addedAt: 300 });
  assert.equal(out.cardId, 'mine', 'your own card stays');
  assert.deepEqual(syncable(out).list.map(f => f.login), ['alice', 'carol']);
});

test('friends: removing one remembers when, so a sync from another PC does not bring them back', () => {
  const config = new MemConfig({ friends: { list: [{ login: 'bob', addedAt: 100 }] } });
  const f = new Friends({ config, github: { can: () => true, view: () => ({ login: 'me' }) }, myCard: () => ({}), now: () => 4242 });
  f.remove('bob');
  assert.deepEqual(config.get('friends').removed, [{ login: 'bob', at: 4242 }]);
  assert.deepEqual(mergeSync(config.get('friends'), { list: [{ login: 'bob', addedAt: 100 }] }).list, []);
});

// ------------------------------------------------------------------ end to end

test('sync: friends and settings follow you to a second PC, and removals stick', async () => {
  const mock = await startMockGitHub();
  try {
    const gh = new GitHubApi({ token: mock.state.token, api: mock.base });
    const pc1 = new MemConfig({
      chatter: 'quiet', sounds: true, hotkey: 'Control+Alt+K', critterPos: { x: 10, y: 20 },
      friends: { list: [{ login: 'alice', addedAt: 100 }, { login: 'bob', addedAt: 100 }] },
    });
    const pc2 = new MemConfig({ critterPos: { x: 900, y: 900 } });
    await syncNow(gh, io(pc1));
    const r = await syncNow(gh, io(pc2));
    assert.equal(r.pulled, true);
    assert.deepEqual([pc2.get('chatter'), pc2.get('sounds'), pc2.get('hotkey')], ['quiet', true, 'Control+Alt+K']);
    assert.deepEqual(pc2.get('critterPos'), { x: 900, y: 900 }, "where he sits is each PC's own");
    assert.deepEqual(pc2.get('friends').list.map(f => f.login), ['alice', 'bob']);

    // pc2 removes bob and turns the sounds off; pc1 picks both up.
    pc2.set({ friends: { ...pc2.get('friends'), list: pc2.get('friends').list.filter(f => f.login !== 'bob'), removed: [{ login: 'bob', at: Date.now() }] } });
    pc2.set({ sounds: false, syncStamps: { ...pc2.get('syncStamps'), prefs: { ...pc2.get('syncStamps').prefs, sounds: Date.now() } } });
    await syncNow(gh, io(pc2));
    await syncNow(gh, io(pc1));
    assert.deepEqual(pc1.get('friends').list.map(f => f.login), ['alice'], 'bob stays removed');
    assert.equal(pc1.get('sounds'), false);
    assert.equal(pc1.get('chatter'), 'quiet');

    const again = await syncNow(gh, io(pc1));
    assert.deepEqual([again.pulled, again.pushed], [false, false], 'settled');
  } finally { await mock.close(); }
});
