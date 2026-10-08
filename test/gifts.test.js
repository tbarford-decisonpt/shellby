const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../src/main/gifts');

const T0 = new Date(2026, 9, 3, 12, 0, 0).getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const never = () => 0.999999; // a rand that always misses
const always = () => 0;       // ...and one that always hits (and picks the first)

test('every find is drawable and has a home', () => {
  const ids = new Set();
  for (const f of g.FINDS) {
    assert.ok(/^[a-z0-9-]+$/.test(f.id) && !ids.has(f.id), f.id);
    ids.add(f.id);
    assert.ok(g.RARITY[f.rarity], `${f.id} rarity`);
    assert.ok(f.name.length <= 24 && f.blurb.length <= 80, `${f.id} text`);
    const w = f.pixels[0].length;
    for (const row of f.pixels) {
      assert.equal(row.length, w, `${f.id} rows are one width`);
      for (const ch of row) assert.ok(ch === '.' || f.palette[ch], `${f.id} uses an undefined colour '${ch}'`);
    }
    assert.ok(f.pixels.length <= 8 && w <= 8, `${f.id} fits his claw`);
  }
  for (const set of g.SETS) assert.ok(set.members.length >= 4, `${set.id} has enough to collect`);
});

test('his first dig always turns something up', () => {
  const r = g.dig(null, {}, T0, never);
  assert.ok(r.find);
  assert.ok(r.isNew);
  assert.equal(g.total(r.state), 1);
});

test('after that, most digs come up empty, and a dry spell always ends', () => {
  let s = g.dig(null, {}, T0, never).state;
  let t = T0 + HOUR;
  const results = [];
  for (let i = 0; i < g.DRY_SPELL; i++) {
    const r = g.dig(s, {}, t, never);
    results.push(!!r.find);
    s = r.state;
    t += 30 * MINUTE;
  }
  assert.deepEqual(results.slice(0, -1), Array(g.DRY_SPELL - 1).fill(false));
  assert.equal(results.at(-1), true, 'the sixth empty-handed dig finds something');
});

test('idle finds have a gap and a daily cap; the manual dig is on top of them', () => {
  let s = g.dig(null, {}, T0, always).state;
  assert.equal(g.dig(s, {}, T0 + 5 * MINUTE, always).find, null, 'too soon after the last one');
  let t = T0;
  let found = 1;
  for (let i = 0; i < 12; i++) {
    t += 25 * MINUTE;
    const r = g.dig(s, {}, t, always);
    if (r.find) found++;
    s = r.state;
  }
  assert.equal(found, g.DAILY_CAP);
  const manual = g.dig(s, { manual: true }, t + MINUTE, never);
  assert.ok(manual.find, 'the manual dig always finds something');
  assert.equal(g.dig(manual.state, { manual: true }, t + 2 * MINUTE, never).find, null, 'on its own cooldown');
  assert.equal(g.canDig(manual.state, t + MINUTE + g.MANUAL_EVERY), true);
  // A new day resets the cap.
  const tomorrow = new Date(2026, 9, 4, 12).getTime();
  assert.ok(g.dig(s, {}, tomorrow, always).find);
});

test('seasonal finds only in season, night finds only at night, legendaries only later', () => {
  const ids = ctx => new Set(g.eligible(g.normalize(null), ctx).map(f => f.id));
  assert.ok(!ids({}).has('candy-corn'));
  assert.ok(ids({ seasons: ['halloween'] }).has('candy-corn'));
  assert.ok(!ids({}).has('moon-shell'));
  assert.ok(ids({ night: true }).has('moon-shell'));
  assert.ok(!ids({}).has('gold-doubloon'), 'no legendary on the first day');
  const seasoned = { items: Object.fromEntries(g.FINDS.slice(0, g.LEGENDARY_AFTER).map(f => [f.id, { n: 1, first: T0, last: T0 }])) };
  assert.ok(new Set(g.eligible(g.normalize(seasoned), {}).map(f => f.id)).has('gold-doubloon'));
  assert.ok(![...ids({ seasons: ['halloween'], night: true })].some(id => g.findById(id).special), 'keepsakes never turn up by digging');
});

