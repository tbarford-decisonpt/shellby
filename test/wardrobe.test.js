const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const catalog = require('../src/main/wardrobe/catalog');
const { validatePack, loadCatalog, installPack, removePack } = catalog;
const seasons = require('../src/main/wardrobe/seasons');
const ach = require('../src/main/wardrobe/achievements');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-wardrobe-'));
const known = { knownAchievements: new Set(['ten-tasks']), knownSeasons: new Set(['halloween']) };

const hat = (over = {}) => ({ id: 'witch-hat', name: 'Witch Hat', slot: 'hat', pivot: [2, 1], palette: { K: '#2b193d' }, pixels: ['..K..', 'KKKKK'], ...over });
const fx = (over = {}) => ({ id: 'bats', name: 'Bats', motion: 'orbit', sprites: [{ palette: { b: '#111111' }, pixels: ['b.b', '.b.'] }], ...over });
const skin = (over = {}) => ({ id: 'ghost', name: 'Ghost', palette: { a: '#ffffff' }, pixels: ['aa', 'aa'], ...over });
const pack = (over = {}) => ({ format: 1, id: 'spooky-extras', name: 'Spooky Extras', author: 'someone', version: '1.0.0', accessories: [hat()], effects: [fx()], skins: [skin()], ...over });

// ---- validatePack: happy path
test('wardrobe: a good pack normalizes with defaults and namespaced keys', () => {
  const { pack: p, errors, warnings } = validatePack(pack({ description: 'boo', homepage: 'https://example.com/x' }), known);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(p.source, 'user');
  assert.equal(p.homepage, 'https://example.com/x');
  const a = p.accessories[0];
  assert.equal(a.key, 'spooky-extras/witch-hat');
  assert.equal(a.id, 'witch-hat');
  assert.equal(a.packId, 'spooky-extras');
  assert.equal(a.anchor, 'head');
  assert.equal(a.follows, 'stalks');
  assert.equal(a.rarity, 'common');
  assert.deepEqual(a.unlock, { default: true });
  assert.equal(a.description, '');
  assert.deepEqual(a.pivot, [2, 1]);
  assert.equal(a.palette.K, '#2b193d');
  const e = p.effects[0];
  assert.equal(e.key, 'spooky-extras/bats');
  assert.equal(e.count, 10);
  assert.equal(e.speed, 1);
  const s = p.skins[0];
  assert.equal(s.key, 'spooky-extras/ghost');
  assert.equal(s.id, 'spooky-extras/ghost');
  assert.deepEqual(s.anchors, { head: [15, -1], face: [15, 0], neck: [15, 4], claw: [21, 6], shellTop: [7, 0] });
});
test('wardrobe: slot defaults for anchor/follows; explicit values win', () => {
  const accessories = [
    hat({ id: 'a', slot: 'face' }), hat({ id: 'b', slot: 'neck' }), hat({ id: 'c', slot: 'held' }),
    hat({ id: 'd', slot: 'shell' }), hat({ id: 'e', slot: 'hat', anchor: 'claw', follows: 'legs', rarity: 'epic' }),
  ];
  const got = validatePack(pack({ accessories }), known).pack.accessories.map(a => [a.anchor, a.follows, a.rarity]);
  assert.deepEqual(got, [
    ['face', 'stalks', 'common'], ['neck', 'body', 'common'], ['claw', 'claw', 'common'],
    ['shellTop', 'shell', 'common'], ['claw', 'legs', 'epic'],
  ]);
});
test('wardrobe: builtin packs use bare item ids as keys', () => {
  const p = validatePack(pack(), { ...known, source: 'builtin' }).pack;
  assert.equal(p.accessories[0].key, 'witch-hat');
  assert.equal(p.skins[0].id, 'ghost');
  assert.equal(p.effects[0].source, 'builtin');
});
test('wardrobe: skin anchors override defaults; bad anchors skip the skin', () => {
  const p = validatePack(pack({ skins: [skin({ anchors: { head: [3, -2] } }), skin({ id: 'b', anchors: { tail: [1, 1] } }), skin({ id: 'c', anchors: { head: [1, 99] } })] }), known).pack;
  assert.equal(p.skins.length, 1);
  assert.deepEqual(p.skins[0].anchors.head, [3, -2]);
  assert.deepEqual(p.skins[0].anchors.claw, [21, 6]);
});

