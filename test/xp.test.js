const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  xpForLevel, levelFor, award, classifyCommand, normalizeXp, AWARDS, TITLES, UNLOCKS, unlocksBetween, nextUnlock,
  streakMultiplier, withDevice, markRed, mergeXpCounts, xpSummary,
} = require('../src/main/xp');
const { pickFor, BOUNTIES, CLEAR_ALL_XP } = require('../src/main/bounties');

const T0 = new Date(2026, 9, 1, 12, 0, 0).getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('level curve: 0, 100, 250, 450, 700 ... and titles', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10].map(xpForLevel), [0, 100, 250, 450, 700, 2700]);
  assert.deepEqual(levelFor(0), { level: 1, title: 'Hatchling', rank: { name: 'Sunlit', color: '#ffd23f' }, xp: 0, floor: 0, next: 100, into: 0, needed: 100, progress: 0 });
  const l = levelFor(320);
  assert.deepEqual([l.level, l.title, l.into, l.needed], [3, 'Shell Seeker', 70, 200]);
  assert.equal(levelFor(2700).title, 'Coral Commander');
  assert.equal(levelFor(1e9).level, 99);
  assert.equal(levelFor(-5).level, 1);
});

test('award adds XP, logs it, and reports level-ups', () => {
  let s = normalizeXp(null);
  for (let i = 0; i < 9; i++) s = award(s, 'task', T0 + i * MIN).state;
  assert.equal(s.total, 90);
  const r = award(s, 'task', T0 + 10 * MIN, { label: 'Tidy Downloads', project: '3d-rack' });
  assert.equal(r.gained, 10);
  assert.equal(r.levelUp, true);
  assert.deepEqual([r.before.level, r.after.level], [1, 2]);
  assert.deepEqual(r.state.log[0], { at: T0 + 10 * MIN, kind: 'task', xp: 10, label: 'Tidy Downloads', project: '3d-rack' });
});

test('a new self-written trick is the biggest award', () => {
  const r = award(null, 'trick', T0, { label: 'rename-screenshots' });
  assert.equal(r.gained, 150);
  assert.ok(Object.values(AWARDS).every(a => a.xp <= AWARDS.trick.xp));
  assert.equal(r.after.level, 2);
});

test('repeats within an hour pay less and less (tests: 6 full, 6 half, 12 quarter, then none), and reset after an hour', () => {
  let s = null;
  const got = [];
  for (let i = 0; i < 30; i++) { const r = award(s, 'tests', T0 + i * MIN); s = r.state; got.push(r.gained); }
  assert.deepEqual(got, [...Array(6).fill(25), ...Array(6).fill(13), ...Array(12).fill(6), ...Array(6).fill(0)]);
  assert.equal(award(s, 'tests', T0 + 90 * MIN).gained, 25);
});

test('"day" counts once per calendar day', () => {
  let r = award(null, 'day', T0);
  assert.equal(r.gained, 5);
  r = award(r.state, 'day', T0 + 5 * 60 * MIN);
  assert.equal(r.gained, 0);
  assert.equal(award(r.state, 'day', T0 + 24 * 60 * MIN).gained, 5);
});

test('unknown kinds, bad clocks and junk state award nothing and never throw', () => {
  assert.equal(award(null, 'nope', T0).gained, 0);
  assert.equal(award(null, 'bounty', T0).gained, 0);
  assert.equal(award(null, 'task', NaN).gained, 0);
  const s = normalizeXp({ total: -40, recent: { task: 'x' }, log: [{ kind: 'evil', at: 1 }, null], byDevice: [1, 2], daily: 'x', red: { '': 5 } });
  assert.deepEqual([s.total, s.recent.task, s.log, s.byDevice, s.daily, s.red], [0, [], [], {}, {}, {}]);
});

test('award never mutates the state it was given', () => {
  const s = markRed(normalizeXp({ total: 50 }), 'reef', T0);
  const copy = JSON.stringify(s);
  award(s, 'deploy', T0);
  award(s, 'tests', T0, { project: 'reef' });
  award(s, 'ship', T0, { project: 'reef', streak: 30 });
  assert.equal(JSON.stringify(s), copy);
});

