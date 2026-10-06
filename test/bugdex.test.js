const { test } = require('node:test');
const assert = require('node:assert/strict');
const b = require('../src/main/bugdex');
const life = require('../src/main/bugdex/lifecycle');
const art = require('../src/main/bugdex/art');
const { SPECIES, HABITATS, live, speciesById } = require('../src/main/bugdex/species');

const T0 = new Date(2026, 9, 6, 12, 0, 0).getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const P = 'a1b2c3d4e5f6';
const Q = 'f6e5d4c3b2a1';
const FP = 'abcdefabcdef';
const never = () => 0.99;
const enc = (over = {}) => ({ species: 'nullfish', fp: FP, project: P, name: 'shellby', source: 'bash', keys: ['111111111111'], kind: 'run', ...over });
const catchOf = (over = {}) => ({ species: 'nullfish', fp: FP, project: P, firstAt: T0, device: 'pc-one', rand: never, ...over });

test('normalize turns garbage into a valid empty book', () => {
  for (const raw of [null, 7, 'x', [], { species: { nope: {}, __proto__: { x: 1 } }, open: [{}], log: [null] }]) {
    const s = b.normalize(raw);
    assert.deepEqual(s.species, {});
    assert.deepEqual(s.open, []);
    assert.deepEqual(s.log, []);
  }
});

test('seeing a bug opens one encounter per bug and project, and pays nothing', () => {
  let r = b.spot(null, enc(), T0);
  assert.ok(r.isNew);
  r = b.spot(r.state, enc(), T0 + MINUTE);
  assert.ok(!r.isNew);
  assert.equal(r.state.open.length, 1);
  assert.equal(r.state.open[0].firstAt, T0);
  assert.equal(r.state.open[0].at, T0 + MINUTE);
  assert.equal(r.state.species.nullfish.seen, 2);
  assert.equal(b.caughtOf(r.state.species.nullfish), 0);
  r = b.spot(r.state, enc({ project: Q }), T0);
  assert.equal(r.state.open.length, 2);
});

test('engaging, then failing again, counts a rerun', () => {
  let s = b.spot(null, enc(), T0).state;
  s = b.engage(s, P, T0 + MINUTE);
  assert.ok(s.open[0].engaged);
  s = b.spot(s, enc(), T0 + 2 * MINUTE).state;
  assert.equal(s.open[0].reruns, 1);
});

test('candidates match by project and key only', () => {
  const s = b.spot(null, enc(), T0).state;
  assert.equal(life.candidates(s.open, { project: P, key: '111111111111' }).length, 1);
  assert.equal(life.candidates(s.open, { project: Q, key: '111111111111' }).length, 0);
  assert.equal(life.candidates(s.open, { project: P, key: '222222222222' }).length, 0);
});

test('encounters slip away after a day, and the oldest drop past the cap', () => {
  let s = b.spot(null, enc(), T0).state;
  assert.equal(b.prune(s, T0 + DAY + 1).open.length, 0);
  for (let i = 0; i < life.MAX_OPEN + 5; i++) s = b.spot(s, enc({ fp: i.toString(16).padStart(12, '0') }), T0 + i).state;
  assert.equal(s.open.length, life.MAX_OPEN);
});

test('the first catch is new, pays, and counts on this PC', () => {
  const r = b.recordCatch(null, catchOf(), T0 + 3 * MINUTE);
  assert.ok(r.counted && r.pays && r.isNew);
  assert.equal(r.stage, 1);
  assert.deepEqual(r.state.species.nullfish.byDevice, { 'pc-one': 1 });
  assert.equal(r.state.species.nullfish.fastest, 3 * MINUTE);
  assert.ok(r.forms.includes('swift'));
  assert.deepEqual(r.state.unseen, ['nullfish']);
});

test('the same bug in the same project: counted once in 12 hours, paid once a week', () => {
  let s = b.recordCatch(null, catchOf(), T0).state;
  assert.equal(b.recordCatch(s, catchOf(), T0 + HOUR).counted, false);
  const r = b.recordCatch(s, catchOf(), T0 + 13 * HOUR);
  assert.ok(r.counted && !r.pays);
  s = r.state;
  assert.ok(b.recordCatch(s, catchOf(), T0 + 8 * DAY).pays);
  // A different bug of the same species is its own catch.
  assert.ok(b.recordCatch(s, catchOf({ fp: '000000000001' }), T0 + 14 * HOUR).pays);
});