// ---- validatePack: item errors skip the item, keep the pack
test('wardrobe: bad items are skipped with a warning, the rest of the pack survives', () => {
  const accessories = [
    hat({ id: 'bad-hex', palette: { K: 'red;}' } }),
    hat({ id: 'bad-slot', slot: 'tail' }),
    hat({ id: 'bad-anchor', anchor: 'toe' }),
    hat({ id: 'bad-follows', follows: 'wind' }),
    hat({ id: 'tall', pixels: Array(17).fill('K') }),
    hat({ id: 'wide', pixels: ['K'.repeat(17)] }),
    hat({ id: 'bad-pivot', pivot: [1.5, 0] }),
    hat({ id: 'far-pivot', pivot: [40, 0] }),
    hat({ id: 'dot-key', palette: { '.': '#000000' } }),
    hat({ id: 'big-palette', palette: Object.fromEntries('abcdefghijklmnopq'.split('').map(c => [c, '#000000'])) }),
    hat({ id: 'bad-rarity', rarity: 'mythic' }),
    hat({ id: 'no-name', name: '' }),
    hat({ id: 'Bad_Id' }),
    'not an object',
    hat({ id: 'ok' }),
  ];
  const { pack: p, warnings } = validatePack(pack({ accessories }), known);
  assert.deepEqual(p.accessories.map(a => a.id), ['ok']);
  assert.equal(warnings.length, accessories.length - 1);
  assert.ok(warnings.includes('skipped accessory bad-slot: bad slot "tail"'));
  assert.ok(warnings.every(w => w.startsWith('skipped accessory ')));
});
test('wardrobe: effects validate motion, count, speed and sprite size', () => {
  const effects = [
    fx({ id: 'm', motion: 'spin' }), fx({ id: 'c', count: 25 }), fx({ id: 's', speed: 4 }),
    fx({ id: 'big', sprites: [{ palette: { b: '#000000' }, pixels: ['bbbbbbbbb'] }] }),
    fx({ id: 'none', sprites: [] }),
    fx({ id: 'many', sprites: Array(7).fill({ palette: { b: '#000000' }, pixels: ['b'] }) }),
    fx({ id: 'good', count: 24, speed: 0.25, motion: 'twinkle' }),
  ];
  const { pack: p, warnings } = validatePack(pack({ effects }), known);
  assert.deepEqual(p.effects.map(e => [e.id, e.count, e.speed]), [['good', 24, 0.25]]);
  assert.equal(warnings.length, 6);
});
test('wardrobe: unlock references must be known achievements/seasons', () => {
  const accessories = [
    hat({ id: 'a', unlock: { achievement: 'ten-tasks' } }),
    hat({ id: 'b', unlock: { achievement: 'nope' } }),
    hat({ id: 'c', unlock: { season: 'halloween' } }),
    hat({ id: 'd', unlock: { season: 'easter' } }),
    hat({ id: 'e', unlock: { default: true } }),
    hat({ id: 'f', unlock: { default: false } }),
    hat({ id: 'g', unlock: { achievement: 'ten-tasks', season: 'halloween' } }),
    hat({ id: 'h', unlock: { bribe: 1 } }),
  ];
  const { pack: p, warnings } = validatePack(pack({ accessories, skins: [skin({ unlock: { season: 'easter' } })] }), known);
  assert.deepEqual(p.accessories.map(a => [a.id, a.unlock]), [
    ['a', { achievement: 'ten-tasks' }], ['c', { season: 'halloween' }], ['e', { default: true }],
  ]);
  assert.equal(p.skins.length, 0);
  assert.ok(warnings.includes('skipped accessory b: unknown achievement "nope"'));
  assert.ok(warnings.includes('skipped accessory d: unknown season "easter"'));
  // Without known sets, every reference is unknown.
  assert.deepEqual(validatePack(pack({ accessories })).pack.accessories.map(a => a.id), ['e']);
});
test('wardrobe: fatal header errors reject the pack', () => {
  for (const bad of [null, [], 'x', 42]) assert.equal(validatePack(bad).pack, null);
  for (const over of [
    { format: 2 }, { format: '1' }, { id: 'X' }, { id: 'a' }, { id: '-abc' }, { id: 'a'.repeat(41) },
    { name: '' }, { name: 'n'.repeat(61) }, { author: undefined }, { version: '1.0' }, { version: 'v1.0.0' },
  ]) {
    const r = validatePack(pack(over), known);
    assert.equal(r.pack, null, JSON.stringify(over));
    assert.ok(r.errors.length);
  }
  // Optional metadata is dropped with a warning instead.
  const r = validatePack(pack({ homepage: 'http://insecure.example', description: 'd'.repeat(241) }), known);
  assert.equal(r.pack.homepage, '');
  assert.equal(r.pack.description, '');
  assert.equal(r.warnings.length, 2);
});
test('wardrobe: __proto__ keys cannot pollute prototypes', () => {
  const raw = JSON.parse(`{"format":1,"id":"evil","name":"E","author":"e","version":"1.0.0","__proto__":{"polluted":1},
    "accessories":[{"id":"x","name":"X","slot":"hat","pivot":[0,0],"palette":{"__proto__":"#000000"},"pixels":["a"]},
                   {"id":"y","name":"Y","slot":"hat","pivot":[0,0],"palette":{"a":"#000000","constructor":"#ffffff"},"pixels":["a"]}],
    "skins":[{"id":"s","palette":{"a":"#000000"},"pixels":["a"],"anchors":{"__proto__":[1,1]}}]}`);
  const { pack: p, warnings } = validatePack(raw, known);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(p.accessories.length, 0);
  assert.equal(p.skins.length, 0);
  assert.equal(warnings.length, 3);
  const ok = validatePack(pack(), known).pack;
  assert.equal(Object.getPrototypeOf(ok.accessories[0].palette), null);
});
test('wardrobe: unknown fields are stripped', () => {
  const { pack: p } = validatePack(pack({ evil: 1, accessories: [hat({ onClick: 'alert(1)', script: 'x' })], effects: [fx({ sprites: [{ palette: { b: '#000000' }, pixels: ['b'], extra: 1 }] })] }), known);
  assert.equal(p.evil, undefined);
  assert.deepEqual(Object.keys(p).sort(), ['accessories', 'author', 'description', 'effects', 'homepage', 'id', 'name', 'skins', 'source', 'version']);
  assert.deepEqual(Object.keys(p.accessories[0]).sort(),
    ['anchor', 'description', 'follows', 'id', 'key', 'name', 'packId', 'palette', 'pivot', 'pixels', 'rarity', 'slot', 'source', 'unlock']);
  assert.deepEqual(Object.keys(p.effects[0]).sort(),
    ['count', 'description', 'id', 'key', 'motion', 'name', 'packId', 'rarity', 'source', 'speed', 'sprites', 'unlock']);
  assert.deepEqual(Object.keys(p.effects[0].sprites[0]).sort(), ['palette', 'pixels']);
});
test('wardrobe: duplicate item ids keep the first; lists are capped', () => {
  const { pack: p, warnings } = validatePack(pack({ accessories: [hat({ name: 'First' }), hat({ name: 'Second' })] }), known);
  assert.deepEqual(p.accessories.map(a => a.name), ['First']);
  assert.match(warnings[0], /duplicate/);
  const many = Array.from({ length: 205 }, (_, i) => hat({ id: `h${i}` }));
  const capped = validatePack(pack({ accessories: many }), known);
  assert.equal(capped.pack.accessories.length, 200);
  assert.ok(capped.warnings.some(w => /first 200/.test(w)));
});
test('wardrobe: validatePack never throws on garbage', () => {
  const junk = [undefined, 0, true, { format: 1 }, pack({ accessories: 'x', effects: {}, skins: [null, 1, []] }),
    pack({ accessories: [{ id: 'z', name: 'Z', slot: 'hat', pivot: 'x', palette: [], pixels: {} }] }),
    pack({ effects: [{ id: 'z', name: 'Z', motion: 'fall', sprites: [null] }] })];
  for (const j of junk) assert.doesNotThrow(() => validatePack(j, known));
});