test('keepsakes come once a year on their day', () => {
  const r = g.keepsake(null, 'birthday', T0);
  assert.equal(r.find.id, 'cake-slice');
  assert.equal(g.keepsake(r.state, 'birthday', T0 + HOUR).find, null);
  const nextYear = new Date(2027, 9, 3, 12).getTime();
  assert.equal(g.keepsake(r.state, 'birthday', nextYear).find.id, 'cake-slice');
  assert.equal(g.keepsake(r.state, 'nonsense', T0).find, null);
});

test('finishing a set is reported once, by the find that finished it', () => {
  const glass = g.SETS.find(s => s.id === 'sea-glass');
  const items = Object.fromEntries(glass.members.slice(0, -1).map(id => [id, { n: 1, first: T0, last: T0 }]));
  items.pebble = { n: 1, first: T0, last: T0 };
  const lastOne = glass.members.at(-1);
  // A rand that lands exactly on the missing piece of glass.
  const s = g.normalize({ items, lastFindAt: 0 });
  const pool = g.eligible(s, {});
  const weights = pool.map(f => g.RARITY[f.rarity].weight * (s.items[f.id] ? 1 : 2));
  const sum = weights.reduce((a, b) => a + b, 0);
  const before = weights.slice(0, pool.findIndex(f => f.id === lastOne)).reduce((a, b) => a + b, 0);
  const r = g.dig(s, { manual: true }, T0, () => (before + 0.01) / sum);
  assert.equal(r.find.id, lastOne);
  assert.deepEqual(r.completed, ['sea-glass']);
  const v = g.view(r.state, T0);
  assert.equal(v.sets.find(x => x.id === 'sea-glass').done, true);
});

test('the shelf hides what you have not found, but says when to look for keepsakes and seasonals', () => {
  const r = g.dig(null, {}, T0, always);
  const v = g.view(r.state, T0, { seasons: [] });
  assert.equal(v.total, 1);
  assert.equal(v.of, g.FINDS.length);
  const owned = v.finds.find(f => f.owned);
  assert.notEqual(owned.name, '???');
  const legendary = v.finds.find(f => f.id === 'black-pearl');
  assert.equal(legendary.name, '???');
  assert.match(legendary.blurb, /Legendary/);
  assert.match(v.finds.find(f => f.id === 'candy-corn').blurb, /Spooky Season/);
  assert.equal(v.finds.find(f => f.id === 'cake-slice').name, 'Birthday cake');
  assert.deepEqual(v.unseen, [owned.id]);
  assert.deepEqual(g.markSeen(r.state).unseen, []);
});

test('his favourite is the one you chose, else the rarest', () => {
  const items = { pebble: { n: 3, first: T0, last: T0 }, pearl: { n: 1, first: T0, last: T0 - HOUR } };
  assert.equal(g.favourite({ items }).id, 'pearl');
  const chosen = g.setFavourite({ items }, 'pebble');
  assert.equal(g.favourite(chosen).id, 'pebble');
  assert.equal(g.setFavourite({ items }, 'gold-doubloon').favourite, null, "can't pick what you haven't got");
  assert.equal(g.favourite(null), null);
});

test('his line when he hands it over fits the bubble', () => {
  for (const f of g.FINDS) {
    for (const r of [0, 0.5, 0.99]) {
      const line = g.foundLine(f, () => r);
      assert.ok(line && line.length <= 24, `${f.id}: "${line}"`);
    }
  }
  assert.equal(g.foundLine(g.findById('ammonite'), () => 0), 'an ammonite fossil!!');
  assert.equal(g.foundLine(g.findById('pebble'), () => 0), 'a smooth pebble!');
});