test('classifyCommand: tests, pushes and deploys across ecosystems', () => {
  const cases = {
    'npm test': 'tests', 'npm run test:unit': 'tests', 'pnpm test -- --watch=false': 'tests', 'node --test test/': 'tests',
    'pytest -q': 'tests', 'python -m pytest tests': 'tests', 'go test ./...': 'tests', 'cargo test': 'tests',
    'dotnet test': 'tests', 'npx vitest run': 'tests', 'npx playwright test': 'tests', './gradlew test': 'tests',
    'git push': 'ship', 'git push -u origin feat/x': 'ship',
    'vercel --prod': 'deploy', 'vercel deploy --prod': 'deploy', 'npx wrangler deploy': 'deploy', 'fly deploy': 'deploy',
    'gh release create v1.2.0': 'deploy', 'npm publish': 'deploy', 'kubectl apply -f k8s/': 'deploy', 'terraform apply -auto-approve': 'deploy',
    'cd app && npm test && git push': 'ship',
    'ls -la': null, 'echo test': null, 'cat test.txt': null, 'git status': null, 'npm install': null, '': null,
    'git push --dry-run': null, 'npm publish --dry-run': null,
  };
  for (const [cmd, want] of Object.entries(cases)) assert.equal(classifyCommand(cmd), want, cmd);
  assert.equal(classifyCommand(null), null);
});

test('titles, badge colours and shells keep coming all the way to 99', () => {
  assert.equal(levelFor(xpForLevel(99)).title, 'Shellby Supreme');
  assert.equal(levelFor(xpForLevel(50)).rank.name, 'Amethyst');
  // never more than 5 levels without something new
  const levels = [1, ...new Set(UNLOCKS.map(u => u.level)), 99];
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] - levels[i - 1] <= 5, `gap ${levels[i - 1]} -> ${levels[i]}`);
  assert.deepEqual(TITLES.map(t => t[0]), [...TITLES.map(t => t[0])].sort((a, b) => a - b));
  assert.deepEqual(unlocksBetween(29, 30).map(u => u.kind).sort(), ['rank', 'shell', 'title']);
  assert.deepEqual(unlocksBetween(20, 21), []);
  assert.equal(nextUnlock(20).level, 25);
  assert.equal(nextUnlock(99), null);
});

// What's in the gist has always been through a merge: nothing pending.
const gist = (...sides) => sides.reduce((g, s) => ({ ...mergeXpCounts(g, s), legacyPending: false }), {});

test('each PC keeps its own count; sync adds PCs and never counts one twice', () => {
  let a = withDevice(normalizeXp({ total: 300 }), 'pc-aaaa');
  assert.deepEqual(a.byDevice, { legacy: 300 });
  assert.equal(a.legacyPending, true, 'an upgraded total is pending until it syncs');
  assert.equal(withDevice(a, 'pc-bbbb').device, 'pc-aaaa', 'a PC keeps the id it was given');
  a = award(a, 'deploy', T0).state;
  let b = withDevice(normalizeXp({ total: 300 }), 'pc-bbbb');
  b = award(b, 'ship', T0, { project: 'x' }).state;
  const m = gist(a, b);
  assert.deepEqual(m.byDevice, { legacy: 300, 'pc-aaaa': 50, 'pc-bbbb': 60 });
  assert.equal(m.total, 410);
  assert.deepEqual(mergeXpCounts(m, m).byDevice, m.byDevice, 'merging again changes nothing');
  assert.deepEqual(mergeXpCounts(m, a).byDevice, m.byDevice, "a PC that hasn't synced yet adds nothing already there");
  // An older Shellby that only knows a total is neither lost nor counted twice.
  assert.equal(mergeXpCounts(m, { total: 410 }).total, 410);
  assert.equal(mergeXpCounts(m, { total: 500 }).total, 500);
  assert.equal(mergeXpCounts({ byDevice: { 'pc-aaaa': -5, '../x': 9, legacy: 'lots' } }, null).total, 0);
  assert.equal(mergeXpCounts({ byDevice: { constructor: 40 } }, { byDevice: { 'pc-aaaa': 10 } }).total, 50, 'a key named like an Object method still counts');
});

test('a PC that upgrades after an older Shellby synced in newer XP does not count it twice', () => {
  // A upgrades first and earns 500 on top of the shared 1000.
  let a = withDevice(normalizeXp({ total: 1000 }), 'pc-aaaa');
  a = { ...a, byDevice: { ...a.byDevice, 'pc-aaaa': 500 }, total: 1500 };
  const g = gist(a);
  // B, still on an older Shellby, max-merged that into one total of 1500 (plus 100 of its own), then upgrades.
  const b = withDevice(normalizeXp({ total: 1600 }), 'pc-bbbb');
  const m = gist(g, b);
  assert.deepEqual(m.byDevice, { legacy: 1100, 'pc-aaaa': 500 });
  assert.equal(m.total, 1600);
  // Both sides settled: syncing again changes nothing.
  assert.deepEqual(gist(m, { ...b, ...m, legacyPending: false }).total, 1600);
});

test('XP earned before the PC had an id moves to it', () => {
  const s = award(normalizeXp(null), 'deploy', T0).state;
  assert.deepEqual(s.byDevice, { local: 50 });
  assert.deepEqual(withDevice(s, 'pc-cccc').byDevice, { 'pc-cccc': 50 });
});