// ---- loadCatalog
function writeJson(dir, name, obj) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
}
test('wardrobe: loadCatalog merges builtin and user packs', () => {
  const root = tmp();
  const builtinDir = path.join(root, 'builtin');
  const userDir = path.join(root, 'user');
  writeJson(builtinDir, 'base.pack.json', pack({ id: 'base', name: 'Base' }));
  writeJson(userDir, 'a.json', pack({ id: 'alpha' }));
  writeJson(userDir, 'b.json', pack({ id: 'base' }));                  // reserved
  writeJson(userDir, 'c.json', pack({ id: 'alpha', name: 'Second' })); // duplicate user id
  writeJson(userDir, 'd.json', '{nope');
  writeJson(userDir, 'e.json', pack({ id: 'big', description: 'x'.repeat(200), accessories: [hat({ junk: 'x'.repeat(520 * 1024) })] }));
  writeJson(userDir, 'f.json', pack({ id: 'bad-header', version: 'one' }));
  writeJson(userDir, 'notes.txt', 'ignored');
  const c = loadCatalog({ builtinDir, userDir, ...known });
  assert.deepEqual(c.packs.map(p => [p.id, p.source]), [['base', 'builtin'], ['alpha', 'user']]);
  assert.deepEqual([...c.accessories.keys()], ['witch-hat', 'alpha/witch-hat']);
  assert.deepEqual([...c.effects.keys()], ['bats', 'alpha/bats']);
  assert.deepEqual(c.skins.map(s => s.id), ['ghost', 'alpha/ghost']);
  assert.deepEqual(c.packs[1].counts, { accessories: 1, effects: 1, skins: 1 });
  assert.equal(c.packs[1].file, path.join(userDir, 'a.json'));
  assert.equal(c.errors.length, 5);
  assert.ok(c.errors.some(e => e.startsWith('b.json: id reserved')));
  assert.ok(c.errors.some(e => e.startsWith('c.json: duplicate pack id alpha')));
  assert.ok(c.errors.some(e => e.startsWith('d.json: invalid JSON')));
  assert.ok(c.errors.some(e => e.startsWith('e.json: file is larger')));
  assert.ok(c.errors.some(e => e.startsWith('f.json: bad version')));
});
test('wardrobe: loadCatalog tolerates missing dirs and records pack warnings', () => {
  const c = loadCatalog({ builtinDir: path.join(tmp(), 'nope'), userDir: undefined });
  assert.deepEqual([c.packs, c.errors, c.skins, c.accessories.size], [[], [], [], 0]);
  const userDir = tmp();
  writeJson(userDir, 'w.json', pack({ accessories: [hat(), hat({ id: 'x', slot: 'nose' })] }));
  const w = loadCatalog({ userDir, ...known });
  assert.equal(w.packs[0].warnings.length, 1);
  assert.equal(w.accessories.size, 1);
});

