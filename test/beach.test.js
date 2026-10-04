const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/main/beach');
const stickers = require('../src/main/stickers');
const streaks = require('../src/main/streaks');
const gifts = require('../src/main/gifts');

const at = (d, h = 12) => new Date(2026, 9, d, h).getTime(); // October 2026, local time
const NOW = at(20);

const project = (id, name, firstShipAt, ships = 1, extra = {}) => ({ name, firstShipAt, lastShipAt: firstShipAt, ships, marks: [], ...extra });
const stickerState = projects => stickers.normalize({ projects });
const streakState = (days = [], projects = {}) => streaks.normalize({ days, projects });
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const run = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => dayKey(at(from + i)));

function beach({ projects = {}, days = [], plots = {}, finds = {}, state = null } = {}) {
  return B.view({
    stickerState: stickerState(projects),
    streakState: streakState(days, plots),
    findState: gifts.normalize({ items: finds }),
    state, now: NOW,
  });
}

test('every castle is a rectangle of known colour roles, and bigger tiers make bigger castles', () => {
  const sizes = ['paper', 'vinyl', 'holo', 'foil'].map(tier => {
    const { pixels } = B.castleArt('a1b2c3d4e5f6', tier, []);
    assert.ok(pixels.every(r => r.length === pixels[0].length), `${tier} rows are all one width`);
    assert.match(pixels.join(''), /^[.sSdwpfg]+$/, `${tier} only uses colour roles`);
    assert.match(pixels.at(-1), /^S+$/, `${tier} stands on a mound`);
    return pixels[0].length * pixels.length;
  });
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] > sizes[i - 1], 'each tier is bigger than the last');
});

test('a castle looks the same every time, and different projects get different castles', () => {
  assert.deepEqual(B.castleArt('a1b2c3d4e5f6', 'holo'), B.castleArt('a1b2c3d4e5f6', 'holo'));
  const looks = new Set(['a1b2c3d4e5f6', '0123456789ab', 'ffffff000000', 'abcdefabcdef'].map(id => B.castleArt(id, 'holo').pixels.join('/')));
  assert.ok(looks.size > 1);
});

test('marks trim the castle: lit windows when live, flags on every tower once released, gold for 1.0', () => {
  const plain = B.castleArt('a1b2c3d4e5f6', 'foil', []);
  const dressed = B.castleArt('a1b2c3d4e5f6', 'foil', ['live', 'release', 'v1']);
  assert.equal(plain.lit, false);
  assert.equal(dressed.lit, true);
  const count = (art, ch) => art.pixels.join('').split(ch).length - 1;
  assert.ok(count(dressed, 'p') > count(plain, 'p'), 'more flagpoles');
  assert.equal(count(plain, 'g'), 0);
  assert.ok(count(dressed, 'g') > 0, 'a gold flag');
});

test('castles stand in the order they were first shipped, and never on top of each other in a row', () => {
  const projects = {};
  for (let i = 0; i < 9; i++) projects[`00000000000${i}`] = project(`00000000000${i}`, `p${i}`, at(1 + i), [1, 5, 15, 40][i % 4]);
  const v = beach({ projects });
  assert.deepEqual(v.castles.map(c => c.name), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
  for (const row of [0, 1]) {
    const inRow = v.castles.filter(c => c.row === row);
    for (let i = 1; i < inRow.length; i++) assert.ok(inRow[i].x >= inRow[i - 1].x + inRow[i - 1].w, `row ${row} doesn't overlap`);
  }
  assert.ok(v.castles.every(c => c.x + c.w <= v.world.width), 'everything fits on the beach');
  assert.equal(v.stats.castles, 9);
  assert.equal(v.stats.since, at(1));
});

test('the beach grows with every castle and is never narrower than its minimum', () => {
  assert.equal(beach().world.width, B.MIN_WIDTH);
  const few = beach({ projects: { '000000000001': project('a', 'a', at(1), 40), '000000000002': project('b', 'b', at(2), 40) } });
  const more = beach({ projects: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`0000000000${String(i).padStart(2, '0')}`, project('', `p${i}`, at(1 + i), 40)])) });
  assert.ok(more.world.width > few.world.width);
});

test('friends’ gift stickers are not castles on your beach', () => {
  const v = beach({ projects: { '000000000001': project('', 'mine', at(1)), '000000000002': project('', 'theirs', at(2), 1, { from: 'octocat' }) } });
  assert.deepEqual(v.castles.map(c => c.name), ['mine']);
});

