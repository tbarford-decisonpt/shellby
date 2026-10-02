const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { checkPacks, PACK_DIR } = require('../scripts/validate-packs');
const { loadCatalog } = require('../src/main/wardrobe/catalog');
const { ACHIEVEMENTS, KNOWN_ACHIEVEMENTS } = require('../src/main/wardrobe/achievements');
const { KNOWN_SEASONS } = require('../src/main/wardrobe/seasons');

const reports = checkPacks();
const catalog = () => loadCatalog({
  builtinDir: PACK_DIR,
  knownAchievements: KNOWN_ACHIEVEMENTS,
  knownSeasons: KNOWN_SEASONS,
});

// src/wardrobe/ ships inside the app, so a bad pack here is a bad release — not
// something a user can uninstall. Hold it to the gallery's upload rules too.
test('packs: every built-in pack passes the loader and the schema', () => {
  assert.ok(reports.length > 1, 'expected the base pack plus the themed packs');
  const bad = reports.filter(r => r.problems.length);
  assert.deepEqual(bad.map(r => `${r.file}: ${r.problems.join('; ')}`), []);
});

test('packs: every pack contributes at least one item', () => {
  for (const r of reports) {
    const total = r.counts.accessories + r.counts.effects + r.counts.skins;
    assert.ok(total > 0, `${r.file} loaded no items`);
  }
});

test('packs: the whole built-in set loads clean, with no key collisions', () => {
  const { packs, errors, accessories, effects, skins } = catalog();
  assert.deepEqual(errors, []);
  for (const p of packs) assert.deepEqual(p.warnings, [], `${p.id} warned`);
  assert.ok(packs.every(p => p.source === 'builtin'));

  // Built-in items are keyed by bare id (no "pack/" prefix), so two packs must
  // never claim the same one — loadCatalog would silently drop the second.
  const ids = [...accessories.values(), ...effects.values()].map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate item id across built-in packs');
  for (const key of accessories.keys()) assert.ok(!key.includes('/'), `${key} should be a bare built-in key`);

  // The base pack alone is 41 / 7 / 2.
  assert.ok(accessories.size > 41, `expected more than 41 accessories, got ${accessories.size}`);
  assert.ok(effects.size > 7, `expected more than 7 effects, got ${effects.size}`);
  assert.ok(skins.length > 2, `expected more than 2 skins, got ${skins.length}`);
});

test('packs: pack ids are unique and none shadows another', () => {
  const seen = new Set();
  for (const f of fs.readdirSync(PACK_DIR).filter(n => n.endsWith('.json'))) {
    const json = JSON.parse(fs.readFileSync(path.join(PACK_DIR, f), 'utf8'));
    assert.ok(!seen.has(json.id), `duplicate pack id ${json.id}`);
    seen.add(json.id);
  }
});

// An item's `unlock` gate and the achievement's `rewards` list are separate fields
// doing one job. The gate alone decides whether the item is wearable (isUnlocked
// reads the earned-achievement list, never `rewards`), so a mismatch is quiet rather
// than fatal — which is exactly why it needs a test:
//   gate but no reward entry  → the item unlocks with no notification and no "new" badge
//   reward entry but no gate  → the celebration claims you unlocked something you always had
test('packs: achievement gates and reward lists agree both ways', () => {
  const { accessories, effects } = catalog();
  const items = [...accessories.values(), ...effects.values()];
  const rewardOf = new Map();
  for (const a of ACHIEVEMENTS) for (const key of a.rewards) rewardOf.set(key, a.id);

  for (const item of items) {
    const gate = item.unlock.achievement;
    if (gate) {
      assert.equal(rewardOf.get(item.key), gate,
        `${item.key} is gated on ${gate} but ${gate} does not list it as a reward`);
    }
  }
  for (const [key, achId] of rewardOf) {
    const item = items.find(i => i.key === key);
    assert.ok(item, `${achId} rewards ${key}, which no built-in pack provides`);
    assert.equal(item.unlock.achievement, achId,
      `${achId} rewards ${key}, but that item is not gated on it`);
  }
});

test('packs: unlockable items only reference achievements and seasons that exist', () => {
  const { accessories, effects, skins } = catalog();
  for (const item of [...accessories.values(), ...effects.values(), ...skins]) {
    const u = item.unlock;
    if (u.achievement) assert.ok(KNOWN_ACHIEVEMENTS.has(u.achievement), `${item.key}: ${u.achievement}`);
    if (u.season) assert.ok(KNOWN_SEASONS.has(u.season), `${item.key}: ${u.season}`);
  }
});