test('tests that failed and now pass are worth more, once', () => {
  const red = markRed(null, 'reef', T0);
  const r = award(red, 'tests', T0 + 5 * MIN, { project: 'reef' });
  assert.equal(r.kind, 'fixed');
  assert.equal(r.gained - r.bounties.reduce((n, b) => n + b.xp, 0), AWARDS.fixed.xp);
  assert.equal(r.state.log.find(e => e.kind === 'fixed').xp, AWARDS.fixed.xp);
  assert.equal(award(r.state, 'tests', T0 + 6 * MIN, { project: 'reef' }).kind, 'tests');
  assert.equal(award(red, 'tests', T0 + 5 * MIN, { project: 'other' }).kind, 'tests');
  assert.equal(award(red, 'tests', T0 + DAY + MIN, { project: 'reef' }).kind, 'tests', 'a day-old failure has gone stale');
});

test('the first push of the day to a project pays a bonus', () => {
  const one = award(null, 'ship', T0, { project: 'reef' });
  assert.equal(one.gained, 60);
  assert.match(one.state.log[0].bonus, /first push today/);
  assert.equal(award(one.state, 'ship', T0 + MIN, { project: 'reef' }).gained, 40);
  assert.equal(award(one.state, 'ship', T0 + MIN, { project: 'kelp' }).gained, 60);
  assert.equal(award(one.state, 'ship', T0 + DAY, { project: 'reef' }).gained, 60);
});

test('a streak multiplies XP: +5% a week, at most +25%', () => {
  assert.deepEqual([0, 6, 7, 14, 35, 400].map(streakMultiplier), [1, 1, 1.05, 1.1, 1.25, 1.25]);
  const r = award(null, 'trick', T0, { streak: 14 });
  assert.equal(r.gained, 165);
  assert.match(r.state.log[0].bonus, /×1\.10 streak/);
});

test('coming back after a few days away doubles XP until the rested pool is spent', () => {
  const s = award(null, 'task', T0).state;
  const back = T0 + 4 * DAY;
  const r = award(s, 'trick', back);
  assert.equal(r.gained, 300);
  assert.equal(xpSummary(s, back).rested, 150, 'the card shows it waiting');
  assert.equal(award(r.state, 'deploy', back + MIN).gained, 50, 'the 150 pool went on the trick');
  assert.equal(award(s, 'task', T0 + DAY).gained, 10, 'a day away is not a break');
});

test('daily bounties: progress, completion XP and the clear-all bonus land in the log', () => {
  let t = T0;
  while (!pickFor(dayKey(t)).some(id => id.startsWith('focus'))) t += DAY;
  const ids = pickFor(dayKey(t));
  let s = markRed(null, 'p1', t);
  const events = [['focus'], ['focus'], ['tests', 'p1'], ['tests', 'p2'], ['tests', 'p3'], ['deploy']];
  for (let i = 0; i < 30; i++) events.push(['task']);
  for (let i = 0; i < 3; i++) events.push(['ship', `p${i}`]);
  let bountyXp = 0;
  events.forEach(([kind, project], i) => {
    const r = award(s, kind, t + i * MIN, { project });
    s = r.state;
    bountyXp += r.bounties.reduce((n, b) => n + b.xp, 0);
  });
  const want = ids.reduce((n, id) => n + BOUNTIES.find(b => b.id === id).xp, 0) + CLEAR_ALL_XP;
  assert.equal(bountyXp, want);
  const v = xpSummary(s, t + HOUR);
  assert.equal(v.bounties.cleared, true);
  assert.ok(v.bounties.list.every(b => b.done && b.count === b.goal));
  assert.ok(s.log.some(e => e.kind === 'bounty'));
  assert.equal(xpSummary(s, t + DAY).bounties.cleared, false, 'tomorrow is a fresh set');
});

test('xpSummary: next unlock, a 30-day history, XP by kind and the ways to earn', () => {
  let s = null;
  for (let i = 0; i < 3; i++) s = award(s, 'deploy', T0 + i * DAY).state;
  const v = xpSummary(s, T0 + 2 * DAY, 7);
  assert.equal(v.daily.length, 30);
  assert.equal(v.daily[29].xp, 50);
  assert.equal(v.daily.filter(d => d.xp).length, 3);
  assert.equal(v.byKind.find(k => k.kind === 'deploy').xp, 150);
  assert.deepEqual(v.unlock.unlocks.map(u => u.name), ['Snail Shell', 'Shell Seeker']);
  assert.equal(v.unlock.xpToGo, s.total < 250 ? 250 - s.total : 0);
  assert.equal(v.streak.multiplier, 1.05);
  assert.deepEqual(v.ways.map(w => w.kind), Object.keys(AWARDS));
});
