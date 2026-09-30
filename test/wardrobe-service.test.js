const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Config } = require('../src/main/config');
const { Wardrobe, windowEnd } = require('../src/main/wardrobe/service');
const { SEASONS } = require('../src/main/wardrobe/seasons');

const BUILTIN = path.join(__dirname, '..', 'src', 'wardrobe');

function make(date) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-wd-'));
  const clock = { now: date };
  const w = new Wardrobe({ config: new Config(dir), builtinDir: BUILTIN, userDir: path.join(dir, 'packs'), now: () => clock.now });
  w.load();
  return { w, clock, dir };
}
const d = (y, m, day, h = 12) => new Date(y, m - 1, day, h);

test('the built-in pack loads cleanly and defaults are unlocked', () => {
  const { w } = make(d(2026, 6, 10));
  assert.equal(w.catalog.errors.length, 0);
  assert.ok(w.catalog.accessories.size >= 30);
  assert.ok(w.isUnlocked(w.item('beanie')));
  assert.ok(w.isUnlocked(w.item('sparkles')));
  assert.equal(w.isUnlocked(w.item('crown')), false);
});

test('finishing a task unlocks rewards, marks them new and emits a celebration', () => {
  const { w } = make(d(2026, 6, 10));
  const events = [];
  w.on('unlocked', e => events.push(e));
  w.record('task-completed');
  assert.equal(events.length, 1);
  assert.equal(events[0].achievement.id, 'first-task');
  assert.deepEqual(events[0].rewards.map(r => r.key).sort(), ['confetti', 'party-hat']);
  assert.ok(w.isUnlocked(w.item('party-hat')));
  assert.ok(w.data.newItems.includes('party-hat'));
  assert.deepEqual(w.record('crew-size', { n: 0 }), []); // no change -> nothing written
});

test('locked items cannot be equipped; wrong slots are rejected', () => {
  const { w } = make(d(2026, 6, 10));
  assert.equal(w.setOutfit({ hat: 'crown' }).ok, false);
  assert.equal(w.setOutfit({ hat: 'sunglasses' }).ok, false);
  assert.equal(w.setOutfit({ hat: 'beanie', face: 'sunglasses' }).ok, true);
  assert.deepEqual(w.effectiveOutfit(), { hat: 'beanie', face: 'sunglasses', neck: null, held: null, shell: null, effect: null });
});

test('seasonal look takes over, respects a change you make, and returns next year', () => {
  const { w, clock } = make(d(2026, 10, 5));
  assert.equal(w.effectiveOutfit().hat, 'witch-hat');
  assert.equal(w.effectiveOutfit().effect, 'bats');
  w.setOutfit({ hat: 'beanie' });
  assert.equal(w.effectiveOutfit().hat, 'beanie');
  assert.equal(w.effectiveOutfit().held, 'pumpkin-pail'); // keeps the rest of the spooky look
  clock.now = d(2026, 10, 20);
  assert.equal(w.effectiveOutfit().hat, 'beanie');        // still your choice this season
  clock.now = d(2027, 10, 3);
  assert.equal(w.effectiveOutfit().hat, 'witch-hat');     // new year, new season
  w.setOptions({ seasonalAuto: false });
  assert.equal(w.effectiveOutfit().hat, 'beanie');
});

test('wearSeason puts the season look back on after an override', () => {
  const { w } = make(d(2026, 12, 10));
  w.setOutfit({ hat: 'beanie' });
  assert.equal(w.effectiveOutfit().hat, 'beanie');
  w.wearSeason();
  assert.equal(w.effectiveOutfit().hat, 'santa-hat');
});

test('seasonal items are collected and stay unlocked after the season', () => {
  const { w, clock } = make(d(2026, 10, 15));
  assert.ok(w.data.collected.includes('witch-hat'));
  clock.now = d(2027, 3, 1);
  assert.ok(w.isUnlocked(w.item('witch-hat')));
  assert.equal(w.isUnlocked(w.item('santa-hat')), false); // never around for winter
  const lock = w.lockInfo(w.item('santa-hat'));
  assert.equal(lock.reason, 'season');
  assert.ok(lock.back > clock.now.getTime());
});

test('randomize only ever picks unlocked items', () => {
  const { w } = make(d(2026, 6, 10));
  for (let i = 0; i < 25; i++) {
    w.randomize();
    for (const [slot, key] of Object.entries(w.effectiveOutfit())) {
      if (!key) continue;
      const item = w.item(key);
      assert.ok(w.isUnlocked(item), `${slot}: ${key} should be unlocked`);
    }
  }
});

test('unlock-all opens everything without touching achievements', () => {
  const { w } = make(d(2026, 6, 10));
  w.setOptions({ unlockAll: true });
  assert.ok(w.isUnlocked(w.item('crown')));
  assert.equal(w.setOutfit({ hat: 'crown' }).ok, true);
  assert.deepEqual(w.data.unlocked, []);
});

test('history backfill credits past usage once, quietly', () => {
  const { w } = make(d(2026, 6, 10));
  const events = [];
  w.on('unlocked', e => events.push(e));
  const earned = w.backfill({ tasksCompleted: 12, activeDays: ['2026-06-01', '2026-06-02'] });
  assert.deepEqual(earned.map(a => a.id).sort(), ['first-task', 'ten-tasks']);
  assert.equal(events.length, 0);                   // no fireworks for old news
  assert.ok(w.isUnlocked(w.item('hard-hat')));
  assert.deepEqual(w.backfill({ tasksCompleted: 500 }), []); // only on first run
});

test('render gives the outfit, the equipped effect and crew hats', () => {
  const { w } = make(d(2026, 12, 10));
  const r = w.render();
  assert.deepEqual(r.accessories.map(a => a.key).sort(), ['candy-cane', 'santa-hat', 'striped-scarf']);
  assert.equal(r.effect.key, 'snow');
  assert.deepEqual(r.crewAccessories.map(a => a.key), ['santa-hat']);
  w.setOptions({ crewOutfits: false });
  assert.deepEqual(w.render().crewAccessories, []);
});

test('community packs install, are namespaced, and can be removed', () => {
  const { w, dir } = make(d(2026, 6, 10));
  const pack = {
    format: 1, id: 'tiny-hats', name: 'Tiny Hats', author: 'tester', version: '1.0.0',
    accessories: [{ id: 'fez', name: 'Fez', slot: 'hat', pivot: [1, 2], palette: { R: '#c1121f' }, pixels: ['.R.', 'RRR'] }],
  };
  const file = path.join(dir, 'tiny.json');
  fs.writeFileSync(file, JSON.stringify(pack));
  assert.equal(w.install(file).ok, true);
  assert.ok(w.item('tiny-hats/fez'));
  assert.equal(w.setOutfit({ hat: 'tiny-hats/fez' }).ok, true);
  fs.writeFileSync(file, JSON.stringify({ ...pack, id: 'shellby' }));
  assert.equal(w.install(file).ok, false); // can't impersonate the built-in pack
  assert.equal(w.remove('tiny-hats'), true);
  assert.equal(w.item('tiny-hats/fez'), null);
  assert.equal(w.effectiveOutfit().hat, null); // removed item drops off the outfit
});

test('season windows: end date handles the new-year wrap', () => {
  const winter = SEASONS.find(s => s.id === 'winter');
  assert.equal(windowEnd(winter, d(2026, 12, 20)).getFullYear(), 2027);
  assert.equal(windowEnd(winter, d(2027, 1, 3)).getMonth(), 0);
});