test('the castle tells you how far it is from growing', () => {
  const v = beach({ projects: { '000000000001': project('', 'a', at(1), 12), '000000000002': project('', 'b', at(2), 41) } });
  assert.deepEqual(v.castles[0].next, { kind: 'Keep', left: 3 });
  assert.equal(v.castles[0].kind, 'Tower house');
  assert.equal(v.castles[1].next, null);
  assert.equal(v.castles[1].kind, 'Citadel');
});

test('the tide comes in with the streak; the high-water mark is the best and never goes down', () => {
  assert.equal(B.tideDepth(0), 3);
  assert.ok(B.tideDepth(7) > B.tideDepth(1));
  assert.ok(B.tideDepth(400) <= 13);

  const v = beach({ days: [...run(1, 10), ...run(18, 20)] });
  assert.equal(v.tide.current, 3);
  assert.equal(v.tide.best, 10);
  assert.ok(v.tide.mark > v.tide.wet, 'the seaweed is further up than today’s tide');

  // Days age out of the streak history, but the beach remembers the best.
  let state = B.observe(null, 30);
  state = B.observe(state, 10);
  assert.equal(state.highWater, 30);
  assert.equal(beach({ days: run(18, 20), state }).tide.best, 30);
});

test('finds wash up along the high-water line, oldest first', () => {
  const v = beach({ finds: { pebble: { n: 2, first: at(3), last: at(9) }, driftwood: { n: 1, first: at(1), last: at(1) } } });
  assert.deepEqual(v.finds.map(f => f.id), ['driftwood', 'pebble']);
  const line = B.SHORE + v.tide.mark;
  for (const f of v.finds) {
    assert.ok(Math.abs(f.y - line) <= 4, 'near the wrack line');
    assert.ok(f.x >= 0 && f.x < v.world.width);
    assert.ok(Array.isArray(f.pixels) && f.palette);
  }
  assert.equal(v.stats.finds, 2);
});

test('a beach full of finds keeps them apart and off the castles', () => {
  const projects = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`0000000000${String(i).padStart(2, '0')}`, project('', `p${i}`, at(1 + i), 15)]));
  const ids = gifts.FINDS.filter(f => !f.special).slice(0, 30).map(f => f.id);
  const v = beach({ projects, finds: Object.fromEntries(ids.map((id, i) => [id, { n: 1, first: at(1) + i, last: at(1) + i }])) });
  assert.equal(v.finds.length, 30);
  for (const a of v.finds) {
    for (const b of v.finds) if (a !== b && a.y === b.y) assert.ok(Math.abs(a.x - b.x) >= 9, `${a.id} and ${b.id} overlap`);
    // Nothing tall enough to hide the wrack line stands in front of a find.
    for (const c of v.castles.filter(x => x.y - x.h < a.y)) assert.ok(a.x + 8 <= c.x || a.x >= c.x + c.w, `${a.id} is behind ${c.name}`);
  }
});

test('projects you work in but haven’t shipped are plots; shipped ones are not', () => {
  const v = beach({
    projects: { '000000000001': project('', 'shipped', at(1), 1, { root: 'C:\\code\\Shipped' }) },
    plots: { 'c:\\code\\shipped': { name: 'shipped', lastSeen: at(19) }, 'c:\\code\\wip': { name: 'wip', lastSeen: at(19) } },
  });
  assert.deepEqual(v.plots.map(p => p.name), ['wip']);
  assert.equal(v.stake, null);
  assert.ok(beach().stake, 'an empty beach marks where the first castle goes');
});

test('what’s new since you last looked: new castles, castles that grew and fresh finds', () => {
  const projects = { '000000000001': project('', 'old', at(1), 15), '000000000002': project('', 'new', at(15)) };
  const first = beach({ projects });
  assert.equal(first.firstVisit, true);
  assert.equal(first.news, 0, 'nothing is "new" on a first visit');

  // Seen on the 10th, when the old one was still a tower house.
  const seen = { ...B.markSeen(null, [{ id: '000000000001', tier: 'vinyl' }], at(10)) };
  const v = beach({ projects, state: seen, finds: { pebble: { n: 1, first: at(12), last: at(12) } } });
  assert.equal(v.firstVisit, false);
  assert.deepEqual(v.castles.map(c => [c.name, c.isNew, c.grew]), [['old', false, true], ['new', true, false]]);
  assert.equal(v.finds[0].isNew, true);
  assert.equal(v.news, 3);
});

test('state from disk is cleaned', () => {
  assert.deepEqual(B.normalize({ seenAt: 'x', tiers: { nope: 'paper', '000000000001': 'gold', '000000000002': 'holo' }, highWater: -4 }),
    { seenAt: 0, tiers: { '000000000002': 'holo' }, highWater: 0 });
  assert.deepEqual(B.normalize(null), { seenAt: 0, tiers: {}, highWater: 0 });
});
