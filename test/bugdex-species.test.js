const { test } = require('node:test');
const assert = require('node:assert/strict');
const b = require('../src/main/bugdex/species');
const { PORTRAITS } = require('../src/main/bugdex/portraits');
const { EVENTS } = require('../src/main/events');

const REMEDIES = new Set(['install', 'kill', 'service', 'lock', 'cache']);

test('every portrait is a species, drawn within 22×22 in lettered colours', () => {
  for (const [id, p] of Object.entries(PORTRAITS)) {
    assert.ok(b.speciesById(id), `portrait for an unknown species ${id}`);
    assert.ok(p.pixels.length <= 22 && p.pixels.every(r => r.length === p.pixels[0].length) && p.pixels[0].length <= 22, `${id} is at most 22×22 and square-cornered`);
    for (const [key, hex] of Object.entries(p.palette)) {
      assert.match(key, /^[A-Za-z]$/, `${id} palette key '${key}' (digits and symbols are the outline's)`);
      assert.match(hex, /^#[0-9a-f]{6}$/i, `${id} colour ${key}`);
    }
    for (const row of p.pixels) for (const ch of row) assert.ok(ch === '.' || Object.hasOwn(p.palette, ch), `${id} uses an undefined colour '${ch}'`);
    const sp = b.speciesById(id);
    assert.ok(Object.isFrozen(sp.portrait) && sp.portrait.pixels.length === p.pixels.length + 2, `${id} is inked and frozen`);
  }
});

test('every species is drawable and has a home', () => {
  const ids = new Set();
  const nos = new Set();
  const habitats = new Set(b.HABITATS.map(h => h.id));
  const events = new Set(EVENTS.map(e => e.id));
  for (const s of b.SPECIES) {
    assert.ok(/^[a-z0-9-]+$/.test(s.id) && !ids.has(s.id), s.id);
    ids.add(s.id);
    assert.ok(Number.isInteger(s.no) && !nos.has(s.no), `${s.id} dex number`);
    nos.add(s.no);
    assert.ok(s.name.length <= 24, `${s.id} name fits`);
    assert.ok(s.blurb.length <= 80, `${s.id} blurb fits`);
    assert.ok(s.hint.length <= 80, `${s.id} hint fits`);
    assert.ok(b.RARITY[s.rarity], `${s.id} rarity`);
    assert.ok(b.TYPES[s.type], `${s.id} type`);
    if (s.id === 'missingno') assert.equal(s.habitat, null);
    else if (s.event) { assert.equal(s.habitat, null, `${s.id} lives in no habitat`); assert.ok(events.has(s.event), `${s.id} event`); }
    else assert.ok(habitats.has(s.habitat), `${s.id} habitat`);
    for (const [key, hex] of Object.entries(s.palette)) {
      assert.ok(/^[^.]$/.test(key), `${s.id} palette key '${key}'`);
      assert.match(hex, /^#[0-9a-f]{6}$/i, `${s.id} colour ${key}`);
    }
    const w = s.pixels[0].length;
    for (const row of s.pixels) {
      assert.equal(row.length, w, `${s.id} rows are one width`);
      for (const ch of row) assert.ok(ch === '.' || Object.hasOwn(s.palette, ch), `${s.id} uses an undefined colour '${ch}'`);
    }
    assert.ok(s.pixels.length <= 8 && w <= 8, `${s.id} fits in the jar`);
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.pixels) && Object.isFrozen(s.palette), `${s.id} frozen`);
    assert.equal(b.speciesById(s.id), s);
  }
  assert.equal(b.speciesById('nope'), null);
  for (const [id, t] of Object.entries(b.TYPES)) assert.match(t.color, /^#[0-9a-f]{6}$/i, `${id} chip colour`);
});

test('dex numbers are pinned', () => {
  const pinned = {
    1: 'shapeshifter-shrimp', 2: 'nullfish', 3: 'nameless-nudibranch', 4: 'syntax-slug',
    5: 'off-by-one-octopus', 6: 'ouroboros-eel', 7: 'broken-promise-prawn', 8: 'heap-leviathan',
    9: 'shell-less-hermit', 10: 'locked-limpet', 11: 'clingy-barnacle', 12: 'mixed-up-mussel',
    13: 'overstuffed-pufferfish', 14: 'closed-clam', 15: 'port-squatter', 16: 'slowpoke-snail',
    17: 'snapped-line', 18: 'nameless-buoy', 19: 'border-crab', 20: 'lost-parcel-crab',
    21: 'meltdown-medusa', 22: 'two-headed-crab', 23: 'bounced-bottle', 24: 'gatekeeper-goby',
    25: 'lockfile-lobster', 26: 'red-tide', 27: 'matrix-hydra', 28: 'sunken-deploy',
    29: 'stalled-galleon', 30: 'the-kraken', 31: 'stray-module-minnow', 32: 'tangled-tree-crab',
    33: 'collapsed-castle', 34: 'lint-louse', 35: 'beached-whale', 36: 'old-salt',
    37: 'mismatched-mantis', 38: 'missing-fin-pipefish', 39: 'undeclared-urchin', 40: 'anything-anemone',
    41: 'optional-oarfish', 42: 'hinted-hermit', 43: 'type-tangle', 44: 'keyless-krill',
    45: 'wonky-whelk', 46: 'circular-sea-snake', 47: 'attribute-anglerfish', 48: 'off-value-oyster',
    49: 'zero-dab', 50: 'borrowing-hermit', 51: 'rusty-nautilus', 52: 'panicked-prawn',
    53: 'nil-gopherfish', 54: 'knotted-eels', 55: 'segfault-squid', 56: 'red-snapper',
    57: 'assertive-lobster', 58: 'mirror-mullet', 59: 'leaky-clam', 60: 'barnacled-anchor',
    61: 'cert-cuttlefish', 62: 'flaky-phantom', 63: 'heisenbug', 64: 'race-wraith',
    65: 'cache-ghoul', 66: 'zombie-process', 67: 'garbled-jellyfish', 68: 'spinning-top-shell',
    69: 'hydration-hydroid', 70: 'duplicate-dory', 71: 'tableless-turtle', 72: 'crowded-sardines',
    73: 'castaway-cod', 74: 'trampled-sand-dollar', 75: 'nowhere-narwhal', 76: 'docked-whale-shark',
    77: 'mojibake-moray', 78: 'idle-isopod', 79: 'sleepy-seahorse', 80: 'hollow-halibut',
    81: 'turned-away-turbot', 82: 'unset-sea-star', 83: 'sealed-scallop', 99: 'missingno',
    101: 'harvest-mouse', 102: 'will-o-wisp', 103: 'frost-mite', 104: 'lovebug', 105: 'dust-bunny', 106: 'tide-pool-nudibranch',
  };
  assert.deepEqual(Object.fromEntries(b.SPECIES.map(s => [s.no, s.id])), pinned);
});

test('every habitat has at least three members', () => {
  assert.equal(b.HABITATS.length, 12);
  for (const h of b.HABITATS) {
    assert.ok(Object.isFrozen(h) && Object.isFrozen(h.members), `${h.id} frozen`);
    assert.ok(h.members.length >= 3, `${h.id} has enough to collect`);
    for (const id of h.members) assert.equal(b.speciesById(id).habitat, h.id);
  }
  const housed = b.HABITATS.reduce((n, h) => n + h.members.length, 0);
  assert.equal(housed, b.SPECIES.length - 1 - b.eventSpecies().length, 'everyone but the hidden glitch and the event bugs has a home');
});

test('remedies use known keys', () => {
  const withRemedies = {};
  for (const s of b.SPECIES) {
    if (s.remedies === null) continue;
    assert.ok(Array.isArray(s.remedies) && s.remedies.length, `${s.id} remedies`);
    for (const r of s.remedies) assert.ok(REMEDIES.has(r), `${s.id} remedy '${r}'`);
    withRemedies[s.id] = [...s.remedies];
  }
  assert.deepEqual(withRemedies, {
    'clingy-barnacle': ['kill'], 'overstuffed-pufferfish': ['cache'], 'closed-clam': ['service'],
    'port-squatter': ['kill'], 'lockfile-lobster': ['lock'], 'stray-module-minnow': ['install'],
    'cache-ghoul': ['cache'], 'docked-whale-shark': ['service'],
  });
});

test('evolution names fit', () => {
  const evolving = b.SPECIES.filter(s => s.evolves !== null);
  assert.equal(evolving.length, 12, 'twelve starters evolve');
  for (const s of evolving) {
    assert.equal(s.evolves.length, 2, `${s.id} has stage II and III`);
    for (const name of s.evolves) assert.ok(typeof name === 'string' && name.length > 0 && name.length <= 24, `${s.id}: "${name}"`);
  }
});

test('live() leaves out the hidden one', () => {
  const live = b.live();
  assert.equal(b.LIVE_PHASE, 3);
  assert.equal(live.length, 83);
  assert.ok(!live.some(s => s.id === 'missingno'));
  assert.ok(live.every(s => s.habitat && s.phase <= b.LIVE_PHASE));
  assert.ok(b.speciesById('missingno'), 'still in the book, just kept apart');
});

test('every tide event has exactly its own bug, and the bug is its event\'s', () => {
  for (const e of EVENTS) {
    const sp = b.speciesById(e.bug);
    assert.ok(sp, `${e.id} bug exists`);
    assert.equal(sp.event, e.id);
  }
  assert.equal(b.eventSpecies().length, EVENTS.length);
  for (const sp of b.eventSpecies()) assert.ok(!b.live().includes(sp), `${sp.id} is never in "of N"`);
});