test('the After dark set only turns up at night', () => {
  const night = g.SETS.find(s => s.id === 'night');
  const day = new Set(g.eligible(g.normalize(null), {}).map(f => f.id));
  assert.ok(night.members.every(id => g.findById(id).night && !day.has(id)));
});

test('junk from disk is tolerated', () => {
  const s = g.normalize({ items: { nope: { n: 3 }, pebble: { n: -1 }, pearl: { n: 2, first: 'x' } }, favourite: 'nope', unseen: ['nope', 'pearl'], specials: ['birthday:2026', 'bad'] });
  assert.deepEqual(Object.keys(s.items), ['pearl']);
  assert.equal(s.favourite, null);
  assert.deepEqual(s.unseen, ['pearl']);
  assert.deepEqual(s.specials, ['birthday:2026']);
});

const ev = require('../src/main/events');

test('every tide event\'s finds are its own, in the Tide chest, and named like the event', () => {
  for (const e of ev.EVENTS) {
    assert.equal(g.EVENT_NAMES[e.id], e.name, `${e.id} name matches events.js`);
    for (const id of e.finds) {
      const f = g.findById(id);
      assert.ok(f, `${id} exists`);
      assert.equal(f.event, e.id);
      assert.equal(f.set, 'tides');
    }
  }
  assert.equal(g.FINDS.filter(f => f.event).length, ev.EVENTS.length * 2);
});

test('event finds only turn up while their event is on', () => {
  const off = g.eligible(g.normalize(null), {});
  assert.ok(!off.some(f => f.event));
  const on = g.eligible(g.normalize(null), { event: 'haunting' });
  assert.deepEqual(on.filter(f => f.event).map(f => f.id).sort(), ['cursed-doubloon', 'ghost-lantern']);
});

test('a sparkly find is counted apart, and the first one says so', () => {
  let r = g.dig(null, {}, T0, always);
  assert.equal(r.shiny, true);
  assert.equal(r.firstShiny, true);
  assert.equal(r.state.items[r.find.id].shiny, 1);
  assert.equal(g.sparkles(r.state), 1);
  r = g.dig(null, {}, T0, never);
  assert.equal(r.shiny, false);
  assert.equal(r.state.items[r.find.id].shiny, undefined);
  const v = g.view(g.normalize({ items: { pebble: { n: 2, first: T0, last: T0, shiny: 1, shinyFirst: T0 } } }), T0);
  const pebble = v.finds.find(f => f.id === 'pebble');
  assert.equal(pebble.shiny, 1);
  assert.ok(pebble.shinyArt && pebble.shinyArt.palette.a !== pebble.palette.a, 'drawn in its own colours');
  assert.equal(v.sparkles, 1);
});

test('the sparkle odds: 1 in 128, raised by an event but never past 4×', () => {
  const rollAt = x => {
    let first = true;
    // The first roll is the pick, the second the sparkle.
    return () => { if (first) { first = false; return 0; } return x; };
  };
  assert.equal(g.dig(null, {}, T0, rollAt(g.SPARKLE_CHANCE * 0.99)).shiny, true);
  assert.equal(g.dig(null, {}, T0, rollAt(g.SPARKLE_CHANCE * 1.01)).shiny, false);
  assert.equal(g.dig(null, { shinyBoost: 2 }, T0, rollAt(g.SPARKLE_CHANCE * 1.9)).shiny, true);
  assert.equal(g.dig(null, { shinyBoost: 99 }, T0, rollAt(g.SPARKLE_CHANCE * 4.1)).shiny, false);
});

test('copies set aside for a swap never outnumber the copies', () => {
  const s = g.normalize({ items: { pebble: { n: 2, held: 5, shiny: 9 } } });
  assert.equal(s.items.pebble.held, 2);
  assert.equal(s.items.pebble.shiny, 2);
});
