// His tank on the calling card (opt-in), a friend's tank to peek at, and the
// tank in the private sync gist: src/main/tank/share.js and where it plugs into
// github/card.js and github/sync.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/main/tank/share');
const T = require('../src/main/tank');
const { cleanCard, lookOf } = require('../src/main/github/card');
const sync = require('../src/main/github/sync');
const gifts = require('../src/main/gifts');
const builtinDecor = require('../src/wardrobe/tank-decor.json').decor;

const piece = (ref, extra = {}) => ({ ref, x: 10, row: 1, z: 0, flip: false, ...extra });
const shared = (placed, extra = {}) => ({ size: 'nano', style: { substrate: 'gravel', backdrop: 'rock-wall', light: 'night' }, placed, editedAt: 5, shareCard: true, ...extra });
// Wardrobe#decorView's shape, from the built-in pack: some locked here, which a peek ignores.
const decorView = builtinDecor.map(d => ({ ...d, key: d.id, frames: d.frames || [], spots: d.spots || [], locked: d.unlock ? { reason: 'achievement', text: 'Not yet' } : null, isNew: false }));

// ------------------------------------------------------------------ your card

test('forCard: nothing unless you share it, and nothing for an empty tank', () => {
  assert.equal(S.forCard({ placed: [piece('castle-keep')] }), null, 'off by default');
  assert.equal(S.forCard(shared([])), null);
  assert.equal(S.forCard(null), null);
});

test('forCard: built-in decor and finds only, as ref, x, row and flip', () => {
  const c = S.forCard(shared([
    piece('castle-keep', { row: 0, flip: true }), piece('find:pebble', { row: 2 }), piece('my-pack/arch'), piece('jar:nullfish'), piece('kelp', { row: 1 }),
  ], { style: { substrate: 'my-pack/glitter', backdrop: 'rock-wall', light: 'night' } }));
  assert.deepEqual(c.placed, [
    { ref: 'castle-keep', x: 10, row: 0, flip: true },
    { ref: 'kelp', x: 10, row: 1, flip: false },
    { ref: 'find:pebble', x: 10, row: 2, flip: false },
  ], 'in paint order, no pack decor or specimen jars');
  assert.deepEqual(c.style, { substrate: null, backdrop: 'rock-wall', light: 'night' }, 'a pack floor stays home');
  assert.equal(c.size, 'nano');
  const json = JSON.stringify(c);
  for (const leak of ['uid', 'editedAt', 'shareCard', 'my-pack', 'jar:', 'palette', 'pixels']) assert.ok(!json.includes(leak), `no ${leak} on the card`);
});

test('forCard: at most CARD_MAX pieces', () => {
  const many = Array.from({ length: 60 }, (_, i) => piece('rock-round', { x: i }));
  assert.equal(S.forCard(shared(many, { size: 'grand' })).placed.length, S.CARD_MAX);
});

// ------------------------------------------------------------------ a friend's card

test('cleanCardTank: a hostile card comes out safe or not at all', () => {
  for (const junk of [null, 'tank', 42, [], {}, { size: 'nano' }, { size: 'mansion', placed: [piece('castle-keep')] }, { size: 'nano', placed: 'lots' }, { size: '__proto__', placed: [] }]) {
    assert.equal(S.cleanCardTank(junk), null, JSON.stringify(junk));
  }
  const c = S.cleanCardTank({
    size: 'nano',
    style: { substrate: 'https://evil.example/x.png', backdrop: 'C:\\Windows\\win.ini', light: '<script>' },
    placed: [
      { ref: 'castle-keep', x: 4, row: 0, flip: 'yes', extra: 'nope', palette: { a: 'url(javascript:1)' } },
      { ref: '<img src=x onerror=alert(1)>', x: 1, row: 1 },
      { ref: 'file:///C:/secret', x: 1, row: 1 },
      { ref: '../../etc/passwd', x: 1, row: 1 },
      { ref: 'https://evil.example', x: 1, row: 1 },
      { ref: 'my-pack/arch', x: 1, row: 1 },
      { ref: 'jar:nullfish', x: 1, row: 1 },
      { ref: 'find:pebble', x: 1.5, row: 1 },
      { ref: 'find:pebble', x: -1, row: 1 },
      { ref: 'find:pebble', x: 96, row: 1 },
      { ref: 'find:pebble', x: 1, row: 3 },
      { ref: 'find:pebble', x: 1, row: '1' },
      { ref: 'find:pebble', x: 95, row: 2 },
      { ref: 'a'.repeat(41), x: 1, row: 1 },
      null, 'castle-keep',
    ],
  });
  assert.deepEqual(c, {
    size: 'nano',
    style: { substrate: null, backdrop: null, light: 'clock' },
    placed: [{ ref: 'castle-keep', x: 4, row: 0, flip: false }, { ref: 'find:pebble', x: 95, row: 2, flip: false }],
  });
});

test('cleanCardTank: an oversized list is cut to CARD_MAX before anything else', () => {
  const c = S.cleanCardTank({ size: 'grand', placed: Array.from({ length: 10000 }, () => ({ ref: 'rock-round', x: 1, row: 1 })) });
  assert.equal(c.placed.length, S.CARD_MAX);
});

test('cleanCard: the tank field rides along cleaned, and a change to it republishes the card', () => {
  const card = { login: 'alex', level: 3, outfit: {}, tank: S.forCard(shared([piece('castle-keep')])) };
  assert.deepEqual(cleanCard(card).tank, card.tank);
  assert.equal(cleanCard({ ...card, tank: { size: 'nano', placed: [{ ref: '<b>', x: 1, row: 1 }] } }).tank, null);
  assert.equal(cleanCard({ login: 'alex' }).tank, null, 'an older card has none');
  const moved = { ...card, tank: S.forCard(shared([piece('castle-keep', { x: 30 })])) };
  assert.notEqual(lookOf(card), lookOf(moved));
});

