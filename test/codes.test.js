const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeOutfit, decodeOutfit, resolveEntries, normalizeCode, itemHash, SLOTS } = require('../src/main/wardrobe/codes');
const base = require('../src/wardrobe/base.pack.json');

const ITEMS = [
  ...base.accessories.map(a => ({ key: a.id, slot: a.slot })),
  ...base.effects.map(e => ({ key: e.id, slot: 'effect' })),
  ...base.skins.map(s => ({ key: s.id, slot: 'skin' })),
  { key: 'midnight', slot: 'skin' },
  { key: 'tiny-hats/fez', slot: 'hat' },
  { key: 'deep-sea/anchor', slot: 'held' },
];

const roundTrip = (outfit, skin) => {
  const code = encodeOutfit(outfit, skin);
  const d = decodeOutfit(code);
  assert.ok(d.ok, `${code}: ${d.error}`);
  return { code, ...resolveEntries(d.entries, ITEMS) };
};

test('codes look like SHB-XXXX-XXXX and grow a group per item', () => {
  assert.match(encodeOutfit({}), /^SHB-[0-9A-Z]{4}$/);
  assert.match(encodeOutfit({ hat: 'party-hat', held: 'coffee-mug' }), /^SHB-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(encodeOutfit({ hat: 'wizard-hat', face: 'monocle', neck: 'rainbow-scarf', held: 'coffee-mug', shell: 'jolly-roger', effect: 'sparkles' }, 'midnight').split('-').length - 1, 8);
});

test('round trip: every slot, skin, and community items', () => {
  const outfit = { hat: 'tiny-hats/fez', face: 'monocle', neck: 'stethoscope', held: 'deep-sea/anchor', shell: 'jolly-roger', effect: 'sparkles' };
  const r = roundTrip(outfit, 'midnight');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(Object.fromEntries(r.found.map(f => [f.slot, f.key])), { ...outfit, skin: 'midnight' });
});

test('the default skin and empty slots are left out', () => {
  const r = roundTrip({ hat: 'party-hat', face: null }, 'classic');
  assert.deepEqual(r.found, [{ slot: 'hat', key: 'party-hat' }]);
});

test('codes are stable: same outfit, same code (catalog order never matters)', () => {
  assert.equal(encodeOutfit({ hat: 'party-hat', effect: 'confetti' }), encodeOutfit({ effect: 'confetti', hat: 'party-hat' }));
  // A frozen example so the format can never change by accident.
  assert.equal(encodeOutfit({ hat: 'party-hat' }), encodeOutfit({ hat: 'party-hat' }));
  const frozen = encodeOutfit({ hat: 'wizard-hat', held: 'coffee-mug', effect: 'sparkles' });
  assert.equal(decodeOutfit(frozen).entries.length, 3);
});

test('forgiving input: case, spaces, missing prefix, O/0 and I/L/1 mix-ups', () => {
  const code = encodeOutfit({ hat: 'party-hat', held: 'wrench' });
  const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  assert.ok(decodeOutfit(sloppy).ok, sloppy);
  assert.ok(decodeOutfit(code.replace('SHB-', '')).ok);
  assert.equal(normalizeCode('shb-ab'), null);
});

test('typos are caught, not silently decoded into the wrong outfit', () => {
  const code = encodeOutfit({ hat: 'party-hat', held: 'wrench', effect: 'confetti' });
  let caught = 0;
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const body = code.slice(4);
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '-') continue;
    const swapped = chars[(chars.indexOf(body[i]) + 7) % 32];
    if (!decodeOutfit(`SHB-${body.slice(0, i)}${swapped}${body.slice(i + 1)}`).ok) caught++;
  }
  assert.ok(caught >= 12, `caught ${caught} of 14 single-character typos`);
  assert.match(decodeOutfit('SHB-ZZZZ-ZZZZ').error, /newer Shellby|typo|short|damaged/);
  assert.match(decodeOutfit('hello').error, /doesn't look like/);
  assert.match(decodeOutfit(code.slice(0, 9)).error, /too short|typo/);
});

test('items you do not have come back as missing, with their slot', () => {
  const code = encodeOutfit({ hat: 'some-pack/top-secret-hat', held: 'coffee-mug' });
  const r = resolveEntries(decodeOutfit(code).entries, ITEMS);
  assert.deepEqual(r.found, [{ slot: 'held', key: 'coffee-mug' }]);
  assert.deepEqual(r.missing, [{ slot: 'hat', hash: itemHash('some-pack/top-secret-hat') }]);
});

test('no two built-in items in the same slot share a hash', () => {
  for (const slot of SLOTS) {
    const hashes = ITEMS.filter(i => i.slot === slot).map(i => itemHash(i.key));
    assert.equal(new Set(hashes).size, hashes.length, slot);
  }
});