// ---- installPack / removePack
test('wardrobe: installPack copies a valid pack to userDir/<id>.json and overwrites same id', () => {
  const src = tmp();
  const userDir = path.join(tmp(), 'nested', 'wardrobe');
  writeJson(src, 'download (1).json', pack({ extra: 'kept in file' }));
  const r = installPack(path.join(src, 'download (1).json'), userDir, known);
  assert.equal(r.ok, true, r.errors.join());
  assert.equal(r.dest, path.join(userDir, 'spooky-extras.json'));
  const saved = JSON.parse(fs.readFileSync(r.dest, 'utf8'));
  assert.equal(saved.extra, 'kept in file'); // the original JSON, not the normalized one
  assert.equal(r.pack.accessories[0].key, 'spooky-extras/witch-hat');

  writeJson(src, 'v2.json', pack({ version: '2.0.0' }));
  assert.equal(installPack(path.join(src, 'v2.json'), userDir, known).ok, true);
  assert.deepEqual(fs.readdirSync(userDir), ['spooky-extras.json']);
  assert.equal(loadCatalog({ userDir, ...known }).packs[0].version, '2.0.0');
});
test('wardrobe: installPack rejects invalid, oversized, missing and reserved packs', () => {
  const src = tmp();
  const userDir = tmp();
  writeJson(src, 'bad.json', pack({ id: '../../evil' }));
  writeJson(src, 'broken.json', '{');
  writeJson(src, 'huge.json', JSON.stringify(pack({ pad: 'x'.repeat(513 * 1024) })));
  writeJson(src, 'base.json', pack({ id: 'base' }));
  for (const f of ['bad.json', 'broken.json', 'huge.json', 'missing.json']) {
    const r = installPack(path.join(src, f), userDir, known);
    assert.equal(r.ok, false, f);
    assert.ok(r.errors.length, f);
  }
  assert.equal(installPack(path.join(src, 'base.json'), userDir, { ...known, reservedIds: new Set(['base']) }).ok, false);
  assert.deepEqual(fs.readdirSync(userDir), []);
  assert.deepEqual(fs.readdirSync(path.dirname(userDir)).filter(f => f === 'evil.json'), []);
});
test('wardrobe: removePack only deletes well-formed ids inside userDir', () => {
  const userDir = tmp();
  const outside = path.join(path.dirname(userDir), 'outside-pack.json');
  fs.writeFileSync(outside, '{}');
  writeJson(userDir, 'spooky-extras.json', pack());
  assert.equal(removePack('../outside-pack', userDir), false);
  assert.equal(removePack('..\\outside-pack', userDir), false);
  assert.ok(fs.existsSync(outside));
  fs.unlinkSync(outside);
  assert.equal(removePack('nope', userDir), false);
  assert.equal(removePack('spooky-extras', userDir), true);
  assert.equal(removePack('spooky-extras', userDir), false);
  assert.deepEqual(fs.readdirSync(userDir), []);
});