test('peekView: their layout with this PC\'s art, locks ignored, unknown pieces as a plain rock', () => {
  const v = S.peekView({
    size: 'ten-gallon', style: { substrate: 'gravel', backdrop: 'no-such-wall', light: 'day' },
    placed: [
      { ref: 'sunken-chest', x: 20, row: 2, flip: true }, // locked on this PC: still theirs
      { ref: 'castle-keep', x: 40, row: 0 },
      { ref: 'decor-from-the-future', x: 60, row: 1 },
      { ref: 'find:pebble', x: 80, row: 2 },
      { ref: 'find:not-a-real-find', x: 90, row: 2 },
      { ref: 'gravel', x: 5, row: 1 }, // a floor isn't a piece
    ],
  }, { decor: decorView, finds: gifts.FINDS });
  assert.equal(v.size.id, 'ten-gallon');
  assert.equal(v.strangers, 3);
  assert.deepEqual(v.pieces.map(p => p.ref).sort(), ['castle-keep', 'find:pebble', S.STAND_IN, S.STAND_IN, S.STAND_IN, 'sunken-chest'].sort());
  assert.equal(v.pieces.find(p => p.ref === 'sunken-chest').flip, true);
  assert.equal(v.style.substrate.ref, 'gravel');
  assert.equal(v.style.backdrop.ref, T.DEFAULT_STYLE.backdrop, 'an unknown back glass is the plain one');
  assert.equal(v.style.light, 'day');
  for (const p of v.pieces) for (const c of Object.values(p.palette)) assert.match(c, /^#[0-9a-f]{6}$/i, 'only colours from this PC\'s own art');
  assert.equal('tray' in v, false, 'no need to send the whole tray');
  assert.equal(S.peekView({ size: 'nano', placed: [] }, { decor: decorView, finds: gifts.FINDS }), null);
});

test('peekView: pack decor on this PC never stands in for a friend\'s ref', () => {
  const v = S.peekView({ size: 'nano', placed: [{ ref: 'castle-keep', x: 1, row: 1 }] }, {
    decor: [{ key: 'evil/castle-keep', name: 'Evil', category: 'structure', palette: { a: '#000000' }, pixels: ['a'] }, ...decorView], finds: [],
  });
  assert.equal(v.pieces[0].name, 'Sandcastle Keep');
});

// ------------------------------------------------------------------ the sync gist

test('sync: the newer tank wins whole, and sharing stays on each PC', () => {
  const pc1 = { tank: shared([piece('castle-keep')], { editedAt: 100, shareCard: true }) };
  const pc2 = { tank: { size: 'ten-gallon', style: {}, placed: [piece('kelp'), piece('find:pebble')], editedAt: 200, shareCard: false } };
  const snap1 = sync.snapshot(k => pc1[k]), snap2 = sync.snapshot(k => pc2[k]);
  assert.equal('shareCard' in snap1.tank, false, 'whether it\'s on your card never leaves the PC');
  const merged = sync.merge(snap1, snap2);
  assert.equal(merged.tank.editedAt, 200);
  assert.deepEqual(merged.tank.placed.map(p => p.ref), ['kelp', 'find:pebble']);
  assert.deepEqual(sync.merge(snap2, snap1), merged, 'either way round');
  const patch = sync.patchFor(merged, k => pc1[k]);
  assert.equal(patch.tank.size, 'ten-gallon');
  assert.equal(patch.tank.shareCard, true, 'pc1 still shares');
  assert.equal('tank' in sync.patchFor(merged, k => pc2[k]), false, 'pc2 had the newest already: nothing to write');
});

test('sync: an older Shellby\'s gist without a tank changes nothing', () => {
  const pc = { tank: shared([piece('castle-keep')], { editedAt: 100 }) };
  const merged = sync.merge(sync.snapshot(k => pc[k]), { format: 1 });
  assert.equal(merged.tank.editedAt, 100);
  assert.equal('tank' in sync.patchFor(merged, k => pc[k]), false);
});

test('sync: a hostile tank in the gist is cleaned like one on disk', () => {
  const evil = { tank: { size: 'nano', style: { substrate: 'javascript:alert(1)', light: 'disco' }, placed: [{ ref: '<script>', x: 1 }, { ref: 'castle-keep', x: 1e9, row: 7, z: -5 }, ...Array(500).fill(piece('rock-round'))], editedAt: 1e15, shareCard: true } };
  const c = sync.clean(evil);
  assert.equal(c.tank.style.substrate, null);
  assert.equal(c.tank.style.light, 'clock');
  assert.ok(c.tank.placed.length <= T.HARD_CAP);
  assert.equal(c.tank.placed.some(p => p.ref === '<script>'), false);
  assert.equal('shareCard' in c.tank, false, 'another PC can\'t turn sharing on here');
  const patch = sync.patchFor(sync.merge({}, evil), () => ({ shareCard: false }));
  assert.equal(patch.tank.shareCard, false);
});

test('applySync and merge never mutate what they are given', () => {
  const a = Object.freeze({ size: 'nano', placed: Object.freeze([Object.freeze(piece('castle-keep'))]), editedAt: 1 });
  const b = Object.freeze({ size: 'nano', placed: Object.freeze([]), editedAt: 2 });
  assert.doesNotThrow(() => S.applySync(a, S.merge(a, b)));
  assert.equal(S.applySync(a, S.merge(a, b)).placed.length, 0);
});