test('species and day caps', () => {
  let s = null;
  for (let i = 0; i < b.SPECIES_DAY_CAP; i++) s = b.recordCatch(s, catchOf({ fp: `00000000000${i}` }), T0 + i).state;
  assert.equal(b.recordCatch(s, catchOf({ fp: '00000000000f' }), T0 + 10).counted, false);
  const ids = live().map(x => x.id);
  let t = null;
  for (let i = 0; i < b.DAY_CAP; i++) t = b.recordCatch(t, catchOf({ species: ids[i], fp: `0000000000${String(i).padStart(2, '0')}` }), T0 + i).state;
  assert.equal(b.recordCatch(t, catchOf({ species: ids[20], fp: '0000000000ff' }), T0 + 20).counted, false);
  assert.ok(b.recordCatch(t, catchOf({ species: ids[20], fp: '0000000000ff' }), T0 + DAY).counted);
});

test('forms: first try and swift make golden; a remedy makes neither; night and shiny', () => {
  const g = b.recordCatch(null, catchOf({ firstTry: true }), T0 + MINUTE);
  assert.deepEqual(g.forms.sort(), ['first-try', 'golden', 'swift']);
  const rem = b.recordCatch(null, catchOf({ firstTry: true, remedy: true }), T0 + MINUTE);
  assert.deepEqual(rem.forms, []);
  const night = new Date(2026, 9, 6, 3, 0, 0).getTime();
  assert.ok(b.recordCatch(null, catchOf({ firstAt: night - HOUR }), night).forms.includes('nocturnal'));
  assert.ok(b.recordCatch(null, catchOf({ rand: () => 0 }), T0 + HOUR).forms.includes('shiny'));
  const ghost = b.recordCatch(null, catchOf({ species: 'flaky-phantom', seasons: ['halloween'] }), T0 + HOUR);
  assert.ok(ghost.forms.includes('spectral'));
});

test('catching enough evolves it, and the starters change their names', () => {
  let s = null;
  let evolved = 0;
  for (let i = 0; i < 5; i++) {
    const r = b.recordCatch(s, catchOf({ fp: `00000000000${i}` }), T0 + i * DAY);
    s = r.state;
    if (r.evolved) evolved = r.evolved;
  }
  assert.equal(evolved, 2);
  const v = b.view(s, T0 + 5 * DAY).species.find(x => x.id === 'nullfish');
  assert.equal(v.stage, 2);
  assert.equal(v.name, speciesById('nullfish').evolves[0]);
  assert.equal(v.baseName, 'Nullfish');
  assert.equal(v.toNext, 10);
});

test('a caught bug back within three days got away; later it is caught for good', () => {
  const s = b.recordCatch(null, catchOf(), T0).state;
  const r = b.spot(s, enc(), T0 + DAY, { device: 'pc-one' });
  assert.ok(r.escaped);
  assert.equal(b.view(r.state, T0 + DAY).species.find(x => x.id === 'nullfish').escapes, 1);
  const calm = b.view(s, T0 + 4 * DAY).species.find(x => x.id === 'nullfish');
  assert.ok(calm.forms.includes('for-good'));
  assert.ok(!b.spot(s, enc(), T0 + 4 * DAY).escaped);
});

test('finishing a habitat says so, once', () => {
  const h = HABITATS.find(x => x.id === 'nets');
  let s = null;
  let done = [];
  h.members.forEach((id, i) => {
    const r = b.recordCatch(s, catchOf({ species: id, fp: `00000000000${i}` }), T0 + i);
    s = r.state;
    done = done.concat(r.completed);
  });
  assert.deepEqual(done, ['nets']);
  assert.equal(b.view(s, T0).habitats.find(x => x.id === 'nets').done, true);
});

test('the view hides unknown art, silhouettes the seen, colours the caught', () => {
  let s = b.spot(null, enc({ species: 'shell-less-hermit' }), T0).state;
  s = b.recordCatch(s, catchOf(), T0).state;
  const v = b.view(s, T0, { names: { [P]: 'shellby' } });
  const by = id => v.species.find(x => x.id === id);
  assert.equal(by('syntax-slug').state, 'unknown');
  assert.equal(by('syntax-slug').pixels, undefined);
  assert.equal(by('syntax-slug').name, '???');
  assert.equal(by('shell-less-hermit').state, 'seen');
  assert.ok(Object.values(by('shell-less-hermit').palette).every(c => c === art.SILHOUETTE));
  assert.equal(by('nullfish').state, 'caught');
  assert.equal(by('nullfish').firstProject, 'shellby');
  assert.equal(v.caught, 1);
  assert.equal(v.seen, 2);
  assert.equal(v.of, live().length);
  assert.equal(v.loose.length, 1);
  assert.equal(v.loose[0].project, 'shellby');
  assert.ok(!v.species.some(x => x.id === 'missingno'));
});