// ---- seasons
const day = (y, m, d, h = 12) => new Date(y, m - 1, d, h);
test('seasons: windows are inclusive and winter wraps the new year', () => {
  assert.ok(seasons.isActive('winter', day(2026, 12, 1, 0)));
  assert.ok(seasons.isActive('winter', day(2026, 12, 31)));
  assert.ok(seasons.isActive('winter', day(2027, 1, 5)));
  assert.ok(seasons.isActive('winter', day(2027, 1, 7, 23)));
  assert.ok(!seasons.isActive('winter', day(2027, 1, 8, 0)));
  assert.ok(!seasons.isActive('winter', day(2026, 11, 30, 23)));
  assert.ok(seasons.isActive('valentine', day(2026, 2, 15)));
  assert.ok(!seasons.isActive('valentine', day(2026, 2, 16)));
  assert.ok(!seasons.isActive('nope', day(2026, 2, 10)));
  assert.equal(seasons.featuredSeason(day(2026, 1, 20)), null);
  assert.deepEqual(seasons.activeSeasons(day(2026, 7, 1)).map(s => s.id), ['summer']);
});
test('seasons: priority ordering when windows overlap', () => {
  assert.deepEqual(seasons.activeSeasons(day(2026, 10, 15)).map(s => s.id), ['halloween', 'autumn']);
  assert.equal(seasons.featuredSeason(day(2026, 10, 15)).id, 'halloween');
  assert.equal(seasons.featuredSeason(day(2026, 11, 3)).id, 'autumn');
  assert.equal(seasons.featuredSeason(day(2026, 9, 14)), null);
});
test('seasons: nextStart returns the current or next window start', () => {
  assert.deepEqual(seasons.nextStart('halloween', day(2026, 9, 30)), day(2026, 10, 1, 0));
  assert.deepEqual(seasons.nextStart('halloween', day(2026, 10, 20)), day(2026, 10, 1, 0));
  assert.deepEqual(seasons.nextStart('halloween', day(2026, 11, 3)), day(2027, 10, 1, 0));
  assert.deepEqual(seasons.nextStart('winter', day(2027, 1, 5)), day(2026, 12, 1, 0));
  assert.deepEqual(seasons.nextStart('winter', day(2026, 12, 31)), day(2026, 12, 1, 0));
  assert.deepEqual(seasons.nextStart('winter', day(2027, 1, 8)), day(2027, 12, 1, 0));
  assert.equal(seasons.nextStart('nope'), null);
  assert.deepEqual([...seasons.KNOWN_SEASONS].sort(), ['autumn', 'halloween', 'spring', 'summer', 'valentine', 'winter']);
});

