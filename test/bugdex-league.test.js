const { test } = require('node:test');
const assert = require('node:assert/strict');
const b = require('../src/main/bugdex');
const { SPECIES, HABITATS, LEAGUE, leagueOf, bossOf } = require('../src/main/bugdex/species');
const { LORE, loreOf } = require('../src/main/bugdex/lore');

const T0 = new Date(2026, 9, 6, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const P = 'a1b2c3d4e5f6';
const never = () => 0.99;
let n = 0;
const fp = () => (++n).toString(16).padStart(12, '0');

// Catch a species once, a day apart so no cap or cooldown gets in the way.
function caught(state, species, at) {
  return b.recordCatch(state, { species, fp: fp(), project: P, firstAt: at - 1000, device: 'pc-one', rand: never }, at);
}

test('every habitat has a boss that lives there, and a 7×7 badge', () => {
  const bosses = new Set();
  for (const h of HABITATS) {
    const sp = SPECIES.find(s => s.id === h.boss);
    assert.ok(sp, h.id);
    assert.equal(sp.habitat, h.id);
    assert.equal(bossOf(sp.id).id, h.id);
    bosses.add(h.boss);
    assert.ok(h.badge.name.endsWith('Badge'));
    assert.equal(h.badge.pixels.length, 7);
    for (const row of h.badge.pixels) {
      assert.equal(row.length, 7);
      for (const ch of row) assert.ok(ch === '.' || h.badge.palette[ch], `${h.id} ${ch}`);
    }
  }
  // The league is nobody's boss.
  for (const id of [...LEAGUE.elite, LEAGUE.champion]) {
    assert.ok(SPECIES.some(s => s.id === id), id);
    assert.ok(!bosses.has(id), id);
  }
  assert.equal(leagueOf(LEAGUE.champion), 'champion');
  assert.equal(leagueOf('nullfish'), null);
});

test('a boss\'s first catch earns its badge; a later one doesn\'t again', () => {
  const kelp = HABITATS.find(h => h.id === 'kelp');
  let r = caught(null, kelp.boss, T0);
  assert.equal(r.badge, 'kelp');
  assert.ok(r.moment);
  r = caught(r.state, kelp.boss, T0 + DAY);
  assert.equal(r.badge, null);
  const l = b.leagueView(r.state);
  const badge = l.badges.find(x => x.habitat === 'kelp');
  assert.ok(badge.earned);
  assert.equal(badge.at, T0);
  assert.deepEqual(badge.palette, kelp.badge.palette);
  assert.equal(l.earned, 1);
  assert.equal(l.open, false);
  // Unearned badges are silhouettes, and a boss you've never met has no name.
  const other = l.badges.find(x => x.habitat === 'vault');
  assert.ok(!other.earned);
  assert.ok(Object.values(other.palette).every(c => c === Object.values(other.palette)[0]));
  assert.equal(other.boss, null);
});

test('every badge, the Deep Four and the champion: the Hall of Fame, once', () => {
  let s = null;
  let at = T0;
  const ids = [...HABITATS.map(h => h.boss), ...LEAGUE.elite];
  for (const id of ids) {
    const r = caught(s, id, at += DAY);
    assert.equal(r.fame, false, id);
    s = r.state;
  }
  assert.equal(b.hallOf(s), 0);
  assert.equal(b.leagueView(s).open, true);
  const r = caught(s, LEAGUE.champion, at += DAY);
  assert.equal(r.league, 'champion');
  assert.equal(r.fame, true);
  assert.equal(b.hallOf(r.state), at);
  assert.equal(caught(r.state, LEAGUE.champion, at + DAY).fame, false);
});

test('gift jars: one a day per friend, one you don\'t have if they can, never a catch', () => {
  let s = caught(null, 'nullfish', T0).state;
  const theirs = ['nullfish', 'syntax-slug', 'missingno'];
  const g = b.giftFor(s, 'bro', theirs, T0);
  assert.equal(g, 'syntax-slug'); // the one you haven't caught
  s = b.addGift(s, { species: g, from: 'bro' }, T0);
  assert.equal(b.giftFor(s, 'bro', theirs, T0 + HOUR), null);
  assert.ok(b.giftFor(s, 'bro', theirs, T0 + DAY));
  assert.equal(b.giftFor(s, 'bro', ['missingno'], T0 + DAY), null);
  assert.equal(b.giftFor(s, 'not a login!', theirs, T0 + DAY), null);
  assert.deepEqual(b.giftCounts(s), { 'syntax-slug': 1 });
  assert.equal(b.caughtOf(b.normalize(s).species['syntax-slug']), 0);
  // Junk from disk goes.
  assert.deepEqual(b.normalize({ gifts: [{ species: 'nope', from: 'bro', at: 1 }, { species: 'nullfish', from: '<x>', at: 1 }, null] }).gifts, []);
});

test('a friend\'s report shows one you\'ve never met as a silhouette with its name', () => {
  const s = caught(null, 'nullfish', T0).state;
  const v = b.view(s, T0 + HOUR, { friends: [{ login: 'bro', bugdex: { caught: ['nullfish', 'syntax-slug', 'nope'], badges: 3 } }, { login: '???' }] });
  const slug = v.species.find(x => x.id === 'syntax-slug');
  assert.equal(slug.state, 'reported');
  assert.equal(slug.name, 'Syntax Slug');
  assert.deepEqual(slug.reportedBy, ['bro']);
  assert.ok(slug.pixels);
  assert.deepEqual(v.species.find(x => x.id === 'nullfish').reportedBy, ['bro']);
  assert.deepEqual(v.friends, [{ login: 'bro', caught: 2, badges: 3, hall: false }]);
  assert.equal(v.seen, 1); // their sighting isn't yours
  assert.equal(v.species.find(x => x.id === 'nameless-nudibranch').state, 'unknown');
});

test('a gift jar does the same for one you\'ve never met', () => {
  const s = b.addGift(null, { species: 'syntax-slug', from: 'bro' }, T0);
  const slug = b.view(s, T0).species.find(x => x.id === 'syntax-slug');
  assert.equal(slug.state, 'reported');
  assert.equal(slug.gifts, 1);
  assert.deepEqual(slug.giftFrom, ['bro']);
});

test('what your card shares: which kinds and how many badges, nothing else', () => {
  let s = caught(null, 'nullfish', T0).state;
  s = caught(s, HABITATS[0].boss, T0 + DAY).state;
  const out = b.shared(s);
  assert.deepEqual(Object.keys(out).sort(), ['badges', 'caught', 'hall']);
  assert.deepEqual(out.caught, [HABITATS[0].boss, 'nullfish'].sort());
  assert.equal(out.badges, 1);
  assert.deepEqual(b.cleanShared({ caught: ['nullfish', 'nullfish', 5, 'nope'], badges: 99, hall: 'yes' }), { caught: ['nullfish'], badges: HABITATS.length, hall: false });
});

test('every species has a field note and a tip, unlocked at stage II and III', () => {
  for (const sp of SPECIES) {
    const l = loreOf(sp.id);
    assert.ok(l?.note && l.tip, sp.id);
    assert.ok(l.note.length <= 140 && l.tip.length <= 140, sp.id);
  }
  assert.equal(Object.keys(LORE).length, SPECIES.length);
  let s = null;
  let at = T0;
  const entry = () => b.view(s, at).species.find(x => x.id === 'nullfish');
  s = caught(s, 'nullfish', at).state;
  assert.equal(entry().note, null);
  assert.equal(entry().noteIn, b.STAGES[1] - 1);
  for (let i = 1; i < b.STAGES[1]; i++) s = caught(s, 'nullfish', at += DAY).state;
  assert.equal(entry().note, loreOf('nullfish').note);
  assert.equal(entry().tip, null);
  for (let i = b.STAGES[1]; i < b.STAGES[2]; i++) s = caught(s, 'nullfish', at += DAY).state;
  assert.equal(entry().tip, loreOf('nullfish').tip);
  assert.equal(entry().tipIn, 0);
});

test('a friend\'s gift jar can go in the tank, even of a bug you haven\'t caught', () => {
  const { library } = require('../src/main/tank');
  let s = caught(null, 'nullfish', T0).state;
  s = b.addGift(s, { species: 'nullfish', from: 'bro' }, T0 + HOUR);
  s = b.addGift(s, { species: 'syntax-slug', from: 'bro' }, T0 + DAY);
  const lib = library({ bugState: s });
  assert.equal(lib.get('jar:nullfish').max, 2);
  assert.equal(lib.get('jar:syntax-slug').max, 1);
  assert.match(lib.get('jar:syntax-slug').description, /@bro/);
});