test('the hidden one only shows once caught, and never counts toward "of"', () => {
  const s = b.recordCatch(null, catchOf({ species: 'missingno' }), T0).state;
  const v = b.view(s, T0);
  assert.ok(v.species.some(x => x.id === 'missingno' && x.state === 'caught'));
  assert.equal(v.caught, 0);
});

test('catchLine always fits in his bubble', () => {
  for (const sp of SPECIES) {
    for (const opts of [{}, { isNew: true }, { forms: ['golden'] }, { evolved: 2 }, { forms: ['shiny'] }]) {
      for (const r of [0, 0.5, 0.99]) assert.ok(b.catchLine(sp.id, { ...opts, rand: () => r }).length <= 24, sp.id);
    }
  }
});

test('favourite: the rarest caught unless one was picked', () => {
  let s = b.recordCatch(null, catchOf(), T0).state;
  s = b.recordCatch(s, catchOf({ species: 'segfault-squid', fp: '000000000009' }), T0 + 1).state;
  assert.equal(b.favourite(s), 'segfault-squid');
  assert.equal(b.favourite(b.setFavourite(s, 'nullfish')), 'nullfish');
  assert.equal(b.setFavourite(s, 'syntax-slug').favourite, null);
});

test('sync: per-PC counts take the larger and add up; merge only grows and is commutative', () => {
  const a = b.recordCatch(null, catchOf({ device: 'pc-one' }), T0).state;
  let c = b.recordCatch(null, catchOf({ device: 'pc-two', fp: '000000000002' }), T0 + HOUR).state;
  c = b.recordCatch(c, catchOf({ device: 'pc-two', fp: '000000000003' }), T0 + 2 * HOUR).state;
  const m1 = b.merge(b.syncable(a), b.syncable(c));
  const m2 = b.merge(b.syncable(c), b.syncable(a));
  assert.deepEqual(m1, m2);
  assert.deepEqual(m1.species.nullfish.byDevice, { 'pc-one': 1, 'pc-two': 2 });
  assert.equal(m1.species.nullfish.first, T0);
  const applied = b.applySync(a, m1);
  assert.equal(b.caughtOf(applied.species.nullfish), 3);
  assert.deepEqual(b.merge(m1, m1), m1);
});

test('sync never carries projects, fingerprints or open encounters; a remote local bucket is dropped', () => {
  let s = b.spot(null, enc(), T0).state;
  s = b.recordCatch(s, catchOf({ device: 'local' }), T0).state;
  const out = JSON.stringify(b.syncable(s));
  assert.ok(!out.includes(P) && !out.includes(FP) && !out.includes('open'));
  assert.deepEqual(b.normalizeSync(b.syncable(s)).species.nullfish.byDevice, {});
  assert.deepEqual(b.applySync(s, b.merge(null, null)).species.nullfish.byDevice, { local: 1 });
});

test('withDevice moves early catches onto this PC', () => {
  const s = b.recordCatch(null, catchOf({ device: 'local' }), T0).state;
  assert.deepEqual(b.withDevice(s, 'pc-one').species.nullfish.byDevice, { 'pc-one': 1 });
});

test('art: jar, stages, forms and specks stay well formed', () => {
  const ok = a => {
    const w = a.pixels[0].length;
    for (const row of a.pixels) {
      assert.equal(row.length, w);
      for (const ch of row) assert.ok(ch === '.' || a.palette[ch], `colour ${ch}`);
    }
  };
  for (const sp of SPECIES) {
    ok(art.jarArt(sp));
    for (let st = 1; st <= 4; st++) ok(art.staged(sp, st, sp.rarity));
    ok(art.golden(sp)); ok(art.shiny(sp)); ok(art.spectral(sp));
    const m = art.micro(sp);
    ok(m);
    assert.equal(m.pixels.length, 3);
    assert.ok(art.jarArt(sp).pixels[0].length <= 12 && art.jarArt(sp).pixels.length <= 12);
  }
  assert.ok(b.jarFor('nullfish'));
  assert.equal(b.jarFor('nope'), null);
});

test('poolOf lists the latest catches as specks', () => {
  let s = b.recordCatch(null, catchOf(), T0).state;
  s = b.recordCatch(s, catchOf({ species: 'syntax-slug', fp: '000000000004' }), T0 + 1).state;
  const pool = b.poolOf(s);
  assert.deepEqual(pool.map(p => p.id), ['syntax-slug', 'nullfish']);
  assert.equal(pool[0].pixels.length, 3);
});