// ---- achievements
test('achievements: every event updates the right stat without mutating', () => {
  const s0 = Object.freeze(ach.emptyStats());
  const cases = [
    ['helper-spawned', 'helpersSpawned'], ['trick-learned', 'tricksLearned'],
    ['created-script-approved', 'createdScriptsRun'], ['routine-run', 'routinesRun'],
    ['permission-answered', 'permissionsAnswered'], ['plan-approved', 'plansApproved'],
    ['files-dropped', 'filesDropped'],
  ];
  for (const [event, stat] of cases) assert.equal(ach.recordStat(s0, event)[stat], 1, event);
  let s = ach.recordStat(s0, 'crew-size', { n: 4 });
  s = ach.recordStat(s, 'crew-size', { n: 2 });
  assert.equal(s.maxCrew, 4);
  assert.equal(ach.recordStat(s0, 'parallel', { n: 3 }).maxParallel, 3);
  assert.equal(ach.recordStat(s0, 'parallel', { n: 'lots' }).maxParallel, 0);
  assert.deepEqual(ach.recordStat(s0, 'made-up'), ach.emptyStats());
  assert.notEqual(ach.recordStat(s0, 'made-up'), s0);
  assert.deepEqual(s0, ach.emptyStats());
});
test('achievements: task hours count as night / early and mark the day active', () => {
  const at = h => ach.recordStat(ach.emptyStats(), 'task-completed', {}, day(2026, 3, 4, h));
  assert.deepEqual([0, 4, 5, 7, 8, 23].map(h => { const s = at(h); return [s.nightTasks, s.earlyTasks]; }),
    [[1, 0], [1, 0], [0, 1], [0, 1], [0, 0], [0, 0]]);
  const s = at(12);
  assert.equal(s.tasksCompleted, 1);
  assert.deepEqual(s.activeDays, ['2026-03-04']);
});
test('achievements: active days dedupe and cap at 400', () => {
  let s = ach.emptyStats();
  s = ach.recordStat(s, 'active', {}, day(2026, 5, 1, 9));
  s = ach.recordStat(s, 'task-completed', {}, day(2026, 5, 1, 18));
  assert.deepEqual(s.activeDays, ['2026-05-01']);
  for (let i = 0; i < 410; i++) s = ach.recordStat(s, 'active', {}, new Date(2025, 0, 1 + i, 12));
  assert.equal(s.activeDays.length, 400);
  assert.equal(s.activeDays.at(-1), '2026-05-01');
  assert.equal(ach.statValue(s, 'activeDays'), 400);
});
test('achievements: evaluate thresholds and skip already-unlocked', () => {
  const s = { ...ach.emptyStats(), tasksCompleted: 10, activeDays: ['2026-01-01'] };
  assert.deepEqual(ach.evaluate(s), ['first-task', 'ten-tasks']);
  assert.deepEqual(ach.evaluate(s, new Set(['first-task'])), ['ten-tasks']);
  assert.deepEqual(ach.evaluate({ ...s, tasksCompleted: 9 }), ['first-task']);
  const days = Array.from({ length: 7 }, (_, i) => `2026-01-0${i + 1}`);
  assert.ok(ach.evaluate({ ...ach.emptyStats(), activeDays: days }).includes('loyal'));
  assert.deepEqual(ach.evaluate(ach.emptyStats()), []);
});
test('achievements: progress hides secrets until done and caps current', () => {
  const rows = ach.progress({ ...ach.emptyStats(), tasksCompleted: 30 });
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(rows.length, ach.ACHIEVEMENTS.length);
  assert.deepEqual([byId['ten-tasks'].current, byId['ten-tasks'].done], [10, true]);
  assert.deepEqual([byId.centurion.current, byId.centurion.goal, byId.centurion.done], [30, 100, false]);
  assert.equal(byId['night-owl'].name, '???');
  assert.equal(byId['night-owl'].description, 'A secret achievement');
  assert.equal(byId['night-owl'].hidden, true);
  const done = ach.progress({ ...ach.emptyStats(), nightTasks: 1 }).find(r => r.id === 'night-owl');
  assert.equal(done.name, 'Night Owl');
  const unlocked = ach.progress(ach.emptyStats(), new Set(['early-bird'])).find(r => r.id === 'early-bird');
  assert.deepEqual([unlocked.name, unlocked.done], ['Early Bird', true]);
});
test('achievements: normalizeStats tolerates garbage', () => {
  for (const g of [null, undefined, 'x', 5, [], { tasksCompleted: 'lots' }]) assert.deepEqual(ach.normalizeStats(g), ach.emptyStats());
  const s = ach.normalizeStats({ tasksCompleted: 3.7, maxCrew: -2, nightTasks: NaN, earlyTasks: Infinity, activeDays: ['2026-01-02', '2026-01-01', 'junk', 7, '2026-01-02'], extra: 1 });
  assert.equal(s.tasksCompleted, 3);
  assert.equal(s.maxCrew, 0);
  assert.equal(s.nightTasks, 0);
  assert.equal(s.earlyTasks, 0);
  assert.deepEqual(s.activeDays, ['2026-01-01', '2026-01-02']);
  assert.equal(s.extra, undefined);
  assert.equal(ach.recordStat('garbage', 'routine-run').routinesRun, 1);
});

