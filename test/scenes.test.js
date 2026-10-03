const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sc = require('../src/main/scenes');

const css = ['critter.css', 'life.css'].map(f => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'critter', f), 'utf8')).join('\n');
const lifeJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'critter', 'life.js'), 'utf8');

test('every scene is well formed, every line fits, every beat is drawable', () => {
  const ids = new Set();
  for (const s of sc.SCENES) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.ok(s.name && s.beats.length >= 1, s.id);
    for (const t of s.who) assert.ok(sc.TEMPERAMENTS.includes(t), `${s.id} who ${t}`);
    for (const b of s.beats) {
      assert.ok(sc.SCENE_BITS.includes(b.bit), `${s.id} uses unknown bit ${b.bit}`);
      assert.ok(b.ms >= 500 && b.ms <= 5000, `${s.id} beat length`);
      if (b.prop) assert.ok(sc.PROPS.includes(b.prop), `${s.id} prop ${b.prop}`);
      if (b.hold) assert.ok(sc.HOLDS.includes(b.hold), `${s.id} hold ${b.hold}`);
      if (b.wear) assert.ok(sc.WEARS.includes(b.wear), `${s.id} wear ${b.wear}`);
      for (const t of sc.TEMPERAMENTS) {
        for (const r of [0, 0.99]) {
          const line = sc.lineFor(b.say, t, () => r);
          if (b.say != null) assert.ok(line && line.length <= 24, `${s.id}: ${t} gets "${line}"`);
        }
      }
    }
    assert.ok(sc.lengthOf(sc.resolve(s, 'chipper')) <= 12000, `${s.id} is a scene, not a film`);
  }
});

test('every bit has an animation and every prop is drawn', () => {
  for (const bit of sc.SCENE_BITS) assert.ok(css.includes(`bit-${bit}`), `critter.css has no bit-${bit}`);
  for (const prop of sc.PROPS) assert.ok(lifeJs.includes(`'${prop}'`), `renderer life.js doesn't draw '${prop}'`);
  for (const hold of sc.HOLDS.filter(h => h !== 'find')) assert.ok(lifeJs.includes(`${hold}:`) || lifeJs.includes(`'${hold}'`), `renderer can't hold ${hold}`);
  for (const wear of sc.WEARS) assert.ok(lifeJs.includes(`${wear}:`) || lifeJs.includes(`'${wear}'`), `renderer can't wear ${wear}`);
});

test('scenes only happen when their moment is right', () => {
  const by = id => sc.SCENES.find(s => s.id === id);
  assert.equal(sc.fits(by('stargaze'), { hour: 14 }), false);
  assert.equal(sc.fits(by('stargaze'), { hour: 23 }), true);
  assert.equal(sc.fits(by('sunbathe'), { hour: 13, weekday: 3 }), false);
  assert.equal(sc.fits(by('sunbathe'), { hour: 13, weekday: 6 }), true);
  assert.equal(sc.fits(by('airguitar'), { music: false }), false);
  assert.equal(sc.fits(by('airguitar'), { music: true }), true);
  assert.equal(sc.fits(by('showfind'), { bond: 2, hasFind: false }), false);
  assert.equal(sc.fits(by('showfind'), { bond: 2, hasFind: true }), true);
  assert.equal(sc.fits(by('showfind'), { bond: 1, hasFind: true }), false);
  assert.equal(sc.fits(by('boo'), { seasons: ['halloween'] }), true);
  assert.equal(sc.fits(by('boo'), { seasons: ['winter'] }), false);
  assert.equal(sc.fits(by('pounce'), { cursorNear: false }), false);
  assert.equal(sc.fits(by('coffee'), { dayOccasion: 'monday' }), true);
});

test('picking leaves out what he just did and favours his temperament', () => {
  const ctx = { temperament: 'fussy', hour: 12, weekday: 3 };
  const all = sc.SCENES.filter(s => sc.fits(s, ctx)).map(s => s.id);
  const recent = all.slice(0, -1);
  assert.equal(sc.pickScene(ctx, recent, () => 0).id, all.at(-1));
  assert.equal(sc.pickScene(ctx, all, () => 0), null);
  const counts = {};
  for (let i = 0; i < 400; i++) { const s = sc.pickScene(ctx, [], () => i / 400); counts[s.id] = (counts[s.id] || 0) + 1; }
  assert.ok(counts.counting > counts.sneeze, 'a fussy crab counts sand more than he sneezes');
});

test('resolve settles every line for one temperament', () => {
  const s = sc.SCENES.find(x => x.id === 'pounce');
  const beats = sc.resolve(s, 'fussy', () => 0);
  assert.equal(beats.at(-1).say, 'how undignified');
  assert.equal(sc.resolve(s, 'cocky', () => 0).at(-1).say, 'meant to do that');
  assert.deepEqual(sc.resolve(null, 'cocky'), []);
});