// ---- schema stays in sync with the validator
test('addon schema is valid JSON and mirrors the validator enums', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'addon.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, 'https://github.com/x-salmon/shellby/blob/main/docs/addon.schema.json');
  const d = schema.$defs;
  assert.deepEqual(d.accessory.properties.slot.enum, catalog.SLOTS);
  assert.deepEqual(d.accessory.properties.anchor.enum, catalog.ANCHORS);
  assert.deepEqual(d.accessory.properties.follows.enum, catalog.FOLLOWS);
  assert.deepEqual(d.effect.properties.motion.enum, catalog.MOTIONS);
  assert.deepEqual(d.rarity.enum, catalog.RARITIES);
  assert.deepEqual(Object.keys(d.skin.properties.anchors.properties), catalog.ANCHORS);
  assert.equal(schema.properties.id.pattern, catalog.PACK_ID_RE.source);
  assert.equal(d.itemId.pattern, catalog.ITEM_ID_RE.source);
  assert.deepEqual(d.unlock.oneOf[1].properties.achievement.enum, [...ach.KNOWN_ACHIEVEMENTS]);
  assert.deepEqual(d.unlock.oneOf[2].properties.season.enum, [...seasons.KNOWN_SEASONS]);
});

// ---- the built-in pack (created separately; skipped until it exists)
const BASE = path.join(__dirname, '..', 'src', 'wardrobe', 'base.pack.json');
test('built-in pack validates cleanly and provides every reward and season outfit item', { skip: !fs.existsSync(BASE) && 'src/wardrobe/base.pack.json not created yet' }, () => {
  const json = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const { pack: p, errors, warnings } = validatePack(json, { source: 'builtin', knownAchievements: ach.KNOWN_ACHIEVEMENTS, knownSeasons: seasons.KNOWN_SEASONS });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  const accessories = new Map(p.accessories.map(a => [a.key, a]));
  const effects = new Map(p.effects.map(e => [e.key, e]));
  for (const a of ach.ACHIEVEMENTS) {
    for (const r of a.rewards) assert.ok(accessories.has(r) || effects.has(r), `${a.id} reward ${r} missing from base pack`);
  }
  for (const s of seasons.SEASONS) {
    for (const [slot, key] of Object.entries(s.outfit)) {
      if (slot === 'effect') assert.ok(effects.has(key), `${s.id} effect ${key} missing`);
      else {
        assert.ok(accessories.has(key), `${s.id} ${slot} ${key} missing`);
        assert.equal(accessories.get(key).slot, slot, `${s.id} ${key} should be a ${slot}`);
      }
    }
  }
});
